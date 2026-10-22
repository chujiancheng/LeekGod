"""
游戏服务器管理脚本
用法: python server.py [start|stop|restart|status|clock|notice|halt|resume|whales]

stop / restart 默认走「安全关服」：
  交易日时钟的收盘休市段（night）→ 立刻停；
  盘中 / 集合竞价 / 午休        → 挂机等当天收盘，落进休市窗口再停。
  等待期间每秒探一次服务端的 /api/admin/clock，等到就动手，Ctrl+C 可中断。

  **会发公告**：进入等待就先推一条「今日收盘后关闭维护」给在线玩家，
  真正动手前再推一条「正在关闭」；`--now` 则是「交易已暂停，即将关闭」。
  等待被取消 / 超时会自动撤下公告（公告只存内存，进程一停就没了）。

  --now        立即关服：先向服务端发停牌指令冻结撮合，再关进程（不等收盘）
  --force      不做任何检查，直接结束进程（旧行为，留作救火）
  --lunch      午间休市也算安全窗口（默认只认收盘后）
  --timeout=N  最长等待秒数（默认 900，约一个半交易日）；超时不动服务器，退出码 2

restart = stop + start，且**必须等旧进程真正退出**（探活失败）才 start；
start 之后还会确认服务可达并公告「已恢复」。--now 重启会在新进程就绪后自动复牌。

halt / resume 通过服务端的运维接口实现（口令见 data/admin.token），
需要服务正在运行；端口口径与 node 一致，都取环境变量 PORT，默认 3000。

PID 文件默认是 Server/server.pid（全局一份）；验收/调试要另起一个临时实例时，
用 GU_PID_FILE 指到临时路径，别和正式服的 PID 文件撞车（否则 stop 会把正式服干掉）。
"""
import subprocess
import sys
import os
import signal
import time
import json
from urllib import error as urlerror
from urllib import request as urlrequest

PID_FILE = os.environ.get("GU_PID_FILE") or os.path.join(os.path.dirname(__file__), "server.pid")
SERVER_DIR = os.path.dirname(__file__)
LOG_DIR = os.path.join(SERVER_DIR, "log")
# node 的业务日志由 log4js 按天切割落盘（Server/log/server.YYYY-MM-DD.log）；
# 这里重定向的只是 logger 初始化之前的崩溃输出（缺模块、语法错误等）
CONSOLE_LOG = os.path.join(LOG_DIR, "server-console.log")
SERVER_ENTRY = os.path.join(SERVER_DIR, "index.js")
ADMIN_TOKEN_FILE = os.path.join(SERVER_DIR, "data", "admin.token")

LOG_MAX_BYTES = 5 * 1024 * 1024
NODE_NAMES = {"node.exe", "node"}

# 安全关服参数
DEFAULT_WAIT_SECONDS = 900      # 最多等一个半交易日（一天 620 秒）
SETTLE_GRACE_MS = 2000          # 进入收盘休市后先等这么久，让日终结算落盘
HALT_ON_STOP_MINUTES = 3        # 立即关服时先停牌多久（只要盖住关服过程即可）

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_TIMEOUT = 2


def process_name(pid):
    """取 PID 对应的进程名（小写）；进程不存在或无法判定时返回 None。

    Windows 上**不走 tasklist**：那是个控制台程序，在某些终端（无窗口 / 被沙箱接管 stdio 时）
    capture_output=True 拿到的 stdout 会是 None，`None.strip()` 直接抛 AttributeError，
    start / stop / status 三条命令全被一个探活函数带崩。改成 ctypes 直接问内核，
    不开子进程、也没有编码与输出格式的坑。
    """
    if os.name == "nt":
        import ctypes
        from ctypes import wintypes

        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        try:
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
            if not handle:
                return None
            try:
                size = wintypes.DWORD(1024)
                buf = ctypes.create_unicode_buffer(1024)
                if not kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    return None
                return os.path.basename(buf.value).lower()
            finally:
                kernel32.CloseHandle(handle)
        except Exception:
            return None
    try:
        with open(f"/proc/{pid}/comm", "r", encoding="utf-8") as f:
            return f.read().strip().lower()
    except OSError:
        return None


def pid_alive(pid):
    """探活：Windows 上 os.kill(pid, 0) 会直接结束进程，必须用进程名检查"""
    if os.name == "nt":
        return process_name(pid) is not None
    try:
        os.kill(pid, 0)
        return True
    except (OSError, SystemError):
        return False


