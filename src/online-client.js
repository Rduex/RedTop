/*
 * FX 联网模块（浏览器端）—— 由 fx-online 的注入脚本追加到游戏单文件末尾。
 *
 * 设计原则：
 *   1) **绝不改动游戏原有逻辑**。本模块只做三件事：读 window.FX 的公开状态、
 *      在结算/通关时把成绩发给服务器、渲染排行榜界面。所有功能都在游戏
 *      的钩子之外实现，任何一处出错都不影响游戏本身能否玩。
 *   2) **离线优先**。服务器不可达时，游戏照常玩，成绩暂存在本地，
 *      联网后自动补交（队列最多保留 30 条，避免无限膨胀）。
 *   3) **零依赖**。不引入任何框架/CDN，纯原生 DOM + fetch。
 */
(function () {
  'use strict';

  /* ===================== 配置 ===================== */
  /* 同源部署时用相对路径即可；把前端挂到别处时改成完整 URL。 */
  var API_BASE = (function () {
    if (window.FX_ONLINE_API) return String(window.FX_ONLINE_API).replace(/\/+$/, '');
    // 由 index.html 注入的全局（例如部署在子路径 /game/ 下时）
    var injected = document.querySelector('meta[name="fx-api-base"]');
    if (injected && injected.content) return injected.content.replace(/\/+$/, '');
    return '';   // 空字符串 = 同源
  })();

  var TOKEN_KEY = 'fx-online-token-v1';
  var QUEUE_KEY = 'fx-online-queue-v1';
  var USER_KEY = 'fx-online-user-v1';
  var PREF_KEY = 'fx-online-pref-v1';
  var QUEUE_MAX = 30;

  /* ===================== 本地存储 ===================== */
  var LS = {
    get: function (k, d) {
      try {
        var v = window.localStorage.getItem(k);
        return v == null ? d : v;
      } catch (e) { return d; }
    },
    set: function (k, v) {
      try { window.localStorage.setItem(k, String(v)); } catch (e) { /* 隐私模式：退化为内存 */ }
    },
    del: function (k) {
      try { window.localStorage.removeItem(k); } catch (e) { /* 忽略 */ }
    },
    getJSON: function (k, d) {
      try {
        var v = window.localStorage.getItem(k);
        return v ? JSON.parse(v) : d;
      } catch (e) { return d; }
    },
    setJSON: function (k, v) {
      try { window.localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ }
    }
  };

  /* ===================== 网络 ===================== */
  var state = {
    token: LS.get(TOKEN_KEY, ''),
    user: LS.getJSON(USER_KEY, null),
    online: false,
    lastError: '',
    board: 'all',
    view: 'play',        // play | board（移动端用整屏切换，避免遮挡游戏）
    submitting: false,
  };

  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json' };
    if (state.token) headers['X-FX-Token'] = state.token;
    var url = API_BASE + path;
    return fetch(url, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
      /* 不依赖 cookie：跨域部署时同样可用 */
      credentials: 'omit',
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || ('请求失败（HTTP ' + res.status + '）'));
          err.code = data && data.code;
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  /* 离线队列：服务器不可达时把成绩存下来，联网后按顺序补交。
   * 这是"离线优先"的关键 —— 玩家在没网时打出的成绩不应因为网络抖动而丢失。 */  function queueLoad() { return LS.getJSON(QUEUE_KEY, []); }
  function queueSave(q) {
    var list = q.slice(-QUEUE_MAX);
    LS.setJSON(QUEUE_KEY, list);
  }
  function queuePush(payload) {
    var q = queueLoad();
    q.push(payload);
    queueSave(q);
    updateBadge();
  }
  function queueFlush() {
    var q = queueLoad();
    if (!q.length || !state.token || state.submitting) return Promise.resolve();
    state.submitting = true;
    var sent = 0;
    /* 串行补交：并发提交会让服务端的"每小时提交上限"判定失去意义，
     * 也可能在服务端造成不必要的竞争。数量本来就不多，串行足够。 */
    function step(i) {
      if (i >= q.length) return Promise.resolve();
      return api('/api/score', { method: 'POST', body: q[i] })
        .then(function () { sent++; return step(i + 1); })
        .catch(function (err) {
          /* 4xx 说明服务端明确拒绝（数据不合法/重复），这条没有重试价值 → 丢弃。
           * 5xx / 网络错误则保留，等下次再交。 */
          if (err && err.status >= 400 && err.status < 500) return step(i + 1);
          throw err;
        });
    }
    return step(0).then(function () {
      var rest = queueLoad().slice(q.length);
      queueSave(rest);
      state.submitting = false;
      updateBadge();
      if (sent) toast('已补交 ' + sent + ' 条离线成绩');
    }).catch(function (err) {
      state.submitting = false;
      state.lastError = err && err.message || '网络错误';
    });
  }

  /* ===================== 云存档（account cloud save）=====================
   *
   * 要解决的问题：游戏状态原先只活在页面内存里，一刷新就回到 $10,000。
   *
   * 策略：
   *   ① 启动时先拉 GET /api/account/state，有存档就覆盖内存里的初始值；
   *   ② 状态变化后**节流**推送（默认 3 秒一次），避免每笔成交都打一次请求；
   *   ③ 关键交易（开仓/平仓/爆仓结算）额外立即推一次，保证不因刷新丢交易；
   *   ④ beforeunload 用 sendBeacon 兜底最后一把；
   *   ⑤ 失败静默重试（指数退避），全程不打扰玩家；
   *   ⑥ 未登录 / 游客：完全不发请求，纯内存。
   *
   * ★ 关键约束：**不能改动游戏的结算逻辑**。
   *   所以这里既不劫持 openPosition，也不接管 settlePosition；
   *   而是周期读取 window.FX.state 的公开字段（balance / positions），
   *   与上次快照比对后决定要不要推送。这样即便游戏内部逻辑变化，
   *   存档模块也不会把游戏弄坏 —— 最坏情况只是少存一点。
   * ================================================================ */

  var ACCOUNT = {
    /* 推送节流间隔（毫秒）。题目要求 3 秒，这里做成可配以便测试。 */
    throttleMs: 3000,
    /* 重试退避基数与上限 */
    retryBaseMs: 2000,
    retryMaxMs: 60000,
    /* 单次推送的最小间隔（防止连续状态变化把请求打爆） */
    minGapMs: 800,
  };

  var account = {
    /* 服务端存档是否已加载过（决定"能不能覆盖本地"） */
    loaded: false,
    /* 服务端是否有真实存档（lastSyncAt > 0） */
    hasSave: false,
    /* 最近一次成功同步的时间（服务端值） */
    lastSyncAt: 0,
    /* 上次推送的内容指纹，用于"没变化就不发请求" */
    lastSentKey: '',
    /* 定时器/状态 */
    timer: null,
    retryTimer: null,
    retryDelay: ACCOUNT.retryBaseMs,
    inFlight: false,
    /* 待推送标记：inFlight 期间又有变化时置位，完成后补发 */
    pending: false,
    failed: 0,
    blocked: false,      // 409 stale 之类：不再用当前值覆盖服务端
  };

  /* 读取游戏当前的真实状态。全部走 window.FX 的公开字段，不碰内部变量。 */
  function readGameState() {
    var fx = FX();
    if (!fx || !fx.state) return null;
    var st = fx.state;
    var bal = Number(st.balance);
    if (!isFinite(bal)) bal = 0;
    var pos = [];
    if (Array.isArray(st.positions)) {
      pos = st.positions.map(function (p) {
        return {
          id: Number(p.id) || 0,
          pair: String(p.pair || ''),
          side: p.side === 'short' ? 'short' : 'long',
          margin: Math.round((Number(p.margin) || 0) * 100) / 100,
          lev: Number(p.lev) || 0,
          notional: Math.round((Number(p.notional) || 0) * 100) / 100,
          entry: Number(p.entry) || 0,
          fee: Math.round((Number(p.fee) || 0) * 100) / 100,
          openTs: Number(p.openTs) || 0,
          openTick: Number(p.openTick) || 0,
        };
      });
    }
    /* ★ balance 用 state.balance（现金），不含浮动盈亏与保证金占用。
     *   为什么不用 totalEquity：totalEquity 会随行情每秒变化，
     *   拿它做同步会让"内容没变也要一直推"。state.balance 只在
     *   开仓/平仓/手续费时变化，是真正需要持久化的量。 */
    return { balance: Math.round(bal * 100) / 100, positions: pos };
  }

  /* 内容指纹：只有真正变了才发请求。
   * 注意 positions 的顺序也要计入 —— 顺序变化虽不影响语义，但罕见且无害。 */
  function stateKey(s) {
    if (!s) return '';
    return s.balance + '|' + s.positions.map(function (p) {
      return p.id + ',' + p.pair + ',' + p.side + ',' + p.margin + ',' + p.lev + ',' + p.entry;
    }).join(';');
  }

  /* 把服务端的存档写回游戏。
   * ★ 这是唯一"改游戏数据"的地方，所以必须极其保守：
   *   - 只在首次加载时调用（避免覆盖玩家正在进行的操作）；
   *   - 只在服务端确实有存档（hasSave）时调用；
   *   - 同时恢复 balance / positions / locked / seq 四个相关字段，
   *     否则游戏会认为"没持仓却扣着保证金"，账户直接算错。 */
  function applySaveToGame(save) {
    var fx = FX();
    if (!fx || !fx.state) return false;
    var st = fx.state;

    var bal = Number(save.balance);
    if (!isFinite(bal)) bal = 10000;
    st.balance = bal;

    var pos = Array.isArray(save.positions) ? save.positions : [];
    st.positions = pos.map(function (p) {
      return {
        id: Number(p.id) || 0,
        pair: String(p.pair || 'EUR/USD'),
        side: p.side === 'short' ? 'short' : 'long',
        margin: Number(p.margin) || 0,
        lev: Number(p.lev) || 1,
        notional: Number(p.notional) || 0,
        entry: Number(p.entry) || 0,
        fee: Number(p.fee) || 0,
        openTs: Number(p.openTs) || Date.now(),
        openTick: Number(p.openTick) || 0,
      };
    });

    /* ★ locked（占用保证金）必须由持仓重新算出来。
     *   游戏里 locked 是独立字段，恢复持仓却不恢复 locked，
     *   就会出现"可用余额虚高 + 权益重复计算"的账目错乱。 */
    var locked = 0;
    st.positions.forEach(function (p) { locked += Number(p.margin) || 0; });
    st.locked = Math.round(locked * 100) / 100;

    /* 仓位 id 的自增游标要推到已用最大值之后，否则新开仓会和恢复的仓位撞 id
     * （撞 id 会让平仓平错对象，是很隐蔽的 bug）。 */
    var maxId = 0;
    st.positions.forEach(function (p) { if (p.id > maxId) maxId = p.id; });
    if (Number(st.seq) < maxId) st.seq = maxId;

    /* 重绘：让界面上立刻显示恢复出来的资金与持仓。
     * renderAll 不会改账，只重画 DOM，所以调用它是安全的。 */
    try {
      if (typeof fx.renderAll === 'function') fx.renderAll();
    } catch (e) { warn(e); }
    return true;
  }

  /* 拉取服务端存档（启动时调用一次） */
  function loadAccountState() {
    if (!state.token) return Promise.resolve(null);   // 游客：不请求
    return api('/api/account/state')
      .then(function (d) {
        account.loaded = true;
        account.hasSave = !!d.hasSave;
        account.lastSyncAt = Number(d.lastSyncAt) || 0;
        if (d.hasSave) {
          applySaveToGame(d);
          /* 记下服务端的指纹，避免刚恢复完就立刻又推一次一模一样的值 */
          account.lastSentKey = stateKey(readGameState());
          toast('☁ 已载入云端存档：$' + Math.round(Number(d.balance) || 0) +
            (d.positions && d.positions.length ? ' · ' + d.positions.length + ' 个持仓' : ''));
        }
        setOnline(true);
        return d;
      })
      .catch(function (e) {
        account.loaded = true;
        if (e && e.status === 401) {
          /* token 失效：退化成游客，本地照玩 */
          state.token = ''; state.user = null;
          LS.del(TOKEN_KEY); LS.del(USER_KEY);
        } else {
          /* 网络问题：本轮先用内存状态，稍后由周期同步自动补上 */
          warn(e);
        }
        setOnline(false);
        return null;
      });
  }

  /* 真正发推送 */
  function pushAccount(reason) {
    if (!state.token || !account.loaded) return Promise.resolve();
    if (account.blocked) return Promise.resolve();       // 已被判定为"过旧"，停止覆盖
    var s = readGameState();
    if (!s) return Promise.resolve();
    var key = stateKey(s);
    if (key === account.lastSentKey && !account.pending) return Promise.resolve();

    account.inFlight = true;
    account.pending = false;
    var payload = {
      balance: s.balance,
      positions: s.positions,
      /* 用 wall clock 做单调性标记：服务端拒绝比存档更旧的提交，
       * 避免 beforeunload 的慢请求把之后的正常同步覆盖掉。 */
      clientTs: Date.now(),
    };
    return api('/api/account/sync', { method: 'POST', body: payload })
      .then(function (d) {
        account.inFlight = false;
        account.lastSentKey = key;
        account.lastSyncAt = Number(d.lastSyncAt) || account.lastSyncAt;
        account.hasSave = true;
        account.retryDelay = ACCOUNT.retryBaseMs;
        account.failed = 0;
        setOnline(true);
        renderHud();
        /* 期间又有变化 → 补发一次，保证最终一致 */
        if (account.pending) { account.pending = false; schedulePush(0); }
      })
      .catch(function (e) {
        account.inFlight = false;
        account.failed++;
        if (e && e.status === 409) {
          /* 服务端有更新的存档：不再用本地覆盖，避免把别的标签页的进度冲掉 */
          account.blocked = true;
          warn('云端存档比本地更新，已停止覆盖（可刷新页面载入最新存档）');
          return;
        }
        if (e && e.status === 401) {
          state.token = ''; state.user = null;
          LS.del(TOKEN_KEY); LS.del(USER_KEY);
          return;
        }
        /* 网络/5xx：静默重试，指数退避，不打扰玩家 */
        setOnline(false);
        account.retryDelay = Math.min(ACCOUNT.retryMaxMs, account.retryDelay * 2);
        scheduleRetry();
      });
  }

  function scheduleRetry() {
    if (account.retryTimer) return;
    account.retryTimer = setTimeout(function () {
      account.retryTimer = null;
      /* 重试时强制推送：内容指纹可能没变，但服务端还没收到 */
      account.lastSentKey = '';
      pushAccount('retry');
    }, account.retryDelay);
  }

  /* 节流调度：3 秒内多次状态变化只推最后一次 */
  function schedulePush(delayMs) {
    if (!state.token || !account.loaded || account.blocked) return;
    if (account.timer) return;
    var d = delayMs === undefined ? ACCOUNT.throttleMs : delayMs;
    account.timer = setTimeout(function () {
      account.timer = null;
      if (account.inFlight) { account.pending = true; return; }
      pushAccount('throttle');
    }, d);
  }

  /* 检测状态变化：由 1 秒的 observe 循环调用。
   * 这是"自动存档"的驱动源 —— 不依赖游戏的任何回调。 */
  var lastObservedKey = '';
  function watchAccount() {
    if (!state.token || !account.loaded) { lastObservedKey = ''; return; }
    var s = readGameState();
    if (!s) return;
    var key = stateKey(s);
    if (key === lastObservedKey) return;
    lastObservedKey = key;
    /* 空仓位且余额没变时不推（刚开局），避免无意义的写盘 */
    schedulePush();
  }

  /* 关键交易完成后立即同步（不等节流）。
   * 通过对比"上一秒是否有仓位数量变化"来识别，避免真的去 hook 游戏函数。 */
  function watchCriticalTrades() {
    if (!state.token || !account.loaded) return;
    var fx = FX();
    if (!fx || !fx.state) return;
    var n = Array.isArray(fx.state.positions) ? fx.state.positions.length : 0;
    if (n !== lastPosCount) {
      lastPosCount = n;
      /* 开仓/平仓/爆仓结算都属于这一类：立刻推一次 */
      schedulePush(0);
    }
  }
  var lastPosCount = -1;

  /* 退出兜底：sendBeacon 是唯一在页面卸载时仍可能送达的方式。
   * 注意 sendBeacon 不能自定义 header，所以 token 必须放在 query 里，
   * 服务端为此额外支持 ?token= 读取。 */
  function beaconFinalState() {
    if (!state.token || !account.loaded || account.blocked) return;
    var s = readGameState();
    if (!s) return;
    var key = stateKey(s);
    if (key === account.lastSentKey) return;      // 没变化就不用发

    var url = API_BASE + '/api/account/sync?token=' + encodeURIComponent(state.token);
    var body = JSON.stringify({
      balance: s.balance,
      positions: s.positions,
      clientTs: Date.now(),
    });
    try {
      if (navigator.sendBeacon) {
        var ok = navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }));
        if (ok) return;
      }
    } catch (e) { warn(e); }
    /* 兜底：sendBeacon 不可用就尝试同步 XHR（keepalive 语义） */
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, false);   // 同步请求，仅用于卸载路径
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(body);
    } catch (e) { warn(e); }
  }

  /* ===================== 成绩采集 ===================== */

  /* 一局的运行期上下文：每次新开一局重置。
   * 这些数字全部从 window.FX 的公开状态读，不侵入游戏内部。 */
  var session = null;

  function FX() { return window.FX; }

  function warn(e) {
    if (window.console && console.warn) console.warn('[fx-online] 已忽略的错误：', e);
  }

  function nowMs() {
    return (window.performance && window.performance.now)
      ? window.performance.now() : Date.now();
  }

  function startSession(reason) {
    var fx = FX();
    if (!fx) return;
    var st = fx.state;
    var run = fx.runRef ? fx.runRef() : {};
    var meta = fx.metaRef ? fx.metaRef() : {};
    session = {
      runId: 'r-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10),
      startAt: Date.now(),
      startPerf: nowMs(),
      startEquity: Number(run.startEquity) || Number(st.balance) || 0,
      startTick: Number(st.tickCount) || 0,
      startTrades: (Number(meta.trades) || 0),
      startCycles: Number(meta.cycles) || 0,
      peak: Number(run.startEquity) || 0,
      reason: reason || 'settle',
      peakAt: Date.now(),
      /* ★ won 必须按"本局"记，不能用游戏里的 state.won：
       *   那个标记在第一次通关后就永久为 true（重置游戏也不会清），
       *   直接拿它当本局结果，会让之后每一局都谎报"通关"，
       *   而服务端会因为"没达标却声称通关"把成绩整条拒掉。
       *   所以真值来源只有一处：观测到 state.won 由假变真的那个瞬间。 */
      won: false,
      wonReported: false,
      reported: false,
      settledReported: false,
      ticks: 0
    };
    /* 起始帧就把峰值锚在"开局总权益"上：带家当开局的玩家，其家当本来就值钱，
     * 不能让排行榜把家当市值当成"这一局赚的"。 */
    try {
      var total = fx.totalEquity ? fx.totalEquity() : null;
      if (typeof total === 'number' && isFinite(total)) session.peak = total;
    } catch (e) { /* 忽略 */ }
    fx.state.__fxRunId = session.runId;
    renderHud();
  }

  /* 采样：由下面的轮询定时器每 2 秒调一次。
   * 为什么不改写游戏的 tick()？—— 那需要动到游戏源码，而本模块的承诺是"不改逻辑"。
   * 轮询 2 秒的精度完全够用：排行榜排的是"本局峰值身家"，
   * 峰值本身是个缓慢累积的量，采样偏差可以忽略。 */
  function sample() {
    var fx = FX();
    if (!fx || !session) return;
    try {
      var total = fx.totalEquity ? fx.totalEquity() : null;
      if (typeof total === 'number' && isFinite(total) && total > session.peak) {
        session.peak = total;
        session.peakAt = Date.now();
      }
      /* 本局已经推进了多少 tick：用于"这局够不够长、值不值得上报" */
      var tc = Number(fx.state.tickCount) || 0;
      var t = Math.max(0, tc - session.startTick);
      if (t > session.ticks) session.ticks = t;
    } catch (e) { /* 忽略 */ }
    renderHud();
  }

  /* 计算"本局推进了多少 tick"。
   * ★ 不要只依赖 sample() 累计出来的值：采样是 2 秒一次的定时任务，
   *   如果玩家在两次采样之间就触发了结算，累计值还是 0，
   *   上报出去的 tickCount 就会是 0 —— 服务端会判定"tick 数与用时对不上"
   *   或者"这一局太短"，真实成绩被整条拒掉。
   *   所以这里始终用「当前 tickCount − 开局 tickCount」现算，
   *   再与采样累计值取 max（应对换局边界上的取整误差）。 */
  function ticksOf(s) {
    var fx = FX();
    var tc = 0;
    try { tc = Number(fx.state.tickCount) || 0; } catch (e) { tc = 0; }
    var byNow = Math.max(0, tc - s.startTick);
    return Math.max(byNow, Math.max(0, Number(s.ticks) || 0));
  }

  /* 把一局打成一个上报体。
   * session 显式传入（而不是读全局 session）：因为在"观测到换局 → 补报上一局"
   * 的路径上，全局 session 已经被换成新局的了，此时必须用摘下来的旧 session。 */
  function buildPayloadFrom(s, reason) {
    var fx = FX();
    var st = fx.state;
    var meta = fx.metaRef ? fx.metaRef() : {};
    var run = fx.runRef ? fx.runRef() : {};
    var durationMs = Math.max(0, Math.round(nowMs() - s.startPerf));
    var ticks = ticksOf(s);
    var TPC = 4;   // TICKS_PER_CANDLE，游戏常量
    try {
      var c = fx.constants && fx.constants.TICKS_PER_CANDLE;
      if (c) TPC = Number(c);
    } catch (e) { /* 用默认值 */ }

    /* 真实持有的家当件数：meta.assets 是 { 资产id: 数量 } 的映射，
     * 只数数量 > 0 的条目（不是资产种类总数 33）。 */
    var owned = 0;
    try {
      if (meta && meta.assets) {
        for (var k in meta.assets) {
          if (Object.prototype.hasOwnProperty.call(meta.assets, k) && Number(meta.assets[k]) > 0) owned++;
        }
      }
    } catch (e) { owned = 0; }

    var equityNow = 0;
    try { equityNow = Number(fx.equity ? fx.equity() : st.balance) || 0; } catch (e) { equityNow = 0; }

    return {
      runId: s.runId,
      score: Math.round(s.peak * 100) / 100,
      equity: Math.round(equityNow * 100) / 100,
      startEquity: Math.round(s.startEquity * 100) / 100,
      target: (fx.constants && fx.constants.FREEDOM_GOAL) || 20000000,
      won: !!s.won,
      tickCount: ticks,
      candles: Math.floor(ticks / TPC),
      trades: 0,
      cards: (run.cards && run.cards.length) || 0,
      assets: owned,
      cycles: Number(meta.cycles) || 0,
      durationMs: durationMs,
      reason: reason || s.reason,
      mode: String(st.mode || 'sim')
    };
  }

  /* 上报当前这一局（**不结束 session**）。
   *
   * 为什么不清空 session：爆仓结算时游戏会问玩家「变现家当继续打 / 就此收手」。
   * 如果一爆仓就把这一局封存，那么选择"继续打"之后赚到的更高峰值就变成了
   * 另一个 runId 的独立成绩 —— 同一个人的同一局被排行榜拆成两条。
   * 服务端按 runId 做 upsert，所以这里只要保持 session 不变、重复上报即可，
   * 峰值会自然累积到这一局的最高点。 */
  function flushCurrent(reason, isWin) {
    if (!session) return Promise.resolve({ skipped: true });
    sample();                          // 上报前先把此刻的峰值采进来
    session.reason = reason || session.reason;
    return submitSession(session, reason, isWin);
  }

  /* 结束当前 session 并开启新的一局上下文。
   * reason 为 'settle' 表示"上一局已经报过了，这里只是换局"，
   * 此时若上一局还没报过（例如玩家直接点了重新开始），补报一次。 */
  function endSession(reason, isWin) {
    var s = session;
    session = null;
    startSession('settle');
    if (!s) return Promise.resolve({ skipped: true });
    if (s.reported) return Promise.resolve({ already: true });
    return submitSession(s, reason || 'settle', isWin);
  }

  /* 上报指定的 session，返回 Promise。 */
  function submitSession(s, reason, isWin) {
    var payload = buildPayloadFrom(s, reason);
    /* 太短的局不上报：与服务端的 MIN_TICKS 同口径。
     * 提前在前端拦掉，免得玩家看到一条无意义的"被拒绝"提示。 */
    if (payload.tickCount < 8) {
      return Promise.resolve({ skipped: true, reason: 'too_short' });
    }
    s.reported = true;
    if (!state.token) {
      /* 没登录也要留住成绩：本地暂存，等玩家登录后一起补交 */
      queuePush(payload);
      toast('成绩已暂存到本地，注册/登录后会自动上榜');
      return Promise.resolve({ queued: true });
    }
    return api('/api/score', { method: 'POST', body: payload })
      .then(function (data) {
        if (data && data.rank) {
          toast((isWin ? '🏆 已上榜：第 ' + data.rank + ' 名（共 ' + data.total + ' 人）'
            : '📈 本局已上榜：第 ' + data.rank + ' 名（共 ' + data.total + ' 人）'));
        }
        refreshBoardSoon();
        return data;
      })
      .catch(function (err) {
        if (err && err.status >= 400 && err.status < 500) {
          /* runId upsert 时"重复"不是错误，服务端会返回最新名次；真被拒就提示 */
          toast('成绩未能上榜：' + err.message, 'err');
          return { error: err.message };
        }
        queuePush(payload);
        toast('网络不通，成绩已暂存，联网后自动补交');
        return { queued: true };
      });
  }

  /* ===================== 钩子与生命周期观测 =====================
   *
   * ★ 这里有一个必须交代清楚的技术约束：
   *
   * 游戏的全部逻辑都在一个 IIFE 闭包里。它对外只暴露 window.FX 上的调试钩子，
   * 而**内部流程调用的是闭包内的原始函数** —— 比如爆仓是 checkRuin() 直接调
   * endCycle('ruin')（见游戏源码），根本不经过 window.FX.endCycle。
   * 因此"包装 window.FX 上的导出函数"只能拦到外部/测试调用，
   * 拦不到玩家实际玩游戏时触发的结算，这条思路是行不通的。
   *
   * 可行的两条路：
   *   ① 改游戏源码，在结算/通关处派发自定义事件（最干净，但侵入游戏）；
   *   ② 不加任何钩子，改为**周期观测 window.FX.state 的状态机**（当前采用）。
   *
   * 这里选 ②：本模块承诺"不改游戏逻辑"，那就必须靠公开状态推断生命周期。
   * 相关状态全部是 window.FX.state 上的公开字段：
   *   state.cycle      play | choosing（爆仓抉择中）| settled（等待结算）
   *   state.tickCount  单调递增的行情推进计数（换局会重置为 0 或变小）
   *   run.startEquity  本局开局资金（换局会变）
   *   meta.cycles      已完成局数（换局 +1）
   *
   * 判定规则：
   *   · cycle 从 'play' 变成非 'play'  → 这一局结束了，立即上报
   *   · run.startEquity / tickCount 回退 / meta.cycles 增加 → 新的一局开始了
   *   · state.won 由假变真 → 通关，补报一次（峰值更高）
   *
   * 观测频率 1 秒：结算状态会一直保持到玩家点按钮，
   * 所以 1 秒的延迟绝不会漏掉任何一次结算。
   * ================================================================ */

  /* 观测到的上一帧快照 */
  var watch = {
    cycle: null,
    startEquity: null,
    cycles: null,
    tickCount: 0,
    won: false,
    booted: false
  };

  function snapshot() {
    var fx = FX();
    var st = fx.state;
    var run = fx.runRef ? fx.runRef() : {};
    var meta = fx.metaRef ? fx.metaRef() : {};
    return {
      cycle: st.cycle,
      startEquity: Number(run.startEquity) || 0,
      cycles: Number(meta.cycles) || 0,
      tickCount: Number(st.tickCount) || 0,
      won: !!st.won
    };
  }

  /* 一局的结束（cycle 离开 'play'）：立刻把成绩报一次。
   *
   * ★ 这里**不结束 session**。爆仓后游戏会问玩家「变现家当继续打 / 就此收手」，
   *   选"继续打"时 cycle 会变回 'play'，这一局还在继续，峰值还会更高。
   *   服务端按 runId 做 upsert，所以先报一次、之后刷新峰值再报一次，
   *   排行榜上始终只有这一局的一条记录，且取最高值。 */
  function onCycleLeftPlay(reason) {
    if (!session || session.settledReported) return;
    session.settledReported = true;
    return flushCurrent(reason || 'settle', false);
  }

  function observe() {
    var fx = FX();
    if (!fx) return;
    var snap;
    try { snap = snapshot(); } catch (e) { warn(e); return; }

    if (!watch.booted) {
      watch = {
        cycle: snap.cycle, startEquity: snap.startEquity, cycles: snap.cycles,
        tickCount: snap.tickCount, won: snap.won, booted: true
      };
      if (!session) startSession('settle');
      return;
    }

    /* ① 通关：won 由假变真。这是本局的高光时刻，立刻补报（峰值通常最高） */
    if (snap.won && !watch.won && session && !session.wonReported) {
      session.won = true;
      session.wonReported = true;
      session.reason = 'retire';
      sample();
      flushCurrent('retire', true);
      refreshBoardSoon();
    }

    /* ② 一局结束：cycle 从 'play' 变成 'choosing'/'settled'。
     *    游戏会把这个状态一直保留到玩家做出选择，所以不会错过。 */
    if (watch.cycle === 'play' && snap.cycle !== 'play') {
      onCycleLeftPlay('settle');
    }

    /* ③ 新的一局真正开始（开新局）：开局资金变化、局数 +1，或 tickCount 回退。
     *    走到这里说明上一局确实结束了，此时才封存 session 并开新的。
     *    注意"变现家当继续打"不会触发这三个信号（run 没换、cycles 没加），
     *    所以它会正确地留在同一个 session 里。 */
    var newRun = snap.cycles !== watch.cycles ||
      snap.startEquity !== watch.startEquity ||
      snap.tickCount < watch.tickCount - 4;   // 留余量：同一局内 tick 只会增长
    if (newRun) {
      /* 上一局若还没报过（例如玩家直接点了「重新开始」，或爆仓后立刻重开），
       * 在这里补报一次，避免成绩丢失。 */
      endSession('restart', false);
      watch.won = snap.won;   // 新局的 won 基准
    }

    watch.cycle = snap.cycle;
    watch.startEquity = snap.startEquity;
    watch.cycles = snap.cycles;
    watch.tickCount = snap.tickCount;
    watch.won = snap.won;
  }

  /* ===================== 界面 ===================== */

  var dom = {};

  var CSS = [
    '.fxo-root{position:fixed;inset:0;z-index:99998;display:none;background:rgba(15,20,26,.55);',
    'backdrop-filter:blur(3px);-webkit-backdrop-filter:blur(3px);}',
    '.fxo-root.on{display:block;}',
    '.fxo-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    'width:min(680px,94vw);max-height:88vh;overflow:auto;background:#fff;border-radius:16px;',
    'box-shadow:0 24px 64px rgba(0,0,0,.28);font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;',
    'color:#1b2028;}',
    '.fxo-head{display:flex;align-items:center;justify-content:space-between;gap:10px;',
    'padding:16px 18px 12px;border-bottom:1px solid #e6eaee;position:sticky;top:0;background:#fff;border-radius:16px 16px 0 0;z-index:2;}',
    '.fxo-head h2{margin:0;font-size:18px;}',
    '.fxo-x{border:1px solid #e6eaee;background:#fff;color:#5b6472;border-radius:999px;',
    'width:32px;height:32px;cursor:pointer;font-size:15px;line-height:1;flex:none;}',
    '.fxo-x:hover{background:#fafbfc;color:#1b2028;}',
    '.fxo-body{padding:14px 18px 20px;}',
    '.fxo-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;}',
    '.fxo-tab{border:1px solid #e6eaee;background:#fff;color:#5b6472;border-radius:999px;',
    'padding:6px 12px;font-size:12.5px;cursor:pointer;white-space:nowrap;}',
    '.fxo-tab.on{background:#4aa877;border-color:#4aa877;color:#fff;font-weight:600;}',
    '.fxo-tab:hover{border-color:#cfd8e0;}',
    '.fxo-row{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px;',
    'font-size:13.5px;border:1px solid transparent;}',
    '.fxo-row:nth-child(odd){background:#f7f9fb;}',
    '.fxo-row.me{background:#e7f4ec;border-color:#bfe3cd;}',
    '.fxo-rank{width:38px;flex:none;text-align:center;font-weight:700;color:#93a0ad;font-size:13px;}',
    '.fxo-row.top1 .fxo-rank{color:#d4a017;}',
    '.fxo-row.top2 .fxo-rank{color:#8e9ba8;}',
    '.fxo-row.top3 .fxo-rank{color:#b0713a;}',
    '.fxo-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}',
    '.fxo-win{font-size:11px;color:#d4a017;border:1px solid #f0e0b0;background:#fdf8e8;',
    'border-radius:999px;padding:1px 6px;flex:none;}',
    '.fxo-score{font-variant-numeric:tabular-nums;font-weight:700;color:#3d8f66;flex:none;}',
    '.fxo-sub{font-size:11.5px;color:#93a0ad;flex:none;}',
    '.fxo-empty{text-align:center;color:#93a0ad;padding:28px 10px;font-size:13px;}',
    '.fxo-form{display:flex;flex-direction:column;gap:10px;max-width:340px;margin:8px auto 0;}',
    '.fxo-input{border:1px solid #e6eaee;border-radius:10px;padding:10px 12px;font-size:14px;',
    'font-family:inherit;outline:none;background:#fff;color:#1b2028;}',
    '.fxo-input:focus{border-color:#4aa877;}',
    '.fxo-btn{border:0;border-radius:10px;padding:11px 14px;font-size:14px;font-weight:600;',
    'cursor:pointer;background:#4aa877;color:#fff;}',
    '.fxo-btn:hover{background:#3d8f66;}',
    '.fxo-btn.ghost{background:#fff;color:#5b6472;border:1px solid #e6eaee;}',
    '.fxo-btn.ghost:hover{background:#fafbfc;color:#1b2028;}',
    '.fxo-btn:disabled{opacity:.55;cursor:not-allowed;}',
    '.fxo-note{font-size:12px;color:#93a0ad;line-height:1.6;margin-top:10px;}',
    '.fxo-err{color:#d1685f;font-size:12.5px;min-height:17px;text-align:center;}',
    '.fxo-ok{color:#3d8f66;font-size:12.5px;min-height:17px;text-align:center;}',
    '.fxo-me{background:#f7f9fb;border:1px solid #e6eaee;border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:13px;}',
    '.fxo-me b{color:#1b2028;}',
    '.fxo-stat{display:flex;gap:14px;flex-wrap:wrap;margin-top:6px;color:#5b6472;font-size:12.5px;}',
    '.fxo-stat b{color:#3d8f66;}',
    /* 顶栏入口按钮 + 好友榜角标 */
    '.fxo-chip{border:1px solid #e6eaee;background:#fff;color:#5b6472;font-size:12px;',
    'padding:6px 10px;border-radius:999px;cursor:pointer;white-space:nowrap;font-family:inherit;transition:.15s;}',
    '.fxo-chip:hover{border-color:#cfd8e0;color:#1b2028;background:#fafbfc;}',
    '.fxo-chip .dot{display:inline-block;width:7px;height:7px;border-radius:50%;',
    'background:#dd6f68;margin-left:5px;vertical-align:middle;}',
    '.fxo-toast{position:fixed;left:50%;transform:translateX(-50%);bottom:84px;z-index:99999;',
    'background:rgba(27,32,40,.94);color:#fff;font-size:13px;padding:10px 16px;border-radius:999px;',
    'max-width:88vw;text-align:center;pointer-events:none;opacity:0;transition:opacity .25s;',
    'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '.fxo-toast.on{opacity:1;}',
    /* 手机端：整屏面板，避免和游戏操作抢手指 */
    '@media (max-width:560px){',
    '.fxo-panel{width:100vw;max-width:100vw;height:100%;max-height:100%;border-radius:0;',
    'top:0;left:0;transform:none;}',
    '.fxo-head{border-radius:0;}',
    '.fxo-score{font-size:13.5px;}',
    '}'
  ].join('');

  function injectCss() {
    if (document.getElementById('fxo-style')) return;
    var s = document.createElement('style');
    s.id = 'fxo-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  var toastTimer = null;
  function toast(msg, kind) {
    var t = dom.toast;
    if (!t) return;
    t.textContent = msg;
    t.style.background = kind === 'err' ? 'rgba(200,95,89,.95)' : 'rgba(27,32,40,.94)';
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('on'); }, 3200);
  }

  function money(n) {
    var v = Number(n) || 0;
    var a = Math.abs(v);
    if (a >= 1e8) return '$' + (v / 1e8).toFixed(2) + ' 亿';
    if (a >= 1e4) return '$' + (v / 1e4).toFixed(a >= 1e6 ? 0 : 1) + ' 万';
    return '$' + Math.round(v).toLocaleString('en-US');
  }

  function durationText(ms) {
    var s = Math.round((Number(ms) || 0) / 1000);
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  }

  /* 顶栏入口：插到游戏顶栏右侧，与原有按钮同一视觉体系 */
  function mountChip() {
    var bar = document.querySelector('.topbar-actions');
    if (!bar || document.getElementById('fxoChip')) return;
    var chip = el('button', 'fxo-chip');
    chip.id = 'fxoChip';
    chip.type = 'button';
    chip.addEventListener('click', function () { open(state.user ? 'board' : 'auth'); });
    /* 放在最前面：排行榜是联网版的主入口，不该被埋在角落 */
    bar.insertBefore(chip, bar.firstChild);
    updateChip();
  }

  /* 顶部入口按钮：同时承担"我在第几"和"有几条待补交"两个状态。
   * 统一在这里重写 innerHTML，避免多个函数各自 appendChild 导致圆点越加越多。 */
  function updateChip() {
    var chip = document.getElementById('fxoChip');
    if (!chip) return;
    var cur = boardData && boardData.me;
    var label;
    if (!state.user) {
      /* 游客：必须让玩家一眼看出"现在不存档"。
       * 否则刷新后回到 $10,000 会被当成 bug —— 实际上是没登录。 */
      label = '☁ 未登录 · 不存档';
    } else if (cur) {
      label = '🌐 第 ' + cur.rank + ' 名';
    } else {
      label = '🌐 排行榜';
    }
    var q = queueLoad().length;
    chip.innerHTML = '';
    chip.appendChild(document.createTextNode(label));
    if (q) {
      var dot = el('span', 'dot');
      dot.title = q + ' 条成绩待补交';
      chip.appendChild(dot);
    }
    chip.title = state.user
      ? (q ? q + ' 条成绩待补交（联网后自动上榜）'
           : (account.hasSave ? '云端存档已启用' : '登录后自动云端存档'))
      : '未登录：资金只存在本页内存中，刷新会回到 $10,000。点这里登录/注册。';
    chip.style.opacity = state.online ? '1' : '.72';
  }

  function updateBadge() { updateChip(); }
  function renderHud() { updateChip(); }

  /* 构建弹窗骨架（只建一次） */
  function buildModal() {
    if (dom.root) return;
    var root = el('div', 'fxo-root');
    root.id = 'fxoRoot';
    var panel = el('div', 'fxo-panel');
    var head = el('div', 'fxo-head');
    var h2 = el('h2', null, '排行榜');
    h2.id = 'fxoTitle';
    var x = el('button', 'fxo-x', '✕');
    x.type = 'button';
    x.addEventListener('click', close);
    head.appendChild(h2); head.appendChild(x);
    var body = el('div', 'fxo-body');
    body.id = 'fxoBody';
    panel.appendChild(head); panel.appendChild(body);
    root.appendChild(panel);
    root.addEventListener('click', function (e) { if (e.target === root) close(); });
    document.body.appendChild(root);

    var t = el('div', 'fxo-toast');
    document.body.appendChild(t);

    dom.root = root; dom.title = h2; dom.body = body; dom.toast = t;
  }

  function open(view) {
    buildModal();
    state.view = view || (state.user ? 'board' : 'auth');
    dom.root.classList.add('on');
    renderView();
    maybeLoadProfile();
  }

  function close() {
    if (dom.root) dom.root.classList.remove('on');
  }

  /* ===================== 视图渲染 ===================== */

  function renderView() {
    if (!dom.root) return;
    var v = state.view;
    if (v === 'auth') return renderAuth();
    if (v === 'me') return renderMe();
    return renderBoard();
  }

  /* 切到「我的战绩」时按需拉一次资料。
   * 放在这里而不是 renderMe 里，是为了让"加载中 / 已有数据"两个分支
   * 共享同一个入口，避免重复请求。 */
  function maybeLoadProfile() {
    if (state.view !== 'me') return;
    if (profileData || profileLoading) return;
    profileLoading = true;
    renderView();
    loadProfile().then(function () {
      profileLoading = false;
      if (state.view === 'me') renderView();
    });
  }

  function clearBody() {
    while (dom.body.firstChild) dom.body.removeChild(dom.body.firstChild);
    return dom.body;
  }

  function renderAuth() {
    dom.title.textContent = state.user ? '账号' : '登录 / 注册';
    var b = clearBody();

    var tabs = el('div', 'fxo-tabs');
    var tLogin = el('button', 'fxo-tab' + (authMode === 'login' ? ' on' : ''), '登录');
    var tReg = el('button', 'fxo-tab' + (authMode === 'register' ? ' on' : ''), '注册新账号');
    tLogin.type = 'button'; tReg.type = 'button';
    tLogin.addEventListener('click', function () { authMode = 'login'; renderAuth(); });
    tReg.addEventListener('click', function () { authMode = 'register'; renderAuth(); });
    tabs.appendChild(tLogin); tabs.appendChild(tReg);
    b.appendChild(tabs);

    var form = el('div', 'fxo-form');
    var name = el('input', 'fxo-input');
    name.type = 'text'; name.placeholder = '昵称（2~20 字）';
    name.autocomplete = 'username';
    name.maxLength = 20;
    var pw = el('input', 'fxo-input');
    pw.type = 'password';
    pw.placeholder = authMode === 'register' ? '密码（至少 6 位）' : '密码';
    pw.autocomplete = authMode === 'register' ? 'new-password' : 'current-password';
    var err = el('div', 'fxo-err');
    err.id = 'fxoAuthErr';
    var btn = el('button', 'fxo-btn', authMode === 'register' ? '注册并登录' : '登录');
    btn.type = 'button';

    function doSubmit() {
      var n = name.value.trim();
      var p = pw.value;
      if (!n || !p) { err.textContent = '昵称和密码都要填'; return; }
      err.textContent = '';
      btn.disabled = true;
      var path = authMode === 'register' ? '/api/register' : '/api/login';
      api(path, { method: 'POST', body: { name: n, password: p } })
        .then(function (data) {
          state.token = data.token;
          state.user = data.user;
          LS.set(TOKEN_KEY, data.token);
          LS.setJSON(USER_KEY, data.user);
          toast('欢迎，' + data.user.name + '！');
          queueFlush().then(function () {
            state.view = 'board';
            renderView();
          });
          /* ★ 登录后必须重新载入云存档。
           *   玩家可能先以游客身份玩了一会儿才登录 —— 此时如果直接上传，
           *   会用游客的 10,000 覆盖掉他真正的云端进度（灾难级数据丢失）。
           *   所以这里先拉存档，并注册自动同步的监听。 */
          installAccountSync();
          loadAccountState().then(function (d) {
            if (d && d.hasSave) {
              /* 服务端有存档 → 已经覆盖了本地，直接提示玩家即可 */
              return;
            }
            /* 服务端没有存档（首次登录）→ 把当前本地状态作为初始存档推上去 */
            account.loaded = true;
            schedulePush(0);
          });
        })
        .catch(function (e) {
          err.textContent = e.message || '出错了';
          btn.disabled = false;
        });
    }

    btn.addEventListener('click', doSubmit);
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSubmit(); });
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') pw.focus(); });

    form.appendChild(name); form.appendChild(pw); form.appendChild(err); form.appendChild(btn);
    b.appendChild(form);

    var note = el('div', 'fxo-note');
    note.innerHTML = '· 昵称 + 密码即可，不用邮箱。<br>' +
      '· 登录后每一局的<b>峰值身家</b>会自动上榜，通关（净资产 ≥ $2,000 万）另外进通关榜。<br>' +
      '· 不想注册也能玩 —— 成绩会暂存在这台设备上，登录后自动补交。';
    b.appendChild(note);

    setTimeout(function () { try { name.focus(); } catch (e) {} }, 60);
  }

  var authMode = 'login';

  function renderBoard() {
    dom.title.textContent = '排行榜';
    var b = clearBody();

    /* 当前登录态与"我在第几" —— 排行榜最重要的信息之一 */
    if (state.user) {
      var me = el('div', 'fxo-me');
      var cur = boardData && boardData.me;
      var gs = readGameState();
      var saveInfo;
      if (account.hasSave) {
        saveInfo = '<div class="fxo-stat">☁ 云端存档：<b>' +
          money(gs ? gs.balance : 0) + '</b>' +
          (gs && gs.positions.length ? ' · ' + gs.positions.length + ' 个持仓' : '') +
          ' · 最后同步 ' + new Date(account.lastSyncAt).toLocaleTimeString('zh-CN') + '</div>';
      } else {
        saveInfo = '<div class="fxo-stat">☁ 云端存档：<b>尚未建立</b>（开始游玩后会自动保存）</div>';
      }
      me.innerHTML = '<b>' + esc(state.user.name) + '</b>' +
        ' · 历史最好 <b>' + money(state.user.best) + '</b>' +
        ' · 已打 <b>' + state.user.runs + '</b> 局' +
        (state.user.wins ? ' · 通关 <b>' + state.user.wins + '</b> 次' : '') +
        saveInfo +
        (cur ? '<div class="fxo-stat">当前榜单排名：<b>第 ' + cur.rank + ' 名</b>' +
          ' / 共 ' + boardData.total + ' 人</div>'
          : '<div class="fxo-stat">当前榜单还没你的成绩 —— 去打一局吧</div>');
      var btns = el('div', 'fxo-tabs');
      btns.style.marginTop = '10px';
      var bMe = el('button', 'fxo-tab', '我的战绩');
      bMe.type = 'button';
      bMe.addEventListener('click', function () {
        state.view = 'me';
        profileData = null;
        renderView();
        maybeLoadProfile();
      });
      var bOut = el('button', 'fxo-tab', '退出登录');
      bOut.type = 'button';
      bOut.addEventListener('click', function () {
        state.token = ''; state.user = null;
        LS.del(TOKEN_KEY); LS.del(USER_KEY);
        toast('已退出登录');
        state.view = 'auth';
        renderView();
      });
      /* 重置云端存档：玩家想从头开始时用。
       * 必须二次确认 —— 这会清掉资金和所有持仓，误点代价很大。 */
      var bReset = el('button', 'fxo-tab', '重置存档');
      bReset.type = 'button';
      bReset.style.color = '#d1685f';
      bReset.addEventListener('click', function () {
        if (!window.confirm('确定要把云端存档重置为 $10,000 并清空所有持仓吗？\n此操作不可撤销。')) return;
        bReset.disabled = true;
        window.FXOnline.resetAccount()
          .then(function () {
            bReset.disabled = false;
            loadBoard();
          })
          .catch(function (e) {
            bReset.disabled = false;
            toast('重置失败：' + ((e && e.message) || '网络错误'), 'err');
          });
      });
      btns.appendChild(bMe); btns.appendChild(bReset); btns.appendChild(bOut);
      me.appendChild(btns);
      b.appendChild(me);
    } else {
      var loginBox = el('div', 'fxo-me');
      loginBox.innerHTML = '还没登录 —— <b>登录后本局成绩才会进排行榜</b>。' +
        '<div class="fxo-stat">不登录也能玩，成绩会暂存在这台设备上，登录后自动补交。</div>';
      var lb = el('div', 'fxo-tabs');
      lb.style.marginTop = '10px';
      var bLogin = el('button', 'fxo-tab on', '登录 / 注册');
      bLogin.type = 'button';
      bLogin.addEventListener('click', function () { state.view = 'auth'; renderView(); });
      lb.appendChild(bLogin);
      loginBox.appendChild(lb);
      b.appendChild(loginBox);
    }

    /* 榜单切换 */
    var tabs = el('div', 'fxo-tabs');
    var boards = (boardData && boardData.boards) || [
      { key: 'all', title: '总榜' }, { key: 'week', title: '周榜' },
      { key: 'today', title: '日榜' }, { key: 'wins', title: '通关榜' }
    ];
    boards.forEach(function (bk) {
      var t = el('button', 'fxo-tab' + (state.board === bk.key ? ' on' : ''), bk.title.split(' · ')[0]);
      t.type = 'button';
      t.title = bk.title;
      t.addEventListener('click', function () {
        state.board = bk.key;
        loadBoard().then(renderView);
      });
      tabs.appendChild(t);
    });
    b.appendChild(tabs);

    if (boardLoading) {
      b.appendChild(el('div', 'fxo-empty', '正在加载…'));
      return;
    }
    if (boardError) {
      var e = el('div', 'fxo-empty', '榜单加载失败：' + boardError);
      var r = el('button', 'fxo-btn ghost', '重试');
      r.type = 'button';
      r.style.marginTop = '12px';
      r.addEventListener('click', function () { loadBoard().then(renderView); });
      b.appendChild(e); b.appendChild(r);
      return;
    }
    if (!boardData || !boardData.rows || !boardData.rows.length) {
      b.appendChild(el('div', 'fxo-empty', '这个榜单还没有成绩 —— 你可以是第一个。'));
      return;
    }

    var list = el('div');
    boardData.rows.forEach(function (row) {
      var isMe = state.user && row.userId === state.user.id;
      var cls = 'fxo-row' + (isMe ? ' me' : '') + (row.rank <= 3 ? ' top' + row.rank : '');
      var r = el('div', cls);
      r.appendChild(el('div', 'fxo-rank', row.rank <= 3 ? ['🥇', '🥈', '🥉'][row.rank - 1] : '#' + row.rank));
      r.appendChild(el('div', 'fxo-name', row.name));
      if (row.won) r.appendChild(el('span', 'fxo-win', '🏆 通关'));
      r.appendChild(el('div', 'fxo-score', money(row.score)));
      /* 通关榜比的是用时，普通榜比的是身家，副信息跟着变 */
      r.appendChild(el('div', 'fxo-sub', state.board === 'wins'
        ? durationText(row.durationMs)
        : durationText(row.durationMs)));
      list.appendChild(r);
    });
    b.appendChild(list);

    var note = el('div', 'fxo-note');
    note.textContent = '榜单口径：每个账号只取最好的一局；「身家」= 本局峰值净资产（现金 + 持仓浮盈 + 家当市值 − 欠款）。';
    b.appendChild(note);
  }

  function renderMe() {
    dom.title.textContent = '我的战绩';
    var b = clearBody();
    if (!state.user) { state.view = 'auth'; return renderAuth(); }

    var back = el('button', 'fxo-btn ghost', '← 回到排行榜');
    back.type = 'button';
    back.style.marginBottom = '12px';
    back.addEventListener('click', function () { state.view = 'board'; renderBoard(); });
    b.appendChild(back);

    if (profileLoading) { b.appendChild(el('div', 'fxo-empty', '正在加载…')); return; }
    if (!profileData) { b.appendChild(el('div', 'fxo-empty', '加载失败')); return; }

    var u = profileData.user || {};
    var box = el('div', 'fxo-me');
    box.innerHTML = '<b>' + esc(u.name || '') + '</b>' +
      '<div class="fxo-stat">' +
      '<span>历史最好 <b>' + money(u.best) + '</b></span>' +
      '<span>总局数 <b>' + (u.runs || 0) + '</b></span>' +
      '<span>通关 <b>' + (u.wins || 0) + '</b> 次</span>' +
      '<span>注册于 ' + new Date(u.createdAt || Date.now()).toLocaleDateString('zh-CN') + '</span>' +
      '</div>';
    var ranks = profileData.ranks || {};
    var rankText = [];
    if (ranks.all) rankText.push('总榜 #' + ranks.all);
    if (ranks.week) rankText.push('周榜 #' + ranks.week);
    if (ranks.today) rankText.push('日榜 #' + ranks.today);
    if (ranks.wins) rankText.push('通关榜 #' + ranks.wins);
    if (rankText.length) {
      box.innerHTML += '<div class="fxo-stat">名次：<b>' + rankText.join(' · ') + '</b></div>';
    }
    b.appendChild(box);

    var h = el('div');
    h.style.cssText = 'font-size:13px;font-weight:700;margin:14px 0 6px;';
    h.textContent = '最近 ' + ((profileData.history || []).length) + ' 局';
    b.appendChild(h);

    if (!profileData.history || !profileData.history.length) {
      b.appendChild(el('div', 'fxo-empty', '还没有成绩记录。'));
      return;
    }
    var list = el('div');
    profileData.history.forEach(function (row) {
      var r = el('div', 'fxo-row');
      var when = new Date(row.at);
      r.appendChild(el('div', 'fxo-rank', (when.getMonth() + 1) + '/' + when.getDate()));
      r.appendChild(el('div', 'fxo-name', money(row.score)));
      if (row.won) r.appendChild(el('span', 'fxo-win', '🏆'));
      r.appendChild(el('div', 'fxo-sub', durationText(row.durationMs) + ' · ' + row.candles + ' 根'));
      list.appendChild(r);
    });
    b.appendChild(list);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ===================== 数据加载 ===================== */

  var boardData = null, boardLoading = false, boardError = '';
  var profileData = null, profileLoading = false;

  function loadBoard() {
    boardLoading = true; boardError = '';
    var url = '/api/leaderboard?board=' + encodeURIComponent(state.board) + '&limit=50';
    return api(url)
      .then(function (d) { boardData = d; boardLoading = false; setOnline(true); })
      .catch(function (e) {
        boardLoading = false;
        boardError = e.message || '网络错误';
        setOnline(false);
      });
  }

  function loadProfile() {
    profileLoading = true; profileData = null;
    return api('/api/profile')
      .then(function (d) { profileData = d; profileLoading = false; })
      .catch(function () { profileLoading = false; });
  }

  /* 「我的战绩」需要在切到该视图时补一次数据 */
  function refreshBoardSoon() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(function () {
      if (dom.root && dom.root.classList.contains('on')) loadBoard().then(renderView);
    }, 600);
  }

  function setOnline(ok) {
    state.online = ok;
    updateChip();
  }

  /* 安装自动同步的驱动（定时器 + 卸载兜底）。
   * 抽成函数是为了避免"启动时已登录"和"游玩中途登录"两条路径重复注册 ——
   * 重复注册会让同一个状态被推多次，白耗请求额度。 */
  var accountSyncInstalled = false;
  function installAccountSync() {
    if (accountSyncInstalled) return;
    if (!state.token) return;
    accountSyncInstalled = true;
    setInterval(function () {
      watchAccount();
      watchCriticalTrades();
    }, 1000);
    /* beforeunload / pagehide 双保险：Safari 对 beforeunload 支持不稳，
     * pagehide 在移动端更可靠。两个都挂，重复发也无害（服务端幂等）。 */
    window.addEventListener('beforeunload', beaconFinalState);
    window.addEventListener('pagehide', beaconFinalState);
  }

  /* ===================== 启动自检 =====================
   *
   * 排查"资金为什么还是 10000"时，最费时间的是分不清断在哪一环：
   *   ① 联网模块根本没被注入（构建问题）
   *   ② 注入了但没登录（游客 → 按设计不存）
   *   ③ 登录了但 token 失效 / 网络不通
   *   ④ 服务端本来就没有存档（首次登录）
   *   ⑤ 存档载入了但游戏没接受
   *
   * 这个函数把结论直接打到控制台，一眼就能定位。
   * 同时也挂在 window.FXOnline.selfCheck() 上，随时可以手动调用。
   * ==================================================== */
  function selfCheck() {
    var fx = FX();
    var lines = [];
    lines.push('[fx-online 自检]');
    lines.push('  联网模块        : ' + (typeof window.FXOnline === 'object' ? '已加载 ✅' : '未加载 ❌（构建或缓存问题）'));
    lines.push('  游戏对象        : ' + (fx && fx.state ? '正常 ✅' : '缺失 ❌'));
    lines.push('  登录状态        : ' + (state.token ? '已登录（' + (state.user ? state.user.name : '信息加载中') + '）' : '游客 ❌ 不会存云端'));
    lines.push('  存档已拉取      : ' + (account.loaded ? '是 ✅' : (state.token ? '否 ❌（请求未完成或失败）' : '否（游客不拉）')));
    lines.push('  服务端有存档    : ' + (account.hasSave ? '有 ✅' : '没有（或未拉取）'));
    lines.push('  最后同步时间    : ' + (account.lastSyncAt ? new Date(account.lastSyncAt).toLocaleString('zh-CN') : '从未'));
    lines.push('  是否被标记过旧  : ' + (account.blocked ? '是 ❌（云端更新，已停止覆盖）' : '否'));
    var gs = readGameState();
    lines.push('  当前游戏资金    : $' + (gs ? gs.balance.toLocaleString('en-US') : '?') +
      '  ·  持仓 ' + (gs ? gs.positions.length : 0) + ' 个');
    if (!state.token) {
      lines.push('  ⚠ 你现在是游客：资金只存在内存里，刷新必然回到 $10,000。');
      lines.push('    点顶栏「🌐 排行榜」→ 注册/登录 后才会启用云端存档。');
    } else if (account.loaded && !account.hasSave) {
      lines.push('  ℹ 这个账号在服务端还没有存档。开始游玩后会自动建立（约 3 秒内）。');
    }
    var text = lines.join('\n');
    if (window.console && console.log) console.log(text);
    return text;
  }

  /* 启动 2.5 秒后自动跑一次，只在"登录了但存档没拉下来"时才用 warn 提醒，
   * 避免正常玩家的控制台被刷屏。 */
  function accountSelfCheck() {
    if (!state.token) return;      // 游客：不打扰
    if (account.loaded) return;    // 正常：不用提示
    if (window.console && console.warn) {
      console.warn('[fx-online] 已登录但云端存档未能载入，' +
        '刷新后资金可能回到初始值。请检查网络或运行 FXOnline.selfCheck() 查看详情。');
    }
  }

  /* ===================== 启动 ===================== */

  function boot() {
    injectCss();
    buildModal();
    mountChip();
    updateBadge();

    /* 等游戏初始化完毕再挂钩：游戏脚本是同步 IIFE，
     * 我们用 DOMContentLoaded + 一小段延迟确保 window.FX 已经就位。 */
    function ready() {
      if (!FX()) { setTimeout(ready, 100); return; }
      /* 观测循环：1 秒一次。结算状态会一直保留到玩家做出选择，
       * 所以这个频率不会漏掉任何一次结算。 */
      setInterval(observe, 1000);
      observe();                       // 立即建立基准快照
      /* 2 秒采样一次峰值。用独立定时器而不是游戏 tick：
       * 这样即使用户暂停游戏，采样依然工作，峰值不会漏掉。 */
      setInterval(sample, 2000);

      /* ★ 云存档：先拉服务端存档，再启动自动同步。
       *   顺序很重要 —— 必须等 applySaveToGame 把状态写回去之后，
       *   再建立"上次推送指纹"，否则会把恢复出来的状态又当成"新变化"推一次。 */
      installAccountSync();

      /* 开局就把榜单拉一次：玩家点开排行榜时应当已经是最新的 */
      loadBoard().then(function () { renderHud(); }).catch(function () {});

      /* ★ 载入云存档：**独立发起**，不要挂在 /api/me 的 then 链里。
       *
       *   这是一个真实的可用性 bug（已修）：
       *   早先写成 api('/api/me').then(... => loadAccountState())，
       *   于是 /api/me 只要出任何一次问题（500、超时、企业网络拦截），
       *   整条链就进 catch，loadAccountState() **永远不会执行** ——
       *   表现就是"玩家明明登录了，刷新后资金还是 10000"，
       *   而且屡刷不好，因为每次都在同一个点失败。
       *
       *   现在两条请求彼此独立：/api/me 只负责拿昵称，
       *   存档加载自己判断 token 是否有效，互不拖累。 */
      if (state.token) loadAccountState();

      if (state.token) {
        api('/api/me')
          .then(function (d) {
            state.user = d.user;
            LS.setJSON(USER_KEY, d.user);
            setOnline(true);
            queueFlush();
          })
          .catch(function (e) {
            if (e && e.status === 401) {
              state.token = ''; state.user = null;
              LS.del(TOKEN_KEY); LS.del(USER_KEY);
            }
            setOnline(false);
          });
      }

      /* 启动自检：把"存档到底加载了没有"打到控制台。
       * 玩家反馈"资金还是 10000"时，看一眼这行就能定位是哪一环断的，
       * 不用再去猜模块有没有被注入。 */
      setTimeout(accountSelfCheck, 2500);
      /* 联网后自动补交离线成绩 */
      window.addEventListener('online', function () { queueFlush(); });
      if (window.console && console.log) {
        console.log('[fx-online] 就绪（API: ' + (API_BASE || '同源') + '）');
      }
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', ready);
    } else {
      ready();
    }
  }

  /* 对外暴露一点调试能力，方便排查问题（不影响游戏） */
  window.FXOnline = {
    open: open, close: close, state: state,
    submit: function (reason) {
      var s = session;
      if (!s) return Promise.resolve({ skipped: true });
      session = null;
      startSession('settle');
      return submitSession(s, reason || 'manual', false);
    },
    observe: observe,
    queue: queueLoad,
    flush: queueFlush,
    apiBase: API_BASE,
    loadBoard: loadBoard,
    /* ---------- 云存档（调试/测试用） ---------- */
    account: account,
    readGameState: readGameState,
    stateKey: stateKey,
    loadAccountState: loadAccountState,
    applySaveToGame: applySaveToGame,
    /* 手动触发一次推送。
     * 默认**尊重内容指纹**：状态没变化就不发请求（与自动同步一致）；
     * 传 force=true 才强制发送（排查问题时用，例如怀疑服务端没收到）。 */
    syncNow: function (force) {
      if (force) account.lastSentKey = '';
      account.pending = false;
      return pushAccount(force ? 'manual-force' : 'manual');
    },
    /* 手动触发卸载兜底（测试用：sendBeacon 在测试环境不可用，会走 XHR） */
    beacon: beaconFinalState,
    /* 自检：排查"资金还是 10000"时先跑这个 */
    selfCheck: selfCheck,
    /* 重置云端存档（走真实接口） */
    resetAccount: function () {
      if (!state.token) return Promise.resolve({ ok: false, error: '未登录' });
      return api('/api/account/reset', { method: 'POST' }).then(function (d) {
        account.lastSentKey = '';
        if (typeof d.balance === 'number') {
          applySaveToGame({ balance: d.balance, positions: [] });
        }
        toast('云端存档已重置为 $' + Math.round(d.balance || 10000));
        return d;
      });
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
