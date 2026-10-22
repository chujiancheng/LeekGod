/**
 * SSE 写背压测试：node test/sse.test.js
 *
 * 背景（2026-10-22 事故）：SSE 每 tick 写一整帧全量快照（~90KB）。客户端「连上了但读不动」
 * （App 熄屏 / 笔记本休眠 / 弱网）时，帧会无限堆在 res 写队列里，实测单条 1.6GB/小时，
 * 正式服两档上限（4GB / 2.5GB）都被它撞爆过。修法见 src/sseback.js。
 *
 * 覆盖：
 *   ① 闸门单元：健康连接放行 / 过跳过线只跳帧不拆 / 过硬线拆 / 久追不上拆 / 追上后复位
 *   ② 真实链路：不读的连接积压被**压在上限以内**（回归断言：修复前会涨到十几 MB）
 *   ③ 正常消费的连接不受影响（写队列恒 0、字节持续增长）
 *   ④ 僵尸连接会被拆掉（不能白占 maxConnections 配额）
 *   ⑤ /api/admin/memory 能看到积压明细
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const config = require('../src/config');
// 测试里把门槛调小，几帧就能触发；生产值见 config.http.sse
config.http.sse.slowSkipBytes = 64 * 1024;
config.http.sse.slowDropBytes = 2 * 1024 * 1024;
config.http.sse.slowKickMs = 200;

const { SseBackpressure } = require('../src/sseback');
const { Game } = require('../src/game');
const { createServer } = require('../src/http');

let passed = 0;
let failed = 0;
function assert(cond, msg) {
  if (cond) {
    passed += 1;
    console.log('  ✓ ' + msg);
  } else {
    failed += 1;
    console.log('  ✗ ' + msg);
  }
}

// ---------- ① 闸门单元 ----------
console.log('\n[1] SseBackpressure 单元');
{
  const drops = [];
  const b = new SseBackpressure({ slowSkipBytes: 1000, slowDropBytes: 5000, slowKickMs: 1000 }, (c, why) =>
    drops.push(why)
  );
  const mk = (n) => ({ res: { writableLength: n } });

  assert(b.check(mk(0)) === true, '队列 0 → 放行');
  assert(b.check(mk(999)) === true, '队列刚过门槛一半 → 仍放行');

  const slow = mk(2000);
  const t0 = 100000;
  assert(b.check(slow, t0) === false, '越过跳过线 → 本帧不写');
  assert(b.check(slow, t0 + 100) === false, '继续慢 → 继续跳帧');
  assert(drops.length === 0, '跳过线内不拆连接（让它自己追上）');
  assert(slow._slowFrames >= 2, '跳帧计数在累加');

  // 追上了：复位 + 回调
  let recovered = 0;
  slow.onRecover = () => (recovered = 1);
  slow.res.writableLength = 0;
  assert(b.check(slow, t0 + 200) === true, '队列恢复 → 重新放行');
  assert(recovered === 1, '追上时触发 onRecover');
  assert(!slow._slowSince && !slow._slowFrames, '追上后慢标记复位');

  // 一直追不上 → 拆
  const stuck = mk(2000);
  b.check(stuck, t0);
  b.check(stuck, t0 + 500);
  assert(drops.length === 0, '未到 slowKickMs 不拆');
  b.check(stuck, t0 + 1500);
  assert(drops.length === 1 && drops[0] === '长时间追不上', '超过 slowKickMs → 拆（长时间追不上）');

  const huge = mk(6000);
  b.check(huge, t0);
  assert(drops.length === 2 && drops[1] === '写队列超限', '超过硬线 → 立刻拆（写队列超限）');

  const stats = SseBackpressure.stats([mk(10), mk(2000), mk(6000)]);
  assert(stats.count === 3 && stats.max === 6000 && stats.sum === 8010, 'stats 汇总连接数/最大/合计');
  assert(stats.slow === 0 || stats.slow === 2, 'slow 计数口径可用');
}

// ---------- ②③④ 真实链路 ----------
const tmpDb = path.join(os.tmpdir(), `gushen-sse-${process.pid}.db`);
for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const g = new Game({ file: tmpDb });
  g.start();
  const brokerKey = Object.keys(config.brokers.list)[0];
  const reg = g.onboard('probe-sse', '背压测试', brokerKey);
  if (!reg.ok) {
    console.log('开户失败，测试中止:', reg);
    process.exit(1);
  }
  const server = createServer(g, {});
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const hub = server.sseHub;

  function connect(mode) {
    return new Promise((resolve) => {
      const sock = net.connect({ port, host: '127.0.0.1' }, () => {
        sock.write(
          `GET /api/events?token=${reg.token} HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n`
        );
        if (mode === 'stall') sock.pause();
        else {
          sock.bytes = 0;
          sock.on('data', (b) => (sock.bytes += b.length));
        }
        setTimeout(() => resolve(sock), 100);
      });
      sock.on('error', () => {});
    });
  }

  const reader = await connect('read');
  const staller = await connect('stall');
  // 服务端 conn.res.socket 是**另一头**的 socket，不能直接对象比较；
  // 客户端 localPort === 服务端 remotePort，用它对号入座
  const connOf = (sock) =>
    [...hub.conns].find((c) => c.res.socket && c.res.socket.remotePort === sock.localPort);
  const tick = async (n, gap) => {
    for (let i = 0; i < n; i++) {
      g.tick();
      await new Promise((r) => setImmediate(r));
      if (gap) await sleep(gap);
    }
  };

  console.log('\n[2] 不读的连接：积压被闸门压在门槛附近，不再无界增长');
  // 120 帧循环本身要跑几百毫秒，先把「久追不上」的计时门槛放宽，专门观察积压是否被压住
  hub.back.kickMs = 60000;
  await tick(120, 0);
  const stalledConn = connOf(staller);
  const stallerBuf = stalledConn ? stalledConn.res.writableLength || 0 : 0;
  assert(!!stalledConn, '不读的连接仍在池子里（跳过线内不拆）');
  // 120 帧 ≈ 10MB 未修复；修复后应该停在跳过线附近
  assert(
    stallerBuf < config.http.sse.slowDropBytes,
    `积压未越硬线（实测 ${(stallerBuf / 1024).toFixed(0)}KB < ${config.http.sse.slowDropBytes / 1024}KB）`
  );
  assert(stallerBuf >= config.http.sse.slowSkipBytes * 0.5, '积压确实被压到了跳过线附近（不是没写）');

  console.log('\n[3] 正常消费的连接不受影响');
  const readerConn = connOf(reader);
  assert(readerConn && (readerConn.res.writableLength || 0) < 4096, '正常连接的写队列保持近 0');
  assert(reader.bytes > 0, `正常连接持续收到字节（${(reader.bytes / 1024).toFixed(0)}KB）`);

  console.log('\n[4] 一直追不上的连接被拆掉');
  const before = hub.conns.size;
  hub.back.kickMs = 0; // 立刻判定「久追不上」，模拟连续一分钟塞不进一帧
  await tick(3, 0);
  assert(hub.conns.size === before - 1, '僵尸连接已从池中摘除');
  assert(!connOf(staller), '确实是那条不读的连接被拆的');
  assert(connOf(reader) != null, '正常连接仍在');

  console.log('\n[5] /api/admin/memory 能看到积压明细');
  const adminToken = fs.readFileSync(require('../src/admin').tokenPath(), 'utf8').trim();
  const req = (p, headers) =>
    new Promise((resolve) => {
      const http = require('http');
      const r = http.request({ port, host: '127.0.0.1', path: p, headers }, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      });
      r.on('error', () => resolve({ status: 0, body: '' }));
      r.end();
    });
  const noAuth = await req('/api/admin/memory');
  assert(noAuth.status === 403, '无口令 → 403');
  const ok = await req('/api/admin/memory', { 'x-admin-token': adminToken });
  let parsed = {};
  try {
    parsed = JSON.parse(ok.body);
  } catch (e) {
    /* 留空由断言兜 */
  }
  assert(ok.status === 200 && parsed.ok === true, '带口令 → 200');
  assert(parsed.memory && typeof parsed.memory.heapUsedMb === 'number', '返回堆用量');
  assert(parsed.memory.rssMb > 0 && parsed.memory.externalMb >= 0, '返回 rss / 堆外');
  assert(parsed.sse && typeof parsed.sse.connections === 'number', '返回推送连接数与积压');

  reader.destroy();
  staller.destroy();
  await new Promise((r) => server.close(r));
  for (const s of ['', '-wal', '-shm']) fs.rmSync(tmpDb + s, { force: true });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
