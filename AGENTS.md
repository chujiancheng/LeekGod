# AGENTS.md

# 项目知识（强制流程）
完整项目知识在 Doc/项目知识.md，是架构/配置/API/表结构的权威文档。
- 修改代码/配置**之前**先读它的相关章节；
- 修改**之后**，若行为、配置、架构、API、表结构有变化，必须同步更新它并在文末「变更记录」追加一条。
本文只保留运维硬规则；交易规则与设计决策另见项目 MEMORY 中「我是股神」条目。

# 服务器操作
cd Server
启动指令 python server.py start
停止指令 python server.py stop
重启指令 python server.py restart
以上三种操作都通过上面的指令进行

stop / restart 是**安全关服**，不是立刻杀进程：
- 当前处于收盘休市（交易日时钟的 night 段）→ 直接停；
- 盘中 / 集合竞价 / 午休 → 挂机等当天收盘，落进休市窗口再停（默认最多等 900 秒，超时不动服务器、退出码 2）；
- restart 会**等旧进程真正退出才 start**，起来后再确认服务可达。
参数：
  --now    立即执行：先向服务端发停牌指令冻结撮合、公告「交易已暂停」，再关进程（不等收盘）；
           restart --now 起来后自动复牌
  --force  不做任何检查直接结束进程（救火用，不发公告）
  --lunch  午间休市也算安全窗口（默认只认收盘后）
  --timeout=N  最长等待秒数，默认 900

公告（玩家端顶部横幅 + toast）：
- 安全 stop/restart 会自动发：等待开始发「今日收盘后关闭/重启维护」，动手前发「正在关闭」，
  restart 就绪后发「已恢复」；等待被取消/超时会自动撤下公告。
- 手动发：python server.py notice "内容" [分钟]；撤下：python server.py notice --clear

查看现状：
  python server.py status   # 进程 + 当前交易日阶段 + 现在能否安全关服
  python server.py clock    # 只读：阶段 / 剩余时间 / 是否停牌

注意：Agent 在会话内**不要**跑 start/stop/restart（PID 文件全局一份，会打掉用户正在跑的正式服务）；
临时验证用 GU_PID_FILE + PORT + PERSIST_FILE 各指一份临时路径，跑完清临时文件。

**临时验证绝不能设 `ADMIN_TOKEN` 环境变量**（2026-10-22 事故）：src/admin.js 在读到 ADMIN_TOKEN 时
会把它**写回 Server/data/admin.token**，把正式服的运维口令覆盖掉——正式服内存里还是旧口令，
之后 server.py 的 clock/stop/notice 全部 403，restart 表现为「等不到交易日时钟」无限重试。
临时实例要定制口令只能用 `ADMIN_TOKEN_FILE=<临时路径>`（config.js 支持，server.py 不读它，两不相扰）。

# 内存体检（堆一直涨时先看这个）
curl -H "x-admin-token: <Server/data/admin.token>" http://127.0.0.1:3000/api/admin/memory
- 先看 sse.bufferedMb / maxBufferedMb / slowConnections：**持续上涨就是有客户端读不动**
  （App 熄屏、笔记本休眠、弱网），帧被堆在写队列里——2026-10-22 两次 OOM 都是它，
  闸门见 src/sseback.js；其次才怀疑引擎容器（memory.heapUsedMb）与堆外（rss − heapTotal）。
- 堆日志跨进程连着读会骗人：used 从 GB 级掉到百 MB 级多半是进程重启，不是「日切释放」，
  对照 `服务已启动` 与 server-console.log 里的 PID 再下结论。

# 开放平台 API Key（玩家量化策略）
玩家自助路径（常规，不需要你操作）：登录游戏 → 主页「开放接口」→ /portal.html 生成 / 查看 / 撤销。
页面走 /api/open/keys（会话令牌鉴权，只能操作自己的 Key），明文只在浏览器弹层出现一次。

