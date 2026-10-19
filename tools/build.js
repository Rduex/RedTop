/*
 * 构建：把「游戏单文件」+「联网模块」合成 public/index.html（联网版）。
 *
 * 运行： node tools/build.js
 *
 * 设计要点：
 *   1) **绝不修改游戏源码**。联网模块是一段独立的 <script>，追加在游戏脚本之后。
 *      游戏本身一个字符都不动 —— 这样：
 *        · 原版 FX模拟器V1.4.html 永远可以继续单独玩/单独改；
 *        · 联网版出问题时，把这段 script 去掉就退回纯单机版，排查面极小。
 *   2) 构建时校验：注入不破坏 HTML 结构、不出现 </script> 提前闭合，
 *      并且把结果拿去解析一遍（防"构建成功但页面白屏"）。
 *   3) 输出到 public/index.html，由 server.js 直接托管。
 *
 * ★ 游戏源文件的查找顺序（这是"部署到云上构建失败"的关键）：
 *     ① 环境变量 FX_GAME_SRC          —— 你显式指定的路径，优先级最高
 *     ② ./FX_game.html                —— **随仓库一起提交的游戏本体（仓库根目录）**
 *     ③ D:/delta/FX模拟器V1.4.html    —— 你本机的原始路径
 *
 *   为什么要内置一份副本（②）：云平台（Railway/Render）只拿到 Git 仓库里的文件，
 *   D:\delta\... 这个本机路径在云上根本不存在。如果必须依赖它，
 *   自动构建必然失败。所以把游戏文件作为一个 ASCII 文件名的副本一起入库，
 *   让构建在任何环境都能跑通；你本机想改用最新版游戏时，
 *   用 FX_GAME_SRC 指过去即可（或重新拷贝一份到 game/）。
 *
 *   用 ASCII 文件名 fx-game.html 而不是中文原名：中文名在部分
 *   Git 配置 / CI 系统 / 容器镜像里会出现编码问题（乱码或无法签出），
 *   用一个纯英文名可以彻底避开这类坑。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CLIENT_SRC = path.join(ROOT, 'src', 'online-client.js');
const OUT = path.join(ROOT, 'public', 'index.html');

/* 候选路径统一来自 tools/game-src.js（四个构建脚本共用一份，避免漂移） */
const { CANDIDATES, resolveGameSrc, describeSource, warnIfOutsideRepo } = require('./game-src');

/* 联网版必须能定位到 API。
 * 同源部署时留空即可（前端会走相对路径），
 * 但如果你要把 public/ 挂到别的域名下，就在这里写死服务器地址。 */
const API_BASE = process.env.FX_API_BASE || '';

function read(file, label) {
  if (!fs.existsSync(file)) {
    throw new Error('找不到' + label + '：' + file);
  }
  return fs.readFileSync(file, 'utf8');
}

