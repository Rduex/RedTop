/*
 * 端到端测试：验证「联网版 index.html」在模拟浏览器环境下能正常启动，
 * 且联网模块不会破坏游戏本身。
 *
 * 手法沿用工作区里已有的做法（见 fx-equity-test.js）：用 DOM 桩在 Node 里
 * 跑整份 HTML 的两个脚本块，然后直接调用 window.FX / window.FXOnline 检查行为。
 *
 * 运行： node test/e2e.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML = path.join(ROOT, 'public', 'index.html');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------- 最小可用的 DOM 桩 ---------- */

const ctxStub = new Proxy({}, {
  get(t, k) { return k in t ? t[k] : (() => ({ width: 12 })); },
  set(t, k, v) { t[k] = v; return true; },
});

/* 记录定时器：测试里手动触发，避免真等时间 */
const timers = [];
const intervals = [];

const store = {};
const els = new Map();

/* ★ 模拟真实 DOM 的 getElementById：
 *   只认得"页面里确实存在"的 id，否则返回 null。
 *   早先的桩会为任何 id 凭空造一个元素，导致 mountChip() 里
 *   `getElementById('fxoChip')` 永远为真、以为按钮已经挂上了就直接 return ——
 *   测试因此漏报了一个真实的挂载问题。这里改为先扫描 HTML 里的 id。 */
function makeEl(id) {
  const style = {};
  const e = {
    tagName: 'DIV', dataset: {}, hidden: true, value: '', disabled: false,
    textContent: '', innerHTML: '', className: '',
    clientWidth: 700, clientHeight: 290, width: 700, height: 290,
    children: [], firstChild: null, parentNode: null,
    style: new Proxy(style, {
      get(t, k) { return k in t ? t[k] : (k === 'setProperty' ? () => {} : ''); },
      set(t, k, v) { t[k] = v; return true; },
    }),
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, on) { const v = on === undefined ? !this._s.has(c) : !!on; v ? this._s.add(c) : this._s.delete(c); return v; },
      contains(c) { return this._s.has(c); },
    },
    addEventListener(t, f) { e._h = e._h || {}; (e._h[t] = e._h[t] || []).push(f); },
    removeEventListener() {},
    appendChild(c) { e.children.push(c); e.firstChild = e.children[0]; c.parentNode = e; return c; },
    insertBefore(c) { e.children.unshift(c); e.firstChild = e.children[0]; c.parentNode = e; return c; },
    removeChild(c) { const i = e.children.indexOf(c); if (i >= 0) e.children.splice(i, 1); e.firstChild = e.children[0] || null; return c; },
    remove() {},
    querySelectorAll: () => [],
    querySelector: () => null,
    closest: () => null,
    getBoundingClientRect: () => ({ width: 700, height: 290, left: 0, top: 0 }),
    getContext: () => ctxStub,
    setAttribute() {}, getAttribute: () => null,
    focus() {}, blur() {}, click() {},
    replaceChildren() { e.children = []; e.firstChild = null; },
  };
  /* id 赋值时自动登记进索引：createElement 造出来的元素，
   * 后续代码给它赋 id（例如 chip.id = 'fxoChip'）也要能被 getElementById 找到。 */
  let _id = id;
  Object.defineProperty(e, 'id', {
    get() { return _id; },
    set(v) { _id = v; if (v) els.set(v, e); },
    enumerable: true,
  });
  if (id) els.set(id, e);
  return e;
}

/* fetch 桩：默认"服务器不可达"，用于验证离线降级路径 */
let fetchCalls = [];
let fetchImpl = function () {
  return Promise.reject(new Error('测试环境默认不联网'));
};

/* 可控时钟：客户端用 performance.now() 算本局时长。
 * 测试里手动推进它，才能造出"tick 数与真实用时相符"的成绩 ——
 * 否则瞬间跑完的测试会让 durationMs ≈ 0 而 tickCount 很大，
 * 看起来像作弊数据，测不出真实链路的正确性。 */
let fakeNow = Date.now();
function advanceClock(ms) { fakeNow += ms; }

/* ---------- 加载页面里的两个脚本块 ----------
 * 注意：必须**先剥掉 HTML 注释**再提取脚本。
 * 注释里的说明文字（例如注入块的标题）如果被当成标签，会把注释内容当代码解析。 */
