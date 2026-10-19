/*
 * 单机版验收 —— 在**完全断网**的浏览器里打开 dist-ghost/index.html，
 * 证明它真的不需要任何网络。
 *
 * 验证手段：
 *   ① CDP Network.emulateNetworkConditions 把网络彻底掐断（offline: true）
 *   ② 从 file:// 打开单文件
 *   ③ 检查：游戏能玩、能开仓、能追保、幽灵对战可用、本地榜可读写
 *   ④ 断言：全程没有任何网络请求（连失败的都没有）
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///' + path.resolve(__dirname, '..', 'dist-ghost', 'index.html').replace(/\\/g, '/');

let pass = 0, fail = 0;
function ok(n, c, x) {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  → ' + JSON.stringify(x).slice(0, 200) : '')); }
}
function section(t) { console.log('\n' + t); }

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
  if (!fs.existsSync(PAGE.replace('file:///', '').replace(/\//g, path.sep))) {
    console.error('先跑 node tools/build-standalone.js');
    process.exit(1);
  }

  const port = 9300 + Math.floor(Math.random() * 200);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-offline-' + Date.now()), 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  let ws = null, id = 0;
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
    await rpc('Network.enable');

    /* 收集所有网络请求与失败 */
    const requests = [];
    const failures = [];
    const exceptions = [];
    ws.addEventListener('message', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.method === 'Network.requestWillBeSent') requests.push(d.params.request.url);
      if (d.method === 'Network.loadingFailed') failures.push(d.params.errorText);
      if (d.method === 'Runtime.exceptionThrown') {
        const ex = d.params.exceptionDetails;
        exceptions.push((ex.exception && ex.exception.description) || ex.text);
      }
    });

    /* ★ 彻底断网 */
    await rpc('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0,
    });

    await rpc('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    await rpc('Page.navigate', { url: PAGE });
    await new Promise((r) => setTimeout(r, 5000));

    const ev = async (expr) => {
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
      return r.result.value;
    };

    console.log('页面：' + PAGE);
    console.log('网络：已断网（offline: true）');

    section('=== A. 断网下页面能否加载 ===');
    const mods = await ev(`({
      fx: !!(window.FX && window.FX.state),
      mock: !!window.MockServer,
      ghost: !!window.GhostUI,
      battle: !!window.GhostBattle,
      margin: !!window.FXMargin,
      theme: !!document.getElementById('fx-theme'),
      online: !!window.FXOnline
    })`);
    ok('★ 游戏本体在断网下正常加载', mods && mods.fx === true, mods);
    ok('本地榜单（MockServer）就绪', mods && mods.mock === true);
    ok('幽灵对战就绪', mods && mods.ghost === true && mods.battle === true);
    ok('追加保证金就绪', mods && mods.margin === true);
    ok('主题已注入', mods && mods.theme === true);
    ok('★ 不含云存档客户端（不会尝试联网）', mods && mods.online === false, mods && mods.online);

    section('=== B. 全程零网络请求 ===');
    const external = requests.filter((u) => !u.startsWith('file://') && !u.startsWith('data:') && !u.startsWith('blob:'));
    ok('★ 没有发起任何外部网络请求', external.length === 0, external.slice(0, 5));
    ok('没有加载失败的资源', failures.length === 0, failures.slice(0, 3));
    ok('没有未捕获异常', exceptions.length === 0, exceptions.slice(0, 3));

    section('=== C. 断网下能真正玩 ===');
    const play = await ev(`(function(){
      try {
        FX.setLev(20);
        var i = document.getElementById('marginInput');
        if (i) { i.value='500'; i.dispatchEvent(new Event('input',{bubbles:true})); }
        FX.openPosition('long');
        var p = FX.state.positions[0];
        return { opened: !!p, margin: p && p.margin, balance: FX.state.balance };
      } catch(e) { return { err: String(e && e.message || e) }; }
    })()`);
    ok('★ 能开仓', play && play.opened === true, play);

    section('=== D. 断网下追保可用 ===');
    await new Promise((r) => setTimeout(r, 900));   /* 注入走 rAF */
    const margin = await ev(`(function(){
      var btn = document.querySelector('#positions [data-fx-margin]');
      if (!btn) return { exists: false };
      btn.click();
      var input = document.getElementById('fx-mrg-amount');
      input.value = '200'; input.dispatchEvent(new Event('input', {bubbles:true}));
      var before = FX.state.positions[0].margin;
      document.getElementById('fx-mrg-ok').click();
      return { exists: true, before: before, after: FX.state.positions[0].margin };
    })()`);
    ok('★ 追保按钮存在', margin && margin.exists === true, margin);
    ok('★ 追保真实改账（+200）', margin && Math.abs(margin.after - margin.before - 200) < 0.01, margin);

    section('=== E. 断网下幽灵对战可用 ===');
    const ghost = await ev(`(function(){
      try {
        return {
          selfCheck: window.GhostBattle && window.GhostBattle.selfCheck ? window.GhostBattle.selfCheck() : null,
          canRecord: !!(window.GhostBattle && window.GhostBattle.startRecording)
        };
      } catch(e) { return { err: String(e && e.message || e) }; }
    })()`);
    ok('幽灵自检通过', !!ghost && /已加载 ✅/.test(ghost.selfCheck || ''), ghost && ghost.selfCheck && ghost.selfCheck.slice(0, 120));
    ok('无错误', !!ghost && !ghost.err, ghost);

    section('=== F. 断网下本地榜可读写 ===');
    const board = await ev(`(function(){
      try {
        var api = window.MockServer;
        var keys = Object.keys(api || {});
        var out = { keys: keys };
        /* 签名是 saveScore(name, profit, opts) —— 三个位置参数，不是对象 */
        if (api && api.saveScore) {
          api.saveScore('断网测试', 12345, { id: 'offline-test' });
          var lb = api.getLeaderboard ? api.getLeaderboard() : null;
          out.lb = lb && lb.length;
          out.first = lb && lb[0] && lb[0].name;
        }
        return out;
      } catch(e) { return { err: String(e && e.message || e) }; }
    })()`);
    ok('本地榜可写入并读回', !!board && !board.err && board.lb >= 1, board);
    ok('写入的名字能读到', !!board && board.first === '断网测试', board && board.first);

    console.log('\n' + '='.repeat(56));
    console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
    console.log('='.repeat(56));
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => { console.error('验收失败：' + (e && e.stack || e)); process.exit(1); });
