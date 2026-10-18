/**
 * 日志：统一走 log4js，按天切割落盘
 *
 * dateFile appender 直接以「server.YYYY-MM-DD.log」命名当天文件，跨天时关闭旧
 * 文件、打开新文件——全程不重命名已打开的句柄（Windows 下句柄被占用时 rename
 * 会直接失败，所以不能用 fileSync / 重命名式轮转那套）。旧文件按 daysToKeep 清理。
 *
 * node 的 stdout/stderr 仍由 server.py 重定向到 server-console.log，只承接
 * logger 初始化之前的崩溃输出（缺模块、语法错误等），与这里的文件互不相干。
 */
const path = require('path');
const fs = require('fs');
const log4js = require('log4js');
const config = require('./config');

// 日志保留天数，超期由 log4js 自动清理（dateFile 的 numBackups = 按天保留的份数）
const LOG_KEEP_DAYS = 30;
const LOG_DIR = path.join(__dirname, '..');
fs.mkdirSync(LOG_DIR, { recursive: true });

log4js.configure({
  appenders: {
    daily: {
      type: 'dateFile',
      filename: path.join(LOG_DIR, 'server.log'),
      pattern: 'yyyy-MM-dd',
      // 当天文件名也带日期：打开的始终是「最终名字」，不做任何重命名
      keepFileExt: true,
      alwaysIncludePattern: true,
      numBackups: LOG_KEEP_DAYS,
      // 不用带颜色的 layout：落的是纯文本文件，ANSI 转义码只是噪音
      layout: {
        type: 'pattern',
        pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} [%p] %c - %m',
      },
    },
  },
  categories: {
    default: { appenders: ['daily'], level: config.log.level },
  },
});

module.exports = {
  logger: log4js.getLogger('server'),
  getLogger: (category) => log4js.getLogger(category),
};
