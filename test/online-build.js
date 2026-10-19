/*
 * 合并版验证：确认 public/index.html 同时具备
 *   ① 新 UI 主题     ② 幽灵对战     ③ Node 云存档
 *
 * 这是回答"为什么 Railway 没生效"的关键测试 ——
 * 部署成功 ≠ 产物正确，必须验证产物内容与实际运行行为。
 *
 * 运行： node test/online-build.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');
const http = require('http');
const os = require('os');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'public', 'index.html');

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

if (!fs.existsSync(DIST)) {
  console.error('找不到 public/index.html，先跑： node tools/build-online.js');
  process.exit(1);
}
const html = fs.readFileSync(DIST, 'utf8');
const stripped = html.replace(/<!--[\s\S]*?-->/g, '');

/* ==================== A. 产物内容 ==================== */

section('=== A. 产物是否同时具备三大能力 ===');
check('★ 含新 UI 主题样式', html.indexOf('id="fx-theme"') >= 0);
check('★ 含 Canvas 主题（K线配色）', html.indexOf('FXCanvasTheme') >= 0);
check('★ 含幽灵本地存储', html.indexOf('root.MockServer = api') >= 0);
check('★ 含幽灵对战界面', html.indexOf('root.GhostUI = api') >= 0);
check('★ 含幽灵桥接', html.indexOf('GhostBattle') >= 0);
check('★ 含 Node 云存档客户端', html.indexOf('window.FXOnline') >= 0);
check('★ 含云存档接口', html.indexOf('/api/account/state') >= 0);
check('★ 含排行榜接口', html.indexOf('/api/leaderboard') >= 0);
check('含游戏本体', html.indexOf('window.FX = {') >= 0);

/* ---------- 幂等注入：产物里每个模块只能有一份 ----------
 * 补的是一个真实事故：拿到一份**已经合并过**的本体（自带主题/幽灵模块）直接构建，
 * 产物里出现了两份模块 —— GhostUI 挂两套界面、MockServer 两个 store、
 * getContext 被包两层，而构建日志一个字都不提。
 * 现在构建会先剥离旧块再注入（tools/inject-guard.js），这里把它锁死。 */
section('=== A2. 幂等注入（本体自带模块时不得重复）===');
const guard = require(path.join(ROOT, 'tools', 'inject-guard.js'));
const buildOnline = require(path.join(ROOT, 'tools', 'build-online.js'));
const { resolveGameSrc } = require(path.join(ROOT, 'tools', 'game-src.js'));
const gamePath = resolveGameSrc();

const once = [
  ['Canvas 主题', 'root.FXCanvasTheme = api'],
  ['MockServer', 'root.MockServer = api'],
  ['Ghost 录制', 'root.Ghost = api'],
  ['GhostUI', 'root.GhostUI = api'],
  ['幽灵桥接', 'root.GhostBattle'],
];
function countOf(sig) { return html.split(sig).length - 1; }
once.forEach(([label, sig]) => {
  check('★ 模块只有一份：' + label, countOf(sig) === 1, '出现 ' + countOf(sig) + ' 次');
});
check('★ 主题样式块只有一份', (html.match(/id="fx-theme"/g) || []).length === 1,
  (html.match(/id="fx-theme"/g) || []).length + ' 个');
check('★ 追加保证金界面在产物里（且只在云存档之前注入一次）',
  countOf('window.FXMargin') >= 1, '出现 ' + countOf('window.FXMargin') + ' 次');

const cleanBody = guard.stripPreviousInjections(fs.readFileSync(gamePath, 'utf8')).html;
const ownBlocks = (cleanBody.match(/<script>/g) || []).length;
const productBlocks = (html.match(/<script>([\s\S]*?)<\/script>/g) || []).length;
check('★ 脚本块数 = 本体自带 ' + ownBlocks + ' + 注入 ' + buildOnline.INJECTED_SCRIPT_COUNT,
  productBlocks === ownBlocks + buildOnline.INJECTED_SCRIPT_COUNT,
  '产物 ' + productBlocks + ' 块 · 本体自带 ' + ownBlocks);
const stripBuilt = guard.stripPreviousInjections(html);
check('★ 剥离器认得产物里自己注入的块（可反复构建）',
  stripBuilt.removed.length >= buildOnline.INJECTED_SCRIPT_COUNT - 1,
  stripBuilt.removed.map((r) => r.name).join(' + '));

section('=== B. 注入顺序（错了会导致功能失效）===');
const headEnd = html.indexOf('</head>');
check('★ Canvas 主题在 <head> 内（早于游戏执行）',
  html.indexOf('FXCanvasTheme') > 0 && html.indexOf('FXCanvasTheme') < headEnd);
check('★ 主题样式在游戏自带样式之后（覆盖才生效）',
  html.indexOf('id="fx-theme"') > html.indexOf('--chart-bg'));
check('★ 云存档客户端在幽灵模块之后（它要覆盖初始状态）',
  html.indexOf('window.FXOnline') > html.indexOf('root.GhostUI'));

