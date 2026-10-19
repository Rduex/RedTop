/*
 * ghost-bridge —— 把幽灵对战挂到游戏生命周期上。
 *
 * ============================ 这就是"修改 app.js"的等价物 ============================
 *
 * 需求让在 app.js 的 update/tick 里加录制与回放。本项目没有 app.js
 * （V1.4 是单文件 IIFE），也不适合改动游戏源码。所以这里用**独立轮询桥接**：
 *
 *   每 200ms 读一次 window.FX.state 的公开字段，做三件事：
 *     ① 检测一局开始/结束（cycle 状态机 + tickCount 回退）
 *     ② 每 tick 推进幽灵时间轴（onTick）
 *     ③ 一局结束时结算幽灵胜负（onRunEnded）
 *
 * 时间基准仍用 tickCount 而不是 wall clock —— 与 ghost.js 的录制器保持一致，
 * 这样"暂停时幽灵不动"这条语义在录制和回放两边是同一个。
 *
 * 为什么不 hook window.FX 上的函数：游戏内部流程（openPosition / settlePosition /
 * checkRuin → endCycle）都不经过 window.FX，包装导出函数拦不到真实调用。
 * 这一点在做云存档时已经验证过并记录在文档里。
 * =================================================================================
 */
(function (root) {
  'use strict';

  var POLL_MS = 200;

  function boot() {
    var d = root.document;
    if (!d) return;

    var fx = root.FX;
    if (!fx || !fx.state) {
      /* 游戏还没初始化完：稍后再试 */
      setTimeout(boot, 100);
      return;
    }

    var M = root.MockServer;
    var GA = root.Ghost;
    var GUI = root.GhostUI;

    if (!M || !GA || !GUI) {
      if (root.console && console.error) {
        console.error('[ghost] 模块缺失，幽灵功能不可用');
      }
      return;
    }

    /* 玩家名：游戏没有账号系统，这里允许多来源。
     * 优先级：localStorage 里手动设的名字 > URL ?name= > 默认 */
    var NAME_KEY = 'fx_player_name';
    function playerName() {
      try {
        var n = root.localStorage && root.localStorage.getItem(NAME_KEY);
        if (n) return String(n).slice(0, 20);
      } catch (e) { /* 忽略 */ }
      try {
        var q = (root.location && root.location.search) || '';
        var m = q.match(/[?&]name=([^&]+)/);
        if (m) {
          var v = decodeURIComponent(m[1]);
          if (v) {
            try { root.localStorage.setItem(NAME_KEY, v.slice(0, 20)); } catch (e2) { /* 忽略 */ }
            return v.slice(0, 20);
          }
        }
      } catch (e) { /* 忽略 */ }
      return '久留美';
    }

    var ui = GUI.create({
      fx: fx,
      mock: M,
      ghostApi: GA,
      getPlayerName: playerName,
    });

    ui.init();

    /* ---------- 生命周期观测 ---------- */
    var watch = {
      booted: false,
      cycle: 'play',
      tickCount: 0,
      startEquity: 0,
      cycles: 0,
      /* 上一 tick 数：用于判断"这一 tick 是新的" */
      lastTick: -1,
    };

    function snapshot() {
      var st = fx.state;
      var rr = fx.runRef ? fx.runRef() : {};
      var meta = fx.metaRef ? fx.metaRef() : {};
      return {
        cycle: st.cycle,
        tickCount: Number(st.tickCount) || 0,
        startEquity: Number(rr.startEquity) || 0,
        cycles: Number(meta.cycles) || 0,
      };
    }

    function poll() {
      var fx2 = root.FX;
      if (!fx2 || !fx2.state) return;
      var snap;
      try { snap = snapshot(); } catch (e) { return; }

      if (!watch.booted) {
        watch.booted = true;
        watch.cycle = snap.cycle;
        watch.tickCount = snap.tickCount;
        watch.startEquity = snap.startEquity;
        watch.cycles = snap.cycles;
        watch.lastTick = snap.tickCount;
        return;
      }

      /* ① 新 tick → 推进幽灵（时间基准与录制器一致：tick 差 × 1.5 秒） */
      if (snap.tickCount > watch.tickCount) {
        try { ui.onTick(); } catch (e) { /* 幽灵出错不能影响游戏 */ }
        watch.lastTick = snap.tickCount;
      }

      /* ② 一局结束：cycle 离开 play */
      if (watch.cycle === 'play' && snap.cycle !== 'play') {
        try { ui.onRunEnded(); } catch (e) { /* 同上 */ }
      }

      /* ③ 新的一局开始：开局资金变 / 局数 +1 / tick 回退 */
      var newRun = snap.cycles !== watch.cycles ||
        snap.startEquity !== watch.startEquity ||
        snap.tickCount < watch.tickCount - 4;
      if (newRun) {
        /* 换局时重新开始录制（上一局的幽灵已经生成了） */
        try { ui.beginRecording(); } catch (e) { /* 忽略 */ }
        watch.cycles = snap.cycles;
        watch.startEquity = snap.startEquity;
      }

      watch.cycle = snap.cycle;
      watch.tickCount = snap.tickCount;
    }

    setInterval(poll, POLL_MS);

    /* 暴露调试接口 */
    root.GhostBattle = {
      ui: ui,
      mock: M,
      playerName: playerName,
      /* 手动生成一个挑战链接（不用点按钮） */
      makeLink: function (cb) { ui.generateChallengeLink(cb); },
      /* 查看当前排行榜 */
      board: function () { return M.getLeaderboard(); },
      /* 自检 */
      selfCheck: function () {
        var lines = ['[幽灵对战自检]'];
        lines.push('  MockServer      : ' + (M ? '已加载 ✅' : '缺失 ❌'));
        lines.push('  Ghost           : ' + (GA ? '已加载 ✅' : '缺失 ❌'));
        lines.push('  GhostUI         : ' + (GUI ? '已加载 ✅' : '缺失 ❌'));
        lines.push('  玩家名          : ' + playerName());
        var st = ui._state;
        lines.push('  录制中          : ' + (st.recorder && st.recorder.isActive() ? '是 ✅' : '否'));
        lines.push('  已录节点        : ' + (st.recorder ? st.recorder.stats().nodes : 0));
        lines.push('  幽灵挑战        : ' + (st.challenge ? ('对战 ' + st.challenge.ghost.name) : '无'));
        lines.push('  排行榜条数      : ' + M.getLeaderboard().length);
        lines.push('  幽灵存档数      : ' + M.listGhosts().length);
        var text = lines.join('\n');
        if (root.console && console.log) console.log(text);
        return text;
      },
    };

    if (root.console && console.log) {
      console.log('[ghost] 幽灵对战已就绪 · 输入 GhostBattle.selfCheck() 查看状态');
    }
  }

  if (root.document && (root.document.readyState === 'loading')) {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
