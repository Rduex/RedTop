/*
 * 数据持久化自检 —— 启动时明确告诉你「数据会不会在下次部署时丢失」。
 *
 * ============================ 为什么需要它 ============================
 *
 * 现状：Railway 的容器文件系统是临时的。只有挂载了持久化卷的目录才会保留。
 * 但代码里 DATA_DIR 只是个路径字符串 —— 它到底在不在卷上，日志看不出来。
 *
 * 于是出现过最坏的情况：玩家以为卷挂好了、服务也正常跑着、注册和存档都成功，
 * 结果下次重新部署时 `data/` 跟着容器一起消失，所有账号和成绩归零，
 * **而日志里一个字都没提**。
 *
 * 这个模块在启动时做四件事：
 *   ① 报告最终生效的数据目录（以及它是怎么来的：环境变量 / 默认值）
 *   ② 真实写入一个探针文件并读回 —— 证明目录可写
 *   ③ 判断这是不是一个"看起来持久化"的位置（容器内挂载点特征）
 *   ④ 不是持久化位置时，**大声警告**，并给出具体怎么修
 *
 * 判据说明（很重要，避免误报）：
 *   本地开发时数据在 D:\delta\fx-online\data —— 这当然是持久的，
 *   不能因为"不在 /app/data"就警告。所以只在**检测到云平台环境**时
 *   才启用"是否挂载"的判断。云平台识别看它注入的环境变量。
 * ==================================================================
 */
'use strict';

const fs = require('fs');
const path = require('path');

/* 云平台特征变量（存在任一即认为在云上） */
const PLATFORM_ENV = [
  ['RAILWAY_ENVIRONMENT', 'Railway'],
  ['RAILWAY_PROJECT_ID', 'Railway'],
  ['RENDER', 'Render'],
  ['RENDER_SERVICE_ID', 'Render'],
  ['HEROKU_APP_NAME', 'Heroku'],
  ['FLY_APP_NAME', 'Fly.io'],
  ['WEBSITE_SITE_NAME', 'Azure'],
  ['K_SERVICE', 'Cloud Run'],
  ['DETA_SPACE_APP', 'Deta'],
  ['VERCEL', 'Vercel'],
];

function detectPlatform() {
  for (const [key, name] of PLATFORM_ENV) {
    if (process.env[key]) return name;
  }
  return null;
}

/*
 * 判断某个目录是否"像一个持久化挂载点"。
 *
 * 这里不做魔法判断 —— Linux 上要准确判断挂载点得读 /proc/mounts，
 * 而容器里那文件通常可读，所以就用它。
 * 读不到时退化为启发式：路径等于平台约定的卷路径则认为持久化。
 */
function isMountPoint(dir) {
  /* 优先：解析 /proc/self/mountinfo，看有没有目标路径的挂载记录 */
  try {
    const raw = fs.readFileSync('/proc/self/mountinfo', 'utf8');
    const target = path.resolve(dir);
    for (const line of raw.split('\n')) {
      if (!line) continue;
      /* 格式：id parent major:minor root mountpoint options ... */
      const parts = line.split(' ');
      const mp = parts[4];
      if (mp && path.resolve(mp) === target) return true;
    }
    return false;
  } catch (e) {
    /* Windows / 受限环境：无法读取，返回 null 表示"判断不了" */
    return null;
  }
}

/*
 * 主检查函数。
 * @param dir       实际使用的数据目录
 * @param opts      { silent } silent=true 时只返回结果不打印
 * @return { ok, level, platform, dir, source, writable, mountPoint, messages[] }
 */
function check(dir, opts) {
  const o = opts || {};
  const platform = detectPlatform();
  const resolved = path.resolve(dir);
  const messages = [];
  let level = 'ok';   // ok | warn | error

  /* ① 数据目录来源 */
  const source = process.env.FX_DATA ? '环境变量 FX_DATA' : '默认值（应用根目录/data）';

  /* ② 可写性：真的写一个探针文件再读回 */
  let writable = false;
  const probe = path.join(resolved, '.fx-write-probe');
  try {
    fs.mkdirSync(resolved, { recursive: true });
    fs.writeFileSync(probe, 'ok', 'utf8');
    const back = fs.readFileSync(probe, 'utf8');
    writable = back === 'ok';
    fs.unlinkSync(probe);
  } catch (e) {
    writable = false;
    messages.push('数据目录不可写：' + e.message);
    level = 'error';
  }

  /* ③ 是否挂载点（只在云平台上有意义） */
  const mountPoint = platform ? isMountPoint(resolved) : null;

  /* ④ 判定 */
  if (platform && writable) {
    if (mountPoint === true) {
      messages.push('数据目录是持久化挂载卷，重新部署不会丢数据');
    } else if (mountPoint === false) {
      level = 'warn';
      messages.push('数据目录【不是】挂载卷！重新部署会把账号与存档一起清空。');
      messages.push('修复：在平台的 Volumes 里把卷挂到这个路径，');
      messages.push('      或把环境变量 FX_DATA 指向已挂载的卷目录。');
    } else {
      /* 判断不了：给出提示而非断言 */
      messages.push('无法确认是否为挂载卷（读不到 /proc/self/mountinfo）。');
      messages.push('请自行确认：' + resolved + ' 是否指向平台的持久化卷。');
    }
  } else if (!platform) {
    messages.push('本地运行：数据保存在本机，重新部署概念不适用。');
  }

  /* ⑤ 现有数据量 */
  let users = 0, scores = 0;
  const dbFile = path.join(resolved, 'fx-online.json');
  try {
    if (fs.existsSync(dbFile)) {
      const db = JSON.parse(fs.readFileSync(dbFile, 'utf8'));
      users = Object.keys(db.users || {}).length;
      scores = (db.scores || []).length;
    }
  } catch (e) { /* 忽略 */ }

  const result = {
    ok: level === 'ok',
    level,
    platform,
    dir: resolved,
    source,
    writable,
    mountPoint,
    dbExists: fs.existsSync(dbFile),
    users,
    scores,
    messages,
  };

  if (!o.silent) print(result);
  return result;
}

/* 打印成易读的启动横幅 */
function print(r) {
  const bar = '  ────────────────────────────────────────────';
  console.log(bar);
  if (r.level === 'error') {
    console.log('  ❌ 数据存储异常');
  } else if (r.level === 'warn') {
    console.log('  ⚠️  数据可能在重新部署时丢失');
  } else {
    console.log('  💾 数据存储正常');
  }
  console.log(bar);
  console.log('  数据目录：' + r.dir);
  console.log('  来源：    ' + r.source);
  console.log('  可写：    ' + (r.writable ? '是' : '否'));
  if (r.platform) {
    console.log('  平台：    ' + r.platform);
    console.log('  挂载卷：  ' + (r.mountPoint === true ? '是 ✅'
      : r.mountPoint === false ? '否 ❌' : '无法判断'));
  } else {
    console.log('  运行环境：本地');
  }
  console.log('  现有数据：' + r.users + ' 个账号 · ' + r.scores + ' 条成绩');
  if (r.messages.length) {
    console.log(bar);
    r.messages.forEach((m) => console.log('  ' + m));
  }
  if (r.level === 'warn') {
    console.log('');
    console.log('  ⚠️  常见原因：平台容器文件系统是临时的，只有挂载卷会保留。');
    console.log('     请在平台控制台确认 Volumes 挂载路径 = 上面的数据目录。');
  }
  console.log(bar);
}

module.exports = { check, print, detectPlatform, isMountPoint, PLATFORM_ENV };
