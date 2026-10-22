/**
 * SSE 写背压闸门（`SseHub` 与开放接口 `/open/v1/stream` 共用）。
 *
 * 为什么需要它（2026-10-22 事故）：SSE 每 tick 给每条连接写一整帧全量快照
 * （约 80~100KB）。客户端只要是「连上了但读不动」——手机 App 熄屏/进后台被系统
 * 冻结、笔记本合盖休眠、弱网掉到几 KB/s——内核接收窗口就会一直满着，Node 只能把
 * 每一帧的字符串堆在 `res` 的写队列里，**且永远不会自己丢**。
 *
 * 实测（`output/probe-sse-backpressure.js`，1200 tick）：
 *   - 正常消费的连接：写队列恒 0，堆 +3.5MB（正常 GC 波动）
 *   - 不读的连接：写队列涨到 93MB，堆 +390MB → 约 1.6GB/小时
 * 正式服 2026-10-22 的 1.1GB/h 线性爬升、以及「客户端一断就整块掉下来」的堆曲线，
 * 都与这个吻合；02:30 / 09:30 两次 OOM 也是它。
 *
 * 判定策略（都是「每帧都是全量快照」这个前提换来的，丢中间帧对客户端无损）：
 *   1. 写队列 ≥ slowSkipBytes：**跳过本 tick 的帧**，不写；
 *   2. 写队列 ≥ slowDropBytes：已经废了，拆连接（客户端按 `retry: 2000` 重连，
 *      重连时立刻拿一帧全量快照，界面自动恢复）；
 *   3. 连续被跳过超过 slowKickMs：同样是僵尸连接，拆掉，别白占 `maxConnections` 配额。
 *
 * 注意：`res.writableLength` 只算「已经在 Node 里排队、还没交给内核」的字节，
 * 内核 socket buffer 里的那部分看不到——所以门槛不能设得太贴（0.5MB 起跳，
 * 折合 5~6 帧），正常玩家偶发一秒半秒的抖动不会被误判。
 */

class SseBackpressure {
  /**
   * @param {{slowSkipBytes?: number, slowDropBytes?: number, slowKickMs?: number}} cfg
   * @param {(conn: object, reason: string, buffered: number) => void} onDrop
   *   需要拆连接时的回调（由各自 hub 决定怎么摘池子 + 怎么记日志）
   */
  constructor(cfg, onDrop) {
    this.cfg = cfg || {};
    this.onDrop = onDrop || (() => {});
    this.skipBytes = this.cfg.slowSkipBytes || 512 * 1024;
    this.dropBytes = this.cfg.slowDropBytes || 8 * 1024 * 1024;
    this.kickMs = this.cfg.slowKickMs || 60000;
  }

  /** 队列是否已经超过「该跳过」的门槛（含计数/计时，返回 true 表示本帧可以写） */
  check(conn, now = Date.now()) {
    const n = conn.res.writableLength || 0;
    if (n >= this.dropBytes) {
      this.onDrop(conn, '写队列超限', n);
      return false;
    }
    if (n >= this.skipBytes) {
      if (!conn._slowSince) {
        conn._slowSince = now;
        conn._slowFrames = 0;
      }
      conn._slowFrames += 1;
      if (now - conn._slowSince >= this.kickMs) {
        this.onDrop(conn, '长时间追不上', n);
        return false;
      }
      return false;
    }
    // 队列回到门槛以下：如果之前积压过，记一笔「追上了」，方便事后看日志判断影响面
    if (conn._slowSince && conn.onRecover) {
      conn.onRecover(conn._slowFrames || 0, now - conn._slowSince);
    }
    conn._slowSince = 0;
    conn._slowFrames = 0;
    return true;
  }

  /** 当前积压字节数（诊断用） */
  static bufferedOf(conn) {
    return conn.res.writableLength || 0;
  }

  /** 本 hub 的积压快照：连接数、单条最大、合计（诊断用） */
  static stats(conns) {
    let max = 0;
    let sum = 0;
    let slow = 0;
    for (const c of conns) {
      const n = SseBackpressure.bufferedOf(c);
      sum += n;
      if (n > max) max = n;
      if (n >= 512 * 1024) slow += 1;
    }
    return { count: conns.size || conns.length || 0, max, sum, slow };
  }
}

module.exports = { SseBackpressure };
