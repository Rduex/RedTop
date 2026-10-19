/*
 * 集成测试：产物 + **真实游戏** 一起跑。
 *
 * 前面 test/ghost-e2e.js 用的是假 FX（形状相同但简化过）。
 * 这里换成 game/fx-game.html 里的真游戏，验证：
 *   - 幽灵模块能在真实游戏上启动
 *   - 真开仓/平仓能被录制到
 *   - 挑战链接能生成
 *
 * 运行： node test/ghost-integration.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* 测试对象改成 public/index.html（线上托管的那份；dist-ghost 已不再保留） */
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
const blocks = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(stripped))) blocks.push(m[1]);

/* ---------- DOM 桩 ---------- */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
    key: (i) => Array.from(map.keys())[i] || null,
    get length() { return map.size; },
    _map: map,
  };
}

function boot(hash, sharedStorage) {
  const els = new Map();
  /* makeEl(tag, id)：id 显式传入时直接登记进 els。
   * 之前只靠 id 的 setter 登记，导致 makeEl('chart') 这种"创建时就有 id"
   * 的元素拿不到 —— 游戏在 el.chart.getContext() 处崩了。 */
  function makeEl(tag, idv) {
    const style = {};
    let text = '';
    let inner = '';
    const e = {
      tagName: String(tag || 'div').toUpperCase(), dataset: {}, hidden: true,
      value: '', disabled: false, className: '', children: [], firstChild: null,
      clientWidth: 700, clientHeight: 290, width: 700, height: 290,
      style: new Proxy(style, {
        get(t, k) { return k in t ? t[k] : (k === 'setProperty' ? () => {} : ''); },
        set(t, k, v) { t[k] = v; return true; },
      }),
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
        contains(c) { return this._s.has(c); },
        toggle(c, on) { const v = on === undefined ? !this._s.has(c) : !!on; v ? this._s.add(c) : this._s.delete(c); return v; },
      },
      addEventListener(t2, f) { (e._h = e._h || {}); (e._h[t2] = e._h[t2] || []).push(f); },
      appendChild(c) {
        e.children.push(c); e.firstChild = e.children[0];
        if (c && c.nodeType === 3) text += c.textContent;
        return c;
      },
      insertBefore(c) {
        e.children.unshift(c); e.firstChild = e.children[0];
        if (c && c.nodeType === 3) text = c.textContent + text;
        return c;
      },
      removeChild(c) {
        const i = e.children.indexOf(c);
        if (i >= 0) e.children.splice(i, 1);
        e.firstChild = e.children[0] || null;
        return c;
      },
      remove() {},
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
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
      focus() {}, blur() {},
      click() { (e._h && e._h.click || []).forEach((f) => f()); },
      replaceChildren() { e.children = []; e.firstChild = null; text = ''; },
      select() {},
    };
    let _idv = idv || '';
    Object.defineProperty(e, 'id', {
      get() { return _idv; },
      set(v) { _idv = v; if (v) els.set(v, e); },
      configurable: true,
    });
    /* 构造时带 id 的元素要立刻登记（setter 不会触发） */
    if (_idv) els.set(_idv, e);
    Object.defineProperty(e, 'textContent', {
      get() { return text; },
      set(v) { text = String(v == null ? '' : v); },
    });
    Object.defineProperty(e, 'innerHTML', {
      get() { return inner; },
      set(v) {
        inner = String(v == null ? '' : v);
        if (inner === '') { e.children.length = 0; e.firstChild = null; text = ''; }
      },
    });
    return e;
  }

  const idRe = /\bid="([^"]+)"/g;
  let im;
  while ((im = idRe.exec(stripped))) if (!els.has(im[1])) makeEl("div", im[1]);
  idRe.lastIndex = 0;

  const topbar = makeEl('div');
  topbar.className = 'topbar-actions';
  const body = makeEl('body');
  const head = makeEl('head');

  /* 真实浏览器里同一域名的多个页面共用一份 localStorage。
   * 测试要模拟"打开新标签页"时，必须复用同一份 storage，
   * 否则新页面读不到上一个页面保存的幽灵（测出假的"幽灵不存在"）。 */
  const storage = sharedStorage || makeStorage();
  const ivs = [];

  const sb = {
    document: {
      readyState: 'complete',
      head, body,
      createElement: makeEl,
      createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
      getElementById: (id) => els.get(id) || null,
      querySelector: (s) => (s === '.topbar-actions' ? topbar : null),
      querySelectorAll: () => [],
      addEventListener() {},
      execCommand: () => true,
    },
    console: { log() {}, warn() {}, error() {} },
    setTimeout(f, ms) { return setTimeout(f, 0); },
    clearTimeout: (id) => clearTimeout(id),
    setInterval(f, ms) { ivs.push({ f, ms }); return ivs.length; },
    clearInterval() {},
    requestAnimationFrame: (f) => setTimeout(f, 0),
    performance: { now: () => Date.now() },
    Promise, JSON, Math, Date, Number, String, Object, Array, Error,
    isFinite, parseInt, parseFloat, RegExp, Map, Set, Symbol,
    navigator: { clipboard: { writeText: (t) => { sb._clip = t; return Promise.resolve(); } } },
    location: {
      origin: 'https://example.com', pathname: '/toy/fx/', search: '',
      hash: hash || '',
    },
    history: { replaceState() {} },
    XMLHttpRequest: function () { this.open = () => {}; this.setRequestHeader = () => {}; this.send = () => {}; },
    fetch: () => Promise.reject(new Error('no network')),
  };
  sb.window = sb;
  sb.globalThis = sb;
  sb.window.localStorage = storage;
  sb.window.innerWidth = 400;
  sb.window.devicePixelRatio = 1;
  sb.window.addEventListener = () => {};
  sb.window.confirm = () => true;
  sb.window.location = sb.location;
  sb.window.history = sb.history;
  sb.window.navigator = sb.navigator;

  vm.createContext(sb);
  blocks.forEach((code, i) => {
    try { vm.runInContext(code, sb); }
    catch (e) { console.log('  块 ' + (i + 1) + ' 执行失败：' + e.message); }
  });

  return { sb, els, storage, ivs, body, topbar };
}

