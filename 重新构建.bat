@echo off
REM ============================================================
REM  重新构建前端产物 public\index.html
REM
REM  什么时候需要跑？
REM    只要改了 src\online-client.js、src\ 下任何文件，
REM    或换了 game\fx-game.html（游戏本体），都要重跑一次。
REM
REM  双击本文件即可。构建完会自动跑一遍诊断，确认
REM  "联网模块已注入且真的会请求存档接口"。
REM ============================================================
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  [x] 没找到 node，请先安装 Node.js 18+：https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo.
echo  ===== 1/3 构建 =====
node tools\build.js
if errorlevel 1 (
  echo.
  echo  [x] 构建失败，请把上面的报错发出来。
  pause
  exit /b 1
)

echo.
echo  ===== 2/3 体检：确认联网模块真的进了产物 =====
node tools\verify-build.js
if errorlevel 1 (
  echo.
  echo  [x] 体检没通过：产物里没找到联网模块。
  pause
  exit /b 1
)

echo.
echo  ===== 3/3 运行时诊断：确认页面真的会去拉存档 =====
node test\diag.js
if errorlevel 1 (
  echo.
  echo  [!] 诊断有不符合预期的场景，请查看上面的输出。
  pause
  exit /b 1
)

echo.
echo  ============================================================
echo   完成。产物：public\index.html
echo.
echo   本地验证：
echo     node src\server.js
echo     然后浏览器打开 http://127.0.0.1:8787
echo.
echo   部署验证：把 public\index.html 与 src\ 一起提交并 push，
echo   平台会自动重新构建；或在浏览器按 Ctrl+F5 强制刷新清缓存。
echo  ============================================================
echo.
pause
