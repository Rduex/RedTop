/*
 * FX 战士久留美 · 联网版服务端（零外部依赖，只用 Node 内置模块）
 *
 * 启动： node src/server.js        （默认 http://127.0.0.1:8787）
 * 环境变量：
 *   PORT       监听端口（**云平台标准变量**，Railway/Render/Heroku/Fly 都注入它）
 *   FX_PORT    同上，优先级更高（留给你在本机想强制指定端口时用）
 *   FX_HOST    监听地址（默认 0.0.0.0，局域网/公网可访问）
 *   FX_DATA    数据目录（默认 ./data）
 *
 * ★ 关于 PORT 与 FX_PORT 的关系（这是"部署后连不上"最常见的原因）：
 *   Railway / Render / Heroku / Fly.io 这些平台不会用 FX_PORT，
 *   它们只会注入标准的 PORT，并且**按那个端口做健康检查**。
 *   如果服务只听 8787，平台探活失败 → 判定部署不健康 → 对外就是"连不上"。
 *   所以这里优先读 FX_PORT，其次读 PORT，最后才回落到 8787。
 *
 * 为什么手写 HTTP 而不是用 Express：
 *   目标是"下载下来就能跑、丢到任何云主机都能跑"。多一个 node_modules
 *   就多一层"npm install 失败/版本漂移"的风险，而这个服务的路由只有十来个，
 *   用内置 http 模块反而更简单、更可控。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const { Store, DEFAULT_BALANCE, MAX_POSITIONS, MAX_BALANCE } = require('./store');
const { Auth } = require('./auth');
const { Leaderboard, BOARDS } = require('./leaderboard');
const { ReplayVerifier } = require('./verify');
const storageCheck = require('./storage-check');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.resolve(process.env.FX_DATA || path.join(ROOT, 'data'));
const PUBLIC_DIR = path.join(ROOT, 'public');

/* 端口优先级：FX_PORT（本机强制指定）> PORT（云平台标准）> 8787（本机默认）
 *
 * ★ 关于 PORT 的坑（"部署后 502"最常见的原因）：
 *   平台会自己注入 PORT，并按**它注入的那个端口**做健康检查。
 *   如果面板里又手动设了一个 PORT（比如 3000），应用确实会监听 3000，
 *   但平台的健康检查仍然去拨它注入的值 —— 两边对不上，就一直是 502。
 *   正确做法：什么都不设，让本函数直接用平台注入的值。（"Do not pin PORT"）
 *
 * ★ 为什么这里**不再**在检测到 PORT 时大喊"你手动设置了 PORT"：
 *   云平台上 PORT 本来就由平台注入，所以这个判断在 Railway 上恒为真，
 *   每次部署都打印三段警告 —— 真正的告警会被自己的噪音淹掉（实测如此）。
 *   仅凭环境变量无法区分"平台注入"与"用户手填"（手填就是覆盖同一个变量，
 *   注入的原值已不可见），所以这里只保留事实，把提示降级进启动横幅。 */
function pickPort() {
  if (process.env.FX_PORT && process.env.PORT) {
    console.warn('[server] 同时设置了 FX_PORT 与 PORT，将使用 FX_PORT=' + process.env.FX_PORT +
      '（忽略 PORT=' + process.env.PORT + '）');
  }
  const candidates = [process.env.FX_PORT, process.env.PORT];
  for (const c of candidates) {
    if (c === undefined || c === null || String(c).trim() === '') continue;
    const n = Number(String(c).trim());
    if (Number.isInteger(n) && n > 0 && n < 65536) return n;
    console.warn('[server] 忽略了非法的端口值：' + JSON.stringify(c));
  }
  return 8787;
}

