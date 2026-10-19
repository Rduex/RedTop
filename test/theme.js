/*
 * 主题验证：确认视觉改造真的生效。
 *
 * 分三类：
 *   A. 静态：主题 CSS 是否真的注入了、是否晚于游戏样式
 *   B. 运行时：Canvas 主题是否真的把旧颜色换成了新色
 *   C. 结构：关键选择器的覆盖是否命中游戏的真实 DOM 类名
 *
 * 运行： node test/theme.js
 */
'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
/* 测试对象改成 public/index.html —— 它才是线上真正托管的那份，
 * 而且同样包含主题 + 幽灵 + 追保 + 云存档（dist-ghost 已不再保留）。 */
const DIST = path.join(ROOT, 'public', 'index.html');
/* 游戏本体的位置由 tools/game-src.js 统一解析（指向仓库根目录的 FX_game.html）——
 * 本体搬家时测试不该跟着挂。 */
const { resolveGameSrc } = require(path.join(ROOT, 'tools', 'game-src.js'));
const GAME = resolveGameSrc();
if (!GAME) {
  console.error('找不到游戏本体（FX_game.html）。先确认它随仓库提交了。');
  process.exit(1);
}
const THEME = path.join(ROOT, 'src', 'theme-fx.css');
const CANVAS = path.join(ROOT, 'src', 'theme-canvas.js');

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
const themeCss = fs.readFileSync(THEME, 'utf8');
const gameHtml = fs.readFileSync(GAME, 'utf8');

/* ==================== A. 静态检查 ==================== */

section('=== A. 主题注入位置 ===');
const headEnd = html.indexOf('</head>');
const themeIdx = html.indexOf('id="fx-theme"');
const canvasIdx = html.indexOf('FXCanvasTheme');

check('主题样式已注入', themeIdx > 0);
check('★ 主题样式在 <head> 内', themeIdx > 0 && themeIdx < headEnd, themeIdx + ' < ' + headEnd);
check('★ Canvas 主题在 <head> 内（早于游戏执行）',
  canvasIdx > 0 && canvasIdx < headEnd, canvasIdx + ' < ' + headEnd);

/* 主题必须在游戏自带样式之后 */
const gameStyleEnd = gameHtml.indexOf('</style>');
const firstCssVar = html.indexOf('--chart-bg');
check('★ 主题样式排在游戏自带样式之后（覆盖才生效）',
  themeIdx > firstCssVar, themeIdx + ' > ' + firstCssVar);

section('=== B. 设计令牌完整性 ===');
const tokens = [
  '--fx-bg', '--fx-surface', '--fx-text', '--fx-text-2', '--fx-text-3',
  '--fx-up', '--fx-down', '--fx-accent', '--fx-gold', '--fx-purple',
  '--fx-chart-bg', '--fx-chart-grid', '--fx-chart-text',
  '--fx-line', '--fx-shadow', '--fx-font', '--fx-mono',
];
let missing = tokens.filter((t) => themeCss.indexOf(t + ':') < 0 && themeCss.indexOf(t + ' :') < 0);
check('★ 全部设计令牌都已定义', missing.length === 0, missing.join(', '));

