/*
 * 桌面端布局测试：验证双栏排版在各分辨率下正确。
 *
 * 检查项：
 *   ① 断点行为：≥1180 两列，<1180 单列
 *   ② 填充率：内容是否铺满容器（低了说明右侧留白）
 *   ③ 无重叠：两栏卡片不能互相盖住
 *   ④ 顶栏横跨两列
 *   ⑤ 图表宽度不超过游戏的 CHART_MAX_W
 *   ⑥ CSS 里没有会导致溢出的固定列宽
 *
 * 运行： node test/desktop-layout.js
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/* 测试对象改成 public/index.html（线上托管的那份；dist-ghost 已不再保留） */
const PAGE = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/');
const THEME = path.join(ROOT, 'src', 'theme-fx.css');

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

const css = fs.readFileSync(THEME, 'utf8');

/* ==================== A. 静态检查 ==================== */

section('=== A. CSS 层面 ===');
check('存在 ≥1180px 的桌面断点', /@media\s*\(min-width:\s*1180px\)/.test(css));
check('★ 使用 Multi-column（column-count: 2）',
  /column-count:\s*2\s*!important/.test(css));
check('★ 卡片设置了 break-inside: avoid（不被从中间截断）',
  /break-inside:\s*avoid/.test(css));
check('★ 顶栏 column-span: all（横跨两列）',
  /column-span:\s*all/.test(css));
check('有 column-fill 声明', /column-fill:\s*balance/.test(css));

/* 关键：不能再用固定 px 列宽（之前试过 760px 导致溢出）。
 * ★ 必须先剥离注释 —— 注释里写了"grid-template-columns: 760px 1fr"
 *   作为反例说明，直接匹配会误报（这个坑踩过一次）。 */
function stripCssComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '');
}
const cssNoComment = stripCssComments(css);
const hasFixedGridCols = /grid-template-columns:\s*\d{3,}px/.test(cssNoComment);
check('★ 没有固定 px 列宽（避免窄容器溢出）', !hasFixedGridCols,
  hasFixedGridCols ? '仍有 grid-template-columns: NNNpx' : '');

/* 顺带验证：桌面布局确实用的是 column-count 而不是 grid */
check('桌面布局用的是 column-count（不是 grid-template-columns）',
  /column-count:\s*2/.test(cssNoComment) &&
  !/@media\s*\(min-width:\s*1180px\)[\s\S]{0,400}grid-template-columns/.test(cssNoComment),
  '检查 1180px 媒体查询内是否混用了 grid');

section('=== A2. 隐藏元素的显隐（回归：曾因 display 覆盖而泄漏）===');
/* ★ 这是真实踩过的 bug：
 *   桌面布局为了让 Multi-column 正确排版，给卡片设了
 *   `display: inline-block !important`。
 *   但游戏用 `[hidden] { display: none !important }` 控制显隐 ——
 *   同层 !important 下后出现的规则胜出，于是所有隐藏卡片被强行显示，
 *   "衣柜少了 $150,000"、"挑战模式进度"这类不该出现的板块一直挂在页面上。
 *
 *   修法：用 .card:not([hidden]) 选择器排除隐藏元素。 */
check('★ 卡片 display 规则必须排除 [hidden]（否则隐藏卡片会泄漏）',
  !/\.phone\s*>\s*\.card\s*\{[^}]*display:\s*inline-block\s*!important/.test(cssNoComment),
  '存在无条件 display:inline-block !important');
check('★ 使用了 :not([hidden]) 限定', /\.card:not\(\[hidden\]\)/.test(cssNoComment));
check('★ 显式声明 [hidden] 卡片 display:none',
  /\.card\[hidden\]\s*\{[^}]*display:\s*none\s*!important/.test(cssNoComment));

check('定义了超宽屏断点（≥1560）', /@media\s*\(min-width:\s*1560px\)/.test(css));
check('中等桌面单独调过图表高度',
  /@media\s*\(min-width:\s*1180px\)\s*and\s*\(max-width:\s*1360px\)/.test(css));

/* ==================== B. 运行时测量 ==================== */