/* 是否处在云部署环境：这些变量由平台注入，本机不会有 */
function isDeployPlatform() {
  return !!(process.env.RAILWAY_ENVIRONMENT || process.env.RAILWAY_PROJECT_ID ||
    process.env.RENDER || process.env.RENDER_SERVICE_ID ||
    process.env.HEROKU_APP_NAME || process.env.FLY_APP_NAME ||
    process.env.WEBSITE_SITE_NAME || process.env.K_SERVICE);
}
const PORT = pickPort();
/* 监听地址：云平台必须听 0.0.0.0（只听 127.0.0.1 的话容器外访问不到）。
 * 允许用 FX_HOST 覆盖，主要是给"只想本机自用"的场景。 */
const HOST = process.env.FX_HOST || '0.0.0.0';

const MAX_BODY = 256 * 1024;   // 请求体上限 256KB：成绩上报只有几 KB

/* ============================ 基础设施 ============================ */

const store = new Store(path.join(DATA_DIR, 'fx-online.json'));
const auth = new Auth(store, path.join(DATA_DIR, 'secret.key'));
const board = new Leaderboard(store);
const verifier = new ReplayVerifier();

/* 简易 IP 限流：滑动窗口计数。
 * 目的不是防 DDoS（那该交给反向代理），而是防止单个脚本把注册/提交接口刷爆。
 * 内存表 + 定期清理就够，重启后重建无所谓。 */
const buckets = new Map();
function rateLimit(key, limit, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now - b.start >= windowMs) {
    b = { start: now, n: 0 };
    buckets.set(key, b);
  }
  b.n++;
  return b.n <= limit;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (now - b.start > 10 * 60 * 1000) buckets.delete(k);
  }
}, 5 * 60 * 1000).unref();

function clientIp(req) {
  /* 部署在 Nginx / Cloudflare 之后时，真实来源在 X-Forwarded-For 的第一段。
   * 这两个头可以被伪造，所以它只用于限流，不用于任何权限判断。 */
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(Array.isArray(xff) ? xff[0] : xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    /* 联网版是独立来源，这里显式打开 CORS，方便你把前端挂到别的域名/端口调试 */
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-FX-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error('顶层必须是对象');
    }
    return v;
  } catch (e) {
    throw Object.assign(new Error('请求体不是合法 JSON'), { status: 400 });
  }
}

/* ============================ 静态文件 ============================ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
};

const IMMUTABLE = /-[0-9a-f]{8,}\.(?:js|css)$/i;

/* ============================ 静态资源压缩 ============================
 *
 * 为什么必须做：游戏页面是**单文件**，原始体积 567KB（HTML + 内联 CSS + 内联 JS）。
 * 不压缩就是每次访问都传 567KB —— 弱网下首屏要好几秒，而这游戏本身只有
 * 一个 HTML，压完只传 148KB，省 74%，且**零新增依赖**（zlib 是 Node 内置）。
 *
 * 几个关键取舍：
 *
 * ① 用 brotli 而不是 gzip：实测 567KB 下
 *      gzip -9     180 KB / 31 ms
 *      brotli q9   148 KB / 58 ms   ← 选它
 *      brotli q11  138 KB / 1263 ms ← 太慢，不值得为 10KB 卡 1.2 秒
 *    q9 与 q11 只差 10KB，但耗时差 20 倍。首页只压一次，58ms 完全可以接受。
 *
 * ② 压缩结果**缓存**在内存里，键带 mtime + 大小：文件一改就自动失效。
 *    否则每个请求都压一次 58ms，并发一上来 CPU 就打满了。
 *
 * ③ 缓存上限 8 项 + 超出直接清空：这个项目静态文件就一个 index.html，
 *    设上限纯粹是防御"以后有人往 public/ 里塞几百个文件"。
 *
 * ④ 只压文本类扩展名。png/jpg/woff2 本来就压过，再压反而更大。
 */
const COMPRESSIBLE = new Set(['.html', '.htm', '.js', '.css', '.json', '.svg', '.txt', '.map']);
const COMPRESS_CACHE = new Map();
const COMPRESS_CACHE_MAX = 8;

/* 按 mtime + 长度做缓存键：文件内容一变，键就变，缓存自然失效 */
function compressionCacheKey(file, st, len) {
  return file + '|' + (st ? st.mtimeMs : 0) + '|' + len;
}

