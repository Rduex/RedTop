/*
 * 验证：secret.key 丢失到底会导致什么后果？
 *
 * 玩家反馈「存档再次消失，怀疑密钥丢失导致」。
 * 这个测试把三种情况分开验证：
 *   ① 密钥保留 → 正常
 *   ② 密钥丢失（重新生成）→ token 失效，但**账号与存档应仍在**
 *   ③ 数据目录整个丢失 → 这才是真正的存档消失
 *
 * 运行： node test/secret-impact.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const SRC = path.resolve(__dirname, '..', 'src');
const { Store } = require(path.join(SRC, 'store.js'));
const { Auth } = require(path.join(SRC, 'auth.js'));

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-secret-'));
const DB = path.join(DIR, 'fx-online.json');
const KEY = path.join(DIR, 'secret.key');

console.log('测试目录：' + DIR);

/* ---------- 第一轮：注册 + 存档 ---------- */
section('=== ① 初始状态：注册并写入存档 ===');
let store = new Store(DB);
let auth = new Auth(store, KEY);

const reg = auth.register('久留美', 'himitsu123');
check('注册成功', reg.ok && !!reg.user, reg.error);
const userId = reg.user.id;
const token = auth.issueToken(userId);

store.saveAccount(userId, 88888.88, [{
  id: 1, pair: 'EUR/USD', side: 'long', margin: 900, lev: 20,
  notional: 18000, entry: 1.085, fee: 2.7, openTs: Date.now(), openTick: 40,
}], Date.now());
check('存档已写入（$88,888.88）', store.accountOf(userId).balance === 88888.88,
  store.accountOf(userId).balance);
check('密钥文件已生成', fs.existsSync(KEY));

/* ---------- 第二轮：正常重启 ---------- */
section('=== ② 正常重启（密钥保留）===');
store = new Store(DB);
auth = new Auth(store, KEY);
check('token 仍然有效', !!auth.verifyToken(token));
check('账号仍在', !!store.userByName('久留美'));
check('存档仍在', store.accountOf(userId).balance === 88888.88,
  store.accountOf(userId).balance);

/* ---------- 第三轮：密钥丢失 ---------- */
section('=== ③ 密钥丢失（被删除后重新生成）===');
fs.unlinkSync(KEY);
console.log('     已删除 secret.key');

store = new Store(DB);
auth = new Auth(store, KEY);

check('★ 账号仍然存在（不受密钥影响）', !!store.userByName('久留美'));
check('★ 存档仍然完整（$88,888.88）',
  store.accountOf(userId).balance === 88888.88,
  store.accountOf(userId).balance);
check('★ 持仓也还在', store.accountOf(userId).positions.length === 1,
  store.accountOf(userId).positions.length);
check('旧 token 已失效（签名对不上）', auth.verifyToken(token) === null);
check('密钥文件被重新生成', fs.existsSync(KEY));

section('=== ④ 用昵称+密码重新登录（密钥丢失后）===');
const relogin = auth.login('久留美', 'himitsu123');
check('★ 密码登录仍然成功', relogin.ok, relogin.error);
if (relogin.ok) {
  const newToken = relogin.token;
  check('新 token 可校验', !!auth.verifyToken(newToken));
  const acc = store.accountOf(relogin.user.id);
  check('★ 登录后存档还在（$88,888.88）', acc.balance === 88888.88, acc.balance);
  check('★ 持仓也在', acc.positions.length === 1);
}

/* ---------- 第五轮：数据文件丢失 ---------- */
section('=== ⑤ 对照：数据文件丢失（真正会丢存档的情况）===');
fs.unlinkSync(DB);
store = new Store(DB);
auth = new Auth(store, KEY);
check('★ 这时账号才真的没了', !store.userByName('久留美'));
check('★ 存档也没了', Object.keys(store.db.users).length === 0);
console.log('     结论：丢的是 **data/fx-online.json**，不是 secret.key');

/* ---------- 结论 ---------- */
console.log('\n' + '='.repeat(60));
console.log('结论');
console.log('='.repeat(60));
console.log('  secret.key 丢失 → 只让**已登录的 token 失效**，');
console.log('                    玩家用昵称+密码重新登录即可，存档完好。');
console.log('');
console.log('  fx-online.json 丢失 → 账号与存档**真的消失**。');
console.log('');
console.log('  所以"存档消失"的真凶是 data/fx-online.json 不见了，');
console.log('  最常见原因：Railway 没挂持久化卷，重新部署清空容器文件系统。');
console.log('='.repeat(60));

console.log('\n通过 ' + pass + ' 项 · 失败 ' + fail + ' 项\n');

try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
process.exit(fail > 0 ? 1 : 0);
