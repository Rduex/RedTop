/*
 * 桌面端布局检查：测量每个卡片在哪一列、有多大、有没有重叠。
 *
 * 用法： node tools/probe-layout.js [宽度]
 *
 * 这是做双栏布局时最有用的工具 ——
 * 肉眼看截图只能看出"有空隙"，但看不出"哪张卡在哪一列、是否重叠"。
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

/* 在页面里跑：返回每个卡片的位置信息 */
function measureFn() {
  const out = [];
  const phone = document.querySelector('.phone');
  if (!phone) return { error: 'no .phone' };
  const pcs = getComputedStyle(phone);
  const phoneRect = phone.getBoundingClientRect();

  const kids = Array.prototype.slice.call(phone.children);
  kids.forEach(function (el) {
    const r = el.getBoundingClientRect();
    const cls = (el.className || '').split(/\s+/)
      .filter(function (c) { return c && c !== 'card'; }).join('.') || el.tagName.toLowerCase();
    out.push({
      cls: cls,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      hidden: !!el.hidden,
    });
  });

  /* 重叠检测：两两比较，面积交集 > 1px² 就算重叠 */
  const overlaps = [];
  const visible = out.filter(function (o) { return !o.hidden; });
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i], b = visible[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) {
        overlaps.push(a.cls + ' × ' + b.cls + '  重叠 ' + ox + 'x' + oy + 'px');
      }
    }
  }

  /* 分栏：按 x 坐标聚类 */
  const xs = Array.from(new Set(visible.map(function (o) { return o.x; }))).sort(function (a, b) { return a - b; });
  const cols = [];
  xs.forEach(function (x) {
    const hit = cols.find(function (c) { return Math.abs(c - x) < 40; });
    if (hit === undefined) cols.push(x);
  });

  /* 横向总占用（是否填满容器） */
  let maxRight = 0;
  visible.forEach(function (o) { if (o.x + o.w > maxRight) maxRight = o.x + o.w; });
  const containerRight = phoneRect.left + phoneRect.width;

  return {
    columnCount: pcs.columnCount,
    phoneWidth: Math.round(phoneRect.width),
    columns: cols.map(function (c) { return Math.round(c); }),
    gaps: cols.length > 1 ? Math.round(cols[1] - cols[0]) : 0,
    usedWidth: Math.round(maxRight - phoneRect.left),
    containerWidth: Math.round(phoneRect.width),
    fillRatio: Math.round((maxRight - phoneRect.left) / phoneRect.width * 100) + '%',
    cards: out,
    overlaps: overlaps,
  };
}

(async function main() {
  const port = 9200 + Math.floor(Math.random() * 400);
  const userDir = path.join(require('os').tmpdir(), 'fx-pl-' + Date.now());

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
    expression: '(' + measureFn.toString() + ')()',
    returnByValue: true,
  });
  const m = res.result.value;

  if (m.error) { console.error(m.error); process.exit(1); }

  console.log('');
  console.log('视口 width = ' + WIDTH);
  console.log('容器 .phone = ' + m.containerWidth + 'px  (column-count: ' + m.columnCount + ')');
  console.log('检测到 ' + m.columns.length + ' 列，x = ' + m.columns.join(', ') +
    (m.gaps ? '  （列间距 ' + m.gaps + 'px）' : ''));
  console.log('内容占用 ' + m.usedWidth + ' / ' + m.containerWidth +
    'px  → 填充率 ' + m.fillRatio);
  console.log('');
  console.log('--- 各卡片位置 ---');
  m.cards.forEach((c) => {
    if (c.hidden) return;
    console.log('  ' + c.cls.padEnd(28, ' ') +
      'x=' + String(c.x).padStart(4) + '  y=' + String(c.y).padStart(4) +
      '  ' + c.w + 'x' + c.h);
  });

  const hiddenCount = m.cards.filter((c) => c.hidden).length;
  if (hiddenCount) console.log('  （另有 ' + hiddenCount + ' 张隐藏卡片）');

  console.log('');
  if (m.overlaps.length) {
    console.log('❌ 检测到 ' + m.overlaps.length + ' 处重叠：');
    m.overlaps.forEach((o) => console.log('   ' + o));
  } else {
    console.log('✅ 无重叠');
  }

  /* 填满程度判断：低于 85% 说明右侧有明显空白 */
  const ratio = parseInt(m.fillRatio, 10);
  if (ratio < 85) {
    console.log('⚠ 填充率仅 ' + m.fillRatio + '，右侧可能留白');
  }

  ws.close();
  child.kill();
  setTimeout(() => process.exit(m.overlaps.length ? 1 : 0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