/* 取这个文件的压缩版本（首次调用会真的压，之后走缓存）。
 * 返回 { br, gz, etag }；不可压缩的文件返回 null。 */
function compressedVariants(file, buf, st) {
  const ext = path.extname(file).toLowerCase();
  if (!COMPRESSIBLE.has(ext)) return null;
  /* 太小的文件压缩收益抵不过头部开销，直接不压 */
  if (buf.length < 1024) return null;

  const key = compressionCacheKey(file, st, buf.length);
  const hit = COMPRESS_CACHE.get(key);
  if (hit) return hit;

  /* ETag 用内容哈希：配合 If-None-Match 让重复访问只回 304，一个字节都不用传。
   * 注意 ETag 必须与"是否压缩"无关 —— 同一个资源的强校验值只该有一个。 */
  const etag = '"' + crypto.createHash('sha1').update(buf).digest('hex').slice(0, 20) + '"';

  let br = null, gz = null;
  try {
    br = zlib.brotliCompressSync(buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    });
  } catch (e) { br = null; }             /* brotli 不可用就退化到 gzip */
  try { gz = zlib.gzipSync(buf, { level: 9 }); } catch (e) { gz = null; }

  const entry = { br, gz, etag };
  if (COMPRESS_CACHE.size >= COMPRESS_CACHE_MAX) COMPRESS_CACHE.clear();
  COMPRESS_CACHE.set(key, entry);
  return entry;
}

/* 客户端接受哪种编码。按 q 值排序太繁琐，这里按"优先 brotli，其次 gzip"，
 * 同时尊重 q=0（明确拒绝）。 */
function acceptEncoding(req) {
  const raw = String((req && req.headers && req.headers['accept-encoding']) || '').toLowerCase();
  if (!raw) return null;
  const banned = (enc) => new RegExp('(^|,)\\s*' + enc + '\\s*;\\s*q\\s*=\\s*0(\\.0*)?\\s*(,|$)').test(raw);
  if (raw.indexOf('br') >= 0 && !banned('br')) return 'br';
  if (raw.indexOf('gzip') >= 0 && !banned('gzip')) return 'gzip';
  return null;
}

function serveStatic(req, res, urlPath) {
  /* 路径穿越防护：解析成绝对路径后必须仍在 PUBLIC_DIR 之内。
   * 这一步不能省 —— decodeURIComponent 之后 "%2e%2e%2f" 这类编码会绕过朴素检查。 */
  let rel;
  try {
    rel = decodeURIComponent(urlPath);
  } catch (_) {
    return sendJson(res, 400, { ok: false, error: '非法路径' });
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = path.resolve(PUBLIC_DIR, '.' + rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { ok: false, error: '禁止访问' });
  }

  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      /* 单页应用回退：未命中的路径统一给 index.html，前端自己处理视图 */
      return sendFile(req, res, path.join(PUBLIC_DIR, 'index.html'), true);
    }
    sendFile(req, res, target, false, st);
  });
}

function sendFile(req, res, file, isFallback, st) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(file).toLowerCase();
    const variants = compressedVariants(file, buf, st);
    const isHead = req && req.method === 'HEAD';

    const headers = {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      /* 静态资源带 hash 的可以长缓存，HTML 一律不缓存：
       * 否则你更新了服务端，玩家的浏览器还在跑旧版本。 */
      'Cache-Control': IMMUTABLE.test(file) && !isFallback
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };

    /* ★ 强校验 + 304：HTML 是 no-cache（每次都问一次），但"问"不等于"重传"。
     *   浏览器带上 If-None-Match，命中就只回 304，**一个字节正文都不传**。
     *   实测弱网下这是重复访问最大的收益点（首次仍要传压缩后的 148KB）。 */
    if (variants) {
      headers.ETag = variants.etag;
      /* Vary 必须写：同一个 URL 可能返回 br / gzip / 原文，
       * 漏了它会被中间缓存（CDN、代理）混着发，导致客户端解码失败。 */
      headers.Vary = 'Accept-Encoding';
      if (!isHead && req && req.headers['if-none-match'] === variants.etag) {
        res.writeHead(304, headers);
        return res.end();
      }
    }

    /* 选一个能用的压缩版本；都没有就发明文 */
    let body = buf;
    let encoding = null;
    if (variants) {
      const want = acceptEncoding(req);
      if (want === 'br' && variants.br) { body = variants.br; encoding = 'br'; }
      else if (want === 'gzip' && variants.gz) { body = variants.gz; encoding = 'gzip'; }
    }
    if (encoding) headers['Content-Encoding'] = encoding;
    headers['Content-Length'] = body.length;

    res.writeHead(200, headers);
    /* HEAD 只回头部，body 必须为空（有些探针会因此判定异常） */
    res.end(isHead ? undefined : body);
  });
}

