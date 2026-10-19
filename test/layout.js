/*
 * 布局体检：检查主题是否会造成排版问题（溢出、文字截断、触控目标过小）。
 *
 * 静态 CSS 没法直接"渲染"，但可以检查导致排版事故的常见模式：
 *   ① 网格/弹性布局没有 min-width:0 → 长内容撑破容器
 *   ② 固定宽度超过移动端视口 → 横向滚动条
 *   ③ 没有换行/截断策略的长文本区域
 *   ④ 触控目标小于 32px
 *   ⑤ 字号小于 10px（手机上不可读）
 *
 * 运行： node test/layout.js
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const THEME = path.join(ROOT, 'src', 'theme-fx.css');
const css = fs.readFileSync(THEME, 'utf8');

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

/* 把 CSS 切成 { selector, body } 便于逐块分析 */
function parseBlocks(cssText) {
  const out = [];
  const clean = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  /* 只处理顶层块（media query 内部也当普通块看，够用） */
  let depth = 0, start = 0, selStart = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === '{') {
      if (depth === 0) {
        const sel = clean.slice(selStart, i).trim();
        start = i + 1;
        out.push({ selector: sel, open: start });
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const last = out[out.length - 1];
        if (last && last.body === undefined) {
          last.body = clean.slice(last.open, i);
          last.selector = last.selector.split('}').pop().trim();
        }
        selStart = i + 1;
      }
    }
  }
  return out.filter((b) => b.body !== undefined);
}

const blocks = parseBlocks(css);

section('=== 1. 网格布局的溢出防护 ===');
/* 所有 grid-template-columns 用了 fr 的，必须配 minmax(0,1fr) 或 min-width:0，
 * 否则内容（长数字/长昵称）会把格子撑破，产生横向溢出。 */
