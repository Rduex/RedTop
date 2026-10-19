/*
 * 注入守卫 —— 让「合并构建」对**已经合并过的本体**也幂等。
 *
 * ============================ 为什么需要它 ============================
 *
 * 真踩过的坑：拿到一份 `FX_game.html` 直接构建，产物里出现了**两份**模块 ——
 * Canvas 主题、MockServer、Ghost、GhostUI、GhostBridge 全都各两份，
 * 外加两个 `<style id="fx-theme">`。
 *
 * 原因：那份本体本身就是一个"游戏 + 主题 + 幽灵"的合并产物（等于 dist-ghost），
 * 而构建脚本是按"输入是纯游戏文件"的假设注入的，于是又注入了一遍。
 *
 * 重复的代价不只是体积：
 *   · GhostUI 会挂第二套界面节点（顶栏多出按钮、弹窗多一层）
 *   · MockServer 会建第二个 store，先录的数据落在被覆盖掉的那个实例里
 *   · theme-canvas 会把 getContext 包两层，颜色映射被叠加
 * 而这一切**构建日志里一个字都不会提** —— 属于最危险的那种"静默错误"。
 *
 * ============================ 做法 ============================
 *
 * 构建前先扫一遍本体，把"我们自己注入过的块"剥掉，再注入当前版本：
 *   · `<style id="fx-theme">…</style>`
 *   · 含下列导出签名的 `<script>…</script>` 块
 *       root.FXCanvasTheme = api / root.MockServer = api / root.Ghost = api
 *       root.GhostUI = api / root.GhostBattle / window.FXMargin / window.FXOnline
 *   · 我们注入时留下的两段注释横幅
 *
 * 判定"是不是我们注入的"靠**导出签名**而不是注释文案 —— 注释改过好几版，
 * 签名才是稳定的身份标识。剥离结果会打印出来，绝不静默。
 *
 * ★ 安全阀：只有**小于 MAX_MODULE_BYTES** 的块才允许被剥离。
 *   游戏主脚本有 190KB+，万一它内部含有 `</script>` 字面量导致正则错配、
 *   把"游戏+模块"切成一大块，这个上限能保证我们绝不会把游戏本体删掉。
 */
'use strict';

const MAX_MODULE_BYTES = 60 * 1024;      // 我们最大的模块约 24KB，留足余量

const SIGNATURES = [
  ['theme-canvas', 'root.FXCanvasTheme = api'],
  ['mock-server', 'root.MockServer = api'],
  ['ghost', 'root.Ghost = api'],
  ['ghost-ui', 'root.GhostUI = api'],
  ['ghost-bridge', 'root.GhostBattle'],
  ['margin-ui', 'window.FXMargin'],
  ['online-client', 'window.FXOnline'],
];

const STYLE_RE = /<style id="fx-theme">[\s\S]*?<\/style>[ \t]*\r?\n?/gi;
const SCRIPT_RE = /<script>([\s\S]*?)<\/script>[ \t]*\r?\n?/gi;
const BANNER_RE = /<!--[^>]*FX 主题（构建时注入）[\s\S]*?-->[ \t]*\r?\n?/gi;
const BANNER2_RE = /<!--[^>]*FX 联网版[\s\S]*?-->[ \t]*\r?\n?/gi;

/* 返回 { html, removed: [{ name, bytes }] } —— 不修改入参 */
function stripPreviousInjections(html) {
  const removed = [];
  let out = String(html || '');

  out = out.replace(STYLE_RE, (m) => {
    removed.push({ name: 'theme-css（<style id="fx-theme">）', bytes: Buffer.byteLength(m, 'utf8') });
    return '';
  });

  out = out.replace(SCRIPT_RE, (whole, body) => {
    const hit = SIGNATURES.find((s) => body.indexOf(s[1]) >= 0);
    if (!hit) return whole;                                   // 不是我们注入的，原样保留
    if (Buffer.byteLength(whole, 'utf8') > MAX_MODULE_BYTES) {
      /* 超大块 + 命中签名 = 极可能是正则错配把游戏和模块切在了一起。
       * 宁可留着重复，也不能删掉游戏本体。 */
      return whole;
    }
    removed.push({ name: hit[0], bytes: Buffer.byteLength(whole, 'utf8') });
    return '';
  });

  const banner = (re, label) => {
    out = out.replace(re, (m) => {
      removed.push({ name: label, bytes: Buffer.byteLength(m, 'utf8') });
      return '';
    });
  };
  banner(BANNER_RE, '注入横幅（head）');
  banner(BANNER2_RE, '注入横幅（body）');

  return { html: out, removed };
}

/* 给日志用的一行摘要 */
function describeRemoved(removed) {
  if (!removed.length) return '（本体是干净的，无需剥离）';
  const total = removed.reduce((s, r) => s + r.bytes, 0);
  return removed.map((r) => r.name).join(' + ') + '（共 ' + (total / 1024).toFixed(1) + ' KB）';
}

/*
 * 统一注入内容的换行符为 LF。
 *
 * 为什么必须做：注入的样式/脚本是从工作区读进来的文本，Windows 检出的文件可能是
 * CRLF，而 `.gitattributes` 归一化之后又变回 LF。若原样拼进产物，就会变成
 * "换行符取决于谁在什么机器上构建"——实测表现：重新构建一次，
 * public/index.html 出现 2765 行 diff，实际内容一个字没变，review 完全没法看。
 *
 * 只归一化**我们注入的部分**，游戏本体自身的字节保持原样。
 */
function toLF(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

module.exports = {
  SIGNATURES, MAX_MODULE_BYTES,
  stripPreviousInjections, describeRemoved, toLF,
};
