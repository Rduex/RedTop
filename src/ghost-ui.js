/*
 * GhostUI —— 幽灵对战的界面层。
 *
 * 职责：
 *   ① 结算界面加"生成幽灵挑战链接"按钮
 *   ② 打开 #ghost=xxx 时显示挑战确认弹窗
 *   ③ 对战中：幽灵动作飘字 + 玩家 vs 幽灵实时对比面板
 *   ④ 结束时：胜负结算
 *
 * ============================ 为什么不改游戏源码 ============================
 *
 * 游戏的结算界面是 IIFE 内部渲染的（showRuinChoice / showDadMoney 等），
 * 没有对外钩子。所以这里不去改那些函数，而是：
 *   - 独立维护一个"幽灵挑战结果"弹窗（游戏自己的结算弹窗照常显示）；
 *   - 用状态观测判断一局何时结束（与 ghost.js 的录制器共用同一套判断）；
 *   - 把入口按钮挂在顶栏，而不是塞进游戏内部弹窗的 DOM 里。
 *
 * 好处：游戏源码零改动；坏处：入口不在"结算弹窗里"而在顶栏。
 * 如果以后要真正塞进结算弹窗，需要游戏侧配合暴露一个插槽 —— 这一点在文档里注明。
 * ==================================================================
 */