/* ============================ 路由 ============================ */

/* 每个路由声明自己的限流额度：注册/登录要收紧（防撞库），排行榜读取可以放宽 */
const ROUTES = [];
function route(method, pattern, handler, opt) {
  ROUTES.push({ method, pattern, handler, opt: opt || {} });
}

/* 需要登录：失败返回 401 */
function requireUser(req, res) {
  const user = auth.userFromRequest(req);
  if (!user) {
    sendJson(res, 401, { ok: false, code: 'unauthorized', error: '请先登录' });
    return null;
  }
  return user;
}

/* ---------- 健康检查 ---------- */
route('GET', '/api/health', (req, res) => {
  /* 存储诊断：直接放进 health，方便在不看日志的情况下排查
   * "为什么重启后数据丢了"这类问题。
   * 注意只暴露路径与判断结果，不暴露任何凭据内容。 */
  let storage = null;
  try {
    const sc = storageCheck.check(DATA_DIR, { silent: true });
    storage = {
      dir: sc.dir,
      source: sc.source,
      writable: sc.writable,
      platform: sc.platform,
      mountPoint: sc.mountPoint,
      dbExists: sc.dbExists,
      level: sc.level,
      /* 文件系统设备号：同一个目录在"挂载卷"与"容器临时盘"上
       * 会有不同的 dev。重启前后对比 dev 是否变化，就能确定卷有没有生效。
       * 这是最硬的证据 —— 不依赖 /proc 是否可读。 */
      dev: null,
      ino: null,
      fsType: null,
    };
    try {
      const fsMod = require('fs');
      fsMod.mkdirSync(DATA_DIR, { recursive: true });
      const st = fsMod.statSync(DATA_DIR);
      storage.dev = st.dev;
      storage.ino = st.ino;
      /* 再取一次文件系统类型（Linux 上通过 statfs 不可用，
       * 退化为读 /proc/mounts 找匹配项） */
      try {
        const mounts = fsMod.readFileSync('/proc/mounts', 'utf8').split('\n');
        let best = null;
        for (const line of mounts) {
          const parts = line.split(' ');
          if (parts.length < 3) continue;
          const mp = parts[1];
          if (!mp) continue;
          if (DATA_DIR === mp || DATA_DIR.indexOf(mp.replace(/\/$/, '') + '/') === 0) {
            if (!best || mp.length > best.mp.length) best = { mp, type: parts[2] };
          }
        }
        if (best) storage.fsType = best.type + ' @ ' + best.mp;
      } catch (e2) { /* Windows 上不可用，忽略 */ }
    } catch (e) {
      storage.devError = e.message;
    }
  } catch (e) {
    storage = { error: e.message };
  }
  sendJson(res, 200, {
    ok: true,
    service: 'fx-online',
    version: 1,
    uptime: Math.round(process.uptime()),
    users: Object.keys(store.db.users).length,
    scores: store.db.scores.length,
    boards: Object.keys(BOARDS),
    storage: storage,
    verify: verifier.status(),
    time: Date.now(),
  });
}, { rate: 240 });

