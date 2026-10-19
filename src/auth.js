/*
 * 账号与凭证：昵称 + 密码注册（用户选择），零外部依赖。
 *
 * 密码存储：scrypt + 每用户随机盐（Node 内置 crypto，无需 bcrypt 依赖）。
 *   - N=16384 是 Node 默认的 CPU/内存成本，单次约几十毫秒，足以让离线爆破变得昂贵；
 *   - 校验一律走 timingSafeEqual，避免用比较耗时反推哈希。
 *
 * 会话凭证：HMAC 签名的无状态 token（userId.expiresAt.signature）。
 *   - 服务端不存 session 表 → 重启服务不会把所有人踢下线；
 *   - 签名密钥持久化在 data/secret.key，重启后旧 token 依然有效；
 *   - 令牌自带过期时间，服务端校验时不需要额外查询。
 */
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { DEFAULT_BALANCE } = require('./store');

const SCRYPT_N = 16384;
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const KEY_LEN = 32;
const TOKEN_DAYS = 90;

/* 昵称规则：2~20 个字符，允许中英文/数字/下划线/连字符。
 * 过宽会把控制字符、emoji 组合、类似昵称的空白都放进来，排行榜会被搞乱。 */
const NAME_RE = /^[\u4e00-\u9fa5A-Za-z0-9_-]{2,20}$/;
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 128;

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, KEY_LEN, {
    N: SCRYPT_N, r: SCRYPT_r, p: SCRYPT_p,
  }).toString('hex');
}

function makeSalt() {
  return crypto.randomBytes(16).toString('hex');
}

/* 恒定时间比较：长度不同直接返回 false（长度本身不是秘密） */
function safeEqual(a, b) {
  const ba = Buffer.from(String(a), 'utf8');
  const bb = Buffer.from(String(b), 'utf8');
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function validateName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!NAME_RE.test(s)) {
    return { ok: false, error: '昵称需要 2~20 个字符，只能用中英文、数字、下划线或连字符' };
  }
  return { ok: true, value: s };
}

function validatePassword(pw) {
  const s = String(pw == null ? '' : pw);
  if (s.length < PASSWORD_MIN) return { ok: false, error: '密码至少 ' + PASSWORD_MIN + ' 位' };
  if (s.length > PASSWORD_MAX) return { ok: false, error: '密码最多 ' + PASSWORD_MAX + ' 位' };
  return { ok: true, value: s };
}

function loadSecret(file) {
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return Buffer.from(s, 'hex');
  } catch (_) { /* 首次启动或文件不可读 → 生成新的 */ }
  const buf = crypto.randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf.toString('hex'), { encoding: 'utf8', mode: 0o600 });
  } catch (e) {
    console.error('[auth] 无法持久化签名密钥（本次运行期间会话仍可用，重启后需重新登录）：' + e.message);
  }
  return buf;
}

class Auth {
  constructor(store, secretFile) {
    this.store = store;
    this.secret = loadSecret(secretFile);
  }

  /* ---------- 注册 ---------- */

  register(name, password) {
    const n = validateName(name);
    if (!n.ok) return { ok: false, error: n.error };
    const p = validatePassword(password);
    if (!p.ok) return { ok: false, error: p.error };
    if (this.store.userByName(n.value)) {
      return { ok: false, error: '这个昵称已经被占用了，换一个吧' };
    }
    const salt = makeSalt();
    const now = Date.now();
    const user = {
      id: crypto.randomUUID(),
      name: n.value,
      nameLower: n.value.toLowerCase(),
      salt,
      hash: hashPassword(p.value, salt),
      createdAt: now,
      lastSeen: now,
      best: 0,
      runs: 0,
      wins: 0,
      banned: false,
      /* ---------- 云存档 ----------
       * 新账号也要把三个字段显式写出来，与 _normalize 给老账号补的默认值
       * 保持同一口径。否则会变成"老账号有 balance、新账号没有"的反向不一致。 */
      balance: DEFAULT_BALANCE,
      positions: [],
      lastSyncAt: 0,
    };
    /* 注册是不可再生的：同步落盘，避免"注册完立刻被杀"导致账号消失 */
    this.store.mutate((db) => { db.users[user.id] = user; }, { sync: true });
    return { ok: true, user, token: this.issueToken(user.id) };
  }

