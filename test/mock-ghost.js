/*
 * MockServer + 幽灵录制/回放 的单元测试。
 *
 * 运行： node test/mock-ghost.js
 */
'use strict';

const path = require('path');

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

/* localStorage 内存实现 */
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    clear: () => m.clear(),
    _map: m,
  };
}

const M = require(path.join(__dirname, '..', 'src', 'mock-server.js'));
const G = require(path.join(__dirname, '..', 'src', 'ghost.js'));

M.setStorage(makeStorage());
M.clearAll();

/* ==================== 第一部分：MockServer ==================== */

section('=== 1. saveScore：排行榜保存与排序 ===');
M.clearAll();
M.saveScore('久留美', 5000);
M.saveScore('小金萌智子', 12000);
M.saveScore('芽吹', -300);
M.saveScore('红头', 0);

let board = M.getLeaderboard();
check('按 profit 降序排列', board.map((b) => b.profit).join(',') === '12000,5000,0,-300',
  board.map((b) => b.profit).join(','));
check('第 1 名是小金萌智子', board[0].name === '小金萌智子', board[0].name);
check('名次从 1 开始连续', board.map((b) => b.rank).join(',') === '1,2,3,4');
check('负数成绩也能保存', board[3].profit === -300, board[3].profit);
check('条目含 name/profit/at', board[0].name && typeof board[0].profit === 'number' &&
  typeof board[0].at === 'number');
check('不暴露内部去重字段 _id', !('_id' in board[0]));

section('=== 2. getLeaderboard：limit 与空态 ===');
check('limit=2 只返回 2 条', M.getLeaderboard(2).length === 2, M.getLeaderboard(2).length);
check('limit 超过总数时返回全部', M.getLeaderboard(999).length === 4);
M.clearAll();
check('清空后返回空数组', Array.isArray(M.getLeaderboard()) && M.getLeaderboard().length === 0);

section('=== 3. saveScore：同 id 去重 ===');
M.clearAll();
M.saveScore('久留美', 1000, { id: 'run-1' });
M.saveScore('久留美', 2000, { id: 'run-1' });
check('★ 同一 id 只留一条（覆盖）', M.getLeaderboard().length === 1, M.getLeaderboard().length);
check('★ 保留的是最后一次的值', M.getLeaderboard()[0].profit === 2000,
  M.getLeaderboard()[0].profit);

section('=== 4. saveScore：脏数据防御 ===');
M.clearAll();
M.saveScore('  带空格的  名字  ', 100);
M.saveScore('', 200);
M.saveScore(null, 300);
M.saveScore('超长名字'.repeat(20), 400);
M.saveScore('NaN收益', 'abc');
board = M.getLeaderboard();
check('昵称首尾空白被裁掉', board.some((b) => b.name === '带空格的  名字'));
check('空昵称回落到默认名', board.some((b) => b.name === M.NAME_DEFAULT), M.NAME_DEFAULT);
check('null 昵称也回落', board.filter((b) => b.name === M.NAME_DEFAULT).length >= 2);
check('超长昵称被截断', board.every((b) => b.name.length <= M.MAX_NAME),
  Math.max(...board.map((b) => b.name.length)));
check('非数字收益按 0 处理（不产生 NaN）',
  board.every((b) => Number.isFinite(b.profit)), JSON.stringify(board.map((b) => b.profit)));

section('=== 5. saveGhost / getGhost ===');
M.clearAll();
const tl = [
  { t: 0, act: 'open', pair: 'EUR/USD', side: 'long', price: 1.085, balance: 9900, equity: 10000 },
  { t: 30, act: 'close', pair: 'EUR/USD', side: 'long', price: 1.090, balance: 10500, equity: 10500 },
  { t: 60, act: 'open', pair: 'USD/JPY', side: 'short', price: 150.2, balance: 10500, equity: 10500 },
  { t: 90, act: 'close', pair: 'USD/JPY', side: 'short', price: 149.8, balance: 11200, equity: 11200 },
];
const mid = M.saveGhost('久留美', 1200, tl, { startEquity: 10000 });
check('saveGhost 返回 matchId 字符串', typeof mid === 'string' && mid.length > 0, mid);
check('matchId 含时间戳特征', /^[0-9a-z]+-[0-9a-z]{4}$/.test(mid), mid);