/* ---------- 注册 ---------- */
route('POST', '/api/register', async (req, res) => {
  const body = await readJson(req);
  const r = auth.register(body.name, body.password);
  if (!r.ok) return sendJson(res, 400, { ok: false, code: 'register_failed', error: r.error });
  console.log('[auth] 注册：' + r.user.name + '（' + clientIp(req) + '）');
  sendJson(res, 200, {
    ok: true,
    token: r.token,
    user: publicUser(r.user),
  });
}, { rate: 10, window: 10 * 60 * 1000 });

/* ---------- 登录 ---------- */
route('POST', '/api/login', async (req, res) => {
  const body = await readJson(req);
  const r = auth.login(body.name, body.password);
  if (!r.ok) return sendJson(res, 401, { ok: false, code: 'login_failed', error: r.error });
  sendJson(res, 200, { ok: true, token: r.token, user: publicUser(r.user) });
}, { rate: 20, window: 10 * 60 * 1000 });

/* ---------- 我是谁（带 token 校验，用于页面刷新后恢复登录态） ---------- */
route('GET', '/api/me', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { ok: true, user: publicUser(user), profile: board.profile(user) });
}, { rate: 240 });

/* ---------- 改昵称 ---------- */
route('POST', '/api/rename', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJson(req);
  const { validateName } = require('./auth');
  const n = validateName(body.name);
  if (!n.ok) return sendJson(res, 400, { ok: false, error: n.error });
  const exist = store.userByName(n.value);
  if (exist && exist.id !== user.id) {
    return sendJson(res, 400, { ok: false, error: '这个昵称已经被占用了' });
  }
  store.mutate(() => {
    user.name = n.value;
    user.nameLower = n.value.toLowerCase();
    /* 历史成绩上的显示名一并更新：排行榜是按成绩行存的名字快照，
   * 不改的话改名后旧成绩还显示旧昵称。 */
    for (const s of store.db.scores) {
      if (s.userId === user.id) s.name = n.value;
    }
  }, { sync: true });
  sendJson(res, 200, { ok: true, user: publicUser(user) });
}, { rate: 10, window: 10 * 60 * 1000 });

/* ---------- 提交成绩 ---------- */
route('POST', '/api/score', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJson(req);
  /* ★ 必须兼容两种上报形态，否则前端发来的成绩会被整条解错：
   *   ① 扁平（前端 online-client.js 实际使用的形态）
   *        { runId, score: 184320.55, equity, tickCount, ... }
   *   ② 包裹（早期测试脚本用的形态）
   *        { score: { runId, score: 184320.55, ... } }
   *   之前写成 `body.score || body`，扁平形态下 body.score 是个**数字**（真值），
   *   于是把数字当成了整个上报体 → tickCount/equity 全变 0 →
   *   每一条真实成绩都会被判"这一局太短"而拒掉。
   *   这里以"score 是不是对象"来区分，两种形态都能正确解析。 */
  const raw = (body.score && typeof body.score === 'object') ? body.score : body;
  const r = board.submit(user, raw, Date.now());
  if (!r.ok) {
    console.log('[score] 拒绝 ' + user.name + '：' + r.code + ' — ' + r.error);
    return sendJson(res, 400, { ok: false, code: r.code, error: r.error });
  }
  console.log('[score] ' + user.name + ' 本局峰值 $' + Math.round(r.entry.score) +
    ' · 总榜第 ' + r.rank + ' 名');
  sendJson(res, 200, { ok: true, entry: r.entry, rank: r.rank, total: r.total });
}, { rate: 120, window: 10 * 60 * 1000 });

/* ---------- 排行榜 ---------- */
route('GET', '/api/leaderboard', (req, res, url) => {
  const q = url.searchParams;
  const user = auth.userFromRequest(req);   // 可选：登录了就顺便告诉客户端"我在第几"
  sendJson(res, 200, {
    ok: true,
    ...board.board(q.get('board') || 'all', {
      limit: q.get('limit'),
      offset: q.get('offset'),
      userId: user ? user.id : null,
    }),
  });
}, { rate: 240 });

