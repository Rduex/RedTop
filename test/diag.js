/*
 * 运行时诊断：证明「构建产物里的联网模块是否真的执行了」。
 *
 * 不靠读源码做静态判断，而是把 public/index.html 当浏览器那样跑起来，
 * 记录它到底向服务器发了哪些请求、资金有没有被存档覆盖。
 *
 * 运行： node test/diag.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public', 'index.html');
const html = fs.readFileSync(HTML_PATH, 'utf8').replace(/<!--[\s\S]*?-->/g, '');

const scripts = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(html))) scripts.push(m[1]);

/* 服务端"已有存档"的样子：$45,000 + 1 个持仓 */
const SERVER_SAVE = {
  ok: true,
  balance: 45000,
  positions: [{
    id: 9, pair: 'EUR/USD', side: 'long', margin: 700, lev: 20,
    notional: 14000, entry: 1.086, fee: 2.1, openTs: Date.now(), openTick: 100,
  }],
  lastSyncAt: Date.now(),
  hasSave: true,
};

/*
 * 造一个元素桩。
 * 关键：必须模拟真实 DOM 的两条行为，否则会测出假结果：
 *   ① appendChild(文本节点) 会把文本并入 textContent；
 *   ② innerHTML = '' 会清空子节点与 textContent。
 * 少了任何一条，"顶栏文字"这类断言就会读到空串或累加值。
 */
function makeEl(id, sink) {
  const style = {};
  let _text = '';
  let _html = '';
  const e = {
    tagName: 'DIV', dataset: {}, hidden: true, value: '', disabled: false,
    className: '', children: [], firstChild: null,
    clientWidth: 700, clientHeight: 290, width: 700, height: 290,
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
    addEventListener() {}, removeEventListener() {},
    appendChild(c) {
      e.children.push(c);
      e.firstChild = e.children[0];
      if (c && c.nodeType === 3) _text += c.textContent;
      return c;
    },
    insertBefore(c) {
      e.children.unshift(c);
      e.firstChild = e.children[0];
      if (c && c.nodeType === 3) _text = c.textContent + _text;
      return c;
    },
    removeChild() {}, remove() {},
    querySelectorAll: () => [], querySelector: () => null, closest: () => null,
    getBoundingClientRect: () => ({ width: 700, height: 290, left: 0, top: 0 }),
    /* 游戏会用 el.chart.getContext('2d') 初始化 K 线画布，必须提供 */
    getContext: () => ({
      canvas: { width: 700, height: 290 },
      setTransform() {}, clearRect() {}, fillRect() {}, beginPath() {}, moveTo() {},
      lineTo() {}, stroke() {}, fill() {}, arc() {}, closePath() {}, save() {}, restore() {},
      fillText() {}, measureText: () => ({ width: 12 }), setLineDash() {}, translate() {},
      scale() {}, rotate() {}, createLinearGradient: () => ({ addColorStop() {} }),
      roundRect() {}, quadraticCurveTo() {}, bezierCurveTo() {}, clip() {},
    }),
    setAttribute() {}, getAttribute: () => null,
    focus() {}, blur() {}, click() {}, replaceChildren() {},
  };
  Object.defineProperty(e, 'textContent', {
    get() { return _text; },
    set(v) { _text = String(v == null ? '' : v); },
  });
  Object.defineProperty(e, 'innerHTML', {
    get() { return _html; },
    set(v) {
      _html = String(v == null ? '' : v);
      if (_html === '') { e.children.length = 0; e.firstChild = null; _text = ''; }
    },
  });
  let _id = id;
  Object.defineProperty(e, 'id', {
    get() { return _id; },
    set(v) { _id = v; if (v && sink) sink.set(v, e); },
  });
  /* ★ 构造时就登记进 id 索引。
   *   只在 setter 里登记是不够的 —— 用 makeEl('chart') 创建时 id 就已经传入，
   *   setter 不会被调用，于是 $('chart') 拿到 null，
   *   游戏在 `el.chart.getContext('2d')` 处直接抛错。（踩过） */
  if (id && sink) sink.set(id, e);
  return e;
}

/*
 * 启动一个隔离的页面场景。
 * opts: { guest, meFails }
 */
