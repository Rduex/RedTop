/*
 * 排行榜与成绩校验。
 *
 * ============================ 防作弊的设计取舍 ============================
 * 本版本采用「客户端上报 + 服务端合理性校验」（用户明确选择的方案）。
 * 必须诚实地说明它的强度边界：
 *
 *   能挡住：
 *     - 直接改前端数字 / 控制台随手 submit 一个天文数字；
 *     - 时间上不可能的成绩（宣称 10 秒打了 10000 个 tick —— 游戏每 1.5 秒才走一 tick）；
 *     - 高频刷榜、重复提交同一份成绩、冒用别人昵称；
 *     - 数值本身越界的成绩（超过硬上限、tick 数与时长矛盾、未达标却报"通关"）。
 *
 *   挡不住：
 *     - 一个懂游戏内部机制的人，伪造一份"时间线自洽"的完整成绩
 *       （合理的 tick 数 + 合理的时长 + 合理的分数）。
 *
 * 因此服务端另有一层「权威复盘的接口预留」：见 verify.js 的 ReplayVerifier。
 * 后续若把游戏改成"种子化随机数 + 全量操作上报"，就能把这一层换成真正的服务端重算，
 * 届时前端伪造将完全失效。当前版本先把接口和数据结构留好，不阻塞上线。
 * ==========================================================================
 */
'use strict';

const crypto = require('crypto');

/* ---------- 可调参数（全部集中在这里，便于按运营情况收紧） ---------- */
const LIMITS = {
  /* 单条成绩的硬上限：$10 万亿。
   * 游戏通关线是 $2,000 万，正常情况下连它的零头都到不了，所以这个上限
   * 不误杀任何真实玩家，但能挡住"随手填 1e30"这种最朴素的伪造。 */
  MAX_SCORE: 1e13,
  /* 一局最少要走多少个 tick 才算数（4 tick = 1 根 K 线，这里 2 根）。
   * 防止"开号即提交"刷满排行榜。 */
  MIN_TICKS: 8,
  /* tick 与真实时长的矛盾判定：游戏每 1.5 秒走一个 tick，且暂停/弹窗只会
   * 让 tick 变少而不会变多，所以 durationMs 不可能小于 tickCount × 1500。
   * 留 10% 余量给定时器抖动与客户端计时误差。 */
  TICK_MS: 1500,
  TICK_SLACK: 0.9,
  /* 一局最长按 45 天算：超过这个时长基本是挂着页面的僵尸标签，
   * 数据没有比较意义，直接拒绝。 */
  MAX_DURATION_MS: 45 * 24 * 3600 * 1000,
  /* 每个账号每小时最多提交多少局：防刷榜（正常人一小时打不了这么多局）。 */
  MAX_SUBMITS_PER_HOUR: 60,
  /* 同一账号保留的历史成绩条数上限：超出后丢弃最旧的，避免数据无限膨胀。 */
  HISTORY_PER_USER: 200,
  /* 全局成绩表上限：超出后按时间淘汰最旧的。 */
  MAX_TOTAL_SCORES: 200000,
  /* 重复提交去重窗口：同样内容的成绩在这个时间窗内只收一次。 */
  DEDUP_MS: 60 * 1000,
};

const REASONS = {
  settle: '爆仓结算',
  restart: '重新开始',
  retire: '达标收手',
  quit: '离开游戏',
  manual: '手动提交',
};

