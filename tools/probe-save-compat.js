/*
 * 换本体后存档兼容性检查。
 *
 * 风险点：云存档只持久化 balance / positions / lastSyncAt / lastClientTs。
 * 如果游戏本体的 state 结构变了（仓位字段名变了、locked 语义变了、seq 变了），
 * 那么"读回来的存档"在新本体里就会算错账，甚至把玩家余额弄丢。
 *
 * 本探针在新旧两版本体上分别：
 *   1) 输出 state 的关键字段与仓位对象的键集合
 *   2) 用同一份存档数据分别在两版里恢复，比较恢复后的账目（equity / available / locked）
 *   3) 报告差异
 */
'use strict';

const { spawn } = require('child_process');
const path = require('path');
const http = require('http');
const os = require('os');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

/* 同一条存档：余额 45678.9，一笔 20x 多单 */
const SAVE = {
  balance: 45678.9,
  positions: [{
    id: 5, pair: 'EUR/USD', side: 'long', margin: 700, lev: 20,
    notional: 14000, entry: 1.09, fee: 2.1, openTs: 1700000000000, openTick: 0,
  }],
  lastSyncAt: 1700000000000,
  lastClientTs: 1700000000000,
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

async function inspectPage(url, label) {
  const port = 9400 + Math.floor(Math.random() * 300);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-save-' + Date.now()), 'about:blank'],
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
    await rpc('Page.navigate', { url: url });
    await new Promise((r) => setTimeout(r, 3500));

    const ev = async (expr) => {
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
      return r.result.value;
    };

    const before = await ev(`(function(){
      var s = FX.state;
      return {
        stateKeys: Object.keys(s).sort(),
        balance: s.balance, locked: s.locked, seq: s.seq,
        posCount: s.positions.length,
        equity: FX.equity ? FX.equity() : null,
        available: FX.available ? FX.available() : null,
        hasEquity: typeof FX.equity === 'function',
        hasAvailable: typeof FX.available === 'function',
        hasLiq: typeof FX.liqPriceOf === 'function'
      };
    })()`);

    /* 用同一份存档恢复 */
    const restored = await ev(`(function(){
      var save = ${JSON.stringify(SAVE)};
      var s = FX.state;
      s.balance = save.balance;
      s.positions = save.positions.map(function(p){ return JSON.parse(JSON.stringify(p)); });
      /* 和 online-client 一样：按持仓重算 locked，并把 seq 推到最大 id */
      s.locked = 0;
      for (var i=0;i<s.positions.length;i++) s.locked += s.positions[i].margin;
      var maxId = 0;
      for (var j=0;j<s.positions.length;j++) maxId = Math.max(maxId, s.positions[j].id);
      if (s.seq < maxId) s.seq = maxId;
      try { FX.renderAll(); } catch(e) {}

      var out = {
        balance: s.balance, locked: s.locked, seq: s.seq, posCount: s.positions.length,
        posKeys: s.positions[0] ? Object.keys(s.positions[0]).sort() : null
      };
      try { out.equity = FX.equity(); } catch(e) { out.equityErr = String(e.message||e); }
      try { out.available = FX.available(); } catch(e) { out.availableErr = String(e.message||e); }
      try { out.liq = FX.liqPriceOf(s.positions[0]); } catch(e) { out.liqErr = String(e.message||e); }
      try { out.totalEquity = FX.totalEquity ? FX.totalEquity() : null; } catch(e) {}
      return out;
    })()`);

    /* 存档能不能被 CloudSave 正常读出去（模拟 online-client 的取数逻辑） */
    const snapshot = await ev(`(function(){
      var s = FX.state;
      return {
        balance: s.balance,
        positions: s.positions.map(function(p){
          return { id:p.id, pair:p.pair, side:p.side, margin:p.margin, lev:p.lev,
                   notional:p.notional, entry:p.entry, fee:p.fee, openTs:p.openTs, openTick:p.openTick };
        })
      };
    })()`);

    return { label, before, restored, snapshot };
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
}

(async function main() {
  const ROOT = path.resolve(__dirname, '..');
  const NEW = 'file:///' + path.join(ROOT, 'public', 'index.html').replace(/\\/g, '/');
  /* 旧版：用备份里的 V1.4 本体单独构建一份到临时目录 */
  const OLD_DIR = 'D:/delta/tmp-oldbody';
  const OLD = 'file:///' + OLD_DIR + '/public/index.html';

  if (!fs.existsSync(OLD_DIR + '/public/index.html')) {
    console.log('（旧版页面不存在，跳过对比；只检查新本体）');
    console.log('如需对比，先按备份里的 V1.4 本体重建到 ' + OLD_DIR);
  }

  const newRes = await inspectPage(NEW, '新本体');
  console.log('\n================ 新本体（FX_game.html） ================');
  console.log(JSON.stringify(newRes, null, 1));

  if (fs.existsSync(OLD_DIR + '/public/index.html')) {
    const oldRes = await inspectPage(OLD, '旧本体 V1.4');
    console.log('\n================ 旧本体（V1.4） ================');
    console.log(JSON.stringify(oldRes, null, 1));

    console.log('\n================ 差异 ================');
    const a = newRes.restored, b = oldRes.restored;
    console.log('  state 字段一致：', JSON.stringify(newRes.before.stateKeys) === JSON.stringify(oldRes.before.stateKeys));
    console.log('  仓位字段一致：', JSON.stringify(a.posKeys) === JSON.stringify(b.posKeys));
    console.log('  equity  新=' + a.equity + '  旧=' + b.equity + '  ' + (a.equity === b.equity ? '✅ 一致' : '⚠️ 不同'));
    console.log('  available 新=' + a.available + '  旧=' + b.available + '  ' + (a.available === b.available ? '✅ 一致' : '⚠️ 不同'));
    console.log('  locked  新=' + a.locked + '  旧=' + b.locked);
    console.log('  强平价  新=' + a.liq + '  旧=' + b.liq);
    if (JSON.stringify(a.posKeys) !== JSON.stringify(b.posKeys)) {
      console.log('  ⚠️ 仓位字段不同：');
      console.log('    新：', JSON.stringify(a.posKeys));
      console.log('    旧：', JSON.stringify(b.posKeys));
    }
  }
})().catch((e) => { console.error('检查失败：' + (e && e.stack || e)); process.exit(1); });
