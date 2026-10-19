/*
 * 量一下追保弹窗在指定视口下的真实几何 —— 用来判断"手机上溢出"到底是
 * 我们的样式问题，还是页面本身有横向溢出（两者修法完全不同）。
 *
 * 用法： node tools/probe-margin-geom.js [宽度]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = process.env.PAGE_URL || 'file:///D:/delta/fx-online/public/index.html';
const WIDTH = Number(process.argv[2] || 390);

function waitPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => { res.resume(); resolve(); })
        .on('error', () => { if (Date.now() > deadline) reject(new Error('CDP 未就绪')); else setTimeout(tick, 150); });
    };
    tick();
  });
}
function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ id, method, params: params || {} });
    const onMsg = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (d.error) reject(new Error(method + ': ' + JSON.stringify(d.error))); else resolve(d.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(msg);
  });
}

(async function main() {
  const port = 9800 + Math.floor(Math.random() * 150);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-geom-' + Date.now()), 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  try {
    await waitPort(port, Date.now() + 20000);
    let target = null;
    const dl = Date.now() + 15000;
    while (Date.now() < dl) {
      const list = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
          let s = ''; res.on('data', (d) => { s += d; });
          res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve([]); } });
        }).on('error', () => resolve([]));
      });
      target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('WS'))); });
    let id = 0;
    await rpc(ws, ++id, 'Page.enable');
    await rpc(ws, ++id, 'Runtime.enable');
    await rpc(ws, ++id, 'Emulation.setDeviceMetricsOverride', { width: WIDTH, height: 780, deviceScaleFactor: Number(process.env.DSF || 2), mobile: process.env.MOBILE !== '0' });
    await rpc(ws, ++id, 'Page.navigate', { url: PAGE });
    await new Promise((r) => setTimeout(r, 3000));

    const evalJs = async (expr) => {
      const r = await rpc(ws, ++id, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description);
      return r.result.value;
    };

    const out = await evalJs(`(function(){
      FX.setLev(20);
      var inp = document.getElementById('marginInput');
      if (inp) { inp.value = '500'; inp.dispatchEvent(new Event('input', {bubbles:true})); }
      FX.openPosition('long');
      return 1;
    })()`);
    void out;
    await new Promise((r) => setTimeout(r, 400));

    const geom = await evalJs(`(function(){
      var btn = document.querySelector('#positions [data-fx-margin]');
      if (btn) btn.click();
      var wrap = document.getElementById('fx-margin-dialog');
      var panel = wrap && wrap.querySelector('.fx-mrg__panel');
      if (!panel) return { error: 'panel not found' };
      var w = wrap.getBoundingClientRect(), p = panel.getBoundingClientRect();
      var csW = getComputedStyle(wrap), csP = getComputedStyle(panel);
      return {
        innerWidth: window.innerWidth,
        docScrollWidth: document.documentElement.scrollWidth,
        bodyScrollWidth: document.body.scrollWidth,
        wrap: { x: w.x, width: w.width, padding: csW.padding, boxSizing: csW.boxSizing, display: csW.display },
        panel: { x: p.x, width: p.width, maxWidth: csP.maxWidth, boxSizing: csP.boxSizing },
        htmlZoom: getComputedStyle(document.documentElement).zoom,
        bodyZoom: getComputedStyle(document.body).zoom,
        viewportMeta: (document.querySelector('meta[name=viewport]')||{}).content || null
      };
    })()`);

    /* 对照：游戏自己的弹窗在同样视口下的几何 —— 用来判断溢出是我们引入的，
     * 还是移动端仿真/页面本身就有（两者结论完全不同）。 */
    const gameModal = await evalJs(`(function(){
      if (FX.openIntelMarket) FX.openIntelMarket();
      var m = document.getElementById('intelModal') || document.querySelector('.modal:not([hidden])');
      if (!m) return { none: true };
      var r = m.getBoundingClientRect();
      var inner = m.querySelector('.modal-card, .modal-inner, .modal-body') || m.firstElementChild;
      var ri = inner ? inner.getBoundingClientRect() : null;
      return { x: r.x, width: r.width, right: r.right,
               innerWidth: window.innerWidth,
               inner: ri ? { x: ri.x, width: ri.width, right: ri.right } : null };
    })()`);

    console.log(JSON.stringify({ marginDialog: geom, gameModal: gameModal }, null, 2));
  } finally {
    try { child.kill(); } catch (e) {}
  }
})().catch((e) => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
