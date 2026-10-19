/*
 * 幽灵对战端到端测试：录制 → 生成链接 → 打开链接 → 挑战 → 对比 → 胜负。
 *
 * 用 DOM 桩跑真实的 GhostUI + MockServer + Ghost，验证整条链路。
 *
 * 运行： node test/ghost-e2e.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

/* ---------- DOM 桩 ---------- */
function makeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: (k) => { m.delete(k); },
    _map: m,
  };
}

function makeDom() {
  const els = new Map();
  let idSeq = 0;
  function makeEl(tag) {
    const style = {};
    let text = '';
    let inner = '';
    const e = {
      tagName: String(tag || 'div').toUpperCase(), dataset: {}, hidden: false,
      value: '', disabled: false, className: '', children: [], firstChild: null,
      style: new Proxy(style, {
        get(t, k) { return k in t ? t[k] : (k === 'setProperty' ? () => {} : ''); },
        set(t, k, v) { t[k] = v; return true; },
      }),
      classList: {
        _s: new Set(),
        add(c) { this._s.add(c); },
        remove(c) { this._s.delete(c); },
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
        if (c && c.nodeType === 3) text = text.replace(c.textContent, '');
        return c;
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      focus() {}, click() { (e._h && e._h.click || []).forEach((f) => f()); },
    };
    Object.defineProperty(e, 'id', {
      get() { return e._id || ''; },
      set(v) { e._id = v; if (v) els.set(v, e); },
    });
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

  const body = makeEl('body');
  const head = makeEl('head');
  const topbar = makeEl('div');
  topbar.className = 'topbar-actions';

  const document = {
    head, body,
    createElement: makeEl,
    createTextNode: (t) => ({ nodeType: 3, textContent: String(t) }),
    getElementById: (id) => els.get(id) || null,
    querySelector: (s) => (s === '.topbar-actions' ? topbar : null),
    querySelectorAll: () => [],
    execCommand: () => true,
  };
  return { document, els, body, head, topbar };
}

/* ---------- 假游戏 ---------- */
function makeFakeFX() {
  const fx = {
    state: { balance: 10000, locked: 0, positions: [], tickCount: 0, logs: [], seq: 0 },
    books: { 'EUR/USD': { price: 1.0850 }, 'USD/JPY': { price: 150.20 } },
    totalEquity() {
      let float = 0;
      this.state.positions.forEach((p) => {
        const price = this.books[p.pair].price;
        const diff = p.side === 'long' ? price - p.entry : p.entry - price;
        float += (diff / p.entry) * p.notional;
      });
      return this.state.balance + this.state.locked + float;
    },
    open(pair, side, margin, lev, price) {
      this.state.balance -= margin;
      this.state.locked += margin;
      this.state.seq++;
      this.books[pair].price = price;
      const p = {
        id: this.state.seq, pair, side, margin, lev, notional: margin * lev,
        entry: price, fee: 0, openTick: this.state.tickCount,
      };
      this.state.positions.push(p);
      return p;
    },
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
      this.state.logs.unshift({
        t: '12:00:00',
        text: '平仓 ' + p.pair + ' ' + (p.side === 'long' ? '多' : '空') + ' ' + p.lev +
          'x · 保证金 $' + p.margin + ' · 盈亏 ' + (pnl >= 0 ? '+' : '-') + '$' +
          Math.abs(pnl).toFixed(2),
      });
      return pnl;
    },
    tick(n) { this.state.tickCount += (n || 1); },
  };
  return fx;
}

/* ---------- 启动一次"页面" ---------- */
function boot(opts) {
  const o = opts || {};
  const dom = makeDom();
  const storage = o.storage || makeStorage();
  const timers = [];

  const sandbox = {
    document: dom.document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout(f, ms) { timers.push({ f, ms }); return timers.length; },
    clearTimeout() {},
    setInterval(f, ms) { (sandbox._iv = sandbox._iv || []).push({ f, ms }); return sandbox._iv.length; },
    clearInterval() {},
    Promise, JSON, Math, Date, Number, String, Object, Array, Error,
    isFinite, parseInt, parseFloat, RegExp, Map, Set,
    navigator: {
      clipboard: {
        writeText: (t) => { sandbox._clipboard = t; return Promise.resolve(); },
      },
    },
    location: {
      origin: 'https://example.com',
      pathname: '/toy/fx-game/',
      search: '',
      hash: o.hash || '',
    },
    history: {
      replaceState: (a, b, url) => { sandbox._replacedTo = url; },
    },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.window.localStorage = storage;

  vm.createContext(sandbox);

  /* 载入三个模块（按依赖顺序） */
  const files = ['mock-server.js', 'ghost.js', 'ghost-ui.js'];
  files.forEach((f) => {
    const code = fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');
    /* 这些文件是 UMD：用 IIFE 包住后会在 globalThis 上挂载。
     * 在 vm 里没有 module，所以走 root.MockServer = api 分支。 */
    vm.runInContext(code, sandbox);
  });

  const fx = makeFakeFX();
  sandbox.window.FX = fx;

  return { sandbox, dom, fx, storage, timers };
}

(async function main() {
  section('=== 1. 模块在沙箱里正确挂载 ===');
  const p1 = boot({});
  check('MockServer 已挂载', typeof p1.sandbox.window.MockServer === 'object');
  check('Ghost 已挂载', typeof p1.sandbox.window.Ghost === 'object');
  check('GhostUI 已挂载', typeof p1.sandbox.window.GhostUI === 'object');
  check('MockServer 四个核心函数齐全',
    typeof p1.sandbox.window.MockServer.saveScore === 'function' &&
    typeof p1.sandbox.window.MockServer.getLeaderboard === 'function' &&
    typeof p1.sandbox.window.MockServer.saveGhost === 'function' &&
    typeof p1.sandbox.window.MockServer.getGhost === 'function');

  const M1 = p1.sandbox.window.MockServer;
  const G1 = p1.sandbox.window.Ghost;

  section('=== 2. 录制：玩家做两笔交易 ===');
  /* 用真实模块录制 */
  const rec = G1.createRecorder(p1.fx, { pollMs: 1000 });
  rec.start();

  p1.fx.tick(0);
  const pos1 = p1.fx.open('EUR/USD', 'long', 600, 20, 1.0850);
  rec.sampleOnce();

  p1.fx.tick(10);                        // 15 秒后
  p1.fx.books['EUR/USD'].price = 1.0900; // 涨了
  p1.fx.close(pos1.id);
  rec.sampleOnce();

  p1.fx.tick(10);                        // 再 15 秒
  const pos2 = p1.fx.open('USD/JPY', 'short', 400, 25, 150.20);
  rec.sampleOnce();

  p1.fx.tick(10);                        // 再 15 秒
  p1.fx.books['USD/JPY'].price = 150.60; // 做空但涨了 → 亏
  p1.fx.close(pos2.id);
  rec.sampleOnce();

  const tl = rec.timeline();
  check('★ 录制到 4 个节点', tl.length === 4, tl.length);
  check('节点序列：开/平/开/平',
    tl.map((n) => n.act).join(',') === 'open,close,open,close',
    tl.map((n) => n.act).join(','));
  check('★ 时间轴 t = 0,15,30,45',
    tl.map((n) => n.t).join(',') === '0,15,30,45',
    tl.map((n) => n.t).join(','));
  check('节点含价格', tl.every((n) => typeof n.price === 'number' && n.price > 0));
  check('节点含余额与权益', tl.every((n) =>
    typeof n.balance === 'number' && typeof n.equity === 'number'));

  const stats = rec.stats();
  check('stats.profit 反映盈亏', typeof stats.profit === 'number', stats.profit);

  section('=== 3. 保存幽灵并生成链接 ===');
  const h1 = p1.sandbox.window.GhostUI.create({
    fx: p1.fx,
    mock: M1,
    ghostApi: G1,
    getPlayerName: () => '久留美',
  });

  let linkResult = null;
  /* 直接调用 UI 的生成逻辑需要内部 recorder，这里走公开的 generateChallengeLink
   * 但那用的是 UI 自己的录制器。为了可控，改为手动 saveGhost + buildGhostLink 验证链路。 */
  const matchId = M1.saveGhost('久留美', stats.profit, tl, { startEquity: rec.startEquity() });
  check('★ saveGhost 返回 matchId', typeof matchId === 'string' && matchId.length > 0, matchId);

  const link = G1.buildGhostLink(matchId);
  check('★ 链接格式正确', link === 'https://example.com/toy/fx-game/#ghost=' + matchId,
    link);
  check('链接含 #ghost=', link.indexOf('#ghost=') >= 0);

  section('=== 4. 打开链接：解析出幽灵 ===');
  const parsed = G1.parseGhostFromHash('#ghost=' + matchId);
  check('★ 从 hash 解析出 matchId', parsed === matchId, parsed);
  const loaded = M1.getGhost(parsed);
  check('★ 能读回幽灵数据', !!loaded);
  check('幽灵昵称正确', loaded.name === '久留美');
  check('幽灵时间轴完整', loaded.timeline.length === 4, loaded.timeline.length);

  section('=== 5. 挑战确认弹窗 ===');
  const p2 = boot({ hash: '#ghost=' + matchId, storage: p1.storage });
  const M2 = p2.sandbox.window.MockServer;
  const G2 = p2.sandbox.window.Ghost;
  p2.fx.state.balance = 10000;

  const ui2 = p2.sandbox.window.GhostUI.create({
    fx: p2.fx,
    mock: M2,
    ghostApi: G2,
    getPlayerName: () => '挑战者',
  });
  ui2.init();

  const modalRoot = p2.dom.els.get('fxgRoot');
  check('★ URL 带 ghost 参数时自动弹窗', !!modalRoot && modalRoot.classList.contains('on'),
    modalRoot ? 'shown' : 'null');
  check('顶栏出现幽灵入口', !!p2.dom.els.get('fxgChip'));

  const bodyText = (function collect(el2) {
    /* ★ 必须把 innerHTML 也算进文本：
     *   桩里的 innerHTML 赋值不会真的生成子节点（浏览器会），
     *   只读 textContent 会漏掉 info 面板里那段 innerHTML 内容，测出假失败。 */
    let s = (el2.textContent || '') + ' ' + (el2.innerHTML || '');
    (el2.children || []).forEach((c) => { s += ' ' + collect(c); });
    return s;
  })(p2.dom.body);
  check('弹窗里显示了幽灵名字', bodyText.indexOf('久留美') >= 0, bodyText.slice(0, 120).replace(/\s+/g, ' '));
  check('弹窗里显示了最终收益', /\+?\$/.test(bodyText));

  section('=== 6. 接受挑战：对比与飘字 ===');
  /* 找到"接受挑战"按钮并点击 */
  function findButton(root2, label) {
    const stack = [root2];
    while (stack.length) {
      const n = stack.pop();
      if (!n) continue;
      if (n.tagName === 'BUTTON' && (n.textContent || '').indexOf(label) >= 0) return n;
      (n.children || []).forEach((c) => stack.push(c));
    }
    return null;
  }
  const acceptBtn = findButton(p2.dom.body, '接受挑战');
  check('找到"接受挑战"按钮', !!acceptBtn);
  if (acceptBtn) acceptBtn.click();

  const uiState = ui2._state;
  check('★ 进入对战状态', !!uiState.challenge, uiState.challenge ? 'yes' : 'no');
  check('对战对象名字正确', uiState.challenge && uiState.challenge.ghost.name === '久留美');

  /* 推进 tick 到 t=15（幽灵第 2 个节点） */
  p2.fx.tick(10);
  ui2.onTick();
  const floatEl = p2.dom.els.get('fxgRoot') ? null : null;
  /* 飘字元素没有 id，按 class 找 */
  const floats = p2.dom.body.children.filter((c) => c.className && c.className.indexOf('fxg-float') >= 0);
  check('★ 幽灵动作触发飘字', floats.length > 0, floats.length);
  if (floats.length) {
    check('★ 飘字内容描述了幽灵动作', /幽灵|久留美/.test(floats[0].textContent),
      floats[0].textContent);
  }

  /* HUD 应已显示对比 */
  const huds = p2.dom.body.children.filter((c) => c.className && c.className.indexOf('fxg-hud') >= 0);
  check('★ 显示玩家 vs 幽灵对比面板', huds.length > 0, huds.length);
  if (huds.length) {
    check('★ 对比面板含双方金额', /vs/.test(huds[0].innerHTML) || huds[0].innerHTML.indexOf('久留美') >= 0,
      huds[0].innerHTML.slice(0, 100));
  }

  section('=== 7. 胜负判定 ===');
  /* 玩家大赚，理应击败幽灵 */
  p2.fx.state.balance = 20000;
  ui2.onRunEnded();

  const resultText = (function collect(el2) {
    let s = el2.textContent || '';
    (el2.children || []).forEach((c) => { s += ' ' + collect(c); });
    return s;
  })(p2.dom.body);
  check('★ 结算显示"击败"', /击败|略胜|打平/.test(resultText), resultText.slice(0, 160).replace(/\s+/g, ' '));
  check('★ 玩家大赚时判定玩家胜', /击败/.test(resultText), resultText.slice(0, 80).replace(/\s+/g, ' '));

  section('=== 8. 排行榜：对战后留下成绩 ===');
  const board = M2.getLeaderboard();
  check('★ 挑战结束后成绩写入排行榜', board.length > 0, board.length);
  check('排行榜里有挑战者', board.some((b) => b.name === '挑战者'), JSON.stringify(board));

  section('=== 9. 边界：链接失效 ===');
  const p3 = boot({ hash: '#ghost=not-exist-id', storage: makeStorage() });
  const ui3 = p3.sandbox.window.GhostUI.create({
    fx: p3.fx, mock: p3.sandbox.window.MockServer,
    ghostApi: p3.sandbox.window.Ghost, getPlayerName: () => 'X',
  });
  let threw = null;
  try { ui3.init(); } catch (e) { threw = e; }
  check('★ 幽灵不存在时不崩', !threw, threw && threw.message);
  check('也没有进入对战状态', !ui3._state.challenge);

  section('=== 10. 边界：没有 #ghost 参数 ===');
  const p4 = boot({ hash: '', storage: makeStorage() });
  const ui4 = p4.sandbox.window.GhostUI.create({
    fx: p4.fx, mock: p4.sandbox.window.MockServer,
    ghostApi: p4.sandbox.window.Ghost, getPlayerName: () => 'Y',
  });
  let threw4 = null;
  try { ui4.init(); } catch (e) { threw4 = e; }
  check('正常启动不崩', !threw4, threw4 && threw4.message);
  check('★ 没有自动弹挑战窗口', !ui4._state.challenge);
  const root4 = p4.dom.els.get('fxgRoot');
  check('弹窗未显示', !root4 || !root4.classList.contains('on'));

  console.log('\n' + '='.repeat(52));
  console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：' + (e && e.stack || e));
  process.exit(1);
});