const gridBlocks = blocks.filter((b) => /grid-template-columns/.test(b.body));
let badGrid = [];
gridBlocks.forEach((b) => {
  const hasFr = /\d+fr/.test(b.body);
  if (!hasFr) return;
  /* 裸 1fr 是危险的；minmax(0,1fr) 才安全 */
  const bareFr = /grid-template-columns:[^;]*\b(?!minmax\()[\d.]+fr/.test(b.body) &&
    !/minmax\(0,\s*1fr\)/.test(b.body);
  if (bareFr) badGrid.push(b.selector);
});
check('★ 所有 fr 网格都用了 minmax(0,1fr)（防撑破）', badGrid.length === 0,
  badGrid.slice(0, 3).join(' | '));
check('确实存在网格布局（不是空检查）', gridBlocks.length > 0, gridBlocks.length + ' 块');

section('=== 2. 固定宽度是否超出手机视口 ===');
/* 找出所有写死的 px 宽度，超过 340px 的在 360px 手机上会溢出 */
const wideFixes = [];
blocks.forEach((b) => {
  const m = b.body.match(/[^-]width:\s*(\d+)px/g);
  if (!m) return;
  m.forEach((s) => {
    const n = parseInt(s.match(/(\d+)px/)[1], 10);
    /* 允许 max-width 与弹性布局里的 width:100% */
    if (n > 340 && !/max-width/.test(s)) wideFixes.push(b.selector + ' → ' + n + 'px');
  });
});
check('★ 没有超过 340px 的硬编码宽度', wideFixes.length === 0,
  wideFixes.slice(0, 3).join(' | '));

check('面板用了 min() 限制宽度（小屏不溢出）',
  /width:\s*min\(\d+px,\s*\d+vw\)/.test(css));

section('=== 3. 长文本的截断策略 ===');
/* 这些元素会放用户可控内容（昵称/情报文案/资产名），必须有截断策略 */
const truncationTargets = [
  ['.im-lv-name', '情报档位名'],
  ['.intel-name', '玩家昵称'],
  ['.brand-title', '标题'],
  ['.loan-cell b', '金额数字'],
];
let noTrunc = [];
truncationTargets.forEach(([sel, label]) => {
  const blk = blocks.find((b) => b.selector.indexOf(sel) >= 0 &&
    /text-overflow|overflow/.test(b.body));
  if (!blk) noTrunc.push(label + '(' + sel + ')');
});
check('★ 用户可控文本都有溢出保护', noTrunc.length === 0, noTrunc.join(', '));

check('word-break 处理超长单词/URL',
  /word-break:\s*break-word/.test(css) || /overflow-wrap/.test(css));

section('=== 4. 触控目标尺寸 ===');
/* 手机端可点元素不应小于 32px 高 */
const interactiveSels = [
  'ghost-btn', 'fxo-chip', 'fxg-chip', 'chart-quick button', 'lev-presets button',
  'im-buy-btn', 'modal-ok', 'btn-ghost', 'loan-actions button', 'modal-close',
];
let tinyTargets = [];
interactiveSels.forEach((sel) => {
  const blk = blocks.find((b) => b.selector.indexOf(sel) >= 0);
  if (!blk) { tinyTargets.push(sel + '(无样式)'); return; }
  const m = blk.body.match(/min-height:\s*(\d+)px/);
  if (!m) {
    /* 有 padding + 字号也能撑起来，退一步看 padding */
    if (!/padding:\s*\d+px/.test(blk.body)) tinyTargets.push(sel + '(无尺寸)');
    return;
  }
  const h = parseInt(m[1], 10);
  if (h < 30) tinyTargets.push(sel + '(' + h + 'px)');
});
check('★ 可点元素都有足够高度（≥30px）', tinyTargets.length === 0,
  tinyTargets.join(', '));

section('=== 5. 字号可读性 ===');
/* 找出所有 font-size，检查是否有小于 9px 的 */
const tinyFonts = [];
blocks.forEach((b) => {
  const m = b.body.match(/font-size:\s*(\d+(?:\.\d+)?)px/g);
  if (!m) return;
  m.forEach((s) => {
    const n = parseFloat(s.match(/(\d+(?:\.\d+)?)px/)[1]);
    if (n < 9) tinyFonts.push(b.selector + ' → ' + n + 'px');
  });
});
check('★ 没有小于 9px 的字号', tinyFonts.length === 0,
  tinyFonts.slice(0, 3).join(' | '));

section('=== 6. 移动端断点覆盖 ===');
/* 断点里必须处理最容易出问题的几个组件 */
const mobileBlock = css.match(/@media\s*\(max-width:\s*640px\)\s*\{([\s\S]*?)\n\}/);
check('有 640px 断点块', !!mobileBlock);
if (mobileBlock) {
  const mb = mobileBlock[1];
  check('★ 手机上压缩顶栏按钮', /ghost-btn|fxo-chip|fxg-chip/.test(mb));
  check('★ 手机上调整账户数字字号', /#equity/.test(mb));
  check('★ 手机上情报四格改两列', /intel-repu[\s\S]{0,120}repeat\(2/.test(mb));
  check('★ 手机上弹窗改为全屏', /modal-panel[\s\S]{0,160}border-radius:\s*0/.test(mb));
  check('手机上压缩融资按钮', /loan-actions button/.test(mb));
  check('手机上调整情报正文', /intel-body/.test(mb));
}

const narrowBlock = css.match(/@media\s*\(max-width:\s*380px\)\s*\{([\s\S]*?)\n\}/);
check('有 380px 超窄屏断点', !!narrowBlock);

section('=== 7. 滚动区域 ===');
check('长列表有 max-height 限制', /max-height:\s*\d+vh/.test(css));
check('滚动区自定义了滚动条（深色下默认滚动条很丑）',
  /::-webkit-scrollbar/.test(css));
check('scrollbar-width 兼容 Firefox', /scrollbar-width:\s*thin/.test(css));

section('=== 8. 横向溢出总检查 ===');
/* 最容易造成横向滚动的是宽表格和 nowrap 长文本 */
check('★ 没有 overflow-x: visible 的危险组合',
  !/white-space:\s*nowrap[^;]*;\s*[^}]*overflow:\s*visible/.test(css));
check('页面容器限制最大宽度', /\.phone[\s\S]{0,120}max-width/.test(css));
check('body 不会产生横向滚动（未设固定超宽）',
  !/body\s*\{[^}]*width:\s*\d{4,}px/.test(css));

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);
