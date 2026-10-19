/*
 * 截图：三选一卡牌弹窗 + 暂停态。
 * 用法： node tools/shot-fix.js
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///D:/delta/fx-online/public/index.html';
const OUT_DIR = path.join(__dirname, '..', 'shots');

function waitTarget(port, deadline) {
  return new Promise((resolve) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          let list = [];
          try { list = JSON.parse(s); } catch (e) { list = []; }
          const t = (list || []).find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
          if (t) return resolve(t);
          retry();
        });
      }).on('error', retry);
    };
    const retry = () => {
      if (Date.now() > deadline) return resolve(null);
      setTimeout(tick, 200);
    };
    tick();
  });
}

(async function main() {
  const port = 9200 + Math.floor(Math.random() * 400);
  const userDir = path.join(require('os').tmpdir(), 'fx-sf-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  const target = await waitTarget(port, Date.now() + 20000);
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
      if (data.error) reject(new Error(JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

  await rpc('Page.enable');
  await rpc('Runtime.enable');
  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 900, height: 900, deviceScaleFactor: 2, mobile: false,
  });
  await rpc('Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2600));

  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* ---------- 截图 1：三选一卡牌 ---------- */
  await rpc('Runtime.evaluate', {
    expression: `
      (function(){
        var modal = document.getElementById('pickModal');
        var body = modal.querySelector('.modal-panel');
        var grid = body.querySelector('.pick-grid');
        if (!grid) { grid = document.createElement('div'); grid.className='pick-grid'; body.appendChild(grid); }
        grid.innerHTML =
          '<button class="pick-card r1"><div class="pick-name">点差半价</div>' +
          '<div class="pick-desc">开仓手续费降低 50%，短线刷单的成本直接砍半。</div></button>' +
          '<button class="pick-card r2"><div class="pick-name">主力席位</div>' +
          '<div class="pick-desc">名义仓位提升 80%，同样的保证金能开更大的仓。</div></button>' +
          '<button class="pick-card r3"><div class="pick-name">复利机器</div>' +
          '<div class="pick-desc">所有盈利放大到 1.70 倍，越赚越快。</div></button>';
        modal.hidden = false;
      })()
    `,
  });
  await new Promise((r) => setTimeout(r, 500));

  const s1 = await rpc('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  fs.writeFileSync(path.join(OUT_DIR, 'fix-pick-cards.png'), Buffer.from(s1.data, 'base64'));
  console.log('已截图：shots/fix-pick-cards.png');

  /* ---------- 截图 2：暂停态 ---------- */
  await rpc('Runtime.evaluate', {
    expression: `
      (function(){
        document.getElementById('pickModal').hidden = true;
        if (window.FX && FX.setPaused) FX.setPaused(true);
        window.scrollTo(0, 780);
      })()
    `,
  });
  await new Promise((r) => setTimeout(r, 600));

  const s2 = await rpc('Page.captureScreenshot', {
    format: 'png', captureBeyondViewport: false, fromSurface: true,
  });
  fs.writeFileSync(path.join(OUT_DIR, 'fix-paused.png'), Buffer.from(s2.data, 'base64'));
  console.log('已截图：shots/fix-paused.png');

  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
