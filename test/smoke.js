/*
 * 冒烟测试：跑完整的玩家旅程，验证联网版端到端真的能用。
 *
 *   注册 → 打一局 → 上报 → 上排行榜 → 看名次 → 重启后数据还在
 *
 * 运行： node test/smoke.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 9200 + Math.floor(Math.random() * 300);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-smoke-'));

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  ✅ ' + n); }
  else { fail++; console.log('  ❌ ' + n + (x !== undefined ? '  -> ' + x : '')); }
}

function req(method, p, body, token) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const r = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign({ 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        token ? { 'X-FX-Token': token } : {}),
    }, (res) => {
      const cs = [];
      res.on('data', (c) => cs.push(c));
      res.on('end', () => {
        const t = Buffer.concat(cs).toString('utf8');
        let j = null; try { j = JSON.parse(t); } catch (e) {}
        resolve({ status: res.statusCode, json: j, text: t });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

function startServer() {
  const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    env: Object.assign({}, process.env, {
      FX_PORT: String(PORT), FX_HOST: '127.0.0.1', FX_DATA: DATA,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  return child;
}

function waitUp(deadline) {
  return new Promise((resolve, reject) => {
    const go = () => {
      req('GET', '/api/health').then((r) => r.status === 200 ? resolve() : again()).catch(again);
    };
    const again = () => Date.now() > deadline ? reject(new Error('启动超时')) : setTimeout(go, 120);
    go();
  });
}

let child = startServer();
process.on('exit', () => {
  try { child.kill(); } catch (e) {}
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) {}
});

/* 模拟前端在真实游戏里会发出的上报体（数值取自一次真实的游戏进程） */
function realRunScore(over) {
  const ticks = 960;                        // 240 根 K 线 ≈ 24 分钟
  return Object.assign({
    runId: 'smoke-' + Math.random().toString(36).slice(2),
    score: 184320.55, equity: 180100.2, startEquity: 10000,
    target: 20000000, won: false,
    tickCount: ticks, candles: ticks / 4,
    trades: 0, cards: 5, assets: 2, cycles: 1,
    durationMs: ticks * 1500, reason: 'settle', mode: 'sim',
  }, over || {});
}

(async function () {
  await waitUp(Date.now() + 15000);
  console.log('\n🚀 服务器已就绪：http://127.0.0.1:' + PORT + '\n');

  console.log('【1】玩家注册');
  const reg = await req('POST', '/api/register', { name: '久留美', password: 'kurumi2026' });
  check('注册成功', reg.status === 200 && reg.json.token, reg.status);
  const token = reg.json.token;

  console.log('\n【2】打一局并上报');
  const s = await req('POST', '/api/score', { score: realRunScore() }, token);
  check('成绩上榜成功', s.status === 200 && s.json.ok, s.status + ' ' + JSON.stringify(s.json));
  check('拿到名次 1', s.json.rank === 1, s.json && s.json.rank);
  check('返回的分数正确保留两位', s.json.entry.score === 184320.55, s.json.entry && s.json.entry.score);

  console.log('\n【3】排行榜能查到');
  const b = await req('GET', '/api/leaderboard?board=all', undefined, token);
  check('总榜里有我', b.json.rows.some((r) => r.name === '久留美'));
  check('我的行被标记出来（前端高亮用）', !!b.json.me && b.json.me.name === '久留美');
  check('榜单展示用金额是数字', typeof b.json.rows[0].score === 'number');

  console.log('\n【4】个人战绩');
  const p = await req('GET', '/api/profile', undefined, token);
  check('个人资料可取', p.status === 200);
  check('历史里有这一局', p.json.history.length === 1);
  check('名次显示正确', p.json.ranks.all === 1, p.json.ranks.all);

  console.log('\n【5】服务器重启后数据仍在');
  child.kill();
  await new Promise((r) => setTimeout(r, 600));
  child = startServer();
  await waitUp(Date.now() + 15000);
  const b2 = await req('GET', '/api/leaderboard?board=all', undefined, token);
  check('重启后仍能看到成绩', b2.json.rows.length === 1 && b2.json.rows[0].name === '久留美',
    JSON.stringify(b2.json.rows));
  check('重启后 token 依然有效（会话不丢）', b2.status === 200);

  console.log('\n【6】换台设备登录同一账号');
  const login = await req('POST', '/api/login', { name: '久留美', password: 'kurumi2026' });
  check('登录成功', login.status === 200 && login.json.token);
  check('新设备也拿到同一个 token 语义（同一账号）',
    login.json.user.id === reg.json.user.id, login.json.user.id + ' vs ' + reg.json.user.id);

  console.log('\n' + '='.repeat(46));
  console.log(fail === 0 ? '🎉 冒烟测试全部通过（' + pass + ' 项）' : '通过 ' + pass + ' · 失败 ' + fail);
  console.log('='.repeat(46));
  child.kill();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('冒烟测试异常：' + (e && e.stack || e));
  child.kill();
  process.exit(1);
});
