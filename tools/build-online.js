/*
 * 构建「联网 + 新UI + 幽灵对战」合并版 —— 给 Railway 用。
 *
 * ============================ 这个脚本解决什么问题 ============================
 *
 * 项目里原本有三套互斥的产物：
 *
 *   public/index.html     Node 存档 + 旧 UI           ← Railway 一直在托管这份
 *   dist-ghost/index.html 新 UI + 幽灵对战 + 本地存档   ← 这几轮的视觉改造
 *   dist/index.html       Toy SDK 版
 *
 * 于是"Railway 部署成功、也没报错，但新 UI 和存档改动都没生效" ——
 * 因为 Railway 跑的是第一份，它压根没包含后两轮的改动。
 *
 * 本脚本把三者该有的能力合并到 **public/index.html**：
 *
 *   ✅ 新 UI 主题      （theme-fx.css + theme-canvas.js）
 *   ✅ 幽灵对战        （mock-server + ghost + ghost-ui + ghost-bridge）
 *   ✅ Node 云端存档   （online-client.js + /api/* 接口）
 *   ✅ 排行榜          （走 Node 后端，不是本地 mock）
 *
 * ============================ 两者如何共存 ============================
 *
 * 存档归属（关键）：
 *   - **Node 后端负责 balance / positions 的持久化**（online-client.js）
 *   - 幽灵模块只**读取** window.FX 的状态用于录制，不写存档
 *   - 排行榜：Node 版走 /api/leaderboard；幽灵版自带一个本地排行榜弹窗，
 *     两者不冲突（一个在顶栏左边，一个在右边）
 *
 * localStorage key 完全不重叠，已核对：
 *   幽灵：fx_leaderboard / fx_ghosts
 *   Node：fx-online-token-v1 / fx-online-user-v1 / fx-online-queue-v1
 *   游戏：fx-simple-meta-v1
 *
 * 注入顺序（重要）：
 *   1) theme-canvas.js  → 必须在游戏之前（抢 getContext）
 *   2) theme-fx.css     → 必须在游戏样式之后（否则被覆盖）
 *   3) 游戏本体
 *   4) mock-server / ghost / ghost-ui / ghost-bridge  → 幽灵对战
 *   5) online-client    → 最后，负责云存档（它会覆盖 ghost 的初始状态）
 *
 * 运行： node tools/build-online.js
 * 输出： public/index.html
 * ==========================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'public', 'index.html');

/* 游戏本体的候选路径统一由 tools/game-src.js 提供 —— 别再在这里抄一份，
 * 四处各写一份的代价是"本体换位置后有的产物还在用旧文件"（真踩过）。 */
const { CANDIDATES, resolveGameSrc, describeSource, warnIfOutsideRepo } = require('./game-src');
/* 注入守卫：本体若已经是一份"合并过的产物"（自带主题/幽灵模块），
 * 先把它的旧块剥掉再注入，避免产物里出现两份模块（详见 tools/inject-guard.js） */
const { stripPreviousInjections, describeRemoved, toLF } = require('./inject-guard');

/* 我们注入的脚本块数：head 1 个（Canvas 主题）+ body 6 个（幽灵 4 + 追保 + 云存档）。
 * 测试用它核对产物块数，避免"本体多一个内联脚本就断言失败"这种脆弱写法。 */