const got = M.getGhost(mid);
check('getGhost 能读回', !!got, got === null ? 'null' : 'ok');
check('昵称正确', got.name === '久留美', got.name);
check('最终收益正确', got.finalProfit === 1200, got.finalProfit);
check('开局资金正确', got.startEquity === 10000, got.startEquity);
check('时间轴节点数正确', got.timeline.length === 4, got.timeline.length);
check('节点字段完整', got.timeline[0].act === 'open' && got.timeline[0].side === 'long' &&
  got.timeline[0].price === 1.085, JSON.stringify(got.timeline[0]));
check('不存在的 matchId 返回 null', M.getGhost('not-exist') === null);
check('空 matchId 返回 null', M.getGhost('') === null && M.getGhost(null) === null);

section('=== 6. saveGhost：matchId 唯一性 ===');
const ids = new Set();
for (let i = 0; i < 50; i++) ids.add(M.saveGhost('测', 1, tl));
check('★ 连续 50 次生成互不重复的 matchId', ids.size === 50, ids.size);

section('=== 7. saveGhost：时间轴清洗 ===');
M.clearAll();
const dirtyTl = [
  { t: 10, act: 'open', pair: 'EUR/USD', side: 'long', price: 1.1, balance: 100, equity: 100 },
  { t: 5, act: 'close', pair: 'EUR/USD', side: 'long', price: 1.1, balance: 100, equity: 100 }, // 时间倒退
  { t: 20, act: 'unknown', pair: 'X', side: 'long', price: 1, balance: 1, equity: 1 },          // 非法动作
  { t: 30, act: 'close', pair: 'X', side: 'short', price: 1, balance: 1, equity: 1 },
  { t: 'abc', act: 'open', pair: 'X', side: 'long', price: 1, balance: 1, equity: 1 },          // 非法时间
  null,
  'garbage',
];
const mid2 = M.saveGhost('脏数据', 0, dirtyTl);
const g2 = M.getGhost(mid2);
check('★ 时间倒退的节点被丢弃', !g2.timeline.some((n) => n.t === 5), JSON.stringify(g2.timeline.map((n) => n.t)));
check('★ 非法动作被丢弃', !g2.timeline.some((n) => n.act === 'unknown'));
check('★ 非法时间被丢弃', !g2.timeline.some((n) => !Number.isFinite(n.t)));
check('★ 只保留 2 个合法节点', g2.timeline.length === 2, g2.timeline.length);
check('时间保持单调递增', g2.timeline[0].t <= g2.timeline[1].t);

section('=== 8. 体积与清理 ===');
M.clearAll();
const madeIds = [];
for (let i = 0; i < 5; i++) {
  /* 每次之间隔 1ms，让 createdAt 真正递增 —— 同一毫秒内批量创建时
   * 时间戳相同，排序只能靠 matchId 兜底，那测的就不是"时间倒序"了。 */
  const t0 = Date.now();
  while (Date.now() === t0) { /* 忙等 1ms，保证时间戳递增 */ }
  madeIds.push(M.saveGhost('玩家' + i, i * 100, tl));
}
check('listGhosts 返回 5 个', M.listGhosts().length === 5, M.listGhosts().length);
check('★ 最后一次保存的排最前（按时间倒序）', M.listGhosts()[0].name === '玩家4',
  M.listGhosts()[0].name);
check('★ createdAt 严格递减', M.listGhosts().every((g, i, arr) =>
  i === 0 || arr[i - 1].createdAt >= g.createdAt),
  M.listGhosts().map((g) => g.createdAt).join(','));
const del = M.deleteGhost(M.listGhosts()[0].matchId);
check('deleteGhost 成功', del.ok === true);
check('删除后剩 4 个', M.listGhosts().length === 4);
check('删除的正是那一个', !M.listGhosts().some((g) => g.name === '玩家4'));
const u = M.usage();
check('usage 返回体积信息', typeof u.kb === 'number' && typeof u.ghosts === 'number', JSON.stringify(u));

