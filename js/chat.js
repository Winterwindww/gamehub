/* =========================================================
   联机游戏厅 · 房间公聊 + 桌上表情
   ---------------------------------------------------------
   桌面端：聊天面板常驻右侧，所有人随时可见。
   窄屏：点顶栏「公聊」按钮以浮层展开。
   表情：点一下自己的座位就能发，气泡出现在自己旁边，
        房间内所有人同步可见。
   ========================================================= */
(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var roomCode = U.cleanCode(params.get('room'));
  if (!roomCode || roomCode.length !== 4) { return; }

  var myId = U.getPlayerId();

  var Snd = window.Snd || { play: function () { } };

  /* 输入框上方的表情面板 */
  var EMOJIS = [
    '😀', '😂', '🤣', '😊', '😎', '🤔', '😏', '😅', '😭', '😡',
    '🤯', '🥳', '😴', '🙈', '👀', '👍', '👎', '👏', '🙏', '🤝',
    '💪', '🫡', '🤫', '🎉', '🔥', '❤️', '🏆', '🃏', '♠️', '♥️',
    '♦️', '♣️', '🎲', '⚡', '🍀'
  ];

  /* 点座位时弹出的快捷表情 */
  var QUICK = [
    '😀', '😂', '😭', '😡', '😎', '🤔',
    '👍', '👎', '🙏', '🎉', '🔥', '💪',
    '🃏', '🍀', '❤️', '😴'
  ];

  var MAX_LEN = 120;
  var KEEP_MSGS = 120;
  var POLL_MS = 1600;
  var DOCK_MIN = 1240;      // 视口宽于此值时，面板常驻侧边

  var msgs = [];
  var lastId = 0;
  var unread = 0;
  var open = false;
  var sending = false;
  var started = false;
  var sentCount = 0;

  var lastEmoteId = 0;
  var emoteStarted = false;
  var emoteSent = 0;
  var suppressMineUntil = 0;

  var fab, badgeEl, panel, bodyEl, inputEl, sendBtn, emojiRow;
  var topBtn, topBadge;
  var picker = null;

  function h(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) { e.className = cls; }
    if (text != null) { e.textContent = text; }
    return e;
  }

  function fmtTime(v) {
    var d = new Date(v);
    if (isNaN(d.getTime())) { return ''; }
    var hh = String(d.getHours()).padStart(2, '0');
    var mm = String(d.getMinutes()).padStart(2, '0');
    return hh + ':' + mm;
  }

  /* ---------------- 构建界面 ---------------- */

  function build() {
    // 顶栏入口（窄屏时用来展开）
    topBtn = document.getElementById('chatOpenBtn');
    topBadge = document.getElementById('chatBadge');
    if (topBtn) { topBtn.onclick = function () { toggle(); }; }

    fab = h('div', 'chat-fab');
    fab.appendChild(h('span', 'chat-fab-ico', '💬'));
    badgeEl = h('span', 'chat-badge');
    badgeEl.classList.add('hidden');
    fab.appendChild(badgeEl);
    fab.title = '房间公聊';
    fab.onclick = function () { toggle(); };

    panel = h('div', 'chat-panel hidden');

    var head = h('div', 'chat-head');
    head.appendChild(h('span', 'chat-head-title', '房间公聊'));
    var hint = h('span', 'chat-head-hint', '点自己的座位可发表情');
    head.appendChild(hint);
    var closeBtn = h('span', 'chat-close', '✕');
    closeBtn.title = '收起';
    closeBtn.onclick = function () { toggle(false); };
    head.appendChild(closeBtn);

    bodyEl = h('div', 'chat-body');

    emojiRow = h('div', 'chat-emoji');
    EMOJIS.forEach(function (em) {
      var b = h('button', 'chat-emoji-btn', em);
      b.type = 'button';
      b.onclick = function () {
        inputEl.value = (inputEl.value + em).slice(0, MAX_LEN);
        inputEl.focus();
      };
      emojiRow.appendChild(b);
    });

    var row = h('div', 'chat-input-row');
    inputEl = document.createElement('input');
    inputEl.type = 'text';
    inputEl.className = 'chat-input';
    inputEl.maxLength = MAX_LEN;
    inputEl.placeholder = '说点什么…';
    inputEl.onkeydown = function (e) {
      if (e.key === 'Enter') { e.preventDefault(); send(); }
    };
    sendBtn = h('button', 'btn btn-primary chat-send', '发送');
    sendBtn.type = 'button';
    sendBtn.onclick = send;
    row.appendChild(inputEl);
    row.appendChild(sendBtn);

    panel.appendChild(head);
    panel.appendChild(bodyEl);
    panel.appendChild(emojiRow);
    panel.appendChild(row);

    document.body.appendChild(fab);
    document.body.appendChild(panel);
  }

  /* ---------------- 常驻 / 展开 ---------------- */

  var mq = window.matchMedia ? window.matchMedia('(min-width: ' + DOCK_MIN + 'px)') : null;

  function isDocked() { return !!(mq && mq.matches); }

  function applyDock() {
    var docked = isDocked();
    document.body.classList.toggle('chat-docked', docked);

    if (docked) {
      open = true;
      unread = 0;
      panel.classList.remove('hidden');
      fab.classList.add('active');
    } else {
      panel.classList.toggle('hidden', !open);
      fab.classList.toggle('active', open);
    }
    renderBadge();
    render();
  }

  function toggle(force) {
    if (isDocked()) { return; }   // 常驻时不收起
    open = (typeof force === 'boolean') ? force : !open;
    panel.classList.toggle('hidden', !open);
    fab.classList.toggle('active', open);
    if (open) {
      unread = 0;
      renderBadge();
      render();
      inputEl.focus();
    }
  }

  if (mq) {
    if (mq.addEventListener) { mq.addEventListener('change', applyDock); }
    else if (mq.addListener) { mq.addListener(applyDock); }
  }
  window.addEventListener('resize', function () { applyDock(); closePicker(); });

  /* ---------------- 渲染 ---------------- */

  function renderBadge() {
    var n = (!open && unread > 0) ? unread : 0;
    var t = n > 99 ? '99+' : String(n);
    badgeEl.textContent = t;
    badgeEl.classList.toggle('hidden', n === 0);
    if (topBadge) {
      topBadge.textContent = t;
      topBadge.classList.toggle('hidden', n === 0);
    }
    if (topBtn) { topBtn.classList.toggle('has-unread', n > 0); }
  }

  function render() {
    if (!open) { return; }
    var stick = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 90;

    bodyEl.innerHTML = '';
    if (!msgs.length) {
      bodyEl.appendChild(h('div', 'chat-empty', '还没有人说话，来打个招呼吧'));
    }
    msgs.forEach(function (m) {
      var mine = m.player_id === myId;
      var item = h('div', 'chat-msg' + (mine ? ' me' : ''));
      var top = h('div', 'chat-msg-top');
      top.appendChild(h('span', 'chat-msg-name', mine ? '我' : (m.nickname || '玩家')));
      top.appendChild(h('span', 'chat-msg-time', fmtTime(m.created_at)));
      item.appendChild(top);
      item.appendChild(h('div', 'chat-msg-text', m.body));
      bodyEl.appendChild(item);
    });

    if (stick) { bodyEl.scrollTop = bodyEl.scrollHeight; }
  }

  /* ---------------- 同步 ---------------- */

  async function poll() {
    var first = !started;
    var rows = await GH.db.listChat(roomCode, first ? null : lastId, first ? 60 : 200);
    started = true;

    if (rows && rows.length) {
      var fresh = 0;
      rows.forEach(function (r) {
        msgs.push(r);
        if (r.id > lastId) { lastId = r.id; }
        if (!first && r.player_id !== myId) { fresh++; }
      });
      if (msgs.length > KEEP_MSGS) { msgs = msgs.slice(-KEEP_MSGS); }
      if (fresh) { unread += fresh; Snd.play('msg'); }
      renderBadge();
    }
    render();

    try { await pollEmotes(); } catch (e) { console.warn('[emote]', e); }
  }

  async function send() {
    if (sending) { return; }
    var text = String(inputEl.value || '').trim();
    if (!text) { return; }
    if (text.length > MAX_LEN) { text = text.slice(0, MAX_LEN); }

    sending = true;
    sendBtn.disabled = true;
    try {
      await GH.db.sendChat(roomCode, myId, U.getNickname() || '玩家', text);
      inputEl.value = '';
      await poll();

      sentCount++;
      if (sentCount % 15 === 0) {
        GH.db.trimChat(roomCode).catch(function () { /* 清理失败不影响使用 */ });
      }
    } catch (e) {
      U.toast('发送失败：' + GH.errText(e), 'err');
    }
    sending = false;
    sendBtn.disabled = false;
    inputEl.focus();
  }

  /* ---------------- 桌上表情 ---------------- */

  /** 按 data-pid 找玩家在页面上的位置（各游戏自行标注） */
  function findAnchor(playerId) {
    var list = document.querySelectorAll('[data-pid]');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-pid') === playerId) { return list[i]; }
    }
    return null;
  }

  function showEmoteBubble(playerId, emoji) {
    var anchor = findAnchor(playerId);
    if (!anchor) { return; }
    var r = anchor.getBoundingClientRect();
    if (!r.width && !r.height) { return; }

    var b = h('div', 'emote-bubble', emoji);
    b.style.visibility = 'hidden';
    document.body.appendChild(b);

    var w = b.offsetWidth || 54;
    var hh = b.offsetHeight || 54;
    var left = Math.min(Math.max(6, r.left + r.width / 2 - w / 2), window.innerWidth - w - 6);
    var top = Math.max(6, r.top - hh - 2);
    b.style.left = left + 'px';
    b.style.top = top + 'px';
    b.style.visibility = 'visible';

    requestAnimationFrame(function () { b.classList.add('in'); });

    setTimeout(function () {
      b.classList.add('out');
      setTimeout(function () { if (b.parentNode) { b.parentNode.removeChild(b); } }, 420);
    }, 2500);
  }

  async function sendEmote(emoji) {
    try {
      await GH.db.sendEmote(roomCode, myId, U.getNickname() || '玩家', emoji);
      suppressMineUntil = Date.now() + 3500;
      showEmoteBubble(myId, emoji);          // 自己立刻看到
      Snd.play('emote');
      emoteSent++;
      if (emoteSent % 12 === 0) {
        GH.db.trimEmotes(roomCode).catch(function () { /* 忽略 */ });
      }
    } catch (e) {
      U.toast('表情发送失败', 'err');
    }
  }

  async function pollEmotes() {
    var rows = await GH.db.listEmotes(roomCode, emoteStarted ? lastEmoteId : null);

    if (!emoteStarted) {                     // 首次只对位，不重播历史表情
      emoteStarted = true;
      if (rows && rows.length && rows[0] && rows[0].id) { lastEmoteId = rows[0].id; }
      return;
    }
    if (!rows || !rows.length) { return; }

    rows.forEach(function (r) {
      if (r.id > lastEmoteId) { lastEmoteId = r.id; }
      // 自己刚发的已经乐观展示过，不再重复播放
      if (r.player_id === myId && Date.now() < suppressMineUntil) { return; }
      showEmoteBubble(r.player_id, r.emoji);
      Snd.play('emote');
    });
  }

  /* ---------------- 点自己的座位选表情 ---------------- */

  function closePicker() {
    if (picker && picker.parentNode) { picker.parentNode.removeChild(picker); }
    picker = null;
  }

  function openPicker(seat) {
    closePicker();
    var r = seat.getBoundingClientRect();

    var box = h('div', 'emote-picker');
    var grid = h('div', 'emote-picker-grid');
    QUICK.forEach(function (em) {
      var b = h('button', 'emote-pick-btn', em);
      b.type = 'button';
      b.onclick = function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        sendEmote(em);
        closePicker();
      };
      grid.appendChild(b);
    });
    box.appendChild(grid);
    box.appendChild(h('div', 'emote-picker-tip', '房间里所有人都能看到'));

    box.style.visibility = 'hidden';
    document.body.appendChild(box);
    picker = box;

    var w = box.offsetWidth || 248;
    var hh = box.offsetHeight || 150;
    var left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), window.innerWidth - w - 8);
    var top = r.top - hh - 10;
    if (top < 8) { top = r.bottom + 10; }
    box.style.left = left + 'px';
    box.style.top = top + 'px';
    box.style.visibility = 'visible';
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) { closePicker(); return; }
    if (picker && picker.contains(t)) { return; }

    var seat = t.closest('[data-pid]');
    if (!seat) { closePicker(); return; }

    if (seat.getAttribute('data-pid') === myId) {
      if (picker) { closePicker(); } else { openPicker(seat); }
    } else {
      closePicker();
    }
  });

  window.addEventListener('scroll', closePicker, true);

  /* ---------------- 启动 ---------------- */

  build();
  applyDock();

  var poller = U.createPoller(function () {
    return poll().catch(function (e) { console.warn('[chat]', e); });
  }, POLL_MS);

  GH.onReady(function (err) {
    if (err) { return; }
    poller.start();
  });

})();
