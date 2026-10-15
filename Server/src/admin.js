/**
 * 运维口令：停牌 / 复牌接口的唯一凭据。
 *
 * 服务监听 0.0.0.0，同网络的玩家直接就能发包，所以运维接口不能裸奔。
 * 口令落在文件里而不是环境变量：node 进程与 server.py 是两个独立进程，
 * 读同一份文件省掉两边同步环境变量的麻烦（环境变量随终端会话丢）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const { logger } = require('./logger');

/** 与存档路径同口径：相对 Server 目录解析 */
function tokenPath() {
  return path.resolve(__dirname, '..', config.admin.tokenFile);
}

function writeToken(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value, { encoding: 'utf8', mode: 0o600 });
}

/** 优先用 ADMIN_TOKEN，其次读文件，都没有就生成一个并落盘 */
function loadToken() {
  const file = tokenPath();
  const fromEnv = String(process.env.ADMIN_TOKEN || '').trim();
  try {
    if (fromEnv) {
      writeToken(file, fromEnv);
      return fromEnv;
    }
    if (fs.existsSync(file)) {
      const saved = fs.readFileSync(file, 'utf8').trim();
      if (saved) return saved;
    }
    const generated = crypto.randomBytes(16).toString('hex');
    writeToken(file, generated);
    logger.info(`[我是股神] 已生成运维口令: ${file}`);
    return generated;
  } catch (e) {
    // 拿不到口令就关掉运维接口，总好过让它裸奔
    logger.warn(`[我是股神] 运维口令不可用，停牌接口已禁用: ${e.message}`);
    return '';
  }
}

const token = loadToken();

/** 定时比较，避免按字符探测口令 */
function authorized(given) {
  const g = String(given || '').trim();
  if (!token || !g) return false;
  const a = Buffer.from(g);
  const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const enabled = () => !!token;

module.exports = { authorized, enabled, tokenPath };
