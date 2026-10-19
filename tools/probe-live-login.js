/*
 * 线上完整流程验证：打开页面 → 真实注册登录 → 改资金 → 看是否发出 sync。
 *
 * 前面只验证了"未登录时不发请求"（那是设计如此）。
 * 这次真正走一遍登录，确认登录后存档链路是否打通。
 *
 * 运行： node tools/probe-live-login.js
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SITE = 'https://redtop-production.up.railway.app/';
const NAME = 'livetest' + Math.floor(Math.random() * 10000);

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
  const userDir = path.join(require('os').tmpdir(), 'fx-ll-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  const target = await waitTarget(port, Date.now() + 25000);
  if (!target) throw new Error('Chrome 未就绪');

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
  await rpc('Network.enable');

  const apiCalls = [];
  ws.addEventListener('message', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.method === 'Network.requestWillBeSent') {
      const u = d.params.request.url;
      if (u.indexOf('/api/') >= 0) {
        apiCalls.push({
          m: d.params.request.method,
          u: u.replace(SITE.slice(0, -1), ''),
          body: (d.params.request.postData || '').slice(0, 150),
        });
      }
    }
  });

  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  console.log('\n打开线上站点...');
  await rpc('Page.navigate', { url: SITE });
  await new Promise((r) => setTimeout(r, 4500));

  console.log('注册账号: ' + NAME);
  const reg = await rpc('Runtime.evaluate', {
    expression: `fetch('/api/register', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({name: ${JSON.stringify(NAME)}, password: 'livetest123'})
    }).then(r => r.json())`,
    awaitPromise: true,
    returnByValue: true,
  });
  const regData = reg.result.value;
  console.log('  注册结果: ' + (regData.ok ? '✅ ' + regData.user.name : '❌ ' + regData.error));

  if (!regData.ok) {
    console.log('无法注册，测试中止');
    ws.close(); child.kill();
    return setTimeout(() => process.exit(1), 250);
  }

  /* 把 token 写入 localStorage 并重新加载页面，模拟真实登录后的状态 */
  console.log('\n写入 token 并刷新页面（模拟已登录状态）...');
  await rpc('Runtime.evaluate', {
    expression: `localStorage.setItem('fx-online-token-v1', ${JSON.stringify(regData.token)});
                 localStorage.setItem('fx-online-user-v1', ${JSON.stringify(JSON.stringify(regData.user))});`,
  });
  await rpc('Page.reload');
  await new Promise((r) => setTimeout(r, 5000));

  const st = await rpc('Runtime.evaluate', {
    expression: `(function(){
      return {
        balance: window.FX ? window.FX.state.balance : null,
        hasToken: !!localStorage.getItem('fx-online-token-v1'),
        loaded: window.FXOnline && window.FXOnline.account ? window.FXOnline.account.loaded : null,
        hasSave: window.FXOnline && window.FXOnline.account ? window.FXOnline.account.hasSave : null,
        lastSyncAt: window.FXOnline && window.FXOnline.account ? window.FXOnline.account.lastSyncAt : null,
      };
    })()`,
    returnByValue: true,
  });
  console.log('\n=== 登录后的运行时状态 ===');
  const v = st.result.value;
  console.log('  有 token      :', v.hasToken);
  console.log('  account.loaded:', v.loaded, v.loaded ? '✅' : '❌ 同步会被拦截！');
  console.log('  account.hasSave:', v.hasSave);
  console.log('  当前余额      : $' + v.balance);

  console.log('\n=== 本次页面加载发出的 /api/ 请求 ===');
  apiCalls.forEach((c) => console.log('  ' + c.m + ' ' + c.u));

  /* 关键：改余额并触发同步 */
  console.log('\n=== 改资金 $45,678 并等待自动同步 ===');
  await rpc('Runtime.evaluate', {
    expression: `window.FX.state.balance = 45678;`,
  });
  await new Promise((r) => setTimeout(r, 6000));

  console.log('\n=== 同步后是否出现 /api/account/sync ===');
  const syncs = apiCalls.filter((c) => c.u.indexOf('/api/account/sync') >= 0);
  if (!syncs.length) {
    console.log('  ❌ 没有发出 sync 请求');
  } else {
    syncs.forEach((c) => console.log('  ✅ ' + c.m + ' ' + c.u + '\n     ' + c.body));
  }

  /* 最后用服务端验证数据真的存下来了 */
  const verify = await rpc('Runtime.evaluate', {
    expression: `fetch('/api/account/state', {
      headers: {'X-FX-Token': localStorage.getItem('fx-online-token-v1')}
    }).then(r => r.json())`,
    awaitPromise: true,
    returnByValue: true,
  });
  console.log('\n=== 服务端实际存的值 ===');
  console.log('  ' + JSON.stringify(verify.result.value).slice(0, 200));

  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