(function (root, factory) {
  var api = factory(root);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.GhostUI = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  function doc() { return root.document; }

  /* ---------- 样式 ---------- */
  var CSS = [
    /* 幽灵挑战浮层 —— 直接内置深色，与主界面同一套令牌。
     * ★ 不要再依赖 theme-fx.css 去覆盖：这些样式是幽灵功能自己的，
     *   内置深色才能保证"无论主题是否加载，弹窗都不会是白底"。 */
    '.fxg-root{position:fixed;inset:0;z-index:99996;display:none;background:rgba(4,7,12,.72);',
    'backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);}',
    '.fxg-root.on{display:block;}',
    /* ★ 面板用"内容自适应 + 最大高度"。
     *   绝不能写 height:100%，否则内容很少时（如排行榜空态）
     *   面板会被拉成满屏，下面一大片空白。 */
    '.fxg-panel{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);',
    'width:min(560px,92vw);max-height:min(86vh,760px);overflow-y:auto;',
    'background:#121926;border:1px solid rgba(148,163,184,.26);border-radius:18px;',
    'box-shadow:0 24px 70px rgba(0,0,0,.6);color:#e8edf5;',
    'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '.fxg-head{display:flex;align-items:center;justify-content:space-between;gap:10px;',
    'padding:16px 18px 13px;border-bottom:1px solid rgba(148,163,184,.14);}',
    '.fxg-head h2{margin:0;font-size:17px;color:#e8edf5;}',
    '.fxg-x{border:1px solid rgba(148,163,184,.2);background:#182234;color:#9aa8bd;',
    'border-radius:999px;width:34px;height:34px;min-width:34px;cursor:pointer;',
    'font-size:14px;line-height:1;flex:none;display:inline-flex;align-items:center;',
    'justify-content:center;transition:all .15s;}',
    '.fxg-x:hover{background:rgba(239,68,68,.16);color:#ef4444;border-color:rgba(239,68,68,.35);}',
    '.fxg-body{padding:16px 18px 20px;}',
    '.fxg-row{display:flex;justify-content:space-between;gap:12px;padding:8px 0;font-size:13.5px;',
    'color:#9aa8bd;border-bottom:1px solid rgba(148,163,184,.07);}',
    '.fxg-row:last-child{border-bottom:0;}',
    '.fxg-row b{font-variant-numeric:tabular-nums;color:#e8edf5;text-align:right;}',
    '.fxg-btn{border:0;border-radius:12px;padding:13px 16px;font-size:14px;font-weight:700;',
    'cursor:pointer;background:linear-gradient(180deg,#5b95ff,#4f8cff);color:#fff;',
    'font-family:inherit;width:100%;margin-top:8px;min-height:48px;',
    'box-shadow:0 4px 18px rgba(79,140,255,.3);transition:filter .15s,transform .12s;}',
    '.fxg-btn:hover{filter:brightness(1.1);}',
    '.fxg-btn:active{transform:scale(.99);}',
    '.fxg-btn.ghost{background:#182234;color:#9aa8bd;border:1px solid rgba(148,163,184,.2);',
    'box-shadow:none;}',
    '.fxg-btn.ghost:hover{background:#1f2b40;color:#e8edf5;}',
    '.fxg-btn.gold{background:linear-gradient(180deg,#e8c163,#e0b44c);color:#241a00;',
    'box-shadow:0 4px 18px rgba(224,180,76,.28);}',
    '.fxg-btn.gold:hover{filter:brightness(1.08);}',
    '.fxg-btn:disabled{opacity:.5;cursor:not-allowed;}',
    '.fxg-note{font-size:12px;color:#64748b;line-height:1.7;margin-top:12px;}',
    '.fxg-win{color:#ef4444;}',
    '.fxg-lose{color:#22c55e;}',
    /* 对战中：对比面板 */
    '.fxg-hud{position:fixed;right:10px;top:80px;z-index:99990;',
    'background:rgba(18,25,38,.96);border:1px solid rgba(148,163,184,.26);',
    'border-radius:14px;padding:10px 13px;font-size:12px;',
    'box-shadow:0 10px 30px rgba(0,0,0,.55);display:none;min-width:136px;',
    'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
    'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#e8edf5;}',
    '.fxg-hud.on{display:block;}',
    '.fxg-hud .fxg-t{font-weight:700;font-size:11px;color:#64748b;margin-bottom:6px;',
    'display:flex;justify-content:space-between;gap:8px;}',
    '.fxg-hud .fxg-l{display:flex;justify-content:space-between;gap:10px;padding:2px 0;',
    'font-variant-numeric:tabular-nums;}',
    '.fxg-hud .fxg-l span:first-child{color:#9aa8bd;}',
    '.fxg-hud .fxg-d{margin-top:6px;padding-top:6px;',
    'border-top:1px solid rgba(148,163,184,.14);',
    'text-align:center;font-weight:700;font-variant-numeric:tabular-nums;}',
    /* 飘字 */
    '.fxg-float{position:fixed;left:50%;top:22%;transform:translateX(-50%);z-index:99995;',
    'background:rgba(18,25,38,.96);color:#e8edf5;font-size:13px;padding:10px 18px;',
    'border-radius:999px;border:1px solid rgba(148,163,184,.26);',
    'pointer-events:none;opacity:0;transition:opacity .3s, transform .3s;white-space:nowrap;',
    'max-width:92vw;overflow:hidden;text-overflow:ellipsis;',
    'box-shadow:0 10px 30px rgba(0,0,0,.55);',
    'font-family:system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;}',
    '.fxg-float.on{opacity:1;transform:translateX(-50%) translateY(-8px);}',
    '.fxg-float.p1{background:rgba(34,197,94,.94);border-color:rgba(34,197,94,.5);',
    'color:#04170c;font-weight:600;}',
    '.fxg-float.p0{background:rgba(239,68,68,.94);border-color:rgba(239,68,68,.5);',
    'color:#fff;font-weight:600;}',
    /* 顶栏入口 */
    '.fxg-chip{border:1px solid rgba(148,163,184,.14);background:#182234;color:#9aa8bd;',
    'font-size:11.5px;padding:7px 12px;border-radius:999px;cursor:pointer;',
    'white-space:nowrap;font-family:inherit;min-height:34px;display:inline-flex;',
    'align-items:center;transition:all .16s;}',
    '.fxg-chip:hover{background:#1f2b40;border-color:rgba(148,163,184,.26);color:#e8edf5;}',
    '.fxg-chip.battle{background:rgba(34,197,94,.16);color:#22c55e;',
    'border-color:rgba(34,197,94,.4);font-weight:700;}',
    /* 手机端：整屏面板，但内容顶部对齐，
     * 不用 height:100% 拉满（那样空态会留大片空白） */
    '@media (max-width:560px){',
    '.fxg-root.on{display:flex;align-items:flex-start;justify-content:center;}',
    '.fxg-panel{position:relative;left:auto;top:auto;transform:none;',
    'width:100vw;max-width:100vw;height:auto;max-height:100vh;',
    'border-radius:0;border-left:0;border-right:0;border-top:0;',
    'margin:0;overflow-y:auto;}',
    '.fxg-head{position:sticky;top:0;z-index:2;background:#121926;}',
    '.fxg-hud{right:6px;top:auto;bottom:76px;font-size:11px;min-width:124px;}}'
  ].join('');

  function injectCss() {
    var d = doc();
    if (!d || d.getElementById('fxg-style')) return;
    var s = d.createElement('style');
    s.id = 'fxg-style';
    s.textContent = CSS;
    d.head.appendChild(s);
  }

  function el(tag, cls, text) {
    var e = doc().createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function money(n) {
    var v = Number(n) || 0;
    var a = Math.abs(v);
    var s = '$' + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (v < 0 ? '-' : '') + s;
  }

  function pnlText(n) {
    var v = Number(n) || 0;
    return (v >= 0 ? '+' : '-') + money(Math.abs(v));
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&quot;');
  }

  /* ============================ 主控制器 ============================ */

  /*
   * 创建幽灵 UI。
   * @param opts { fx, mock, ghostApi, getPlayerName }
   */
  function create(opts) {
    var o = opts || {};
    var fx = o.fx;
    var mock = o.mock;
    var GA = o.ghostApi || root.Ghost;
    var getPlayerName = o.getPlayerName || function () { return '久留美'; };

    var st = {
      /* 当前的幽灵挑战（null = 普通模式） */
      challenge: null,       // { ghost, replay, accepted }
      hudShown: false,
      floatTimer: null,
      /* 录制器（每局一个） */
      recorder: null,
      lastRunActive: false,
    };

    var dom = {};

    function build() {
      var d = doc();
      if (!d || dom.root) return;

      /* 挑战 / 结果 共用同一个弹窗容器 */
      var rootEl = el('div', 'fxg-root');
      rootEl.id = 'fxgRoot';
      var panel = el('div', 'fxg-panel');
      var head = el('div', 'fxg-head');
      var h2 = el('h2', null, '幽灵挑战');
      var x = el('button', 'fxg-x', '✕');
      x.type = 'button';
      x.addEventListener('click', function () { hideModal(); });
      head.appendChild(h2);
      head.appendChild(x);
      var body = el('div', 'fxg-body');
      panel.appendChild(head);
      panel.appendChild(body);
      rootEl.appendChild(panel);
      d.body.appendChild(rootEl);

      /* 对比 HUD */
      var hud = el('div', 'fxg-hud');
      d.body.appendChild(hud);

      /* 飘字 */
      var fl = el('div', 'fxg-float');
      d.body.appendChild(fl);

      dom.root = rootEl;
      dom.title = h2;
      dom.body = body;
      dom.hud = hud;
      dom.float = fl;
    }

    function showModal(title) {
      build();
      dom.title.textContent = title || '幽灵挑战';
      dom.root.classList.add('on');
    }
    function hideModal() {
      if (dom.root) dom.root.classList.remove('on');
    }

    /* ---------- 飘字 ---------- */
    function floatText(text, kind) {
      build();
      if (!dom.float) return;
      dom.float.textContent = text;
      dom.float.className = 'fxg-float on' + (kind === 1 ? ' p1' : (kind === 0 ? ' p0' : ''));
      clearTimeout(st.floatTimer);
      st.floatTimer = setTimeout(function () {
        if (dom.float) dom.float.classList.remove('on');
      }, 2600);
    }

    /* ---------- HUD ---------- */
    function renderHud(cmp) {
      build();
      if (!dom.hud) return;
      var ghostName = st.challenge ? st.challenge.ghost.name : '幽灵';
      var diffCls = cmp.diff >= 0 ? 'fxg-win' : 'fxg-lose';
      dom.hud.innerHTML =
        '<div class="fxg-t"><span>我 ' + esc(getPlayerName()) + '</span><span>vs</span></div>' +
        '<div class="fxg-l"><span>我</span><b class="' + diffCls + '">' + money(cmp.player) + '</b></div>' +
        '<div class="fxg-l"><span>' + esc(ghostName) + '</span><b>' + money(cmp.ghost) + '</b></div>' +
        '<div class="fxg-d ' + diffCls + '">' +
        (cmp.diff >= 0 ? '领先 ' : '落后 ') + money(Math.abs(cmp.diff)) + '</div>';
      if (!st.hudShown) {
        dom.hud.classList.add('on');
        st.hudShown = true;
      }
    }

    function hideHud() {
      if (dom.hud) dom.hud.classList.remove('on');
      st.hudShown = false;
    }

    /* ---------- 挑战确认弹窗 ---------- */
    function showChallengeConfirm(ghost) {
      build();
      var body = dom.body;
      while (body.firstChild) body.removeChild(body.firstChild);

      dom.title.textContent = '👻 幽灵挑战';
      var n = ghost.timeline.length;

      var info = el('div');
      info.innerHTML =
        '<div class="fxg-row"><span>挑战对象</span><b>' + esc(ghost.name) + '</b></div>' +
        '<div class="fxg-row"><span>它的最终收益</span><b class="' +
        (ghost.finalProfit >= 0 ? 'fxg-win' : 'fxg-lose') + '">' +
        pnlText(ghost.finalProfit) + '</b></div>' +
        '<div class="fxg-row"><span>它操作了</span><b>' + n + ' 次</b></div>' +
        '<div class="fxg-row"><span>你的开局资金</span><b>' + money(ghost.startEquity) + '</b></div>';
      body.appendChild(info);

      var note = el('div', 'fxg-note');
      note.textContent = '挑战期间它会在同样的时间点开仓/平仓，你会看到它的动向，' +
        '但不会影响你自己的行情。结束时比收益，赚得多的算赢。';
      body.appendChild(note);

      var btn = el('button', 'fxg-btn', '接受挑战');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        acceptChallenge(ghost);
      });
      body.appendChild(btn);

      var skip = el('button', 'fxg-btn ghost', '先不挑战，正常玩');
      skip.type = 'button';
      skip.addEventListener('click', function () {
        hideModal();
        /* 清掉 hash，避免刷新后又弹 */
        clearGhostHash();
      });
      body.appendChild(skip);

      showModal('👻 幽灵挑战');
    }

    function clearGhostHash() {
      try {
        if (root.history && root.history.replaceState && root.location) {
          root.history.replaceState(null, '', root.location.pathname + root.location.search);
        }
      } catch (e) { /* file:// 下 replaceState 可能受限，忽略 */ }
    }

    /* ---------- 接受挑战 ---------- */
    function acceptChallenge(ghost) {
      hideModal();
      st.challenge = {
        ghost: ghost,
        replay: GA.createReplay(ghost, fx),
        accepted: true,
        startedAt: null,
        startEquity: null,
      };
      /* 挑战期间重新开始录制（这一局既是挑战，也能生成新幽灵） */
      beginRecording();
      updateChip();
      floatText('👻 ' + ghost.name + ' 加入了这一局', 1);
    }

    /* ---------- 结算 ---------- */
    function showResult(verdict) {
      build();
      var body = dom.body;
      while (body.firstChild) body.removeChild(body.firstChild);

      var title = verdict.tie ? '🤝 打平了' : (verdict.win ? '🏆 你击败了幽灵！' : '💀 幽灵略胜一筹');
      dom.title.textContent = title;

      var info = el('div');
      info.innerHTML =
        '<div class="fxg-row"><span>你的收益</span><b class="' +
        (verdict.playerProfit >= 0 ? 'fxg-win' : 'fxg-lose') + '">' +
        pnlText(verdict.playerProfit) + '</b></div>' +
        '<div class="fxg-row"><span>' + esc(verdict.ghostName) + ' 的收益</span><b>' +
        pnlText(verdict.ghostProfit) + '</b></div>' +
        '<div class="fxg-row"><span>差距</span><b>' +
        (verdict.diff >= 0 ? '领先 ' : '落后 ') + money(Math.abs(verdict.diff)) + '</b></div>';
      body.appendChild(info);

      /* 顺手把这场挑战的成绩也写进排行榜 */
      try {
        mock.saveScore(getPlayerName(), verdict.playerProfit);
      } catch (e) { /* 忽略 */ }

      var btn = el('button', 'fxg-btn', '再来一局');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        hideModal();
        st.challenge = null;
        hideHud();
        clearGhostHash();
        updateChip();
        beginRecording();
      });
      body.appendChild(btn);

      showModal(title);
    }

    /* ---------- 排行榜弹窗 ---------- */
    function showLeaderboard() {
      build();
      var body = dom.body;
      while (body.firstChild) body.removeChild(body.firstChild);
      dom.title.textContent = '🏆 本地排行榜';

      var rows = mock.getLeaderboard(50);
      if (!rows.length) {
        var empty = el('div', 'fxg-note', '还没有成绩。打完一局就会出现在这里。');
        empty.style.textAlign = 'center';
        empty.style.padding = '24px 0';
        body.appendChild(empty);
      } else {
        var list = el('div');
        rows.forEach(function (r) {
          var row = el('div', 'fxg-row');
          row.innerHTML = '<span>#' + r.rank + ' ' + esc(r.name) + '</span><b class="' +
            (r.profit >= 0 ? 'fxg-win' : 'fxg-lose') + '">' + pnlText(r.profit) + '</b>';
          list.appendChild(row);
        });
        body.appendChild(list);
      }

      var note = el('div', 'fxg-note');
      note.textContent = '排行榜存在本机浏览器里（localStorage）。接入 Toy 后会改为平台榜单。';
      body.appendChild(note);

      showModal('🏆 本地排行榜');
    }

    /* ---------- 生成挑战链接 ---------- */
    function generateChallengeLink(onDone) {
      var rec = st.recorder;
      if (!rec) {
        if (onDone) onDone({ ok: false, error: '录制器还没准备好' });
        return;
      }
      var timeline = rec.flush();
      if (!timeline.length) {
        if (onDone) onDone({ ok: false, error: '这一局还没有任何操作，没有可挑战的内容' });
        return;
      }
      var stats = rec.stats();
      var id = mock.saveGhost(getPlayerName(), stats.profit, timeline, {
        startEquity: rec.startEquity(),
      });
      if (!id) {
        if (onDone) onDone({ ok: false, error: '保存失败（浏览器存储空间可能不够）' });
        return;
      }
      var link = GA.buildGhostLink(id);
      copyToClipboard(link).then(function (ok) {
        if (onDone) onDone({ ok: true, matchId: id, link: link, copied: ok, nodes: timeline.length });
      });
    }

    /* 复制到剪贴板：优先 Clipboard API，失败退化到 execCommand */
    function copyToClipboard(text) {
      return new Promise(function (resolve) {
        try {
          if (root.navigator && root.navigator.clipboard && root.navigator.clipboard.writeText) {
            root.navigator.clipboard.writeText(text)
              .then(function () { resolve(true); })
              .catch(function () { resolve(legacyCopy(text)); });
            return;
          }
        } catch (e) { /* 落到 legacy */ }
        resolve(legacyCopy(text));
      });
    }

    function legacyCopy(text) {
      var d = doc();
      if (!d || !d.body) return false;
      try {
        var ta = d.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        d.body.appendChild(ta);
        ta.select();
        var ok = false;
        try { ok = d.execCommand('copy'); } catch (e) { ok = false; }
        d.body.removeChild(ta);
        return ok;
      } catch (e) { return false; }
    }

    /* ---------- 录制生命周期 ---------- */
    function beginRecording() {
      if (!GA || !GA.createRecorder) return;
      if (st.recorder && st.recorder.isActive()) st.recorder.stop();
      st.recorder = GA.createRecorder(fx);
      st.recorder.start();
      if (st.challenge) {
        st.challenge.replay2 = null;
        st.challenge.startedAt = null;
      }
    }

    /* 每 tick 调一次：推进幽灵、更新 HUD */
    function onTick() {
      if (!st.challenge) return;
      var rec = st.recorder;
      if (!rec) return;
      var stats = rec.stats();
      var sec = stats.seconds;

      /* 第一次真正参与时才记起点，避免把"看确认弹窗"的时间算进去 */
      if (st.challenge.startedAt === null) {
        st.challenge.startedAt = sec;
        st.challenge.startEquity = (function () {
          try { return typeof fx.totalEquity === 'function' ? fx.totalEquity() : fx.state.balance; }
          catch (e) { return 10000; }
        })();
      }

      var fired = st.challenge.replay.advance(sec);
      for (var i = 0; i < fired.length; i++) {
        var node = fired[i];
        var desc = st.challenge.replay.describeNode(node);
        /* 幽灵赚了还是亏了：用节点前后权益差判断 */
        var gain = (Number(node.equity) || 0) - (Number(st.challenge.ghost.startEquity) || 10000);
        floatText(desc, gain >= 0 ? 1 : 0);
      }

      var cmp = st.challenge.replay.compare(sec);
      renderHud(cmp);
    }

    /* 一局结束时调用：显示胜负 */
    function onRunEnded() {
      if (!st.challenge) return;
      var v = st.challenge.replay.verdict();
      hideHud();
      showResult(v);
    }

    /* ---------- 顶栏入口 ---------- */
    function updateChip() {
      var d = doc();
      if (!d) return;
      var chip = d.getElementById('fxgChip');
      if (!chip) return;
      if (st.challenge) {
        chip.textContent = '👻 对战中';
        chip.className = 'fxg-chip battle';
        chip.title = '正在与 ' + st.challenge.ghost.name + ' 对战';
      } else {
        chip.textContent = '🏆 排行 · 幽灵';
        chip.className = 'fxg-chip';
        chip.title = '查看排行榜 / 生成幽灵挑战链接';
      }
    }

    function mountChip() {
      var d = doc();
      if (!d) return;
      var bar = d.querySelector('.topbar-actions');
      if (!bar || d.getElementById('fxgChip')) return;
      var chip = el('button', 'fxg-chip');
      chip.id = 'fxgChip';
      chip.type = 'button';
      chip.addEventListener('click', function () { showGhostMenu(); });
      bar.insertBefore(chip, bar.firstChild);
      updateChip();
    }

    /* 综合菜单：排行榜 / 生成链接 */
    function showGhostMenu() {
      build();
      var body = dom.body;
      while (body.firstChild) body.removeChild(body.firstChild);
      dom.title.textContent = '🏆 排行 · 幽灵';

      var bBoard = el('button', 'fxg-btn', '查看排行榜');
      bBoard.type = 'button';
      bBoard.addEventListener('click', showLeaderboard);
      body.appendChild(bBoard);

      var bLink = el('button', 'fxg-btn gold', '生成幽灵挑战链接');
      bLink.type = 'button';
      bLink.addEventListener('click', function () {
        bLink.disabled = true;
        bLink.textContent = '生成中…';
        generateChallengeLink(function (r) {
          bLink.disabled = false;
          if (!r.ok) {
            bLink.textContent = '生成幽灵挑战链接';
            var msg = el('div', 'fxg-note');
            msg.style.color = '#d1685f';
            msg.textContent = '生成失败：' + r.error;
            body.appendChild(msg);
            return;
          }
          bLink.textContent = '已生成！再生成一个';
          var box = el('div', 'fxg-note');
          box.innerHTML = '挑战链接（已' + (r.copied ? '复制到剪贴板' : '生成，请手动复制') + '）：<br>' +
            '<span style="word-break:break-all;color:#3d8f66">' + esc(r.link) + '</span><br>' +
            '包含 ' + r.nodes + ' 个操作节点。发给朋友，他们打开就会遇到你这个幽灵。';
          body.appendChild(box);
        });
      });
      body.appendChild(bLink);

      var note = el('div', 'fxg-note');
      note.textContent = '幽灵记录的是你这一局的开仓/平仓时点与余额曲线。' +
        '别人打开链接会和你这一局比收益。';
      body.appendChild(note);

      showModal('🏆 排行 · 幽灵');
    }

    /* ---------- 入口：检查 URL ---------- */
    function checkUrlForGhost() {
      var id = GA.parseGhostFromHash();
      if (!id) return false;
      var g = mock.getGhost(id);
      if (!g) {
        floatText('这个幽灵不存在或已失效', 0);
        clearGhostHash();
        return false;
      }
      showChallengeConfirm(g);
      return true;
    }

    function init() {
      injectCss();
      build();
      mountChip();
      beginRecording();
      checkUrlForGhost();
    }

    return {
      init: init,
      onTick: onTick,
      onRunEnded: onRunEnded,
      beginRecording: beginRecording,
      generateChallengeLink: generateChallengeLink,
      showLeaderboard: showLeaderboard,
      showGhostMenu: showGhostMenu,
      checkUrlForGhost: checkUrlForGhost,
      floatText: floatText,
      _state: st,
      _dom: dom,
    };
  }

  return { create: create, injectCss: injectCss, money: money, pnlText: pnlText };
});