function clampNum(v, min, max, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/* 归一化客户端上报的 payload：所有字段都当作不可信输入处理。
 * 先把类型与范围压到合法区间，再做语义校验 —— 这样后面的判断不会踩到
 * 字符串/NaN/Infinity 这些坑。 */
function normalizeSubmission(raw) {
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    /* 主指标：本局峰值权益（排行榜按它排） */
    score: clampNum(p.score, 0, Number.MAX_SAFE_INTEGER, 0),
    /* 结算时的账户权益 */
    equity: clampNum(p.equity, 0, Number.MAX_SAFE_INTEGER, 0),
    /* 本局开局资金 */
    startEquity: clampNum(p.startEquity, 0, LIMITS.MAX_SCORE, 0),
    /* 通关目标（用于校验 won 是否自洽） */
    target: clampNum(p.target, 1, LIMITS.MAX_SCORE, 20000000),
    won: !!p.won,
    /* 行情推进量：tick 数与折算出的 K 线数 */
    tickCount: Math.floor(clampNum(p.tickCount, 0, 1e9, 0)),
    candles: Math.floor(clampNum(p.candles, 0, 1e9, 0)),
    /* 本局操作量 */
    trades: Math.floor(clampNum(p.trades, 0, 1e9, 0)),
    cards: Math.floor(clampNum(p.cards, 0, 1e9, 0)),
    assets: Math.floor(clampNum(p.assets, 0, 1e9, 0)),
    cycles: Math.floor(clampNum(p.cycles, 0, 1e9, 0)),
    /* 本局墙钟时长（客户端测量） */
    durationMs: clampNum(p.durationMs, 0, LIMITS.MAX_DURATION_MS * 2, 0),
    /* 结束原因 */
    reason: REASONS[String(p.reason || '')] ? String(p.reason) : 'manual',
    mode: String(p.mode || 'sim').slice(0, 24),
    /* 客户端自带的运行标识：用于"同一局只提交一次"的去重 */
    runId: String(p.runId || '').slice(0, 64),
  };
}

/*
 * 合理性校验。返回 { ok:true, sub } 或 { ok:false, error, code }。
 * user 为已认证的账号；now 便于测试注入固定时间。
 */
function validateSubmission(sub, user, now) {
  const t = now === undefined ? Date.now() : now;

  /* ① 数值越界：最粗暴的伪造在这里就被拦掉 */
  if (sub.score > LIMITS.MAX_SCORE) {
    return { ok: false, code: 'score_too_large', error: '成绩超出合理上限' };
  }
  if (sub.startEquity > LIMITS.MAX_SCORE) {
    return { ok: false, code: 'start_too_large', error: '开局资金超出合理上限' };
  }

  /* ② 时间与 tick 数必须自洽：游戏每 1.5 秒一个 tick，暂停只会更少。
   *    这是本方案里最有效的一条"不可能性"判据。 */
  if (sub.tickCount < LIMITS.MIN_TICKS) {
    return { ok: false, code: 'too_short', error: '这一局太短了，打满 ' + Math.ceil(LIMITS.MIN_TICKS / 4) + ' 根 K 线才能上榜' };
  }
  const neededMs = sub.tickCount * LIMITS.TICK_MS * LIMITS.TICK_SLACK;
  if (sub.durationMs < neededMs) {
    return {
      ok: false, code: 'time_mismatch',
      error: 'tick 数与实际用时对不上（' + sub.tickCount + ' tick 至少需要 ' +
        Math.round(neededMs / 1000) + ' 秒）',
    };
  }
  if (sub.durationMs > LIMITS.MAX_DURATION_MS) {
    return { ok: false, code: 'too_long', error: '这一局挂了太久，成绩不予记录' };
  }

  /* ③ K 线数不能超过 tick 数（4 tick 收一根） */
  if (sub.candles > Math.floor(sub.tickCount / 4) + 1) {
    return { ok: false, code: 'candle_mismatch', error: 'K 线数与行情推进量对不上' };
  }

  /* ④ 通关声明必须真的达到目标 */
  if (sub.won && sub.score < sub.target) {
    return { ok: false, code: 'fake_win', error: '未达到通关目标却声明通关' };
  }

  /* ⑤ 峰值不能低于结算权益太多：峰值本局恒 ≥ 开局，且理论上 ≥ 任意时刻权益。
   *    允许 1% 的浮点/取整误差。 */
  if (sub.score + Math.max(1, sub.score * 0.01) < sub.equity) {
    return { ok: false, code: 'peak_below_equity', error: '峰值权益低于结算权益，数据不自洽' };
  }
  if (sub.score < sub.startEquity * 0.5) {
    return { ok: false, code: 'peak_too_low', error: '峰值权益低于开局资金，数据不自洽' };
  }

  /* ⑥ 频率限制：按小时窗口数一数这个账号提交了多少局 */
  const recent = countRecent(user.id, t - 3600 * 1000);
  if (recent >= LIMITS.MAX_SUBMITS_PER_HOUR) {
    return { ok: false, code: 'rate_limited', error: '提交太频繁了，休息一会儿再上榜' };
  }

  /* ⑦ 去重：没有 runId 的成绩按"内容完全相同且在窗口内"去重。
   * 有 runId 的走 upsert（见 Leaderboard.submit）：同一局允许多次上报，
   * 服务端只保留最好的那一次 —— 这样"通关瞬间先报一次、之后又刷新了峰值"
   * 这种正常情况不会被误判成重复提交。 */
  if (!sub.runId && isDuplicateContent(user.id, sub, t)) {
    return { ok: false, code: 'duplicate', error: '这份成绩刚刚提交过' };
  }

  return { ok: true };
}

