"""
开放平台 API Key 管理（/open/v1 的凭据）

用法:
    python openkey.py issue <账号> [--label 备注] [--scopes read,trade] [--ip 192.168.1.]
                                   [--base http://1.2.3.4:3000] [--handout]
    python openkey.py list [账号] [--all]
    python openkey.py revoke <KeyID>

`--handout` 会额外打印一段可直接私聊发给玩家的发货文案（玩家申请流程见
Doc/玩家申请APIKey.md）；`--base` 是写给玩家的服务器地址，默认 http://127.0.0.1:3000。

需要服务正在运行（走 /api/admin/keys 运维接口，口令读 data/admin.token）。
端口口径与 server.py / node 一致：环境变量 PORT，默认 3000。

**明文 Key 只在 issue 时打印一次**：服务端库里只存 sha256，丢了这个字符串就只能撤销重发。
"""
import json
import os
import sys
import datetime
from urllib import error as urlerror
from urllib import request as urlrequest

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
ADMIN_TOKEN_FILE = os.path.join(SERVER_DIR, "data", "admin.token")


def read_token():
    # 与 src/admin.js 的 loadToken 同口径：环境变量优先，其次读文件
    env = os.environ.get("ADMIN_TOKEN", "").strip()
    if env:
        return env
    try:
        with open(ADMIN_TOKEN_FILE, "r", encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


def call(method, path, payload=None):
    token = read_token()
    if not token:
        print(f"读不到运维口令: {ADMIN_TOKEN_FILE}")
        print("先 python server.py start 让它生成一次，或用 ADMIN_TOKEN 环境变量指定")
        return None
    port = os.environ.get("PORT", "3000")
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    headers = {"X-Admin-Token": token}
    if data is not None:
        headers["Content-Type"] = "application/json"
    req = urlrequest.Request(f"http://127.0.0.1:{port}{path}", data=data, headers=headers, method=method)
    try:
        with urlrequest.urlopen(req, timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urlerror.HTTPError as e:
        try:
            body = json.loads(e.read().decode("utf-8"))
        except Exception:
            body = {"ok": False, "error": f"HTTP {e.code}"}
        return body
    except Exception as e:
        print(f"请求失败（服务没起？端口 {port}）: {e}")
        return None


def parse_args(argv):
    """`--k v` 取值，`--k` 单独出现当成 True（布尔开关，如 --handout）。"""
    positional, opts = [], {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            key = a[2:]
            if i + 1 < len(argv) and not argv[i + 1].startswith("--"):
                opts[key] = argv[i + 1]
                i += 2
            else:
                opts[key] = True
                i += 1
        else:
            positional.append(a)
            i += 1
    return positional, opts


def print_handout(r, base):
    """发货文案：运维复制→私聊发给玩家。不要贴群，也不要截图。"""
    line = "=" * 52
    print("")
    print(line)
    print("复制下面整段，私聊发给玩家：")
    print(line)
    print("【我是股神 · 开放接口凭据】")
    print(f"服务器地址：{base}")
    print(f"账号：{r['account']}")
    print(f"KeyID：{r['id']}")
    print(f"Key：{r['key']}")
    print(f"权限：{r['scopes']}")
    print("")
    print("这串 Key 只显示这一次，丢了只能重新申请；请不要截图、不要发到群里。")
    print("拿到后先自检（约 2 分钟）：")
    print(f"  export GUSHEN_API_KEY='{r['key']}'")
    print(f"  export GUSHEN_BASE='{base}'")
    print('  curl -s -H "X-API-Key: $GUSHEN_API_KEY" $GUSHEN_BASE/open/v1/ping')
    print(f"  Windows：set GUSHEN_API_KEY={r['key']}  &  set GUSHEN_BASE={base}")
    print('  看到 "ok": true 就是通了')
    print("完整指南：Doc/玩家申请APIKey.md")
    print(line)


def cmd_issue(pos, opts):
    if not pos:
        print("用法: python openkey.py issue <账号> [--label 备注] [--scopes read,trade] [--ip 1.2.3.]")
        print("                              [--base http://1.2.3.4:3000] [--handout]")
        return
    body = {"account": pos[0]}
    if "label" in opts:
        body["label"] = opts["label"]
    if "scopes" in opts:
        body["scopes"] = opts["scopes"]
    if "ip" in opts:
        body["ipAllow"] = opts["ip"]
    r = call("POST", "/api/admin/keys", body)
    if not r:
        return
    if not r.get("ok"):
        print(f"签发失败: {r.get('error')}")
        return
    print(f"已签发 → 账号 {r['account']}  权限 {r['scopes']}  备注 {r.get('label') or '无'}")
    print(f"KeyID : {r['id']}")
    print(f"Key   : {r['key']}")
    print("")
    print("这串 Key 只显示这一次（服务端只存哈希）。把它填进策略脚本：")
    print("    export GUSHEN_API_KEY='" + r["key"] + "'")

    if opts.get("handout"):
        base = str(opts.get("base") or os.environ.get("PUBLIC_BASE") or "http://127.0.0.1:3000")
        base = base.rstrip("/")
        print_handout(r, base)
        if "127.0.0.1" in base or "localhost" in base:
            print("")
            print("⚠️ 发货文案里的地址还是本机回环，玩家多半访问不到。")
            print("   请加 --base http://<对外地址>:<端口> 重新生成。")


def cmd_list(pos, opts):
    path = "/api/admin/keys"
    if pos:
        path += "?account=" + pos[0]
    r = call("GET", path)
    if not r or not r.get("ok"):
        print(f"读取失败: {r.get('error') if r else '无响应'}")
        return
    rows = r.get("keys") or []
    if not rows:
        print("还没有任何 Key")
        return
    # 已撤销的默认不列：运维看这张表是为了判断「还剩几把名额」，混进历史会误判
    revoked = [k for k in rows if k.get("revoked")]
    show_all = bool(opts.get("all"))
    if not show_all:
        rows = [k for k in rows if not k.get("revoked")]
    if not rows:
        print(f"没有有效 Key（另有 {len(revoked)} 把已撤销，加 --all 查看）")
        return
    print(f"{'KeyID':10} {'账号':16} {'权限':12} {'最近使用':20} 备注")
    for k in rows:
        used = k.get("lastUsedAt")
        used_s = datetime.datetime.fromtimestamp(used / 1000).strftime("%Y-%m-%d %H:%M") if used else "从未"
        state = "  [已撤销]" if k.get("revoked") else ""
        print(f"{k['id']:10} {k['account']:16} {k['scopes']:12} {used_s:20} {k.get('label') or ''}{state}")
    if revoked and not show_all:
        print(f"（另有 {len(revoked)} 把已撤销，未列出；加 --all 查看）")


def cmd_revoke(pos, opts):
    if not pos:
        print("用法: python openkey.py revoke <KeyID>")
        return
    r = call("DELETE", "/api/admin/keys/" + pos[0])
    if not r:
        return
    print(f"已撤销 {r['id']}（{r.get('account')}）" if r.get("ok") else f"撤销失败: {r.get('error')}")


def main():
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help"):
        print(__doc__.strip())
        return
    cmd, pos, opts = argv[0], *parse_args(argv[1:])
    if cmd == "issue":
        cmd_issue(pos, opts)
    elif cmd == "list":
        cmd_list(pos, opts)
    elif cmd == "revoke":
        cmd_revoke(pos, opts)
    else:
        print(f"未知命令: {cmd}")
        print(__doc__.strip())


if __name__ == "__main__":
    main()