function waitTarget(port, deadline) {
  return new Promise((resolve) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          let list = [];
          try { list = JSON.parse(s); } catch (e) { list = []; }
          const t = (list || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
          if (t) return resolve(t);
          retry();
        });
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

const measureFn = function () {
  const phone = document.querySelector('.phone');
  if (!phone) return { error: 'no phone' };
  const pcs = getComputedStyle(phone);
  const pr = phone.getBoundingClientRect();
  const kids = Array.prototype.slice.call(phone.children);
  const vis = [];
  kids.forEach(function (el) {
    if (el.hidden) return;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    vis.push({
      cls: (el.className || '').split(/\s+/).filter(function (c) { return c && c !== 'card'; }).join('.'),
      x: Math.round(r.left), y: Math.round(r.top),
      w: Math.round(r.width), h: Math.round(r.height),
      isTop: el.classList.contains('topbar'),
    });
  });

  /* 重叠检测 */
  const overlaps = [];
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      const a = vis[i], b = vis[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) overlaps.push(a.cls + ' × ' + b.cls);
    }
  }

  /* 分栏：按 x 聚类 */
  const xs = Array.from(new Set(vis.map(function (o) { return o.x; }))).sort(function (a, b) { return a - b; });
  const cols = [];
  xs.forEach(function (x) {
    if (cols.indexOf(x) < 0 && !cols.some(function (c) { return Math.abs(c - x) < 40; })) cols.push(x);
  });

  let maxRight = 0;
  vis.forEach(function (o) { if (o.x + o.w > maxRight) maxRight = o.x + o.w; });

  /* 图表实际宽度 */
  const cv = document.querySelector('.chart-wrap canvas');
  const cw = cv ? Math.round(cv.getBoundingClientRect().width) : 0;

  /* 顶栏是否横跨 */
  const top = vis.find(function (o) { return o.isTop; });

  /* ★ 隐藏元素泄漏检测：带 hidden 属性但实际显示出来的元素。
   *   这是最容易漏的一类 bug —— DOM 上 hidden=true，肉眼却看得见。 */
  const leaked = [];
  document.querySelectorAll('[hidden]').forEach(function (el) {
    const cs = getComputedStyle(el);
    if (cs.display !== 'none') {
      const r = el.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) {
        leaked.push((el.id || el.className || el.tagName) + ' display=' + cs.display);
      }
    }
  });

  return {
    leakedHidden: leaked,
    columnCount: pcs.columnCount,
    containerW: Math.round(pr.width),
    cols: cols.map(function (c) { return Math.round(c); }),
    used: Math.round(maxRight - pr.left),
    fillRatio: Math.round((maxRight - pr.left) / pr.width * 100),
    overlaps: overlaps,
    canvasW: cw,
    topWidth: top ? top.w : 0,
    cardCount: vis.length,
  };
};

