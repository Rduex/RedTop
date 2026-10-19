/*
 * 验证「三选一卡牌标题」与「暂停态配色」的实际渲染效果。
 *
 * 不靠读 CSS 判断 —— 直接读 getComputedStyle，算对比度。
 * 这两处 bug 都是"看代码觉得没问题、渲染出来看不清"的类型。
 *
 * 运行： node tools/probe-fix.js
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///D:/delta/fx-online/public/index.html';

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
  const userDir = path.join(require('os').tmpdir(), 'fx-fix-' + Date.now());

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
    width: 900, height: 1000, deviceScaleFactor: 2, mobile: false,
  });
  await rpc('Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2600));

  /* ---------- 1. 三选一卡牌 ---------- */
  const pick = await rpc('Runtime.evaluate', {
    expression: `
      (function(){
        // 造一个卡牌弹窗内容（游戏默认是空的）
        var modal = document.getElementById('pickModal');
        if (!modal) return { error: 'pickModal 不存在' };
        var body = modal.querySelector('.modal-panel .pick-grid') || modal.querySelector('.modal-panel');
        body.innerHTML =
          '<button class="pick-card r1"><div class="pick-name">点差半价</div>' +
          '<div class="pick-desc">手续费降低 50%</div></button>' +
          '<button class="pick-card r2"><div class="pick-name">主力席位</div>' +
          '<div class="pick-desc">名义仓位提升 80%</div></button>';
        modal.hidden = false;

        var nameEl = modal.querySelector('.pick-name');
        var cardEl = modal.querySelector('.pick-card');
        var cs = getComputedStyle(nameEl);
        var csCard = getComputedStyle(cardEl);

        // 找卡牌的实际背景（可能来自父级）
        function effBg(el) {
          var n = el;
          while (n && n !== document.documentElement) {
            var b = getComputedStyle(n).backgroundColor;
            if (b && b !== 'rgba(0, 0, 0, 0)' && b !== 'transparent') return b;
            n = n.parentElement;
          }
          return 'rgb(18,25,38)';
        }
        return {
          titleColor: cs.color,
          titleSize: cs.fontSize,
          titleWeight: cs.fontWeight,
          cardBg: effBg(cardEl),
          cardBorderLeft: csCard.borderLeftColor,
        };
      })()
    `,
    returnByValue: true,
  });

  /* ---------- 2. 暂停态 ---------- */
  const paused = await rpc('Runtime.evaluate', {
    expression: `
      (function(){
        // 触发暂停
        if (window.FX && typeof FX.setPaused === 'function') FX.setPaused(true);

        var btn = document.querySelector('.ct-pause');
        var wrap = document.querySelector('.chart-wrap');
        var note = document.querySelector('.chart-note .right');
        var badge = document.querySelector('.pause-badge');

        function info(el){
          if (!el) return null;
          var cs = getComputedStyle(el);
          return {
            bg: cs.backgroundColor,
            color: cs.color,
            border: cs.borderColor,
            boxShadow: cs.boxShadow,
          };
        }
        return {
          button: info(btn),
          wrap: info(wrap),
          note: info(note),
          badge: info(badge),
          pausedClass: btn ? btn.classList.contains('paused') : false,
        };
      })()
    `,
    returnByValue: true,
  });

  /* ---------- 计算对比度 ---------- */
  function parseRGB(s) {
    if (!s) return null;
    const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return null;
    return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)];
  }
  function relLum(rgb) {
    const f = (c) => {
      const s = c / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
  }
  function contrast(a, b) {
    const la = relLum(a), lb = relLum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  let bad = 0;
  function ok(label, cond, extra) {
    console.log('  ' + (cond ? '✅' : '❌') + ' ' + label + (extra ? '  → ' + extra : ''));
    if (!cond) bad++;
  }

  console.log('\n=== ① 三选一卡牌标题 ===');
  const p = pick.result.value;
  if (p.error) {
    ok('卡牌弹窗存在', false, p.error);
  } else {
    const fg = parseRGB(p.titleColor);
    const bg = parseRGB(p.cardBg);
    const ratio = (fg && bg) ? contrast(fg, bg) : 0;
    console.log('     标题色：' + p.titleColor);
    console.log('     卡片背景：' + p.cardBg);
    console.log('     对比度：' + ratio.toFixed(2) + ':1');
    ok('标题不再是深黑（亮度足够）',
      fg && relLum(fg) > 0.4, p.titleColor);
    ok('★ 对比度 ≥ 4.5:1（WCAG AA 正文标准）',
      ratio >= 4.5, ratio.toFixed(2) + ':1');
    ok('标题字号够大', parseFloat(p.titleSize) >= 13, p.titleSize);
    ok('标题加粗', parseInt(p.titleWeight, 10) >= 600, p.titleWeight);
  }

  console.log('\n=== ② 暂停态配色 ===');
  const q = paused.result.value;
  ok('暂停已生效', q.pausedClass === true);

  if (q.button) {
    const bg = parseRGB(q.button.bg);
    console.log('     暂停按钮背景：' + q.button.bg);
    console.log('     暂停按钮文字：' + q.button.color);
    /* 关键：不能是高饱和的纯黄大色块 */
    ok('★ 暂停按钮不再是实心亮黄（背景带透明度）',
      /rgba\(/.test(q.button.bg) && parseRGB(q.button.bg) &&
      Math.max(...parseRGB(q.button.bg)) < 250,
      q.button.bg);
    /* 关键不是"有没有阴影"，而是"有没有**黄色**阴影"。
     * 普通黑色投影（rgba(0,0,0,.28)）是深色界面的正常深度表达，
     * 有问题的是原来那种黄色光晕 rgba(232,180,85,.35)。 */
    var hasYellowGlow = /rgba\(\s*232\s*,\s*180\s*,\s*85/.test(q.button.boxShadow || '');
    ok('★ 去掉了黄色光晕（只保留普通黑色投影）',
      !hasYellowGlow, q.button.boxShadow);
    const btnFg = parseRGB(q.button.color);
    const btnBg = parseRGB(q.button.bg) || [18, 25, 38];
    if (btnFg) {
      /* 文字压在深底上，用页面底色算对比 */
      const r2 = contrast(btnFg, [18, 25, 38]);
      console.log('     文字/深底对比度：' + r2.toFixed(2) + ':1');
      ok('暂停按钮文字可读（≥4.5:1）', r2 >= 4.5, r2.toFixed(2) + ':1');
    }
  }

  if (q.wrap) {
    console.log('     图表描边：' + q.wrap.boxShadow);
    /* 不能是 2px 的亮黄实框 */
    const hasBrightYellowBorder = /rgba\(232,\s*180,\s*85,\s*0?\.8\)/.test(q.wrap.boxShadow);
    ok('★ 图表不再是亮黄实心描边', !hasBrightYellowBorder, q.wrap.boxShadow.slice(0, 80));
  }

  if (q.note) {
    console.log('     底部提示色：' + q.note.color);
    const c = parseRGB(q.note.color);
    ok('★ 提示色不再是深黄 #b8862f',
      !(c && c[0] === 184 && c[1] === 134 && c[2] === 47), q.note.color);
  }

  console.log('\n' + '='.repeat(56));
  console.log(bad === 0 ? '✅ 两处修复均已生效' : '❌ 仍有 ' + bad + ' 项未通过');
  console.log('='.repeat(56));

  ws.close();
  child.kill();
  setTimeout(() => process.exit(bad ? 1 : 0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
