/*
 * 数据持久化自检的测试。
 *
 * 重点验证：
 *   ① 本地环境不误报（本地数据当然是持久的）
 *   ② 云平台 + 非挂载点 → 必须警告
 *   ③ 云平台 + 可写 → 不崩
 *   ④ 目录不可写时明确报错
 *
 * 运行： node test/storage-check.js
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const SC = require(path.join(ROOT, 'src', 'storage-check.js'));

let pass = 0, fail = 0;
function check(n, c, x) {
  if (c) { pass++; console.log('  OK   ' + n); }
  else { fail++; console.log('  FAIL ' + n + (x !== undefined ? '  -> ' + x : '')); }
}
function section(t) { console.log('\n' + t); }

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-sc-'));
process.on('exit', () => {
  try { fs.rmSync(DIR, { recursive: true, force: true }); } catch (e) {}
});

section('=== ① 本地环境（无平台变量）===');
delete process.env.RAILWAY_ENVIRONMENT;
delete process.env.RENDER;
const localRes = SC.check(DIR, { silent: true });
check('识别为本地环境', localRes.platform === null, localRes.platform);
check('本地不报警告（数据在本机就是持久的）', localRes.level === 'ok', localRes.level);
check('可写检测通过', localRes.writable === true);
check('返回数据目录', localRes.dir === path.resolve(DIR));

section('=== ② 云平台 + 目录可写 ===');
process.env.RAILWAY_ENVIRONMENT = 'production';
const cloudRes = SC.check(DIR, { silent: true });
check('识别出 Railway', cloudRes.platform === 'Railway', cloudRes.platform);
check('可写检测通过', cloudRes.writable === true);
check('mountPoint 有明确取值（true/false/null）',
  cloudRes.mountPoint === true || cloudRes.mountPoint === false || cloudRes.mountPoint === null,
  String(cloudRes.mountPoint));
/* 在 Linux 上能读 /proc，应当明确为 false（临时目录不是挂载点）；
 * 在 Windows 上读不到，返回 null 也算合理。 */
if (process.platform === 'linux') {
  check('★ Linux 上能判断出"非挂载点"', cloudRes.mountPoint === false,
    String(cloudRes.mountPoint));
  check('★ 非挂载点会触发警告', cloudRes.level === 'warn', cloudRes.level);
  check('★ 警告文案提到"重新部署"',
    cloudRes.messages.some((m) => /重新部署|清空/.test(m)),
    JSON.stringify(cloudRes.messages));
}
delete process.env.RAILWAY_ENVIRONMENT;

section('=== ③ 其它平台识别 ===');
const platforms = [
  ['RENDER', 'Render'],
  ['HEROKU_APP_NAME', 'Heroku'],
  ['FLY_APP_NAME', 'Fly.io'],
];
platforms.forEach(([k, name]) => {
  process.env[k] = 'x';
  const r = SC.check(DIR, { silent: true });
  check('识别 ' + name, r.platform === name, r.platform);
  delete process.env[k];
});

section('=== ④ 目录不可写 ===');
/* 用一个不存在的深层路径 + 只读父目录来模拟不可写比较麻烦，
 * 直接用一个文件当作"目录"来触发 mkdir 失败。 */
const fakeDir = path.join(DIR, 'not-a-dir');
fs.writeFileSync(fakeDir, 'x');
const badRes = SC.check(fakeDir, { silent: true });
check('★ 不可写时标记为 error', badRes.level === 'error', badRes.level);
check('★ 不可写时 writable=false', badRes.writable === false);
check('★ 给出了错误说明', badRes.messages.some((m) => /不可写/.test(m)),
  JSON.stringify(badRes.messages));
fs.unlinkSync(fakeDir);

section('=== ⑤ 现有数据统计 ===');
const dbFile = path.join(DIR, 'fx-online.json');
fs.writeFileSync(dbFile, JSON.stringify({
  version: 2, meta: { seq: 0, winKeys: {} },
  users: { a: { id: 'a', name: 'A' }, b: { id: 'b', name: 'B' } },
  scores: [{ id: 's1' }, { id: 's2' }, { id: 's3' }],
}));
const statRes = SC.check(DIR, { silent: true });
check('正确统计账号数', statRes.users === 2, statRes.users);
check('正确统计成绩数', statRes.scores === 3, statRes.scores);
check('标记数据文件存在', statRes.dbExists === true);

section('=== ⑥ 损坏的数据文件不影响自检 ===');
fs.writeFileSync(dbFile, '{ 不是 JSON');
let threw = null;
let corruptRes = null;
try { corruptRes = SC.check(DIR, { silent: true }); } catch (e) { threw = e; }
check('★ 数据文件损坏时自检不抛异常', !threw, threw && threw.message);
check('损坏时账号数按 0 处理', corruptRes && corruptRes.users === 0,
  corruptRes && corruptRes.users);

section('=== ⑦ print 不抛异常 ===');
let printOk = true;
try {
  const origLog = console.log;
  console.log = () => {};
  SC.print(SC.check(DIR, { silent: true }));
  console.log = origLog;
} catch (e) { printOk = false; }
check('print 输出正常', printOk);

console.log('\n' + '='.repeat(52));
console.log('通过 ' + pass + ' 项 · 失败 ' + fail + ' 项');
console.log('='.repeat(52));
process.exit(fail > 0 ? 1 : 0);
