/*
 * 追加保证金（手动追保）—— 以「注入模块」实现，**不改游戏本体**。
 *
 * ============================ 为什么要单独做这个 ============================
 *
 * 游戏本体里其实有两种追保入口：
 *   ① 持仓卡上的「＋追保 $X」—— 但**只在危险度 ≥ 0.55 时才渲染**（MC_SHOW_RATIO）；
 *   ② 一键追到安全 topUpSafe() —— 由①那个按钮触发。
 *
 * 于是玩家实际能做的只有一件事：等仓位已经快爆了，点一下"自动补到安全"。
 * 想**主动**补一笔钱（比如刚开仓就想把强平价推远、或者只想补 200 块），
 * 界面上没有任何入口 —— 这就是"缺少追加保证金功能"的真正含义。
 *
 * 本模块补上的是「手动、按金额」的那条路径：
 *   · 每张持仓卡上常驻一个「＋ 追加保证金」按钮（不看危险度，随时可点）
 *   · 弹窗里可以自己填金额，也可以点 25% / 50% / 全部可用 / 补到安全
 *   · 实时预览追加后的 保证金 / 强平价 / 危险度（点之前就知道会发生什么）
 *
 * ============================ 为什么不改游戏本体 ============================
 *
 * 游戏本体（仓库根目录 `FX_game.html`）是**按字节保真的原始单文件**。
 * 它同时是 Toy 版、离线版、历史对照的唯一源头，改一次等于让所有产物失去基准。
 * 所以新增能力一律走"注入 + 复用已导出的 API"：
 *
 *   账目计算  → FX.topUpPosition(id, amount)   （本体实现，含日志与提示）
 *   强平价    → FX.liqPriceOf(p)               （统一口径，绝不自己重算）
 *   危险度    → FX.dangerRatio(p)
 *   需补金额  → FX.topUpNeed(p)
 *   可用余额  → FX.available()
 *
 * ★ 预览也**直接调用本体函数**（传一个 margin 加大后的浅拷贝），而不是在这里
 *   复制一套公式。复制公式的下场是：哪天本体改了强平口径，弹窗里的预览
 *   还是旧数字 —— 玩家看到"补完了强平价却没变"，比没有这个功能更糟。
 *
 * ============================ 注入点为什么用 MutationObserver ============================
 *
 * renderPositions() 每次都 `el.positions.innerHTML = ...` 整体重建，
 * 我们插进去的节点会被下一次渲染抹掉。而内部调用走的是闭包里的 renderAll，
 * 不经过 window.FX，没法简单包一层。所以用 MutationObserver 盯着 #positions，
 * 每次重绘后把自己的按钮补回去（幂等：已经有了就跳过）。
 */
