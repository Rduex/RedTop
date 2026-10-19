/*
 * 游戏本体解析 —— 全项目**唯一**的候选路径定义。
 *
 * ============================ 为什么要有这个文件 ============================
 *
 * 原来四个构建脚本（build-online / build-ghost / build-toy / build）各自抄了一份
 * 候选列表。代价是：本体一换位置就要改四处，漏掉任何一处，那个产物就会
 * **静默地构建出另一个本体**（不是报错，是"构建成功但内容不对"，最难发现）。
 *
 * 真踩过的坑：本体从 game/fx-game.html 移到仓库根目录 FX_game.html 之后，
 * 构建脚本仍找不到它，于是回退到本机的 `D:\delta\FX模拟器V1.4.html` ——
 * 那是**旧版本**，构建居然"成功"了，只是产物里全是过时代的东西。
 * 所以这里除了统一候选列表，还会在选中"仓库外"的文件时大声警告。
 *
 * ============================ 候选优先级 ============================
 *
 *   ① FX_GAME_SRC 环境变量           —— 显式指定，最高优先级（构建/调试用）
 *   ② <仓库根>/FX_game.html          —— 当前正式位置（随仓库提交，云端靠它构建）
 *   ③ D:/delta/FX模拟器V1.4.html     —— 本机原始文件，仅开发机兜底
 *
 * ★ ② 必须排在 ③ 前面：云端（Linux）上 ③ 根本不存在，而开发机上 ③ 存在 ——
 *   顺序反了就会"本地能构建、云端构建失败"，或者本地悄悄构建出旧本体。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const REPO_BODY = path.join(ROOT, 'FX_game.html');

const CANDIDATES = [
  process.env.FX_GAME_SRC,                            // ① 显式指定
  REPO_BODY,                                          // ② 仓库根目录（正式位置）
  'D:/delta/FX模拟器V1.4.html',                        // ③ 本机兜底
].filter(Boolean);

/* 依次找第一个真实存在的候选 */
function resolveGameSrc() {
  for (const c of CANDIDATES) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).isFile()) return c;
    } catch (e) { /* 该候选不可用，继续下一个 */ }
  }
  return null;
}

/* 这个源文件在仓库里吗？（在仓库里 = 云端也能构建） */
function isInRepo(file) {
  if (!file) return false;
  const abs = path.resolve(file);
  return abs === ROOT || abs.startsWith(ROOT + path.sep);
}

/* 给人看的来源说明，构建横幅里用 */
function describeSource(file) {
  if (!file) return '（未找到）';
  if (!isInRepo(file)) return '（⚠ 仓库外的本机文件）';
  if (path.resolve(file) === REPO_BODY) return '（仓库内置）';
  return '（仓库内置）';
}

/* 选中仓库外的源时大声警告：这是"本地能跑、云端失败"或"用错本体"的高危信号 */
function warnIfOutsideRepo(file) {
  if (!file || isInRepo(file)) return false;
  console.warn('');
  console.warn('  ⚠️  正在用**仓库外**的游戏文件构建：' + file);
  console.warn('     这份文件不会被提交，云端（Railway/Render）上不存在 → 云端构建会失败。');
  console.warn('     如果只是本机预览，可以忽略；如果要部署，请把游戏本体放到仓库根目录');
  console.warn('     并命名为 FX_game.html。');
  console.warn('');
  return true;
}

module.exports = { ROOT, REPO_BODY, CANDIDATES, resolveGameSrc, isInRepo, describeSource, warnIfOutsideRepo };
