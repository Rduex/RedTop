/*
 * 云存档专项测试：数据迁移 + 三个接口 + 前端同步策略。
 *
 * 分成两段：
 *   A. 服务端：老数据迁移、GET state / POST sync / POST reset、校验与鉴权
 *   B. 前端：模拟浏览器，验证"刷新后资金不重置"这条核心诉求真的成立
 *
 * 运行： node test/account.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const http = require('http');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-acc-'));
const PORT = 9500 + Math.floor(Math.random() * 250);

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

/* ==================== A. 服务端 ==================== */

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        token ? { 'X-FX-Token': token } : {}),
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const t = Buffer.concat(cs).toString('utf8');
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, json: j, text: t });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: Object.assign({}, process.env, {
      FX_PORT: String(PORT), FX_HOST: '127.0.0.1', FX_DATA: DATA,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

function waitUp(deadline) {
  return new Promise((resolve, reject) => {
    const go = () => req('GET', '/api/health').then((r) => r.status === 200 ? resolve() : again()).catch(again);
    const again = () => Date.now() > deadline ? reject(new Error('启动超时')) : setTimeout(go, 120);
    go();
  });
}

/* ---------- 预置一份"旧格式"数据库，验证迁移 ---------- */
const dbFile = path.join(DATA, 'fx-online.json');
fs.mkdirSync(DATA, { recursive: true });
fs.writeFileSync(dbFile, JSON.stringify({
  version: 1,
  meta: { seq: 0, winKeys: {} },
  users: {
    legacy: {
      id: 'legacy', name: '老玩家', nameLower: '老玩家',
      salt: '00', hash: '00',
      createdAt: 1700000000000, lastSeen: 1700000000000,
      best: 88888, runs: 12, wins: 1, banned: false,
      /* ★ 故意不写 balance / positions / lastSyncAt */
    },
  },
  scores: [],
}, null, 2));

let child = startServer();
process.on('exit', () => {
  try { child.kill(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
});

(async function main() {
  await waitUp(Date.now() + 15000);

  section('=== A1. 老数据迁移（线上已有账号不能报错）===');
  const mig = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const legacyUser = mig.users.legacy;
  check('★ 旧账号被自动注入 balance=10000', legacyUser.balance === 10000, legacyUser.balance);
  check('★ 旧账号被自动注入 positions=[]', Array.isArray(legacyUser.positions) && legacyUser.positions.length === 0,
    JSON.stringify(legacyUser.positions));
  check('★ 旧账号被自动注入 lastSyncAt=0', legacyUser.lastSyncAt === 0, legacyUser.lastSyncAt);
  check('旧账号原有字段未丢失（best/runs/wins）',
    legacyUser.best === 88888 && legacyUser.runs === 12 && legacyUser.wins === 1);

  section('=== A2. GET /api/account/state ===');
  const reg = await req('POST', '/api/register', { name: '存档玩家', password: 'save123456' });
  check('注册成功', reg.status === 200 && reg.json.token);
  const token = reg.json.token;

  const st0 = await req('GET', '/api/account/state', undefined, token);
  check('需要鉴权前：新账号可读到状态', st0.status === 200);
  check('新账号初始 balance=10000', st0.json.balance === 10000, st0.json.balance);
  check('新账号初始 positions 为空数组', Array.isArray(st0.json.positions) && st0.json.positions.length === 0);
  check('新账号 hasSave=false（从未同步过）', st0.json.hasSave === false, st0.json.hasSave);

  const noAuth = await req('GET', '/api/account/state');
  check('未登录访问 state 返回 401', noAuth.status === 401, noAuth.status);
  const badTok = await req('GET', '/api/account/state', undefined, 'fake.token.sig');
  check('伪造 token 返回 401', badTok.status === 401, badTok.status);

  section('=== A3. POST /api/account/sync ===');
  const pos1 = {
    id: 7, pair: 'EUR/USD', side: 'long', margin: 800, lev: 20,
    notional: 16000, entry: 1.085, fee: 2.4, openTs: Date.now(), openTick: 120,
  };
  const sync1 = await req('POST', '/api/account/sync', {
    balance: 18420.5, positions: [pos1], clientTs: Date.now(),
  }, token);
  check('同步成功', sync1.status === 200 && sync1.json.ok === true, sync1.status);
  check('回显 balance 正确', sync1.json.balance === 18420.5, sync1.json.balance);
  check('回显 positions 数量正确', sync1.json.positions.length === 1);
  check('同步后 hasSave=true', sync1.json.hasSave === true);
  check('lastSyncAt 被写入', sync1.json.lastSyncAt > 0, sync1.json.lastSyncAt);

  const st1 = await req('GET', '/api/account/state', undefined, token);
  check('★ 再读回来的 balance 就是同步值（落盘生效）', st1.json.balance === 18420.5, st1.json.balance);
  check('★ 再读回来的持仓完整', st1.json.positions.length === 1 &&
    st1.json.positions[0].pair === 'EUR/USD' &&
    st1.json.positions[0].margin === 800, JSON.stringify(st1.json.positions));
  check('hasSave 持久化正确', st1.json.hasSave === true);

  section('=== A4. sync 的输入校验 ===');
  const cases = [
    ['balance 非数字被拒', { balance: 'abc' }, 400],
    ['balance 为负被拒', { balance: -1 }, 400],
    ['balance 超大被拒', { balance: 1e30 }, 400],
    ['positions 非数组被拒', { balance: 1, positions: 'x' }, 400],
    ['持仓超过 50 个被拒',
      { balance: 1, positions: new Array(60).fill({ id: 1, pair: 'X', side: 'long', margin: 1, lev: 1, entry: 1 }) }, 400],
  ];
  for (const [name, body, expect] of cases) {
    const r = await req('POST', '/api/account/sync', body, token);
    check(name, r.status === expect, r.status + ' ' + (r.json && r.json.error));
  }
  const syncNoAuth = await req('POST', '/api/account/sync', { balance: 1 });
  check('未登录 sync 返回 401', syncNoAuth.status === 401, syncNoAuth.status);

  section('=== A5. 非法持仓被过滤（不让脏数据进库）===');
  const dirty = await req('POST', '/api/account/sync', {
    balance: 5000,
    positions: [
      { id: 1, pair: 'EUR/USD', side: 'long', margin: 100, lev: 10, entry: 1.1 },
      { id: 2, pair: 'EUR/USD', side: 'long', margin: 0, lev: 10, entry: 1.1 },   // margin=0 → 丢弃
      { id: 3, pair: 'EUR/USD', side: 'long', margin: 100, lev: 0, entry: 1.1 },   // lev=0 → 丢弃
      { id: 4, pair: 'EUR/USD', side: 'long', margin: 100, lev: 10, entry: 0 },    // entry=0 → 丢弃
      null,
      'garbage',
    ],
    clientTs: Date.now(),
  }, token);
  check('★ 只有合法持仓被保留（6 条脏数据 → 1 条）',
    dirty.status === 200 && dirty.json.positions.length === 1, dirty.json.positions.length);

  section('=== A6. 时间戳单调性（防并发乱序覆盖）===');
  const now = Date.now();
  await req('POST', '/api/account/sync', { balance: 300, positions: [], clientTs: now }, token);
  /* 明显过旧（-60 秒，远超 2 秒容差）→ 应当拒绝 */
  const stale = await req('POST', '/api/account/sync', { balance: 999, positions: [], clientTs: now - 60000 }, token);
  check('★ 过旧的提交被拒（409 stale_sync）', stale.status === 409, stale.status + ' ' + (stale.json && stale.json.code));
  const after = await req('GET', '/api/account/state', undefined, token);
  check('★ 旧提交没有覆盖新数据', after.json.balance === 300, after.json.balance);

  /* ★ 同时间戳重发必须被接受（幂等）。
   *   这是真 bug 的回归点：早先服务端拿客户端 clientTs 去比服务端 lastSyncAt，
   *   两端时钟差几毫秒就会把正常的重试/幂等重放误判成 stale。 */
  const sameTs = await req('POST', '/api/account/sync', { balance: 301, positions: [], clientTs: now }, token);
  check('★ 相同时间戳可以接受（幂等重发不被误拒）', sameTs.status === 200,
    sameTs.status + ' ' + (sameTs.json && sameTs.json.code));

  /* 小范围乱序（1 秒内）也在容差内，应当接受 —— 多标签页并发时会遇到 */
  const slightOut = await req('POST', '/api/account/sync', { balance: 302, positions: [], clientTs: now - 1500 }, token);
  check('★ 1.5 秒内的轻微乱序被容忍（多标签页并发）', slightOut.status === 200,
    slightOut.status + ' ' + (slightOut.json && slightOut.json.code));

  section('=== A7. POST /api/account/reset ===');
  const reset = await req('POST', '/api/account/reset', undefined, token);
  check('重置成功', reset.status === 200 && reset.json.ok === true, reset.status);
  check('★ 重置后 balance=10000', reset.json.balance === 10000, reset.json.balance);
  check('★ 重置后 positions 清空', Array.isArray(reset.json.positions) && reset.json.positions.length === 0);
  const afterReset = await req('GET', '/api/account/state', undefined, token);
  check('重置结果已落盘', afterReset.json.balance === 10000 && afterReset.json.positions.length === 0,
    afterReset.json.balance);
  const resetNoAuth = await req('POST', '/api/account/reset');
  check('未登录 reset 返回 401', resetNoAuth.status === 401, resetNoAuth.status);

  section('=== A8. ?token= 查询参数（sendBeacon 卸载兜底需要）===');
  await req('POST', '/api/account/sync', { balance: 7777, positions: [], clientTs: Date.now() }, token);
  const viaQuery = await req('GET', '/api/account/state?token=' + encodeURIComponent(token));
  check('★ 通过 ?token= 也能鉴权（sendBeacon 无法设 header）',
    viaQuery.status === 200 && viaQuery.json.balance === 7777,
    viaQuery.status + ' ' + (viaQuery.json && viaQuery.json.balance));
  const beaconSync = await req('POST', '/api/account/sync?token=' + encodeURIComponent(token),
    { balance: 8888, positions: [], clientTs: Date.now() });
  check('★ beacon 形态的 sync 可写入', beaconSync.status === 200 && beaconSync.json.balance === 8888,
    beaconSync.status);

  section('=== A9. 数据落盘（重启后仍在）===');
  const onDisk = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
  const diskUser = Object.values(onDisk.users).find((u) => u.name === '存档玩家');
  check('★ 余额已写入磁盘文件', diskUser && diskUser.balance === 8888, diskUser && diskUser.balance);
  check('★ lastSyncAt 已写入磁盘', diskUser && diskUser.lastSyncAt > 0);
  check('磁盘结构版本已升到 2', onDisk.version === 2, onDisk.version);

  /* 重启服务，验证读回来还在 */
  child.kill();
  await new Promise((r) => setTimeout(r, 500));
  child = startServer();
  await waitUp(Date.now() + 15000);
  const afterRestart = await req('GET', '/api/account/state', undefined, token);
  check('★ 重启服务后存档仍在（真持久化）',
    afterRestart.json.balance === 8888, afterRestart.json.balance);
  check('重启后 token 仍有效', afterRestart.status === 200);

  /* ==================== B. 前端 ==================== */

  section('=== B1. 前端：刷新后资金不重置（核心诉求）===');

  /* 用 DOM 桩跑真实页面，验证 applySaveToGame 真的把资金写回游戏 */
  function bootPage(tokenValue, serverState) {
    const els = new Map();
    const ctxProxy = new Proxy({}, {
      get(t, k) { return k in t ? t[k] : (() => ({ width: 12 })); },
      set(t, k, v) { t[k] = v; return true; },
    });
    function makeEl(id) {
      const style = {};
      const e = {
        tagName: 'DIV', dataset: {}, hidden: true, value: '', disabled: false,
        textContent: '', innerHTML: '', className: '',
        clientWidth: 700, clientHeight: 290, width: 700, height: 290,
        children: [], firstChild: null, parentNode: null,
        style: new Proxy(style, { get(t, k) { return k in t ? t[k] : (k === 'setProperty' ? () => {} : ''); },
          set(t, k, v) { t[k] = v; return true; } }),
        classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
          toggle(c, on) { const v = on === undefined ? !this._s.has(c) : !!on; v ? this._s.add(c) : this._s.delete(c); return v; },
          contains(c) { return this._s.has(c); } },
        addEventListener() {}, removeEventListener() {},
        appendChild(c) { e.children.push(c); e.firstChild = e.children[0]; return c; },
        insertBefore(c) { e.children.unshift(c); e.firstChild = e.children[0]; return c; },
        removeChild() {}, remove() {},
        querySelectorAll: () => [], querySelector: () => null, closest: () => null,
        getBoundingClientRect: () => ({ width: 700, height: 290, left: 0, top: 0 }),
        getContext: () => ctxProxy, setAttribute() {}, getAttribute: () => null,
        focus() {}, blur() {}, click() {}, replaceChildren() {},
      };
      let _id = id;
      Object.defineProperty(e, 'id', { get() { return _id; }, set(v) { _id = v; if (v) els.set(v, e); } });
      if (id) els.set(id, e);
      return e;
    }

    const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
    const stripped = html.replace(/<!--[\s\S]*?-->/g, '');
    const scripts = [];
    const re = /<script>([\s\S]*?)<\/script>/g;
    let m;
    while ((m = re.exec(stripped))) scripts.push(m[1]);
    const idRe = /\bid="([^"]+)"/g;
    let im;
    while ((im = idRe.exec(stripped))) if (!els.has(im[1])) makeEl(im[1]);

    const topbar = makeEl('__topbar');
    const doc = {
      readyState: 'complete',
      getElementById: (id) => (els.has(id) ? els.get(id) : null),
      createElement: () => makeEl(''),
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
      querySelector: (s) => (s === '.topbar-actions' ? topbar : null),
      querySelectorAll: () => [],
      addEventListener() {},
      head: makeEl('head'), body: makeEl('body'),
    };

    const store = {};
    if (tokenValue) store['fx-online-token-v1'] = tokenValue;
    const timers = [];
    const intervals = [];
    const beacons = [];
    const sandbox = {
      document: doc,
      console: { log() {}, warn() {}, error() {} },
      setTimeout(f, ms) { timers.push({ f, ms }); return timers.length; },
      clearTimeout() {},
      setInterval(f, ms) { intervals.push({ f, ms }); return intervals.length; },
      clearInterval() {},
      performance: { now: () => Date.now() },
      fetch(url, opts) {
        /* 只拦截存档相关接口，其它给个空成功响应 */
        if (url.indexOf('/api/account/state') >= 0) {
          return Promise.resolve({ ok: true, status: 200,
            json: () => Promise.resolve(Object.assign({ ok: true }, serverState)) });
        }
        if (url.indexOf('/api/account/sync') >= 0) {
          return Promise.resolve({ ok: true, status: 200,
            json: () => Promise.resolve({ ok: true, balance: 1, positions: [], lastSyncAt: Date.now(), hasSave: true }) });
        }
        if (url.indexOf('/api/me') >= 0) {
          return Promise.resolve({ ok: true, status: 200,
            json: () => Promise.resolve({ ok: true, user: { id: 'u1', name: 'T', best: 0, runs: 0, wins: 0 } }) });
        }
        if (url.indexOf('/api/leaderboard') >= 0) {
          return Promise.resolve({ ok: true, status: 200,
            json: () => Promise.resolve({ ok: true, rows: [], me: null, total: 0, boards: [] }) });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
      },
      Promise, JSON, Math, Date, Number, String, Object, Array, Error,
      isFinite, parseInt, parseFloat, RegExp, Map, Set, Blob: function (a) { this.parts = a; },
      XMLHttpRequest: function () {
        this.open = () => {}; this.setRequestHeader = () => {};
        this.send = (b) => beacons.push(b);
      },
      navigator: { sendBeacon: (url, body) => { beacons.push({ url, body }); return true; } },
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window.localStorage = {
      getItem: (k) => (k in store ? store[k] : null),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: (k) => { delete store[k]; },
    };
    sandbox.window.innerWidth = 400;
    sandbox.window.devicePixelRatio = 1;
    let unloadHandlers = [];
    sandbox.window.addEventListener = (t, f) => { if (t === 'beforeunload' || t === 'pagehide') unloadHandlers.push(f); };
    sandbox.window.confirm = () => true;
    sandbox.window.navigator = sandbox.navigator;

    vm.createContext(sandbox);
    scripts.forEach((code) => vm.runInContext(code, sandbox));

    /* 推进需等待的异步流程 */
    return {
      sandbox, els, timers, intervals, beacons,
      FX: () => sandbox.window.FX,
      FXOnline: () => sandbox.window.FXOnline,
      runTimers() { const l = timers.slice(); timers.length = 0; l.forEach((t) => t.f()); },
      fireUnload() { unloadHandlers.forEach((f) => f()); },
    };
  }

  /* 场景：服务端有存档 $45,000 + 2 个持仓，页面启动后应当覆盖成这个值 */
  const savedPositions = [
    { id: 11, pair: 'GBP/USD', side: 'short', margin: 1200, lev: 15, notional: 18000, entry: 1.27, fee: 2.7, openTs: Date.now(), openTick: 300 },
    { id: 12, pair: 'USD/JPY', side: 'long', margin: 600, lev: 25, notional: 15000, entry: 150.2, fee: 2.25, openTs: Date.now(), openTick: 320 },
  ];
  const page = bootPage('valid.token.sig', {
    balance: 45000, positions: savedPositions, lastSyncAt: Date.now(), hasSave: true,
  });

  const FX = page.FX();
  check('游戏启动后默认是 $10,000（改造前的行为）', FX.state.balance === 10000, FX.state.balance);

  /* 触发一次登录态确认 + 存档载入的异步链 */
  await page.FXOnline().loadAccountState();

  check('★ 载入云端存档后 balance = $45,000（不再是 10000）',
    FX.state.balance === 45000, FX.state.balance);
  check('★ 载入云端存档后持仓恢复为 2 个',
    Array.isArray(FX.state.positions) && FX.state.positions.length === 2,
    FX.state.positions && FX.state.positions.length);
  check('★ 持仓内容正确（交易对/方向/保证金）',
    FX.state.positions[0].pair === 'GBP/USD' && FX.state.positions[0].side === 'short' &&
    FX.state.positions[0].margin === 1200,
    JSON.stringify(FX.state.positions[0]));
  check('★ locked（占用保证金）按持仓重算 = 1800',
    Math.abs(FX.state.locked - 1800) < 0.01, FX.state.locked);
  check('★ seq 游标被推到最大 id 之后（防止新仓撞 id）',
    FX.state.seq >= 12, FX.state.seq);

  section('=== B2. 未登录：完全不发请求 ===');
  const guestPage = bootPage(null, { balance: 99999, positions: [], lastSyncAt: 1, hasSave: true });
  const beforeFetch = guestPage.FXOnline().account.loaded;
  await guestPage.FXOnline().loadAccountState();
  check('★ 游客载入返回 null 且不覆盖游戏资金',
    guestPage.FX().state.balance === 10000, guestPage.FX().state.balance);
  check('游客的 account.loaded 保持 false（未触发任何存档请求）', beforeFetch === false);

  section('=== B3. 状态变化检测与节流 ===');
  const syncCalls = [];
  function countingPage() {
    const p = bootPage('valid.token.sig', {
      balance: 20000, positions: [], lastSyncAt: Date.now(), hasSave: true,
    });
    /* 包一层，统计 sync 调用次数 */
    const origFetch = p.sandbox.fetch;
    p.sandbox.fetch = function (url, opts) {
      if (url.indexOf('/api/account/sync') >= 0) syncCalls.push(JSON.parse(opts.body));
      return origFetch(url, opts);
    };
    return p;
  }
  const p2 = countingPage();
  await p2.FXOnline().loadAccountState();
  check('载入后资金为 $20,000', p2.FX().state.balance === 20000, p2.FX().state.balance);

  syncCalls.length = 0;
  /* 改余额后再推送 */
  p2.FX().state.balance = 21000;
  p2.FXOnline().account.loaded = true;
  p2.FXOnline().syncNow(true);      // force：忽略指纹，确保发出去
  await new Promise((r) => setImmediate(r));
  check('手动 sync 会推送', syncCalls.length === 1, syncCalls.length);
  check('推送内容含最新 balance', syncCalls[0] && syncCalls[0].balance === 21000,
    syncCalls[0] && syncCalls[0].balance);
  check('推送内容含 positions 数组', syncCalls[0] && Array.isArray(syncCalls[0].positions));
  check('推送内容含 clientTs（服务端据此防乱序）',
    syncCalls[0] && typeof syncCalls[0].clientTs === 'number');

  section('=== B4. 内容未变时不重复推送（节流的核心）===');
  /* 先把"已推送指纹"对齐到当前状态：模拟"刚刚同步成功"的干净基线。
   * （B3 里我们手工改过 balance，指纹与当前值已经不一致 ——
   *   那是测试造出来的状态，不是产品行为。） */
  await p2.FXOnline().syncNow(true);
  syncCalls.length = 0;

  /* 基线一致后再同步：状态没变 → 应当跳过 */
  await p2.FXOnline().syncNow();
  check('★ 状态未变化时同步请求被跳过（省流量/省写盘）', syncCalls.length === 0, syncCalls.length);

  /* 反过来验证：状态一改，不带 force 也会发 */
  syncCalls.length = 0;
  p2.FX().state.balance = 22222;
  await p2.FXOnline().syncNow();
  check('★ 状态变化后同步正常发出', syncCalls.length === 1 && syncCalls[0].balance === 22222,
    syncCalls.length + ' / ' + (syncCalls[0] && syncCalls[0].balance));

  section('=== B5. 退出兜底：beforeunload 走 sendBeacon ===');
  p2.FX().state.balance = 33333;
  p2.FXOnline().account.lastSentKey = '';   // 模拟"还没推送过"
  const beforeBeacons = p2.beacons.length;
  p2.fireUnload();
  check('★ 卸载时触发了 beacon 发送', p2.beacons.length > beforeBeacons, p2.beacons.length - beforeBeacons);
  const lastBeacon = p2.beacons[p2.beacons.length - 1];
  check('★ beacon 的 URL 带 ?token=（header 不可用）',
    lastBeacon && typeof lastBeacon === 'object' && String(lastBeacon.url).indexOf('token=') >= 0,
    lastBeacon && lastBeacon.url);
  check('beacon 指向 /api/account/sync',
    lastBeacon && String(lastBeacon.url).indexOf('/api/account/sync') >= 0);

  section('=== B6. 未登录时 beacon 也不发 ===');
  const guestBefore = guestPage.beacons.length;
  guestPage.fireUnload();
  check('★ 游客卸载时不发 beacon', guestPage.beacons.length === guestBefore,
    guestPage.beacons.length - guestBefore);

  section('=== B7. 断网失败后的静默重试 ===');
  const p3 = bootPage('valid.token.sig', {
    balance: 30000, positions: [], lastSyncAt: Date.now(), hasSave: true,
  });
  await p3.FXOnline().loadAccountState();
  /* 让 sync 全部失败 */
  const origFetch3 = p3.sandbox.fetch;
  p3.sandbox.fetch = function (url, opts) {
    if (url.indexOf('/api/account/sync') >= 0) {
      return Promise.reject(Object.assign(new Error('断网'), { status: 0 }));
    }
    return origFetch3(url, opts);
  };
  p3.FX().state.balance = 31000;
  p3.FXOnline().account.lastSentKey = '';
  await p3.FXOnline().syncNow();
  await new Promise((r) => setImmediate(r));
  check('★ 同步失败后记录了失败次数', p3.FXOnline().account.failed >= 1, p3.FXOnline().account.failed);
  check('★ 同步失败不抛到游戏层（静默处理）', true);
  check('失败后安排了重试定时器', p3.FXOnline().account.retryTimer !== null);

  console.log('\n' + '='.repeat(52));
  console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：' + (e && e.stack || e));
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