/* ---------- 个人资料 ---------- */
route('GET', '/api/profile', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, { ok: true, ...board.profile(user) });
}, { rate: 240 });

/* ---------- 预留：权威复盘验证（当前返回未启用） ---------- */
route('POST', '/api/replay', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJson(req);
  sendJson(res, 200, { ok: true, ...verifier.verify(user, body, store) });
}, { rate: 60, window: 10 * 60 * 1000 });

/* ============================ 云存档 ============================
 *
 * 背景：游戏原本的状态只活在页面内存里，一刷新就回到 $10,000。
 * 这里加三个接口把 balance / positions 存到服务端，刷新后能接着玩。
 *
 * 设计上的三个约束：
 *   1) 全部需要鉴权：存档是玩家的私有数据，游客不落库（前端直接走内存）。
 *   2) 写入走 sync 落盘：存档是"不可再生"的，防抖窗口内被杀就永久丢了。
 *   3) 时间戳防倒退：客户端可能并发提交（节流 + beforeunload 两条路径），
 *      如果乱序到达，旧数据会覆盖新数据。用 clientTs 做单调性检查。
 * ================================================================ */

/* 存档请求体很小（几十个仓位），但同步频率高，单独给一个宽松的读额度 */
const ACCOUNT_READ_RATE = 240;
const ACCOUNT_WRITE_RATE = 120;

/* 校验并归一化客户端提交的存档。
 * 所有字段都当作不可信输入：类型、范围、长度全部收紧。 */
function parseAccountPayload(body) {
  const b = body && typeof body === 'object' ? body : {};
  const bal = Number(b.balance);
  if (!Number.isFinite(bal)) {
    return { ok: false, error: 'balance 必须是数字' };
  }
  if (bal < 0) return { ok: false, error: 'balance 不能为负' };
  if (bal > MAX_BALANCE) return { ok: false, error: 'balance 超出合理上限' };
  if (b.positions !== undefined && !Array.isArray(b.positions)) {
    return { ok: false, error: 'positions 必须是数组' };
  }
  if (Array.isArray(b.positions) && b.positions.length > MAX_POSITIONS) {
    return { ok: false, error: '持仓数量超出上限（最多 ' + MAX_POSITIONS + ' 个）' };
  }
  /* clientTs 可选：前端用来做"哪个请求更新"的比较。缺省时用服务端时间。 */
  const ts = Number(b.clientTs);
  return {
    ok: true,
    balance: bal,
    positions: b.positions || [],
    clientTs: Number.isFinite(ts) ? ts : null,
  };
}

/* 组装返回给前端的存档体 */
function accountPayload(user) {
  const acc = store.accountOf(user.id) || { balance: DEFAULT_BALANCE, positions: [], lastSyncAt: 0 };
  return {
    ok: true,
    balance: acc.balance,
    positions: acc.positions,
    lastSyncAt: acc.lastSyncAt,
    /* 前端据此判断"服务端是否已有真实存档"：
     * lastSyncAt === 0 表示这个账号从没同步过，此时前端不该覆盖本地初始状态。 */
    hasSave: acc.lastSyncAt > 0,
  };
}

/* ---------- GET /api/account/state ---------- */
route('GET', '/api/account/state', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  sendJson(res, 200, accountPayload(user));
}, { rate: ACCOUNT_READ_RATE });

