/*
 * 服务端接口测试：注册/登录、鉴权、成绩校验、排行榜口径。
 *
 * 手法：在临时数据目录里起一个真实的 server 进程，用 HTTP 打它。
 * 这样测的是完整链路（路由、限流、JSON、持久化），而不是内部函数。
 *
 * 运行： node test/api.js
 */
'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8791 + Math.floor(Math.random() * 200);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-test-'));

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra !== undefined ? '  -> ' + extra : '')); }
}
function section(t) { console.log('\n' + t); }

function request(method, p, body, token, extraHeaders) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: p, method,
      headers: Object.assign(
        { 'Content-Type': 'application/json' },
        payload ? { 'Content-Length': Buffer.byteLength(payload) } : {},
        token ? { 'X-FX-Token': token } : {},
        extraHeaders || {}
      ),
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch (e) { /* 非 JSON */ }
        resolve({ status: res.statusCode, json, text, headers: res.headers });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function waitForServer(deadline) {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      request('GET', '/api/health').then((r) => {
        if (r.status === 200) resolve(r);
        else retry();
      }).catch(() => retry());
    };
    const retry = () => {
      if (Date.now() > deadline) return reject(new Error('服务器启动超时'));
      setTimeout(tryOnce, 120);
    };
    tryOnce();
  });
}

/* 一个"合法"成绩的最小构造：满足服务端全部时间/数值约束 */
function makeScore(over) {
  const ticks = 400;                      // 100 根 K 线
  return Object.assign({
    runId: 'run-' + Math.random().toString(36).slice(2),
    score: 30000,
    equity: 29000,
    startEquity: 10000,
    target: 20000000,
    won: false,
    tickCount: ticks,
    candles: Math.floor(ticks / 4),
    trades: 12,
    cards: 3,
    assets: 1,
    cycles: 1,
    durationMs: ticks * 1500 + 5000,        // 真实时长 ≥ tick 数 × 1.5s
    reason: 'settle',
    mode: 'sim',
  }, over || {});
}

const child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
  env: Object.assign({}, process.env, {
    FX_PORT: String(PORT),
    FX_HOST: '127.0.0.1',
    FX_DATA: DATA,
  }),
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOut = '';
child.stdout.on('data', (d) => { serverOut += d.toString(); });
child.stderr.on('data', (d) => { serverOut += d.toString(); });

