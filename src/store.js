/*
 * 数据持久化层：零外部依赖，单文件 JSON 库。
 *
 * 为什么不用 SQLite / 外部数据库：
 *   1) 目标是一键启动、随时丢到任意云主机 —— 不需要用户装任何东西；
 *   2) 排行榜的数据量级（几千个玩家、几万条成绩）用 JSON 完全够；
 *   3) 写入走"临时文件 + rename"的原子替换，进程被 kill 也不会留下半截文件。
 *
 * 结构：
 *   { version, users: { id: {...} }, scores: [ {...} ], meta: { seq } }
 *
 * 所有写操作都过 mutate()，它负责：串行化 + 防抖落盘 + 原子替换 + 进程退出兜底。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_VERSION = 2;

/* 云存档默认值：新账号与"老账号迁移"都落到这两个常量上。
 * 10000 与游戏内的 START_EQUITY 一致，免得登录后余额和单机首局不一样。 */
const DEFAULT_BALANCE = 10000;
/* 单个账号最多允许存多少个持仓：游戏里同屏几十个仓位已经到极限，
 * 这里设 50 是为了挡住恶意构造的超大数组（每次同步都要落盘）。 */
const MAX_POSITIONS = 50;
/* 余额上限：与排行榜的合理上限同量级，挡住 "1e30" 这类脏值。 */
const MAX_BALANCE = 1e13;

function emptyDB() {
  return { version: DATA_VERSION, meta: { seq: 0, winKeys: {} }, users: {}, scores: [] };
}

/* 从任何输入里取出一个安全的正数（防脏数据把统计搞成 NaN） */
function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
}

/* 归一化一条成绩记录：老存档缺字段时补齐，避免读取方到处写防御代码 */
function normScore(s) {
  if (!s || typeof s !== 'object') return null;
  const userId = String(s.userId || '');
  if (!userId) return null;
  return {
    id: String(s.id || crypto.randomUUID()),
    userId,
    name: String(s.name || '玩家').slice(0, 24),
    score: num(s.score),
    peak: num(s.peak),
    startEquity: num(s.startEquity),
    target: num(s.target, 20000000),
    won: !!s.won,
    at: num(s.at, Date.now()),
    tickCount: num(s.tickCount),
    trades: num(s.trades),
    candles: num(s.candles),
    cards: num(s.cards),
    assets: num(s.assets),
    cycles: num(s.cycles),
    mode: String(s.mode || 'sim'),
    durationMs: num(s.durationMs),
    reason: String(s.reason || 'settle'),
  };
}

/* 归一化单个持仓。持仓数据完全来自客户端，属于**不可信输入**，
 * 所以每个字段都要重新夹到合法范围，不能直接存。
 * 只保留云存档真正需要的字段：游戏恢复时用这些就够重建一个仓位。 */
function normPosition(p) {
  if (!p || typeof p !== 'object') return null;
  const side = p.side === 'short' ? 'short' : 'long';
  const margin = num(p.margin);
  const lev = num(p.lev);
  const entry = num(p.entry);
  /* 关键字段缺失/非正数的仓位没有恢复意义，直接丢弃。
   * 宁可少恢复一个仓位，也不要写进一个会导致游戏崩溃的空壳。 */
  if (!(margin > 0) || !(lev > 0) || !(entry > 0)) return null;
  return {
    id: Math.floor(num(p.id, 0)),
    pair: String(p.pair || 'EUR/USD').slice(0, 16),
    side,
    margin: Math.round(margin * 100) / 100,
    lev,
    notional: Math.round(num(p.notional) * 100) / 100,
    entry,
    fee: Math.round(num(p.fee) * 100) / 100,
    openTs: Math.floor(num(p.openTs, Date.now())),
    openTick: Math.floor(num(p.openTick, 0)),
  };
}

/* 归一化持仓数组：去空、限长。 */
function normPositions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const p of list) {
    if (out.length >= MAX_POSITIONS) break;
    const np = normPosition(p);
    if (np) out.push(np);
  }
  return out;
}