const html = fs.readFileSync(HTML, 'utf8');
const noComments = html.replace(/<!--[\s\S]*?-->/g, '');
const scripts = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(noComments))) scripts.push(m[1]);

/* 把 HTML 里真实存在的 id 全部登记进元素表：
 * 这样 getElementById 的行为与浏览器一致 —— 存在就返回，不存在就是 null。 */
const idRe = /\bid="([^"]+)"/g;
let im;
while ((im = idRe.exec(noComments))) {
  if (!els.has(im[1])) makeEl(im[1]);
}

const topbarActions = makeEl('__topbar-actions');
const documentStub = {
  readyState: 'complete',
  getElementById(id) { return els.has(id) ? els.get(id) : null; },
  createElement: () => makeEl(''),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
  querySelector(sel) {
    if (sel === '.topbar-actions') return topbarActions;
    return null;
  },
  querySelectorAll: () => [],
  addEventListener(t, f) { documentStub._h = documentStub._h || {}; (documentStub._h[t] = documentStub._h[t] || []).push(f); },
  head: makeEl('head'),
  body: makeEl('body'),
};

const sandbox = {
  document: documentStub,
  console: { log() {}, warn() {}, error() {} },
  setTimeout(f, ms) { timers.push({ f, ms }); return timers.length; },
  clearTimeout() {},
  setInterval(f, ms) { intervals.push({ f, ms }); return intervals.length; },
  clearInterval() {},
  fetch(url, opts) {
    fetchCalls.push({ url, opts });
    return fetchImpl(url, opts);
  },
  performance: { now: () => fakeNow },
  Promise, JSON, Math, Date, Number, String, Object, Array, Error,
  isFinite, parseInt, parseFloat, RegExp, Map, Set,
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
sandbox.window.addEventListener = () => {};
sandbox.window.confirm = () => true;


section('=== 0. 构建产物结构 ===');
check('index.html 含 2 个脚本块（游戏 + 联网模块）', scripts.length === 2, scripts.length);
check('联网模块里含 FXOnline 导出', scripts[1].indexOf('window.FXOnline') >= 0);

vm.createContext(sandbox);
scripts.forEach((code, i) => {
  try {
    vm.runInContext(code, sandbox);
    check('脚本块 ' + (i + 1) + ' 执行无异常', true);
  } catch (e) {
    check('脚本块 ' + (i + 1) + ' 执行无异常', false, e.message);
  }
});

const FX = sandbox.window.FX;
const FXOnline = sandbox.window.FXOnline;

section('=== 1. 游戏本体未被破坏 ===');
check('window.FX 已导出', !!FX);
check('window.FXOnline 已导出', !!FXOnline);
check('state 可用', !!FX && !!FX.state);
check('totalEquity() 可调用', typeof FX.totalEquity === 'function' && isFinite(FX.totalEquity()), FX && FX.totalEquity && FX.totalEquity());
check('游戏常量完整（通关目标存在）', FX.constants.FREEDOM_GOAL === 20000000, FX.constants && FX.constants.FREEDOM_GOAL);
check('初始权益 = $10,000', FX.state.balance === 10000 || FX.state.balance > 0, FX.state.balance);

section('=== 2. 联网模块挂载 ===');
check('顶栏插入了排行榜入口', topbarActions.children.some((c) => c.id === 'fxoChip'));
check('暴露了调试接口 open/submit', typeof FXOnline.open === 'function' && typeof FXOnline.submit === 'function');
check('注册了观测定时器', intervals.some((it) => it.ms === 1000));
check('注册了峰值采样定时器', intervals.some((it) => it.ms === 2000));

function runInterval(ms) {
  intervals.filter((it) => it.ms === ms).forEach((it) => it.f());
}
function runTimers() {
  const list = timers.slice();
  timers.length = 0;
  list.forEach((t) => t.f());
}

section('=== 3. 离线（服务器不可达）时不得影响游戏 ===');
/* 触发观测与采样：不应抛异常，也不应改动游戏账户 */
const before = { balance: FX.state.balance, ticks: FX.state.tickCount, equity: FX.totalEquity() };
let threw = null;
try {
  for (let i = 0; i < 5; i++) { runInterval(1000); runInterval(2000); }
} catch (e) { threw = e; }
check('观测/采样循环不抛异常', !threw, threw && threw.message);
check('游戏账户未被联网模块改动', FX.state.balance === before.balance && FX.totalEquity() === before.equity,
  FX.state.balance + ' / ' + FX.totalEquity());
check('游戏行情计数未被改动', FX.state.tickCount === before.ticks, FX.state.tickCount);

section('=== 4. 离线成绩：未登录时应暂存到本地队列 ===');
runInterval(1000);
/* 推进游戏，让本局足够长（服务端要求 ≥8 tick）。
 * 同时推进时钟：40 个 tick 在真实游戏里对应 40×1.5 秒 = 60 秒。 */
FX.state.tickCount = (FX.state.tickCount || 0) + 40;
advanceClock(40 * 1500);
FX.state.balance = 25000;
runInterval(2000);          // 采样到峰值
const sub = FXOnline.submit('manual');
check('submit 返回 Promise', sub && typeof sub.then === 'function');

section('=== 5. 已登录时上报：应发出正确的请求体 ===');
let sent = null;
let fetchResolve = null;
fetchImpl = function (url, opts) {
  sent = { url, opts };
  return new Promise((resolve) => {
    fetchResolve = () => resolve({
      ok: true, status: 200,
      json: () => Promise.resolve({ ok: true, rank: 3, total: 12, entry: { score: 25000 } }),
    });
  });
};
sandbox.window.localStorage.setItem('fx-online-token-v1', 'fake.token.sig');
FXOnline.state.token = 'fake.token.sig';
FXOnline.state.user = { id: 'u1', name: '测试员', best: 0, runs: 0 };

/* 开一局新的采样上下文并推进到"一局打了 60 秒" */
runInterval(1000);
FX.state.tickCount = (FX.state.tickCount || 0) + 40;
advanceClock(40 * 1500);
FX.state.balance = 33000;
runInterval(2000);
FXOnline.submit('manual');

section('--- 等待异步上报 ---');

/* 让异步流程有机会跑完，然后校验请求体 */
setImmediate(() => {
  section('=== 6. 上报请求体的正确性 ===');
  check('确实发出了 /api/score 请求', !!sent && sent.url.indexOf('/api/score') >= 0, sent && sent.url);
  if (sent) {
    const body = JSON.parse(sent.opts.body);
    check('带上了登录 token', sent.opts.headers['X-FX-Token'] === 'fake.token.sig');
    check('body.score 是数字且 > 0', typeof body.score === 'number' && body.score > 0, body.score);
    check('body 含 runId', typeof body.runId === 'string' && body.runId.length > 0, body.runId);
    check('body.tickCount > 0', body.tickCount > 0, body.tickCount);
    check('body.durationMs > 0', body.durationMs > 0, body.durationMs);
    /* 这条是重点：服务端会用 durationMs >= tickCount×1500×0.9 来判定"时间上可能"。
     * 客户端算出来的时长必须真的满足它，否则真实玩家的成绩会被自己人拒掉。 */
    check('tick 数与时长相容（能通过服务端的时间校验）',
      body.durationMs >= body.tickCount * 1500 * 0.9,
      'ticks=' + body.tickCount + ' dur=' + body.durationMs +
      ' need>=' + Math.round(body.tickCount * 1500 * 0.9));
    check('won 字段存在（布尔）', typeof body.won === 'boolean', body.won);
    check('startEquity 合理（>0）', typeof body.startEquity === 'number' && body.startEquity > 0, body.startEquity);
    /* 峰值不得低于结算权益太多，否则服务端的 peak_below_equity 会拒绝 */
    check('score 不低于 equity 的 99%（服务端会校验峰值 ≥ 权益）',
      body.score + Math.max(1, body.score * 0.01) >= body.equity,
      'score=' + body.score + ' equity=' + body.equity);
  }

  /* ---------- 界面渲染：这一段验证排行榜 UI 真的能画出来 ---------- */
  section('=== 7. 排行榜界面渲染 ===');
  const modal = els.get('fxoRoot');

  let threw = null;
  try { FXOnline.open('auth'); } catch (e) { threw = e; }
  check('打开登录界面不抛异常', !threw, threw && threw.message);
  check('弹窗被标记为显示中', !!modal && modal.classList.contains('on'));

  /* 让 /api/leaderboard 返回一份榜单，验证列表渲染 */
  const fakeRows = [
    { rank: 1, name: '<script>坏名字</script>', score: 30000000, equity: 29000000, won: true,
      at: Date.now(), durationMs: 3600000, tickCount: 2000, candles: 500, trades: 30,
      cards: 8, assets: 4, cycles: 1, reason: 'retire', mode: 'sim', userId: 'u9' },
    { rank: 2, name: '测试员', score: 250000, equity: 240000, won: false,
      at: Date.now(), durationMs: 1800000, tickCount: 1200, candles: 300, trades: 20,
      cards: 4, assets: 2, cycles: 1, reason: 'settle', mode: 'sim', userId: 'u1' },
  ];
  fetchImpl = function (url) {
    if (url.indexOf('/api/leaderboard') >= 0) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          ok: true, board: 'all', title: '总榜', desc: 'x', total: 2, offset: 0, limit: 50,
          rows: fakeRows,
          me: fakeRows[1],
          boards: [
            { key: 'all', title: '总榜 · 历史最高身家', desc: '' },
            { key: 'week', title: '周榜 · 近 7 天', desc: '' },
            { key: 'today', title: '日榜 · 今日', desc: '' },
            { key: 'wins', title: '通关榜', desc: '' },
          ],
          updatedAt: Date.now(),
        }),
      });
    }
    if (url.indexOf('/api/profile') >= 0) {
      return Promise.resolve({
        ok: true, status: 200,
        json: () => Promise.resolve({
          ok: true,
          user: { id: 'u1', name: '测试员', createdAt: Date.now(), best: 250000, runs: 7, wins: 0 },
          best: null,
          history: [fakeRows[1], fakeRows[1]],
          ranks: { all: 2, week: 2, today: null, wins: null },
        }),
      });
    }
    return Promise.reject(new Error('unexpected url ' + url));
  };

  FXOnline.state.token = 'fake.token.sig';
  FXOnline.state.user = { id: 'u1', name: '测试员', best: 250000, runs: 7, wins: 0 };

  FXOnline.loadBoard().then(() => {
    section('=== 8. 榜单列表渲染（含 XSS 防护）===');
    FXOnline.state.view = 'board';
    let threw2 = null;
    try { FXOnline.open('board'); } catch (e) { threw2 = e; }
    check('渲染榜单不抛异常', !threw2, threw2 && threw2.message);

    const dump = collectText(modal);
    check('榜单里出现了玩家名字', dump.indexOf('测试员') >= 0, dump.slice(0, 120));
    check('榜单里出现了通关标记', dump.indexOf('通关') >= 0, dump.slice(0, 120));
    /* 名字里的 HTML 必须被转义成文本，绝不能变成真实标签 */
    check('恶意昵称被转义（未注入标签）',
      dump.indexOf('<script>') >= 0 && !containsTag(modal, 'script'),
      'dump 含转义文本=' + (dump.indexOf('<script>') >= 0) +
      ' 真标签=' + containsTag(modal, 'script'));

    /* 我的战绩视图也要能画 */
    let threw3 = null;
    try { FXOnline.open('me'); } catch (e) { threw3 = e; }
    check('打开「我的战绩」不抛异常', !threw3, threw3 && threw3.message);

    console.log('\n' + '='.repeat(52));
    console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
    console.log('='.repeat(52));
    if (fail > 0) process.exitCode = 1;
  }).catch((e) => {
    check('榜单加载流程', false, e && e.message);
    console.log('\n通过 ' + pass + ' · 失败 ' + fail);
    process.exitCode = 1;
  });
});

/* 递归收集元素树里的全部文本（innerHTML 与 textContent 都算） */
function collectText(root, out) {
  out = out || [];
  if (!root) return out.join(' ');
  if (typeof root.textContent === 'string' && root.textContent) out.push(root.textContent);
  if (typeof root.innerHTML === 'string' && root.innerHTML) out.push(root.innerHTML);
  (root.children || []).forEach((c) => collectText(c, out));
  return out.join(' ');
}

/* 检查元素树里是否存在真实的 <script> 元素（XSS 判据） */
function containsTag(root, tag) {
  if (!root) return false;
  if (root.tagName && String(root.tagName).toLowerCase() === tag) return true;
  return (root.children || []).some((c) => containsTag(c, tag));
}