/* ---------- POST /api/account/sync ---------- */
route('POST', '/api/account/sync', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const body = await readJson(req);
  const parsed = parseAccountPayload(body);
  if (!parsed.ok) {
    return sendJson(res, 400, { ok: false, code: 'bad_balance', error: parsed.error });
  }

  /* 时间戳单调性：拒绝比当前存档更旧的提交，避免并发乱序把新数据覆盖成旧的。
   *
   * ★ 这里必须拿**同一个时钟域**做比较：
   *   客户端提交的是 clientTs（客户端时钟），服务端记录的是 lastSyncAt（服务端时钟）。
   *   早先代码直接比较这两个值 —— 但服务端时间通常比客户端晚几毫秒
   *   （请求往返 + 两端时钟误差），于是：
   *     客户端用同一个 clientTs 重发（网络重试 / 幂等重放）→ 被判 409 stale。
   *   这是真 bug，不是测试问题：重试会被误拒、玩家进度推不上去。
   *
   *   改法：额外存一个 lastClientTs（**上次接受的客户端时间戳**），
   *   单调性只跟它比，两个值都来自客户端时钟，语义才对等。
   *   同时留 2 秒容差，容忍多标签页/并发请求的微小乱序。 */
  const cur = store.accountOf(user.id);
  if (parsed.clientTs !== null && cur && cur.lastClientTs > 0 &&
      parsed.clientTs < cur.lastClientTs - 2000) {
    return sendJson(res, 409, {
      ok: false, code: 'stale_sync',
      error: '这次提交比服务端的存档更旧，已忽略',
      balance: cur.balance,
      lastSyncAt: cur.lastSyncAt,
    });
  }

  const now = Date.now();
  const saved = store.saveAccount(user.id, parsed.balance, parsed.positions, now, parsed.clientTs);
  if (!saved) return sendJson(res, 404, { ok: false, error: '账号不存在' });

  sendJson(res, 200, {
    ok: true,
    balance: saved.balance,
    positions: saved.positions,
    lastSyncAt: saved.lastSyncAt,
    hasSave: true,
  });
}, { rate: ACCOUNT_WRITE_RATE });

/* ---------- POST /api/account/reset ---------- */
route('POST', '/api/account/reset', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const now = Date.now();
  const saved = store.resetAccount(user.id, now);
  if (!saved) return sendJson(res, 404, { ok: false, error: '账号不存在' });
  console.log('[account] ' + user.name + ' 重置存档 → $' + saved.balance);
  sendJson(res, 200, {
    ok: true,
    balance: saved.balance,
    positions: saved.positions,
    lastSyncAt: saved.lastSyncAt,
    hasSave: true,
  });
}, { rate: ACCOUNT_WRITE_RATE });

function publicUser(u) {
  return {
    id: u.id, name: u.name, createdAt: u.createdAt,
    best: u.best, runs: u.runs, wins: u.wins,
  };
}

/* ============================ 请求分发 ============================ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-FX-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  if (!pathname.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return sendJson(res, 405, { ok: false, error: '方法不允许' });
    }
    return serveStatic(req, res, pathname);
  }

  /* ★ HEAD 请求要按 GET 处理。
   * 有些健康检查器（含部分负载均衡与监控探针）用 HEAD 而不是 GET 探活。
   * 早先这里严格按 (method, pattern) 匹配，HEAD /api/health 会落到 404 ——
   * 探针看到 404 就判定服务不健康，进而抛出 502。
   * HTTP 语义上 HEAD 应当等价于 GET（只是不返回 body），所以这里统一映射。 */
  const method = req.method === 'HEAD' ? 'GET' : req.method;
  const found = ROUTES.find((r) => r.method === method && r.pattern === pathname);
  if (!found) {
    return sendJson(res, 404, { ok: false, error: '没有这个接口：' + pathname });
  }

  /* 限流键 = 路由 + IP：不同接口各自计数，互不影响 */
  const rlKey = found.pattern + '|' + clientIp(req);
  if (!rateLimit(rlKey, found.opt.rate || 120, found.opt.window || 60 * 1000)) {
    return sendJson(res, 429, { ok: false, code: 'rate_limited', error: '操作太频繁了，稍后再试' });
  }

  try {
    await found.handler(req, res, url);
  } catch (e) {
    const status = e && e.status ? e.status : 500;
    if (status >= 500) console.error('[500] ' + pathname + ' → ' + (e && e.stack || e));
    if (!res.headersSent) {
      sendJson(res, status, { ok: false, error: (e && e.message) || '服务器内部错误' });
    } else {
      res.end();
    }
  }
});

