/*
 * Canvas 主题覆盖 —— 让 K 线图符合交易终端视觉规范。
 *
 * ============================ 为什么需要这一层 ============================
 *
 * 游戏的 K 线是用 Canvas 手绘的，颜色**硬编码在绘制函数里**：
 *     网格  '#1d4a43'   轴文字 '#9ed3c7'
 *     涨    '#43b581'   跌     '#e0756e'
 *     当前价线 '#e9c552' 持仓线 '#5fa8f5' / '#f08a86'
 *
 * 这些值没法用 CSS 改。而改游戏源码又违背"不动游戏"的约束。
 *
 * 所以这里做**Canvas 上下文染色**：在游戏初始化前包住
 * HTMLCanvasElement.prototype.getContext，返回一个 Proxy，
 * 把游戏写入的这些旧颜色在 strokeStyle/fillStyle 赋值时替换成新主题色。
 *
 * 优点：
 *   - 游戏源码零改动
 *   - 只影响颜色，不影响任何绘制几何
 *   - 找不到映射的颜色原样放行，不会误伤
 * 代价：
 *   - 依赖旧颜色字面量。若将来游戏改了配色，映射会失效（但不会崩）
 *     —— 所以映射表里每个旧值都写了注释，便于对照维护。
 * =====================================================================
 */
