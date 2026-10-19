/*
 * 追加保证金（src/margin-ui.js）的单元测试。
 *
 * 为什么单独写一套 DOM 桩，而不复用 test/online-build.js 那个：
 *   那个桩只为"脚本能跑起来、window.X 存在"服务 —— getElementById 只返回预先
 *   注册过的节点，createElement 不支持 setAttribute，也没有 querySelector 家族。
 *   而这几项恰好是追保模块的核心：往 #positions 里插按钮、按 [data-close] 找仓位 id。
 *   所以这里造一个小而完整的 DOM，让它能在 Node 里真的把 UI 建出来、点一遍。
 *
 * 覆盖的是三类容易出错的地方：
 *   ① 账目口径：预览必须与本体 liqPriceOf/dangerRatio/topUpNeed 一致（不能自己抄公式）
 *   ② 注入：按钮要插到每张持仓卡上、不能重复插、危险度文案要跟着数值走
 *   ③ 交互安全：Enter 必须被拦在输入框里 —— 游戏在 document 上把 INPUT 里的 Enter
 *      绑成了"直接开仓"，漏了这一步就会出现"填金额时按回车，凭空开了一单"
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'margin-ui.js');

let pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { console.log('  ❌ ' + name + (extra ? ' — ' + extra : '')); process.exitCode = 1; }
}
function near(a, b, eps) { return Math.abs(a - b) < (eps || 1e-6); }
function section(t) { console.log('\n' + t); }

/* ------------------------------------------------------------ 最小 DOM */
function makeDom() {
  const registry = new Map();

  function node(tag) {
    const n = {
      tagName: String(tag || 'div').toUpperCase(),
      nodeType: 1,
      id: '', className: '', textContent: '', value: '',
      type: '', placeholder: '', disabled: false, hidden: false,
      style: {}, dataset: {}, attrs: {}, children: [], parentNode: null,
      _ev: {},
      /* ★ classList 必须与 className 同步：真实 DOM 里两者是同一份数据。
       *   桩里如果各存一份，就会出现"className='pos' 但 classList.contains('pos')
       *   为 false"的假阴性 —— 注入逻辑会因此整段被跳过（踩过）。 */
      classList: {
        add(c) { if (!n.classList.contains(c)) n.className = (n.className ? n.className + ' ' : '') + c; },
        remove(c) {
          n.className = String(n.className || '').split(/\s+/).filter((x) => x && x !== c).join(' ');
        },
        contains(c) { return String(n.className || '').split(/\s+/).indexOf(c) >= 0; },
        toggle(c, on) {
          const v = on === undefined ? !n.classList.contains(c) : !!on;
          if (v) n.classList.add(c); else n.classList.remove(c);
          return v;
        },
      },
      setAttribute(k, v) { n.attrs[k] = String(v); if (k === 'id') n.id = String(v); },
      getAttribute(k) { return Object.prototype.hasOwnProperty.call(n.attrs, k) ? n.attrs[k] : null; },
      removeAttribute(k) { delete n.attrs[k]; },
      appendChild(c) { c.parentNode = n; n.children.push(c); return c; },
      removeChild(c) { n.children = n.children.filter((x) => x !== c); return c; },
      insertBefore(c, ref) {
        c.parentNode = n;
        const i = n.children.indexOf(ref);
        if (i < 0) n.children.push(c); else n.children.splice(i, 0, c);
        return c;
      },
      remove() { if (n.parentNode) n.parentNode.removeChild(n); },
      addEventListener(t, fn) { (n._ev[t] = n._ev[t] || []).push(fn); },
      removeEventListener() {},
      focus() { n._focused = true; },
      select() { n._selected = true; },
      contains(x) {
        if (x === n) return true;
        return n.children.some((c) => (c.contains ? c.contains(x) : c === x));
      },
      querySelector(sel) { return findAll(n, sel)[0] || null; },
      querySelectorAll(sel) { return findAll(n, sel); },
      closest(sel) {
        let cur = n;
        while (cur) { if (match(cur, sel)) return cur; cur = cur.parentNode; }
        return null;
      },
      getBoundingClientRect() { return { width: 350, height: 160, left: 0, top: 0 }; },
    };
    return n;
  }

  /* 选择器只支持本模块用到的几类：.cls、#id、[attr]、'a b'（后代） */
  function splitSel(sel) { return String(sel).trim().split(/\s+(?![^\[]*\])/); }
  function matchOne(el, part) {
    if (!el || !el.attrs && !el.className) return false;
    if (part[0] === '.') return String(el.className || '').split(/\s+/).indexOf(part.slice(1)) >= 0;
    if (part[0] === '#') return el.id === part.slice(1);
    if (part[0] === '[') {
      const inner = part.slice(1, -1);
      const eq = inner.indexOf('=');
      if (eq < 0) return el.attrs && Object.prototype.hasOwnProperty.call(el.attrs, inner);
      const k = inner.slice(0, eq);
      const v = inner.slice(eq + 1).replace(/^["']|["']$/g, '');
      return el.attrs && el.attrs[k] === v;
    }
    return String(el.tagName || '').toLowerCase() === part.toLowerCase();
  }
  function match(el, sel) {
    const parts = splitSel(sel);
    if (!matchOne(el, parts[parts.length - 1])) return false;
    if (parts.length === 1) return true;
    let cur = el.parentNode;
    let i = parts.length - 2;
    while (cur && i >= 0) {
      if (matchOne(cur, parts[i])) i--;
      cur = cur.parentNode;
    }
    return i < 0;
  }
  function walk(root, out) {
    root.children.forEach((c) => { out.push(c); walk(c, out); });
    return out;
  }
  function findAll(root, sel) {
    return walk(root, []).filter((el) => match(el, sel));
  }

  const document = {
    readyState: 'complete',
    head: node('head'),
    body: node('body'),
    documentElement: node('html'),
    _ev: {},
    getElementById(id) { return registry.get(id) || null; },
    createElement(t) { return node(t); },
    createTextNode(t) { return { nodeType: 3, textContent: String(t) }; },
    querySelector(sel) { return findAll(document.body, sel)[0] || null; },
    querySelectorAll(sel) { return findAll(document.body, sel); },
    addEventListener(t, fn) { (document._ev[t] = document._ev[t] || []).push(fn); },
    removeEventListener() {},
  };
  document.body.parentNode = document.documentElement;

  return { document, node, registry, findAll };
}

/* ------------------------------------------------------------ 交易口径 */
/* 与游戏本体一致（fx-game.html）：
 *   liqPriceOf(p)  = entry × (1 − margin × m / notional)      （做多）
 *   pnlOf(p)       = (price − entry) / entry × notional       （做多）
 *   dangerRatio(p) = |loss| / (margin × m)
 *   topUpNeed(p)   = |loss| / (m × 0.5) − margin               （追到安全）
 * 这里照抄一份**只用于测试**的参考实现，用来校验"模块算出来的数"对不对。 */
const M = 0.8;
function refPnl(p, price) {
  const dir = p.side === 'long' ? 1 : -1;
  return ((price - p.entry) / p.entry) * p.notional * dir;
}
function refLiq(p) {
  const r = (p.margin * M) / p.notional;
  return p.side === 'long' ? p.entry * (1 - r) : p.entry * (1 + r);
}
function refDanger(p, price) {
  const loss = Math.max(0, -refPnl(p, price));
  return loss / (p.margin * M);
}
function refNeed(p, price) {
  const loss = Math.max(0, -refPnl(p, price));
  const need = loss / (M * 0.5) - p.margin;
  return Math.max(0, Math.round(need * 100) / 100);
}

/* ------------------------------------------------------------ 夹具 */
const market = { price: 1.07 };           // 现价（浮亏）；可变，用来模拟行情推进
const PRICE = market.price;
const POS = {
  id: 7, pair: 'EUR/USD', side: 'long', margin: 500, lev: 20,
  notional: 10000, entry: 1.1, fee: 3, openTs: Date.now(), openTick: 0,
};

/* ------------------------------------------------------------ 主流程 */
(function main() {
  const dom = makeDom();
  const { document, node, registry } = dom;

  /* ---- #positions 里放一张持仓卡（结构照抄本体的 renderPositions） ---- */
  const positions = node('div');
  positions.id = 'positions';
  registry.set('positions', positions);

  const card = node('div');
  card.className = 'pos';
  const actions = node('div');
  actions.className = 'pos-actions';
  const closeBtn = node('button');
  closeBtn.setAttribute('data-close', '7');
  actions.appendChild(closeBtn);
  card.appendChild(actions);
  positions.appendChild(card);

  /* ---- FX 桩：只实现模块真正调用的那几个，其余照本体语义 ---- */
  const calls = { topUp: [], toast: [] };
  const timers = [];                      // 模块注册的定时刷新（每 1.2 秒）
  const state = { positions: [POS], balance: 3500, locked: 500 };
  const FX = {
    state: state,
    digitDigits: () => 5,
    maintOf: () => M,
    pnlOf: (p) => refPnl(p, market.price),
    liqPriceOf: (p) => refLiq(p),
    dangerRatio: (p) => refDanger(p, market.price),
    topUpNeed: (p) => refNeed(p, market.price),
    available: () => state.balance - state.locked,
    topUpPosition(id, amount) {
      const p = state.positions.find((q) => q.id === Number(id));
      if (!p) return 0;
      const want = Math.round((Number(amount) || 0) * 100) / 100;
      const avail = state.balance - state.locked;
      if (!(want > 0) || want > avail) return 0;
      calls.topUp.push({ id: p.id, amount: want });
      p.margin = Math.round((p.margin + want) * 100) / 100;
      state.locked = Math.round((state.locked + want) * 100) / 100;
      return want;
    },
  };

  const sb = {
    document,
    console: { log() {}, warn() {}, error() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    setInterval: (fn) => { timers.push(fn); return timers.length; },
    clearInterval: () => { timers.length = 0; },
    requestAnimationFrame: (fn) => { fn(); return 1; },
    FX,
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);

  const src = fs.readFileSync(SRC, 'utf8');

  section('[1] 源码与产物');
  ok('模块不含 </script（不能内联进 HTML）', !/<\/script/i.test(src));
  ok('模块不自己定义强平公式（必须复用本体 liqPriceOf）',
    !/entry\s*\*\s*\(1\s*-/.test(src.replace(/\/\*[\s\S]*?\*\//g, '')));
  ok('模块调用本体 topUpPosition 而非自行改账', /FX\.topUpPosition\s*\(/.test(src));

  const built = path.join(ROOT, 'public', 'index.html');
  if (fs.existsSync(built)) {
    const html = fs.readFileSync(built, 'utf8');
    const iMargin = html.indexOf('window.FXMargin');
    const iGame = html.indexOf('window.FX = {');
    ok('产物里注入了 window.FXMargin', iMargin > 0);
    ok('追保模块排在游戏本体之后', iMargin > iGame, iMargin + ' vs ' + iGame);
    ok('产物里仍有游戏本体的 topUpPosition', html.indexOf('topUpPosition, topUpSafe') > 0);
  } else {
    ok('产物存在（先跑 node tools/build-online.js）', false, built);
  }

  section('[2] 模块加载');
  let err = null;
  try { vm.runInContext(src, sb); } catch (e) { err = e; }
  ok('★ 执行无异常', !err, err && err.message);
  ok('★ window.FXMargin 已就绪', !!sb.window.FXMargin);
  if (!sb.window.FXMargin) return;

  const FXM = sb.window.FXMargin;

  section('[3] 账目预览与本体口径一致');
  const base = FXM.plan(7, 0);
  ok('取到仓位计划', !!base);
  ok('强平价 = 本体口径', near(base.liqBefore, refLiq(POS), 1e-9), base.liqBefore + ' vs ' + refLiq(POS));
  ok('危险度 ≈ 68.2%', near(base.dangerBefore, refDanger(POS, PRICE), 1e-9), base.dangerBefore);
  ok('补到安全金额 ≈ $181.82', near(base.need, refNeed(POS, PRICE), 0.01), base.need);
  ok('可用余额 = balance − locked = $3000', near(base.available, 3000, 1e-9), base.available);

  const p200 = FXM.plan(7, 200);
  ok('追加 200 后保证金 = 700', near(p200.marginAfter, 700, 1e-9), p200.marginAfter);
  ok('追加 200 后强平价被推远（做多 → 更低）', p200.liqAfter < p200.liqBefore,
    p200.liqBefore + ' -> ' + p200.liqAfter);
  ok('追加 200 后强平价 = 本体口径', near(p200.liqAfter, refLiq(Object.assign({}, POS, { margin: 700 })), 1e-9));
  ok('追加 200 后危险度下降', p200.dangerAfter < p200.dangerBefore,
    p200.dangerBefore + ' -> ' + p200.dangerAfter);
  ok('预览不改动真实仓位（只传浅拷贝）', near(POS.margin, 500, 1e-9), POS.margin);

  section('[4] 持仓卡按钮注入');
  ok('持仓卡上出现追保入口', !!card.querySelector('.fx-margin-row'));
  const row = card.querySelector('.fx-margin-row');
  const openBtn = row && row.children[0];
  ok('按钮文案是「＋ 追加保证金」', !!openBtn && openBtn.textContent.indexOf('追加保证金') >= 0,
    openBtn && openBtn.textContent);
  ok('按钮带 data-fx-margin = 仓位 id', !!openBtn && openBtn.getAttribute('data-fx-margin') === '7',
    openBtn && openBtn.getAttribute('data-fx-margin'));
  ok('按钮类型是 button（不会误触发提交）', !!openBtn && openBtn.type === 'button');
  const hint = row && row.children[1];
  ok('旁边显示危险度百分比', !!hint && /危险度\s*68\.2%/.test(hint.textContent), hint && hint.textContent);

  FXM.injectRows();
  ok('重复注入是幂等的（只有一行）', card.querySelectorAll('.fx-margin-row').length === 1,
    card.querySelectorAll('.fx-margin-row').length);

  section('[5] 弹窗交互');
  ok('初始是关闭的', FXM.isOpen() === false);
  ok('open(7) 成功', FXM.open(7) === true);
  ok('★ 打开后可见', FXM.isOpen() === true);
  ok('当前仓位 id = 7', FXM.currentId() === 7);

  const dialog = registry.size >= 0 ? document.querySelector('.fx-mrg') : null;
  ok('弹窗挂在 body 上', !!dialog && dialog.parentNode === document.body);
  const panel = dialog && dialog.querySelector('.fx-mrg__panel');
  ok('弹窗是带 role=dialog 的五类容器', !!panel && panel.getAttribute('role') === 'dialog');
  ok('aria-modal 已标注', !!panel && panel.getAttribute('aria-modal') === 'true');

  function byId(id) { return document.querySelector('#' + id); }
  const meta = byId('fx-mrg-meta');
  ok('标题行显示货币对与方向', !!meta && meta.innerHTML.indexOf('EUR/USD') >= 0 && meta.innerHTML.indexOf('做多') >= 0,
    meta && meta.innerHTML);
  const input = byId('fx-mrg-amount');
  ok('金额框自动预填「补到安全」的金额', !!input && near(Number(input.value), refNeed(POS, PRICE), 0.01),
    input && input.value);
  ok('金额框是 number 类型（手机弹数字键盘）', !!input && input.type === 'number');
  ok('打开后自动聚焦输入框', !!input && input._focused === true);

  const okBtn = byId('fx-mrg-ok');
  ok('确认按钮文案带金额', !!okBtn && okBtn.textContent.indexOf('181.82') >= 0 || okBtn.textContent.indexOf('181.8') >= 0,
    okBtn && okBtn.textContent);

  section('[6] 输入金额 → 实时预览');
  function type(v) {
    input.value = String(v);
    (input._ev.input || []).forEach((fn) => fn({ target: input }));
  }
  type(200);
  const preview = byId('fx-mrg-preview');
  ok('预览里出现"追加后"的箭头', !!preview && preview.innerHTML.indexOf('→') >= 0, preview && preview.innerHTML);
  ok('预览写明新保证金 $700', preview.innerHTML.indexOf('$700.00') >= 0, preview.innerHTML);
  ok('预览写明强平价从 1.05600 变低', preview.innerHTML.indexOf('1.05600') >= 0, preview.innerHTML);
  ok('确认按钮可用', okBtn.disabled === false);
  ok('确认按钮金额同步为 $200.00', okBtn.textContent.indexOf('$200.00') >= 0, okBtn.textContent);

  type(9999);
  ok('★ 超出可用余额时禁用确认', okBtn.disabled === true);
  const errBox = byId('fx-mrg-err');
  ok('★ 超出余额给出明确原因（含"不够"与差额）',
    errBox.hidden === false && /不够/.test(errBox.textContent) && /\$6,999/.test(errBox.textContent),
    errBox.textContent);

  type(0);
  ok('金额为 0 时禁用确认', okBtn.disabled === true);

  section('[7] Enter / Escape 必须被拦在输入框里');
  /* 这一段是回归重点：游戏在 document 上把 INPUT 里的 Enter 绑成了 openPosition()，
   * 若这里不 stopPropagation，玩家"填完金额按回车"就会凭空开一单。 */
  let stopped = 0, prevented = 0;
  const fakeEv = { key: 'Enter', preventDefault() { prevented++; }, stopPropagation() { stopped++; } };
  const kd = (panel._ev.keydown || []);
  ok('弹窗监听了 keydown', kd.length > 0);
  kd.forEach((fn) => fn(fakeEv));
  ok('★ Enter 被阻止冒泡（不会传到 document 的开仓逻辑）', stopped > 0, 'stopPropagation ×' + stopped);
  ok('★ Enter 同时 preventDefault', prevented > 0);

  let escStopped = 0;
  const escEv = { key: 'Escape', preventDefault() {}, stopPropagation() { escStopped++; } };
  kd.forEach((fn) => fn(escEv));
  ok('Escape 关闭弹窗', FXM.isOpen() === false);
  ok('Escape 同样阻止冒泡', escStopped > 0);

  section('[8] 真正执行追保');
  FXM.open(7);
  type(200);
  const applied = FXM.apply(200);
  ok('★ 调用本体 topUpPosition(7, 200)', calls.topUp.length === 1 &&
    calls.topUp[0].id === 7 && near(calls.topUp[0].amount, 200, 1e-9),
    JSON.stringify(calls.topUp));
  ok('★ 返回实际追加金额 200', near(applied, 200, 1e-9), applied);
  ok('★ 仓位保证金变成 700', near(POS.margin, 700, 1e-9), POS.margin);
  ok('★ 账户占用的保证金同步 +200（=2800 可用前状态）', near(state.locked, 700, 1e-9), state.locked);
  ok('★ 余额不变（钱只是被占用，没有转走）', near(state.balance, 3500, 1e-9), state.balance);
  ok('★ 成功后弹窗自动关闭', FXM.isOpen() === false);

  FXM.open(7);
  type(5000);
  const failed = FXM.apply(5000);
  ok('超出余额时不执行、返回 0', failed === 0 && calls.topUp.length === 1);
  ok('失败时弹窗保持打开，方便改金额', FXM.isOpen() === true);
  FXM.close();

  section('[9] 弹窗开着时数字跟随行情，但不动输入框');
  FXM.open(7);
  ok('打开时注册了定时刷新', timers.length === 1, timers.length);
  type(150);
  const inputBefore = input.value;
  const dangerCell = byId('fx-mrg-stat-danger');
  const dangerTextBefore = dangerCell.textContent;

  market.price = 1.062;      // 行情往不利方向走 → 危险度上升
  timers.slice().forEach((fn) => fn());
  ok('★ 危险度数字已刷新', dangerCell.textContent !== dangerTextBefore,
    dangerTextBefore + ' -> ' + dangerCell.textContent);
  ok('★ 输入框的值没有被覆盖', input.value === inputBefore, input.value);
  ok('刷新后确认按钮金额仍按输入框算', okBtn.textContent.indexOf('$150.00') >= 0, okBtn.textContent);

  market.price = PRICE;      // 复位，避免影响后续断言
  FXM.close();
  ok('关窗后停掉定时刷新', timers.length === 0, timers.length);

  section('[10] 边界：仓位不存在');
  ok('open(999) 返回 false', FXM.open(999) === false);
  ok('plan(999) 返回 null', FXM.plan(999, 100) === null);

  console.log('\n' + (process.exitCode ? '❌ 有断言失败' : '✅ 全部通过') + ' · ' + pass + ' 条断言');
})();
