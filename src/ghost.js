/*
 * Ghost —— 幽灵录制与回放。
 *
 * ============================ 为什么没有改 app.js ============================
 *
 * 需求写的是"在游戏核心代码（app.js）中增加录制逻辑"。但这个项目里**没有 app.js**：
 * 那是旧版 fx-simple/ 目录的遗留源文件，V1.4 已经是手改的单文件 IIFE。
 * 游戏逻辑全部封在 (function(){...})() 里，只对外暴露 window.FX 的调试钩子。
 *
 * 更关键的是：**内部流程不经过 window.FX**。
 * 比如开仓是 openPosition() 内部直接调用，平仓是 settlePosition()，
 * 爆仓是 checkRuin() → endCycle()。包装 window.FX 上的导出函数拦不到这些调用。
 * （这一点在之前做云存档时已经踩过一次并记录在 README 里。）
 *
 * 所以录制改用**状态差分观测 + 日志流双重确认**：
 *
 *   ① 每 200ms 读一次 window.FX.state 的公开字段
 *   ② 用 positions 的 id 集合做差分：
 *        新增 id → 开仓；消失 id → 平仓
 *   ③ 用 state.logs 里新的 "平仓 ... 盈亏 +$xx" 记录补出平仓的真实盈亏
 *   ④ 时间基准用 tickCount（1 tick = 1.5 秒的确定性时间），
 *      而不是 wall clock —— 这样玩家暂停/弹窗时幽灵时间轴不会漂移
 *
 * 这样做的好处：**游戏源码一个字节都不用改**，且不会因为游戏内部重构而失效。
 *
 * ============================ 幽灵怎么"交易" ============================
 *
 * 幽灵不做实时行情模拟（那会和玩家的行情互相干扰）。它按**自己时间轴里
 * 记录下来的余额**推进：
 *   - 时间轴节点记录了那一刻的 balance / equity；
 *   - 回放时把节点之间的余额做线性插值，得到一个平滑的"幽灵资产曲线"；
 *   - 这样对比展示既忠实于录制时的真实路径，又不需要重放行情。
 * ==================================================================
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Ghost = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var POLL_MS = 200;          // 状态轮询间隔（比 tick 的 1.5 秒细得多，不会漏动作）
  var TICK_SEC = 1.5;         // 游戏 1 tick = 1.5 秒（与游戏 TICK_MS 一致）
  var MAX_TIMELINE = 3000;    // 单局最多记多少节点（防止长局撑爆 localStorage）

  /* ============================ 录制器 ============================ */

  /*
   * 创建录制器。
   * @param fx       window.FX（只读，不修改游戏）
   * @param opts     { pollMs, maxNodes }
   */
  function createRecorder(fx, opts) {
    var o = opts || {};
    var pollMs = o.pollMs || POLL_MS;
    var maxNodes = o.maxNodes || MAX_TIMELINE;

    var rec = {
      active: false,
      timeline: [],          // [{ t, act, pair, side, price, balance, equity }]
      startEquity: 10000,
      startBalance: 10000,
      startTick: 0,
      lastTick: 0,
      /* 第一个节点所在 tick：用于把时间轴归零到 t=0。
       * 录制开始后玩家可能先观察几秒才下单，那时不该把 t 记成 3、6 秒 ——
       * 幽灵回放从 0 开始才符合直觉。 */
      firstTick: null,
      /* 已知持仓：id -> { pair, side, entry, margin, notional, lev, openT } */
      known: {},
      /* 已消费的日志条数（logs 是 unshift 到头部，用 text 去重更稳） */
      seenLogs: {},
      timer: null,
      nodes: 0,
    };

    function state() {
      return fx && fx.state ? fx.state : null;
    }

    /* 秒数：用 tick 计数换算成"游戏时间"，保证暂停时不走表。
     * 为什么不用 wall clock：玩家可以暂停、可以挂着弹窗不动，
     * 那时幽灵时间轴不该继续前进，否则回放时动作全错位。
     *
     * ★ 关键：录制起点要**对齐到"记下 startTick 的那一刻"之前的 tick 数**。
     *   早先直接用 (当前tick − startTick)，但 start() 之后玩家可能先做别的、
     *   第一个动作发生时 tick 已经 +1，于是第一个节点被记成 t=1.5 而不是 t=0。
     *   这里改为以"录制开始的那一 tick"作为 t=0 的基准，
     *   并且对第一个节点做归零处理（见 pushNode 的 firstAt 逻辑）。 */
    function gameSeconds(tick) {
      var d = (tick - rec.startTick) * TICK_SEC;
      if (rec.firstTick === null) rec.firstTick = tick;
      return Math.round((d - (rec.firstTick - rec.startTick) * TICK_SEC) * 10) / 10;
    }

    function currentEquity() {
      try {
        return typeof fx.totalEquity === 'function' ? fx.totalEquity() : (state().balance || 0);
      } catch (e) {
        return state() ? (state().balance || 0) : 0;
      }
    }

    function priceOf(pair) {
      try {
        if (fx.books && fx.books[pair]) return Number(fx.books[pair].price) || 0;
      } catch (e) { /* 忽略 */ }
      return 0;
    }

    /* 记一个节点 */
    function pushNode(act, info) {
      if (rec.timeline.length >= maxNodes) return null;
      var st = state();
      if (!st) return null;
      var node = {
        t: gameSeconds(Number(st.tickCount) || 0),
        act: act,
        pair: info.pair || '',
        side: info.side || null,
        price: Math.round((info.price || 0) * 100000) / 100000,
        balance: Math.round((Number(st.balance) || 0) * 100) / 100,
        equity: Math.round(currentEquity() * 100) / 100,
      };
      rec.timeline.push(node);
      rec.nodes = rec.timeline.length;
      return node;
    }

    /* 从日志里找某个仓位的真实平仓盈亏。
     * 日志格式（游戏 addLog）：'平仓 EUR/USD 多 20x · 保证金 $500 · 盈亏 +$12.34'
     * 因为 settlePosition 会先 splice 再 addLog，ids 已消失，
     * 所以按"时间最近的未消费平仓日志"来配对。 */
    function consumeClosePnl() {
      var st = state();
      if (!st || !Array.isArray(st.logs)) return null;
      for (var i = st.logs.length - 1; i >= 0; i--) {
        var lg = st.logs[i];
        var text = lg && lg.text ? String(lg.text) : '';
        if (text.indexOf('平仓') !== 0) continue;
        var key = text + '|' + (lg.t || '');
        if (rec.seenLogs[key]) continue;
        rec.seenLogs[key] = 1;
        /* 解析 "盈亏 +$123.45" / "盈亏 -$45.6" */
        var m = text.match(/盈亏\s*([+-])\$?([\d,]+\.?\d*)/);
        if (m) {
          var v = Number(m[2].replace(/,/g, ''));
          if (isFinite(v)) return m[1] === '-' ? -v : v;
        }
        return 0;
      }
      return null;
    }

    /* 一次采样：比对持仓 id 集合，推断开仓 / 平仓 */
    function sampleOnce() {
      var st = state();
      if (!st || !rec.active) return;
      var positions = Array.isArray(st.positions) ? st.positions : [];

      var now = {};
      var i, p;
      for (i = 0; i < positions.length; i++) {
        p = positions[i];
        if (!p || p.id == null) continue;
        now[String(p.id)] = p;
      }

      /* 新增的 id → 开仓 */
      for (var id in now) {
        if (rec.known[id]) continue;
        p = now[id];
        rec.known[id] = {
          pair: p.pair, side: p.side, entry: Number(p.entry) || 0,
          margin: Number(p.margin) || 0, notional: Number(p.notional) || 0,
          lev: Number(p.lev) || 0,
        };
        /* 加仓也会让同一个 id 的 margin 变大，但 id 不变，不算新开仓。
         * 这里只在"第一次见到这个 id"时记录。 */
        pushNode('open', {
          pair: p.pair, side: p.side,
          /* 开仓价用持仓里记录的 entry（权威），不用实时价（可能有滑点） */
          price: Number(p.entry) || priceOf(p.pair),
        });
      }

      /* 消失的 id → 平仓 */
      for (var oldId in rec.known) {
        if (now[oldId]) continue;
        var info = rec.known[oldId];
        delete rec.known[oldId];
        var pnl = consumeClosePnl();
        pushNode('close', {
          pair: info.pair,
          side: info.side,
          /* 平仓价：用当前行情价（此时仓位已经不在，只能这样估） */
          price: priceOf(info.pair),
          pnl: pnl,
        });
      }
    }

    function start() {
      var st = state();
      if (!st) return false;
      rec.active = true;
      rec.timeline = [];
      rec.nodes = 0;
      rec.known = {};
      rec.seenLogs = {};
      rec.firstTick = null;
      rec.startTick = Number(st.tickCount) || 0;
      rec.startBalance = Number(st.balance) || 0;
      try {
        rec.startEquity = typeof fx.totalEquity === 'function' ? fx.totalEquity() : rec.startBalance;
      } catch (e) { rec.startEquity = rec.startBalance; }

      /* 开局就带着的持仓（从云存档恢复的）不记为"开仓动作"，
       * 但要把它们放进 known，否则第一轮采样会把它们当成新开仓。 */
      var positions = Array.isArray(st.positions) ? st.positions : [];
      for (var i = 0; i < positions.length; i++) {
        var p = positions[i];
        if (p && p.id != null) {
          rec.known[String(p.id)] = {
            pair: p.pair, side: p.side, entry: Number(p.entry) || 0,
            margin: Number(p.margin) || 0, notional: Number(p.notional) || 0,
            lev: Number(p.lev) || 0,
          };
        }
      }

      if (rec.timer) clearInterval(rec.timer);
      rec.timer = setInterval(sampleOnce, pollMs);
      return true;
    }

    function stop() {
      rec.active = false;
      if (rec.timer) { clearInterval(rec.timer); rec.timer = null; }
      return rec.timeline.slice();
    }

    /* 强制采样一次（结算前调用，确保最后一笔动作被记下） */
    function flush() {
      if (rec.active) sampleOnce();
      return rec.timeline.slice();
    }

    /* 当前统计 */
    function stats() {
      var st = state();
      var profit = 0;
      try {
        profit = currentEquity() - rec.startEquity;
      } catch (e) { profit = 0; }
      return {
        active: rec.active,
        nodes: rec.timeline.length,
        seconds: gameSeconds(Number(st && st.tickCount) || 0),
        profit: Math.round(profit * 100) / 100,
      };
    }

    return {
      start: start,
      stop: stop,
      flush: flush,
      stats: stats,
      sampleOnce: sampleOnce,
      timeline: function () { return rec.timeline.slice(); },
      startEquity: function () { return rec.startEquity; },
      isActive: function () { return rec.active; },
    };
  }

  /* ============================ 回放器 ============================ */

  /*
   * 创建回放器。
   * @param ghost    MockServer.getGhost() 的返回值
   * @param fx       window.FX（用于读玩家当前权益）
   */
  function createReplay(ghost, fx) {
    var g = ghost;
    /* 按时间排序并去重（同一秒的多个动作合成一组） */
    var nodes = (g.timeline || []).slice().sort(function (a, b) { return a.t - b.t; });
    var cursor = 0;
    var events = [];      // 本次回放已触发的事件（给 UI 用）

    /* 幽灵的"当前资产"：在节点之间做线性插值。
     * 为什么插值而不是阶梯：阶梯会让幽灵资产每秒跳一下，视觉上很突兀，
     * 而且玩家会误以为幽灵真的在实时交易。 */
    function ghostEquityAt(sec) {
      if (!nodes.length) return g.startEquity || 10000;
      var base = Number(g.startEquity) || 10000;
      /* 找到 sec 落在哪两个节点之间 */
      var prev = null, next = null;
      for (var i = 0; i < nodes.length; i++) {
        if (nodes[i].t <= sec) prev = nodes[i];
        else { next = nodes[i]; break; }
      }
      if (!prev && next) {
        /* 还没到第一个节点：从起始权益线性过渡到第一个节点 */
        var t0 = next.t || 1;
        var r0 = Math.max(0, Math.min(1, sec / t0));
        return base + (Number(next.equity) - base) * r0;
      }
      if (!prev) return base;
      if (!next) {
        /* 已经过了最后一个节点：停在最终权益（幽灵"不再操作"） */
        return Number(prev.equity) || base;
      }
      var span = next.t - prev.t;
      if (span <= 0) return Number(next.equity) || base;
      var r = Math.max(0, Math.min(1, (sec - prev.t) / span));
      return Number(prev.equity) + (Number(next.equity) - Number(prev.equity)) * r;
    }

    /* 幽灵此刻的"余额"（展示用，等同权益） */
    function ghostBalanceAt(sec) {
      return ghostEquityAt(sec);
    }

    /*
     * 推进到第 sec 秒，返回这一瞬间**刚越过**的节点（可能多个）。
     * 主循环每个 tick 调一次即可。
     */
    function advance(sec) {
      var fired = [];
      while (cursor < nodes.length && nodes[cursor].t <= sec) {
        fired.push(nodes[cursor]);
        cursor++;
      }
      if (fired.length) {
        for (var i = 0; i < fired.length; i++) {
          events.push({ t: sec, node: fired[i] });
        }
      }
      return fired;
    }

    /* 玩家 vs 幽灵 的实时对比 */
    function compare(sec) {
      var player = 0;
      try {
        player = typeof fx.totalEquity === 'function' ? fx.totalEquity() : (fx.state.balance || 0);
      } catch (e) { player = 0; }
      var gh = ghostEquityAt(sec);
      return {
        player: Math.round(player * 100) / 100,
        ghost: Math.round(gh * 100) / 100,
        diff: Math.round((player - gh) * 100) / 100,
        playerProfit: Math.round((player - (Number(g.startEquity) || 10000)) * 100) / 100,
        ghostProfit: Math.round((gh - (Number(g.startEquity) || 10000)) * 100) / 100,
      };
    }

    /* 最终判定：比收益，不比绝对值（双方开局资金可能不同） */
    function verdict() {
      var player = 0;
      try {
        player = typeof fx.totalEquity === 'function' ? fx.totalEquity() : (fx.state.balance || 0);
      } catch (e) { player = 0; }
      var base = Number(g.startEquity) || 10000;
      var playerProfit = Math.round((player - base) * 100) / 100;
      var ghostProfit = Math.round((Number(g.finalProfit) || 0) * 100) / 100;
      var win = playerProfit > ghostProfit;
      var tie = Math.abs(playerProfit - ghostProfit) < 0.01;
      return {
        win: win && !tie,
        tie: tie,
        playerProfit: playerProfit,
        ghostProfit: ghostProfit,
        diff: Math.round((playerProfit - ghostProfit) * 100) / 100,
        ghostName: g.name,
      };
    }

    /* 把节点的动作翻成人话，给 UI 飘字用 */
    function describeNode(node) {
      var who = g.name || '幽灵';
      var pair = node.pair || '某个货币对';
      var sideText = node.side === 'long' ? '多头' : (node.side === 'short' ? '空头' : '');
      if (node.act === 'open') {
        return who + ' 在此刻买入了' + (sideText || '仓位') + '（' + pair + '）';
      }
      return who + ' 在此刻平掉了' + pair + ' 的' + (sideText || '仓位');
    }

    return {
      ghost: g,
      advance: advance,
      compare: compare,
      verdict: verdict,
      describeNode: describeNode,
      ghostEquityAt: ghostEquityAt,
      ghostBalanceAt: ghostBalanceAt,
      totalNodes: nodes.length,
      cursor: function () { return cursor; },
      events: function () { return events.slice(); },
      /* 回放结束时幽灵的节点是否全部走完 */
      finished: function () { return cursor >= nodes.length; },
    };
  }

  /* ============================ URL 解析 ============================ */

  /*
   * 从 URL hash 里取幽灵 ID。
   * 支持 #ghost=xxx 与 #/ghost=xxx 两种写法（后者是为将来 hash 路由留的）。
   * @param hash 可选，默认取 location.hash
   */
  function parseGhostFromHash(hash) {
    var h = hash;
    if (h == null) {
      try { h = (typeof location !== 'undefined' && location.hash) || ''; } catch (e) { h = ''; }
    }
    h = String(h || '');
    if (!h) return null;
    if (h.charAt(0) === '#') h = h.slice(1);
    if (h.charAt(0) === '/') h = h.slice(1);
    var m = h.match(/(?:^|&)ghost=([^&]+)/);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }

  /* 生成挑战链接：#ghost=<matchId> */
  function buildGhostLink(matchId) {
    var origin = '';
    var pathname = '';
    try {
      origin = (typeof location !== 'undefined' && location.origin) || '';
      pathname = (typeof location !== 'undefined' && location.pathname) || '';
    } catch (e) { /* 忽略 */ }
    return origin + pathname + '#ghost=' + encodeURIComponent(String(matchId || ''));
  }

  return {
    createRecorder: createRecorder,
    createReplay: createReplay,
    parseGhostFromHash: parseGhostFromHash,
    buildGhostLink: buildGhostLink,
    TICK_SEC: TICK_SEC,
    POLL_MS: POLL_MS,
    MAX_TIMELINE: MAX_TIMELINE,
  };
});