def get_pid():
    if not os.path.exists(PID_FILE):
        return None
    try:
        with open(PID_FILE, "r", encoding="utf-8") as f:
            pid = int(f.read().strip())
    except (OSError, ValueError):
        # PID 文件损坏，清理掉避免后续 int() 抛异常
        remove_pid()
        return None
    if pid_alive(pid):
        return pid
    remove_pid()
    return None


def save_pid(pid):
    with open(PID_FILE, "w", encoding="utf-8") as f:
        f.write(str(pid))


def remove_pid():
    if os.path.exists(PID_FILE):
        os.remove(PID_FILE)


def rotate_log():
    """控制台兜底日志超过阈值时轮转一次，避免无限增长（业务日志按天切割，不归这里管）"""
    if not os.path.exists(CONSOLE_LOG):
        return
    try:
        if os.path.getsize(CONSOLE_LOG) < LOG_MAX_BYTES:
            return
        backup = CONSOLE_LOG + ".1"
        if os.path.exists(backup):
            os.remove(backup)
        os.replace(CONSOLE_LOG, backup)
    except OSError:
        pass


def start_failure_hint():
    """启动即退时，把 server-console.log 里最可能的原因摘出来直接打印。

    最常见的两种：缺依赖（新环境没 npm install）、存档版本不兼容（2026-10-20 起
    NPC 改真名那一版故意没有 8 → 9 的迁移，任何老档都必须删库重开）。
    不自动删档——存档是玩家的东西，删不删由人决定。
    """
    try:
        with open(CONSOLE_LOG, "r", encoding="utf-8", errors="replace") as f:
            text = f.read()[-6000:]
    except OSError:
        return
    if "存档表结构版本为" in text:
        at = text.find("存档表结构版本为")
        print("\n存档版本不兼容，需要删库重开：")
        print(text[at:at + 500].rstrip())
    elif "Cannot find module" in text:
        print("\n缺少依赖：先在本目录执行 npm install 再启动")


def start():
    pid = get_pid()
    if pid:
        print(f"服务器已在运行 (PID: {pid})")
        return False

    print("正在启动服务器...")
    os.makedirs(LOG_DIR, exist_ok=True)
    rotate_log()
    log = open(CONSOLE_LOG, "a", encoding="utf-8")
    creationflags = 0
    if os.name == "nt":
        # 独立进程组 + 与控制台解绑，避免父终端退出时带走服务
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        )
    # 显式抬高 V8 老生代上限：SSE 每帧全量 JSON 的垃圾曾把堆线性堆到上限（heap OOM）。
    # 2026-10-21 起 SSE 公共段每 tick 只序列化一次（垃圾 ~降 3 倍），实测夜间活跃堆仅几十 MB，
    # 当时据此把 6144 降到 2560。但 2026-10-22 白天又连崩两次（PID 81424 / 61932），
    # 真因不是垃圾而是「SSE 慢消费者的写队列」：客户端读不动时每帧都堆在 res 里不释放，
    # 属于活对象，Mark-Compact 回收不到（详见 src/sseback.js 与 Doc 变更记录）。
    # 修法已在代码里（写背压闸门），这里抬到 8192 只是保险：本机 32GB，8192 仍是安全区间。
    # 可用 NODE_OPTIONS 覆盖。
    node_cmd = ["node", SERVER_ENTRY]
    if "NODE_OPTIONS" not in os.environ:
        node_cmd = ["node", "--max-old-space-size=8192", SERVER_ENTRY]
    process = subprocess.Popen(
        node_cmd,
        cwd=SERVER_DIR,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        creationflags=creationflags,
    )
    save_pid(process.pid)
    time.sleep(1)

    if process.poll() is not None:
        print("启动失败，查看 server-console.log")
        start_failure_hint()
        remove_pid()
        return False

    print(f"服务器已启动 (PID: {process.pid})")
    print(f"访问地址: http://{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '3000')}")
    print(f"日志文件: {os.path.join(LOG_DIR, 'server.' + time.strftime('%Y-%m-%d') + '.log')}（按天切割，保留 30 天）")
    return True


# ---------- 运维接口 ----------