function bootScenario(opts) {
  const o = opts || {};
  const els = new Map();
  const ctxProxy = new Proxy({}, {
    get(t, k) { return k in t ? t[k] : (() => ({ width: 12 })); },
    set(t, k, v) { t[k] = v; return true; },
  });
  const mk = (id) => makeEl(id, els);

  /* 把 HTML 里真实存在的 id 全部登记，模拟浏览器已解析好的 DOM */
  const idRe = /\bid="([^"]+)"/g;
  let im;
  while ((im = idRe.exec(html))) if (!els.has(im[1])) mk(im[1]);
  idRe.lastIndex = 0;

  const topbar = mk('__topbar');
  const calls = [];
  const storage = o.guest ? {} : { 'fx-online-token-v1': 'diag.token.sig' };

  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: (id) => (els.has(id) ? els.get(id) : null),
      createElement: () => mk(''),
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
      querySelector: (s) => (s === '.topbar-actions' ? topbar : null),
      querySelectorAll: () => [],
      addEventListener() {},
      head: mk('head'),
      body: mk('body'),
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: () => 0,
    clearInterval() {},
    performance: { now: () => Date.now() },
    fetch(url) {
      calls.push(url);
      if (url.indexOf('/api/me') >= 0) {
        if (o.meFails) {
          return Promise.reject(Object.assign(new Error('boom'), { status: 500 }));
        }
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, user: { id: 'u1', name: '诊断', best: 0, runs: 0, wins: 0 } }),
        });
      }
      if (url.indexOf('/api/account/state') >= 0) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(SERVER_SAVE) });
      }
      if (url.indexOf('/api/account/sync') >= 0) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, balance: 1, positions: [], lastSyncAt: Date.now(), hasSave: true }),
        });
      }
      if (url.indexOf('/api/leaderboard') >= 0) {
        return Promise.resolve({
          ok: true, status: 200,
          json: () => Promise.resolve({ ok: true, rows: [], me: null, total: 0, boards: [] }),
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    },
    Promise, JSON, Math, Date, Number, String, Object, Array, Error,
    isFinite, parseInt, parseFloat, RegExp, Map, Set,
    Blob: function (a) { this.parts = a; },
    XMLHttpRequest: function () {
      this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {};
    },
    navigator: { sendBeacon: () => true },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.localStorage = {
    getItem: (k) => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: (k) => { delete storage[k]; },
  };
  sandbox.window.innerWidth = 400;
  sandbox.window.devicePixelRatio = 1;
  sandbox.window.addEventListener = () => {};
  sandbox.window.confirm = () => true;
  sandbox.window.navigator = sandbox.navigator;

  vm.createContext(sandbox);
  const errors = [];
  scripts.forEach((code, i) => {
    try { vm.runInContext(code, sandbox); }
    catch (e) { errors.push({ block: i + 1, message: e.message }); }
  });
  if (errors.length) {
    console.log('[diag] 脚本块执行出错：', JSON.stringify(errors));
  }

  return {
    sandbox,
    calls,
    els,
    FX: () => sandbox.window.FX,
    FXOnline: () => sandbox.window.FXOnline,
    chipText() {
      const chip = els.get('fxoChip');
      return chip ? chip.textContent : '';
    },
    async settle() {
      /* 把异步链推到一个稳定的点（fetch → then → then） */
      for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r));
    },
  };
}

(async function main() {
  console.log('=== 构建产物结构 ===');
  console.log('脚本块数量:', scripts.length);
  scripts.forEach((s, i) => {
    console.log('  块 ' + (i + 1) + ': ' + (s.length / 1024).toFixed(1) + 'KB' +
      (s.indexOf('FXOnline') >= 0 ? '  ← 含联网模块' : '  ← 游戏本体'));
  });

  let ok = true;

  /* ---------- 场景 1：已登录 + 服务端有存档 ---------- */
  console.log('\n=== 场景1：已登录，云端有 $45,000 与 1 个持仓 ===');
  const s1 = bootScenario({});
  const FX = s1.FX();
  const FXOnline = s1.FXOnline();

  console.log('window.FX       :', FX ? '存在' : '缺失');
  console.log('window.FXOnline :', FXOnline ? '存在' : '缺失');
  console.log('顶栏按钮        :', s1.els.has('fxoChip') ? '已插入' : '未插入');
  console.log('载入前资金      : $' + (FX ? FX.state.balance : '?'));

  await s1.settle();
  console.log('实际请求        :', s1.calls.length ? s1.calls.join(' → ') : '（无）');

  const asked = s1.calls.some((u) => u.indexOf('/api/account/state') >= 0);
  const balOk = FX.state.balance === 45000;
  const posOk = FX.state.positions.length === 1;
  console.log('请求存档接口    :', asked ? '✅ 是' : '❌ 否');
  console.log('资金被覆盖      :', balOk ? '✅ $' + FX.state.balance : '❌ $' + FX.state.balance);
  console.log('持仓被恢复      :', posOk ? '✅ 1 个' : '❌ ' + FX.state.positions.length + ' 个');
  ok = ok && asked && balOk && posOk;

  console.log('\n--- 控制台自检输出 ---');
  console.log(FXOnline.selfCheck());

  /* ---------- 场景 2：/api/me 挂掉 ---------- */
  console.log('\n=== 场景2：/api/me 返回 500（存档加载不应被拖累）===');
  const s2 = bootScenario({ meFails: true });
  await s2.settle();
  const asked2 = s2.calls.some((u) => u.indexOf('/api/account/state') >= 0);
  const bal2 = s2.FX().state.balance === 45000;
  console.log('仍请求存档接口  :', asked2 ? '✅ 是（已解耦）' : '❌ 否（被 /api/me 拖累）');
  console.log('资金            :', bal2 ? '✅ $' + s2.FX().state.balance : '❌ $' + s2.FX().state.balance);
  ok = ok && asked2 && bal2;

  /* ---------- 场景 3：游客 ---------- */
  console.log('\n=== 场景3：游客（未登录）===');
  const s3 = bootScenario({ guest: true });
  await s3.settle();
  const asked3 = s3.calls.some((u) => u.indexOf('/api/account/state') >= 0);
  const chip = s3.chipText();
  console.log('请求存档接口    :', asked3 ? '是（不应发生）' : '✅ 否（游客纯内存，符合设计）');
  console.log('资金            :', s3.FX().state.balance === 10000 ? '$10000（符合设计）' : s3.FX().state.balance);
  console.log('顶栏提示        :', JSON.stringify(chip));
  const warned = /未登录|不存档/.test(chip);
  console.log('明确告知不存档  :', warned ? '✅ 是' : '❌ 否');
  ok = ok && !asked3 && warned;

  console.log('\n' + '='.repeat(48));
  console.log(ok ? '✅ 全部场景符合预期' : '❌ 存在不符合预期的场景（见上）');
  console.log('='.repeat(48));
  process.exit(ok ? 0 : 1);
})();
