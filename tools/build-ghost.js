/*
 * 构建「幽灵对战版」——纯静态、零后端、单文件。
 *
 * 这是"Toy SDK 未下发、Railway 即将停用"期间的过渡形态：
 *   - 排行榜与幽灵全部走 localStorage（MockServer）
 *   - 不含任何网络请求
 *   - 产物是一个可直接双击打开的单文件
 *
 * 运行： node tools/build-ghost.js
 * 输出： dist-ghost/index.html
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-ghost');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

/* 候选路径统一来自 tools/game-src.js（四个构建脚本共用一份，避免漂移） */
const { CANDIDATES, resolveGameSrc, describeSource, warnIfOutsideRepo } = require('./game-src');
const { stripPreviousInjections, describeRemoved, toLF } = require('./inject-guard');

function read(file, label) {
  if (!fs.existsSync(file)) throw new Error('找不到' + label + '：' + file);
  return fs.readFileSync(file, 'utf8');
}

function stripComments(code) {
  let out = code.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');
  return out;
}

function main() {
  const gameSrc = resolveGameSrc();
  if (!gameSrc) throw new Error('找不到游戏源文件。已尝试：\n' + CANDIDATES.join('\n'));
  warnIfOutsideRepo(gameSrc);

  const game = read(gameSrc, '游戏单文件');

  /* ★ 幂等注入：本体若本身就是合并产物（自带主题/幽灵模块），先剥离再注入。 */
  const guarded = stripPreviousInjections(game);
  const bodyHtml = guarded.html;
  if (guarded.removed.length) {
    console.log('  已剥离本体里已有的注入块：' + describeRemoved(guarded.removed));
  }

  const mock = read(path.join(ROOT, 'src', 'mock-server.js'), 'MockServer');
  const ghost = read(path.join(ROOT, 'src', 'ghost.js'), '幽灵模块');
  const ui = read(path.join(ROOT, 'src', 'ghost-ui.js'), '幽灵界面');
  const bridge = read(path.join(ROOT, 'src', 'ghost-bridge.js'), '桥接模块');
  const themeCss = read(path.join(ROOT, 'src', 'theme-fx.css'), '主题样式');
  const themeCanvas = read(path.join(ROOT, 'src', 'theme-canvas.js'), 'Canvas 主题');

  /* 内联安全：不能含 </style> / </script */
  const pieces = { mock, ghost, ui, bridge, themeCanvas };
  for (const k of Object.keys(pieces)) {
    if (/<\/script/i.test(pieces[k])) throw new Error(k + ' 含 </script，不能内联');
  }
  if (/<\/style/i.test(themeCss)) throw new Error('theme-fx.css 含 </style>，不能内联');
  if (!/<\/body>/i.test(game)) throw new Error('游戏源文件里找不到 </body>');
  if (!/<\/head>/i.test(game)) throw new Error('游戏源文件里找不到 </head>');

  /* ---------- 注入顺序（这里有个容易踩的坑）----------
   *
   * 游戏的 <script> 在 <body> 里，而我们习惯把注入块追加在 </body> 前。
   * 那样游戏会**先执行**，等 Canvas 主题装上去时，画布已经用默认颜色画过了 ——
   * 之后虽然每次重绘都会走新主题，但首帧是旧的，而且 getContext 的接管
   * 在语义上就"晚了一步"。
   *
   * 正确做法：把 Canvas 主题单独塞进 <head>。
   *   - <head> 里的脚本在 <body> 解析之前执行 → 一定早于游戏
   *   - 它只做一件事：包住 HTMLCanvasElement.prototype.getContext
   *   - 不依赖 DOM，所以在 head 里执行是安全的
   *
   * 主题 CSS 同样进 <head>，且必须排在游戏自带 <style> **之后**才能覆盖。
   * 游戏的 <style> 也在 <head> 里，所以把我们的 <style> 插在 </head> 前即可。 */
  const headBlock = [
    '',
    '<!-- ============ FX 主题（构建时注入）============',
    '     ① Canvas 主题：必须最先执行，抢先接管 canvas.getContext',
    '     ② 主题样式：必须排在游戏自带样式之后才能覆盖',
    '     =============================================== -->',
    '<script>',
    '/* ---- Canvas 主题（早于游戏执行）---- */',
    themeCanvas.trim(),
    '</script>',
    '<style id="fx-theme">',
    themeCss.trim(),
    '</style>',
    '',
  ].join('\n');

  const styled = bodyHtml.replace(/<\/head>/i, () => headBlock + '</head>');
  if (styled === bodyHtml) throw new Error('注入 head 块失败');

  const inject = [
    '',
    '<!-- ==================== FX · 幽灵对战版（构建时注入）====================',
    '     纯前端：排行榜与幽灵全部存在 localStorage，不含任何网络请求。',
    '     视觉：交易终端风格（K线/行情）+ 社交媒体信息流风格（情报市场）。',
    '     =================================================================== -->',
    '<script>',
    '/* ---- MockServer：localStorage 假后端 ---- */',
    mock.trim(),
    '</script>',
    '<script>',
    '/* ---- Ghost：录制与回放 ---- */',
    ghost.trim(),
    '</script>',
    '<script>',
    '/* ---- GhostUI：界面 ---- */',
    ui.trim(),
    '</script>',
    '<script>',
    '/* ---- 桥接：把幽灵挂到游戏生命周期 ---- */',
    bridge.trim(),
    '</script>',
    '',
  ].join('\n');

  /* ★ 函数式替换：字符串形式的 $' 会展开成"匹配后全文" */
  const out = styled.replace(/<\/body>/i, () => inject + '\n</body>');
  if (out === styled) throw new Error('注入失败');

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, out, 'utf8');

  /* ---------- 校验 ---------- */
  const stripped = out.replace(/<!--[\s\S]*?-->/g, '');
  const noComments = stripComments(stripped);

  const net = [];
  if (/\bfetch\s*\(/.test(noComments)) net.push('fetch(');
  if (/XMLHttpRequest/.test(noComments)) net.push('XMLHttpRequest');
  if (/navigator\.sendBeacon/.test(noComments)) net.push('sendBeacon');
  if (/new\s+WebSocket\s*\(/.test(noComments)) net.push('WebSocket');
  if (/['"`]\/api\//.test(noComments)) net.push('/api/ 路径');
  if (net.length) throw new Error('产物里仍有网络调用：' + net.join(', '));

  const abs = [];
  const attrRe = /\b(?:src|href)\s*=\s*["'](\/[^"']*)["']/gi;
  let m;
  while ((m = attrRe.exec(stripped))) abs.push(m[1]);
  if (abs.length) throw new Error('产物里有绝对路径：' + abs.join(', '));

  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  while ((m = re.exec(stripped))) blocks.push(m[1]);
  /* 6 块：Canvas 主题 + 游戏 + MockServer + Ghost + GhostUI + 桥接 */
  if (blocks.length !== 6) {
    throw new Error('脚本块应为 6 个（主题 + 游戏 + 4 模块），实际 ' + blocks.length);
  }
  blocks.forEach((code, i) => {
    try { new vm.Script(code, { filename: 'b' + (i + 1) }); }
    catch (e) { throw new Error('第 ' + (i + 1) + ' 块语法错误：' + e.message); }
  });

  /* 主题必须真的注入进去了，且位置正确 */
  if (out.indexOf('id="fx-theme"') < 0) throw new Error('产物缺少主题样式');
  /* Canvas 主题在 <head> 里 → 一定早于 body 中的游戏脚本 */
  const headEnd = out.indexOf('</head>');
  const canvasIdx = out.indexOf('FXCanvasTheme');
  if (canvasIdx < 0) throw new Error('产物缺少 Canvas 主题');
  if (canvasIdx > headEnd) {
    throw new Error('Canvas 主题必须注入到 <head> 内（否则晚于游戏执行，接管失效）');
  }
  /* 主题样式也必须早于 </head>，且在游戏自带样式之后 */
  const styleIdx = out.indexOf('id="fx-theme"');
  const gameStyleIdx = out.indexOf('--chart-bg');
  if (styleIdx < 0) throw new Error('产物缺少主题样式');
  if (styleIdx < gameStyleIdx) {
    throw new Error('主题样式必须排在游戏自带样式之后（否则覆盖不生效）');
  }

  ['window.MockServer', 'window.GhostUI', 'window.FX = {'].forEach((need) => {
    if (out.indexOf(need) < 0 && out.indexOf(need.replace('window.', '')) < 0) {
      throw new Error('产物缺少 ' + need);
    }
  });

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log('');
  console.log('  ✅ 已生成幽灵对战版：' + OUT_FILE);
  console.log('     ' + kb + ' KB · 单文件 · 零网络请求 · 可直接双击打开');
  console.log('');
  console.log('     游戏源文件：' + gameSrc + ' ' + describeSource(gameSrc));
  console.log('     模块：MockServer / Ghost / GhostUI / 桥接');
  console.log('     脚本块：' + blocks.length + ' 个');
  console.log('');
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('\n❌ 构建失败：' + e.message + '\n'); process.exit(1); }
}

module.exports = { main, resolveGameSrc, CANDIDATES, OUT_FILE };