def read_admin_token():
    """与服务端同口径：环境变量 ADMIN_TOKEN 优先，其次读 data/admin.token"""
    env = os.environ.get("ADMIN_TOKEN", "").strip()
    if env:
        return env
    try:
        with open(ADMIN_TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def admin_call(path, payload=None, method="POST", quiet=False, timeout=5, action="操作"):
    """调服务端运维接口，返回解析后的 dict；送不达或被拒时返回 None。

    quiet=True 只吞掉这里的提示，调用方自己决定怎么报警——安全关服的轮询路径
    每秒打一行"调用失败"会把终端刷满。
    """
    token = read_admin_token()
    if not token:
        if not quiet:
            print(f"读不到运维口令: {ADMIN_TOKEN_FILE}")
            print("先 python server.py start 让它生成一次，或用 ADMIN_TOKEN 环境变量指定")
        return None

    port = os.environ.get("PORT", "3000")
    headers = {"X-Admin-Token": token}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = urlrequest.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        headers=headers,
        method=method,
    )
    try:
        with urlrequest.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {}
        if not quiet:
            print(f"{action}被拒绝: {data.get('error', e.reason)}")
        return None
    except Exception as e:
        if not quiet:
            print(f"调用失败: {e}")
            print("服务没在运行？先 python server.py status")
        return None


def fetch_clock(quiet=True):
    """当前交易日时钟；服务没起或口令不可用时返回 None"""
    return admin_call("/api/admin/clock", method="GET", quiet=quiet, timeout=3, action="查询")


def announce(text, minutes=30, kind="shutdown"):
    """给在线玩家下发系统公告；失败只提示、不阻断关服流程"""
    r = admin_call(
        "/api/admin/notice",
        {"text": text, "minutes": minutes, "kind": kind},
        quiet=True,
        action="公告",
    )
    return r is not None


def clear_notice():
    """撤下公告（等待被取消时必须撤，否则玩家盯着一条永远不发生的「即将关闭」）"""
    return admin_call("/api/admin/notice", {"clear": True}, quiet=True, action="公告") is not None


# ---------- 安全关服 ----------

def window_ready(data, opts):
    """判断此刻是不是可以安全停进程的窗口。返回 (是否安全, 阶段描述)。

    描述里**不带秒数**：调用方要靠它做变化检测去打进度，把每秒都在变的倒计时
    拼进来等于每行都不一样，节流就失效了。
    """
    day = data.get("day") or {}
    if not day.get("enabled"):
        # 没启用交易日时钟（day.enabled=false）就没有盘中盘后可言，随时可停
        return True, "未启用交易日时钟"

    phase = day.get("phase")
    label = day.get("label") or phase
    day_no = day.get("day")
    trading = bool(day.get("trading"))
    elapsed = int(day.get("phaseElapsedMs") or 0)

    if trading:
        return False, f"第 {day_no} 日 · {label}"

    if phase == "night":
        if elapsed < SETTLE_GRACE_MS:
            # 收盘竞价刚结束、日终结算正在跑：这一秒杀掉进程，重启要靠兜底补结，
            # 等两秒就能让它完整落盘，成本极低
            return False, f"第 {day_no} 日 · 收盘休市（日终结算中）"
        return True, f"第 {day_no} 日收盘休市（日终结算已完成）"

    if phase == "lunch":
        if opts["lunch"]:
            return True, f"第 {day_no} 日午间休市"
        return False, f"第 {day_no} 日 · 午间休市（加 --lunch 可就此停服）"

    return False, f"第 {day_no} 日 · {label}（非交易但不是休市窗口）"


def _left_seconds(data, day):
    """(本阶段剩余秒, 距今日收盘秒)，都用服务端时间算，避开两边时钟误差"""
    now = data.get("serverTime") or int(time.time() * 1000)
    left = max(0, int(((day.get("phaseEndsAt") or now) - now) / 1000))
    session_left = max(0, int(((day.get("dayEndsAt") or now) - now) / 1000))
    return left, session_left


