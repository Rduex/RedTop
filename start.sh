#!/usr/bin/env bash
# ============================================================
#  FX 战士久留美 · 联网版 —— 一键启动（macOS / Linux / WSL）
#
#  用法：  ./start.sh
#  停止：  Ctrl+C
# ============================================================
set -e

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "[x] 没有找到 node。请先安装 Node.js 18+：https://nodejs.org/"
  exit 1
fi

PORT="${FX_PORT:-8787}"
GAME_SRC="${FX_GAME_SRC:-D:/delta/FX模拟器V1.4.html}"

echo
echo "============================================================"
echo " FX 战士久留美 · 联网版"
echo "============================================================"
echo
echo "[1/2] 构建联网版页面..."
if [ -f "$GAME_SRC" ]; then
  node tools/build.js
else
  echo "      （找不到游戏源文件 $GAME_SRC，跳过构建，直接托管已有的 public/index.html）"
  if [ ! -f public/index.html ]; then
    echo "  [x] public/index.html 也不存在，无法继续。"
    echo "      请用 FX_GAME_SRC 指定游戏单文件路径后重试。"
    exit 1
  fi
fi

echo
echo "[2/2] 启动服务器（Ctrl+C 停止）..."
echo
exec node src/server.js