(async function main() {
  const port = 9200 + Math.floor(Math.random() * 400);
  const userDir = path.join(require('os').tmpdir(), 'fx-dl-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  const target = await waitTarget(port, Date.now() + 20000);
  if (!target) throw new Error('没有可用页面');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WS 失败')));
  });

  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const onMsg = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.id !== myId) return;
      ws.removeEventListener('message', onMsg);
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2600));

  async function measure(width) {
    await rpc('Emulation.setDeviceMetricsOverride', {
      width: width, height: 1000, deviceScaleFactor: 1, mobile: width < 600,
    });
    await new Promise((r) => setTimeout(r, 450));
    const res = await rpc('Runtime.evaluate', {
      expression: '(' + measureFn.toString() + ')()',
      returnByValue: true,
    });
    return res.result.value;
  }

  section('=== B. 断点行为 ===');
  const mDesktop = await measure(1400);

  /* 隐藏元素泄漏 —— 这条最重要，直接对应玩家看到的 bug */
  check('★ 1400px：没有 hidden 元素泄漏（衣柜/挑战卡不应显示）',
    mDesktop.leakedHidden.length === 0, mDesktop.leakedHidden.join(' | '));
  check('1400px：两列', mDesktop.columnCount === '2' && mDesktop.cols.length === 2,
    'columnCount=' + mDesktop.columnCount + ' cols=' + mDesktop.cols.length);
  check('★ 1400px：无重叠', mDesktop.overlaps.length === 0, mDesktop.overlaps.join(', '));
  check('★ 1400px：填充率 ≥90%（右侧无明显留白）',
    mDesktop.fillRatio >= 90, mDesktop.fillRatio + '%');
  check('1400px：顶栏横跨两列（宽度 > 单列宽）',
    mDesktop.topWidth > mDesktop.containerW * 0.9,
    mDesktop.topWidth + ' vs 容器 ' + mDesktop.containerW);

  const mTablet = await measure(1000);
  check('1000px：单列（未触发桌面断点）',
    mTablet.cols.length === 1, 'cols=' + mTablet.cols.length);
  check('1000px：无重叠', mTablet.overlaps.length === 0, mTablet.overlaps.join(', '));

  const mPhone = await measure(390);
  check('★ 390px：没有 hidden 元素泄漏',
    mPhone.leakedHidden.length === 0, mPhone.leakedHidden.join(' | '));
  check('★ 390px：单列，不受桌面布局影响',
    mPhone.cols.length === 1, 'cols=' + mPhone.cols.length);
  check('390px：无重叠', mPhone.overlaps.length === 0, mPhone.overlaps.join(', '));
  check('390px：填充率 ≥90%', mPhone.fillRatio >= 90, mPhone.fillRatio + '%');

  section('=== C. 边界值 ===');
  const mJustBelow = await measure(1179);
  check('1179px：单列（断点下方）', mJustBelow.cols.length === 1,
    'cols=' + mJustBelow.cols.length);

  const mJustAt = await measure(1181);
  check('★ 1181px：没有 hidden 元素泄漏（断点边界也不漏）',
    mJustAt.leakedHidden.length === 0, mJustAt.leakedHidden.join(' | '));
  check('★ 1181px：两列（刚好跨过断点）', mJustAt.cols.length === 2,
    'cols=' + mJustAt.cols.length);
  check('1181px：无重叠', mJustAt.overlaps.length === 0, mJustAt.overlaps.join(', '));

  section('=== D. 宽屏 ===');
  const mWide = await measure(1920);
  check('★ 1920px：没有 hidden 元素泄漏',
    mWide.leakedHidden.length === 0, mWide.leakedHidden.join(' | '));
  check('1920px：两列', mWide.cols.length === 2, 'cols=' + mWide.cols.length);
  check('1920px：无重叠', mWide.overlaps.length === 0, mWide.overlaps.join(', '));
  check('★ 1920px：填充率 ≥90%', mWide.fillRatio >= 90, mWide.fillRatio + '%');
  check('容器有最大宽度上限（不会无限拉宽）',
    mWide.containerW <= 1500, mWide.containerW + 'px');

  section('=== E. 图表宽度约束 ===');
  /* 游戏的 CHART_MAX_W = 760，canvas 不会更宽。
   * 如果布局给的列宽远超 760，canvas 右侧就会留白。 */
  check('★ canvas 宽度 ≤ 760（游戏 CHART_MAX_W）',
    mDesktop.canvasW <= 760, mDesktop.canvasW + 'px');
  check('canvas 宽度合理（>300，不是被压扁）',
    mDesktop.canvasW > 300, mDesktop.canvasW + 'px');

  console.log('\n  实测摘要：');
  console.log('    1400px → ' + mDesktop.cols.length + ' 列 · 填充 ' +
    mDesktop.fillRatio + '% · canvas ' + mDesktop.canvasW + 'px');
  console.log('    1920px → ' + mWide.cols.length + ' 列 · 填充 ' +
    mWide.fillRatio + '% · canvas ' + mWide.canvasW + 'px');
  console.log('    390px  → ' + mPhone.cols.length + ' 列 · 填充 ' +
    mPhone.fillRatio + '%');

  ws.close();
  child.kill();
  console.log('\n' + '='.repeat(52));
  console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  setTimeout(() => process.exit(fail > 0 ? 1 : 0), 250);
})().catch((e) => {
  console.error('测试异常：' + (e && e.stack || e));
  process.exit(1);
});
