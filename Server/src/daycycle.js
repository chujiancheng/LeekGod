/**
 * 交易日时钟：把连续时间切成「天」，一天再切成若干阶段（集合竞价 / 上午 / 午休 / 下午 / 收盘竞价 / 夜间）。
 *
 * 设计要点：
 * - **服务端权威**。阶段只由 `startAt`（本轮开盘时刻）与当前时间推出，是**纯函数**，
 *   没有任何内部状态。于是重启后不需要恢复什么，把 `startAt` 存进 meta 就能接着上一局的时间轴走；
 *   客户端也不许自己算阶段，一律吃服务端下发的 `day` 段。
 * - **刻意不按真实时长等比压缩**。真实 A 股盘中 250 分钟压到 10 分钟是 25 倍，
 *   等比压缩下收盘集合竞价只剩 7 秒——而竞价与尾盘恰恰是博弈密度最高的两段。
 *   这里给它们超额配时（两段竞价合计 50 秒占一天的 8%），日内连续交易占 79%。
 * - 每个阶段额外带 `gameTime` / `gameMs`：把游戏内的 30 秒竞价线性映射到真实的
 *   09:15→09:25，于是客户端顶栏可以直接显示真实时刻，玩家顺带学会真实规则。
 *
 * 阶段字段：
 *   key          阶段标识
 *   label        中文名（横幅与日志）
 *   gameTime     该阶段在真实交易日的起始时刻 HH:MM
 *   gameMs       该阶段在真实交易日的长度（毫秒），用于把游戏内进度线性映射成真实时刻
 *   ms           游戏内该阶段的长度（毫秒）
 *   trading      true = 接受下单（竞价阶段也接受，只是不连续撮合）
 *   auction      'open' | 'close' = 集合竞价阶段，阶段结束时集中撮合
 *   cancelLockMs 集合竞价最后这么多毫秒内不可撤单（真实市场 09:20 之后不可撤，制造心理压力）
 */

/** 一天内各阶段的累计起止（构造时算一次，供 O(阶段数) 定位用） */
class DayCycle {
  /**
   * @param {object} cfg config.day
   * @param {number} startAt 基准时刻：第 1 天开盘集合竞价的开始时间
   */
  constructor(cfg, startAt = Date.now()) {
    this.cfg = cfg || {};
    this.enabled = !!this.cfg.enabled;
    this.phases = Array.isArray(this.cfg.phases) && this.cfg.phases.length ? this.cfg.phases : [];
    this.dayMs = this.phases.reduce((a, p) => a + p.ms, 0);
    this.startAt = startAt;
    // 每个阶段的起始偏移，避免每次 locate 都重新累加
    this.offsets = [];
    let acc = 0;
    for (const p of this.phases) {
      this.offsets.push(acc);
      acc += p.ms;
    }
  }

  /** 时钟没有配置阶段时退化为「只有一个永远可交易的阶段」，等价于「没有天」的旧行为 */
  get ok() {
    return this.enabled && this.phases.length > 0 && this.dayMs > 0;
  }

  /** 重启恢复：把基准时刻换成本局开盘时刻（存 meta.round_started_at） */
  reanchor(startAt) {
    if (Number.isFinite(startAt)) this.startAt = startAt;
  }

  /**
   * 定位 now 所处的交易日与阶段。O(阶段数)，与停服多久无关。
   * @returns {{day:number, phaseIndex:number, phase:object, phaseStartAt:number, phaseEndsAt:number,
   *            elapsedMs:number, leftMs:number, dayStartAt:number, dayEndsAt:number, gameClockMs:number}}
   */
  locate(now = Date.now()) {
    if (!this.ok) return null;
    const elapsed = Math.max(0, now - this.startAt);
    const dayIndex = Math.floor(elapsed / this.dayMs);
    const rest = elapsed - dayIndex * this.dayMs;
    let idx = this.phases.length - 1;
    for (let k = 0; k < this.phases.length; k++) {
      if (rest < this.offsets[k] + this.phases[k].ms) {
        idx = k;
        break;
      }
    }
    const phase = this.phases[idx];
    const dayStartAt = this.startAt + dayIndex * this.dayMs;
    const phaseStartAt = dayStartAt + this.offsets[idx];
    const elapsedMs = rest - this.offsets[idx];
    return {
      day: dayIndex + 1,
      phaseIndex: idx,
      phase,
      phaseStartAt,
      phaseEndsAt: phaseStartAt + phase.ms,
      elapsedMs,
      leftMs: phase.ms - elapsedMs,
      dayStartAt,
      dayEndsAt: dayStartAt + this.dayMs,
      gameClockMs: gameClock(phase, elapsedMs),
    };
  }

