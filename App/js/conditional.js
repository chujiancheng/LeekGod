/* ==========================================================================
   conditional.js — 条件单（服务端自动化策略，与网页端「自动」同源）
   四类：止盈止损 / 网格 / 双均线 / 定投

   口径与服务端 Server/src/auto.js 完全一致：
     - 只走 POST /api/auto（op = create / update / remove）
     - 列表来自 state.account.auto（SSE 每帧下发，不用自己轮询）
     - 参数校验以服务端为准，前端只做「明显填错」的拦截，避免两套规则漂移
   条件单由服务端每 tick 代执行，玩家下线也照跑；休市/停牌期间冻结。
   ========================================================================== */
(function (GS) {
  'use strict';

  const { $, esc, fmtP, fmtQty, fmtMoney, fmtTime, num, toast } = GS.core;

  /** 类型元数据：顺序即弹层里的展示顺序 */
  const TYPES = [
    { id: 'tps', name: '止盈止损', tip: '触价自动平仓，一次性' },
    { id: 'grid', name: '网格', tip: '跌一格买、涨一格卖' },
    { id: 'ma', name: '双均线', tip: '快线上穿买、下穿卖' },
    { id: 'dca', name: '定投', tip: '按时分批买入' },
  ];
  const TYPE_NAME = {};
  TYPES.forEach((t) => {
    TYPE_NAME[t.id] = t.name;
  });

  /* ------------------------------------------------------------ 数据读取 */

  /** 账户当前全部条件单（服务端已按创建时间倒序） */
  function list() {
    const st = GS.core.S.state;
    const a = st && st.account;
    return a && Array.isArray(a.auto) ? a.auto : [];
  }

  function listOf(stockId) {
    return list().filter((s) => s.stockId === stockId);
  }

  function activeCount() {
    return list().filter((s) => s.enabled && !s.done).length;
  }

  /** 新建时的默认标的：优先「当前正在看的股票」，其次第一只 */
  function defaultStockId() {
    const st = GS.core.S.state;
    const rows = (st && st.rules && st.rules.stocks) || [];
    return GS.core.S.stockId || (rows[0] && rows[0].id) || '';
  }

  /**
   * 默认方向跟持仓走：只持空头就选空头，其余一律多头。
   * 服务端 `position` 缺省也是多头，这里只是把「明显的意图」提前选好，避免用户
   * 建了个空头止盈止损却按多头方向去算触发价。
   */
  function defaultPosition(stockId) {
    const p = GS.core.position(stockId);
    const lq = num(p && p.long && p.long.qty);
    const sq = num(p && p.short && p.short.qty);
    return !lq && sq > 0 ? 'short' : 'long';
  }

  /* ------------------------------------------------------------ 文案展示 */

  function paramsText(s) {
    const p = s.params || {};
    if (s.type === 'tps') {
      const parts = [p.position === 'short' ? '空头' : '多头'];
      if (p.tp) parts.push('止盈 ' + fmtP(p.tp));
      if (p.sl) parts.push('止损 ' + fmtP(p.sl));
      parts.push(p.qty > 0 ? fmtQty(p.qty) + ' 股' : '全部');
      return parts.join(' · ');
    }
    if (s.type === 'grid') {
      return (
        '基准 ' + fmtP(p.base) + ' · 间距 ' + p.stepPct + '% · 每格 ' +
        fmtQty(p.qty) + ' 股 · 最多 ' + p.maxLevels + ' 格'
      );
    }
    if (s.type === 'ma') {
      return '快线 ' + p.fast + ' · 慢线 ' + p.slow + ' tick · 每次投入 ' + p.budgetPct + '%';
    }
    if (s.type === 'dca') {
      return (
        '每次 ' + fmtMoney(p.amount) + ' 元 · 间隔 ' + Math.round(num(p.intervalMs) / 1000) +
        ' 秒 · ' + (p.maxTimes > 0 ? '共 ' + p.maxTimes + ' 次' : '不限次数')
      );
    }
    return '';
  }

  /** 状态标签：已完成 > 已暂停 > 各自运行态 */
  function tagOf(s) {
    const st = s.state || {};
    if (s.done) return '<span class="tag">已完成</span>';
    if (!s.enabled) return '<span class="tag">已暂停</span>';
    if (s.type === 'tps') {
      return st.waiting
        ? '<span class="tag tag-gold">待平仓</span>'
        : '<span class="tag tag-good">监控中</span>';
    }
    if (s.type === 'grid') {
      const max = (s.params && s.params.maxLevels) || 0;
      return '<span class="tag tag-good">运行中 ' + num(st.openLevels) + '/' + max + '</span>';
    }
    if (s.type === 'ma') {
      if (!st.ready) {
        // 预热进度与网页端同口径：已完成 tick / 慢线窗口
        const slow = num(s.params && s.params.slow) || 0;
        const done = Math.max(0, slow - num(st.warmupLeft));
        return '<span class="tag">采集中 ' + done + '/' + slow + '</span>';
      }
      return '<span class="tag tag-good">运行中</span>';
    }
    return '<span class="tag tag-good">运行中</span>';
  }

  /**
   * 创建时间：当天只给时分秒（和 App 其它地方一致），跨天补 M-D。
   * 服务端连跑几天后，只显示 09:12:33 会让人以为是今天建的。
   */
  function fmtWhen(ts) {
    const t = num(ts);
    if (!t) return '—';
    const d = new Date(t);
    const now = new Date(GS.core.serverNow());
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? fmtTime(t) : d.getMonth() + 1 + '-' + d.getDate() + ' ' + fmtTime(t).slice(0, 5);
  }

  /* ---------------------------------------------------------------- 列表 */

  function rowHtml(s) {
    const evt = s.events && s.events.length ? s.events[0] : null;
    const toggle = s.done
      ? ''
      : '<button class="mini-btn" data-cond-toggle="' + esc(s.id) + '" data-enable="' +
        (s.enabled ? '0' : '1') + '">' + (s.enabled ? '暂停' : '启用') + '</button>';
    return (
      '<div class="list-row" data-cond="' + esc(s.id) + '">' +
        '<div class="list-main">' +
          '<div class="list-t1">' + esc(s.stockName || s.stockId) + ' ' + tagOf(s) + '</div>' +
          '<div class="list-t2">' + esc(TYPE_NAME[s.type] || s.typeLabel || s.type) +
            ' · ' + esc(paramsText(s)) + '</div>' +
          (evt ? '<div class="list-t3">' + fmtTime(evt.t) + ' ' + esc(evt.text) + '</div>' : '') +
        '</div>' +
        '<div class="list-right">' + toggle + '</div>' +
      '</div>'
    );
  }

  function render(box) {
    if (!box) return;
    const rows = list();
    let html;
    if (!rows.length) {
      html =
        '<div class="empty"><div class="empty-icon">🎯</div>还没有条件单<br>' +
        '<span class="hint">点下方「新建条件单」，让服务端替你盯盘</span></div>';
    } else {
      html = rows.map(rowHtml).join('');
    }
    // 内容没变就别重写：SSE 每 700ms 一帧，每帧重写会把玩家正按着的「暂停」按钮换成新节点，
    // 按下与抬起落在两个节点上 → 这一次点击直接丢（列表里有按钮，必须门控）
    if (box.dataset.condSig === html) return;
    box.dataset.condSig = html;
    box.innerHTML = html;
  }

  /* ------------------------------------------------------------ 交互绑定 */

  /** 事件委托绑在容器上（容器 innerHTML 会被反复替换，委托本身只绑一次） */
  function bind(root) {
    GS.core.on(root, '[data-cond-toggle]', 'click', (e, t) => {
      e.stopPropagation();
      const id = t.dataset.condToggle;
      const enable = t.dataset.enable === '1';
      t.disabled = true;
      GS.api.api
        .auto({ op: 'update', id, enabled: enable })
        .then((r) => {
          const ok = !!(r && r.ok);
          // 失败要把按钮解开：失败时行内容不变 → 列表签名不变 → 不会重绘，
          // 不手动恢复的话这个按钮就永久灰着（只能切 tab 才能再点）
          if (!ok) t.disabled = false;
          toast(ok ? (enable ? '已启用' : '已暂停') : (r && r.error) || '操作失败', ok ? 'ok' : 'err');
        })
        .catch(() => {
          t.disabled = false;
          toast('网络异常', 'err');
        });
    });

    GS.core.on(root, '[data-cond]', 'click', (e, t) => {
      openDetail(t.dataset.cond);
    });
  }

  /* ---------------------------------------------------------------- 详情 */

  function openDetail(id) {
    const s = list().find((x) => x.id === id);
    if (!s) {
      toast('条件单不存在（可能已被删除）', 'err');
      return;
    }
    const st = s.state || {};
    const events = (s.events || [])
      .map(
        (ev) =>
          '<div class="cd-evt"><span class="num">' + fmtTime(ev.t) + '</span>' + esc(ev.text) + '</div>'
      )
      .join('');
    const extra = [];
    if (s.type === 'grid') {
      if (st.nextBuy != null) extra.push(fieldLine('下一格买入价', '≤ ' + fmtP(st.nextBuy)));
      if (st.nextSell != null) extra.push(fieldLine('下一格卖出价', '≥ ' + fmtP(st.nextSell)));
      extra.push(fieldLine('持有格数', num(st.openLevels) + ' 格 / ' + fmtQty(num(st.heldShares)) + ' 股'));
    } else if (s.type === 'ma') {
      extra.push(fieldLine('均线状态', st.ready ? (st.side === 1 ? '多头排列' : st.side === 0 ? '空头排列' : '待定') : '采集中 ' + num(st.warmupLeft) + ' tick'));
      if (st.pendingSignal != null) extra.push(fieldLine('待执行信号', st.pendingSignal === 1 ? '买入' : '卖出'));
    } else if (s.type === 'dca') {
      extra.push(fieldLine('已投次数', num(st.doneTimes) + ' 次'));
      extra.push(fieldLine('累计投入', '¥' + fmtMoney(num(st.totalSpent))));
      if (st.nextAt > Date.now()) extra.push(fieldLine('下次投入', fmtTime(st.nextAt)));
    } else if (s.type === 'tps' && st.waiting) {
      extra.push(fieldLine('触发状态', '已触发，等待可平仓'));
    }

    const html =
      '<div class="cd-head">' +
        '<div class="cd-name">' + esc(s.stockName || s.stockId) + '</div>' +
        '<div class="cd-sub">' + esc(TYPE_NAME[s.type] || s.typeLabel || s.type) + ' ' + tagOf(s) + '</div>' +
      '</div>' +
      '<div class="sec-title">参数</div>' +
      fieldLine('条件', paramsText(s)) +
      extra.join('') +
      fieldLine('创建时间', fmtWhen(s.createdAt)) +
      '<div class="sec-title">最近动作</div>' +
      (events || '<div class="hint">暂无动作记录</div>') +
      '<div class="cd-acts">' +
        (s.done
          ? ''
          : '<button class="btn-flat" id="cdToggle">' + (s.enabled ? '暂停条件单' : '启用条件单') + '</button>') +
        '<button class="btn-flat is-danger" id="cdDel">删除</button>' +
      '</div>' +
      '<div class="hint">条件单由服务端每 tick 代执行，App 关掉也照跑；暂停只是不再下单，已挂的单不受影响。</div>';

    GS.core.sheet({
      title: '条件单详情',
      html,
      onMount(ctl) {
        const body = ctl.body;
        const tg = body.querySelector('#cdToggle');
        if (tg) {
          tg.onclick = () => {
            tg.disabled = true;
            GS.api.api
              .auto({ op: 'update', id: s.id, enabled: !s.enabled })
              .then((r) => {
                const ok = !!(r && r.ok);
                toast(ok ? '已更新' : (r && r.error) || '操作失败', ok ? 'ok' : 'err');
                if (ok) GS.core.closeSheet();
                else tg.disabled = false;
              })
              .catch(() => {
                tg.disabled = false;
                toast('网络异常', 'err');
              });
          };
        }
        const del = body.querySelector('#cdDel');
        if (del) {
          del.onclick = () => {
            if (!window.confirm('删除该条件单？已经挂出去的委托不受影响。')) return;
            del.disabled = true;
            GS.api.api
              .auto({ op: 'remove', id: s.id })
              .then((r) => {
                const ok = !!(r && r.ok);
                toast(ok ? '已删除' : (r && r.error) || '删除失败', ok ? 'ok' : 'err');
                if (ok) GS.core.closeSheet();
                else del.disabled = false;
              })
              .catch(() => {
                del.disabled = false;
                toast('网络异常', 'err');
              });
          };
        }
      },
    });
  }

  /* ------------------------------------------------------------ 表单构件 */

  function fieldLine(label, value) {
    return '<div class="field-line"><span>' + esc(label) + '</span><b>' + esc(value) + '</b></div>';
  }

  /** 一行输入：label 左、输入右（数值一律右对齐，与下单面板同观感） */
  function field(id, label, value, placeholder, mode) {
    return (
      '<label class="cf"><span>' + esc(label) + '</span>' +
        '<input id="' + id + '" inputmode="' + (mode || 'decimal') + '" value="' + esc(value) +
        '" placeholder="' + esc(placeholder || '') + '">' +
      '</label>'
    );
  }

  /** 股票选择：横向滚动的 chip 行（10 只以内一屏能滑完，比原生 select 更快） */
  function stocksHtml(cur) {
    const st = GS.core.S.state;
    const rows = (st && st.rules && st.rules.stocks) || [];
    if (!rows.length) return '';
    return (
      '<div class="sec-title">标的</div>' +
      '<div class="cf-stocks" id="cfStocks">' +
        rows
          .map(
            (x) =>
              '<button class="cf-stock' + (x.id === cur ? ' on' : '') + '" data-sid="' + esc(x.id) + '">' +
              esc(x.name) + '</button>'
          )
          .join('') +
      '</div>'
    );
  }

  function typesHtml(cur) {
    return (
      '<div class="cf-types" id="cfTypes">' +
        TYPES.map(
          (t) =>
            '<button class="cf-type' + (t.id === cur ? ' on' : '') + '" data-type="' + t.id + '">' +
            '<b>' + t.name + '</b><i>' + t.tip + '</i></button>'
        ).join('') +
      '</div>'
    );
  }

  /** 各类型的参数表单（默认值对齐网页端，服务端最终校验） */
  function fieldsHtml(type, stockId, position) {
    const m = GS.core.market(stockId) || {};
    const last = num(m.last);
    const lot = num(m.lotSize) || 100;
    const pos = position === 'short' ? 'short' : 'long';
    const rules = (GS.core.S.state && GS.core.S.state.rules && GS.core.S.state.rules.auto) || {};
    if (type === 'tps') {
      return (
        '<div class="sec-title">参数</div>' +
        '<div class="chip-row" id="cfPos">' +
          '<button class="chip' + (pos === 'long' ? ' on' : '') + '" data-pos="long">多头持仓</button>' +
          '<button class="chip' + (pos === 'short' ? ' on' : '') + '" data-pos="short">空头持仓</button>' +
        '</div>' +
        field('cfTp', '止盈价', '', last ? '如 ' + fmtP(last * 1.1) : '留空不启用') +
        field('cfSl', '止损价', '', last ? '如 ' + fmtP(last * 0.92) : '留空不启用') +
        field('cfQty', '数量（股）', '0', '0 = 全部可平', 'numeric')
      );
    }
    if (type === 'grid') {
      const g = rules.grid || {};
      return (
        '<div class="sec-title">参数</div>' +
        field('cfBase', '基准价', '', last ? '留空 = 现价 ' + fmtP(last) : '留空 = 现价') +
        field('cfStep', '网格间距（%）', '2', (g.minStepPct || 0.3) + ' ~ ' + (g.maxStepPct || 20)) +
        field('cfQty', '每格数量（股）', String(lot), lot + ' 的整数倍', 'numeric') +
        field('cfLevels', '最大格数', '10', '1 ~ ' + (g.maxLevels || 50), 'numeric')
      );
    }
    if (type === 'ma') {
      const c = rules.ma || {};
      return (
        '<div class="sec-title">参数</div>' +
        field('cfFast', '快线窗口（tick）', '45', (c.minFast || 10) + ' ~ ' + (c.maxFast || 300), 'numeric') +
        field('cfSlow', '慢线窗口（tick）', '150', '至少 快线 + ' + (c.minSlowGap || 10), 'numeric') +
        field('cfBudget', '每次投入（% 可用资金）', '50', '1 ~ 100')
      );
    }
    const minSec = Math.round(((rules.dcaMinIntervalMs || 5000) / 1000));
    return (
      '<div class="sec-title">参数</div>' +
      field('cfAmount', '每次金额（元）', '5000', '如 5000') +
      field('cfInterval', '间隔（秒）', '60', '最少 ' + minSec, 'numeric') +
      field('cfTimes', '总次数', '0', '0 = 不限，资金不足自动停', 'numeric')
    );
  }

  /* ------------------------------------------------------------ 新建弹层 */

  /** 表单内的当前选择（弹层生命周期内有效） */
  let cur = { type: 'tps', stockId: '', position: 'long' };

  /** 「本股已有 N 条」提示：切标的时就地更新，不用重开弹层 */
  function mineHint(stockId) {
    const n = listOf(stockId).length;
    return n ? '本股已有 ' + n + ' 条条件单，可在「交易 → 条件单」里管理' : '';
  }

  function openCreate(stockId, opt) {
    const o = opt || {};
    const sid = stockId || defaultStockId();
    cur = {
      type: o.type || 'tps',
      stockId: sid,
      // 方向：显式传入 > 持仓推断 > 多头
      position: o.position === 'short' || o.position === 'long' ? o.position : defaultPosition(sid),
    };
    const html =
      '<div class="cd-tip">下单后由服务端替你盯着盘口，触价自动报单。App 关掉也生效，休市/停牌期间冻结。</div>' +
      typesHtml(cur.type) +
      stocksHtml(cur.stockId) +
      '<div id="cfFields">' + fieldsHtml(cur.type, cur.stockId, cur.position) + '</div>' +
      '<button class="btn-primary" id="cfSubmit">创建条件单</button>' +
      // 提示常驻（空字符串也占位），换标的时能就地更新条数
      '<div class="hint" id="cfMine">' + mineHint(cur.stockId) + '</div>';

    GS.core.sheet({
      title: '新建条件单',
      html,
      onMount(ctl) {
        const body = ctl.body;

        const repaintFields = () => {
          body.querySelector('#cfFields').innerHTML = fieldsHtml(cur.type, cur.stockId, cur.position);
          // 多头/空头选择在重绘后要还原（tps 才有）
          const posBox = body.querySelector('#cfPos');
          if (posBox) {
            posBox.querySelectorAll('.chip').forEach((c) => {
              c.classList.toggle('on', c.dataset.pos === cur.position);
            });
          }
        };

        GS.core.on(body, '#cfTypes [data-type]', 'click', (e, t) => {
          if (cur.type === t.dataset.type) return;
          cur.type = t.dataset.type;
          body.querySelectorAll('#cfTypes .cf-type').forEach((b) => {
            b.classList.toggle('on', b === t);
          });
          repaintFields();
        });

        GS.core.on(body, '#cfStocks [data-sid]', 'click', (e, t) => {
          if (cur.stockId === t.dataset.sid) return;
          cur.stockId = t.dataset.sid;
          body.querySelectorAll('#cfStocks .cf-stock').forEach((b) => {
            b.classList.toggle('on', b === t);
          });
          // 换股票只影响「现价」提示，已填的参数保留——所以重绘字段后把值搬回去
          const keep = readFields(body, cur.type);
          repaintFields(body);
          writeFields(body, cur.type, keep);
          const hint = body.querySelector('#cfMine');
          if (hint) hint.textContent = mineHint(cur.stockId);
        });

        GS.core.on(body, '#cfPos .chip', 'click', (e, t) => {
          cur.position = t.dataset.pos === 'short' ? 'short' : 'long';
          body.querySelectorAll('#cfPos .chip').forEach((c) => {
            c.classList.toggle('on', c === t);
          });
        });

        const btn = body.querySelector('#cfSubmit');
        btn.onclick = () => {
          const v = collect(body, cur.type);
          if (v.error) {
            toast(v.error, 'err');
            return;
          }
          btn.disabled = true;
          btn.textContent = '创建中…';
          GS.api.api
            .auto({ op: 'create', type: cur.type, stockId: cur.stockId, params: v.params })
            .then((r) => {
              if (r && r.ok) {
                toast('条件单已创建，服务端开始盯盘', 'ok');
                GS.core.closeSheet();
                return;
              }
              btn.disabled = false;
              btn.textContent = '创建条件单';
              toast((r && r.error) || '创建失败', 'err');
            })
            .catch(() => {
              btn.disabled = false;
              btn.textContent = '创建条件单';
              toast('网络异常，条件单未创建', 'err');
            });
        };
      },
    });
  }

  /* ---------------------------------------------------------- 表单值读写 */

  const val = (body, id) => {
    const el = body.querySelector('#' + id);
    return el ? String(el.value).trim() : '';
  };

  /** 换股票重绘前把玩家已填的值抓出来 */
  function readFields(body, type) {
    if (type === 'tps') return { tp: val(body, 'cfTp'), sl: val(body, 'cfSl'), qty: val(body, 'cfQty') };
    if (type === 'grid') {
      return {
        base: val(body, 'cfBase'), step: val(body, 'cfStep'),
        qty: val(body, 'cfQty'), levels: val(body, 'cfLevels'),
      };
    }
    if (type === 'ma') {
      return { fast: val(body, 'cfFast'), slow: val(body, 'cfSlow'), budget: val(body, 'cfBudget') };
    }
    return { amount: val(body, 'cfAmount'), interval: val(body, 'cfInterval'), times: val(body, 'cfTimes') };
  }

  function writeFields(body, type, v) {
    if (!v) return;
    const set = (id, x) => {
      const el = body.querySelector('#' + id);
      if (el && x != null && x !== '') el.value = x;
    };
    if (type === 'tps') {
      set('cfTp', v.tp);
      set('cfSl', v.sl);
      set('cfQty', v.qty);
    } else if (type === 'grid') {
      set('cfBase', v.base);
      set('cfStep', v.step);
      set('cfQty', v.qty);
      set('cfLevels', v.levels);
    } else if (type === 'ma') {
      set('cfFast', v.fast);
      set('cfSlow', v.slow);
      set('cfBudget', v.budget);
    } else {
      set('cfAmount', v.amount);
      set('cfInterval', v.interval);
      set('cfTimes', v.times);
    }
  }

  /**
   * 采集 + 轻校验。返回 { params } 或 { error }。
   * 数值合法性（网格间距区间、慢线 > 快线 + gap、券商条数上限……）留给服务端，
   * 这里只拦「一定会被拒」的空表单，省一次往返。
   */
  function collect(body, type) {
    const lot = num((GS.core.market(cur.stockId) || {}).lotSize) || 100;
    if (type === 'tps') {
      const tp = val(body, 'cfTp');
      const sl = val(body, 'cfSl');
      if (!tp && !sl) return { error: '止盈和止损至少填一个' };
      if ((tp && !(num(tp) > 0)) || (sl && !(num(sl) > 0))) return { error: '止盈/止损价必须是正数' };
      const qty = val(body, 'cfQty');
      // 服务端对非法数量是按 0 处理（= 全部），填了「abc」会静默变成全平，这里直接拦
      if (qty && !/^\d+$/.test(qty)) return { error: '数量只能填整数（0 = 全部可平）' };
      return { params: { position: cur.position, tp, sl, qty } };
    }
    if (type === 'grid') {
      const qty = Math.floor(num(val(body, 'cfQty')));
      if (!(qty > 0) || qty % lot !== 0) return { error: '每格数量必须是 ' + lot + ' 股的整数倍' };
      const step = num(val(body, 'cfStep'));
      if (!(step > 0)) return { error: '网格间距必须大于 0' };
      return {
        params: { base: val(body, 'cfBase'), stepPct: step, qty, maxLevels: val(body, 'cfLevels') },
      };
    }
    if (type === 'ma') {
      const fast = Math.floor(num(val(body, 'cfFast')));
      const slow = Math.floor(num(val(body, 'cfSlow')));
      if (!(fast > 0) || !(slow > 0)) return { error: '快线/慢线窗口必须是正整数' };
      if (slow <= fast) return { error: '慢线窗口必须大于快线' };
      return { params: { fast, slow, budgetPct: val(body, 'cfBudget') } };
    }
    const amount = num(val(body, 'cfAmount'));
    if (!(amount > 0)) return { error: '每次金额必须大于 0' };
    const sec = num(val(body, 'cfInterval'));
    if (!(sec > 0)) return { error: '间隔必须大于 0 秒' };
    return { params: { amount, intervalMs: Math.round(sec * 1000), maxTimes: val(body, 'cfTimes') } };
  }

  /* ---------------------------------------------------------------- 导出 */

  GS.cond = {
    list, listOf, activeCount,
    render, bind,
    openCreate, openDetail,
    // 验收脚本用（output/verify-app-cond.mjs）：不参与运行时逻辑
    __test: {
      paramsText, tagOf, rowHtml, fieldsHtml, collect, typesHtml, stocksHtml,
      fmtWhen, mineHint, defaultStockId, defaultPosition,
    },
  };
})(window.GS);