section('=== 9. 数据损坏容错 ===');
const corrupt = makeStorage();
corrupt.setItem(M.KEY_BOARD, '{{{ 不是 JSON');
corrupt.setItem(M.KEY_GHOSTS, 'not json either');
M.setStorage(corrupt);
let threw = null;
try {
  const b = M.getLeaderboard();
  const gg = M.getGhost('x');
  check('★ 排行榜 JSON 损坏时返回空数组（不抛错）', Array.isArray(b) && b.length === 0);
  check('★ 幽灵 JSON 损坏时返回 null（不抛错）', gg === null);
  const saved = M.saveScore('修复后', 999);
  check('★ 损坏后仍能写入新数据', saved.ok === true && M.getLeaderboard().length === 1);
} catch (e) { threw = e; }
check('★ 全程未抛异常', !threw, threw && threw.message);

M.setStorage(makeStorage());
M.clearAll();

/* ==================== 第二部分：录制器 ==================== */

section('=== 10. 录制器：捕获开仓与平仓 ===');
M.clearAll();

/* 造一个最小的假 FX，形状与真实游戏一致 */
function makeFakeFX() {
  const fx = {
    state: {
      balance: 10000, locked: 0, positions: [], tickCount: 0, logs: [],
      seq: 0,
    },
    books: {
      'EUR/USD': { price: 1.0850 },
      'USD/JPY': { price: 150.20 },
    },
    totalEquity() {
      let float = 0;
      this.state.positions.forEach((p) => {
        const price = this.books[p.pair].price;
        const diff = p.side === 'long' ? price - p.entry : p.entry - price;
        float += (diff / p.entry) * p.notional;
      });
      return this.state.balance + this.state.locked + float;
    },
    /* 模拟游戏开仓 */
    open(pair, side, margin, lev, price) {
      const notional = margin * lev;
      this.state.balance -= margin;
      this.state.locked += margin;
      this.state.seq++;
      this.books[pair].price = price;
      this.state.positions.push({
        id: this.state.seq, pair, side, margin, lev, notional,
        entry: price, fee: 0, openTick: this.state.tickCount,
      });
      return this.state.positions[this.state.positions.length - 1];
    },
    /* 模拟游戏平仓（含写日志，与真实 settlePosition 一致） */
    close(id) {
      const i = this.state.positions.findIndex((p) => p.id === id);
      if (i < 0) return null;
      const p = this.state.positions[i];
      const price = this.books[p.pair].price;
      const diff = p.side === 'long' ? price - p.entry : p.entry - price;
      const pnl = (diff / p.entry) * p.notional;
      this.state.positions.splice(i, 1);
      this.state.locked -= p.margin;
      this.state.balance += p.margin + pnl;
      const sign = pnl >= 0 ? '+' : '-';
      this.state.logs.unshift({
        t: '12:00:00',
        text: '平仓 ' + p.pair + ' ' + (p.side === 'long' ? '多' : '空') + ' ' + p.lev +
          'x · 保证金 $' + p.margin + ' · 盈亏 ' + sign + '$' + Math.abs(pnl).toFixed(2),
      });
      return pnl;
    },
    tick(n) { this.state.tickCount += (n || 1); },
  };
  return fx;
}

const fx = makeFakeFX();
const rec = G.createRecorder(fx, { pollMs: 1000 });   // 手动采样，不靠定时器

rec.start();
check('录制器已启动', rec.isActive() === true);

/* t=0 开多 */
fx.tick(0);
const p1 = fx.open('EUR/USD', 'long', 500, 20, 1.0850);
rec.sampleOnce();

/* t=15s（10 tick）平仓盈利 */
fx.tick(10);
fx.books['EUR/USD'].price = 1.0900;
fx.close(p1.id);
rec.sampleOnce();

/* t=30s 开空 */
fx.tick(10);
fx.open('USD/JPY', 'short', 400, 25, 150.20);
rec.sampleOnce();