(async function main() {
  section('=== 1. 真实游戏 + 幽灵模块一起启动 ===');
  const p = boot('');
  const FX = p.sb.window.FX;
  const GB = p.sb.window.GhostBattle;

  check('★ 真实游戏启动成功（window.FX 存在）', !!FX && !!FX.state);
  check('★ 幽灵桥接启动成功（GhostBattle 存在）', !!GB, GB ? 'yes' : 'no');
  check('MockServer 挂载', !!p.sb.window.MockServer);
  check('Ghost 挂载', !!p.sb.window.Ghost);
  check('GhostUI 挂载', !!p.sb.window.GhostUI);
  check('顶栏出现幽灵入口按钮', !!p.els.get('fxgChip'));

  section('=== 2. 自检输出 ===');
  const sc = GB.selfCheck();
  console.log('');
  console.log(sc.split('\n').map((l) => '     ' + l).join('\n'));
  check('自检标明录制中', /录制中\s*:\s*是/.test(sc), sc.split('\n')[4]);
  check('自检全部模块已加载', !/缺失/.test(sc));

  section('=== 3. 用真实的开仓/平仓驱动录制 ===');
  const ui = GB.ui;
  const rec = ui._state.recorder;
  check('录制器处于活动状态', rec && rec.isActive());

  const nodesBefore = rec.stats().nodes;

  /* 真实游戏的开仓 API */
  FX.state.mode = 'sim';
  FX.state.pair = 'EUR/USD';
  FX.setLev && FX.setLev(20);
  const marginEl = p.els.get('marginInput');
  if (marginEl) marginEl.value = '500';

  FX.openPosition('long');
  const posCount = FX.state.positions.length;
  check('★ 真实游戏开仓成功', posCount >= 1, posCount);

  /* 手动触发一次采样（桥接每 200ms 采一次，测试里直接调） */
  rec.sampleOnce();
  const nodesAfterOpen = rec.stats().nodes;
  check('★ 开仓被录制到', nodesAfterOpen > nodesBefore,
    nodesBefore + ' → ' + nodesAfterOpen);

  const tl1 = rec.timeline();
  const openNode = tl1[tl1.length - 1];
  check('★ 录制节点是 open 动作', openNode && openNode.act === 'open', openNode && openNode.act);
  check('★ 记录了交易对', openNode && openNode.pair === 'EUR/USD', openNode && openNode.pair);
  check('★ 记录了方向', openNode && openNode.side === 'long', openNode && openNode.side);
  check('★ 记录了价格（>0）', openNode && openNode.price > 0, openNode && openNode.price);
  check('★ 记录了余额与权益', openNode && typeof openNode.balance === 'number' &&
    typeof openNode.equity === 'number', openNode && JSON.stringify({
      b: openNode.balance, e: openNode.equity,
    }));

  /* 平仓（真实游戏 API） */
  const pid = FX.state.positions[0] && FX.state.positions[0].id;
  if (pid != null) {
    FX.closePosition(pid);
    rec.sampleOnce();
  }
  const tl2 = rec.timeline();
  check('★ 平仓也被录制到', tl2.length > tl1.length, tl1.length + ' → ' + tl2.length);
  const closeNode = tl2[tl2.length - 1];
  check('★ 最后一个节点是 close', closeNode && closeNode.act === 'close', closeNode && closeNode.act);
  check('★ 平仓节点记录了价格', closeNode && closeNode.price > 0, closeNode && closeNode.price);

  section('=== 4. 时间轴语义 ===');
  const t0 = tl2[0] && tl2[0].t;
  check('★ 第一个节点 t=0（时间轴从 0 开始）', t0 === 0, t0);
  const ts = tl2.map((n) => n.t);
  check('★ 时间单调不减', ts.every((v, i) => i === 0 || v >= ts[i - 1]), ts.join(','));
  check('★ 节点数 ≥ 2（一开一平）', tl2.length >= 2, tl2.length);

  section('=== 5. 生成挑战链接 ===');
  let linkRes = null;
  await new Promise((resolve) => {
    GB.makeLink(function (r) { linkRes = r; resolve(); });
    setTimeout(resolve, 0);
  });

  check('★ 生成链接成功', linkRes && linkRes.ok === true,
    linkRes && (linkRes.error || 'ok'));
  if (linkRes && linkRes.ok) {
    check('★ 返回 matchId', typeof linkRes.matchId === 'string' && linkRes.matchId.length > 0,
      linkRes.matchId);
    check('★ 链接含 #ghost=', linkRes.link.indexOf('#ghost=') >= 0, linkRes.link);
    check('★ 链接格式正确',
      linkRes.link === 'https://example.com/toy/fx/#ghost=' + linkRes.matchId, linkRes.link);
    check('已复制到剪贴板', linkRes.copied === true);
    check('剪贴板内容 = 链接', p.sb._clip === linkRes.link, p.sb._clip);
    check('链接里的节点数 > 0', linkRes.nodes > 0, linkRes.nodes);

    section('=== 6. 打开生成的链接能读到幽灵 ===');
    const g = p.sb.window.MockServer.getGhost(linkRes.matchId);
    check('★ 幽灵可读回', !!g);
    check('★ 幽灵时间轴完整', g && g.timeline.length === linkRes.nodes,
      g && g.timeline.length);
    check('★ 幽灵记录了最终收益', g && typeof g.finalProfit === 'number',
      g && g.finalProfit);

    section('=== 7. 新页面以挑战模式启动 ===');
    const p2 = boot('#ghost=' + linkRes.matchId, p.storage);
    const ui2 = p2.sb.window.GhostBattle && p2.sb.window.GhostBattle.ui;
    check('★ 新页面启动成功', !!ui2);
    const modal = p2.els.get('fxgRoot');
    check('★ 自动弹出挑战确认窗口', !!modal && modal.classList.contains('on'),
      modal ? (modal.classList.contains('on') ? 'shown' : 'hidden') : 'null');
  }

  section('=== 8. 排行榜写入 ===');
  const M = p.sb.window.MockServer;
  M.saveScore('测试员', 1234);
  M.saveScore('强敌', 5678);
  const board = M.getLeaderboard();
  check('★ 排行榜有 2 条', board.length === 2, board.length);
  check('按收益降序', board[0].name === '强敌', board[0].name);

  console.log('\n' + '='.repeat(52));
  console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：' + (e && e.stack || e));
  process.exit(1);
});
