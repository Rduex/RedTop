/*
 * 为什么"MutationObserver 没触发"按钮却还在？
 *
 * 上一轮探测发现 newSinceHook = 0，但重绘 20 次后按钮仍稳定存在。
 * 两种可能：
 *   A. 观察器在模块启动时已挂好，我的 hook 挂得太晚（只统计"之后"新建的），
 *      所以 0 是正常的 —— 按钮靠观察器补回来。
 *   B. 观察器压根没生效，但 renderPositions() 每次重绘时都会顺带重建卡片，
 *      而按钮是**另一次渲染**补进去的 —— 那就存在竞态（有时能补、有时不能）。
 *
 * 这个探针直接判定：临时把 #positions 整个重建（模拟真实重绘），
 * 在不触发 rAF 的情况下看按钮会不会自动回来。
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
  const port = 9910 + Math.floor(Math.random() * 70);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-mo2-' + Date.now()), 'about:blank'],
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
    await ev(`(function(){ FX.setLev(20); var i=document.getElementById('marginInput'); if(i){i.value='500';i.dispatchEvent(new Event('input',{bubbles:true}));} FX.openPosition('long'); return 1; })()`);
    await new Promise((r) => setTimeout(r, 900));
    console.log('开仓后 rows =', await ev(`document.querySelectorAll('#positions .fx-margin-row').length`));

    console.log('\n=== A. 手动把 #positions 掏空，再触发一次真实重绘，看观察器会不会补 ===');
    console.log(JSON.stringify(await ev(`(function(){
      var box = document.getElementById('positions');
      // 模拟"游戏自己重建了卡片但还没注入"的状态
      box.innerHTML = box.innerHTML;      // 重新解析，插入的节点全没了
      var afterWipe = box.querySelectorAll('.fx-margin-row').length;
      return { afterWipe: afterWipe };
    })()`)));

    await new Promise((r) => setTimeout(r, 900));
    console.log('  不手动 renderAll，等 900ms 后 rows =',
      await ev(`document.querySelectorAll('#positions .fx-margin-row').length`),
      '（>0 说明观察器在工作；=0 说明没观察器）');

    console.log('\n=== B. FX.renderAll()（真实重绘路径）后是否自动补回 ===');
    console.log(JSON.stringify(await ev(`(function(){
      FX.renderAll();
      return { immediatelyAfterRender: document.querySelectorAll('#positions .fx-margin-row').length };
    })()`)));
    await new Promise((r) => setTimeout(r, 900));
    console.log('  等 900ms 后 rows =', await ev(`document.querySelectorAll('#positions .fx-margin-row').length`));

    console.log('\n=== C. 页面里 MutationObserver 是否被改写/禁用 ===');
    console.log(JSON.stringify(await ev(`(function(){
      return {
        native: String(window.MutationObserver).slice(0, 40),
        isNative: /\\[native code\\]/.test(String(window.MutationObserver)),
        hasObserve: typeof MutationObserver.prototype.observe === 'function'
      };
    })()`)));

    console.log('\n=== D. 直接问模块自己的状态 ===');
    console.log(JSON.stringify(await ev(`(function(){
      var api = window.FXMargin;
      return { keys: Object.keys(api), isOpen: api.isOpen ? api.isOpen() : null };
    })()`)));
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => { console.error('诊断失败：' + (e && e.stack || e)); process.exit(1); });
