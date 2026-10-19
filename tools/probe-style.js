/*
 * 样式探针：用 CDP 读取真实计算样式，定位"某个元素为什么还是白底"。
 *
 * 用法： node tools/probe-style.js intel 390
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///D:/delta/fx-online/dist-ghost/index.html';

const WHICH = process.argv[2] || 'intel';
const WIDTH = Number(process.argv[3] || 390);

const OPEN = {
  intel: 'FX.openIntelMarket()',
  market: 'FX.openMarket()',
  none: '1',
};

const SELECTORS = [
  '.im-tab.active', '.im-tab', '.im-tabs', '.im-pane',
  '.intel-repu', '.intel-repu-cell', '.modal-panel', '.im-lv',
  '.im-lv-top', '.im-lv-name', '.im-lv-price', '.im-lv-desc',
  '.im-lv-stats', '.im-lv-actions', '.im-stat', '.im-buy-btn',
  '.modal-head', '.modal-sub', '.market-foot', '#imFoot',
];

function waitForTarget(port, deadline) {
  return new Promise((resolve) => {
    let tried = 0;
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
      setTimeout(tick, 220);
    };
    tick();
  });
}

(async function main() {
  const port = 9200 + Math.floor(Math.random() * 400);
  const userDir = path.join(require('os').tmpdir(), 'fx-probe-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  const target = await waitForTarget(port, Date.now() + 20000);
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
    width: WIDTH, height: 900, deviceScaleFactor: 1, mobile: WIDTH < 600,
  });
  await rpc('Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2400));

  const opener = OPEN[WHICH] || '1';
  const opened = await rpc('Runtime.evaluate', {
    expression: opener, returnByValue: true,
  });
  console.log('打开：' + JSON.stringify(opened.result && opened.result.value));
  await new Promise((r) => setTimeout(r, 800));

  /* 逐个查计算样式 */
  const selsJson = JSON.stringify(SELECTORS);
  const expr = '(' + function (sels) {
    const out = [];
    sels.forEach((s) => {
      const el = document.querySelector(s);
      if (!el) { out.push(s + '  ➜  不存在'); return; }
      const cs = getComputedStyle(el);
      out.push(
        s + '\n      bg=' + cs.backgroundColor +
        '\n      color=' + cs.color +
        '\n      display=' + cs.display +
        '\n      grid=' + (cs.gridTemplateColumns || '-') +
        '\n      padding=' + cs.padding +
        '\n      height=' + cs.height + ' maxH=' + cs.maxHeight
      );
    });
    return out.join('\n');
  }.toString() + ')(' + selsJson + ')';

  const res = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true });
  console.log('\n=== 计算样式 ===\n' + res.result.value);

  /* 找出所有渲染出浅色背景的元素 —— 这是定位"白块"的最快方式 */
  const scan = '(' + function () {
    const light = [];
    const all = document.body.querySelectorAll('*');
    all.forEach((el) => {
      const cs = getComputedStyle(el);
      const bg = cs.backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return;
      const r = +m[1], g = +m[2], b = +m[3];
      /* 亮度 > 200 视为浅色 */
      if (r > 200 && g > 200 && b > 200) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 4 || rect.height < 4) return;
        light.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 60),
          id: el.id || '',
          bg: bg,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
        });
      }
    });
    return light.slice(0, 25);
  }.toString() + ')()';

  const scanRes = await rpc('Runtime.evaluate', {
    expression: scan, returnByValue: true,
  });
  const list = scanRes.result.value || [];
  console.log('\n=== 仍为浅色背景的元素（' + list.length + ' 个）===');
  if (!list.length) {
    console.log('  无 ✅');
  } else {
    list.forEach((x) => {
      console.log('  <' + x.tag + (x.id ? ' #' + x.id : '') +
        (x.cls ? ' .' + x.cls.split(' ').join('.') : '') + '>  ' +
        x.bg + '  ' + x.w + 'x' + x.h);
    });
  }

  ws.close();
  child.kill();
  setTimeout(() => process.exit(0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
