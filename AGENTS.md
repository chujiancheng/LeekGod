# AGENTS.md

# 服务器操作
cd Server
启动指令 python server.py start
停止指令 python server.py stop
重启指令 python server.py restart
以上三种操作都通过上面的指令进行

# 依赖
Server 需要 npm 依赖（log4js 日志 + better-sqlite3 存档）。新环境首次运行前先在 Server 目录执行 npm install，
否则 node index.js 会直接报模块找不到、服务起不来。

# 数据存档
账号/持仓/挂单/成交流水/令牌/行情断点存在 Server/data/game.db（SQLite），重启会接着上一局继续。
想开新一局：停服后删掉 Server/data/game.db（连同 -wal / -shm）再启动。

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
统一走 Server/src/logger.js（log4js），落盘在 Server/server.log，超 5MB 轮转。
新代码不要用 console.log/error（test/ 下测试脚本自身输出除外）。