def wait_for_window(opts):
    """阻塞等到安全窗口；返回 True 表示可以停服，False 表示放弃（不动服务器）"""
    deadline = time.time() + opts["timeout"]
    last_msg = ""
    last_print = 0.0
    announced = False

    while True:
        data = fetch_clock()
        if data is None:
            # 接口不通：可能进程刚好自己退了，也可能口令/端口不对
            if not get_pid():
                print("服务器已不在运行（PID 已消失）")
                return True
            if time.time() >= deadline:
                print(f"等不到服务端时钟（{ADMIN_TOKEN_FILE} / PORT 是否对得上？）")
                print("未停止服务器。确认服务无响应后可用: python server.py stop --force")
                return False
            if not announced:
                print("取不到交易日时钟，1 秒后重试（按 Ctrl+C 放弃）...")
                announced = True
            time.sleep(1)
            continue

        ready, msg = window_ready(data, opts)
        announced = False
        if ready:
            print(f"{msg} → 开始关服")
            return True

        if time.time() >= deadline:
            _, session_left = _left_seconds(data, data.get("day") or {})
            print(f"已等 {opts['timeout']} 秒仍未进入安全窗口（当前：{msg}，距收盘 {session_left} 秒）")
            print("未停止服务器。要立刻停请用: python server.py stop --now")
            return False

        now = time.time()
        # 阶段切换时必打，同一阶段最多 30 秒一行，别把终端刷满
        if msg != last_msg or now - last_print >= 30:
            _, session_left = _left_seconds(data, data.get("day") or {})
            print(f"等待收盘休市... {msg}，距今日收盘 {session_left} 秒")
            last_msg = msg
            last_print = now
        time.sleep(1)