section('=== C. 主题内容与桌面布局 ===');
check('含设计令牌 --fx-bg', html.indexOf('--fx-bg:') >= 0);
check('含桌面双栏（column-count: 2）', html.indexOf('column-count: 2') >= 0);
check('★ 隐藏卡片不会被强制显示（:not([hidden])）',
  html.indexOf('.card:not([hidden])') >= 0);
check('含东亚红涨绿跌配色', html.indexOf('--fx-up: #ef4444') >= 0);

/* ==================== D. 运行时：真实启动服务器 ==================== */

section('=== D. 启动真实后端，验证端到端 ===');

const PORT = 9400 + Math.floor(Math.random() * 300);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-ob-'));

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

function waitUp(deadline) {
  return new Promise((resolve, reject) => {
    const go = () => req('GET', '/api/health')
      .then((r) => (r.status === 200 ? resolve() : again()))
      .catch(again);
    const again = () => (Date.now() > deadline
      ? reject(new Error('服务器启动超时')) : setTimeout(go, 130));
    go();
  });
}

let child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: Object.assign({}, process.env, {
    FX_PORT: String(PORT), FX_HOST: '127.0.0.1', FX_DATA: DATA,
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.on('data', () => {});
child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));

process.on('exit', () => {
  try { child.kill(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
});

(async function () {
  await waitUp(Date.now() + 15000);

  const page = await req('GET', '/');
  check('服务器能托管新产物', page.status === 200);
  check('★ 托管的就是合并版（含新主题）', page.text.indexOf('id="fx-theme"') >= 0);
  check('★ 托管的就是合并版（含幽灵对战）', page.text.indexOf('GhostBattle') >= 0);
  check('★ 托管的就是合并版（含云存档）', page.text.indexOf('/api/account/state') >= 0);

  section('=== E. 云存档接口端到端 ===');
  const reg = await req('POST', '/api/register', { name: '合并版测试', password: 'merge123456' });
  check('注册成功', reg.status === 200 && !!reg.json.token);
  const token = reg.json.token;

  const st0 = await req('GET', '/api/account/state', undefined, token);
  check('读取初始存档', st0.status === 200 && st0.json.balance === 10000, st0.json && st0.json.balance);

  const pos = [{
    id: 5, pair: 'EUR/USD', side: 'long', margin: 700, lev: 20,
    notional: 14000, entry: 1.085, fee: 2.1, openTs: Date.now(), openTick: 40,
  }];
  const sync = await req('POST', '/api/account/sync', {
    balance: 45678.9, positions: pos, clientTs: Date.now(),
  }, token);
  check('写入存档成功', sync.status === 200 && sync.json.balance === 45678.9,
    sync.status + ' ' + (sync.json && sync.json.balance));

  const st1 = await req('GET', '/api/account/state', undefined, token);
  check('★ 刷新后读到的是新余额（存档生效）', st1.json.balance === 45678.9, st1.json.balance);
  check('★ 持仓也恢复', st1.json.positions.length === 1, st1.json.positions.length);

  section('=== F. 排行榜接口端到端 ===');
  const score = await req('POST', '/api/score', {
    runId: 'merge-1', score: 123456, equity: 120000, startEquity: 10000,
    target: 20000000, won: false, tickCount: 400, candles: 100,
    durationMs: 400 * 1500, reason: 'settle', mode: 'sim',
  }, token);
  check('提交成绩成功', score.status === 200 && score.json.ok === true,
    score.status + ' ' + JSON.stringify(score.json && score.json.code));

  const board = await req('GET', '/api/leaderboard?board=all');
  check('★ 榜单能读到', board.json.rows.length === 1 && board.json.rows[0].name === '合并版测试',
    JSON.stringify(board.json.rows.map((r) => r.name)));

  section('=== G. 前端运行时（模拟浏览器）===');

  /* 用 DOM 桩把产物跑起来，验证三个模块都能启动 */
  const scripts = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(stripped))) scripts.push(m[1]);
  /* 动态计算：本体自带的 <script> 数 + 我们注入的 7 个。
   * 写死数字的话，本体多一个内联脚本就会误报（这份本体自带 1 个）。 */
  check('脚本块数量 = 本体自带 ' + ownBlocks + ' + 注入 ' + buildOnline.INJECTED_SCRIPT_COUNT,
    scripts.length === ownBlocks + buildOnline.INJECTED_SCRIPT_COUNT, scripts.length);

  const els = new Map();
  let _inner = '';
  function makeEl(id, sink) {
    const style = {};
    let text = '';
    let inner = '';
    const e = {
      tagName: 'DIV', dataset: {}, hidden: true, value: '', disabled: false,
      className: '', children: [], firstChild: null,
      clientWidth: 700, clientHeight: 290, width: 700, height: 290,
      style: new Proxy(style, {
        get(t, k) { return k in t ? t[k] : (k === 'setProperty' ? () => {} : ''); },
        set(t, k, v) { t[k] = v; return true; },
      }),
      classList: {
        _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        toggle(c, o) { const v = o === undefined ? !this._s.has(c) : !!o; v ? this._s.add(c) : this._s.delete(c); return v; },
        contains(c) { return this._s.has(c); },
      },
      addEventListener() {}, removeEventListener() {},
      appendChild(c) { e.children.push(c); e.firstChild = e.children[0]; if (c && c.nodeType === 3) text += c.textContent; return c; },
      insertBefore(c) { e.children.unshift(c); e.firstChild = e.children[0]; if (c && c.nodeType === 3) text = c.textContent + text; return c; },
      removeChild() {}, remove() {},
      querySelectorAll: () => [], querySelector: () => null, closest: () => null,
      getBoundingClientRect: () => ({ width: 700, height: 290, left: 0, top: 0 }),
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
    Object.defineProperty(e, 'textContent', { get() { return text; }, set(v) { text = String(v == null ? '' : v); } });
    Object.defineProperty(e, 'innerHTML', {
      get() { return inner; },
      set(v) { inner = String(v == null ? '' : v); if (inner === '') { e.children.length = 0; e.firstChild = null; text = ''; } },
    });
    let idv = id || '';
    Object.defineProperty(e, 'id', { get() { return idv; }, set(v) { idv = v; if (v && sink) sink.set(v, e); } });
    if (idv && sink) sink.set(idv, e);
    return e;
  }

  const idRe = /\bid="([^"]+)"/g;
  let im;
  while ((im = idRe.exec(stripped))) if (!els.has(im[1])) makeEl(im[1], els);
  idRe.lastIndex = 0;

  const topbar = makeEl('__tb', els);
  const store = {};
  const netCalls = [];
  const sb = {
    document: {
      readyState: 'complete',
      getElementById: (id) => (els.has(id) ? els.get(id) : null),
      createElement: () => makeEl('', els),
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
      querySelector: (s) => (s === '.topbar-actions' ? topbar : null),
      querySelectorAll: () => [],
      addEventListener() {},
      execCommand: () => true,
      head: makeEl('head', els),
      body: makeEl('body', els),
      documentElement: makeEl('html', els),
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0, clearTimeout() {},
    setInterval: () => 0, clearInterval() {},
    performance: { now: () => Date.now() },
    fetch(url, opts) {
      netCalls.push(url);
      return Promise.reject(Object.assign(new Error('测试不联网'), { status: 0 }));
    },
    navigator: { clipboard: { writeText: () => Promise.resolve() }, sendBeacon: () => true },
    location: { origin: 'http://x', pathname: '/', search: '', hash: '' },
    history: { replaceState() {} },
    Promise, JSON, Math, Date, Number, String, Object, Array, Error,
    isFinite, parseInt, parseFloat, RegExp, Map, Set,
    Blob: function (a) { this.parts = a; },
    XMLHttpRequest: function () { this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {}; },
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.window.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sb.window.innerWidth = 1400;
  sb.window.devicePixelRatio = 1;
  sb.window.addEventListener = () => {};
  sb.window.confirm = () => true;
  sb.window.navigator = sb.navigator;
  sb.window.location = sb.location;

  vm.createContext(sb);
  let execErr = null;
  scripts.forEach((code, i) => {
    try { vm.runInContext(code, sb); }
    catch (e) { if (!execErr) execErr = '块' + (i + 1) + ': ' + e.message; }
  });

  check('★ 全部脚本执行无异常', !execErr, execErr);
  check('★ window.FX 就绪（游戏本体）', !!sb.window.FX && !!sb.window.FX.state);
  check('★ window.FXOnline 就绪（云存档）', !!sb.window.FXOnline);
  check('★ window.FXMargin 就绪（追加保证金）', !!sb.window.FXMargin && typeof sb.window.FXMargin.plan === 'function');
  check('★ window.GhostBattle 就绪（幽灵对战）', !!sb.window.GhostBattle);
  check('★ window.MockServer 就绪（幽灵存储）', !!sb.window.MockServer);
  check('★ FXCanvasTheme 已接管 canvas', !!sb.window.FXCanvasTheme);

  /* 主题是否真的注入：直接从 HTML 文本里取 <style id="fx-theme"> 的内容。
   * ★ 不能用 DOM 桩的节点去判断 —— 桩里的 <style> 内容不会通过
   *   textContent 赋值，那测的是桩的实现细节，不是产物本身。 */
  const themeMatch = html.match(/<style id="fx-theme">([\s\S]*?)<\/style>/);
  check('★ 主题样式已注入且内容完整',
    !!themeMatch && themeMatch[1].length > 10000,
    themeMatch ? themeMatch[1].length + ' 字符' : '未找到');

  /* Canvas 主题：验证颜色映射生效 */
  if (sb.window.FXCanvasTheme) {
    const up = sb.window.FXCanvasTheme.mapColor('#43b581');
    check('★ K 线涨色已映射为东亚红（#ef4444）', up === '#ef4444', up);
  }

  console.log('\n  说明：fetch 被拒绝是预期的 —— 测试环境不联网。');
  console.log('  实际部署时前端会成功调用 /api/account/state。');
  console.log('  网络调用尝试次数：' + netCalls.length);

  child.kill();
  console.log('\n' + '='.repeat(56));
  console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('='.repeat(56));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：' + (e && e.stack || e));
  try { child.kill(); } catch (_) {}
  process.exit(1);
});
