/*
 * 打开指定界面后截图 —— 用于检查弹窗类 UI 的深色主题。
 *
 * 用法：
 *   node tools/shot-modal.js intel 390   情报市场
 *   node tools/shot-modal.js market 390  资产市场
 *   node tools/shot-modal.js ghost 390   幽灵菜单
 *   node tools/shot-modal.js leaderboard 390
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///D:/delta/fx-online/dist-ghost/index.html';

const WHICH = process.argv[2] || 'intel';
const WIDTH = Number(process.argv[3] || 390);
const OUT = path.join(__dirname, '..', 'shots', 'modal-' + WHICH + '-' + WIDTH + '.png');

/* 每个界面用什么 JS 打开 */
const OPENERS = {
  intel: `
    (function(){
      if (window.FX && typeof FX.openIntelMarket === 'function') { FX.openIntelMarket(); return 'FX.openIntelMarket'; }
      var el = document.getElementById('intelModal');
      if (el) { el.hidden = false; return 'hidden=false'; }
      return 'not found';
    })()
  `,
  market: `
    (function(){
      if (window.FX && typeof FX.openMarket === 'function') { FX.openMarket(); return 'FX.openMarket'; }
      var el = document.getElementById('marketModal');
      if (el) { el.hidden = false; return 'hidden=false'; }
      return 'not found';
    })()
  `,
  pick: `
    (function(){
      var el = document.getElementById('pickModal');
      if (el) { el.hidden = false; return 'hidden=false'; }
      return 'not found';
    })()
  `,
  ghost: `
    (function(){
      var chip = document.getElementById('fxgChip');
      if (chip) { chip.click(); return 'clicked'; }
      return 'not found';
    })()
  `,
  leaderboard: `
    (function(){
      if (window.GhostBattle && GhostBattle.ui) { GhostBattle.ui.showLeaderboard(); return 'showLeaderboard'; }
      return 'not found';
    })()
  `,
};

function waitPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      const req = http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        if (Date.now() > deadline) reject(new Error('CDP 未就绪'));
        else setTimeout(tick, 150);
      });
    };
    tick();
  });
}

(async function main() {
  const port = 9300 + Math.floor(Math.random() * 300);
  const userDir = path.join(require('os').tmpdir(), 'fx-shotm-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  await waitPort(port, Date.now() + 20000);

  let target = null;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const list = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve([]); } });
      }).on('error', () => resolve([]));
    });
    target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (target) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!target) throw new Error('没有可用页面');

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res);
    ws.addEventListener('error', () => rej(new Error('WS 失败')));
  });

  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const onMsg = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.id !== myId) return;
      ws.removeEventListener('message', onMsg);
      if (data.error) reject(new Error(method + ': ' + JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  await rpc('Page.enable');
  await rpc('Runtime.enable');

  await rpc('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: 900, deviceScaleFactor: 2, mobile: WIDTH < 600,
  });

  await rpc('Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2200));

  /* 打开目标界面 */
  const opener = OPENERS[WHICH] || OPENERS.intel;
  const res = await rpc('Runtime.evaluate', {
    expression: opener,
    returnByValue: true,
    awaitPromise: false,
  });
  console.log('打开结果：' + JSON.stringify(res.result && res.result.value));

  await new Promise((r) => setTimeout(r, 900));

  /* ★ 弹窗截图只截**视口**，不要截整页。
   *   原因：.modal 是 position:fixed 覆盖层，背后还渲染着完整的主页面。
   *   Page.getLayoutMetrics 返回的是整个文档高度（含被遮住的主页面），
   *   按那个高度截图会在弹窗下方带出上千像素的空白 —— 那是假象，
   *   真实用户看到的就是一个覆盖在页面上的弹窗。
   *   所以这里固定用视口高度截图。 */
  const viewH = 844;   // 接近 iPhone 14 的可视高度

  await rpc('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: viewH, deviceScaleFactor: 2, mobile: WIDTH < 600,
  });
  await new Promise((r) => setTimeout(r, 350));

  const shot = await rpc('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log('已截图：' + OUT + '（' + WIDTH + ' x ' + viewH + ' 视口）');

  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 300);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
