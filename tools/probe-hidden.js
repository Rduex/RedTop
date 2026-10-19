/*
 * 隐藏元素泄漏检查：找出"设置了 hidden 属性、但实际仍被显示"的元素。
 *
 * 这类 bug 极隐蔽 —— DOM 上 hidden=true，肉眼却看得见，
 * 因为某条 CSS 的 display 覆盖了 [hidden] 的 display:none。
 *
 * 运行： node tools/probe-hidden.js [宽度]
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///D:/delta/fx-online/dist-ghost/index.html';
const WIDTH = Number(process.argv[2] || 1400);

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

const scanFn = function () {
  const leaked = [];
  const all = document.querySelectorAll('[hidden]');
  all.forEach(function (el) {
    const cs = getComputedStyle(el);
    if (cs.display !== 'none') {
      const r = el.getBoundingClientRect();
      leaked.push({
        tag: el.tagName.toLowerCase(),
        id: el.id || '',
        cls: (el.className || '').toString().slice(0, 60),
        display: cs.display,
        w: Math.round(r.width),
        h: Math.round(r.height),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      });
    }
  });
  return leaked;
};

(async function main() {
  const port = 9200 + Math.floor(Math.random() * 400);
  const userDir = path.join(require('os').tmpdir(), 'fx-ph-' + Date.now());

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
    width: WIDTH, height: 1000, deviceScaleFactor: 1, mobile: WIDTH < 600,
  });
  await rpc('Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2600));

  const res = await rpc('Runtime.evaluate', {
    expression: '(' + scanFn.toString() + ')()',
    returnByValue: true,
  });
  const leaked = res.result.value || [];

  console.log('\n视口 width = ' + WIDTH);
  console.log('带 hidden 属性的元素扫描中…\n');

  if (!leaked.length) {
    console.log('✅ 所有 hidden 元素都正确隐藏了');
  } else {
    console.log('❌ 有 ' + leaked.length + ' 个 hidden 元素仍在显示：\n');
    leaked.forEach((x) => {
      console.log('  <' + x.tag + (x.id ? ' #' + x.id : '') +
        (x.cls ? ' .' + x.cls.split(' ').join('.') : '') + '>');
      console.log('     display=' + x.display + '  ' + x.w + 'x' + x.h +
        '  内容："' + x.text + '"');
    });
  }

  ws.close();
  child.kill();
  setTimeout(() => process.exit(leaked.length ? 1 : 0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
