/*
 * 构建体检：确认产物里到底有没有联网模块。
 *
 * 为什么单独写这个：
 *   "模块到底进没进产物"是最容易被误判的一环（本次排查就绕了弯路）。
 *   这个脚本不做静态猜测，只输出可核对的事实：
 *     - 产物有几个脚本块、各自多大
 *     - 联网模块的关键标识是否存在
 *     - 联网模块是否**排在游戏脚本之后**（顺序错了就读不到 window.FX）
 *
 * 运行： node tools/verify-build.js
 * 退出码：0 = 健康，1 = 有问题
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'index.html');
const CLIENT = path.join(ROOT, 'src', 'online-client.js');

let bad = 0;
function ok(label, cond, extra) {
  console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '  → ' + extra : ''));
  if (!cond) bad++;
}

if (!fs.existsSync(OUT)) {
  console.error('❌ 找不到 public/index.html。先跑： node tools/build.js');
  process.exit(1);
}

const html = fs.readFileSync(OUT, 'utf8');
const stripped = html.replace(/<!--[\s\S]*?-->/g, '');

/* 提取脚本块（顺序保留，用于判断先后） */
const blocks = [];
const re = /<script>([\s\S]*?)<\/script>/g;
let m;
while ((m = re.exec(stripped))) blocks.push(m[1]);

console.log('\n=== 产物结构 ===');
console.log('  文件：' + OUT);
console.log('  大小：' + (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1) + ' KB');
console.log('  脚本块：' + blocks.length + ' 个');
blocks.forEach((b, i) => {
  const isClient = b.indexOf('FXOnline') >= 0;
  console.log('    块 ' + (i + 1) + '：' + (b.length / 1024).toFixed(1) + ' KB' +
    (isClient ? '  ← 联网模块' : '  ← 游戏本体'));
});

console.log('\n=== 检查项 ===');
ok('产物含 2 个脚本块（游戏 + 联网模块）', blocks.length === 2, blocks.length + ' 个');
ok('联网模块存在（含 window.FXOnline）',
  blocks.some((b) => b.indexOf('window.FXOnline') >= 0));
ok('联网模块里含存档接口调用（/api/account/state）',
  html.indexOf('/api/account/state') >= 0);
ok('联网模块里含自动同步（/api/account/sync）',
  html.indexOf('/api/account/sync') >= 0);
ok('联网模块里含卸载兜底（sendBeacon）',
  html.indexOf('sendBeacon') >= 0);
ok('游戏本体含 window.FX 导出（模块靠它读状态）',
  blocks.some((b) => b.indexOf('window.FX = {') >= 0));

/* 顺序：联网模块必须排在游戏之后，否则执行时读不到 window.FX */
const clientIdx = blocks.findIndex((b) => b.indexOf('window.FXOnline') >= 0);
const gameIdx = blocks.findIndex((b) => b.indexOf('window.FX = {') >= 0);
ok('联网模块排在游戏脚本之后（否则读不到 window.FX）',
  clientIdx > gameIdx && clientIdx >= 0, '游戏块#' + (gameIdx + 1) + ' → 模块块#' + (clientIdx + 1));

/* 源码与产物是否同步：把源码首尾各取一段，确认都在产物里 */
const src = fs.readFileSync(CLIENT, 'utf8').trim();
const head = src.slice(0, 160);
const tail = src.slice(-160);
ok('产物包含源码的开头（最近一次改动已构建进去）', html.indexOf(head) >= 0);
ok('产物包含源码的结尾（构建完整，没被截断）', html.indexOf(tail) >= 0);

/* 语法自检：把每个脚本块解析一遍 */
const vm = require('vm');
let syntaxOk = true;
blocks.forEach((b, i) => {
  try { new vm.Script(b, { filename: 'block' + (i + 1) + '.js' }); }
  catch (e) { syntaxOk = false; console.log('    块 ' + (i + 1) + ' 语法错误：' + e.message); }
});
ok('所有脚本块语法正确（能解析）', syntaxOk);

console.log('\n' + '='.repeat(50));
if (bad === 0) {
  console.log('✅ 产物健康：联网模块已正确注入');
} else {
  console.log('❌ 发现 ' + bad + ' 个问题，产物不可用');
}
console.log('='.repeat(50) + '\n');
process.exit(bad === 0 ? 0 : 1);