/* 未捕获异常不要让进程直接死掉：排行榜服务挂掉比"少记一条成绩"严重得多 */
process.on('uncaughtException', (e) => {
  console.error('[uncaught] ' + (e && e.stack || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[unhandled] ' + (e && e.stack || e));
});

function shutdown(sig) {
  console.log('\n[server] 收到 ' + sig + '，正在保存数据…');
  try { store.close(); } catch (e) { console.error('[server] 保存失败：' + e.message); }
  server.close(() => process.exit(0));
  /* 兜底：10 秒内没关干净就强退，避免部署脚本卡住 */
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/* 监听失败必须**大声报错并退出**。
 *
 * 为什么这条很重要：如果不给 server 挂 'error' 监听，Node 遇到
 * EADDRINUSE（端口被占）/ EACCES（权限不足）只会抛一个未捕获异常，
 * 日志里一行带上下文的话都没有 —— 而部署平台上你**只能靠日志**排查。
 * 典型场景就是 502：进程看起来"在跑"，实际根本没监听任何端口，
 * 平台健康检查一直拨不通，你却完全看不出原因。
 *
 * 这里把它变成一条人话日志，并明确退出码非 0（让平台判定部署失败并重试），
 * 而不是留着一个"活着但不服务"的僵尸进程。 */
server.on('error', (err) => {
  const lines = [''];
  if (err && err.code === 'EADDRINUSE') {
    lines.push('  ❌ 端口 ' + PORT + ' 已被占用（EADDRINUSE），无法启动。');
    lines.push('');
    lines.push('  最常见的原因：你在平台的环境变量里手动设了 PORT，');
    lines.push('  而平台自己也会注入 PORT —— 两个值打架，或与平台探测的端口不一致。');
    lines.push('  ★ 处理办法：**删掉你自己设的 PORT 环境变量**，让平台自动注入。');
    lines.push('     Railway 会按它注入的端口做健康检查，手动改 PORT 会导致 502。');
  } else if (err && err.code === 'EACCES') {
    lines.push('  ❌ 没有权限监听端口 ' + PORT + '（EACCES）。');
    lines.push('  1024 以下的端口通常需要 root 权限，请换一个高位端口。');
  } else {
    lines.push('  ❌ 监听失败：' + (err && err.message || err));
  }
  lines.push('');
  lines.push('  当前生效的配置：');
  lines.push('    监听地址：' + HOST + '（云平台应为 0.0.0.0）');
  lines.push('    监听端口：' + PORT);
  lines.push('    PORT 环境变量：' + JSON.stringify(process.env.PORT));
  lines.push('    FX_PORT 环境变量：' + JSON.stringify(process.env.FX_PORT));
  lines.push('    FX_HOST 环境变量：' + JSON.stringify(process.env.FX_HOST));
  lines.push('');
  console.error(lines.join('\n'));
  try { store.close(); } catch (e) { /* 尽力保存 */ }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const lan = [];
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) lan.push(ni.address);
    }
  }
  console.log('');
  console.log('  🎮 FX 战士久留美 · 联网版已启动');
  console.log('  ────────────────────────────────────────────');
  console.log('  监听：    ' + HOST + ':' + PORT +
    (process.env.FX_PORT ? '（端口来自 FX_PORT，本机强制指定）'
      : process.env.PORT ? '（端口来自平台注入的 PORT）' : '（本机默认端口）'));
  console.log('  本机：    http://127.0.0.1:' + PORT);
  lan.forEach((ip) => console.log('  局域网：  http://' + ip + ':' + PORT + '   （同一 WiFi 下手机直接扫码/输入）'));
  /* ★ 数据持久化自检：明确告知"重新部署会不会丢数据"。
   *   以前这里只打印路径，看不出是否挂载了卷 —— 曾导致
   *   "以为卷挂好了、实际每次部署都在清空数据，日志却毫无提示"。
   *   放在启动横幅里，看日志就能一眼判断。 */
  storageCheck.print(storageCheck.check(DATA_DIR, { silent: true }));
});

module.exports = { server, store, auth, board, verifier };