let tl2 = rec.timeline();
check('★ 记录了 3 个节点（开/平/开）', tl2.length === 3, tl2.length);
check('第 1 个是开仓', tl2[0].act === 'open' && tl2[0].side === 'long', JSON.stringify(tl2[0]));
check('第 1 个节点时间 t=0', tl2[0].t === 0, tl2[0].t);
check('第 2 个是平仓', tl2[1].act === 'close', tl2[1].act);
check('★ 平仓时间 t=15 秒（10 tick × 1.5s）', tl2[1].t === 15, tl2[1].t);
check('开仓价取自持仓 entry', tl2[0].price === 1.085, tl2[0].price);
check('记录含 balance 与 equity', typeof tl2[0].balance === 'number' &&
  typeof tl2[0].equity === 'number', JSON.stringify(tl2[0]));
check('第 3 个节点 t=30 秒', tl2[2].t === 30, tl2[2].t);

section('=== 11. 录制器：初始持仓不误记开仓 ===');
const fx2 = makeFakeFX();
fx2.state.positions.push({
  id: 99, pair: 'EUR/USD', side: 'short', margin: 300, lev: 10,
  notional: 3000, entry: 1.08, fee: 0, openTick: 0,
});
const rec2 = G.createRecorder(fx2, { pollMs: 1000 });
rec2.start();
rec2.sampleOnce();
check('★ 开局已有的持仓不被记为"开仓动作"', rec2.timeline().length === 0,
  rec2.timeline().length);

section('=== 12. 录制器：stats 与 stop ===');
const st = rec.stats();
check('stats 含 nodes/seconds/profit', typeof st.nodes === 'number' &&
  typeof st.seconds === 'number' && typeof st.profit === 'number', JSON.stringify(st));
check('已记录 3 个节点', st.nodes === 3, st.nodes);
const finalTl = rec.stop();
check('stop 返回时间轴', Array.isArray(finalTl) && finalTl.length === 3);
check('stop 后不再 active', rec.isActive() === false);

/* ==================== 第三部分：回放器 ==================== */

section('=== 13. 回放器：节点触发与资产插值 ===');

/* 用前面保存的幽灵 */
M.clearAll();
const playTl = [
  { t: 0, act: 'open', pair: 'EUR/USD', side: 'long', price: 1.085, balance: 10000, equity: 10000 },
  { t: 20, act: 'close', pair: 'EUR/USD', side: 'long', price: 1.09, balance: 11000, equity: 11000 },
  { t: 40, act: 'open', pair: 'USD/JPY', side: 'short', price: 150.2, balance: 11000, equity: 11000 },
  { t: 60, act: 'close', pair: 'USD/JPY', side: 'short', price: 149.8, balance: 10800, equity: 10800 },
];
const playId = M.saveGhost('久留美', 800, playTl, { startEquity: 10000 });
const ghostData = M.getGhost(playId);

const playerFx = makeFakeFX();     // 玩家当前权益 = 10000
const rp = G.createReplay(ghostData, playerFx);

check('回放器读到 4 个节点', rp.totalNodes === 4, rp.totalNodes);
check('开局幽灵资产 = 起始权益', rp.ghostEquityAt(0) === 10000, rp.ghostEquityAt(0));

/* 推进到 t=0，应触发第 1 个节点 */
let fired = rp.advance(0);
check('t=0 触发 1 个节点', fired.length === 1, fired.length);
check('触发的是开仓', fired[0].act === 'open');

/* t=10（两节点之间）：幽灵资产应在 10000~11000 之间插值 */
const mid10 = rp.ghostEquityAt(10);
check('★ 节点之间做线性插值（10000 < x < 11000）', mid10 > 10000 && mid10 < 11000, mid10);
check('★ t=10 插值 = 10500', Math.abs(mid10 - 10500) < 0.01, mid10);

/* 推进到 t=20 */
fired = rp.advance(20);
check('t=20 触发平仓', fired.length === 1 && fired[0].act === 'close');

/* 一次跨越多个节点 */
fired = rp.advance(60);
check('★ 一次推进跨越 2 个节点（t=40 与 t=60）', fired.length === 2, fired.length);

