/*
 * 直接对**线上部署**做真实浏览器测试：看它到底发不发存档请求。
 *
 * 前面验证过：后端正常、页面代码正确。
 * 那就只剩"前端运行时没有触发同步"这一种可能。
 *
 * 这个脚本用 CDP 打开线上地址，注入假登录态，模拟交易，
 * 观察它是否真的调用了 /api/account/sync。
 *
 * 运行： node tools/probe-live-save.js
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const SITE = 'https://redtop-production.up.railway.app/';

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
  const userDir = path.join(require('os').tmpdir(), 'fx-live-' + Date.now());

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

  /* 记录所有网络请求 */
  const requests = [];
  const consoleMsgs = [];
  ws.addEventListener('message', (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch (e) { return; }
    if (d.method === 'Network.requestWillBeSent') {
      const u = d.params.request.url;
      if (u.indexOf('/api/') >= 0) {
        requests.push({
          url: u.replace(SITE.slice(0, -1), ''),
          method: d.params.request.method,
          body: (d.params.request.postData || '').slice(0, 120),
        });
      }
    }
    if (d.method === 'Runtime.consoleAPICalled') {
      const txt = (d.params.args || []).map((a) => a.value || a.description || '').join(' ');
      if (txt) consoleMsgs.push(txt.slice(0, 160));
    }
  });

  await rpc('Emulation.setDeviceMetricsOverride', {
    width: 1400, height: 900, deviceScaleFactor: 1, mobile: false,
  });

  console.log('\n打开线上站点：' + SITE);
  await rpc('Page.navigate', { url: SITE });
  await new Promise((r) => setTimeout(r, 5000));

  /* 检查页面状态 */
  const state = await rpc('Runtime.evaluate', {
    expression: `(function(){
      return {
        hasFX: !!window.FX,
        hasFXOnline: !!window.FXOnline,
        balance: window.FX ? window.FX.state.balance : null,
        tickCount: window.FX ? window.FX.state.tickCount : null,
        token: (function(){
          try { return !!localStorage.getItem('fx-online-token-v1'); } catch(e){ return false; }
        })(),
        accountLoaded: window.FXOnline && window.FXOnline.account
          ? window.FXOnline.account.loaded : null,
        hasSave: window.FXOnline && window.FXOnline.account
          ? window.FXOnline.account.hasSave : null,
        syncNowExists: !!(window.FXOnline && window.FXOnline.syncNow),
      };
    })()`,
    returnByValue: true,
  });

  console.log('\n=== 页面运行时状态 ===');
  const st = state.result.value;
  console.log('  window.FX        :', st.hasFX);
  console.log('  window.FXOnline  :', st.hasFXOnline);
  console.log('  当前余额         : $' + st.balance);
  console.log('  有登录 token     :', st.token);
  console.log('  account.loaded   :', st.accountLoaded);
  console.log('  account.hasSave  :', st.hasSave);
  console.log('  syncNow 可调用   :', st.syncNowExists);

  console.log('\n=== 页面启动时发出的 /api/ 请求 ===');
  if (!requests.length) {
    console.log('  （无）← 这就是问题：前端完全没有请求后端');
  } else {
    requests.forEach((r) => console.log('  ' + r.method + ' ' + r.url));
  }

  /* 关键实验：注入假 token，看是否会触发存档请求 */
  console.log('\n=== 实验：注入假登录态后，手动触发同步 ===');
  const inject = await rpc('Runtime.evaluate', {
    expression: `(function(){
      try {
        localStorage.setItem('fx-online-token-v1', 'fake.token.sig');
      } catch(e) {}
      if (!window.FXOnline) return { error: 'no FXOnline' };
      window.FXOnline.state.token = 'fake.token.sig';
      // 直接调用同步，看它发不发请求
      if (window.FXOnline.syncNow) {
        window.FXOnline.syncNow(true);
        return { called: true };
      }
      return { called: false, error: 'no syncNow' };
    })()`,
    returnByValue: true,
  });
  console.log('  注入结果:', JSON.stringify(inject.result.value));

  await new Promise((r) => setTimeout(r, 2500));

  console.log('\n=== 注入后新增的 /api/ 请求 ===');
  const after = requests.filter((r) => r.url.indexOf('/score') >= 0 ||
    r.url.indexOf('/account') >= 0 || r.url.indexOf('/me') >= 0);
  if (!after.length) {
    console.log('  （无）← syncNow 调用了但没发请求');
  } else {
    after.forEach((r) => console.log('  ' + r.method + ' ' + r.url +
      (r.body ? '\n     body: ' + r.body : '')));
  }

  console.log('\n=== 控制台输出（前 12 条）===');
  consoleMsgs.slice(0, 12).forEach((m) => console.log('  ' + m));

  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
