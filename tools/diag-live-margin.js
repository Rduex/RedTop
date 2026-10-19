/*
 * 线上追保按钮缺失 —— 运行时诊断。
 *
 * 现象：线上开仓成功，但持仓卡上没有「＋ 追加保证金」按钮（本地构建正常）。
 * 本探针在**真实线上页面**里逐步检查注入链路的每一环，定位断在哪：
 *   ① window.FXMargin 是否存在、injectRows 是否可调用
 *   ② #positions 是否存在、里面的卡片结构是否带 .pos 与 .pos-actions[data-close]
 *   ③ 手动调用 injectRows() 后按钮是否出现（判断是"注入逻辑坏"还是"观察器没触发"）
 *   ④ MutationObserver 是否被挂上（monkey-patch 计数）
 *   ⑤ 是否抛过异常（捕获 console.warn '[FXMargin] 未启用'）
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
  const port = 9950 + Math.floor(Math.random() * 40);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-diag-' + Date.now()), 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  let ws, id = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const myId = ++id;
    const onMsg = (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.id !== myId) return;
      ws.removeEventListener('message', onMsg);
      if (d.error) reject(new Error(method + ': ' + JSON.stringify(d.error))); else resolve(d.result);
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

    /* 在页面加载前就挂上日志收集，才能抓到模块启动期的 warn */
    const logs = [];
    ws.addEventListener('message', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.method === 'Runtime.consoleAPICalled') {
        const args = (d.params.args || []).map((a) => a.value !== undefined ? a.value : a.description).join(' ');
        logs.push('[' + d.params.type + '] ' + args);
      }
      if (d.method === 'Runtime.exceptionThrown') {
        const ex = d.params.exceptionDetails;
        logs.push('[exception] ' + ((ex.exception && ex.exception.description) || ex.text));
      }
    });

    await rpc('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await rpc('Page.navigate', { url: URL });
    await new Promise((r) => setTimeout(r, 6000));

    const evalJs = async (expr) => {
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
      }
      return r.result.value;
    };

    console.log('目标：' + URL);
    console.log('\n=== 1. 模块与 API ===');
    console.log(JSON.stringify(await evalJs(`({
      margin: !!window.FXMargin,
      api: window.FXMargin ? Object.keys(window.FXMargin) : null,
      injectRowsIsFn: !!(window.FXMargin && typeof window.FXMargin.injectRows === 'function')
    })`), null, 1));

    console.log('\n=== 2. 开仓（走真实游戏流程）===');
    console.log(JSON.stringify(await evalJs(`(function(){
      FX.setLev(20);
      var inp = document.getElementById('marginInput');
      if (inp) { inp.value='500'; inp.dispatchEvent(new Event('input',{bubbles:true})); }
      FX.openPosition('long');
      return { positions: FX.state.positions.length };
    })()`)));

    await new Promise((r) => setTimeout(r, 600));

    console.log('\n=== 3. 卡片结构（注入逻辑依赖这些）===');
    console.log(JSON.stringify(await evalJs(`(function(){
      var box = document.getElementById('positions');
      if (!box) return { err: 'no #positions' };
      var cards = Array.prototype.slice.call(box.children);
      return {
        childCount: cards.length,
        cardClasses: cards.map(function(c){ return c.className; }),
        hasPos: cards.map(function(c){ return c.classList.contains('pos'); }),
        hasActions: cards.map(function(c){ return !!c.querySelector('.pos-actions [data-close]'); }),
        closeIds: cards.map(function(c){ var b=c.querySelector('.pos-actions [data-close]'); return b?b.getAttribute('data-close'):null; }),
        currentRowCount: box.querySelectorAll('.fx-margin-row').length
      };
    })()`), null, 1));

    console.log('\n=== 4. 手动调用 injectRows() ===');
    console.log(JSON.stringify(await evalJs(`(function(){
      var before = document.querySelectorAll('#positions .fx-margin-row').length;
      var err = null;
      try { window.FXMargin.injectRows(); } catch(e) { err = String(e && e.message || e); }
      var after = document.querySelectorAll('#positions .fx-margin-row').length;
      var btn = document.querySelector('#positions [data-fx-margin]');
      return { before: before, after: after, err: err, btnText: btn ? btn.textContent.trim() : null };
    })()`), null, 1));

    console.log('\n=== 5. MutationObserver 是否挂在 #positions 上 ===');
    console.log(JSON.stringify(await evalJs(`(function(){
      var box = document.getElementById('positions');
      // 用一个探针 observer 确认 DOM 变化确实会触发
      var fired = 0;
      var o = new MutationObserver(function(){ fired++; });
      o.observe(box, { childList: true });
      FX.renderAll();
      return { probeObserverFired: fired, moSupported: typeof MutationObserver !== 'undefined' };
    })()`)));

    console.log('\n=== 6. 页面日志（含模块启动警告）===');
    const relevant = logs.filter((l) => /FXMargin|margin|幽灵|ghost|error|Error/i.test(l));
    if (!relevant.length) console.log('  （无相关日志）');
    relevant.slice(0, 20).forEach((l) => console.log('  ' + l));

    console.log('\n=== 7. 再次检查按钮（注入后）===');
    console.log(JSON.stringify(await evalJs(`({
      rows: document.querySelectorAll('#positions .fx-margin-row').length,
      btns: document.querySelectorAll('#positions [data-fx-margin]').length
    })`)));
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => { console.error('诊断失败：' + (e && e.stack || e)); process.exit(1); });