/* ---------- 以下三个查询需要读全局成绩表，故由 leaderboard 实例提供 ---------- */

let _scoresRef = null;
function bindScores(scores) { _scoresRef = scores; }

function countRecent(userId, since) {
  let n = 0;
  const list = _scoresRef || [];
  for (let i = 0; i < list.length; i++) {
    if (list[i].userId === userId && list[i].at >= since) n++;
  }
  return n;
}

function findRun(scores, userId, runId) {
  const list = scores || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].userId === userId && list[i].runId === runId) return list[i];
  }
  return null;
}

function isDuplicateContent(userId, sub, now) {
  const list = _scoresRef || [];
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    if (s.userId !== userId) continue;
    if (now - s.at > LIMITS.DEDUP_MS) continue;
    if (s.score === sub.score && s.tickCount === sub.tickCount &&
        s.durationMs === sub.durationMs && s.reason === sub.reason) return true;
  }
  return false;
}

/* ============================ 排行榜 ============================ */

const BOARDS = {
  /* 全部时间的个人最好成绩 */
  all: { title: '总榜 · 历史最高身家', desc: '每个账号取历史最好的一局' },
  /* 本周（最近 7 天） */
  week: { title: '周榜 · 近 7 天最高身家', desc: '最近 7 天内的最好一局' },
  /* 今天（自然日，按服务器本地时区） */
  today: { title: '日榜 · 今日最高身家', desc: '今天打出的一局' },
  /* 通关榜：只收录达成 $2,000 万的局，按用时短优先 */
  wins: { title: '通关榜 · 谁最快赢回 2,000 万', desc: '只看通关的局，用时越短越强' },
};

function startOfToday(now) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/* 从全量成绩里筛出某个榜单该看的那些记录 */
function filterForBoard(scores, board, now) {
  if (board === 'today') {
    const from = startOfToday(now);
    return scores.filter((s) => s.at >= from);
  }
  if (board === 'week') {
    return scores.filter((s) => s.at >= now - 7 * 24 * 3600 * 1000);
  }
  if (board === 'wins') {
    return scores.filter((s) => s.won);
  }
  return scores;
}

/* 每个账号只留一条代表成绩：
 *   - 普通榜取 score 最大；
 *   - 通关榜取"用时最短"（时长是通关榜的主排序键）。 */
function bestPerUser(list, board) {
  const map = new Map();
  for (const s of list) {
    const cur = map.get(s.userId);
    if (!cur) { map.set(s.userId, s); continue; }
    if (board === 'wins') {
      if (s.durationMs < cur.durationMs ||
          (s.durationMs === cur.durationMs && s.score > cur.score)) map.set(s.userId, s);
    } else if (s.score > cur.score ||
               (s.score === cur.score && s.at < cur.at)) {
      map.set(s.userId, s);
    }
  }
  return Array.from(map.values());
}

function sortBoard(list, board) {
  if (board === 'wins') {
    return list.sort((a, b) =>
      (a.durationMs - b.durationMs) || (b.score - a.score) || (a.at - b.at));
  }
  return list.sort((a, b) => (b.score - a.score) || (a.at - b.at));
}

