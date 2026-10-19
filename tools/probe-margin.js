/*
 * 追加保证金（追保）的真浏览器端到端探针。
 *
 * 单测（test/margin-ui.js）用的是手写 DOM 桩 —— 它能验证"账目与流程"，
 * 但验证不了真实浏览器里最容易出事的三件事：
 *   ① MutationObserver 在真渲染循环下能不能把按钮补回来（渲染会重建 innerHTML）
 *   ② 点按钮 / 填金额 / 点确认这条真实事件链走不走得通
 *   ③ 面板在真样式下是否可见、有没有被别的东西盖住
 *
 * 所以这里用 CDP 开一个真 Chrome，把整条链跑一遍并截图。
 *
 * 用法： node tools/probe-margin.js [宽度]
 * 输出： shots/margin-dialog.png + 控制台断言结果
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = process.env.PAGE_URL ||
  'file:///D:/delta/fx-online/public/index.html';

const WIDTH = Number(process.argv[2] || 900);
const HEIGHT = 780;
const SHOT = path.join(__dirname, '..', 'shots', 'margin-dialog.png');

let pass = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { console.log('  ❌ ' + name + (extra !== undefined ? ' — ' + JSON.stringify(extra) : '')); process.exitCode = 1; }
}

function waitPort(port, deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => { res.resume(); resolve(); })
        .on('error', () => {
          if (Date.now() > deadline) reject(new Error('CDP 端口未就绪'));
          else setTimeout(tick, 150);
        });
    };
    tick();
  });
}

function rpc(ws, id, method, params) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ id, method, params: params || {} });
    const onMsg = (ev) => {
      let data;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      if (data.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (data.error) reject(new Error(method + ': ' + JSON.stringify(data.error)));
      else resolve(data.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(msg);
  });
}

(async function main() {
  const port = 9500 + Math.floor(Math.random() * 300);
  const userDir = path.join(os.tmpdir(), 'fx-margin-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--disable-dev-shm-usage',
    '--remote-debugging-port=' + port,
    '--user-data-dir=' + userDir,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});

  try {
    await waitPort(port, Date.now() + 20000);

    let target = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const list = await new Promise((resolve) => {
        http.get({ host: '127.0.0.1', port, path: '/json/list' }, (res) => {
          let s = '';
          res.on('data', (d) => { s += d; });
          res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { resolve([]); } });
        }).on('error', () => resolve([]));
      });
      target = (list || []).find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (!target) throw new Error('没有可用页面');

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve);
      ws.addEventListener('error', () => reject(new Error('WS 连接失败')));
    });

    let id = 0;
    await rpc(ws, ++id, 'Page.enable');
    await rpc(ws, ++id, 'Runtime.enable');
    /* ★ mobile 仿真在无头 Chrome 里会给窄视口套一层 1.25 的页面缩放：
     *   layout 宽度变成 463 而截图视口仍是 390，于是右侧被"切掉"——
     *   这是**仿真假象**，不是样式问题（游戏自带的弹窗同样会被切）。
     *   量真样式时用 MOBILE=0（桌面仿真 + 390 宽窗口），结论才可信。 */
    await rpc(ws, ++id, 'Emulation.setDeviceMetricsOverride', {
      width: WIDTH, height: HEIGHT,
      deviceScaleFactor: Number(process.env.DSF || 2),
      mobile: process.env.MOBILE === undefined ? WIDTH < 600 : process.env.MOBILE !== '0',
    });
    await rpc(ws, ++id, 'Page.navigate', { url: PAGE });
    await new Promise((r) => setTimeout(r, 3000));

    async function evaluate(expr) {
      const r = await rpc(ws, ++id, 'Runtime.evaluate', {
        expression: expr, returnByValue: true, awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error('页面表达式异常：' + (r.exceptionDetails.exception && r.exceptionDetails.exception.description
          || r.exceptionDetails.text));
      }
      return r.result.value;
    }

    console.log('\n[1] 页面与模块就绪');
    const ready = await evaluate('!!(window.FX && window.FX.state && window.FXMargin)');
    ok('FX / FXMargin 都已加载', ready === true);
    if (!ready) throw new Error('模块未就绪，后续无法验证');

    console.log('\n[2] 开一笔仓位（走游戏本体 openPosition）');
    const opened = await evaluate(`(function () {
      FX.setLev(20);
      var inp = document.getElementById('marginInput');
      if (inp) { inp.value = '500'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
      FX.openPosition('long');
      var p = FX.state.positions[0];
      return p ? { id: p.id, margin: p.margin, notional: p.notional, entry: p.entry, side: p.side } : null;
    })()`);
    ok('开仓成功', !!opened, opened);
    if (!opened) throw new Error('开仓失败，无法验证追保');

    console.log('\n[3] MutationObserver 把追保按钮补回卡片');
    await new Promise((r) => setTimeout(r, 400));
    const rowInfo = await evaluate(`(function () {
      var row = document.querySelector('#positions .pos .fx-margin-row');
      if (!row) return null;
      var btn = row.querySelector('[data-fx-margin]');
      var hint = row.querySelector('.fx-margin-hint');
      var cs = getComputedStyle(btn);
      var rc = btn.getBoundingClientRect();
      return {
        text: btn.textContent.trim(),
        id: btn.getAttribute('data-fx-margin'),
        hint: hint ? hint.textContent.trim() : '',
        display: cs.display,
        visible: rc.width > 0 && rc.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.1,
        fg: cs.color, bg: cs.backgroundColor
      };
    })()`);
    ok('★ 卡片上出现追保入口', !!rowInfo, rowInfo);
    if (rowInfo) {
      ok('文案为「＋ 追加保证金」', rowInfo.text.indexOf('追加保证金') >= 0, rowInfo.text);
      ok('按钮携带仓位 id', String(rowInfo.id) === String(opened.id), rowInfo.id);
      ok('★ 按钮真实可见（有尺寸、非隐藏）', rowInfo.visible === true, rowInfo);
      ok('旁边显示危险度', /危险度/.test(rowInfo.hint), rowInfo.hint);
    }

    console.log('\n[4] 渲染竞态：连续触发 5 次重绘后按钮仍只在 1 个');
    await evaluate('(function(){ for (var i=0;i<5;i++) FX.renderAll(); return 1; })()');
    /* ★ 注入是"重绘之后补回来"，走 requestAnimationFrame —— 不能在同一拍里数，
     *   否则数到 0 会误判成"没注入"。等两帧再数才是真实结果。 */
    await new Promise((r) => setTimeout(r, 400));
    const afterRenders = await evaluate("document.querySelectorAll('#positions .pos .fx-margin-row').length");
    ok('渲染后不重复注入', afterRenders === 1, afterRenders);

    console.log('\n[5] 点开弹窗（真实 click 事件）');
    const openedDialog = await evaluate(`(function () {
      document.querySelector('#positions [data-fx-margin]').click();
      var dlg = document.getElementById('fx-margin-dialog');
      var panel = dlg && dlg.querySelector('.fx-mrg__panel');
      if (!dlg || !panel) return { ok: false };
      var cs = getComputedStyle(dlg);
      var rc = panel.getBoundingClientRect();
      return {
        ok: true,
        hidden: dlg.hidden,
        display: cs.display,
        panelVisible: rc.width > 100 && rc.height > 100,
        title: (document.getElementById('fx-mrg-title') || {}).textContent,
        meta: (document.getElementById('fx-mrg-meta') || {}).innerHTML,
        preset: (document.getElementById('fx-mrg-amount') || {}).value,
        preview: (document.getElementById('fx-mrg-preview') || {}).textContent.slice(0, 80),
        activeIsInput: document.activeElement && document.activeElement.id === 'fx-mrg-amount'
      };
    })()`);
    ok('★ 弹窗打开且可见', openedDialog.ok && openedDialog.hidden === false && openedDialog.panelVisible,
      openedDialog);
    ok('标题是「追加保证金」', openedDialog.title === '追加保证金', openedDialog.title);
    ok('标题行显示货币对', /EUR\/USD/.test(openedDialog.meta || ''), openedDialog.meta);
    ok('金额框已聚焦', openedDialog.activeIsInput === true);

    console.log('\n[6] 填金额 → 预览 → 确认');
    const before = await evaluate('({ margin: FX.state.positions[0].margin, locked: FX.state.locked, balance: FX.state.balance, liq: FX.liqPriceOf(FX.state.positions[0]) })');

    const typed = await evaluate(`(function () {
      var inp = document.getElementById('fx-mrg-amount');
      inp.value = '200';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      return {
        preview: document.getElementById('fx-mrg-preview').textContent,
        okText: document.getElementById('fx-mrg-ok').textContent,
        okDisabled: document.getElementById('fx-mrg-ok').disabled
      };
    })()`);
    ok('预览出现"追加后"的对比', /追加后保证金/.test(typed.preview), typed.preview.slice(0, 120));
    ok('确认按钮显示金额 $200.00', /200\.00/.test(typed.okText), typed.okText);
    ok('确认按钮可点', typed.okDisabled === false);

    /* 截图：弹窗态 */
    const shotData = await rpc(ws, ++id, 'Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(path.dirname(SHOT), { recursive: true });
    fs.writeFileSync(SHOT, Buffer.from(shotData.data, 'base64'));
    console.log('  📸 已截图：' + SHOT);

    const applied = await evaluate(`(function () {
      document.getElementById('fx-mrg-ok').click();
      var p = FX.state.positions[0];
      return {
        closed: document.getElementById('fx-margin-dialog').hidden,
        margin: p ? p.margin : null,
        locked: FX.state.locked,
        balance: FX.state.balance,
        liq: p ? FX.liqPriceOf(p) : null,
        log: (function () {
          var li = document.querySelectorAll('#logList li, .log-list li');
          for (var i = 0; i < li.length; i++) {
            if (li[i].textContent.indexOf('追保') >= 0) return li[i].textContent;
          }
          return li.length ? ('(无追保行) ' + li[li.length - 1].textContent) : '(无日志行)';
        })()
      };
    })()`);

    ok('★ 保证金 500 → 700', Math.abs(applied.margin - (before.margin + 200)) < 1e-6,
      before.margin + ' -> ' + applied.margin);
    ok('★ 占用保证金同步增加 200', Math.abs(applied.locked - (before.locked + 200)) < 1e-6,
      before.locked + ' -> ' + applied.locked);
    ok('★ 余额不变（钱只是被占用）', Math.abs(applied.balance - before.balance) < 1e-6,
      before.balance + ' -> ' + applied.balance);
    ok('★ 强平价被推远（做多 → 更低）', applied.liq < before.liq,
      before.liq + ' -> ' + applied.liq);
    ok('★ 执行后弹窗自动关闭', applied.closed === true);
    ok('交易日志里出现「➕ 追保」', /追保/.test(applied.log || ''), applied.log);

    console.log('\n[7] 超额输入必须被拦住');
    await new Promise((r) => setTimeout(r, 400));
    const guard = await evaluate(`(function () {
      var opener = document.querySelector('#positions [data-fx-margin]');
      if (!opener) return { disabled: null, err: '找不到追保入口（注入未生效）', errHidden: true };
      opener.click();
      var inp = document.getElementById('fx-mrg-amount');
      inp.value = '999999';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      var okBtn = document.getElementById('fx-mrg-ok');
      var err = document.getElementById('fx-mrg-err');
      var r = { disabled: okBtn.disabled, errHidden: err.hidden, err: err.textContent };
      document.querySelector('#fx-margin-dialog [data-mrg-close]').click();
      return r;
    })()`);
    ok('★ 超过可用余额时确认被禁用', guard.disabled === true);
    ok('★ 并给出具体差额提示', guard.errHidden === false && /不够/.test(guard.err), guard.err);

    console.log('\n[8] 页面没有新增报错');
    const errs = await evaluate('window.__fxErrCount || 0');
    ok('无未捕获异常计数', errs === 0, errs);

    console.log('\n' + '='.repeat(50));
    console.log('通过 ' + pass + ' 项 · 失败 ' + (process.exitCode ? '有' : 0) + ' 项');
    console.log('='.repeat(50));
  } finally {
    try { child.kill(); } catch (e) { /* 忽略 */ }
  }
})().catch((e) => {
  console.error('\n探针异常：' + (e && e.stack || e));
  process.exit(1);
});
