@echo off
REM ============================================================
REM  FX 战士久留美 · 联网版 —— 一键启动（Windows）
REM
REM  双击本文件即可：自动构建联网版页面 + 启动服务器 + 打开浏览器。
REM  关掉这个黑窗口 = 关掉服务器。
REM ============================================================
setlocal

cd /d "%~dp0"

REM 找一个能用的 node
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [x] 没有找到 node 命令。
  echo      请先安装 Node.js 18 或更高版本：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo   FX 战士久留美 · 联网版
echo  ============================================================
echo.
echo  [1/3] 正在构建联网版页面...
node tools\build.js
if errorlevel 1 (
  echo.
  echo  [x] 构建失败。请确认游戏源文件存在：
  echo      D:\delta\FX模拟器V1.4.html
  echo      或用环境变量 FX_GAME_SRC 指定别的路径。
  echo.
  pause
  exit /b 1
)

echo.
echo  [2/3] 正在启动服务器...
echo  [3/3] 浏览器会自动打开，关掉本窗口即可停止服务。
echo.

REM 延迟两秒再开浏览器，等服务器起来
start "" cmd /c "timeout /t 2 >nul & start http://127.0.0.1:8787"

node src\server.js

echo.
echo  服务器已停止。
pause