/* 对外暴露的一行（脱敏：不带 userId 以外的内部字段） */
function toRow(entry, rank) {
  return {
    rank,
    name: entry.name,
    score: entry.score,
    equity: entry.equity,
    startEquity: entry.startEquity,
    won: entry.won,
    at: entry.at,
    durationMs: entry.durationMs,
    tickCount: entry.tickCount,
    candles: entry.candles,
    trades: entry.trades,
    cards: entry.cards,
    assets: entry.assets,
    cycles: entry.cycles,
    reason: entry.reason,
    mode: entry.mode,
    userId: entry.userId,
  };
}

class Leaderboard {
  constructor(store) {
    this.store = store;
    bindScores(store.db.scores);
  }

  /* 提交一局成绩：校验 → 入库（同一局 upsert）→ 更新账号统计 → 返回名次 */
  submit(user, rawSub, now) {
    const t = now === undefined ? Date.now() : now;
    const sub = normalizeSubmission(rawSub);
    const check = validateSubmission(sub, user, t);
    if (!check.ok) return check;

    const entry = {
      id: crypto.randomUUID(),
      userId: user.id,
      name: user.name,
      score: sub.score,
      peak: sub.score,
      equity: sub.equity,
      startEquity: sub.startEquity,
      target: sub.target,
      won: sub.won,
      at: t,
      tickCount: sub.tickCount,
      candles: sub.candles,
      trades: sub.trades,
      cards: sub.cards,
      assets: sub.assets,
      cycles: sub.cycles,
      durationMs: sub.durationMs,
      mode: sub.mode,
      reason: sub.reason,
      runId: sub.runId,
    };

    let isNew = true;
    this.store.mutate((db) => {
      /* 同一局（同 runId）允许多次上报：前端同一次游戏生命周期里
       * 「结算」和「通关」两个时间点都会提交，且后者峰值更高。
       * 这里只保留最好的那一条，而不是报错或写两行 ——
       * 否则排行榜上会出现同一个人的重复条目。 */
      if (entry.runId) {
        const prev = findRun(db.scores, user.id, entry.runId);
        if (prev) {
          isNew = false;
          /* won 一旦为真就不会退回（通关是这一局的既成事实） */
          entry.won = entry.won || prev.won;
          if (entry.score >= prev.score) {
            prev.score = entry.score;
            prev.peak = entry.score;
            prev.equity = entry.equity;
            prev.at = entry.at;
            prev.tickCount = Math.max(prev.tickCount, entry.tickCount);
            prev.candles = Math.max(prev.candles, entry.candles);
            prev.cards = entry.cards;
            prev.assets = entry.assets;
            prev.cycles = entry.cycles;
            prev.durationMs = entry.durationMs;
            prev.reason = entry.reason;
            prev.won = entry.won;
          }
          entry.id = prev.id;
        }
      }
      if (isNew) db.scores.push(entry);

      /* 账号累计统计：只有新的一局才计 runs，避免重复上报刷局数 */
      if (isNew) {
        user.runs += 1;
        if (entry.score > user.best) user.best = entry.score;
        user.lastSeen = t;
      } else if (entry.score > user.best) {
        user.best = entry.score;
      }
      /* 通关次数按"这一局是否通关过"记，用 runId 去重 */
      if (entry.won) {
        const key = user.id + '|' + (entry.runId || entry.id);
        if (!db.meta.winKeys) db.meta.winKeys = {};
        if (!db.meta.winKeys[key]) {
          db.meta.winKeys[key] = t;
          user.wins += 1;
        }
      }
      prune(db);
    }, { sync: true });   // 成绩不可再生：同步落盘，掉电/强杀也不丢

    const rank = this.rankOf(user.id, 'all', t);
    return { ok: true, entry: toRow(entry, rank.rank), rank: rank.rank, total: rank.total, updated: !isNew };
  }