def wait_pid_gone(pid, seconds):
    """等进程真的消失；超时返回 False"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        if not pid_alive(pid):
            return True
        time.sleep(0.5)
    return not pid_alive(pid)


def force_kill(pid):
    if os.name == "nt":
        subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
        return
    os.kill(pid, signal.SIGTERM)
    if wait_pid_gone(pid, 3):
        return
    try:
        os.kill(pid, signal.SIGKILL)
    except OSError:
        pass


def stop_server(pid):
    """先发关服指令让进程自己收尾，等不到再强杀"""
    # 先用 clock 探一下接口通不通：老版本服务没有这两个接口（404），
    # 这时发 shutdown 只会白等十几秒，直接说清楚再强杀
    if read_admin_token() and fetch_clock() is not None:
        print("向服务端发送关服指令...")
        admin_call("/api/admin/shutdown", {}, quiet=True, timeout=3, action="关服")
        if wait_pid_gone(pid, 15):
            remove_pid()
            print("服务器已停止（优雅关闭，存档已落盘）")
            return True
        print("15 秒内进程未退出，改为强制结束")
    else:
        print("服务端未响应运维接口（可能是旧版本或口令不匹配），直接结束进程")
        print("  新版服务启动后才会走优雅关闭")

    force_kill(pid)
    if wait_pid_gone(pid, 10):
        remove_pid()
        print("服务器已停止")
        return True
    print("停止失败：进程仍在运行")
    return False


def safe_stop(opts, verb="关闭"):
    """安全关服主流程；返回 True 表示进程已停（或本来就没起）。

    `verb` 只用于公告文案：stop 是「关闭」、restart 是「重启」，
    玩家看到的是"服务器即将重启"而不是"关闭"，免得以为不回来了。
    """
    pid = get_pid()
    if not pid:
        print("服务器未在运行")
        return True

    # PID 可能已被系统复用给无关进程，确认进程名再动手
    name = process_name(pid)
    if name not in NODE_NAMES:
        print(f"PID {pid} 当前是 {name or '未知进程'}，不是服务进程，已清理 PID 文件")
        remove_pid()
        return True

    if opts["force"]:
        print(f"跳过安全检查，直接结束进程 (PID: {pid})...")
        force_kill(pid)
        if wait_pid_gone(pid, 15):
            remove_pid()
            print("服务器已停止")
            return True
        print("停止失败：进程仍在运行")
        return False

    if opts["now"]:
        # 「立即关服」也要先把交易关掉：停牌是全市场一起冻结（报价、撮合、成交全停），
        # 玩家最多挂成一张不成交的死单，不会出现"最后一秒成交没落盘"
        print("立即关服：先冻结盘面（全市场停牌）...")
        r = admin_call(
            "/api/admin/halt",
            {"minutes": HALT_ON_STOP_MINUTES, "reason": f"运维{verb}"},
            quiet=True,
            action="停牌",
        )
        if r is None:
            print("停牌指令未送达（服务无响应或口令不可用），直接关进程")
        else:
            print(f"已停牌 {HALT_ON_STOP_MINUTES} 分钟，撮合已冻结，等在途 tick 落盘...")
            if announce(f"交易已暂停，服务器即将{verb}，请稍候重新连接", 5):
                # 多等一会儿：公告要真的渲染到玩家屏幕上，3 秒足够一次 SSE 帧
                print("已发公告，等 3 秒让在线玩家看到...")
                time.sleep(3)
            else:
                time.sleep(1.5)
        return stop_server(pid)

    print("安全检查：等交易日收盘休市窗口（Ctrl+C 可放弃）...")
    # 已经在安全窗口里（收盘休市 / --lunch 的午休）就不用发"等到收盘"那条：
    # 明明马上要动手，还公告"今日收盘后维护"只会让玩家以为还有很久
    pre = fetch_clock()
    ready_now = bool(pre) and window_ready(pre, opts)[0]
    posted = False
    if not ready_now:
        posted = announce(
            f"服务器将在今日收盘后{verb}维护（盘中照常交易），请提前处理挂单与持仓",
            max(10, int(opts["timeout"] / 60) + 10),
        )
        if posted:
            print(f"已发公告：今日收盘后{verb}维护")

    try:
        if not wait_for_window(opts):
            if posted and clear_notice():
                print("已撤下公告")
            return False
    except KeyboardInterrupt:
        if posted and clear_notice():
            print("\n已撤下公告，服务器未停止")
        raise

    # 窗口到了：再推一条「马上动手」，让正好在屏幕前的人有个准备
    if announce(f"服务器正在{verb}，正在保存存档，请稍候重新连接", 5):
        time.sleep(2)
    return stop_server(pid)


def safe_restart(opts):
    old_pid = get_pid()
    if not old_pid:
        return start()

    if not safe_stop(opts, verb="重启"):
        print("关服未完成，放弃重启")
        return False

    # 关键：必须等旧进程真的消失再 start，否则新进程抢端口 / 抢 PID 文件，
    # 起来就是一个 EADDRINUSE 的僵尸
    if not wait_pid_gone(old_pid, 30):
        print(f"旧进程 (PID: {old_pid}) 仍未退出，放弃重启")
        return False
    time.sleep(1)  # 让端口与 SQLite 文件句柄彻底释放

    if not start():
        return False

    if opts["now"]:
        # 停牌状态是**落盘**的（meta.halt），新进程会把刚才那次停牌读回来。
        # 立即重启的语义是「关窗即开张」，所以起来之后主动复牌
        data = admin_call("/api/admin/resume", {}, quiet=True, action="复牌")
        print("已复牌" if data is not None else "复牌失败，请手动 python server.py resume")

    ready = wait_ready()
    if ready:
        # 公告只存内存、随进程消失，所以「恢复了」这条必须起来之后再发
        announce("服务器已恢复，可以正常交易", 3, kind="info")
    return ready


def wait_ready(seconds=30):
    """start 之后确认服务真的能应答（不只进程活着、端口没在空转）"""
    deadline = time.time() + seconds
    while time.time() < deadline:
        data = fetch_clock()
        if data is not None:
            day = data.get("day") or {}
            extra = f"，第 {day.get('day')} 日 · {day.get('label')}" if day.get("enabled") else ""
            print(f"服务已就绪{extra}")
            return True
        if not get_pid():
            print("启动后进程已退出，查看 server-console.log")
            start_failure_hint()
            return False
        time.sleep(1)
    print(f"{seconds} 秒内服务未应答，进程可能还在初始化；稍后 status 确认")
    return False


# ---------- 其余命令 ----------

def status():
    pid = get_pid()
    if not pid:
        print("服务器未在运行")
        return

    print(f"服务器运行中 (PID: {pid})")
    data = fetch_clock(quiet=True)
    if data is None:
        print("  运维接口无应答（口令或端口不匹配）")
        return
    day = data.get("day") or {}
    if not day.get("enabled"):
        print("  交易日时钟未启用")
    else:
        left, session_left = _left_seconds(data, day)
        trading = bool(day.get("trading"))
        print(f"  第 {day.get('day')} 个交易日 · {day.get('label')}（{day.get('phase')}）")
        print(
            f"  {'可交易' if trading else '休市中'} | 本阶段剩 {left} 秒 | "
            f"距今日收盘 {session_left} 秒"
        )
    halt = data.get("halt") or {}
    if halt.get("halted"):
        secs = max(0, int((halt.get("until", 0) - time.time() * 1000) / 1000))
        print(f"  停牌中，剩 {secs // 60} 分 {secs % 60} 秒，原因: {halt.get('reason') or '未填写'}")
    ready, msg = window_ready(data, {"lunch": False})
    print(f"  现在能否安全关服: {'可以' if ready else '不行'} — {msg}")


def clock():
    """打印当前交易日时钟（纯只读，便于人工确认现在该不该动手）"""
    data = fetch_clock(quiet=False)
    if data is None:
        return
    day = data.get("day") or {}
    if not day.get("enabled"):
        print("交易日时钟未启用（config.day.enabled=false），随时可停服")
        return
    left, session_left = _left_seconds(data, day)
    print(f"第 {day.get('day')} 个交易日 · {day.get('label')}（{day.get('phase')}）")
    print(
        f"可交易: {'是' if day.get('trading') else '否'} | "
        f"本阶段剩 {left} 秒 | 距今日收盘 {session_left} 秒"
    )
    halt = data.get("halt") or {}
    if halt.get("halted"):
        until = halt.get("until", 0)
        secs = max(0, int((until - time.time() * 1000) / 1000))
        print(f"停牌中，剩 {secs // 60} 分 {secs % 60} 秒，原因: {halt.get('reason') or '未填写'}")
    ready, msg = window_ready(data, {"lunch": False})
    print(f"安全关服: {'可以' if ready else '需等待'} — {msg}")


def notice():
    """手动发 / 撤系统公告（玩家端顶部横幅 + 首次出现时一条 toast）"""
    args = sys.argv[2:]
    if not args:
        print('用法: python server.py notice "公告内容" [分钟]')
        print("      python server.py notice --clear")
        return
    if args[0] in ("--clear", "-c"):
        print("已撤下公告" if clear_notice() else "撤下失败（服务未运行或口令不匹配）")
        return
    text = args[0]
    minutes = 30
    if len(args) > 1:
        try:
            minutes = float(args[1])
        except ValueError:
            print(f"有效分钟数需要是数字: {args[1]}")
            return
    if announce(text, minutes, kind="info"):
        print(f"已发公告（{int(minutes)} 分钟后自动消失）: {text}")
    else:
        print("发送失败（服务未运行或口令不匹配）")


def halt():
    minutes = 5
    if len(sys.argv) > 2:
        try:
            minutes = float(sys.argv[2])
        except ValueError:
            print(f"停牌时长必须是数字（分钟）: {sys.argv[2]}")
            return
    reason = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""
    data = admin_call("/api/admin/halt", {"minutes": minutes, "reason": reason}, action="停牌")
    if data is None:
        return
    left = max(0, int((data.get("until", 0) - time.time() * 1000) / 1000))
    print(f"已停牌 {left // 60} 分 {left % 60} 秒，原因: {data.get('reason') or '未填写'}")


def resume():
    data = admin_call("/api/admin/resume", {}, action="复牌")
    if data is None:
        return
    print("已复牌" if data.get("resumed") else "当前本来就没有停牌")


def whales():
    """打印 AI 主力完整持仓（仅运维口令；不会出现在任何玩家接口里）"""
    data = admin_call("/api/admin/whales", method="GET", action="查询")
    if data is None:
        return

    print(
        f"AI 主力组合 | 第 {data.get('day')} 交易日 · {data.get('phaseLabel')} | "
        f"LLM={'开' if data.get('llmEnabled') else '关'}"
    )
    dec = data.get("lastDecision")
    if dec:
        print(
            f"上一轮决策: {dec.get('phaseLabel')} day{dec.get('day')} "
            f"bias={dec.get('merged') and dec['merged'].get('bias')}"
        )
        for d in dec.get("decisions") or []:
            mark = "✓" if d.get("ok") else "✗"
            stocks = ",".join(s.get("stockName", "") for s in d.get("stocks") or []) or "-"
            ords = d.get("orders") or []
            otxt = "；".join(
                f"{'✓' if o.get('ok') else '✗'}{o.get('stockName')}{o.get('qty')}@{o.get('price')}"
                for o in ords
            ) or f"挂单{d.get('ordersPlaced') or 0}"
            note = (d.get("note") or d.get("error") or "")[:36]
            print(f"  {mark} {d.get('label')}: {stocks} | {otxt} | {note}")
    else:
        print("上一轮决策: （内存无记录，等下一次触发）")
    hist = data.get("decisionHistory") or []
    print(f"决策历史 {len(hist)} 条（观测页可看详情）")
    print("-" * 72)
    for w in data.get("whales", []):
        print(
            f"[{w['label']}] {w['account']}  "
            f"权益 {w['equity']:,.2f}  现金 {w['cash']:,.2f}  "
            f"已实现 {w['realizedPnL']:,.2f}  风险度 {w['marginUsage']:.2%}"
        )
        if not w["positions"]:
            print("  持仓: （空仓）")
        for p in w["positions"]:
            sides = []
            if p["longQty"]:
                sides.append(f"多 {p['longQty']}股 成本{p['longCost']} 盈亏{p['longPnl']}")
            if p["shortQty"]:
                sides.append(f"空 {p['shortQty']}股 成本{p['shortCost']} 盈亏{p['shortPnl']}")
            print(f"  {p['stockName']}({p['stockId']}) 现价{p['last']}: " + " | ".join(sides))
        if w["orders"]:
            print(f"  在途委托 {len(w['orders'])} 笔:")
            for o in w["orders"]:
                print(
                    f"    {o['stockName']} {o['action']} {o['qty']}@{o['price']} "
                    f"({o['status']} 成交{o['filled']})"
                )
        if w["recentTrades"]:
            print(f"  最近成交 {len(w['recentTrades'])} 笔:")
            for t in w["recentTrades"][:5]:
                print(f"    {t['stockName']} {t['action']} {t['qty']}@{t['price']}")
        print()


def parse_options(args):
    opts = {"now": False, "force": False, "lunch": False, "timeout": DEFAULT_WAIT_SECONDS}
    i = 0
    while i < len(args):
        a = args[i]
        if a == "--now":
            opts["now"] = True
        elif a == "--force":
            opts["force"] = True
        elif a == "--lunch":
            opts["lunch"] = True
        elif a.startswith("--timeout="):
            opts["timeout"] = _seconds(a.split("=", 1)[1])
        elif a == "--timeout" and i + 1 < len(args):
            i += 1
            opts["timeout"] = _seconds(args[i])
        else:
            print(f"忽略未知参数: {a}")
        i += 1
    return opts


def _seconds(raw):
    try:
        v = float(raw)
    except ValueError:
        print(f"--timeout 需要秒数: {raw}")
        sys.exit(EXIT_FAIL)
    if v <= 0:
        print(f"--timeout 必须大于 0: {raw}")
        sys.exit(EXIT_FAIL)
    return int(v)


USAGE = """用法: python server.py [start|stop|restart|status|clock|notice|halt|resume|whales]

  stop            安全关服：收盘休市即刻停，盘中则等当天收盘后再停（会先发公告）
  restart         安全重启：安全关服后**等旧进程真正退出**再 start，起来后确认可达并公告恢复
  status          进程状态 + 当前交易日阶段 + 现在能否安全关服
  clock           只读：当前交易日时钟（阶段 / 剩余时间 / 是否停牌）
  notice          发一条系统公告（所有在线玩家顶部横幅 + toast）
                  python server.py notice "今天 22:00 例行维护" [分钟]
                  python server.py notice --clear