运维代管（仅在需要锁 IP、帮查、账号被盗时用）：
cd Server
签发：python openkey.py issue <账号> [--label 备注] [--scopes read,trade] [--ip 127.0.0.1] [--base 对外地址] [--handout]
列表：python openkey.py list [账号] [--all]
撤销：python openkey.py revoke <KeyID>
- 需要服务正在运行；账号必须已在游戏里开完户（有昵称 + 券商）。
- **明文 Key 只在签发时打印一次**（库里只存 sha256），丢了只能撤销重发，谁都无法找回。
- `--handout --base http://<对外地址>:3000` 会打印一段可直接私聊转发的发货文案（含自检命令）；
  不要发群、不要截图。代发前核对：账号名（不是昵称）、已开户、现有 Key 未满 8 把。
- 网页生成不绑 IP；玩家要锁来源时用上面 `--ip` 代发。
- 接口文档 Doc/开放平台API.md（完全手册，含逐字段说明与可直接给 AI 的施工说明），
  玩家入门 Doc/玩家申请APIKey.md（玩家版，网页自助，不含运维命令），
  示例策略 Server/examples/quant_ma.py（双均线演示）、Server/examples/quant_template.py（长期运行骨架）、
  Server/examples/quant_grid.py（波动率自适应网格，震荡市）。
- 会话令牌与 API Key 是两套凭据，不能互相顶替。
- **`Server/examples/` 那四个示例脚本本地带真实 Key**（用户 2026-10-22 选定「只本地用不提交」）：
  `quant_ma.py` / `quant_template.py` / `quant_rotation.py` / `quant_grid.py` 在 git 里都打了
  `skip-worktree` 标记——**暂存区与远端只有 `API_KEY = ""` 的空版本，工作区里是真 Key**。
  改这几个文件前先 `git update-index --no-skip-worktree <文件>`，改完立刻重新 `--skip-worktree`；
  `git pull` / `checkout` 报 "local changes would be overwritten" 也是这个标记造成的，不是真的冲突。
  **任何时候都不要为了改它们而顺手 `git add`**，那会把 Key 写进仓库（推上去就是公开泄露）。
- 启动器 `Server/examples/run-quant.bat` 是**纯 ASCII + CRLF**，跟 Mobile/build-apk.bat 同规矩：中文注释会让 cmd
  读错行。只做一件事：改顶部 SCRIPT / ARGS / KEY 三行，然后把参数原样传给 Python。KEY 留空就用 .py 里的 API_KEY 常量。

# 依赖
Server 需要 npm 依赖（log4js 日志 + better-sqlite3 存档）。新环境首次运行前先在 Server 目录执行 npm install，
否则 node index.js 会直接报模块找不到、服务起不来。

# 数据存档
账号/持仓/挂单/成交流水/令牌/行情断点存在 **D:/GushenData/game.db**（SQLite+WAL，2026-10-20 从
Server/data/ 迁到 D 盘机械硬盘，为省 SSD 磨损；路径在 Server/src/config.js `persistence.file`）。
重启会接着上一局继续。想开新一局：停服后删掉 D:/GushenData/game.db（连同 -wal / -shm）再启动。
WAL checkpoint 阈值已调大到 64MB（db.js `wal_autocheckpoint`，机械盘配套）。

# 验收 / 调试不要污染正式存档
正式存档只放真实对局数据。跑验收、调试、截图这类验证时，用 PERSIST_FILE 指向一个临时库，
验证完直接删临时文件，game.db 全程不碰：

    $env:PERSIST_FILE="$env:TEMP\gushen-verify.db"; python server.py start

要点：
- 服务运行中直接改 game.db 没用：内存里的账号会被脏标记或兜底扫描重新写回，必须停服再改。
- 登录是按名字即时建号的，所以验收账号一旦在浏览器里留下 localStorage（gushen_name / token），
  下次进页面会自动把它重建出来。清理验收数据时要连浏览器本地存储一起清。
- 停服时不要顺手删 game.db，先确认那是不是正式存档。

# 日志
统一走 Server/src/logger.js（log4js），**按天切割**落盘在 Server/log/server.YYYY-MM-DD.log，自动保留 30 天。
node 的 stdout/stderr 由 server.py 重定向到 Server/log/server-console.log，只承接启动早期崩溃输出。
新代码不要用 console.log/error（test/ 下测试脚本自身输出除外）。
