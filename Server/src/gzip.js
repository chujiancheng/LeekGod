/**
 * HTTP gzip 压缩（REST 大响应 + SSE 行情流共用）。
 *
 * 为什么需要（2026-10-22）：state / markets 这类 JSON 满屏重复字段名，gzip 能压掉
 * 85%~90%（实测 /api/events 81KB→~9KB、/open/v1/stream 默认参数 52KB→~7KB）。
 * 在此之前量化客户端一条 SSE 连接 0.6Mbps、按 240/分 轮询全量行情一条 1.7Mbps，
 * 几个客户端叠加就是 10Mbps 级别。
 *
 * 两类出口：
 *   1. REST（json()/send()）：body 够大且客户端 Accept-Encoding 带 gzip 时，
 *      一次性 gzipSync 后下发，带 Content-Encoding: gzip + Vary: Accept-Encoding；
 *   2. SSE（sseEncoder()）：连接建立时若客户端支持，挂一个常驻 gzip 流在 res 前面，
 *      帧全部写进压缩流，**每帧之后 flush()（Z_SYNC_FLUSH）**——SSE 客户端必须
 *      能立刻解出当前帧，不能等缓冲攒满。每 tick 每连接一次 flush 的 CPU 开销
 *      在 700ms 的 tick 间隔下可以忽略（level 1，80KB 帧 ≈ 1ms）。
 *
 * 兼容性：浏览器 EventSource / requests（urllib3）/ OkHttp 都默认带
 * Accept-Encoding: gzip 且透明解压；curl 与 urllib.request 不主动带该头，
 * 服务端就不压缩——老脚本零改动继续跑，想省流量加个 --compressed 即可。
 */
const zlib = require('zlib');
const config = require('./config');

const MIN_BYTES = 1024; // 小于 1KB 的响应不值得省那几百字节（压缩头 + CPU）
const REST_LEVEL = 6; // 一次性压缩：用默认级别换更高压缩比
const SSE_LEVEL = 1; // 每 tick 都要压：速度优先，10 只股票的重复结构 level 1 已够压

function enabled() {
  return !!(config.http && config.http.gzip && config.http.gzip.enabled);
}

/** 客户端是否接受 gzip（SSE 建连与 REST 响应共用一个判定） */
function acceptsGzip(req) {
  if (!req || !req.headers) return false;
  return /\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''));
}

/**
 * REST 响应体：需要压缩时返回 gzip 后的 Buffer，否则返回 null（调用方原文下发）。
 * `str` 是已序列化的 JSON 字符串。
 */
function gzipBody(req, str) {
  if (!enabled() || str.length < MIN_BYTES || !acceptsGzip(req)) return null;
  return zlib.gzipSync(Buffer.from(str, 'utf8'), { level: REST_LEVEL });
}

/**
 * SSE 压缩通道：客户端支持时返回一个已 pipe 到 res 的 gzip 流，
 * 调用方此后把 res.write 换成 out.write，并在**每个完整事件之后** out.flush()。
 * 返回 null 表示不支持，调用方按原样直写 res。
 */
function sseEncoder(req, res) {
  if (!enabled() || !acceptsGzip(req)) return null;
  const gz = zlib.createGzip({ level: SSE_LEVEL });
  gz.pipe(res);
  return gz;
}

/**
 * 连接的待发积压字节（诊断/背压判定用）：SSE 走压缩流时，
 * 压缩前的队列（out.writableLength）+ 压缩后交给内核前的队列（res.writableLength）都要算。
 */
function bufferedOf(res, out) {
  return (out ? out.writableLength : 0) + (res ? res.writableLength : 0);
}

module.exports = { acceptsGzip, gzipBody, sseEncoder, bufferedOf };
