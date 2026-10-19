/*
 * 精简后的端到端验收 —— 真启动一个服务端，把玩家实际会用到的路径全走一遍。
 *
 * 为什么要单独做这一步：单测大多是"读源码/仿真 DOM"，而这次动的是**文件结构**
 * （删了 dist-ghost / vendor / toy / shots，改了测试读取路径）。
 * 只有真的启一个 HTTP 服务、真的注册账号、真的提交成绩、真的读写存档，
 * 才能证明「删干净了但没删坏」。
 *
 * 覆盖：
 *   ① 静态托管：首页 200 且含全部模块（主题/幽灵/追保/云存档）
 *   ② 排行榜：注册 → 提交成绩 → 四个榜单都能读到
 *   ③ 云存档：sync 写入 → state 读回 → 重启进程后仍在（真持久化）
 *   ④ 幽灵对战：页面里 GhostBattle.selfCheck() 全绿
 *   ⑤ 追保：开仓 → 按钮注入 → 弹窗 → 真实改账
 *   ⑥ 卸载后数据仍在（模拟重新部署）
 *
 * 用法： node tools/acceptance.js
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const CHROME = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra !== undefined ? '  → ' + JSON.stringify(extra).slice(0, 300) : '')); }
}
function section(t) { console.log('\n' + t); }

const DATA = path.join(os.tmpdir(), 'fx-accept-' + Date.now());
let PORT = 0;

function req(method, p, body, token) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (payload) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = payload.length; }
    if (token) headers['Authorization'] = 'Bearer ' + token;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(s); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, text: s, json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: String(e.message), text: '' }));
    if (payload) r.write(payload);
    r.end();
  });
}

function startServer(port) {
  return spawn(NODE, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, {
      FX_PORT: String(port), PORT: '', FX_HOST: '127.0.0.1', FX_DATA: DATA,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function waitReady(port, deadline) {
  return new Promise((resolve) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/api/health' }, (res) => {
        let s = ''; res.on('data', (d) => { s += d; });
        res.on('end', () => resolve(true));
      }).on('error', () => {
        if (Date.now() > deadline) resolve(false); else setTimeout(tick, 150);
      });
    };
    tick();
  });
}

async function browser(pages) {
  const port = 9800 + Math.floor(Math.random() * 150);
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage', '--remote-debugging-port=' + port,
    '--user-data-dir=' + path.join(os.tmpdir(), 'fx-acc-' + Date.now()), 'about:blank'],
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
    await new Promise((resolve, reject) => {
      const tick = () => {
        http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => { res.resume(); resolve(); })
          .on('error', () => { if (Date.now() > Date.now() + 20000) reject(new Error('cdp')); else setTimeout(tick, 150); });
      };
      tick();
    });
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
    await rpc('Emulation.setDeviceMetricsOverride', { width: 900, height: 900, deviceScaleFactor: 1, mobile: false });
    return { rpc, evalJs: async (expr) => {
      const r = await rpc('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) return { __err: (r.exceptionDetails.exception || {}).description || r.exceptionDetails.text };
      return r.result.value;
    } };
  } finally {
    setTimeout(() => { try { child.kill(); } catch (e) {} }, 20000);
  }
}

(async function main() {
  fs.mkdirSync(DATA, { recursive: true });
  PORT = 7100 + Math.floor(Math.random() * 600);

  let srv = startServer(PORT);
  try {
    const ready = await waitReady(PORT, Date.now() + 15000);
    if (!ready) throw new Error('服务端未就绪');

    section('=== 1. 静态托管（删掉 dist-ghost 后仍能托管）===');
    const home = await req('GET', '/');
    ok('首页 200', home.status === 200, home.status);
    const html = home.text;
    ok('含游戏本体', html.indexOf('window.FX = {') >= 0);
    ok('含主题样式', html.indexOf('id="fx-theme"') >= 0);
    ok('含幽灵对战', html.indexOf('root.GhostUI = api') >= 0 && html.indexOf('root.GhostBattle') >= 0);
    ok('含云存档客户端', html.indexOf('window.FXOnline') >= 0);
    ok('含追加保证金', html.indexOf('window.FXMargin') >= 0);
    ok('模块不重复（Canvas 主题仅 1 份）', (html.split('root.FXCanvasTheme = api').length - 1) === 1,
      html.split('root.FXCanvasTheme = api').length - 1);

    section('=== 2. 联机排行榜 ===');
    const name = '验收玩家' + Math.floor(Math.random() * 1e5);
    const reg = await req('POST', '/api/register', { name, password: 'pass1234' });
    ok('注册成功并拿到 token', reg.status === 200 && reg.json && reg.json.ok === true && !!reg.json.token,
      reg.json);
    const token = reg.json.token;

    /* ★ 成绩必须自洽，否则会被反作弊正确拒绝（这次就先被拦了一次，说明防作弊在工作）：
     *   won:true 要求 score ≥ target；peak 必须 ≥ score，也要 ≥ startEquity；
     *   durationMs 必须 ≥ tickCount × 1500 × 0.9。 */
    const TICK = 40;
    const sub = await req('POST', '/api/score', {
      score: 21000000, startEquity: 10000, target: 20000000, won: true,
      tickCount: TICK, candles: Math.floor(TICK / 4), trades: 5, cards: 2, assets: 1, cycles: 0,
      durationMs: TICK * 1500, peak: 22000000, runId: 'acc-' + Date.now(),
    }, token);
    ok('提交成绩成功', sub.status === 200 && sub.json && sub.json.ok === true, sub.json);

    for (const b of ['all', 'week', 'today', 'wins']) {
      const lb = await req('GET', '/api/leaderboard?board=' + b);
      ok('榜单 ' + b + ' 可读且有数据',
        lb.status === 200 && lb.json && lb.json.ok && lb.json.rows && lb.json.rows.length > 0,
        lb.json && { total: lb.json.total });
    }

    section('=== 3. 云存档（写入 → 读回）===');
    const save = { balance: 88888.5, positions: [], clientTs: Date.now() };
    const sync = await req('POST', '/api/account/sync', save, token);
    ok('sync 写入成功', sync.status === 200 && sync.json && sync.json.ok === true, sync.json);
    const st = await req('GET', '/api/account/state', undefined, token);
    ok('state 读回余额一致', st.status === 200 && st.json && Math.abs(st.json.balance - 88888.5) < 0.01,
      st.json && st.json.balance);

    section('=== 4. 重启进程后数据仍在（模拟重新部署）===');
    srv.kill();
    await new Promise((r) => setTimeout(r, 800));
    srv = startServer(PORT);
    await waitReady(PORT, Date.now() + 15000);
    await new Promise((r) => setTimeout(r, 500));

    const lb2 = await req('GET', '/api/leaderboard?board=all');
    ok('★ 重启后排行榜仍有数据', lb2.status === 200 && lb2.json.rows.length > 0,
      lb2.json && lb2.json.total);
    const login = await req('POST', '/api/login', { name, password: 'pass1234' });
    ok('★ 重启后账号仍能登录', login.status === 200 && login.json && login.json.ok === true, login.json);
    const st2 = await req('GET', '/api/account/state', undefined, login.json.token);
    ok('★ 重启后存档余额不变', st2.status === 200 && Math.abs(st2.json.balance - 88888.5) < 0.01,
      st2.json && st2.json.balance);

    section('=== 5. 浏览器里跑真页面 ===');
    const b = await browser();
    await b.rpc('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/' });
    await new Promise((r) => setTimeout(r, 5000));

    const mods = await b.evalJs(`({
      fx: !!(window.FX && window.FX.state),
      online: !!window.FXOnline, margin: !!window.FXMargin,
      ghost: !!(window.GhostUI && window.Ghost), mock: !!window.MockServer,
      battle: !!window.GhostBattle, theme: !!document.getElementById('fx-theme')
    })`);
    ok('页面模块全部就绪', mods && mods.fx && mods.online && mods.margin && mods.ghost &&
      mods.mock && mods.battle && mods.theme, mods);

    const selfCheck = await b.evalJs(`window.GhostBattle && window.GhostBattle.selfCheck ? window.GhostBattle.selfCheck() : null`);
    ok('幽灵对战自检通过', !!selfCheck && /已加载 ✅/.test(selfCheck) && !/❌/.test(selfCheck),
      selfCheck && selfCheck.slice(0, 160));

    const lbInPage = await b.evalJs(`fetch('/api/leaderboard?board=all').then(r=>r.json()).then(j=>({ok:j.ok,total:j.total}))`);
    ok('页面内能拉到排行榜', lbInPage && lbInPage.ok === true && lbInPage.total > 0, lbInPage);

    section('=== 6. 追保（开仓 → 按钮注入 → 改账）===');
    await b.evalJs(`(function(){
      FX.setLev(20);
      var i=document.getElementById('marginInput');
      if(i){i.value='500';i.dispatchEvent(new Event('input',{bubbles:true}));}
      FX.openPosition('long'); return 1;
    })()`);
    await new Promise((r) => setTimeout(r, 900));   /* 注入走 rAF，必须等 */
    const btn = await b.evalJs(`(function(){
      var x = document.querySelector('#positions [data-fx-margin]');
      return { exists: !!x, text: x ? x.textContent.trim() : null };
    })()`);
    ok('★ 追保按钮已注入持仓卡', btn && btn.exists === true, btn);

    const applied = await b.evalJs(`(function(){
      var before = FX.state.positions[0].margin;
      document.querySelector('#positions [data-fx-margin]').click();
      var input = document.getElementById('fx-mrg-amount');
      input.value = '200'; input.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('fx-mrg-ok').click();
      return { before: before, after: FX.state.positions[0].margin, locked: FX.state.locked };
    })()`);
    ok('★ 追保真实生效（保证金 +200）', applied && Math.abs(applied.after - applied.before - 200) < 0.01,
      applied);

    section('=== 7. 数据目录检查 ===');
    const files = fs.existsSync(DATA) ? fs.readdirSync(DATA) : [];
    ok('数据文件已落盘', files.indexOf('fx-online.json') >= 0, files);
    const db = JSON.parse(fs.readFileSync(path.join(DATA, 'fx-online.json'), 'utf8'));
    ok('账号已持久化', Object.keys(db.users || {}).length > 0, Object.keys(db.users || {}).length);
    ok('成绩已持久化', (db.scores || []).length > 0, (db.scores || []).length);

    console.log('\n' + '='.repeat(56));
    console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
    console.log('='.repeat(56));
    process.exit(fail > 0 ? 1 : 0);
  } finally {
    try { srv.kill(); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => {
  console.error('验收失败：' + (e && e.stack || e));
  process.exit(1);
});
