/*
 * 权威复盘验证器 —— **接口预留**，当前未启用。
 *
 * ---------------------------------------------------------------------------
 * 为什么留这个文件：
 * 用户选择的方案是「客户端上报 + 服务端合理性校验」（见 leaderboard.js
 * 顶部对强度边界的诚实说明）。那一层挡不住"时间线自洽的伪造成绩"。
 * 真正能根治的做法只有一条路：让服务端自己把这一局重算一遍。
 *
 * 本文件把这个能力的位置、接口和数据结构先定下来，等游戏侧完成两项改造后
 * 直接打开开关即可，不需要动 server.js / leaderboard.js / 前端：
 *
 *   改造 ①【种子化随机数】
 *     目前行情、事件、情报、卡牌抽取全部直接用 Math.random()（见游戏里
 *     gauss() / maybeStartEvent() / buyIntel() / rollCards() 等十余处）。
 *     只要把它们换成统一的 seeded PRNG（例如以 runSeed 为种子的 mulberry32），
 *     同一份"种子 + 操作序列"就能在 Node 里逐步复现出完全相同的行情。
 *
 *   改造 ②【全量操作上报】
 *     前端把影响结果的操作按顺序记下来：
 *       { tick, action: 'open',  pair, side, margin, lev }
 *       { tick, action: 'close', id }
 *       { tick, action: 'buyAsset',  id, qty }
 *       { tick, action: 'pick', cardId }   // 三选一
 *       { tick, action: 'intel', ... }
 *     连同 tick 数一起提交，服务端按同样顺序灌进无头引擎即可复算。
 *
 * 做完这两步后，verify() 的实现就是把操作回放进引擎、取出它算出的峰值权益，
 * 与上报值比对（误差 > 0.5% 即判定伪造）。
 *
 * ★ 好消息：这个无头复算在 Node 里**已经被验证可行** —— 本项目的工作区里
 *   现存一批测试（fx-equity-test.js / fx-boss-test.js 等）就是靠 jsdom 风格的
 *   DOM 桩把整份游戏的 IIFE 跑在 Node 里，然后直接调用 window.FX 的钩子。
 *   同一个手法可以直接用来做服务端复算，届时前端只负责"报操作"。
 * ---------------------------------------------------------------------------
 */
'use strict';

const crypto = require('crypto');

/* 操作类型白名单：将来真正复盘时，只有这些动作会被接受。
 * 现在先用于"上报体结构"的校验，避免前端发来一堆无法解释的东西。 */
const ACTIONS = {
  open: ['pair', 'side', 'margin', 'lev'],
  close: ['id'],
  closeHalf: ['id'],
  closeAll: [],
  buyAsset: ['id', 'qty'],
  sellAsset: ['id', 'qty'],
  pick: ['cardId'],
  skip: [],
  intel: ['intelId', 'pair', 'dir'],
  plant: ['pair', 'dir'],
  borrow: ['amount'],
  repay: ['amount'],
  topUp: ['id', 'amount'],
  retire: [],
};

class ReplayVerifier {
  constructor(opts) {
    const o = opts || {};
    /* 默认关闭：前端还没上报操作序列，强行校验会把所有真实成绩误判为伪造。 */
    this.enabled = !!o.enabled;
    /* 允许的复算误差：浮点累加 + 取整差异，0.5% 足够宽容又足够严格。 */
    this.tolerance = typeof o.tolerance === 'number' ? o.tolerance : 0.005;
    this.engine = o.engine || null;   // 未来注入的无头引擎 runner
  }

  status() {
    return {
      enabled: this.enabled,
      tolerance: this.tolerance,
      hasEngine: !!this.engine,
      hint: this.enabled
        ? '复盘验证已启用'
        : '复盘验证未启用：当前采用客户端上报 + 服务端合理性校验；本接口已预留，待游戏接入种子化随机数与操作上报后开启',
      actions: Object.keys(ACTIONS),
    };
  }

  /* 校验"操作序列"本身的结构是否合法（类型/字段/单调递增的 tick） */
  validateTrace(trace) {
    if (!Array.isArray(trace)) return { ok: false, error: '操作序列必须是数组' };
    if (trace.length > 20000) return { ok: false, error: '操作条数超出上限' };
    let lastTick = -1;
    for (let i = 0; i < trace.length; i++) {
      const step = trace[i];
      if (!step || typeof step !== 'object') return { ok: false, error: '第 ' + (i + 1) + ' 条操作不是对象' };
      const kind = String(step.action || '');
      if (!ACTIONS[kind]) return { ok: false, error: '第 ' + (i + 1) + ' 条操作类型不认识：' + kind };
      const t = Number(step.tick);
      if (!Number.isFinite(t) || t < 0) return { ok: false, error: '第 ' + (i + 1) + ' 条操作的 tick 非法' };
      if (t < lastTick) return { ok: false, error: '第 ' + (i + 1) + ' 条操作的 tick 倒退' };
      lastTick = t;
    }
    return { ok: true, steps: trace.length };
  }

  /*
   * 主入口。当前实现返回"未启用"，但已经把该做的检查都写好了 ——
   * 这样前端现在就可以开始上报（数据先攒着），将来开启时历史数据也能复用。
   */
  verify(user, payload, store) {
    const p = payload && typeof payload === 'object' ? payload : {};
    const declared = Number(p.declaredScore);

    /* 结构校验始终执行：即使不复算，也能识别出明显畸形的上报体 */
    let traceCheck = { ok: true, steps: 0 };
    if (p.trace !== undefined) {
      traceCheck = this.validateTrace(p.trace);
      if (!traceCheck.ok) {
        return { verified: false, enabled: this.enabled, reason: 'bad_trace', error: traceCheck.error };
      }
    }

    if (!this.enabled || !this.engine) {
      return {
        verified: false,
        enabled: false,
        steps: traceCheck.steps,
        declaredScore: Number.isFinite(declared) ? declared : null,
        reason: 'verifier_disabled',
        note: '复盘验证尚未启用，本次成绩按客户端上报 + 合理性校验处理',
      };
    }

    if (!Number.isFinite(declared)) {
      return { verified: false, enabled: true, reason: 'no_score', error: '缺少 declaredScore' };
    }
    if (!p.seed) {
      return { verified: false, enabled: true, reason: 'no_seed', error: '缺少 runSeed，无法复算' };
    }

    /* ---- 以下为开启后的真实路径（engine 由未来注入） ---- */
    try {
      const result = this.engine.replay({
        seed: String(p.seed),
        startEquity: Number(p.startEquity) || 0,
        trace: p.trace || [],
        expectedTicks: Number(p.tickCount) || 0,
      });
      const diff = Math.abs(result.peakEquity - declared);
      const rel = declared > 0 ? diff / declared : diff;
      const ok = rel <= this.tolerance;
      return {
        verified: ok,
        enabled: true,
        declaredScore: declared,
        serverScore: result.peakEquity,
        tolerance: this.tolerance,
        relDiff: rel,
        steps: traceCheck.steps,
        reason: ok ? 'match' : 'mismatch',
      };
    } catch (e) {
      return { verified: false, enabled: true, reason: 'replay_error', error: e.message };
    }
  }
}

/* 给未来用的种子工具：把任意字符串散列成 32 位整数种子 */
function seedFromString(s) {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  return h.readUInt32BE(0);
}

module.exports = { ReplayVerifier, ACTIONS, seedFromString };
