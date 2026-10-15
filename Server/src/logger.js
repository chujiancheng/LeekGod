/**
 * 日志：统一走 log4js
 *
 * 落盘不在这一层做——server.py 把 node 的 stdout/stderr 重定向到 server/server.log
 * 并负责超限轮转。这里只配 stdout appender，避免同一个日志文件出现两个写入方、
 * 两套轮转逻辑（Windows 下另一个句柄持有文件时重命名会直接失败）。
 */
const log4js = require('log4js');
const config = require('./config');

log4js.configure({
  appenders: {
    out: {
      type: 'stdout',
      // 不用带颜色的 layout：输出会被重定向进 server.log，ANSI 转义码只是噪音
      layout: {
        type: 'pattern',
        pattern: '%d{yyyy-MM-dd hh:mm:ss.SSS} [%p] %c - %m',
      },
    },
  },
  categories: {
    default: { appenders: ['out'], level: config.log.level },
  },
});

module.exports = {
  logger: log4js.getLogger('server'),
  getLogger: (category) => log4js.getLogger(category),
};
