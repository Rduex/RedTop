/*
 * 用 Chrome DevTools Protocol 截图。
 *
 * 为什么不用 chrome --screenshot：
 *   当前 Chrome 版本在无头模式下忽略 --window-size，视口恒为 800x600，
 *   拍不到完整页面，也拍不了手机宽度。必须走 CDP 的
 *   Emulation.setDeviceMetricsOverride + Page.captureScreenshot(fullPage)。
 *
 * 用法： node tools/shot.js [宽度] [输出文件] [是否全页]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = process.env.PAGE_URL ||
  'file:///D:/delta/fx-online/dist-ghost/index.html';

const WIDTH = Number(process.argv[2] || 900);
const OUT = process.argv[3] || path.join(__dirname, '..', 'shots', 'shot.png');
const FULL = process.argv[4] !== 'viewport';
const HEIGHT = Number(process.argv[5] || 900);

function waitPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('CDP 端口未就绪'));
        else setTimeout(tick, 150);
      });
    };
    tick();
  });
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ id, method, params: params || {} });
    const onMsg = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (data.error) reject(new Error(method + ': ' + JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(msg);
  });
}

(async function main() {
  const port = 9222 + Math.floor(Math.random() * 300);
  const userDir = path.join(require('os').tmpdir(), 'fx-shot-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stderr.on('data', () => {});

  await waitPort(port, Date.now() + 20000);

  /* ★ 端口就绪 ≠ 页面 target 就绪。
   *   Chrome 启动后会先建浏览器进程，页面 target 要稍后才出现。
   *   早先只请求一次 /json/list 就报"没有可用页面" —— 其实是时机太早。
   *   这里轮询到出现 type === 'page' 为止。 */
  let target = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const list = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(s)); } catch (e) { resolve([]); }
        });
      }).on('error', () => resolve([]));
    });
    target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('没有可用页面（等待 15 秒仍无 page target）');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
  });

  let id = 0;
  await rpc(ws, ++id, 'Page.enable');
  await rpc(ws, ++id, 'Runtime.enable');

  /* 设置视口（设备像素比 2，保证文字清晰） */
  await rpc(ws, ++id, 'Emulation.setDeviceMetricsOverride', {
    width: WIDTH,
    height: HEIGHT,
    deviceScaleFactor: 2,
    mobile: WIDTH < 600,
  });

  /* 导航并等加载 */
  await rpc(ws, ++id, 'Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2500));

  /* 拿到页面真实高度 */
  const metrics = await rpc(ws, ++id, 'Page.getLayoutMetrics');
  const contentH = Math.ceil(
    (metrics.cssContentSize && metrics.cssContentSize.height) ||
    (metrics.contentSize && metrics.contentSize.height) || HEIGHT
  );

  const shotHeight = FULL ? Math.min(contentH, 6000) : HEIGHT;

  if (FULL) {
    await rpc(ws, ++id, 'Emulation.setDeviceMetricsOverride', {
      width: WIDTH,
      height: shotHeight,
      deviceScaleFactor: 2,
      mobile: WIDTH < 600,
    });
    await new Promise((r) => setTimeout(r, 400));
  }

  const shot = await rpc(ws, ++id, 'Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: FULL,
    fromSurface: true,
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));

  console.log('已截图：' + OUT);
  console.log('  视口：' + WIDTH + ' x ' + shotHeight + '（页面内容高 ' + contentH + '）');

  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => {
  console.error('截图失败：' + (e && e.message));
  process.exit(1);
});
