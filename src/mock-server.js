/*
 * MockServer —— 用 localStorage 模拟一个后端。
 *
 * 目的：Toy SDK 还没下发，但排行榜和幽灵对战现在就要能用。
 * 所以这里做一个**接口形状与未来 Toy 版一致**的假后端：
 * 以后接上真后端，只需把这一层的四个函数换掉，上层代码一行都不用动。
 *
 * ============================ 设计约束 ============================
 *
 * 1) **零依赖、原生 JS**。可以直接 <script> 引入，也能在 Node 里 require 做测试。
 * 2) **storage 可注入**。默认用 localStorage，取不到时自动退化为内存 Map
 *    （file:// 打开、隐私模式、配额耗尽都不会崩）。测试里注入假的即可。
 * 3) **所有读入都当脏数据**。localStorage 是用户能随手改的地方，
 *    所以每次读取都做 JSON 容错、类型校验、字段裁剪。
 * 4) **写入有配额保护**。幽灵时间轴可能很大，localStorage 只有 5MB 左右。
 *    写失败时自动淘汰最旧的幽灵并重试，绝不抛错给游戏。
 * ==================================================================
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MockServer = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* ---------- 常量 ---------- */

  var KEY_BOARD = 'fx_leaderboard';
  var KEY_GHOSTS = 'fx_ghosts';

  var MAX_BOARD = 200;         // 排行榜最多留多少条
  var MAX_GHOSTS = 30;         // 幽灵最多留多少个（体积大，留少一点）
  var MAX_TIMELINE = 3000;     // 单个幽灵最多多少条时间轴节点
  var MAX_NAME = 20;           // 昵称长度上限
  var NAME_DEFAULT = '匿名玩家';

  /* ---------- storage 适配 ---------- */

  /* 内存兜底：localStorage 不可用时用它，保证功能不崩（只是刷新后丢） */
  var memStore = Object.create(null);
  var memAdapter = {
    getItem: function (k) { return k in memStore ? memStore[k] : null; },
    setItem: function (k, v) { memStore[k] = String(v); },
    removeItem: function (k) { delete memStore[k]; },
  };

  var injected = null;   // 测试/上层可注入

  /* 探测 localStorage 是否真的可写：
   * 光判断 typeof 不够 —— Safari 隐私模式下 localStorage 存在但
   * setItem 会直接抛 QuotaExceededError。 */
  var cached = null;
  function detect() {
    if (cached) return cached;
    try {
      if (typeof localStorage !== 'undefined' && localStorage) {
        var probe = '__fx_probe__';
        localStorage.setItem(probe, '1');
        localStorage.removeItem(probe);
        cached = localStorage;
        return cached;
      }
    } catch (e) { /* 不可用 */ }
    cached = memAdapter;
    return cached;
  }

  function storage() {
    return injected || detect();
  }

  function setStorage(s) {
    injected = s || null;
    cached = null;
  }

  /* ---------- 通用工具 ---------- */

  function safeGet(key) {
    try {
      var raw = storage().getItem(key);
      if (raw == null) return null;
      return JSON.parse(raw);
    } catch (e) {
      /* 数据损坏：不要让它传染。返回 null，后续会当作空处理。 */
      return null;
    }
  }

  function safeSet(key, value) {
    var payload;
    try { payload = JSON.stringify(value); }
    catch (e) { return false; }
    try {
      storage().setItem(key, payload);
      return true;
    } catch (e) {
      return false;
    }
  }

  function num(v, fallback) {
    var n = Number(v);
    return isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function round2(n) {
    return Math.round(num(n) * 100) / 100;
  }

  /* 昵称清洗：去控制字符、去首尾空白、限长、空则用默认值 */
  function cleanName(name) {
    var s = String(name == null ? '' : name);
    /* 去掉控制字符（可能破坏 UI 或被当成注入） */
    s = s.replace(/[\u0000-\u001F\u007F]/g, '');
    s = s.trim();
    if (!s) return NAME_DEFAULT;
    if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME);
    return s;
  }

  /* ============================ 排行榜 ============================ */

  /*
   * 保存一条成绩。
   * @param name    玩家昵称
   * @param profit  本局收益（可为负）
   * @param opts    { id } 可选：传了就按 id 去重（防同一局重复记账）
   * @return { ok, entry, rank, total }
   */
  function saveScore(name, profit, opts) {
    var o = opts || {};
    var list = readBoard();

    var entry = {
      name: cleanName(name),
      profit: round2(profit),
      at: Date.now(),
      /* id 只用于去重，不对外暴露（getLeaderboard 会剥掉它） */
      _id: o.id ? String(o.id) : null,
    };

    /* 去重：同一个 id 只保留最后一次（覆盖），避免"结算"和"再来一局"
     * 两处都触发保存时记两条。 */
    if (entry._id) {
      var idx = -1;
      for (var i = 0; i < list.length; i++) {
        if (list[i]._id === entry._id) { idx = i; break; }
      }
      if (idx >= 0) list.splice(idx, 1);
    }

    list.push(entry);
    sortBoard(list);
    if (list.length > MAX_BOARD) list.length = MAX_BOARD;

    safeSet(KEY_BOARD, list);

    var rank = -1;
    for (var k = 0; k < list.length; k++) {
      if (list[k] === entry) { rank = k + 1; break; }
    }
    return { ok: true, entry: publicEntry(entry, rank), rank: rank, total: list.length };
  }

  /*
   * 读取排行榜，按 profit 降序。
   * @param limit 可选：只取前 N 条
   * @return [{ rank, name, profit, at }]
   */
  function getLeaderboard(limit) {
    var list = readBoard();
    sortBoard(list);
    var n = (typeof limit === 'number' && limit > 0) ? Math.min(limit, list.length) : list.length;
    var out = [];
    for (var i = 0; i < n; i++) out.push(publicEntry(list[i], i + 1));
    return out;
  }

  function clearLeaderboard() {
    safeSet(KEY_BOARD, []);
    return { ok: true };
  }

  /* 内部：读排行榜并做结构校验（含兼容"包了一层 {list:[]}"的旧形态） */
  function readBoard() {
    var raw = safeGet(KEY_BOARD);
    if (!raw) return [];
    var arr = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.list) ? raw.list : []);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var it = arr[i];
      if (!it || typeof it !== 'object') continue;
      var p = Number(it.profit);
      if (!isFinite(p)) continue;          // 脏数据直接丢
      out.push({
        name: cleanName(it.name),
        profit: round2(p),
        at: num(it.at, 0),
        _id: it._id ? String(it._id) : null,
      });
    }
    return out;
  }

  function sortBoard(list) {
    /* 降序；同分时先达成的排前面（用 at 升序做次级排序，更公平） */
    list.sort(function (a, b) {
      if (b.profit !== a.profit) return b.profit - a.profit;
      return a.at - b.at;
    });
  }

  function publicEntry(e, rank) {
    return {
      rank: rank,
      name: e.name,
      profit: e.profit,
      at: e.at,
    };
  }

  /* ============================ 幽灵 ============================ */

  /*
   * 保存一个幽灵（战报）。
   * @param name         玩家昵称
   * @param finalProfit  本局最终收益
   * @param timeline     时间轴数组 [{t, act, pair, side, price, balance, equity}]
   * @param opts         { startEquity, id } 可选
   * @return matchId 字符串；失败返回 null
   */
  function saveGhost(name, finalProfit, timeline, opts) {
    var o = opts || {};
    var ghosts = readGhosts();

    var matchId = makeMatchId();
    var cleanTimeline = sanitizeTimeline(timeline);

    var ghost = {
      matchId: matchId,
      name: cleanName(name),
      finalProfit: round2(finalProfit),
      startEquity: round2(num(o.startEquity, 10000)),
      timeline: cleanTimeline,
      createdAt: Date.now(),
    };

    ghosts[matchId] = ghost;

    /* 配额保护：先按数量淘汰，再按体积重试 */
    pruneGhosts(ghosts);

    if (!safeSet(KEY_GHOSTS, ghosts)) {
      /* 写失败（多半是配额）：继续淘汰最旧的，直到写得进去或只剩 1 个 */
      var ids = Object.keys(ghosts).sort(function (a, b) {
        return ghosts[a].createdAt - ghosts[b].createdAt;
      });
      while (ids.length > 1) {
        delete ghosts[ids.shift()];
        if (safeSet(KEY_GHOSTS, ghosts)) break;
      }
      if (!safeSet(KEY_GHOSTS, ghosts)) return null;
    }

    return matchId;
  }

  /*
   * 读取幽灵。
   * @return ghost 对象；不存在/损坏返回 null
   */
  function getGhost(matchId) {
    var id = String(matchId == null ? '' : matchId).trim();
    if (!id) return null;
    var ghosts = readGhosts();
    var g = ghosts[id];
    if (!g || typeof g !== 'object') return null;

    return {
      matchId: String(g.matchId || id),
      name: cleanName(g.name),
      finalProfit: round2(g.finalProfit),
      startEquity: round2(num(g.startEquity, 10000)),
      timeline: sanitizeTimeline(g.timeline),
      createdAt: num(g.createdAt, 0),
    };
  }

  /* 列出所有幽灵（调试/管理用，按时间倒序） */
  function listGhosts() {
    var ghosts = readGhosts();
    return Object.keys(ghosts).map(function (id) {
      var g = ghosts[id];
      return {
        matchId: String(g.matchId || id),
        name: cleanName(g.name),
        finalProfit: round2(g.finalProfit),
        nodes: Array.isArray(g.timeline) ? g.timeline.length : 0,
        createdAt: num(g.createdAt, 0),
      };
    }).sort(function (a, b) {
      /* ★ createdAt 可能相同：同一毫秒内连续保存多个幽灵时（批量生成、
       *   脚本连调），时间戳完全一样。只按时间排会得到不确定的顺序，
       *   "最后一次保存的排最前"就保证不了。
       *   所以同时间戳时用 matchId 降序兜底 —— matchId 含递增的时间戳前缀
       *   与随机尾，字典序降序与创建顺序基本一致，且是确定性的。 */
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return a.matchId < b.matchId ? 1 : (a.matchId > b.matchId ? -1 : 0);
    });
  }

  function deleteGhost(matchId) {
    var ghosts = readGhosts();
    var id = String(matchId == null ? '' : matchId).trim();
    if (!ghosts[id]) return { ok: false, error: '没有这个幽灵' };
    delete ghosts[id];
    safeSet(KEY_GHOSTS, ghosts);
    return { ok: true };
  }

  function clearGhosts() {
    safeSet(KEY_GHOSTS, {});
    return { ok: true };
  }

  /* 生成 matchId：时间戳（36 进制）+ 短随机后缀。
   * 只用时间戳在同一毫秒内连存两个会撞，所以补个随机尾。 */
  function makeMatchId() {
    var ts = Date.now().toString(36);
    var rnd = Math.floor(Math.random() * 1679616).toString(36);  // 36^4
    while (rnd.length < 4) rnd = '0' + rnd;
    return ts + '-' + rnd;
  }

  /* 时间轴清洗：字段白名单 + 数量上限 + 时间单调。
   * 时间轴来自游戏自身，但它会被写进 localStorage（用户可改），
   * 所以读回来时也要按不可信数据处理。 */
  function sanitizeTimeline(tl) {
    if (!Array.isArray(tl)) return [];
    var out = [];
    var lastT = -1;
    for (var i = 0; i < tl.length && out.length < MAX_TIMELINE; i++) {
      var n = tl[i];
      if (!n || typeof n !== 'object') continue;
      var t = num(n.t, NaN);
      if (!isFinite(t) || t < 0) continue;
      if (t < lastT) continue;               // 时间倒退的节点丢掉
      var act = String(n.act || '');
      if (act !== 'open' && act !== 'close') continue;
      var side = n.side === 'short' ? 'short' : (n.side === 'long' ? 'long' : null);
      out.push({
        t: Math.round(t * 10) / 10,
        act: act,
        pair: String(n.pair || '').slice(0, 16),
        side: side,
        price: num(n.price, 0),
        balance: round2(n.balance),
        equity: round2(n.equity),
      });
      lastT = t;
    }
    return out;
  }

  function readGhosts() {
    var raw = safeGet(KEY_GHOSTS);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw;
  }

  /* 按数量淘汰最旧的，保证体积可控 */
  function pruneGhosts(ghosts) {
    var ids = Object.keys(ghosts);
    if (ids.length <= MAX_GHOSTS) return;
    ids.sort(function (a, b) {
      return num(ghosts[a].createdAt, 0) - num(ghosts[b].createdAt, 0);
    });
    var drop = ids.length - MAX_GHOSTS;
    for (var i = 0; i < drop; i++) delete ghosts[ids[i]];
  }

  /* ============================ 管理 ============================ */

  function clearAll() {
    safeSet(KEY_BOARD, []);
    safeSet(KEY_GHOSTS, {});
    return { ok: true };
  }

  /* 当前占用体积（字节），用于排查配额问题 */
  function usage() {
    var bytes = 0;
    try {
      var b = storage().getItem(KEY_BOARD);
      var g = storage().getItem(KEY_GHOSTS);
      bytes = (b ? b.length : 0) + (g ? g.length : 0);
    } catch (e) { /* 忽略 */ }
    return {
      bytes: bytes,
      kb: Math.round(bytes / 1024 * 10) / 10,
      board: getLeaderboard().length,
      ghosts: listGhosts().length,
    };
  }

  return {
    /* 排行榜 */
    saveScore: saveScore,
    getLeaderboard: getLeaderboard,
    clearLeaderboard: clearLeaderboard,
    /* 幽灵 */
    saveGhost: saveGhost,
    getGhost: getGhost,
    listGhosts: listGhosts,
    deleteGhost: deleteGhost,
    clearGhosts: clearGhosts,
    /* 管理 */
    clearAll: clearAll,
    usage: usage,
    /* 注入 storage（测试用） */
    setStorage: setStorage,
    /* 常量（测试与上层共用） */
    KEY_BOARD: KEY_BOARD,
    KEY_GHOSTS: KEY_GHOSTS,
    MAX_BOARD: MAX_BOARD,
    MAX_GHOSTS: MAX_GHOSTS,
    MAX_TIMELINE: MAX_TIMELINE,
    MAX_NAME: MAX_NAME,
    NAME_DEFAULT: NAME_DEFAULT,
  };
});