stop / restart 参数：
  --now           立即执行：先全市场停牌冻结撮合、发公告，再停进程（不等收盘）
  --force         不做任何检查直接结束进程（救火用）
  --lunch         午间休市也算安全窗口（默认只认收盘后）
  --timeout=N     最长等待秒数，默认 900；超时不动服务器并返回退出码 2"""


def main():
    if len(sys.argv) < 2:
        print(USAGE)
        return

    cmd = sys.argv[1].lower()

    try:
        if cmd in ("stop", "restart"):
            opts = parse_options(sys.argv[2:])
            ok = safe_restart(opts) if cmd == "restart" else safe_stop(opts)
            sys.exit(EXIT_OK if ok else EXIT_TIMEOUT)

        actions = {
            "start": start,
            "status": status,
            "clock": clock,
            "notice": notice,
            "halt": halt,
            "resume": resume,
            "whales": whales,
        }

        if cmd in actions:
            r = actions[cmd]()
            if cmd == "start" and r is False:
                sys.exit(EXIT_FAIL)
        else:
            print(f"未知命令: {cmd}")
            print(USAGE)
    except KeyboardInterrupt:
        # 等待收盘的途中按了 Ctrl+C：什么都不做，服务器保持原样
        print("\n已取消，服务器未停止")
        sys.exit(130)


if __name__ == "__main__":
    main()