  /** 当前是否可交易（竞价也算——只是不连续撮合） */
  canTrade(now = Date.now()) {
    if (!this.ok) return true;
    const st = this.locate(now);
    return !!st.phase.trading;
  }

  /** 当前是否集合竞价阶段：返回 'open' / 'close'，否则 null */
  auction(now = Date.now()) {
    if (!this.ok) return null;
    const st = this.locate(now);
    return st.phase.auction || null;
  }

  /**
   * 集合竞价是否已进入「不可撤单」窗口。
   * 真实市场 09:20 那条硬线是整个竞价系统最有价值的心理设计点：
   * 想撤的人撤不掉、想追的人不敢追。这里用阶段尾部的 cancelLockMs 复刻。
   */
  auctionLocked(now = Date.now()) {
    if (!this.ok) return false;
    const st = this.locate(now);
    const p = st.phase;
    if (!p.auction) return false;
    const lockMs = p.cancelLockMs || 0;
    if (!lockMs) return false;
    return st.leftMs <= lockMs;
  }

  /** 下发给客户端的 day 段（不含任何内幕：阶段、剩余时间、游戏内时刻而已） */
  snapshot(now = Date.now()) {
    if (!this.ok) return { enabled: false, trading: true };
    const st = this.locate(now);
    return {
      enabled: true,
      day: st.day,
      phase: st.phase.key,
      label: st.phase.label,
      trading: !!st.phase.trading,
      auction: st.phase.auction || null,
      locked: this.auctionLocked(now),
      // 竞价倒计时的分段：剩余多少毫秒进入「不可撤单」
      unlockLeftMs: st.phase.auction && st.phase.cancelLockMs
        ? Math.max(0, st.leftMs - st.phase.cancelLockMs)
        : null,
      phaseMs: st.phase.ms,
      phaseElapsedMs: st.elapsedMs,
      phaseLeftMs: Math.max(0, st.leftMs),
      phaseEndsAt: st.phaseEndsAt,
      dayEndsAt: st.dayEndsAt,
      gameClockMs: st.gameClockMs,
      phaseGameMs: st.phase.gameMs || st.phase.ms,
    };
  }
}

/** 'HH:MM' → 自 00:00 起的毫秒 */
function parseGameTime(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return 0;
  return (Number(m[1]) * 60 + Number(m[2])) * 60000;
}

/**
 * 阶段内的游戏内时刻：按「该阶段在游戏里的进度」线性映射到真实交易日的同一段。
 * 竞价 30 秒 → 09:15~09:25，上午 230 秒 → 09:30~11:30，夜间 40 秒 → 15:00~次日 09:15。
 */
function gameClock(phase, elapsedMs) {
  const start = parseGameTime(phase.gameTime);
  const span = phase.gameMs || phase.ms;
  const offset = (Math.max(0, Math.min(1, elapsedMs / phase.ms)) * span) % (24 * 3600000);
  return (start + offset) % (24 * 3600000);
}

/** 自 00:00 起的毫秒 → 'HH:MM:SS' */
function formatGameClock(ms) {
  let v = Math.floor((ms % (24 * 3600000) + 24 * 3600000) % (24 * 3600000));
  const h = Math.floor(v / 3600000);
  v -= h * 3600000;
  const m = Math.floor(v / 60000);
  const s = Math.floor((v - m * 60000) / 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

module.exports = { DayCycle, formatGameClock };
