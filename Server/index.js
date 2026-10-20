/**
 * 服务入口：node index.js（由 python server.py start 管理）
 */
const path = require('path');
const config = require('./src/config');
const { logger } = require('./src/logger');
const { Game } = require('./src/game');
const { createServer } = require('./src/http');
const { Persister } = require('./src/persist');

// 收尾重入标记放在最前面：shutdown 定义在文件末尾（声明提升），
// 但标记若跟着定义走，启动早期的信号就会撞上 TDZ
let closing = false;

const archive = openArchive();
const game = new Game({ persist: archive });
game.start();
if (archive) {
  logger.info(
    `[我是股神] 存档: ${path.resolve(config.persistence.file)} | ` +
      `账户 ${game.store.all().length} 个 | 本轮开局 ${new Date(game.startedAt).toLocaleString()}`
  );
}

const server = createServer(game, { onShutdown: shutdown });
server.listen(config.port, '0.0.0.0', () => {
  logger.info(`[我是股神] 服务已启动: http://127.0.0.1:${config.port}`);
  logger.info(
    `规则: 初始资金 ${config.account.initialCash} | 手续费 ${config.trade.feeRate} | ` +
      `锁仓 ${config.trade.lockMs / 1000} 秒 | 冷却 ${config.trade.cooldownMs / 1000} 秒 | ` +
      `保证金 ${config.margin.ratio * 100}% / 维持 ${config.margin.maintenance * 100}%`
  );
});

/** 打开存档；打不开就直接失败退出，不要在"钱读不出来"的状态下继续跑 */
function openArchive() {
  if (!config.persistence.enabled) {
    logger.info('[我是股神] 持久化已关闭（PERSIST=0），本次运行不落盘');
    return null;
  }
  try {
    return new Persister(config.persistence.file);
  } catch (e) {
    logger.fatal(`[我是股神] 存档初始化失败: ${e.message}`);
    logger.fatal('确认不需要旧数据后，删除存档文件重开新局');
    process.exit(1);
  }
}

/**
 * 收尾：停 tick → 关存档 → 关监听 → 退出。
 *
 * 三个入口共用一份实现：SIGINT / SIGTERM（Ctrl+C、Linux 的 kill）与
 * 运维关服接口（`POST /api/admin/shutdown`，由 `python server.py stop/restart` 调）。
 * 重入保护是必须的：关服接口触发之后，脚本还可能在超时后补一刀，两条路径撞上来
 * 不能把 archive.close() 跑两遍。
 */
function shutdown(reason) {
  if (closing) return;
  closing = true;
  logger.info(`[我是股神] 正在关闭${reason ? `（${reason}）` : ''}...`);
  game.stop();
  archive?.close();
  server.close(() => process.exit(0));
  // SSE 长连接会让 server.close 的回调永远等不到，兜底一秒后直接退
  setTimeout(() => process.exit(0), 1000);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