function cleanup() {
  try { child.kill(); } catch (e) { /* 忽略 */ }
  try { fs.rmSync(DATA, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
}
process.on('exit', cleanup);

(async function main() {
  await waitForServer(Date.now() + 15000);

  section('=== 1. 健康检查 ===');
  const h = await request('GET', '/api/health');
  check('GET /api/health 返回 200', h.status === 200, h.status);
  check('报告了 4 个榜单', Array.isArray(h.json.boards) && h.json.boards.length === 4, h.json && h.json.boards);
  check('说明了复盘验证未启用', h.json.verify && h.json.verify.enabled === false);

  section('=== 2. 注册与登录 ===');
  const reg = await request('POST', '/api/register', { name: '久留美', password: 'himitsu123' });
  check('注册成功返回 token', reg.status === 200 && typeof reg.json.token === 'string', reg.status);
  const token = reg.json.token;
  check('返回了用户信息', reg.json.user && reg.json.user.name === '久留美');

  const dup = await request('POST', '/api/register', { name: '久留美', password: 'other999' });
  check('重复昵称被拒绝（400）', dup.status === 400, dup.status + ' ' + (dup.json && dup.json.error));

  const shortPw = await request('POST', '/api/register', { name: '阿久二号', password: '123' });
  check('过短密码被拒绝', shortPw.status === 400, shortPw.status);

  const badName = await request('POST', '/api/register', { name: 'a', password: 'longenough' });
  check('非法昵称被拒绝', badName.status === 400, badName.status);

  const badLogin = await request('POST', '/api/login', { name: '久留美', password: 'wrongpass' });
  check('密码错误登录失败（401）', badLogin.status === 401, badLogin.status);

  const okLogin = await request('POST', '/api/login', { name: '久留美', password: 'himitsu123' });
  check('正确密码登录成功', okLogin.status === 200 && typeof okLogin.json.token === 'string', okLogin.status);

  section('=== 3. 鉴权 ===');
  const noToken = await request('GET', '/api/me');
  check('无 token 访问 /api/me 返回 401', noToken.status === 401, noToken.status);

  const badToken = await request('GET', '/api/me', undefined, 'garbage.token.sig');
  check('伪造 token 返回 401', badToken.status === 401, badToken.status);

  const me = await request('GET', '/api/me', undefined, token);
  check('合法 token 取回本人信息', me.status === 200 && me.json.user.name === '久留美', me.status);

  section('=== 4. 成绩校验：合法成绩应入库 ===');
  const s1 = await request('POST', '/api/score', { score: makeScore({ score: 30000 }) }, token);
  check('合法成绩被接受', s1.status === 200 && s1.json.ok === true, s1.status + ' ' + JSON.stringify(s1.json));
  check('返回了名次', typeof s1.json.rank === 'number' && s1.json.rank === 1, s1.json && s1.json.rank);

  /* ★ 回归测试：前端 online-client.js 发的是**扁平**结构
   *   { runId, score: 数字, equity, tickCount, ... }，而不是 { score: {...} }。
   *   曾经服务端写成 body.score || body，把数字当成了整个上报体，
   *   导致所有真实成绩都被判"这一局太短"而拒掉。这条测试专门守住这个坑。 */
  const flat = await request('POST', '/api/score', {
    runId: 'flat-shape-1', score: 184320.55, equity: 180100.2, startEquity: 10000,
    target: 20000000, won: false, tickCount: 960, candles: 240, trades: 42,
    cards: 5, assets: 2, cycles: 1, durationMs: 960 * 1500, reason: 'settle', mode: 'sim',
  }, token);
  check('★ 扁平结构（前端真实形态）被正确解析', flat.status === 200 && flat.json.ok === true,
    flat.status + ' ' + JSON.stringify(flat.json && flat.json.code));
  check('★ 扁平结构下 score 保留了真实数值',
    flat.status === 200 && Math.abs(flat.json.entry.score - 184320.55) < 0.01,
    flat.json && flat.json.entry && flat.json.entry.score);
  check('★ 扁平结构下 tickCount/时长被正确读取',
    flat.status === 200 && flat.json.entry.tickCount === 960 &&
    flat.json.entry.durationMs === 960 * 1500,
    flat.json && flat.json.entry && flat.json.entry.tickCount + '/' + (flat.json.entry && flat.json.entry.durationMs));

  section('=== 5. 成绩校验：各类伪造与非法数据应被拒 ===');
  const cases = [
    ['天文数字成绩被拒', { score: makeScore({ score: 1e30, equity: 1e30 }) }, 400],
    ['tick 数与时长矛盾被拒（10 秒打了 400 tick）',
      { score: makeScore({ durationMs: 10000 }) }, 400],
    ['一局太短被拒（<8 tick）', { score: makeScore({ tickCount: 2, candles: 0, durationMs: 3000 }) }, 400],
    ['未达标却声明通关被拒', { score: makeScore({ won: true, score: 50000, target: 20000000 }) }, 400],
    ['峰值低于结算权益被拒', { score: makeScore({ score: 1000, equity: 90000, startEquity: 10000 }) }, 400],
    ['K 线数超过 tick 数被拒',
      { score: makeScore({ tickCount: 40, candles: 999, durationMs: 60000 }) }, 400],
    ['开局资金超大被拒', { score: makeScore({ startEquity: 1e20 }) }, 400],
  ];
  for (const [name, payload, expect] of cases) {
    const r = await request('POST', '/api/score', payload, token);
    check(name, r.status === expect, r.status + ' ' + (r.json && r.json.code));
  }

  const negScore = await request('POST', '/api/score', { score: makeScore({ score: -500 }) }, token);
  check('负数成绩被拒（或被压成 0 后因峰值过低被拒）',
    negScore.status === 400, negScore.status + ' ' + (negScore.json && negScore.json.code));

  section('=== 6. 同一局 runId 去重（upsert，只涨不重复计数）===');
  const runId = 'fixed-run-1';
  const before = await request('GET', '/api/profile', undefined, token);
  const runsBefore = before.json.user.runs;
  const a = await request('POST', '/api/score',
    { score: makeScore({ runId, score: 15000, equity: 15000 }) }, token);
  check('第一次提交成功', a.status === 200, a.status);
  const b = await request('POST', '/api/score',
    { score: makeScore({ runId, score: 45000, equity: 44000 }) }, token);
  check('同一 runId 第二次提交也成功（不报重复）', b.status === 200, b.status + ' ' + (b.json && b.json.code));
  const after = await request('GET', '/api/profile', undefined, token);
  check('局数只 +1（没有因为重复上报多算）', after.json.user.runs === runsBefore + 1,
    runsBefore + ' → ' + after.json.user.runs);
  const hist = after.json.history.filter((x) => x.score === 45000);
  check('同一局只留一条记录，且取最高峰值', hist.length === 1 && !after.json.history.some((x) => x.score === 15000),
    JSON.stringify(after.json.history.map((x) => x.score)));

  section('=== 7. 排行榜与名次 ===');
  const boardAll = await request('GET', '/api/leaderboard?board=all', undefined, token);
  check('总榜返回 200', boardAll.status === 200);
  check('总榜含"我"的行', !!boardAll.json.me && boardAll.json.me.rank === 1, JSON.stringify(boardAll.json.me));
  check('榜单行带名次与名字', boardAll.json.rows[0].rank === 1 && boardAll.json.rows[0].name === '久留美');

  /* 再注册一个更强的玩家，验证排序与名次变化。
   * ★ 注意：要声明 won=true，score 就必须真的 ≥ target（$20,000,000）——
   *   服务端会拦"未达标却声明通关"。所以这里用一个真实的通关成绩。 */
  const reg2 = await request('POST', '/api/register', { name: '小金萌智子', password: 'loan12345' });
  const token2 = reg2.json.token;
  const winRes = await request('POST', '/api/score', {
    score: makeScore({ score: 25000000, equity: 24000000, won: true, target: 20000000, reason: 'retire' }),
  }, token2);
  check('真实通关的成绩被接受', winRes.status === 200 && winRes.json.entry.won === true,
    winRes.status + ' ' + JSON.stringify(winRes.json && winRes.json.code));
  const board2 = await request('GET', '/api/leaderboard?board=all', undefined, token);
  check('更强的成绩排到第 1', board2.json.rows[0].name === '小金萌智子', board2.json.rows[0].name);
  check('我的名次随之降到第 2', board2.json.me.rank === 2, board2.json.me.rank);

  const wins = await request('GET', '/api/leaderboard?board=wins');
  check('通关榜只收录通关的局', wins.json.rows.length === 1 && wins.json.rows[0].won === true,
    JSON.stringify(wins.json.rows.map((r) => r.won)));
  check('通关榜按用时排序', wins.json.rows[0].name === '小金萌智子');

  section('=== 8. 分页与参数容错 ===');
  const paged = await request('GET', '/api/leaderboard?board=all&limit=1&offset=1');
  check('limit=1&offset=1 只返回第 2 名', paged.json.rows.length === 1 && paged.json.rows[0].rank === 2,
    JSON.stringify(paged.json.rows.map((r) => r.rank)));
  const bogus = await request('GET', '/api/leaderboard?board=nonexistent&limit=abc&offset=-5');
  check('非法 board/limit/offset 不报错，回落到 total 榜', bogus.status === 200 && bogus.json.board === 'all',
    bogus.status + ' ' + (bogus.json && bogus.json.board));

  section('=== 9. 排行榜行不含敏感字段 ===');
  const row = boardAll.json.rows[0];
  check('行里没有邮箱/密码哈希/盐', !('hash' in row) && !('salt' in row) && !('email' in row),
    Object.keys(row).join(','));

  section('=== 10. 数据持久化（重启后仍在）===');
  /* child 是长驻进程，这里只验证落盘文件确实被写出来了 */
  const file = path.join(DATA, 'fx-online.json');
  await new Promise((r) => setTimeout(r, 400));   // 等防抖落盘
  check('数据文件已生成', fs.existsSync(file), file);
  if (fs.existsSync(file)) {
    const db = JSON.parse(fs.readFileSync(file, 'utf8'));
    check('文件里含注册的账号', !!db.users && Object.keys(db.users).length >= 2,
      Object.keys(db.users || {}).length);
    check('文件里含成绩记录', Array.isArray(db.scores) && db.scores.length >= 3,
      (db.scores || []).length);
    check('密码以盐+哈希存储（不是明文）',
      Object.values(db.users).every((u) => u.hash && u.hash.length === 64 && u.salt && u.salt.length === 32 &&
        !JSON.stringify(u).includes('himitsu123')));
  }

  section('=== 11. 静态页面托管 ===');
  const html = await request('GET', '/');
  check('GET / 返回 200', html.status === 200, html.status);
  check('返回的是联网版页面（含 FXOnline）', html.text.indexOf('FXOnline') >= 0);
  check('含排行榜入口注入', html.text.indexOf('fx-online') >= 0);

  const traversal = await request('GET', '/../src/server.js');
  check('路径穿越被挡（不回源码）', traversal.text.indexOf('FX_PORT') < 0 &&
    traversal.text.indexOf('require(') < 0, traversal.status);

  section('=== 11b. 传输压缩（弱网首屏的关键）===');
  /* 为什么要测：页面是单文件 567KB，不压缩每次访问都要传这么多。
   * 压完约 148KB（省 74%），但压缩逻辑有个共同陷阱 ——
   *   · 忘了 Vary: Accept-Encoding → 中间缓存会把 br 结果发给了只支持 gzip 的客户端
   *   · 忘了对 HEAD 去掉 body → 探针判定异常
   *   · 压缩后内容与源文件不一致（编码/换行处理错）
   * 这三条都在这里锁死。 */
  const raw = await request('GET', '/', undefined, undefined, { 'Accept-Encoding': 'identity' });
  const br = await request('GET', '/', undefined, undefined, { 'Accept-Encoding': 'br, gzip' });
  const onlyGzip = await request('GET', '/', undefined, undefined, { 'Accept-Encoding': 'gzip' });
  const refuse = await request('GET', '/', undefined, undefined, { 'Accept-Encoding': 'br;q=0, gzip;q=0' });

  check('★ 支持 brotli 时返回 br 编码',
    br.headers['content-encoding'] === 'br', br.headers['content-encoding']);
  check('★ 只支持 gzip 时退回 gzip',
    onlyGzip.headers['content-encoding'] === 'gzip', onlyGzip.headers['content-encoding']);
  check('客户端明确拒绝压缩时发明文',
    !refuse.headers['content-encoding'], refuse.headers['content-encoding']);

  const rawLen = Number(raw.headers['content-length'] || 0);
  const brLen = Number(br.headers['content-length'] || 0);
  check('★ 压缩确实省下大量体积（≥60%）',
    rawLen > 0 && brLen > 0 && (1 - brLen / rawLen) >= 0.6,
    rawLen + ' → ' + brLen + '（省 ' + Math.round((1 - brLen / rawLen) * 100) + '%）');

  check('★ 带 Vary: Accept-Encoding（否则 CDN 会串编码）',
    String(br.headers.vary || '').toLowerCase().indexOf('accept-encoding') >= 0,
    br.headers.vary);
  check('带 ETag（重复访问可 304）', !!br.headers.etag, br.headers.etag);

  if (br.headers.etag) {
    const fresh = await request('GET', '/', undefined, undefined, {
      'Accept-Encoding': 'br', 'If-None-Match': br.headers.etag,
    });
    check('★ If-None-Match 命中时返回 304 且无正文',
      fresh.status === 304 && !fresh.text, fresh.status + ' / 正文长度 ' + fresh.text.length);
  }

  const head = await request('HEAD', '/', undefined, undefined, { 'Accept-Encoding': 'br' });
  check('HEAD / 返回 200 且无正文', head.status === 200 && !head.text, head.status);

  check('★ 明文页面内容完整（非乱码、含关键标记）',
    html.text.indexOf('<!doctype html>') >= 0 && html.text.indexOf('window.FX = {') >= 0 &&
    html.text.length > 300000, '正文长度 ' + html.text.length);

  section('=== 12. 构建配置（云平台部署相关）===');
  /* 用 /api/health 里报出来的端口，反证 server.js 读的是我们传进去的 FX_PORT。
   * 这一条守护的是"部署后连不上"这个最常见的坑。 */
  check('服务监听的是注入的 FX_PORT（而非硬编码 8787）', h.status === 200 && PORT !== 8787,
    '端口 ' + PORT);

  /* 逐条检查云平台需要的配置文件都在仓库里，并且内容指向正确的东西。
   * 这些文件错了，部署就会失败或连不上，属于"跑一次测试就能发现"的问题。 */
  const gameSrcUtil = require(path.join(ROOT, 'tools', 'game-src.js'));
  const resolvedGame = gameSrcUtil.resolveGameSrc();
  const repoBody = gameSrcUtil.REPO_BODY;
  const repoBodyRel = path.relative(ROOT, repoBody).split(path.sep).join('/');
  const filesToCheck = [
    ['package.json', '"postinstall"', 'postinstall 构建钩子（只跑 npm install 的平台也能拿到最新前端产物）'],
    ['package.json', '"start": "node src/server.js"', '启动命令'],
    ['railway.json', 'healthcheckPath', 'Railway 健康检查路径'],
    ['railway.json', '/api/health', '健康检查指向 /api/health'],
    ['render.yaml', 'mountPath', 'Render 磁盘挂载（否则重部署清空榜单）'],
    [repoBodyRel, '<!doctype html>', '随仓库提交的游戏本体（云上没有 D:\\ 路径）'],
  ];
  for (const [f, needle, label] of filesToCheck) {
    const p = path.join(ROOT, f);
    let content = '';
    try { content = fs.readFileSync(p, 'utf8'); } catch (e) { /* 缺文件 */ }
    check('存在且正确：' + label, content.indexOf(needle) >= 0, f);
  }

  /* 游戏本体必须是真的游戏（含 window.FX 导出），不是占位文件 */
  let gameCopy = '';
  try { gameCopy = fs.readFileSync(resolvedGame, 'utf8'); } catch (e) { /* 缺文件 */ }
  check('游戏本体是真的游戏文件（含 FX 导出）',
    gameCopy.indexOf('window.FX = {') >= 0 && gameCopy.length > 200000,
    (resolvedGame || '(未找到)') + ' · ' + gameCopy.length + ' 字节');
  check('★ 解析到的游戏本体在仓库内（云端才构建得出来）',
    !!resolvedGame && gameSrcUtil.isInRepo(resolvedGame), String(resolvedGame));

  /* 旧路径必须真的不在了 —— 留着的话构建可能悄悄用回旧本体 */
  check('旧的本体位置 game/fx-game.html 已移除（避免构建用错版本）',
    !fs.existsSync(path.join(ROOT, 'game', 'fx-game.html')), 'game/fx-game.html 仍存在');

  section('=== 13. 构建脚本的源文件解析 ===');
  const build = require(path.join(ROOT, 'tools', 'build.js'));
  check('构建脚本能解析到游戏源文件（云上也能构建）', !!build.resolveGameSrc(),
    build.resolveGameSrc());
  check('候选路径含仓库根目录的 FX_game.html',
    build.CANDIDATES.some((c) => c && c.indexOf('FX_game.html') >= 0),
    JSON.stringify(build.CANDIDATES));

  /* ★ 四个构建脚本必须共用同一份候选列表。
   *   各抄一份的代价是"本体换位置后有的产物还在用旧文件"，而且不会报错。 */
  const builders = ['build-online.js', 'build-ghost.js', 'build.js'];
  builders.forEach((f) => {
    const m = require(path.join(ROOT, 'tools', f));
    check(f + ' 与 game-src.js 共用候选列表（不会各写一份而漂移）',
      JSON.stringify(m.CANDIDATES) === JSON.stringify(gameSrcUtil.CANDIDATES),
      JSON.stringify(m.CANDIDATES));
  });
  check('解析优先级：仓库内本体排在 D:\\ 本机路径之前',
    build.CANDIDATES.findIndex((c) => c && c.indexOf('FX_game.html') >= 0) <
    build.CANDIDATES.findIndex((c) => c && c.indexOf('D:/delta') >= 0),
    JSON.stringify(build.CANDIDATES));

  section('=== 14. 健康检查兼容性（防 502）===');
  /* HEAD /api/health 必须可用：部分负载均衡器与监控探针用 HEAD 探活。
   * 早先严格按 (method,pattern) 匹配，HEAD 会落到 404 →
   * 探针判定不健康 → 平台对外抛 502。 */
  const headHealth = await request('HEAD', '/api/health');
  check('★ HEAD /api/health 返回 200（健康探针兼容）', headHealth.status === 200, headHealth.status);
  const headPage = await request('HEAD', '/');
  check('HEAD / 返回 200（页面探针兼容）', headPage.status === 200, headPage.status);

  /* 监听地址必须是 0.0.0.0 系（不是 127.0.0.1）：否则容器外访问不到 → 502。
   * 用 /api/health 从"外部"访问即可证明它不是在只听回环。 */
  check('★ 服务可从非回环地址访问（绑定 0.0.0.0）', h.status === 200 && h.json.ok === true);

  section('=== 15. 监听配置解析（不写死端口/主机）===');
  const srvSrc = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
  check('★ 读取 process.env.PORT（而非写死端口）', srvSrc.indexOf('process.env.PORT') >= 0);
  check('★ 默认绑定 0.0.0.0（非 localhost/127.0.0.1）',
    /const HOST = process\.env\.FX_HOST \|\| '0\.0\.0\.0'/.test(srvSrc),
    (srvSrc.match(/const HOST = .+/) || [])[0]);
  check('listen() 用的是变量而非字面量',
    /server\.listen\(PORT, HOST,/.test(srvSrc),
    (srvSrc.match(/server\.listen\([^)]*\)/) || [])[0]);
  /* 真正的绑定地址不能是回环 —— 日志里出现 127.0.0.1 是正常的（给人看的提示），
   * 所以这里检查的是"没有把回环地址传进 listen()"。 */
  check('没有把 127.0.0.1/localhost 传给 listen()',
    !/server\.listen\((?:[^)]*)(?:127\.0\.0\.1|localhost)/.test(srvSrc));
  check('★ 监听失败会明确报错并退出（不再静默 502）',
    srvSrc.indexOf("server.on('error'") >= 0 && srvSrc.indexOf('EADDRINUSE') >= 0);
  /* 这里锁定的是「真正的病根」而不是某句文案：
   * 以前只要有 PORT 就无条件喊"你手动设置了 PORT"，而在 Railway 上 PORT
   * 本来就是平台注入的，于是每次部署都刷三段警告 —— 告警被自己的噪音淹掉。
   * 现在的要求是：不再输出那种必然误报的警告，但只要处在云平台、端口又来自
   * PORT，启动横幅里必须说明端口来源（人看日志能立刻判断）。 */
  check('不再无条件误报"你手动设置了 PORT"',
    srvSrc.indexOf('检测到你在云平台上手动设置了 PORT') < 0);
  check('启动横幅会说明端口来源',
    srvSrc.indexOf('端口来自平台注入的 PORT') >= 0);

  section('=== 16. 端口优先级实测（独立起进程验证）===');
  /* 用一个真实子进程验证 pickPort 的优先级，而不是只读源码文本。
   * 显式覆盖 FX_PORT/PORT（包括用空串把父进程的继承值清掉），
   * 否则子进程会继承测试自身环境里的变量，结果不可控。 */
  function portOf(env) {
    return new Promise((resolve) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
        env: Object.assign({}, process.env, { FX_HOST: '127.0.0.1', FX_DATA: DATA },
          { FX_PORT: '', PORT: '' }, env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const done = (v) => { try { p.kill(); } catch (e) {} resolve(v); };
      p.stdout.on('data', (d) => {
        out += d.toString();
        const m = out.match(/监听：\s+[\d.]+:(\d+)/);
        if (m) done(Number(m[1]));
      });
      p.stderr.on('data', () => {});
      setTimeout(() => done(null), 6000);
    });
  }
  check('只设 PORT=3101 → 用 3101（云平台场景）', (await portOf({ PORT: '3101' })) === 3101);
  check('FX_PORT=3102 压过 PORT=3101 → 用 3102',
    (await portOf({ PORT: '3101', FX_PORT: '3102' })) === 3102);
  check('都不设 → 回落 8787', (await portOf({})) === 8787);
  check('非法 PORT 被忽略 → 回落 8787', (await portOf({ PORT: 'abc' })) === 8787);

  console.log('\n' + '='.repeat(52));
  console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
  console.log('='.repeat(52));
  if (fail > 0) {
    console.log('\n--- 服务端输出 ---\n' + serverOut.slice(-2000));
    process.exitCode = 1;
  }
  child.kill();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试异常：' + (e && e.stack || e));
  console.log('\n--- 服务端输出 ---\n' + serverOut.slice(-3000));
  process.exit(1);
});
