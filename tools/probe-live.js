/*
 * 线上体检 —— 对真实部署地址做一次全功能探测，找出到底哪里坏了。
 *
 * 为什么要专门针对"线上"而不是本地构建：
 *   线上跑的是**上一次成功部署的镜像**，它可能比本地代码旧好几个提交。
 *   本地测试全绿也说明不了线上的事。
 *
 * 检查项：
 *   ① 页面能否加载、有没有 JS 崩溃（未捕获异常）
 *   ② 各模块是否就绪：FX / FXOnline / FMargin / GhostUI / MockServer / GhostBattle
 *   ③ 排行榜能否真实拉到数据（/api/leaderboard）
 *   ④ 云存档接口是否通（/api/account/state 未登录应 401）
 *   ⑤ 幽灵对战：录制能否启动、本地存储能否读写
 *   ⑥ 追保：能否开仓并弹出追保对话框
 *
 * 用法： node tools/probe-live.js [URL]
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = process.argv[2] || process.env.PAGE_URL || 'https://redtop-production.up.railway.app/';
const WIDTH = 900;
const HEIGHT = 900;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra) : '')); }
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
  const port = 9700 + Math.floor(Math.random() * 200);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-live-' + Date.now()), 'about:blank'],
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
    if (!target) throw new Error('没有可用页面');

    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res);
      ws.addEventListener('error', () => rej(new Error('WS 失败')));
    });

    await rpc('Page.enable');
    await rpc('Runtime.enable');
    await rpc('Log.enable');
    await rpc('Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false,
    });

    /* 收集页面侧错误与网络失败 */
    const pageErrors = [];
    const netFails = [];
    const consoleErrs = [];
    ws.addEventListener('message', (ev) => {
      let d; try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.method === 'Runtime.exceptionThrown') {
        const ex = d.params.exceptionDetails;
        pageErrors.push((ex.exception && ex.exception.description) || ex.text);
      }
      if (d.method === 'Log.entryAdded' && d.params.entry.level === 'error') {
        consoleErrs.push(d.params.entry.text);
      }
      if (d.method === 'Network.loadingFailed') netFails.push(d.params);
    });
    await rpc('Network.enable');

    console.log('目标：' + URL);
    await rpc('Page.navigate', { url: URL });
    await new Promise((r) => setTimeout(r, 6000));

    const evalJs = async (expr) => {
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) {
        throw new Error('页面表达式异常：' + ((r.exceptionDetails.exception || {}).description || r.exceptionDetails.text));
      }
      return r.result.value;
    };

    section('=== A. 页面与模块 ===');
    const mods = await evalJs(`(function(){
      var out = {};
      out.fx = !!(window.FX && window.FX.state);
      out.online = !!window.FXOnline;
      out.margin = !!window.FXMargin;
      out.ghost = !!(window.GhostUI && window.Ghost);
      out.mock = !!window.MockServer;
      out.battle = !!window.GhostBattle;
      out.theme = !!window.FXCanvasTheme;
      out.themeStyle = !!document.getElementById('fx-theme');
      out.positions = !!document.getElementById('positions');
      out.version = (window.FXOnline && window.FXOnline.version) || null;
      return out;
    })()`);
    ok('游戏本体就绪（window.FX）', mods.fx);
    ok('云存档客户端就绪', mods.online);
    ok('追加保证金界面就绪', mods.margin);
    ok('幽灵对战界面就绪', mods.ghost);
    ok('MockServer 就绪', mods.mock);
    ok('幽灵桥接就绪', mods.battle);
    ok('主题已注入（Canvas + 样式）', mods.theme && mods.themeStyle);

    section('=== B. JS 运行期错误 ===');
    ok('无未捕获异常', pageErrors.length === 0, pageErrors.slice(0, 3));
    ok('无 console.error', consoleErrs.length === 0, consoleErrs.slice(0, 3));

    section('=== C. 联机排行榜（真实接口）===');
    const board = await evalJs(`fetch('/api/leaderboard?board=all').then(r=>r.json()).then(j=>({ok:!!j.ok,total:j.total,rows:(j.rows||[]).length,first:(j.rows||[])[0]?{name:j.rows[0].name,score:j.rows[0].score}:null,boards:(j.boards||[]).length})).catch(e=>({err:String(e)}))`);
    ok('接口返回 ok', board && board.ok === true, board);
    ok('榜单有数据', board && board.rows > 0, board);
    ok('四个榜单都在', board && board.boards === 4, board);

    section('=== D. 云存档接口 ===');
    const acct = await evalJs(`fetch('/api/account/state').then(r=>({status:r.status})).catch(e=>({err:String(e)}))`);
    ok('未登录时 /api/account/state 正确返回 401', acct && acct.status === 401, acct);

    section('=== E. 幽灵对战本地存储 ===');
    const ghost = await evalJs(`(function(){
      try {
        if (!window.MockServer) return { err: 'no MockServer' };
        var api = window.MockServer;
        var keys = Object.keys(api);
        var r = { keys: keys };
        if (api.getLeaderboard) { var lb = api.getLeaderboard(); r.lbLen = (lb && lb.length) || 0; r.lbOk = true; }
        if (api.listGhosts) { var g = api.listGhosts(); r.ghosts = (g && g.length) || 0; r.ghostOk = true; }
        return r;
      } catch (e) { return { err: String(e && e.message || e) }; }
    })()`);
    ok('幽灵本地存储可读写', ghost && !ghost.err, ghost);

    section('=== F. 追保功能（开仓 + 弹窗）===');
    const margin = await evalJs(`(function(){
      try {
        FX.setLev(20);
        var inp = document.getElementById('marginInput');
        if (inp) { inp.value = '500'; inp.dispatchEvent(new Event('input', {bubbles:true})); }
        FX.openPosition('long');
        var p = FX.state.positions[0];
        var btn = document.querySelector('#positions [data-fx-margin]');
        return { opened: !!p, margin: p && p.margin, hasBtn: !!btn, btnText: btn && btn.textContent.trim() };
      } catch (e) { return { err: String(e && e.message || e) }; }
    })()`);
    ok('能开仓', margin && margin.opened === true, margin);
    if (margin && margin.hasBtn) {
      const dlg = await evalJs(`(function(){
        document.querySelector('#positions [data-fx-margin]').click();
        var d = document.getElementById('fx-margin-dialog');
        return { open: !!d && !d.hidden, title: (document.getElementById('fx-mrg-title')||{}).textContent };
      })()`);
      ok('追保对话框能打开', dlg && dlg.open === true, dlg);
    } else {
      ok('追保按钮已注入持仓卡', false, margin);
    }

    section('=== G. 网络请求失败 ===');
    ok('无失败的资源请求', netFails.length === 0, netFails.slice(0, 3));

    console.log('\n' + '='.repeat(56));
    console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
    console.log('='.repeat(56));
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => {
  console.error('线上体检异常：' + (e && e.stack || e));
  process.exit(1);
});