function normUser(u) {
  if (!u || typeof u !== 'object') return null;
  /* ★ 云存档字段的**向后兼容迁移**就靠这里。
   *   线上已有一批账号是没有 balance/positions 的（那次重构之前注册的）。
   *   如果这里不给默认值，读档后这两个字段是 undefined，
   *   前端拿到 undefined 会把游戏资金弄坏，甚至让 /api/account/state 抛错。
   *   所以在归一化阶段一律补齐：
   *     balance    缺失 → 10000（游戏初始资金）
   *     positions  缺失 → []
   *     lastSyncAt 缺失 → 0（表示"从未同步过"，前端据此判断用不用覆盖） */
  const balanceRaw = u.balance;
  const balance = (balanceRaw === undefined || balanceRaw === null || !Number.isFinite(Number(balanceRaw)))
    ? DEFAULT_BALANCE
    : Math.max(0, Math.min(MAX_BALANCE, Number(balanceRaw)));
  return {
    id: String(u.id || ''),
    name: String(u.name || '玩家'),
    nameLower: String(u.nameLower || '').toLowerCase(),
    salt: String(u.salt || ''),
    hash: String(u.hash || ''),
    createdAt: num(u.createdAt, Date.now()),
    lastSeen: num(u.lastSeen, Date.now()),
    best: num(u.best),
    runs: num(u.runs),
    wins: num(u.wins),
    banned: !!u.banned,
    /* ---------- 云存档 ---------- */
    balance,
    positions: normPositions(u.positions),
    lastSyncAt: num(u.lastSyncAt, 0),
    /* lastClientTs：上次**被接受**的客户端时间戳。
     * 单独存它是因为单调性比较必须在同一个时钟域里做 ——
     * 拿客户端的 clientTs 去比服务端的 lastSyncAt 会因两端时钟差
     * 把正常的幂等重试误判成"过旧"（实测踩过）。 */
    lastClientTs: num(u.lastClientTs, 0),
  };
}

