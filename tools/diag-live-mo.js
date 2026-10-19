/*
 * 线上 MutationObserver / 注入时机诊断。
 *
 * 想回答两个问题：
 *   ① 追保按钮的注入是不是**稳定**的（每次重绘都能补回来，且不会重复）
 *   ② 页面里到底有几个 MutationObserver 在跑（模块重复装载的信号）
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || 'https://redtop-production.up.railway.app/';

function waitPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => { res.resume(); resolve(); })
        .on('error', () => { if (Date.now() > deadline) reject(new Error('CDP 未就绪')); else setTimeout(tick, 150); });
    };
    tick();
  });
}

(async function main() {
  const port = 9880 + Math.floor(Math.random() * 90);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-mo-' + Date.now()), 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  let ws = null;
  let id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const onMsg = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.id !== myId) return;
      ws.removeEventListener('message', onMsg);
      if (d.error) reject(new Error(JSON.stringify(d.error))); else resolve(d.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id: myId, method, params: params || {} }));
  });

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
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', () => rej(new Error('WS'))); });

    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await rpc('Page.navigate', { url: URL });
    await new Promise((r) => setTimeout(r, 6000));

    const ev = async (expr) => {
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
      return r.result.value;
    };

    console.log('目标：' + URL);

    console.log('\n=== 1. 开仓 ===');
    console.log(JSON.stringify(await ev(`(function(){
      FX.setLev(20);
      var i=document.getElementById('marginInput');
      if(i){i.value='500';i.dispatchEvent(new Event('input',{bubbles:true}));}
      FX.openPosition('long');
      return FX.state.positions.length;
    })()`)));

    /* ★ 关键：注入走 requestAnimationFrame，必须等一帧以上再数 */
    await new Promise((r) => setTimeout(r, 800));
    console.log('  等 800ms 后：rows =', await ev(`document.querySelectorAll('#positions .fx-margin-row').length`),
      ' btns =', await ev(`document.querySelectorAll('#positions [data-fx-margin]').length`));

    console.log('\n=== 2. 连续重绘后是否稳定（幂等）===');
    for (const n of [1, 5, 20]) {
      await ev(`(function(){ for(var i=0;i<${n};i++) FX.renderAll(); return 1; })()`);
      await new Promise((r) => setTimeout(r, 700));
      const rows = await ev(`document.querySelectorAll('#positions .fx-margin-row').length`);
      const btns = await ev(`document.querySelectorAll('#positions [data-fx-margin]').length`);
      console.log(`  重绘 ${String(n).padStart(2)} 次 → rows=${rows}  btns=${btns}`);
    }

    console.log('\n=== 3. 观察器数量与会话 ===');
    console.log(JSON.stringify(await ev(`(function(){
      var hits = [];
      // 通过覆盖构造器来统计"从现在起"还有谁在 new MutationObserver
      var O = window.MutationObserver;
      var n = 0;
      window.MutationObserver = function(cb){ n++; return new O(cb); };
      window.MutationObserver.prototype = O.prototype;
      FX.renderAll();
      return { newSinceHook: n };
    })()`)));

    console.log('\n=== 4. 幽灵对战可用性 ===');
    console.log(JSON.stringify(await ev(`(function(){
      try {
        var r = { battle: !!window.GhostBattle, ui: !!window.GhostUI, mock: !!window.MockServer };
        if (window.GhostBattle && window.GhostBattle.selfCheck) r.selfCheck = window.GhostBattle.selfCheck();
        if (window.MockServer && window.MockServer.listGhosts) r.ghosts = (window.MockServer.listGhosts()||[]).length;
        return r;
      } catch(e) { return { err: String(e && e.message || e) }; }
    })()`)));
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => { console.error('诊断失败：' + (e && e.stack || e)); process.exit(1); });
