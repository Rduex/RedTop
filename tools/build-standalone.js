/*
 * 单机版构建 —— 生成一个「双击就能玩」的单 HTML 文件，零服务器、零网络。
 *
 * ============================ 为什么需要它 ============================
 *
 * 联网版依赖自建 Node 服务端（排行榜 + 云存档）。但玩家分布在国内各地，
 * 直连 Railway 经常失败/超时，体验很差；而游戏本身的**核心玩法完全不需要网络**。
 *
 * 所以这里产出第二份产物：
 *   联网版 public/index.html  —— 有服务器时用（联机榜 + 云存档）
 *   单机版 dist-ghost/index.html —— 没服务器也能玩（本地榜 + 幽灵对战）
 *
 * 两者共用同一份游戏本体与同一套注入模块，只是**注入哪几个模块**不同：
 *
 *   模块            单机版   联网版   说明
 *   theme-*          ✅       ✅     纯样式，无依赖
 *   margin-ui        ✅       ✅     只操作内存里的仓位，不需要网络
 *   mock-server      ✅       ✅     用 localStorage 假装后端（本地榜 + 幽灵存档）
 *   ghost*           ✅       ✅     幽灵对战全走 localStorage
 *   online-client    ❌       ❌     只在联网版注入（访问 /api/*，离线会一直重试）
 *
 * ★ 关键设计：单机版**不含 online-client.js**。
 *   否则离线打开时会不停重试 /api/*，控制台刷满错误，
 *   而且"未登录·不存档"的提示会误导玩家以为存档坏了。
 *
 * ★ 单机版的存档在哪：游戏本体的 localStorage（key: fx-simple-meta-v1）
 *   加上 MockServer 的本地榜/幽灵。换浏览器或清缓存会丢，这是可接受的
 *   —— 单机版本就图"打开就能玩"，不承诺跨设备。
 *
 * 用法： node tools/build-standalone.js
 * 输出： dist-ghost/index.html（约 500KB，可发给任何人、可用 U 盘拷走）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist-ghost');
const OUT_FILE = path.join(OUT_DIR, 'index.html');

const { CANDIDATES, resolveGameSrc, describeSource, warnIfOutsideRepo } = require('./game-src');
const { stripPreviousInjections, describeRemoved, toLF } = require('./inject-guard');

function read(file, label) {
  if (!fs.existsSync(file)) throw new Error('找不到' + label + '：' + file);
  return fs.readFileSync(file, 'utf8');
}

function main() {
  const gameSrc = resolveGameSrc();
  if (!gameSrc) {
    throw new Error('找不到游戏源文件。已尝试：\n' + CANDIDATES.map((c) => '  · ' + c).join('\n'));
  }
  warnIfOutsideRepo(gameSrc);

  const game = read(gameSrc, '游戏单文件');

  /* 幂等注入：本体可能本身就是合并产物（自带主题/幽灵模块），先剥离再注入 */
  const guarded = stripPreviousInjections(game);
  const bodyHtml = guarded.html;
  if (guarded.removed.length) {
    console.log('  已剥离本体里已有的注入块：' + describeRemoved(guarded.removed));
  }

  const themeCss = read(path.join(ROOT, 'src', 'theme-fx.css'), '主题样式');
  const themeCanvas = read(path.join(ROOT, 'src', 'theme-canvas.js'), 'Canvas 主题');
  const mock = read(path.join(ROOT, 'src', 'mock-server.js'), 'MockServer');
  const ghost = read(path.join(ROOT, 'src', 'ghost.js'), '幽灵模块');
  const ghostUI = read(path.join(ROOT, 'src', 'ghost-ui.js'), '幽灵界面');
  const bridge = read(path.join(ROOT, 'src', 'ghost-bridge.js'), '幽灵桥接');
  const marginUI = read(path.join(ROOT, 'src', 'margin-ui.js'), '追加保证金界面');

  /* 内联安全：这几段代码里不能出现闭合标签，否则会提前截断 HTML */
  const scripts = {
    'theme-canvas.js': themeCanvas,
    'mock-server.js': mock,
    'ghost.js': ghost,
    'ghost-ui.js': ghostUI,
    'ghost-bridge.js': bridge,
    'margin-ui.js': marginUI,
  };
  for (const k of Object.keys(scripts)) {
    if (/<\/script/i.test(scripts[k])) throw new Error(k + ' 含 </script，不能内联');
  }
  if (/<\/style/i.test(themeCss)) throw new Error('theme-fx.css 含 </style，不能内联');
  if (!/<\/head>/i.test(bodyHtml)) throw new Error('游戏源文件里找不到 </head>');
  if (!/<\/body>/i.test(bodyHtml)) throw new Error('游戏源文件里找不到 </body>');

  /* ---------- 1) <head>：Canvas 主题 + 主题样式 ---------- */
  const headBlock = [
    '',
    '<!-- ============ FX 单机版（构建时注入）============',
    '     ① Canvas 主题：必须最先执行，抢先接管 canvas.getContext',
    '     ② 主题样式：必须排在游戏自带样式之后才能覆盖',
    '     =============================================== -->',
    '<script>',
    '/* ---- Canvas 主题（早于游戏执行）---- */',
    toLF(themeCanvas).trim(),
    '</script>',
    '<style id="fx-theme">',
    toLF(themeCss).trim(),
    '</style>',
    '',
  ].join('\n');

  const styled = bodyHtml.replace(/<\/head>/i, () => headBlock + '</head>');
  if (styled === bodyHtml) throw new Error('注入 head 失败');

  /* ---------- 2) </body> 前：幽灵对战 + 追保（不含云存档）---------- */
  const bodyBlock = [
    '',
    '<!-- ==================== FX 单机版（零服务器 · 零网络）====================',
    '     本文件不访问任何网络接口：',
    '       · 排行榜  → 本地 localStorage（MockServer）',
    '       · 幽灵对战 → 本地 localStorage（录制/回放/挑战链接）',
    '       · 云存档   → **不包含**（那需要服务器；单机版用游戏自带的本地存档）',
    '     发给任何人、拷到 U 盘、断网双击，都能直接玩。',
    '     ==================================================================== -->',
    '<script>',
    '/* ---- MockServer：本地榜单 + 幽灵存档（用 localStorage 假装后端）---- */',
    toLF(mock).trim(),
    '</script>',
    '<script>',
    '/* ---- Ghost：录制与回放 ---- */',
    toLF(ghost).trim(),
    '</script>',
    '<script>',
    '/* ---- GhostUI：幽灵对战界面 ---- */',
    toLF(ghostUI).trim(),
    '</script>',
    '<script>',
    '/* ---- 桥接：把幽灵挂到游戏生命周期 ---- */',
    toLF(bridge).trim(),
    '</script>',
    '<script>',
    '/* ---- 追加保证金：持仓卡上的手动追保入口（纯本地，无需服务器）---- */',
    toLF(marginUI).trim(),
    '</script>',
    '',
  ].join('\n');

  /* ★ 函数式替换：字符串形式的 $' 会展开成"匹配后全文" */
  const out = styled.replace(/<\/body>/i, () => bodyBlock + '\n</body>');
  if (out === styled) throw new Error('注入 body 失败');

  /* ---------- 校验 ---------- */
  const stripped = out.replace(/<!--[\s\S]*?-->/g, '');

  const must = [
    ['id="fx-theme"', '主题样式'],
    ['FXCanvasTheme', 'Canvas 主题'],
    ['root.MockServer = api', '本地榜单存储'],
    ['root.GhostUI = api', '幽灵对战界面'],
    ['GhostBattle', '幽灵桥接'],
    ['window.FXMargin', '追加保证金'],
    ['window.FX = {', '游戏本体'],
  ];
  const missing = must.filter(([needle]) => out.indexOf(needle) < 0);
  if (missing.length) throw new Error('产物缺少：' + missing.map((m) => m[1]).join(', '));

  /* ★ 单机版绝不能含云存档客户端：它会去请求 /api/*，离线时一直重试 */
  if (out.indexOf('window.FXOnline') >= 0) {
    throw new Error('单机版不应包含云存档客户端（它会尝试联网）');
  }
  /* ★ 也不能含任何 http(s) 外链：单机版必须能在断网下完整运行 */
  const externalUrls = (stripped.match(/https?:\/\/[a-z0-9]/gi) || []);
  if (externalUrls.length) {
    throw new Error('单机版不应含外部 URL（会依赖网络）：' + externalUrls.slice(0, 3).join(', '));
  }

  /* 顺序：Canvas 主题在 head 内 */
  const headEnd = out.indexOf('</head>');
  if (out.indexOf('FXCanvasTheme') > headEnd) {
    throw new Error('Canvas 主题必须在 <head> 内（否则晚于游戏执行）');
  }

  /* 脚本块语法 */
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(stripped))) blocks.push(m[1]);
  blocks.forEach((code, i) => {
    try { new vm.Script(code, { filename: 'b' + (i + 1) + '.js' }); }
    catch (e) { throw new Error('第 ' + (i + 1) + ' 块语法错误：' + e.message); }
  });

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log('');
  console.log('  ✅ 已生成单机版：' + OUT_FILE);
  console.log('     ' + kb + ' KB · 单文件 · 零网络请求 · 双击即玩 · ' + blocks.length + ' 个脚本块');
  console.log('');
  console.log('     能力清单：');
  console.log('       ✅ 新 UI 主题（交易终端 + 社交信息流 + 桌面双栏）');
  console.log('       ✅ 幽灵对战（录制 / 挑战链接 / 实时对比）');
  console.log('       ✅ 本地排行榜（localStorage，不联网）');
  console.log('       ✅ 追加保证金（手动填金额 · 实时预览）');
  console.log('       ⛔ 云存档 / 联机榜（需要服务器，单机版不含）');
  console.log('');
  console.log('     游戏源文件：' + gameSrc + ' ' + describeSource(gameSrc));
  console.log('');
}

if (require.main === module) {
  try { main(); } catch (e) { console.error('\n❌ 构建失败：' + e.message + '\n'); process.exit(1); }
}

module.exports = { main, OUT_FILE, resolveGameSrc, CANDIDATES };