check('全部节点已走完', rp.finished() === true);
check('已触发事件记录 4 条', rp.events().length === 4, rp.events().length);

section('=== 14. 回放器：玩家 vs 幽灵对比 ===');
const cmp = rp.compare(20);
check('对比含 player/ghost/diff', typeof cmp.player === 'number' &&
  typeof cmp.ghost === 'number' && typeof cmp.diff === 'number', JSON.stringify(cmp));
check('玩家权益 10000', cmp.player === 10000, cmp.player);
check('幽灵权益 11000', cmp.ghost === 11000, cmp.ghost);
check('★ 差值 = 玩家 − 幽灵 = −1000', cmp.diff === -1000, cmp.diff);

section('=== 15. 回放器：胜负判定 ===');
/* 玩家赚 0，幽灵赚 800 → 幽灵胜 */
let v = rp.verdict();
check('★ 玩家收益 0 / 幽灵收益 800', v.playerProfit === 0 && v.ghostProfit === 800,
  JSON.stringify(v));
check('★ 判定为幽灵胜', v.win === false && v.tie === false, JSON.stringify(v));
check('差值 = −800', v.diff === -800, v.diff);
check('结果含幽灵名字', v.ghostName === '久留美', v.ghostName);

/* 玩家赚 2000 → 玩家胜 */
playerFx.state.balance = 12000;
v = rp.verdict();
check('★ 玩家赚 2000 > 幽灵 800 → 玩家胜', v.win === true, JSON.stringify(v));

/* 打平 */
playerFx.state.balance = 10800;
v = rp.verdict();
check('★ 收益相同时判定为平局', v.tie === true && v.win === false, JSON.stringify(v));

section('=== 16. 回放器：动作转人话 ===');
const desc1 = rp.describeNode({ act: 'open', pair: 'EUR/USD', side: 'long' });
check('开仓描述含"买入"与"多头"', /买入/.test(desc1) && /多头/.test(desc1), desc1);
const desc2 = rp.describeNode({ act: 'close', pair: 'USD/JPY', side: 'short' });
check('平仓描述含"平掉"与"空头"', /平掉/.test(desc2) && /空头/.test(desc2), desc2);
check('描述里带幽灵名字', desc1.indexOf('久留美') >= 0, desc1);

section('=== 17. URL 解析与链接生成 ===');
check('解析 #ghost=abc123', G.parseGhostFromHash('#ghost=abc123') === 'abc123',
  G.parseGhostFromHash('#ghost=abc123'));
check('解析 #/ghost=abc123', G.parseGhostFromHash('#/ghost=abc123') === 'abc123',
  G.parseGhostFromHash('#/ghost=abc123'));
check('带其他参数也能解析', G.parseGhostFromHash('#ghost=abc&foo=1') === 'abc',
  G.parseGhostFromHash('#ghost=abc&foo=1'));
check('URL 编码正确解码', G.parseGhostFromHash('#ghost=a%20b') === 'a b',
  G.parseGhostFromHash('#ghost=a%20b'));
check('无 ghost 参数返回 null', G.parseGhostFromHash('#other=1') === null);
check('空 hash 返回 null', G.parseGhostFromHash('') === null);
check('undefined 返回 null', G.parseGhostFromHash(undefined) === null);

section('=== 18. 边界：空时间轴 ===');
M.clearAll();
const emptyId = M.saveGhost('空手', 0, []);
const emptyGhost = M.getGhost(emptyId);
const rpEmpty = G.createReplay(emptyGhost, playerFx);
check('空时间轴不崩', rpEmpty.totalNodes === 0);
check('空时间轴 advance 返回空', rpEmpty.advance(100).length === 0);
check('空时间轴资产 = 起始权益', rpEmpty.ghostEquityAt(50) === 10000,
  rpEmpty.ghostEquityAt(50));
check('空时间轴 compare 不崩', typeof rpEmpty.compare(10).player === 'number');
check('empty 也立即 finished', rpEmpty.finished() === true);

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);