function main() {
  const gameSrc = resolveGameSrc();
  if (!gameSrc) {
    throw new Error(
      '找不到游戏源文件。已尝试以下路径：\n' +
      CANDIDATES.map((c) => '    · ' + c).join('\n') + '\n' +
      '请用环境变量 FX_GAME_SRC 指定，或把游戏本体放到仓库根目录并命名为 FX_game.html'
    );
  }

  warnIfOutsideRepo(gameSrc);
  const game = read(gameSrc, '游戏单文件');
  const client = read(CLIENT_SRC, '联网模块');

  /* 内联的两段代码都不能含 </script，否则会提前闭合标签、把后面的内容
   * 当成 HTML 渲染出来（轻则样式崩，重则页面直接坏掉）。 */
  if (/<\/script/i.test(client)) {
    throw new Error('online-client.js 含 </script，不能内联');
  }
  if (!/<\/body>/i.test(game)) {
    throw new Error('游戏源文件里找不到 </body>，结构不符合预期');
  }

  /* 注入顺序很关键：联网模块必须在游戏脚本之后执行，
   * 因为它要读 window.FX（游戏 IIFE 结束时才挂上）。 */
  const inject = [
    '',
    '<!-- ==================== FX 联网模块（构建时注入，非游戏源码） ====================',
    '     由 tools/build.js 自动追加。想回到纯单机版：删掉本段脚本即可。',
    '     本段不修改任何游戏逻辑，只读取 window.FX 的公开状态并上报成绩。',
    '     ========================================================================== -->',
    API_BASE
      ? '<script>window.FX_ONLINE_API=' + JSON.stringify(API_BASE) + ';</script>'
      : '',
    '<script>',
    client.trim(),
    '</script>',
    ''
  ].filter((s) => s !== '').join('\n');

  /* ★ 必须用**函数**作为 replace 的第二个参数，不能直接传字符串。
   * 原因：替换字符串里的 $ 有特殊含义 —— $' 表示"匹配之后的全部文本"、
   * $& 表示"匹配到的文本"。联网模块里有金额格式化代码 `'$' + ...`，
   * 直接传字符串会被解释成 $' 并展开成半页 HTML，把脚本彻底搞坏。
   * 传函数就完全绕开这套替换语义，注入内容原样落盘。 */
  const out = game.replace(/<\/body>/i, () => inject + '\n</body>');

  if (out === game) throw new Error('注入失败：替换 </body> 没有生效');

  /* ★ 构建期就地把注入后的脚本块拿去解析一遍。
   * 这一条能挡住一整类"构建成功但页面白屏"的事故 ——
   * 最典型的就是 replace() 的 $' 展开把脚本写坏（本项目已经踩过一次）。
   * 与其等玩家打开页面发现坏了，不如让构建直接失败。 */
  const vm = require('vm');
  const stripped = out.replace(/<!--[\s\S]*?-->/g, '');
  const blocks = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  let mm;
  while ((mm = re.exec(stripped))) blocks.push(mm[1]);
  if (blocks.length !== 2) {
    throw new Error('注入后应当正好 2 个脚本块，实际 ' + blocks.length + ' 个');
  }
  blocks.forEach((code, i) => {
    try {
      new vm.Script(code, { filename: 'block' + (i + 1) + '.js' });
    } catch (e) {
      throw new Error('第 ' + (i + 1) + ' 个脚本块语法错误：' + e.message);
    }
  });

  /* 注入后的结构自检：**去掉 HTML 注释之后再**数脚本标签。
   * 注意不能直接全文计数 —— 我们自己的注入说明注释里就写着 "<script>"，
   * 那样会把注释文字算进去，得到 3 开 2 闭的假错误。 */
  const noComments = out.replace(/<!--[\s\S]*?-->/g, '');
  const openTags = (noComments.match(/<script\b/gi) || []).length;
  const closeTags = (noComments.match(/<\/script>/gi) || []).length;
  if (openTags !== closeTags) {
    throw new Error('注入后 <script> 标签不成对：' + openTags + ' 开 / ' + closeTags + ' 闭');
  }
  /* 注入后应当正好两个脚本块：① 游戏本体 ② 联网模块。
   * 多出来就说明注入重复执行了（会挂两个 setInterval 和两套界面）。 */
  if (openTags !== 2) {
    throw new Error('注入后应当正好 2 个脚本块（游戏 + 联网模块），实际 ' + openTags + ' 个');
  }

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out, 'utf8');

  const kb = (Buffer.byteLength(out, 'utf8') / 1024).toFixed(1);
  console.log('已生成联网版：' + OUT + '（' + kb + ' KB）');
  console.log('  游戏源文件：' + gameSrc + ' ' + describeSource(gameSrc));
  console.log('  联网模块：  ' + CLIENT_SRC);
  console.log('  API 地址：  ' + (API_BASE || '同源（推荐）'));
}

if (require.main === module) {
  try {
    main();
  } catch (e) {
    console.error('构建失败：' + e.message);
    process.exit(1);
  }
}

module.exports = { main, resolveGameSrc, CANDIDATES, CLIENT_SRC, OUT };
