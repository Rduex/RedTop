/*
 * 全弹窗白块扫描：一次性检查所有 12 个弹窗里是否还有浅色残留。
 *
 * 做法：
 *   1) 逐个把弹窗设为可见（hidden=false），并塞入示例内容（有些弹窗默认是空的）
 *   2) 用"亮度 > 200 的背景元素"扫描法找出所有白块
 *   3) 汇总报告，按弹窗分组
 *
 * 这是深色主题最容易漏的地方 —— 弹窗深处（三选一卡牌、结算单、BOSS 揭晓等）
 * 平时不打开就看不见，一打开就是一块刺眼的白。
 *
 * 运行： node tools/probe-modals.js
 */
'use strict';

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');

const CHROME = process.env.CHROME_PATH ||
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PAGE = 'file:///D:/delta/fx-online/dist-ghost/index.html';

/* 每个弹窗：id + 打开方式（有的需要先塞内容才有东西可扫） */
const MODALS = [
  { id: 'tutorialModal', label: '新手教程' },
  { id: 'pickModal', label: '三选一卡牌', fill: true },
  { id: 'offerModal', label: '资产要约' },
  { id: 'marketModal', label: '资产市场' },
  { id: 'intelModal', label: '情报市场' },
  { id: 'retireModal', label: '通关' },
  { id: 'dadModal', label: '衣柜摸金' },
  { id: 'dadScoldModal', label: '久爸责骂' },
  { id: 'ruinModal', label: '爆仓抉择' },
  { id: 'cycleModal', label: '本局结算' },
  { id: 'bossRevealModal', label: 'BOSS 揭晓' },
  { id: 'bossWarnModal', label: '大额入场叮嘱' },
];

function waitForTarget(port, deadline) {
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
      setTimeout(tick, 220);
    };
    tick();
  });
}

(async function main() {
  const port = 9200 + Math.floor(Math.random() * 400);
  const userDir = path.join(require('os').tmpdir(), 'fx-pm-' + Date.now());

  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
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
    width: 390, height: 844, deviceScaleFactor: 1, mobile: true,
  });
  await rpc('Page.navigate', { url: PAGE });
  await new Promise((r) => setTimeout(r, 2400));

  /* 扫描函数（在页面里执行） */
  const scanFn = function () {
    const light = [];
    const all = document.body.querySelectorAll('*');
    all.forEach((el) => {
      const cs = getComputedStyle(el);
      /* 跳过不可见元素，避免误报 */
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (parseFloat(cs.opacity) < 0.05) return;
      const bg = cs.backgroundColor;
      if (!bg || bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') return;
      const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
      if (!m) return;
      const r = +m[1], g = +m[2], b = +m[3];
      if (r > 200 && g > 200 && b > 200) {
        const rect = el.getBoundingClientRect();
        if (rect.width < 6 || rect.height < 6) return;
        light.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || '').toString().slice(0, 70),
          id: el.id || '',
          bg: bg,
          w: Math.round(rect.width),
          h: Math.round(rect.height),
          path: (function () {
            let p = el, parts = [];
            for (let i = 0; i < 4 && p && p.tagName; i++) {
              parts.unshift(p.tagName.toLowerCase() +
                (p.id ? '#' + p.id : '') +
                (p.className ? '.' + String(p.className).split(' ')[0] : ''));
              p = p.parentElement;
            }
            return parts.join(' > ');
          })(),
        });
      }
    });
    /* 去重：同一类名只留一个代表 */
    const seen = new Set();
    return light.filter((x) => {
      const k = x.tag + '|' + x.cls + '|' + x.bg;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  };

  const report = [];

  for (const modal of MODALS) {
    /* 先全部关掉，再打开目标 —— 避免多个弹窗叠加互相干扰 */
    await rpc('Runtime.evaluate', {
      expression: `
        (function(){
          document.querySelectorAll('.modal').forEach(function(m){ m.hidden = true; });
          var el = document.getElementById(${JSON.stringify(modal.id)});
          if (!el) return 'MISSING';
          /* 有些弹窗默认内容是空的，塞一点占位内容才扫得到内部元素 */
          ${modal.fill ? `
          var body = el.querySelector('.modal-body, .cs-list, .pick-list, .modal-panel');
          if (body && !body.children.length) {
            body.innerHTML =
              '<div class="pick-card r1"><div class="pick-name">测试卡 A</div><div class="pick-desc">描述文字</div></div>' +
              '<div class="pick-card r2"><div class="pick-name">测试卡 B</div><div class="pick-desc">描述文字</div></div>' +
              '<div class="pick-card r3"><div class="pick-name">测试卡 C</div><div class="pick-desc">描述文字</div></div>';
          }` : ''}
          el.hidden = false;
          return 'OK';
        })()
      `,
      returnByValue: true,
    });
    await new Promise((r) => setTimeout(r, 220));

    const res = await rpc('Runtime.evaluate', {
      expression: '(' + scanFn.toString() + ')()',
      returnByValue: true,
    });
    const list = res.result.value || [];
    report.push({ modal: modal, list: list });

    const status = list.length === 0 ? '✅ 干净' : ('⚠ ' + list.length + ' 处白块');
    console.log(modal.label.padEnd(14, ' ') + status);
    list.forEach((x) => {
      console.log('    <' + x.tag + (x.id ? ' #' + x.id : '') +
        (x.cls ? ' .' + x.cls.split(' ').join('.') : '') + '>  ' +
        x.bg + '  ' + x.w + 'x' + x.h);
    });
  }

  /* 汇总 */
  const dirty = report.filter((r) => r.list.length > 0);
  console.log('\n' + '='.repeat(56));
  if (!dirty.length) {
    console.log('✅ 全部 ' + MODALS.length + ' 个弹窗均无浅色残留');
  } else {
    console.log('⚠ ' + dirty.length + ' / ' + MODALS.length + ' 个弹窗仍有白块：');
    /* 汇总出现过的类名，便于一次性修 */
    const classes = new Set();
    dirty.forEach((d) => d.list.forEach((x) => {
      if (x.cls) x.cls.split(' ').forEach((c) => c && classes.add(c));
      if (x.id) classes.add('#' + x.id);
    }));
    console.log('  涉及类名：' + Array.from(classes).join(', '));
  }
  console.log('='.repeat(56));

  ws.close();
  child.kill();
  setTimeout(() => process.exit(dirty.length ? 1 : 0), 250);
})().catch((e) => {
  console.error('失败：' + (e && e.message));
  process.exit(1);
});