class Store {
  constructor(file) {
    this.file = file;
    this.tmp = file + '.tmp';
    this.db = emptyDB();
    this._dirty = false;
    this._timer = null;
    this._writing = false;
    this._pendingWrite = false;
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.file)) {
        const raw = fs.readFileSync(this.file, 'utf8');
        const parsed = JSON.parse(raw);
        this.db = this._normalize(parsed);
        /* ★ 迁移后立刻回写磁盘。
         *   目的：让"磁盘上的结构"和"内存里的结构"始终一致。
         *   如果只在内存里补默认值而不回写，会留下两个隐患：
         *     1) 运维用文本工具看数据文件时，看到的是缺字段的旧结构，
         *        容易误判"迁移没生效"；
         *     2) 某些只读外部文件的分析脚本会拿到不一致的数据。
         *   用 _needsPersist 标记"结构被升级过"，避免每次启动都白写一次盘。 */
        if (this._needsPersist) {
          this._needsPersist = false;
          this._dirty = true;
          this.flush();
        }
        return true;
      }
    } catch (e) {
      // 数据损坏时不要静默丢档：改名留底，让用户有机会人工抢救
      const bak = this.file + '.corrupt-' + Date.now();
      try {
        fs.renameSync(this.file, bak);
        console.error('[store] 数据文件损坏，已备份到 ' + bak + '：' + e.message);
      } catch (_) {
        console.error('[store] 数据文件损坏且无法备份：' + e.message);
      }
    }
    this.db = emptyDB();
    return false;
  }

  /* 读入时做一次全量归一化：外部文件可能是手工编辑过的、旧版本写的、甚至被改坏的 */
  _normalize(raw) {
    const db = emptyDB();
    if (!raw || typeof raw !== 'object') return db;
    this._needsPersist = false;

    /* 版本升级 → 需要回写磁盘 */
    if (Number(raw.version) !== DATA_VERSION) this._needsPersist = true;

    db.meta.seq = num(raw.meta && raw.meta.seq, 0);
    /* winKeys 是"这一局是否已计入通关次数"的去重表，必须一起还原 ——
     * 漏掉它会让重启后的通关重复计数。老文件没有这个字段时补空对象。 */
    if (raw.meta && raw.meta.winKeys && typeof raw.meta.winKeys === 'object') {
      db.meta.winKeys = Object.assign({}, raw.meta.winKeys);
    }
    const users = raw.users && typeof raw.users === 'object' ? raw.users : {};
    for (const k of Object.keys(users)) {
      const src = users[k];
      /* 检测"这个账号是否缺少云存档字段"：缺了就要回写，让磁盘也补齐。
       * 这是题目要求的"线上已有数据"迁移路径。 */
      if (src && typeof src === 'object' &&
          (src.balance === undefined || src.positions === undefined ||
           src.lastSyncAt === undefined)) {
        this._needsPersist = true;
      }
      const u = normUser(src);
      if (u && u.id) db.users[u.id] = u;
    }
    const scores = Array.isArray(raw.scores) ? raw.scores : [];
    db.scores = scores.map(normScore).filter(Boolean);
    return db;
  }

  /* 唯一的写入入口：mutator 直接改 this.db，改完由这里决定何时落盘。
   *
   * opts.sync = true  → 立刻同步落盘（不等防抖）。
   *
   * 为什么需要这个开关：默认的 120ms 防抖对高频内部更新很合适，但对
   * 「注册」「提交成绩」这类**不可再生**的数据不够安全 ——
   * 一旦进程在这 120ms 内被强杀（Windows 上 child.kill() 是直接终止，
   * 不会走 SIGTERM 的优雅收尾），这些写入就永久丢了。
   * 实测就是这么丢掉过的：注册完立刻 kill，账号整个消失。
   * 所以关键写入走同步，其余继续走防抖。 */
  mutate(fn, opts) {
    const out = fn(this.db);
    this._dirty = true;
    if (opts && opts.sync) {
      if (this._timer) {
        clearTimeout(this._timer);
        this._timer = null;
      }
      this.flush();
    } else {
      this.scheduleFlush();
    }
    return out;
  }

  /* 防抖 120ms：排行榜写入很频繁（每局一条），但没必要每条都同步落盘 */
  scheduleFlush() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.flush();
    }, 120);
  }

  /* 原子落盘：先写 .tmp，再 rename 覆盖。rename 在同一文件系统内是原子的，
   * 所以最坏情况是"旧内容"或"新内容"，绝不会出现半截 JSON。 */
  flush() {
    if (!this._dirty) return;
    if (this._writing) {
      this._pendingWrite = true;
      return;
    }
    this._writing = true;
    this._pendingWrite = false;
    this._dirty = false;
    const payload = JSON.stringify(this.db);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.tmp, payload, 'utf8');
      fs.renameSync(this.tmp, this.file);
    } catch (e) {
      // 写失败要把 dirty 放回去，不然这次改动就永久丢了
      this._dirty = true;
      console.error('[store] 落盘失败：' + e.message);
    } finally {
      this._writing = false;
    }
    if (this._pendingWrite || this._dirty) this.scheduleFlush();
  }

  /* 进程退出前的兜底：把还没落盘的改动同步写完，并清掉定时器。
   *
   * ★ 这里**只在真有改动时**才写（`if (this._dirty)`）。
   *   早期版本无条件 `this._dirty = true; this.flush();`，看起来"更保险"，
   *   实际上是个破坏性行为：进程只要退出，哪怕一个字节都没改，也会把
   *   内存里的状态原样盖回磁盘。于是任何**外部对数据文件的修改**
   *   （手工修库、从备份恢复、运维脚本订正）都会在下一次部署/重启时
   *   被静默回滚 —— 线上真踩过：把备份盖进卷里，紧接着 redeploy，
   *   文件当场被空库覆盖，看起来像"数据又丢了"。
   *
   *   语义上也不该写：没有改动就没有"最后一点改动"要保存。
   *   定时器里待写的改动由 `scheduleFlush` 负责，`flush()` 自己会检查 dirty。 */
  close() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._dirty) this.flush();
  }

  /* ---------- 便捷查询 ---------- */

  userById(id) {
    return this.db.users[id] || null;
  }

  userByName(name) {
    const lower = String(name || '').trim().toLowerCase();
    if (!lower) return null;
    for (const id of Object.keys(this.db.users)) {
      if (this.db.users[id].nameLower === lower) return this.db.users[id];
    }
    return null;
  }

  /* 玩家个人最好的一条成绩（用于个人面板） */
  bestOf(userId) {
    let best = null;
    for (const s of this.db.scores) {
      if (s.userId !== userId) continue;
      if (!best || s.score > best.score) best = s;
    }
    return best;
  }

  historyOf(userId, limit) {
    const list = this.db.scores.filter((s) => s.userId === userId).sort((a, b) => b.at - a.at);
    return limit ? list.slice(0, limit) : list;
  }

  /* ---------- 云存档 ---------- */

  /* 读某个玩家的存档。用户对象在 _normalize / register 时已经补齐过字段，
   * 这里再兜一层，保证返回给前端的结构永远完整（前端不必写防御代码）。 */
  accountOf(userId) {
    const u = this.userById(userId);
    if (!u) return null;
    return {
      balance: Number.isFinite(Number(u.balance)) ? Number(u.balance) : DEFAULT_BALANCE,
      positions: Array.isArray(u.positions) ? u.positions : [],
      lastSyncAt: Number(u.lastSyncAt) || 0,
      lastClientTs: Number(u.lastClientTs) || 0,
    };
  }

  /* 写存档。调用方（server.js）已经做过鉴权与业务校验，
   * 这里只负责"归一化 + 落盘"，用 sync 保证不丢。
   * 返回写入后的最终值（已归一化），供接口回显。
   *
   * clientTs 单独存进 lastClientTs：它是**客户端时钟**的时间，
   * 只用于下一次单调性比较，不要和 lastSyncAt（服务端时钟）混用。 */
  saveAccount(userId, balance, positions, now, clientTs) {
    return this.mutate(() => {
      const u = this.userById(userId);
      if (!u) return null;
      const b = Number(balance);
      u.balance = Number.isFinite(b) ? Math.max(0, Math.min(MAX_BALANCE, b)) : DEFAULT_BALANCE;
      u.positions = normPositions(positions);
      u.lastSyncAt = now === undefined ? Date.now() : now;
      const ct = Number(clientTs);
      if (Number.isFinite(ct) && ct > 0) u.lastClientTs = ct;
      return {
        balance: u.balance, positions: u.positions,
        lastSyncAt: u.lastSyncAt, lastClientTs: u.lastClientTs,
      };
    }, { sync: true });
  }

  /* 重置存档：余额回到 10000、持仓清空。
   * 同时把 lastClientTs 归零 —— 重置之后玩家会用新的时间戳继续同步，
   * 若不清零，任何"比重置前更旧"的时间戳都会被误判成 stale。 */
  resetAccount(userId, now) {
    return this.mutate(() => {
      const u = this.userById(userId);
      if (!u) return null;
      u.balance = DEFAULT_BALANCE;
      u.positions = [];
      u.lastSyncAt = now === undefined ? Date.now() : now;
      u.lastClientTs = 0;
      return {
        balance: u.balance, positions: u.positions,
        lastSyncAt: u.lastSyncAt, lastClientTs: 0,
      };
    }, { sync: true });
  }
}

module.exports = {
  Store, emptyDB, normScore, normUser, normPosition, normPositions, DATA_VERSION,
  DEFAULT_BALANCE, MAX_POSITIONS, MAX_BALANCE,
};
