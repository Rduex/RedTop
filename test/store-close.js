/*
 * 退出时落盘语义的回归测试。
 *
 * 背景（真实事故）：store.close() 曾经无条件 `_dirty = true; flush();`，
 * 于是「进程退出」本身就是一次写盘。运维把备份文件盖进数据目录后重启，
 * 新进程启动 → 读到备份 → 一切正常；但只要再来一次重启，旧容器退出时
 * 就把自己内存里的（空的）状态盖回去，备份当场消失。
 *
 * 这里锁死三条语义：
 *   ① 没有改动 → close() 不碰文件（内容、mtime 都不变）
 *   ② 有未落盘的改动 → close() 必须写出去（防抖窗口内的改动不能丢）
 *   ③ 外部改写过的文件 → 只要本进程没改过，close() 不许覆盖
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { Store } = require('../src/store');

let pass = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass++;
    console.log('  ✅ ' + name);
  } else {
    console.log('  ❌ ' + name + (extra ? ' — ' + extra : ''));
    process.exitCode = 1;
  }
}

function tmpDb(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-store-'));
  return path.join(dir, name || 'fx-online.json');
}

/*
 * 造一份"已经归一化"的数据文件。
 *
 * 不能直接手写 JSON 当种子：load() 会对缺字段的老结构做向后兼容迁移
 * （补 balance/positions/lastSyncAt…），迁移后的 `_needsPersist` 会让
 * 进程主动回写一次 —— 那是**正确且必要**的行为，但会干扰"无改动不写盘"
 * 的测量。所以先用 Store 自己写一份规范数据出来，再拿它做种子。
 */
function canonicalFile() {
  const file = tmpDb();
  const s = new Store(file);
  s.mutate((db) => {
    db.users['u-1'] = Object.assign({}, USER);
    db.meta.seq = 1;
  }, { sync: true });
  s.close();
  return file;
}

const USER = {
  id: 'u-1',
  name: '测试玩家',
  nameLower: '测试玩家',
  salt: 'aabb',
  hash: 'ccdd',
  createdAt: 1,
  lastSeen: 1,
  best: 0,
  runs: 0,
  wins: 0,
  banned: false,
  balance: 12345,
  positions: [],
  /* 下面两个字段必须给：_normalize 会检查 lastSyncAt/positions/balance 是否存在，
   * 缺任何一个都会判定"这是老结构"，于是启动时主动回写一次 —— 那是正确行为，
   * 但会让"无改动不写盘"的测量失真。 */
  lastSyncAt: 0,
  lastClientTs: 0,
};

function baseDB() {
  return { version: 2, meta: { seq: 1, winKeys: {} }, users: { 'u-1': USER }, scores: [] };
}

console.log('[1] 没有改动时，close() 不写盘');
{
  const file = canonicalFile();
  const before = fs.readFileSync(file, 'utf8');
  const st1 = fs.statSync(file);

  const s = new Store(file);
  ok('读到了种子账号', !!s.db.users['u-1']);
  s.close();

  const after = fs.readFileSync(file, 'utf8');
  const st2 = fs.statSync(file);
  ok('文件内容未变', before === after);
  ok('mtime 未被刷新（说明根本没写）', st1.mtimeMs === st2.mtimeMs,
    st1.mtimeMs + ' -> ' + st2.mtimeMs);
  ok('没有留下 .tmp 残留', !fs.existsSync(file + '.tmp'));

  /* 关键：磁盘上仍然是完整的一份数据，没有被改成空库 */
  const disk = JSON.parse(after);
  ok('磁盘上账号还在', !!disk.users['u-1']);
}

console.log('[2] 有改动时，close() 必须落盘');
{
  const file = canonicalFile();
  const s = new Store(file);
  /* 走防抖分支（不带 sync），模拟"120ms 窗口内进程退出" */
  s.mutate((db) => {
    db.users['u-2'] = Object.assign({}, USER, { id: 'u-2', name: '新玩家', nameLower: '新玩家' });
  });
  s.close();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('新账号被写下去了', !!disk.users['u-2']);
  ok('老账号没丢', !!disk.users['u-1']);
}

console.log('[3] 外部改写文件后，无改动的 close() 不得覆盖');
{
  const file = canonicalFile();
  const s = new Store(file);

  /* 模拟运维在进程运行期间替换了数据文件（恢复备份 / 手工修库） */
  const external = {
    version: 2,
    meta: { seq: 9, winKeys: {} },
    users: { 'u-9': Object.assign({}, USER, { id: 'u-9', name: '恢复账号', nameLower: '恢复账号' }) },
    scores: [],
  };
  fs.writeFileSync(file, JSON.stringify(external), 'utf8');

  s.close();
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('外部写入的内容被保留', !!disk.users['u-9']);
  ok('内存里的旧账号没有被写回磁盘', !disk.users['u-1']);
}

console.log('[4] 空路径/首次启动也不炸');
{
  const file = tmpDb('never-existed.json');
  const s = new Store(file);
  ok('首次启动是空库', Object.keys(s.db.users).length === 0);
  s.close();
  ok('无改动时不创建文件', !fs.existsSync(file));
}

console.log('\n' + (process.exitCode ? '❌ 有断言失败' : '✅ 全部通过') + ' · ' + pass + ' 条断言');