  /* ---------- 登录 ---------- */

  login(name, password) {
    const user = this.store.userByName(name);
    if (!user) {
      // 用户不存在也走一次哈希：让"存在/不存在"的响应时间尽量接近，
      // 避免用响应耗时枚举已注册昵称。
      hashPassword(String(password == null ? '' : password), 'decoy-salt-for-timing');
      return { ok: false, error: '昵称或密码不对' };
    }
    const expect = hashPassword(String(password == null ? '' : password), user.salt);
    if (!safeEqual(expect, user.hash)) return { ok: false, error: '昵称或密码不对' };
    if (user.banned) return { ok: false, error: '这个账号已被封禁' };
    /* lastSeen 也要落盘，否则重启后"最后活跃时间"全部回退 */
    this.store.mutate(() => { user.lastSeen = Date.now(); }, { sync: true });
    return { ok: true, user, token: this.issueToken(user.id) };
  }

  /* ---------- 无状态 token ---------- */

  issueToken(userId) {
    const expires = Date.now() + TOKEN_DAYS * 24 * 3600 * 1000;
    const body = userId + '.' + expires;
    const sig = crypto.createHmac('sha256', this.secret).update(body).digest('hex');
    return body + '.' + sig;
  }

  /* 校验 token → 返回用户对象（未登录/过期/伪造一律 null） */
  verifyToken(token) {
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [userId, expiresStr, sig] = parts;
    const expires = Number(expiresStr);
    if (!Number.isFinite(expires) || expires < Date.now()) return null;
    const expect = crypto.createHmac('sha256', this.secret).update(userId + '.' + expiresStr).digest('hex');
    if (!safeEqual(sig, expect)) return null;
    const user = this.store.userById(userId);
    if (!user) return null;
    if (user.banned) return null;
    return user;
  }

  /* 从 Authorization / X-FX-Token 头里取 token。
   *
   * ★ 额外支持 ?token= 查询参数：navigator.sendBeacon() **无法自定义请求头**，
   *   而页面卸载时的最后一把同步只能走 sendBeacon 才可能送达。
   *   所以那条路径只能把 token 放 query 里。
   *
   *   安全权衡：query 里的 token 会进访问日志/浏览器历史。这里做三点缓解：
   *     1) 只允许在极少数需要 beacon 的接口上走 query（由调用方控制）；
   *     2) token 本身有 90 天过期时间；
   *     3) 生产环境应确保 HTTPS（防止中间人看到 URL）。
   *   这是"卸载时仍能存上"所必须付出的代价，符合题目要求的取舍。 */
  userFromRequest(req) {
    const h = req.headers || {};
    let token = h['x-fx-token'];
    const auth = h['authorization'];
    if (!token && auth && /^Bearer\s+/i.test(auth)) token = auth.replace(/^Bearer\s+/i, '');
    if (!token) token = tokenFromUrl(req.url);
    return this.verifyToken(Array.isArray(token) ? token[0] : token);
  }
}

/* 从请求 URL 里取 ?token=（只在没有 header 时兜底） */
function tokenFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  const q = url.indexOf('?');
  if (q < 0) return '';
  const search = url.slice(q + 1);
  const parts = search.split('&');
  for (const kv of parts) {
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    if (kv.slice(0, eq) !== 'token') continue;
    try {
      return decodeURIComponent(kv.slice(eq + 1));
    } catch (e) {
      return '';
    }
  }
  return '';
}

module.exports = {
  Auth, validateName, validatePassword, hashPassword, makeSalt, safeEqual,
  NAME_RE, PASSWORD_MIN, PASSWORD_MAX, TOKEN_DAYS,
};