  /* 某账号在指定榜单上的名次（不在榜上返回 rank: null） */
  rankOf(userId, board, now) {
    const t = now === undefined ? Date.now() : now;
    const list = sortBoard(bestPerUser(filterForBoard(this.store.db.scores, board, t), board), board);
    const idx = list.findIndex((s) => s.userId === userId);
    return { rank: idx < 0 ? null : idx + 1, total: list.length };
  }

  /* 榜单查询：支持分页，并标出"我"在哪一行（前端高亮） */
  board(boardName, opts) {
    const o = opts || {};
    const t = o.now === undefined ? Date.now() : o.now;
    const name = BOARDS[boardName] ? boardName : 'all';
    const limit = Math.max(1, Math.min(100, Math.floor(Number(o.limit) || 50)));
    const offset = Math.max(0, Math.floor(Number(o.offset) || 0));

    const list = sortBoard(bestPerUser(filterForBoard(this.store.db.scores, name, t), name), name);
    const rows = [];
    for (let i = offset; i < Math.min(list.length, offset + limit); i++) {
      rows.push(toRow(list[i], i + 1));
    }
    let me = null;
    if (o.userId) {
      const idx = list.findIndex((s) => s.userId === o.userId);
      if (idx >= 0) me = toRow(list[idx], idx + 1);
    }
    return {
      board: name,
      title: BOARDS[name].title,
      desc: BOARDS[name].desc,
      total: list.length,
      offset,
      limit,
      rows,
      me,
      boards: Object.keys(BOARDS).map((k) => ({ key: k, title: BOARDS[k].title, desc: BOARDS[k].desc })),
      updatedAt: t,
    };
  }

  /* 个人资料：账号信息 + 历史成绩 + 名次 */
  profile(user, now) {
    const t = now === undefined ? Date.now() : now;
    const hist = this.store.historyOf(user.id, 20).map((s, i) => toRow(s, i + 1));
    const best = this.store.bestOf(user.id);
    return {
      user: {
        id: user.id,
        name: user.name,
        createdAt: user.createdAt,
        best: user.best,
        runs: user.runs,
        wins: user.wins,
      },
      best: best ? toRow(best, null) : null,
      history: hist,
      ranks: {
        all: this.rankOf(user.id, 'all', t).rank,
        week: this.rankOf(user.id, 'week', t).rank,
        today: this.rankOf(user.id, 'today', t).rank,
        wins: this.rankOf(user.id, 'wins', t).rank,
      },
    };
  }
}

/* 淘汰策略：单账号历史留最近 N 条；全局总数超限时按时间丢最旧。
 * 之所以按时间而不是按分数丢：旧的成绩本来就会自然滑出周榜/日榜，
 * 保留近期数据更符合排行榜的展示需求。 */
function prune(db) {
  const perUser = new Map();
  for (const s of db.scores) {
    perUser.set(s.userId, (perUser.get(s.userId) || 0) + 1);
  }
  const overflow = new Set();
  for (const [uid, n] of perUser) {
    if (n > LIMITS.HISTORY_PER_USER) overflow.add(uid);
  }
  if (overflow.size) {
    const keepCount = new Map();
    const sortedDesc = db.scores.slice().sort((a, b) => b.at - a.at);
    const keep = new Set();
    for (const s of sortedDesc) {
      if (!overflow.has(s.userId)) { keep.add(s.id); continue; }
      const c = keepCount.get(s.userId) || 0;
      if (c < LIMITS.HISTORY_PER_USER) {
        keep.add(s.id);
        keepCount.set(s.userId, c + 1);
      }
    }
    db.scores = db.scores.filter((s) => keep.has(s.id));
  }
  if (db.scores.length > LIMITS.MAX_TOTAL_SCORES) {
    db.scores.sort((a, b) => b.at - a.at);
    db.scores = db.scores.slice(0, LIMITS.MAX_TOTAL_SCORES);
  }
}

module.exports = {
  Leaderboard, validateSubmission, normalizeSubmission, prune, toRow,
  filterForBoard, bestPerUser, sortBoard, LIMITS, BOARDS, REASONS, startOfToday,
};
