/*
 * 确认「equity 差 21 元」到底是不是存档兼容性问题。
 *
 * 假设：两版游戏的开盘基准价（或行情种子）不同，所以同一笔"入场价 1.09"的仓位，
 * 在新旧两版里的当前浮盈不一样 —— 这是**行情差异**，不是存档结构差异。
 *
 * 验证方法：把两版的当前价强制对齐（直接改 book.price 到同一值），
 * 再看 equity 是否完全一致。若一致 → 存档口径没问题。
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const SAVE = {
  balance: 45678.9,
  positions: [{
    id: 5, pair: 'EUR/USD', side: 'long', margin: 700, lev: 20,
    notional: 14000, entry: 1.09, fee: 2.1, openTs: 1700000000000, openTick: 0,
  }],
};

function waitPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => { res.resume(); resolve(); })
        .on('error', () => { if (Date.now() > deadline) reject(new Error('CDP 就绪失败')); else setTimeout(tick, 150); });
    };
    tick();
  });
}

async function run(url) {
  const port = 9450 + Math.floor(Math.random() * 250);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-eq-' + Date.now()), 'about:blank'],
  { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  let ws = null, id = 0;
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
    await rpc('Page.navigate', { url: url });
    await new Promise((r) => setTimeout(r, 3500));

    const ev = async (expr) => {
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
      return r.result.value;
    };

    /* 恢复存档，然后把现价钉到 1.09（= 入场价，浮盈应为 0），比较 equity */
    return await ev(`(function(){
      var save = ${JSON.stringify(SAVE)};
      var s = FX.state;
      s.balance = save.balance;
      s.positions = JSON.parse(JSON.stringify(save.positions));
      s.locked = 700; s.seq = 5;

      /* 把该货币对现价钉到入场价：浮盈必然为 0 */
      var pair = s.positions[0].pair;
      var book = FX.books && FX.books[pair];
      var origPrice = book ? book.price : null;
      if (book) book.price = s.positions[0].entry;

      var out = {
        origPrice: origPrice,
        pinnedPrice: book ? book.price : null,
        equityAtEntry: null, pnlAtEntry: null,
        locked: s.locked, available: FX.available(), seq: s.seq,
        posKeys: Object.keys(s.positions[0]).sort()
      };
      try { out.equityAtEntry = FX.equity(); } catch(e) { out.equityErr = String(e.message||e); }
      try { out.pnlAtEntry = FX.pnlOf(s.positions[0]); } catch(e) { out.pnlErr = String(e.message||e); }
      try { out.liq = FX.liqPriceOf(s.positions[0]); } catch(e) { out.liqErr = String(e.message||e); }
      /* 再钉一个 +1% 的价格，验证浮动盈亏公式一致 */
      if (book) book.price = s.positions[0].entry * 1.01;
      try { out.equityAtUp1pct = FX.equity(); out.pnlAtUp1pct = FX.pnlOf(s.positions[0]); } catch(e) {}
      return out;
    })()`);
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
}

(async function main() {
  const ROOT = path.resolve(__dirname, '..');
  const NEW = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/');
  const OLD = 'file:///D:/delta/tmp-oldbody/public/index.html';

  const n = await run(NEW);
  console.log('新本体：');
  console.log(JSON.stringify(n, null, 1));

  if (fs.existsSync('D:/delta/tmp-oldbody/public/index.html')) {
    const o = await run(OLD);
    console.log('\n旧本体 V1.4：');
    console.log(JSON.stringify(o, null, 1));
    console.log('\n=== 钉到同一现价后的对比 ===');
    const rows = [
      ['入场价处 equity', n.equityAtEntry, o.equityAtEntry],
      ['入场价处 pnl', n.pnlAtEntry, o.pnlAtEntry],
      ['+1% 时 equity', n.equityAtUp1pct, o.equityAtUp1pct],
      ['+1% 时 pnl', n.pnlAtUp1pct, o.pnlAtUp1pct],
      ['available', n.available, o.available],
      ['locked', n.locked, o.locked],
      ['seq', n.seq, o.seq],
      ['强平价', n.liq, o.liq],
    ];
    rows.forEach(([k, a, b]) => {
      const same = (typeof a === 'number' && typeof b === 'number')
        ? Math.abs(a - b) < 1e-6 : JSON.stringify(a) === JSON.stringify(b);
      console.log('  ' + k.padEnd(18) + ' 新=' + String(a).padEnd(22) + ' 旧=' + String(b).padEnd(22) + (same ? '✅' : '⚠️'));
    });
    console.log('\n  仓位字段一致：', JSON.stringify(n.posKeys) === JSON.stringify(o.posKeys));
  }
})().catch((e) => { console.error('失败：' + (e && e.stack || e)); process.exit(1); });