const INJECTED_SCRIPT_COUNT = 7;

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
  if (!gameSrc) throw new Error('找不到游戏源文件。已尝试：\n' + CANDIDATES.map((c) => '  · ' + c).join('\n'));
  warnIfOutsideRepo(gameSrc);

  const game = read(gameSrc, '游戏单文件');

  /* ★ 幂等注入：本体可能本身就是合并产物（自带主题/幽灵模块）。
   *   不剥离的话产物里会有两份模块 —— GhostUI 挂两套界面、MockServer 两个 store、
   *   getContext 被包两层，而构建日志一个字都不提。 */
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
  const client = read(path.join(ROOT, 'src', 'online-client.js'), '云存档客户端');

  /* ---------- 内联安全检查 ---------- */
  const scripts = {
    'theme-canvas.js': themeCanvas,
    'mock-server.js': mock,
    'ghost.js': ghost,
    'ghost-ui.js': ghostUI,
    'ghost-bridge.js': bridge,
    'margin-ui.js': marginUI,
    'online-client.js': client,
  };
  for (const k of Object.keys(scripts)) {
    if (/<\/script/i.test(scripts[k])) throw new Error(k + ' 含 </script，不能内联');
  }
  if (/<\/style/i.test(themeCss)) throw new Error('theme-fx.css 含 </style，不能内联');
  if (!/<\/head>/i.test(game)) throw new Error('游戏源文件里找不到 </head>');
  if (!/<\/body>/i.test(game)) throw new Error('游戏源文件里找不到 </body>');

  /* ---------- 1) <head>：Canvas 主题 + 样式 ---------- */
  const headBlock = [
    '',
    '<!-- ============ FX 主题（构建时注入）============',
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

  /* ---------- 2) </body> 前：幽灵对战 + 云存档 ---------- */
  const bodyBlock = [
    '',
    '<!-- ==================== FX 联网版（Node 后端 + 新UI + 幽灵对战）====================',
    '     数据能力：',
    '       · 云存档 / 排行榜  → 走自建 Node 后端（/api/*）',
    '       · 幽灵对战          → 走本地 localStorage（不依赖服务器）',
    '     两者 localStorage key 完全不重叠，可安全共存。',
    '     ================================================================================= -->',
    '<script>',
    '/* ---- MockServer：幽灵对战的本地存储 ---- */',
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
    '/* ---- 追加保证金：给持仓卡补一个手动追保入口（只调用游戏已导出的 API）---- */',
    toLF(marginUI).trim(),
    '</script>',
    '<script>',
    '/* ---- 云存档客户端：最后加载，负责 balance/positions 持久化 ---- */',
    toLF(client).trim(),
    '</script>',
    '',
  ].join('\n');

  /* ★ 函数式替换：字符串形式的 $' 会展开成"匹配后全文" */
  const out = styled.replace(/<\/body>/i, () => bodyBlock + '\n</body>');
  if (out === styled) throw new Error('注入 body 失败');

  /* ---------- 校验 ---------- */
  const stripped = out.replace(/<!--[\s\S]*?-->/g, '');
  const noComments = stripComments(stripped);

  /* 必须包含四大能力 */
  const must = [
    ['id="fx-theme"', '新 UI 主题样式'],
    ['FXCanvasTheme', 'Canvas 主题'],
    ['root.MockServer = api', '幽灵本地存储'],
    ['root.GhostUI = api', '幽灵对战界面'],
    ['GhostBattle', '幽灵桥接'],
    ['window.FXMargin', '追加保证金界面'],
    ['window.FXOnline', '云存档客户端'],
    ['window.FX = {', '游戏本体'],
    ['/api/account/state', 'Node 云存档接口'],
    ['/api/leaderboard', 'Node 排行榜接口'],
  ];
  const missing = must.filter(([needle]) => out.indexOf(needle) < 0);
  if (missing.length) {
    throw new Error('产物缺少：' + missing.map((m) => m[1]).join(', '));
  }

  /* 顺序检查：Canvas 主题在 head 内 */
  const headEnd = out.indexOf('</head>');
  if (out.indexOf('FXCanvasTheme') > headEnd) {
    throw new Error('Canvas 主题必须在 <head> 内（否则晚于游戏执行）');
  }
  /* 主题样式在游戏样式之后 */
  if (out.indexOf('id="fx-theme"') < out.indexOf('--chart-bg')) {
    throw new Error('主题样式必须在游戏自带样式之后');
  }
  /* 云存档客户端在最后（它要覆盖初始状态） */
  const clientIdx = out.indexOf('window.FXOnline');
  const ghostIdx = out.indexOf('root.GhostUI');
  if (clientIdx < ghostIdx) {
    throw new Error('云存档客户端应在幽灵模块之后加载');
  }
  /* 追保界面依赖 window.FX（游戏本体），必须排在游戏之后 */
  const marginIdx = out.indexOf('window.FXMargin');
  const gameIdx = out.indexOf('window.FX = {');
  if (marginIdx < gameIdx) {
    throw new Error('追保界面必须在游戏本体之后注入（它要调用 FX.* 接口）');
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

  /* 绝对路径（子目录部署会 404） */
  const abs = [];
  const attrRe = /\b(?:src|href)\s*=\s*["'](\/[^"']*)["']/gi;
  while ((m = attrRe.exec(stripped))) abs.push(m[1]);
  if (abs.length) throw new Error('产物里有绝对路径：' + abs.join(', '));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log('');
  console.log('  ✅ 已生成联网版：' + OUT);
  console.log('     ' + kb + ' KB · ' + blocks.length + ' 个脚本块');
  console.log('');
  console.log('     能力清单：');
  console.log('       ✅ 新 UI 主题（交易终端 + 社交信息流 + 桌面双栏）');
  console.log('       ✅ 幽灵对战（录制 / 挑战链接 / 实时对比）');
  console.log('       ✅ 追加保证金（手动填金额 · 实时预览强平价与危险度）');
  console.log('       ✅ Node 云存档（/api/account/state · sync · reset）');
  console.log('       ✅ Node 排行榜（/api/leaderboard · score）');
  console.log('');
  console.log('     游戏源文件：' + gameSrc + ' ' + describeSource(gameSrc));
  console.log('');
}

if (require.main === module) {
  try { main(); }
  catch (e) { console.error('\n❌ 构建失败：' + e.message + '\n'); process.exit(1); }
}

module.exports = { main, resolveGameSrc, CANDIDATES, OUT, INJECTED_SCRIPT_COUNT, stripPreviousInjections };