(function (root) {
  'use strict';

  /*
   * 颜色映射表：旧值 → 新值（大小写不敏感，统一小写比对）
   *
   * ★ 涨跌颜色必须与 CSS 的 --fx-up / --fx-down 保持一致，
   *   否则会出现"界面红涨、K 线绿涨"的自相矛盾 —— 这是很致命的体验问题。
   *   所以提供两套调色板，按市场习惯选择：
   *     east  = 红涨绿跌（中国大陆 / 日 / 韩 / 台，**默认**）
   *     intl  = 绿涨红跌（欧美，TradingView 默认）
   *
   * 其余颜色依据主流交易终端：
   *   - 网格用极低对比的中性灰蓝，不抢蜡烛的视觉重心
   *   - 当前价线用品牌蓝（原本是黄），因为黄色在深底上像警告色
   */
  var PALETTES = {
    /* 东亚习惯：红涨绿跌 */
    east: {
      '#43b581': '#ef4444',                 // 涨（旧绿）→ 红
      '#e0756e': '#22c55e',                 // 跌（旧红）→ 绿
      '#3f9e6d': 'rgba(239,68,68,.92)',     // 事件角标-急拉 → 红
      '#5fa8f5': '#ef4444',                 // 多头持仓线 → 红
      '#f08a86': '#22c55e',                 // 空头持仓线 → 绿
      '#2f6fb5': '#b91c1c',                 // 多头标签底
      '#b5534f': '#15803d',                 // 空头标签底
    },
    /* 国际习惯：绿涨红跌 */
    intl: {
      '#43b581': '#22c55e',
      '#e0756e': '#ef4444',
      '#3f9e6d': 'rgba(34,197,94,.92)',
      '#5fa8f5': '#60a5fa',
      '#f08a86': '#fb7185',
      '#2f6fb5': '#1d4ed8',
      '#b5534f': '#b91c1c',
    },
  };

  /* 两套共用的图表底色系映射 */
  var BASE = {
    '#0f312c': '#0b1220',      // 原图表底色（墨绿）→ 终端深蓝黑
    '#0d2a26': '#0a1018',      // 变体
    '#1d4a43': 'rgba(148,163,184,.085)',   // 网格线 → 极淡中性
    '#9ed3c7': '#7d8ca3',      // 轴文字（薄荷）→ 中性灰蓝
    '#20302a': '#0a1018',      // 当前价标签上的深色文字 → 保持深色
    '#e9c552': '#4f8cff',      // 当前价线/标签（旧黄）→ 品牌蓝
    '#fff': '#ffffff',
    '#ffffff': '#ffffff',
  };

  /* 当前生效的映射表 */
  var MAP = {};

  function rebuildMap(palette) {
    MAP = {};
    var k;
    for (k in BASE) if (Object.prototype.hasOwnProperty.call(BASE, k)) MAP[k] = BASE[k];
    var p = PALETTES[palette] || PALETTES.east;
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k)) MAP[k] = p[k];
  }

  /* 默认东亚习惯；html[data-market="intl"] 可切国际惯例 */
  function detectPalette() {
    try {
      var h = (typeof document !== 'undefined') ? document.documentElement : null;
      if (h && h.getAttribute && h.getAttribute('data-market') === 'intl') return 'intl';
    } catch (e) { /* 忽略 */ }
    return 'east';
  }
  rebuildMap(detectPalette());

  /* 运行时切换（调试/设置用）。切了之后下次重绘就生效。 */
  function setPalette(name) {
    if (!PALETTES[name]) return false;
    rebuildMap(name);
    try {
      var h = (typeof document !== 'undefined') ? document.documentElement : null;
      if (h && h.setAttribute) h.setAttribute('data-market', name);
    } catch (e) { /* 忽略 */ }
    return true;
  }

  /* 常用 canvas 属性里可能被写入颜色的 */
  var COLOR_PROPS = { strokeStyle: 1, fillStyle: 1, shadowColor: 1 };

  function norm(v) {
    if (typeof v !== 'string') return null;
    var s = v.trim().toLowerCase();
    /* 去掉空白差异，例如 'rgb(1, 2, 3)' / 'rgb(1,2,3)' */
    s = s.replace(/\s+/g, '');
    return s;
  }

  /* 把 rgb()/rgba() 也映射一下（有些路径用函数形式） */
  function mapColor(v) {
    var n = norm(v);
    if (!n) return null;
    if (Object.prototype.hasOwnProperty.call(MAP, n)) return MAP[n];
    return null;
  }

  function makeStyled(ctx) {
    /* 用 Proxy 拦截属性赋值。
     * 只拦颜色属性，其余一律原样透传到真实 ctx，保证行为完全一致。 */
    return new Proxy(ctx, {
      set: function (target, prop, value) {
        if (COLOR_PROPS[prop] && typeof value === 'string') {
          var mapped = mapColor(value);
          if (mapped) {
            target[prop] = mapped;
            return true;
          }
        }
        target[prop] = value;
        return true;
      },
      get: function (target, prop) {
        var v = target[prop];
        /* 方法要绑定回真实 ctx，否则内部 this 会指向 Proxy 导致报错 */
        if (typeof v === 'function') {
          return function () {
            return v.apply(target, arguments);
          };
        }
        return v;
      },
    });
  }

  function install() {
    if (typeof HTMLCanvasElement === 'undefined') return false;
    var proto = HTMLCanvasElement.prototype;
    if (!proto || proto.__fxThemed) return false;

    var orig = proto.getContext;
    if (typeof orig !== 'function') return false;

    /* ★ 缓存要挂在**这个 canvas 实例**上，而不是 ctx 上。
     *   早先把标记打在 ctx 上，导致"同一 canvas 多次 getContext"时
     *   每次都会新建 Proxy，实例相等性丢失（测试里抓到的）。
     *   改用 WeakMap 以 canvas 为键，保证同一 canvas 永远拿到同一个 Proxy。
     *   WeakMap 不阻止 canvas 被回收。 */
    var cache = new WeakMap();

    proto.getContext = function () {
      var ctx = orig.apply(this, arguments);
      if (!ctx) return ctx;
      var cached = cache.get(this);
      if (cached) return cached;
      var wrapped = makeStyled(ctx);
      cache.set(this, wrapped);
      return wrapped;
    };

    proto.__fxThemed = true;
    return true;
  }

  /* 暴露给测试与调试 */
  var api = {
    install: install,
    mapColor: mapColor,
    setPalette: setPalette,
    PALETTES: PALETTES,
    get MAP() { return MAP; },
    COLOR_PROPS: COLOR_PROPS,
    _makeStyled: makeStyled,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FXCanvasTheme = api;

  /* 立即安装（脚本在游戏之前执行，所以要尽早接管 getContext） */
  install();
})(typeof globalThis !== 'undefined' ? globalThis : this);