(function () {
  'use strict';

  if (window.FXMargin) return;

  var VERSION = 1;

  /* ---------------------------------------------------------------- 样式 */
  var CSS = [
    '/* ---- 追加保证金（注入模块自带样式，不污染主题文件） ---- */',
    '.fx-margin-row {',
    '  display: flex; align-items: center; gap: 8px;',
    '  margin-top: 8px; padding-top: 8px;',
    '  border-top: 1px dashed var(--fx-line, rgba(148,163,184,.14));',
    '  flex-wrap: wrap;',
    '}',
    '.fx-margin-open {',
    '  flex: 0 0 auto;',
    '  appearance: none; -webkit-appearance: none;',
    '  font: inherit; font-size: 12px; line-height: 1;',
    '  padding: 7px 10px; border-radius: var(--fx-r-sm, 8px);',
    '  border: 1px solid var(--fx-line-strong, rgba(148,163,184,.26));',
    '  background: var(--fx-surface-3, #1f2b40);',
    '  color: var(--fx-text, #e8edf5);',
    '  cursor: pointer; transition: border-color .15s, background .15s, color .15s;',
    '}',
    '.fx-margin-open:hover {',
    '  border-color: var(--fx-accent, #4f8cff);',
    '  color: var(--fx-accent, #4f8cff);',
    '  background: var(--fx-accent-dim, rgba(79,140,255,.14));',
    '}',
    '.fx-margin-open:active { transform: translateY(1px); }',
    '.fx-margin-hint {',
    '  font-size: 11.5px; color: var(--fx-text-3, #64748b);',
    '  font-variant-numeric: tabular-nums;',
    '}',
    '.fx-margin-hint.warn { color: var(--fx-gold, #e0b44c); }',
    '.fx-margin-hint.bad { color: var(--fx-up, #ef4444); font-weight: 600; }',

    '/* ---- 弹窗 ---- */',
    '.fx-mrg[hidden] { display: none !important; }',
    '.fx-mrg {',
    '  position: fixed; inset: 0; z-index: 70;',
    '  display: flex; align-items: center; justify-content: center;',
    '  padding: 16px;',
    '}',
    '.fx-mrg__mask {',
    '  position: absolute; inset: 0;',
    '  background: rgba(4, 7, 12, .66);',
    '  -webkit-backdrop-filter: blur(3px); backdrop-filter: blur(3px);',
    '}',
    '.fx-mrg__panel {',
    '  position: relative; width: 100%; max-width: 420px;',
    '  max-height: calc(100vh - 32px); overflow-y: auto;',
    '  background: var(--fx-surface, #121926);',
    '  border: 1px solid var(--fx-line-strong, rgba(148,163,184,.26));',
    '  border-radius: var(--fx-r-lg, 16px);',
    '  box-shadow: var(--fx-shadow, 0 8px 24px rgba(0,0,0,.45));',
    '  padding: 18px 18px 16px;',
    '  color: var(--fx-text, #e8edf5);',
    '  animation: fx-mrg-in .16s ease-out;',
    '}',
    '@keyframes fx-mrg-in { from { opacity: 0; transform: translateY(6px) scale(.99); }',
    '  to { opacity: 1; transform: none; } }',
    '@media (prefers-reduced-motion: reduce) { .fx-mrg__panel { animation: none; } }',
    '.fx-mrg__head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }',
    '.fx-mrg__head h3 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: .2px; }',
    '.fx-mrg__x {',
    '  appearance: none; border: 0; background: transparent; cursor: pointer;',
    '  color: var(--fx-text-2, #9aa8bd); font-size: 22px; line-height: 1;',
    '  padding: 2px 6px; border-radius: 8px;',
    '}',
    '.fx-mrg__x:hover { color: var(--fx-text, #e8edf5); background: var(--fx-surface-2, #182234); }',
    '.fx-mrg__meta { margin-top: 6px; font-size: 12.5px; color: var(--fx-text-2, #9aa8bd); }',
    '.fx-mrg__meta b { color: var(--fx-text, #e8edf5); font-weight: 600; }',
    '.fx-mrg__side.long { color: var(--fx-up, #ef4444); }',
    '.fx-mrg__side.short { color: var(--fx-down, #22c55e); }',
    '.fx-mrg__stats {',
    '  display: grid; grid-template-columns: 1fr 1fr; gap: 8px 12px;',
    '  margin: 14px 0 4px; padding: 12px;',
    '  background: var(--fx-bg-2, #0e131f);',
    '  border: 1px solid var(--fx-line, rgba(148,163,184,.14));',
    '  border-radius: var(--fx-r-md, 12px);',
    '}',
    '.fx-mrg__stats > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }',
    '.fx-mrg__stats span { font-size: 11px; color: var(--fx-text-3, #64748b); }',
    '.fx-mrg__stats b { font-size: 14px; font-variant-numeric: tabular-nums; font-weight: 600; }',
    '.fx-mrg__label {',
    '  display: flex; align-items: baseline; justify-content: space-between;',
    '  margin: 14px 0 6px; font-size: 12.5px; color: var(--fx-text-2, #9aa8bd);',
    '}',
    '.fx-mrg__label span { font-size: 11px; color: var(--fx-text-3, #64748b); }',
    '.fx-mrg__input {',
    '  width: 100%; box-sizing: border-box;',
    '  font: inherit; font-size: 18px; font-variant-numeric: tabular-nums;',
    '  padding: 11px 13px; border-radius: var(--fx-r-md, 12px);',
    '  background: var(--fx-bg-2, #0e131f);',
    '  border: 1px solid var(--fx-line-strong, rgba(148,163,184,.26));',
    '  color: var(--fx-text, #e8edf5);',
    '  outline: none;',
    '}',
    '.fx-mrg__input:focus { border-color: var(--fx-accent, #4f8cff);',
    '  box-shadow: 0 0 0 3px var(--fx-accent-dim, rgba(79,140,255,.14)); }',
    '/* 去掉数字输入框原生的上下箭头：它跟这套深色圆角控件不搭，',
    ' * 且手机端本来就走数字键盘。步进靠下面的快捷档位。 */',
    '.fx-mrg__input::-webkit-outer-spin-button,',
    '.fx-mrg__input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }',
    '.fx-mrg__input { -moz-appearance: textfield; appearance: textfield; }',
    '.fx-mrg__chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }',
    '.fx-mrg__chip {',
    '  appearance: none; font: inherit; font-size: 12px; line-height: 1;',
    '  padding: 7px 10px; cursor: pointer;',
    '  border-radius: 999px;',
    '  border: 1px solid var(--fx-line-strong, rgba(148,163,184,.26));',
    '  background: transparent; color: var(--fx-text-2, #9aa8bd);',
    '}',
    '.fx-mrg__chip:hover { border-color: var(--fx-accent, #4f8cff); color: var(--fx-accent, #4f8cff); }',
    '.fx-mrg__chip[disabled] { opacity: .45; cursor: not-allowed; }',
    '.fx-mrg__preview {',
    '  margin-top: 12px; padding: 10px 12px; min-height: 18px;',
    '  font-size: 12.5px; line-height: 1.65; color: var(--fx-text-2, #9aa8bd);',
    '  background: var(--fx-surface-2, #182234);',
    '  border-radius: var(--fx-r-sm, 8px);',
    '  font-variant-numeric: tabular-nums;',
    '}',
    '.fx-mrg__preview b { color: var(--fx-text, #e8edf5); font-weight: 600; }',
    '.fx-mrg__preview .fx-mrg-up { color: var(--fx-down, #22c55e); }',
    '.fx-mrg__err {',
    '  margin-top: 10px; padding: 8px 10px; border-radius: var(--fx-r-sm, 8px);',
    '  font-size: 12.5px; line-height: 1.5;',
    '  color: var(--fx-up, #ef4444);',
    '  background: var(--fx-up-dim, rgba(239,68,68,.14));',
    '}',
    '.fx-mrg__err[hidden] { display: none !important; }',
    '.fx-mrg__actions { display: flex; gap: 10px; margin-top: 16px; }',
    '.fx-mrg__actions button {',
    '  flex: 1; appearance: none; font: inherit; font-size: 14px; font-weight: 600;',
    '  padding: 12px 14px; border-radius: var(--fx-r-md, 12px); cursor: pointer;',
    '  border: 1px solid transparent;',
    '}',
    '.fx-mrg__cancel {',
    '  background: transparent; color: var(--fx-text-2, #9aa8bd);',
    '  border-color: var(--fx-line-strong, rgba(148,163,184,.26)) !important;',
    '}',
    '.fx-mrg__cancel:hover { color: var(--fx-text, #e8edf5); background: var(--fx-surface-2, #182234); }',
    '.fx-mrg__ok {',
    '  background: var(--fx-accent, #4f8cff); color: #fff;',
    '}',
    '.fx-mrg__ok:hover { filter: brightness(1.08); }',
    '.fx-mrg__ok[disabled] { opacity: .45; cursor: not-allowed; filter: none; }',
  ].join('\n');

  /* ---------------------------------------------------------------- 工具 */
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  function money(n) {
    var v = Number(n) || 0;
    var s = Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '-$' : '$') + s;
  }

  function pct(n) { return (Math.round((Number(n) || 0) * 1000) / 10) + '%'; }

  /* 价格按该货币对的小数位显示（用本体导出的 digitDigits，别自己猜） */
  function priceOf(pair, v) {
    var d = 5;
    try { d = FX.digitDigits(pair); } catch (e) { /* 兜底 5 位 */ }
    return Number(v).toFixed(d);
  }

  function injectStyle() {
    if (document.getElementById('fx-margin-style')) return;
    var st = document.createElement('style');
    st.id = 'fx-margin-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  /* ---------------------------------------------------------------- 账目 */
  function posById(id) {
    var list = (window.FX && FX.state && FX.state.positions) || [];
    for (var i = 0; i < list.length; i++) if (list[i].id === Number(id)) return list[i];
    return null;
  }

  /* 预览：给本体函数传一个"保证金已加大"的浅拷贝，口径天然一致 */
  function plan(id, amount) {
    if (!window.FX) return null;
    var p = posById(id);
    if (!p) return null;
    var add = Math.max(0, round2(amount));
    var after = {};
    for (var k in p) if (Object.prototype.hasOwnProperty.call(p, k)) after[k] = p[k];
    after.margin = round2(p.margin + add);

    var need = 0;
    try { need = Math.max(0, round2(FX.topUpNeed(p))); } catch (e) { need = 0; }

    return {
      id: p.id,
      pair: p.pair,
      side: p.side,
      lev: p.lev,
      amount: add,
      marginBefore: p.margin,
      marginAfter: after.margin,
      liqBefore: FX.liqPriceOf(p),
      liqAfter: FX.liqPriceOf(after),
      dangerBefore: FX.dangerRatio(p),
      dangerAfter: FX.dangerRatio(after),
      available: FX.available(),
      need: need,
    };
  }

  /* ---------------------------------------------------------------- 卡片按钮 */
  var ROW_CLASS = 'fx-margin-row';

  function injectRows() {
    var box = document.getElementById('positions');
    if (!box) return;
    var cards = box.children || [];
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (!card || !card.classList || !card.classList.contains('pos')) continue;
      if (card.querySelector('.' + ROW_CLASS)) continue;      // 幂等：已经有了
      var btn = card.querySelector('.pos-actions [data-close]');
      if (!btn) continue;                                     // 结构不认识就别乱插
      var id = btn.getAttribute('data-close');
      var p = posById(id);
      if (!p) continue;

      var danger = 1;
      try { danger = FX.dangerRatio(p); } catch (e) { danger = 0; }

      var row = el('div', ROW_CLASS);
      var open = el('button', 'fx-margin-open', '＋ 追加保证金');
      open.type = 'button';
      open.setAttribute('data-fx-margin', String(id));
      open.setAttribute('title', '手动补一笔保证金，把强平价推远');
      var hint = el('span', 'fx-margin-hint',
        '危险度 ' + pct(danger) + (danger >= 1 ? ' · 已触强平线' : ''));
      if (danger >= 1) hint.className += ' bad';
      else if (danger >= 0.55) hint.className += ' warn';
      row.appendChild(open);
      row.appendChild(hint);
      card.appendChild(row);
    }
  }

  var pending = false;
  function scheduleInject() {
    if (pending) return;
    pending = true;
    var run = function () { pending = false; injectRows(); };
    if (window.requestAnimationFrame) requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  /* ---------------------------------------------------------------- 弹窗 */
  var ui = null;          // 缓存引用（构造一次）
  var currentId = null;

  function buildDialog() {
    if (ui) return ui;
    injectStyle();

    var wrap = el('div', 'fx-mrg');
    wrap.id = 'fx-margin-dialog';
    wrap.hidden = true;

    var mask = el('div', 'fx-mrg__mask');
    mask.setAttribute('data-mrg-close', '1');

    var panel = el('div', 'fx-mrg__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-modal', 'true');
    panel.setAttribute('aria-labelledby', 'fx-mrg-title');

    var head = el('div', 'fx-mrg__head');
    var title = el('h3', null, '追加保证金');
    title.id = 'fx-mrg-title';
    var x = el('button', 'fx-mrg__x', '×');
    x.type = 'button';
    x.setAttribute('data-mrg-close', '1');
    x.setAttribute('aria-label', '关闭');
    head.appendChild(title);
    head.appendChild(x);

    var meta = el('div', 'fx-mrg__meta');
    meta.id = 'fx-mrg-meta';

    var stats = el('div', 'fx-mrg__stats');
    function stat(label, key) {
      var d = el('div');
      d.appendChild(el('span', null, label));
      var b = el('b', null, '—');
      b.id = 'fx-mrg-stat-' + key;
      d.appendChild(b);
      stats.appendChild(d);
      return b;
    }
    var sMargin = stat('当前保证金', 'margin');
    var sLiq = stat('强平价', 'liq');
    var sDanger = stat('危险度', 'danger');
    var sAvail = stat('可用余额', 'avail');

    var label = el('label', 'fx-mrg__label', '追加金额');
    label.setAttribute('for', 'fx-mrg-amount');
    label.appendChild(el('span', null, 'USD'));

    var input = document.createElement('input');
    input.className = 'fx-mrg__input';
    input.id = 'fx-mrg-amount';
    input.type = 'number';
    input.inputMode = 'decimal';
    input.step = '100';
    input.min = '1';
    input.autocomplete = 'off';
    input.placeholder = '填一个大于 0 的金额';

    var chips = el('div', 'fx-mrg__chips');
    var chipSpecs = [
      ['25', '25% 可用'],
      ['50', '50% 可用'],
      ['100', '全部可用'],
      ['need', '补到安全'],
    ];
    var chipBtns = {};
    chipSpecs.forEach(function (spec) {
      var b = el('button', 'fx-mrg__chip', spec[1]);
      b.type = 'button';
      b.setAttribute('data-mrg-chip', spec[0]);
      chips.appendChild(b);
      chipBtns[spec[0]] = b;
    });

    var preview = el('div', 'fx-mrg__preview');
    preview.id = 'fx-mrg-preview';
    var err = el('div', 'fx-mrg__err');
    err.id = 'fx-mrg-err';
    err.hidden = true;

    var actions = el('div', 'fx-mrg__actions');
    var cancel = el('button', 'fx-mrg__cancel', '取消');
    cancel.type = 'button';
    cancel.setAttribute('data-mrg-close', '1');
    var ok = el('button', 'fx-mrg__ok', '确认追加');
    ok.type = 'button';
    ok.id = 'fx-mrg-ok';
    actions.appendChild(cancel);
    actions.appendChild(ok);

    panel.appendChild(head);
    panel.appendChild(meta);
    panel.appendChild(stats);
    panel.appendChild(label);
    panel.appendChild(input);
    panel.appendChild(chips);
    panel.appendChild(preview);
    panel.appendChild(err);
    panel.appendChild(actions);
    wrap.appendChild(mask);
    wrap.appendChild(panel);
    document.body.appendChild(wrap);

    ui = {
      wrap: wrap, panel: panel, meta: meta, input: input, preview: preview, err: err,
      ok: ok, chips: chipBtns,
      sMargin: sMargin, sLiq: sLiq, sDanger: sDanger, sAvail: sAvail,
    };
    return ui;
  }

  function showErr(msg) {
    if (!ui) return;
    if (!msg) { ui.err.hidden = true; ui.err.textContent = ''; return; }
    ui.err.hidden = false;
    ui.err.textContent = msg;
  }

  /* 弹窗开着的时候行情还在跑（K 线每 1.5 秒推进），危险度会变。
   * 这里只刷新"数字区"和预览，**绝不动输入框里的值** —— 玩家正在打字的
   * 时候把 200 改成别的，是最容易让人炸毛的一种"贴心"。 */
  function refreshLive() {
    if (!ui || ui.wrap.hidden || currentId == null) return;
    var p = posById(currentId);
    if (!p) { close(); return; }            // 仓位在弹窗开着时被平掉/强平了
    var info = plan(currentId, 0);
    if (!info) { close(); return; }
    ui.sMargin.textContent = money(info.marginBefore);
    ui.sLiq.textContent = priceOf(p.pair, info.liqBefore);
    ui.sDanger.textContent = pct(info.dangerBefore);
    ui.sAvail.textContent = money(info.available);
    renderPreview();
  }

  /* 把当前金额下的预览画出来（含"能不能点确认"的判定） */
  function renderPreview() {
    if (!ui || currentId == null) return;
    var raw = ui.input.value;
    var amount = round2(raw === '' ? 0 : Number(raw));
    var info = plan(currentId, amount);
    if (!info) {
      showErr('这笔仓位已经不存在了（可能刚被平掉）');
      ui.ok.disabled = true;
      ui.preview.textContent = '';
      return;
    }

    var avail = info.available;
    var over = amount > avail + 1e-9;
    var liqDir = info.side === 'long'
      ? (info.liqAfter < info.liqBefore ? '下移' : '上移')
      : (info.liqAfter > info.liqBefore ? '上移' : '下移');

    if (!(amount > 0)) {
      ui.preview.innerHTML = '填入金额后可预览：追加会让<b>保证金变大、强平价被推远</b>，' +
        '账户权益不变（那笔钱本来就在你账上，只是被仓位占用）。';
    } else {
      ui.preview.innerHTML =
        '追加后保证金 <b>' + money(info.marginBefore) + ' → ' + money(info.marginAfter) + '</b><br>' +
        '强平价 <b>' + priceOf(info.pair, info.liqBefore) + ' → ' + priceOf(info.pair, info.liqAfter) +
        '</b>（' + liqDir + '，离现价更远）<br>' +
        '危险度 <b>' + pct(info.dangerBefore) + ' → ' + pct(info.dangerAfter) + '</b>' +
        '，剩余可用 <b>' + money(Math.max(0, avail - amount)) + '</b>';
    }

    if (over) showErr('可用余额只有 ' + money(avail) + '，不够追加 ' + money(amount) +
      '（还差 ' + money(round2(amount - avail)) + '）');
    else showErr('');

    ui.ok.disabled = !(amount > 0) || over;
    ui.ok.textContent = amount > 0 ? '确认追加 ' + money(amount) : '确认追加';

    /* 快捷档位：补到安全只在真有浮亏且需要补时可用 */
    var needBtn = ui.chips.need;
    if (needBtn) {
      var canNeed = info.need > 0;
      needBtn.disabled = !canNeed;
      needBtn.textContent = canNeed ? '补到安全 ' + money(info.need) : '补到安全（暂不需要）';
    }
    ui.chips['100'].disabled = !(avail > 0);
    ui.chips['50'].disabled = !(avail > 0);
    ui.chips['25'].disabled = !(avail > 0);
  }

  function open(id) {
    buildDialog();
    var p = posById(id);
    if (!p) return false;
    currentId = Number(id);
    var info = plan(currentId, 0);
    if (!info) return false;

    ui.meta.innerHTML =
      '<span class="fx-mrg__side ' + (p.side === 'long' ? 'long' : 'short') + '">' +
      (p.side === 'long' ? '做多' : '做空') + '</span> <b>' + p.pair + '</b> · ' +
      p.lev + 'x · 名义 ' + money(p.notional) + ' · 入场 ' + priceOf(p.pair, p.entry);

    ui.sMargin.textContent = money(info.marginBefore);
    ui.sLiq.textContent = priceOf(p.pair, info.liqBefore);
    ui.sDanger.textContent = pct(info.dangerBefore);
    ui.sAvail.textContent = money(info.available);

    /* 默认填"补到安全"的金额；不需要补就填可用余额的 10%，减少一次输入 */
    var preset = info.need > 0 ? info.need
      : (info.available > 0 ? round2(info.available * 0.1) : 0);
    ui.input.value = preset > 0 ? String(preset) : '';

    showErr('');
    renderPreview();
    ui.wrap.hidden = false;
    try { ui.input.focus(); ui.input.select(); } catch (e) { /* 忽略 */ }

    /* 开着窗的时候让数字跟上行情（同样只改数字，不动输入框） */
    if (!ui._timer && typeof window.setInterval === 'function') {
      ui._timer = window.setInterval(refreshLive, 1200);
    }
    return true;
  }

  function close() {
    if (!ui) return;
    if (ui._timer) {
      if (typeof window.clearInterval === 'function') window.clearInterval(ui._timer);
      ui._timer = 0;
    }
    ui.wrap.hidden = true;
    currentId = null;
    showErr('');
  }

  function apply(amount) {
    if (currentId == null) return 0;
    var info = plan(currentId, amount);
    if (!info) { close(); return 0; }
    /* 本体负责校验与提示（余额不足/金额非法都由 toast 说明），
     * 这里只在成功后关窗；失败就保留弹窗让玩家改数字。 */
    var applied = FX.topUpPosition(currentId, amount);
    if (applied > 0) close();
    else renderPreview();
    return applied;
  }

  /* ---------------------------------------------------------------- 事件 */
  function bind() {
    /* 卡片按钮：委托到 document，避免每次重绘都要重绑 */
    document.addEventListener('click', function (e) {
      var t = e.target;
      if (!t || !t.closest) return;

      var opener = t.closest('[data-fx-margin]');
      if (opener) {
        e.preventDefault();
        open(opener.getAttribute('data-fx-margin'));
        return;
      }
      if (!ui || ui.wrap.hidden) return;
      if (t.closest('[data-mrg-close]')) { e.preventDefault(); close(); }
    }, false);

    document.addEventListener('click', function (e) {
      if (!ui || ui.wrap.hidden) return;
      var t = e.target;
      if (!t || !t.closest || !ui.wrap.contains(t)) return;

      if (t.id === 'fx-mrg-ok') { e.preventDefault(); apply(ui.input.value === '' ? 0 : Number(ui.input.value)); return; }

      var chip = t.closest('[data-mrg-chip]');
      if (chip && !chip.disabled) {
        e.preventDefault();
        var info = plan(currentId, 0);
        if (!info) return;
        var key = chip.getAttribute('data-mrg-chip');
        var amt = 0;
        if (key === 'need') amt = info.need;
        else amt = round2(info.available * (Number(key) / 100));
        if (amt > 0) { ui.input.value = String(amt); renderPreview(); }
      }
    }, false);

    if (!ui) return;

    ui.input.addEventListener('input', renderPreview);

    /* ★ 关键：游戏在 document 上监听 keydown，且 INPUT 里按 Enter 会**直接开仓**
     *   （fx-game.html 的 openPosition(state.lastSide)）。所以这里必须在冒泡阶段
     *   就把 Enter/Escape 截住 —— stopPropagation 之后 document 上的处理器不会再跑。 */
    ui.panel.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (!ui.ok.disabled) apply(ui.input.value === '' ? 0 : Number(ui.input.value));
        return;
      }
      if (e.key === 'Escape' || e.key === 'Esc') {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    }, false);
  }

  /* ---------------------------------------------------------------- 启动 */
  function mount() {
    injectStyle();
    buildDialog();
    bind();
    injectRows();
    var box = document.getElementById('positions');
    if (box && window.MutationObserver) {
      new MutationObserver(scheduleInject).observe(box, { childList: true });
    }
  }

  function boot() {
    if (!window.FX || !document.getElementById('positions')) return false;
    mount();
    return true;
  }

  /* 游戏脚本在 </body> 前执行完毕，但为稳妥起见轮询等待（最多 ~10 秒） */
  var tries = 0;
  var dead = false;
  (function wait() {
    if (dead) return;
    try {
      if (boot()) return;
    } catch (e) {
      /* ★ 绝不让这个模块把游戏带崩：环境不认识（例如极简 DOM 桩、老浏览器缺 API）
       *   就安静退出，游戏本体照常运行 —— 少一个追保按钮远好过整页白屏。 */
      dead = true;
      if (window.console && console.warn) {
        console.warn('[FXMargin] 未启用：' + ((e && e.message) || e));
      }
      return;
    }
    tries++;
    if (tries > 200) return;                    // 10 秒还没就绪就放弃，不阻塞页面
    setTimeout(wait, 50);
  })();

  /* ---------------------------------------------------------------- 对外 */
  window.FXMargin = {
    version: VERSION,
    open: open,
    close: close,
    apply: apply,
    plan: plan,
    refresh: scheduleInject,
    injectRows: injectRows,
    isOpen: function () { return !!(ui && !ui.wrap.hidden); },
    currentId: function () { return currentId; },
    /* 测试用：暴露原始样式串长度，便于断言"样式确实注入了" */
    styleId: 'fx-margin-style',
  };
})();
