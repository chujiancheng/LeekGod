"""
游戏服务器管理脚本
用法: python server.py [start|stop|restart|status|halt|resume]

halt / resume 通过服务端的运维接口实现（口令见 data/admin.token），
需要服务正在运行；端口口径与 node 一致，都取环境变量 PORT，默认 3000。
"""
import subprocess
import sys
import os
import signal
import time
import json
from urllib import error as urlerror
from urllib import request as urlrequest

PID_FILE = os.path.join(os.path.dirname(__file__), "server.pid")
LOG_FILE = os.path.join(os.path.dirname(__file__), "server.log")
SERVER_DIR = os.path.dirname(__file__)
SERVER_ENTRY = os.path.join(SERVER_DIR, "index.js")
ADMIN_TOKEN_FILE = os.path.join(SERVER_DIR, "data", "admin.token")

LOG_MAX_BYTES = 5 * 1024 * 1024
NODE_NAMES = {"node.exe", "node"}


def process_name(pid):
    """取 PID 对应的进程名（小写）；进程不存在或无法判定时返回 None"""
    if os.name == "nt":
        try:
            out = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                capture_output=True,
                text=True,
                creationflags=subprocess.CREATE_NO_WINDOW,
            )
        except Exception:
            return None
        lines = [l for l in out.stdout.strip().splitlines() if l.strip()]
        if not lines:
            return None
        fields = lines[0].split('","')
        # 无匹配时 tasklist 输出的是提示文本，拆不出多个 CSV 字段
        if len(fields) < 2:
            return None
        return fields[0].strip('"').lower()
    try:
        with open(f"/proc/{pid}/comm", "r", encoding="utf-8") as f:
            return f.read().strip().lower()
    except OSError:
        return None


def pid_alive(pid):
    """探活：Windows 上 os.kill(pid, 0) 会直接结束进程，必须用 tasklist 检查"""
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
    """日志超过阈值时轮转一次，避免长期运行无限增长"""
    if not os.path.exists(LOG_FILE):
        return
    try:
        if os.path.getsize(LOG_FILE) < LOG_MAX_BYTES:
            return
        backup = LOG_FILE + ".1"
        if os.path.exists(backup):
            os.remove(backup)
        os.replace(LOG_FILE, backup)
    except OSError:
        pass


def start():
    pid = get_pid()
    if pid:
        print(f"服务器已在运行 (PID: {pid})")
        return

    print("正在启动服务器...")
    rotate_log()
    log = open(LOG_FILE, "a", encoding="utf-8")
    creationflags = 0
    if os.name == "nt":
        # 独立进程组 + 与控制台解绑，避免父终端退出时带走服务
        creationflags = (
            subprocess.CREATE_NEW_PROCESS_GROUP
            | getattr(subprocess, "DETACHED_PROCESS", 0x00000008)
        )
    process = subprocess.Popen(
        ["node", SERVER_ENTRY],
        cwd=SERVER_DIR,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=log,
        creationflags=creationflags,
    )
    save_pid(process.pid)
    time.sleep(1)

    if process.poll() is not None:
        print("启动失败，查看 server.log")
        remove_pid()
    else:
        print(f"服务器已启动 (PID: {process.pid})")
        print(f"访问地址: http://{os.environ.get('HOST', '0.0.0.0')}:{os.environ.get('PORT', '3000')}")
        print(f"日志文件: {LOG_FILE}")


def stop():
    pid = get_pid()
    if not pid:
        print("服务器未在运行")
        return

    # PID 可能已被系统复用给无关进程，确认进程名再动手
    name = process_name(pid)
    if name not in NODE_NAMES:
        print(f"PID {pid} 当前是 {name or '未知进程'}，不是服务进程，已清理 PID 文件")
        remove_pid()
        return

    print(f"正在停止服务器 (PID: {pid})...")
    try:
        if os.name == "nt":
            subprocess.run(["taskkill", "/F", "/PID", str(pid)], capture_output=True)
        else:
            os.kill(pid, signal.SIGTERM)
            time.sleep(2)
            try:
                os.kill(pid, 0)
                os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        print("服务器已停止")
    except Exception as e:
        print(f"停止失败: {e}")
    finally:
        remove_pid()


def restart():
    stop()
    time.sleep(1)
    start()


def status():
    pid = get_pid()
    if pid:
        print(f"服务器运行中 (PID: {pid})")
    else:
        print("服务器未在运行")


def admin_post(path, payload):
    """调用服务端的运维接口。口令由服务端首次启动时生成，这里读同一份文件"""
    try:
        with open(ADMIN_TOKEN_FILE, "r", encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        token = ""
    if not token:
        print(f"读不到运维口令: {ADMIN_TOKEN_FILE}")
        print("先 python server.py start 让它生成一次，或用 ADMIN_TOKEN 环境变量指定")
        return

    port = os.environ.get("PORT", "3000")
    req = urlrequest.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "X-Admin-Token": token},
        method="POST",
    )
    try:
        with urlrequest.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as e:
        try:
            data = json.loads(e.read().decode("utf-8"))
        except Exception:
            data = {}
        print(f"操作被拒绝: {data.get('error', e.reason)}")
        return
    except Exception as e:
        print(f"调用失败: {e}")
        print("服务没在运行？先 python server.py status")
        return

    if path.endswith("halt"):
        left = max(0, int((data.get("until", 0) - time.time() * 1000) / 1000))
        print(f"已停牌 {left // 60} 分 {left % 60} 秒，原因: {data.get('reason') or '未填写'}")
    else:
        print("已复牌" if data.get("resumed") else "当前本来就没有停牌")


def halt():
    minutes = 5
    if len(sys.argv) > 2:
        try:
            minutes = float(sys.argv[2])
        except ValueError:
            print(f"停牌时长必须是数字（分钟）: {sys.argv[2]}")
            return
    reason = " ".join(sys.argv[3:]) if len(sys.argv) > 3 else ""
    admin_post("/api/admin/halt", {"minutes": minutes, "reason": reason})


def resume():
    admin_post("/api/admin/resume", {})


def main():
    if len(sys.argv) < 2:
        print("用法: python server.py [start|stop|restart|status|halt|resume]")
        return

    cmd = sys.argv[1].lower()
    actions = {
        "start": start,
        "stop": stop,
        "restart": restart,
        "status": status,
        "halt": halt,
        "resume": resume,
    }

    if cmd in actions:
        actions[cmd]()
    else:
        print(f"未知命令: {cmd}")
        print("可用命令: start, stop, restart, status, halt, resume")


if __name__ == "__main__":
    main()