check('未使用纯黑背景（OLED 拖影）', themeCss.indexOf('#000000') < 0 &&
  themeCss.indexOf('#000 ') < 0 && !/--fx-bg:\s*#000/.test(themeCss));
check('数字使用等宽表格数字', themeCss.indexOf('tabular-nums') >= 0);
check('定义了涨/跌语义色', /--fx-up:\s*#[0-9a-f]{6}/i.test(themeCss) &&
  /--fx-down:\s*#[0-9a-f]{6}/i.test(themeCss));

section('=== C. 关键区域都被覆盖 ===');
/* 这些类名必须真实存在于游戏 DOM 中，否则覆盖是空转 */
const gameClasses = [
  'topbar', 'account-card', 'market-card', 'chart-wrap', 'order-card',
  'positions-card', 'log-card', 'loan-card', 'loan-grid', 'loan-cell',
  'loan-actions', 'intel-card', 'intel-repu', 'im-tabs', 'im-tab',
  'im-lv', 'im-lv-top', 'im-lv-name', 'im-lv-price', 'im-lv-desc',
  'im-lv-stats', 'im-lv-actions', 'im-buy-btn', 'modal-panel',
  'modal-head', 'modal-ok', 'btn-ghost', 'cs-row', 'ghost-btn',
];
let notCovered = gameClasses.filter((c) => themeCss.indexOf('.' + c) < 0);
check('★ 所有关键区域都有主题覆盖', notCovered.length === 0, notCovered.join(', '));

/* 反向：主题里引用的类，游戏里必须真的有，否则是死代码 */
let deadSelectors = [];
gameClasses.forEach((c) => {
  const inGame = new RegExp('class="[^"]*\\b' + c + '\\b').test(gameHtml) ||
    new RegExp("class=\\\\?['\"][^'\"]*\\b" + c + '\\b').test(gameHtml) ||
    gameHtml.indexOf(c) >= 0;
  if (!inGame) deadSelectors.push(c);
});
check('★ 覆盖的类名在游戏里真实存在（无死代码）', deadSelectors.length === 0,
  deadSelectors.join(', '));

section('=== D. 移动端适配 ===');
check('有移动端断点（≤640px）', /@media\s*\(max-width:\s*640px\)/.test(themeCss));
check('有超窄屏断点（≤380px）', /@media\s*\(max-width:\s*380px\)/.test(themeCss));
check('有矮屏断点（横屏）', /@media\s*\(max-height:\s*620px\)/.test(themeCss));
check('★ 用 clamp() 做流体字号（不写死 px）',
  (themeCss.match(/clamp\(/g) || []).length >= 5,
  (themeCss.match(/clamp\(/g) || []).length + ' 处');
check('★ 用 minmax(0,1fr) 防止网格溢出',
  (themeCss.match(/minmax\(0,\s*1fr\)/g) || []).length >= 5,
  (themeCss.match(/minmax\(0,\s*1fr\)/g) || []).length + ' 处');
check('长文本用 ellipsis 防溢出',
  (themeCss.match(/text-overflow:\s*ellipsis/g) || []).length >= 4,
  (themeCss.match(/text-overflow:\s*ellipsis/g) || []).length + ' 处');
check('触控目标有最小高度', /min-height:\s*(3[2-9]|4[0-9]|50)px/.test(themeCss));
check('四格在手机上降为两列',
  /\.intel-repu\s*\{\s*grid-template-columns:\s*repeat\(2/.test(themeCss) ||
  themeCss.indexOf('grid-template-columns: repeat(2, minmax(0, 1fr))') >= 0);

section('=== E. 无障碍 ===');
check('尊重 prefers-reduced-motion', /prefers-reduced-motion/.test(themeCss));
check('★ 定义了可见的键盘焦点环', /focus-visible/.test(themeCss) &&
  /outline:\s*2px solid/.test(themeCss));
check('选中文字有配色', /::selection/.test(themeCss));
check('对比度：正文色足够亮', (function () {
  const m = themeCss.match(/--fx-text:\s*(#[0-9a-f]{6})/i);
  if (!m) return false;
  const hex = m[1].slice(1);
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  /* 相对亮度（sRGB） */
  const lum = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const L = 0.2126 * lum(r) + 0.7152 * lum(g) + 0.0722 * lum(b);
  const bgM = themeCss.match(/--fx-bg:\s*(#[0-9a-f]{6})/i);
  const bgHex = bgM[1].slice(1);
  const Lb = 0.2126 * lum(parseInt(bgHex.slice(0, 2), 16)) +
    0.7152 * lum(parseInt(bgHex.slice(2, 4), 16)) +
    0.0722 * lum(parseInt(bgHex.slice(4, 6), 16));
  const ratio = (Math.max(L, Lb) + 0.05) / (Math.min(L, Lb) + 0.05);
  console.log('       正文/背景对比度 = ' + ratio.toFixed(1) + ':1');
  return ratio >= 7;   // AAA 标准
})());

/* ==================== F. Canvas 主题运行时验证 ==================== */

section('=== F. Canvas 颜色映射 ===');
const canvasApi = require(CANVAS);

check('#0f312c（旧图表底）→ 新深蓝黑', canvasApi.mapColor('#0f312c') === '#0b1220',
  canvasApi.mapColor('#0f312c'));
check('#1d4a43（旧网格）→ 淡中性网格', !!canvasApi.mapColor('#1d4a43'),
  canvasApi.mapColor('#1d4a43'));
check('#9ed3c7（旧轴文字）→ 中性灰蓝', canvasApi.mapColor('#9ed3c7') === '#7d8ca3',
  canvasApi.mapColor('#9ed3c7'));
check('★ #e9c552（旧当前价线，黄）→ 品牌蓝', canvasApi.mapColor('#e9c552') === '#4f8cff',
  canvasApi.mapColor('#e9c552'));

section('=== F2. 涨跌配色：界面与 K 线必须一致 ===');
/* 最关键的一致性检查：
 * CSS 里 --fx-up 是涨色，Canvas 里 #43b581（游戏原本的涨色）也必须映射到同一色相。
 * 否则会出现"界面红涨、K 线绿涨"的自相矛盾 —— 那是最致命的体验问题。 */
const cssUp = (themeCss.match(/--fx-up:\s*(#[0-9a-f]{6})/i) || [])[1];
const cssDown = (themeCss.match(/--fx-down:\s*(#[0-9a-f]{6})/i) || [])[1];
const canvasUp = canvasApi.mapColor('#43b581');     // 游戏原本的"涨"色
const canvasDown = canvasApi.mapColor('#e0756e');   // 游戏原本的"跌"色

console.log('       CSS    涨=' + cssUp + '  跌=' + cssDown);
console.log('       Canvas 涨=' + canvasUp + '  跌=' + canvasDown);

check('★ Canvas 的"涨"色 = CSS 的 --fx-up',
  String(canvasUp).toLowerCase() === String(cssUp).toLowerCase(),
  canvasUp + ' vs ' + cssUp);
check('★ Canvas 的"跌"色 = CSS 的 --fx-down',
  String(canvasDown).toLowerCase() === String(cssDown).toLowerCase(),
  canvasDown + ' vs ' + cssDown);
check('默认东亚惯例：涨=红、跌=绿',
  String(cssUp).toLowerCase() === '#ef4444' && String(cssDown).toLowerCase() === '#22c55e',
  cssUp + ' / ' + cssDown);

section('=== F3. 调色板可切换 ===');
check('提供 east / intl 两套调色板',
  !!canvasApi.PALETTES.east && !!canvasApi.PALETTES.intl);
check('east：涨=红', canvasApi.PALETTES.east['#43b581'] === '#ef4444',
  canvasApi.PALETTES.east['#43b581']);
check('intl：涨=绿', canvasApi.PALETTES.intl['#43b581'] === '#22c55e',
  canvasApi.PALETTES.intl['#43b581']);
check('提供 setPalette 运行时切换', typeof canvasApi.setPalette === 'function');
check('CSS 里定义了 intl 覆盖块', /html\[data-market="intl"\]/.test(themeCss));

const beforeSwitch = canvasApi.mapColor('#43b581');
canvasApi.setPalette('intl');
const afterSwitch = canvasApi.mapColor('#43b581');
check('★ 切到 intl 后涨色立即变绿', afterSwitch === '#22c55e',
  beforeSwitch + ' → ' + afterSwitch);
canvasApi.setPalette('east');
check('切回 east 后涨色恢复为红', canvasApi.mapColor('#43b581') === '#ef4444',
  canvasApi.mapColor('#43b581'));

section('=== F4. 其余映射 ===');
check('#5fa8f5（多单线）已映射', !!canvasApi.mapColor('#5fa8f5'),
  canvasApi.mapColor('#5fa8f5'));
check('#f08a86（空单线）已映射', !!canvasApi.mapColor('#f08a86'),
  canvasApi.mapColor('#f08a86'));
check('大小写不敏感', canvasApi.mapColor('#0F312C') === '#0b1220',
  canvasApi.mapColor('#0F312C'));
check('未知颜色原样放行（不误伤）', canvasApi.mapColor('#123456') === null,
  canvasApi.mapColor('#123456'));
check('非颜色值不崩', canvasApi.mapColor(null) === null &&
  canvasApi.mapColor(123) === null && canvasApi.mapColor(undefined) === null);

section('=== G. Canvas Proxy 行为 ===');
/* 造一个假 canvas context，验证 Proxy 真的替换了颜色 */
function fakeCtx() {
  return {
    strokeStyle: '#000000',
    fillStyle: '#000000',
    lineWidth: 1,
    font: '10px sans-serif',
    beginPath() { this._calls = (this._calls || 0) + 1; return 'ok'; },
    moveTo() {}, lineTo() {}, stroke() {}, fill() {}, fillRect() {},
    measureText() { return { width: 10 }; },
    save() {}, restore() {}, setLineDash() {}, fillText() {},
  };
}

const proxy = canvasApi._makeStyled(fakeCtx());
proxy.strokeStyle = '#43b581';
check('★ 写入旧涨色 → 实际存的是东亚红', proxy.strokeStyle === '#ef4444',
  proxy.strokeStyle);

proxy.fillStyle = '#e0756e';
check('★ 写入旧跌色 → 实际存的是东亚绿', proxy.fillStyle === '#22c55e',
  proxy.fillStyle);

proxy.strokeStyle = '#1d4a43';
check('★ 写入旧网格色 → 实际存的是淡网格',
  proxy.strokeStyle === 'rgba(148,163,184,.085)', proxy.strokeStyle);

proxy.strokeStyle = '#abcdef';
check('不认识的颜色原样写入', proxy.strokeStyle === '#abcdef', proxy.strokeStyle);

proxy.lineWidth = 3;
check('非颜色属性正常透传', proxy.lineWidth === 3, proxy.lineWidth);

let methodOk = false;
try {
  methodOk = proxy.beginPath() === 'ok';
} catch (e) { methodOk = false; }
check('★ 方法调用正常（this 绑定正确）', methodOk);

proxy.font = 'bold 12px monospace';
check('字体属性正常透传', proxy.font === 'bold 12px monospace', proxy.font);

section('=== H. getContext 接管 ===');
/* 模拟浏览器环境，验证 getContext 被包住 */
const sandbox = {
  HTMLCanvasElement: function HTMLCanvasElement() {},
  console: { log() {}, warn() {}, error() {} },
  Object, Array, String, Number, Error,
};
sandbox.HTMLCanvasElement.prototype.getContext = function () {
  return fakeCtx();
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(CANVAS, 'utf8'), sandbox);

const cvs = new sandbox.HTMLCanvasElement();
const ctx2 = cvs.getContext('2d');
ctx2.strokeStyle = '#43b581';
check('★ 经 getContext 拿到的 ctx 已被染色', ctx2.strokeStyle === '#ef4444',
  ctx2.strokeStyle);

const ctx3 = cvs.getContext('2d');
check('重复 getContext 返回同一实例（不重复包装）', ctx3 === ctx2);

/* ==================== I. 真实游戏 DOM 覆盖抽样 ==================== */

section('=== I. 与真实游戏 DOM 的契合度 ===');
/* 挑几个最容易出问题的：深色主题下如果某些元素没覆盖，会白底黑字很刺眼 */
const criticalSel = [
  ['body', '页面底色', /html,\s*body\s*\{[^}]*background:\s*var\(--fx-bg\)/s],
  ['.card', '卡片底色', /\.card\s*\{[^}]*background:\s*var\(--fx-surface\)/s],
  ['.chart-wrap', 'K线图容器', /\.chart-wrap\s*\{[^}]*background:\s*var\(--fx-chart-bg\)/s],
  ['.modal-panel', '弹窗底', /\.modal-panel\s*\{[^}]*background:\s*var\(--fx-surface\)/s],
  ['.loan-cell', '融资卡数字格', /\.loan-cell\s*\{[^}]*background:\s*var\(--fx-surface-2\)/s],
  ['.im-lv', '情报条目', /\.im-lv\s*\{[^}]*display:\s*grid/s],
];
criticalSel.forEach(([sel, label, re]) => {
  check('★ ' + label + '（' + sel + '）已重绘', re.test(themeCss));
});

/* 检查浅色背景硬编码。
 * ★ 这里要区分"大面积容器底色"和"小控件前景色"：
 *   滑块、选中文字、按钮文字用白色是深色主题的正确做法。
 *   真正会破相的是**卡片/页面/弹窗**这类大面积元素用了白底。
 *   所以按"选择器块"逐个检查，只对容器类选择器报警。 */
function findLightContainerBackgrounds(css) {
  const bad = [];
  /* 粗略按 } 切块，逐块看选择器 */
  const blocks = css.split('}');
  const containerHints = /^\s*(html|body|\.phone|\.card|\.modal|\.modal-panel|\.chart-wrap|\.topbar|\.account-card|\.market-card|\.loan-card|\.intel-card|\.im-lv|\.loan-cell|\.intel-repu-cell)\b/;
  blocks.forEach((blk) => {
    const brace = blk.indexOf('{');
    if (brace < 0) return;
    const selector = blk.slice(0, brace).trim();
    if (!containerHints.test(selector)) return;
    const body = blk.slice(brace);
    if (/background(?:-color)?:\s*#f{0,1}[0-9a-f]{2}(?:[0-9a-f]{3})?\s*(?:!important)?\s*;/i.test(body) &&
        !/var\(--fx-/.test(body)) {
      /* 只报"不是变量"的浅色 */
      const m = body.match(/background(?:-color)?:\s*(#[0-9a-f]{3,8})/i);
      if (m && /^#(f|e)[0-9a-f]/i.test(m[1])) bad.push(selector + ' → ' + m[1]);
    }
  });
  return bad;
}
const lightContainers = findLightContainerBackgrounds(themeCss);
check('★ 容器类元素没有浅色背景硬编码', lightContainers.length === 0,
  lightContainers.slice(0, 3).join(' | '));

/* 白色作为前景/滑块是允许的，这里确认它被正确保留 */
check('滑杆滑块保留白色（深色下的标准做法）',
  /::-webkit-slider-thumb\s*\{[^}]*background:\s*#fff/s.test(themeCss));
check('选中文字用白色前景', /::selection\s*\{[^}]*color:\s*#fff/s.test(themeCss));

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);
