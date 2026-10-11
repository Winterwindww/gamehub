/* =========================================================
   联机游戏厅 · 欢乐扑克（界面层）
   ========================================================= */
(function () {
  'use strict';

  var SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };
  var PHASE_TXT = {
    idle: '等待开始',
    preflop: '翻牌前',
    flop: '翻牌',
    turn: '转牌',
    river: '河牌',
    showdown: '摊牌'
  };

  var params = new URLSearchParams(location.search);
  var roomCode = U.cleanCode(params.get('room'));
  var myId = U.getPlayerId();

  var room = null;
  var players = [];
  var st = null;
  var cfg = { startChips: 1000, smallBlind: 10, bigBlind: 20 };
  var myIdx = -1;
  var busy = false;
  var raiseValue = 0;
  var lastBeat = 0;
  var lastSig = '';
  var saturationWarned = false;

  var Snd = window.Snd || { play: function () { } };

  /* 动画状态 */
  var communitySlots = [];     // 5 张公共牌的固定 DOM 槽位
  var shownCommunity = 0;      // 已经翻开几张公共牌
  var revealRunning = false;   // 正在播放翻牌序列
  var tableAnimating = false;  // 动画期间先不公布结果、不亮牌
  var dealShown = null;        // { 座位号: 已发出几张底牌 }
  var dealRunning = false;
  var lastHandNo = -1;

  var elRoomCode = document.getElementById('roomCode');
  var elRoomBadge = document.getElementById('roomBadge');
  var elConnDot = document.getElementById('connDot');
  var elBlindInfo = document.getElementById('blindInfo');
  var elBanner = document.getElementById('resultBanner');
  var elPhaseTag = document.getElementById('phaseTag');
  var elCommunity = document.getElementById('communityCards');
  var elPot = document.getElementById('potDisplay');
  var elSeatLayer = document.getElementById('seatLayer');
  var elMyCards = document.getElementById('myCards');
  var elMyHandName = document.getElementById('myHandName');
  var elActionBar = document.getElementById('actionBar');
  var elTableCta = document.getElementById('tableCta');
  var elLog = document.getElementById('logPanel');
  var btnStart = document.getElementById('startHandBtn');
  var btnReset = document.getElementById('resetBtn');
  var elBack = document.getElementById('backBtn');

  if (!roomCode || roomCode.length !== 4) {
    document.body.innerHTML =
      '<div class="wrap"><div class="card"><h2>缺少房间码</h2>' +
      '<p class="hint">请回到大厅创建或加入一个房间。</p>' +
      '<a class="btn btn-primary" href="index.html" style="margin-top:14px">返回大厅</a></div></div>';
    return;
  }

  elRoomCode.textContent = roomCode;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function readCfg(c) {
    c = c || {};
    return {
      startChips: Number(c.startChips) || 1000,
      smallBlind: Number(c.smallBlind) || 10,
      bigBlind: Number(c.bigBlind) || 20
    };
  }

  /* ---------------- 云端 ---------------- */

  async function applyState(mutator, tries) {
    var max = tries || 6;
    for (var i = 0; i < max; i++) {
      var r = await GH.db.getRoom(roomCode);
      if (!r) { return { ok: false, error: '房间不存在' }; }
      var s = Poker.normalizeState(r.state || {}, cfg);
      var res = mutator(s);
      if (res === null || res === false) { return { ok: false, error: '' }; }
      if (res && res.ok === false) { return res; }
      var done = await GH.db.updateRoom(r, { state: s });
      if (done) { return { ok: true, room: done }; }
      await sleep(110);
    }
    return { ok: false, error: '操作冲突，请重试' };
  }

  async function ensureSeated() {
    if (Poker.indexOfPlayer(st, myId) >= 0) { return; }
    if (st.seats.length >= Poker.maxSeats(cfg)) {
      if (!saturationWarned) {
        saturationWarned = true;
        U.toast('桌子满了，你正在观战');
      }
      return;
    }
    var res = await applyState(function (s) {
      Poker.allocateSeat(s, myId, U.getNickname() || '玩家');
      return { ok: true };
    });
    if (res.ok) {
      adoptState(Poker.normalizeState(res.room.state, cfg));
    }
  }

  async function heartbeat() {
    var now = Date.now();
    if (now - lastBeat < 4000) { return; }
    lastBeat = now;
    var me = null;
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === myId) { me = players[i]; break; }
    }
    if (me) { try { await GH.db.touchPlayer(me); } catch (e) { /* 忽略 */ } }
  }

  async function cleanupIdle() {
    var now = Date.now();
    var stale = [];
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (p.player_id === myId) { continue; }
      if (now - new Date(p.last_seen).getTime() > 120000) { stale.push(p.player_id); }
    }
    if (!stale.length) { return; }

    var inHand = st.phase !== 'idle' && st.phase !== 'showdown';
    if (inHand) { return; }

    for (var k = 0; k < stale.length; k++) {
      try { await GH.db.removePlayer(roomCode, stale[k]); } catch (e) { /* 忽略 */ }
    }

    var need = false;
    for (var m = 0; m < st.seats.length; m++) {
      if (stale.indexOf(st.seats[m].playerId) >= 0) { need = true; break; }
    }
    if (!need) { return; }

    var res = await applyState(function (s) {
      stale.forEach(function (pid) { Poker.removeSeat(s, pid); });
      return { ok: true };
    });
    if (res.ok) {
      adoptState(Poker.normalizeState(res.room.state, cfg));
    }
  }

  async function handleTimeout() {
    if (!st || !Poker.isTimedOut(st)) { return; }
    var idx = st.turnSeat;
    var s = st.seats[idx];
    if (!s || s.folded || s.allIn) { return; }
    var la = Poker.legalActions(st, idx);
    if (!la) { return; }

    var action = la.canCheck ? 'check' : 'fold';
    var name = s.nickname;
    var res = await applyState(function (state) {
      var r = Poker.act(state, idx, action, 0);
      return r.ok ? { ok: true } : { ok: false, error: '' };
    });
    if (res.ok) {
      U.toast(name + ' 超时，自动' + (action === 'check' ? '过牌' : '放弃'));
      adoptState(Poker.normalizeState(res.room.state, cfg));
      renderAll();
    }
  }

  /* ---------------- 轮询 ---------------- */

  var poller = U.createPoller(async function () {
    var r = await GH.db.getRoom(roomCode);
    if (!r) { elConnDot.classList.add('off'); return; }

    room = r;
    cfg = readCfg(r.config);
    adoptState(Poker.normalizeState(r.state || {}, cfg));

    players = (await GH.db.listPlayers(roomCode)) || [];
    elConnDot.classList.remove('off');

    await heartbeat();
    await handleTimeout();
    await cleanupIdle();

    if (Poker.indexOfPlayer(st, myId) < 0) { await ensureSeated(); }

    // 动画播放中不打断（动画自己会渲染）
    if (!dealRunning && !revealRunning) { renderAll(); }
  }, 1300);

  function syncMine() {
    myIdx = Poker.indexOfPlayer(st, myId);
  }

  /* ---------------- 状态落库 + 音效 ---------------- */

  /*
   * 所有状态更新统一走 adoptState()。它在落状态之后对比前后差异，
   * 由「发生了什么」决定播什么音 —— 自己操作和别人操作走的是同一条路径，
   * 因此不会重复发声。
   */

  var prevSnap = null;
  var showdownAnnounced = -1;

  function snapOf(state) {
    return {
      phase: state.phase,
      handNo: state.handNo,
      turnSeat: state.turnSeat,
      community: (state.community || []).length,
      seats: (state.seats || []).map(function (s) {
        return {
          bet: s.bet || 0,
          folded: !!s.folded,
          allIn: !!s.allIn,
          inHand: !!s.inHand
        };
      })
    };
  }

  function adoptState(next) {
    st = next;
    syncMine();
    afterState();
  }

  function afterState() {
    var cur = snapOf(st);
    var prev = prevSnap;
    prevSnap = cur;

    if (!prev) {
      // 首次同步（进房间 / 刷新）：只对位，不补放历史音效
      if (st.phase === 'showdown') { showdownAnnounced = st.handNo; }
      return;
    }

    var newHand = cur.handNo !== prev.handNo;
    if (newHand) { showdownAnnounced = -1; }   // 新的一手，结果音可以重新播

    // 新的一手
    if (newHand && st.phase === 'preflop') { Snd.play('start'); }

    // 逐座位比对：放弃 / 全押 / 下注
    var betUp = false;
    var allInNow = false;
    for (var i = 0; i < cur.seats.length; i++) {
      var a = prev.seats[i];
      var b = cur.seats[i];
      if (!a || !b) { continue; }
      if (!a.folded && b.folded) { Snd.play('fold'); }
      if (!a.allIn && b.allIn) { allInNow = true; }
      if (b.bet > a.bet) { betUp = true; }
    }

    if (allInNow) { Snd.play('allin'); }
    else if (betUp && !newHand) { Snd.play('chip'); }

    // 过牌：行动权易手，但下注额没变、没人放弃，且还在同一条街
    var pa = prev.turnSeat;
    var sameStreet = (cur.phase === prev.phase && cur.community === prev.community);
    if (!allInNow && !betUp && sameStreet && pa !== null && pa !== undefined && pa !== cur.turnSeat) {
      var s0 = prev.seats[pa];
      var s1 = cur.seats[pa];
      if (s0 && s1 && s0.inHand && s1.inHand && !s0.folded && !s1.folded) {
        Snd.play('check');
      }
    }

    // 轮到我
    if (cur.turnSeat !== prev.turnSeat && cur.turnSeat === myIdx && myIdx >= 0
      && st.phase !== 'idle' && st.phase !== 'showdown') {
      Snd.play('turn');
    }

    // 本手结束：还有公共牌要翻就等动画放完（runRevealSequence 收尾时补播）
    if (cur.phase === 'showdown' && prev.phase !== 'showdown') {
      if (st.community.length <= shownCommunity) { announceShowdown(); }
    }
  }

  /** 本手结果音：赢 / 输（观战不发声），每手只播一次 */
  function announceShowdown() {
    if (!st || st.phase !== 'showdown') { return; }
    if (showdownAnnounced === st.handNo) { return; }
    showdownAnnounced = st.handNo;

    if (myIdx < 0) { return; }
    var res = (st.showdown && st.showdown.results) || [];
    for (var i = 0; i < res.length; i++) {
      if (res[i].i === myIdx) {
        Snd.play(res[i].won > 0 ? 'win' : 'lose');
        return;
      }
    }
  }

  /* ---------------- 提交动作 ---------------- */

  async function submit(idx, action, amount) {
    if (busy) { return; }
    busy = true;
    try {
      var res = await applyState(function (s) {
        var r = Poker.act(s, idx, action, amount);
        if (!r.ok) { return { ok: false, error: r.error }; }
        return { ok: true };
      });
      if (!res.ok && res.error) { U.toast(res.error, 'err'); }
      if (res.ok) {
        st = Poker.normalizeState(res.room.state, cfg);
        syncMine();
        lastSig = '';
        renderAll();
      }
    } catch (e) {
      U.toast('操作失败：' + GH.errText(e), 'err');
    }
    busy = false;
  }

  /* ---------------- 公共牌：发牌 + 翻牌动画 ---------------- */

  function buildCommunitySlots() {
    elCommunity.innerHTML = '';
    communitySlots = [];
    for (var i = 0; i < 5; i++) {
      var slot = document.createElement('div');
      slot.className = 'pcard-slot empty';

      var inner = document.createElement('div');
      inner.className = 'pcard-inner';

      var back = document.createElement('div');
      back.className = 'pcard pc-face pc-back';

      var front = document.createElement('div');
      front.className = 'pcard pc-face pc-front';

      inner.appendChild(back);
      inner.appendChild(front);
      slot.appendChild(inner);
      elCommunity.appendChild(slot);
      communitySlots.push(slot);
    }
  }

  function fillFront(slot, card) {
    var front = slot.querySelector('.pc-front');
    var red = (card.charAt(1) === 'h' || card.charAt(1) === 'd') ? ' red' : '';
    front.className = 'pcard pc-face pc-front' + red;
    front.innerHTML = '';
    var r = document.createElement('div');
    r.className = 'rk';
    r.textContent = (card.charAt(0) === 'T' ? '10' : card.charAt(0));
    var s = document.createElement('div');
    s.className = 'st';
    s.textContent = SUIT_SYM[card.charAt(1)] || '';
    front.appendChild(r);
    front.appendChild(s);
  }

  /** 先无过渡地摆成背面，下一帧再翻转，出来的就是"翻牌"效果 */
  function flipSlot(slot) {
    Snd.play('flip');
    var inner = slot.querySelector('.pcard-inner');
    inner.classList.add('no-anim');
    inner.classList.remove('flipped');
    void inner.offsetWidth;
    inner.classList.remove('no-anim');
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { inner.classList.add('flipped'); });
    });
    slot.classList.remove('pop');
    void slot.offsetWidth;
    slot.classList.add('pop');
  }

  function resetCommunitySlots() {
    shownCommunity = 0;
    communitySlots.forEach(function (slot) {
      var inner = slot.querySelector('.pcard-inner');
      inner.classList.add('no-anim');
      inner.classList.remove('flipped');
      void inner.offsetWidth;
      inner.classList.remove('no-anim');
      slot.classList.add('empty');
      slot.classList.remove('pop');
      slot.removeAttribute('data-card');
    });
  }

  /** 把公共牌区同步到「已经翻开 shownCommunity 张」的样子 */
  function syncCommunity() {
    if (!communitySlots.length) { buildCommunitySlots(); }
    var target = st.community.length;

    if (target < shownCommunity) { resetCommunitySlots(); }

    for (var i = 0; i < 5; i++) {
      var slot = communitySlots[i];
      var inner = slot.querySelector('.pcard-inner');
      if (i < shownCommunity) {
        var card = st.community[i];
        if (!card) { continue; }
        if (slot.getAttribute('data-card') !== card) {
          fillFront(slot, card);
          slot.setAttribute('data-card', card);
          slot.classList.remove('empty');
          flipSlot(slot);
        } else {
          slot.classList.remove('empty');
          inner.classList.add('flipped');
        }
      } else if (slot.getAttribute('data-card')) {
        slot.classList.add('empty');
        slot.removeAttribute('data-card');
        inner.classList.add('no-anim');
        inner.classList.remove('flipped');
        void inner.offsetWidth;
        inner.classList.remove('no-anim');
      } else {
        slot.classList.add('empty');
      }
    }

    // 本手提前结束、公共牌没发完时，空格子可以直接点开
    var canTap = boardRevealable();
    for (var t = 0; t < 5; t++) {
      communitySlots[t].classList.toggle('tappable', canTap && t >= shownCommunity);
    }

    if (target > shownCommunity && !revealRunning && !dealRunning) {
      runRevealSequence();
    }
  }

  /**
   * 逐段亮公共牌：翻牌 3 张错开翻，转牌、河牌各 1 张。
   * 全押之后一次性跑完 5 张时也走这条路径，所以不会再"啪一下全出来"。
   */
  async function runRevealSequence() {
    revealRunning = true;
    tableAnimating = true;
    try {
      while (true) {
        var target = st.community.length;
        if (target <= shownCommunity) { break; }

        var groupEnd = shownCommunity < 3 ? Math.min(3, target) : shownCommunity + 1;
        while (shownCommunity < groupEnd && shownCommunity < st.community.length) {
          shownCommunity++;
          syncCommunity();
          await sleep(175);
        }
        if (shownCommunity < st.community.length) { await sleep(540); }
      }
      await sleep(340);
    } finally {
      tableAnimating = false;
      revealRunning = false;
      renderAll();
      announceShowdown();      // 牌翻完了才揭晓，音效跟结果一起出
    }
  }

  /* ---------------- 底牌：发牌动画 ---------------- */

  function detectNewHand() {
    if (st.phase === 'idle') { lastHandNo = -1; dealShown = null; return; }
    if (st.handNo !== lastHandNo) {
      lastHandNo = st.handNo;
      // 只在真正开局时发牌；中途刷新不会重放
      if (st.phase === 'preflop' && !st.community.length) { playDeal(); }
    }
  }

  async function playDeal() {
    if (dealRunning) { return; }
    dealRunning = true;
    dealShown = {};
    try {
      await sleep(230);        // 这一步 renderAll 已把桌面摆成"空位"状态

      var order = [];
      for (var i = 0; i < st.seats.length; i++) {
        if (st.seats[i].inHand) { order.push(i); }
      }

      // 一圈一圈发，每次只替换对应位置的那张牌 —— 不整层重绘，动画就不会被打断
      for (var r = 0; r < 2; r++) {
        for (var k = 0; k < order.length; k++) {
          var idx = order[k];
          dealShown[idx] = (dealShown[idx] || 0) + 1;
          Snd.play('deal', { alt: (r + k) % 2 === 1 });
          placeDealtCard(idx, r);
          await sleep(150);
        }
      }
    } finally {
      dealShown = null;
      dealRunning = false;
      renderAll();
    }
  }

  function seatElByIndex(idx) {
    var s = st.seats[idx];
    if (!s) { return null; }
    var list = elSeatLayer.querySelectorAll('.pseat');
    for (var i = 0; i < list.length; i++) {
      if (list[i].getAttribute('data-pid') === s.playerId) { return list[i]; }
    }
    return null;
  }

  /** 把某个座位第 pos 张底牌替换成真牌，并播放"从桌心飞来"的动画 */
  function placeDealtCard(idx, pos) {
    var s = st.seats[idx];
    var seatEl = seatElByIndex(idx);
    if (!s || !seatEl || !s.hole || !s.hole[pos]) { return; }
    var holder = seatEl.querySelector('.pcards');
    if (!holder) { return; }

    var ce = cardEl(idx === myIdx ? s.hole[pos] : null, 'tiny');
    ce.classList.add('deal-in');
    if (idx !== myIdx) {
      var left = parseFloat(seatEl.style.left) || 50;
      var top = parseFloat(seatEl.style.top) || 50;
      ce.style.setProperty('--dx', Math.max(-120, Math.min(120, (50 - left) * 6)).toFixed(0) + 'px');
      ce.style.setProperty('--dy', Math.max(-130, Math.min(130, (48 - top) * 6)).toFixed(0) + 'px');
    }

    var old = holder.children[pos];
    if (old) { holder.replaceChild(ce, old); } else { holder.appendChild(ce); }

    if (idx === myIdx) {
      var mine = cardEl(s.hole[pos]);
      mine.classList.add('deal-in');
      var oldMine = elMyCards.children[pos];
      if (oldMine) { elMyCards.replaceChild(mine, oldMine); } else { elMyCards.appendChild(mine); }
      elMyHandName.textContent = '发牌中…';
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderAll() {
    detectNewHand();
    elBlindInfo.textContent = '注额 ' + cfg.smallBlind + ' / ' + cfg.bigBlind + '　初始 ' + cfg.startChips;
    renderBanner();
    renderTable();
    syncCommunity();
    renderMyHand();
    renderActions();
    renderLog();
    renderButtons();
  }

  function seatName(i) {
    var s = st.seats[i];
    return s ? s.nickname : '—';
  }

  function renderBanner() {
    var txt = '';
    if (tableAnimating && st.phase === 'showdown') {
      txt = '公共牌发放中…';
    } else if (st.phase === 'idle') {
      txt = st.seats.length < 2 ? '等同学进来后开牌（至少 2 人）' : '人到齐了，点下面的「开始这一手」';
    } else if (st.phase === 'showdown') {
      var res = (st.showdown && st.showdown.results) || [];
      var winners = res.filter(function (r) { return r.won > 0; });
      if (winners.length) {
        var unc = !!(st.showdown && st.showdown.uncontested);
        txt = winners.map(function (w) {
          if (unc) { return seatName(w.i) + ' 收下奖池 ' + U.money(w.won) + '（其他人都放弃了）'; }
          return seatName(w.i) + ' 以「' + w.name + '」赢得 ' + U.money(w.won);
        }).join(' · ');
      } else {
        txt = '本手结束';
      }
    } else if (st.turnSeat !== null && st.turnSeat !== undefined && st.seats[st.turnSeat]) {
      var s = st.seats[st.turnSeat];
      var left = st.turnDeadline ? Math.max(0, Math.ceil((st.turnDeadline - Date.now()) / 1000)) : 0;
      txt = '轮到 ' + s.nickname + (st.turnSeat === myIdx ? '（就是你）' : '') + ' · 剩余 ' + left + ' 秒';
    }
    elBanner.textContent = txt;
    elBanner.classList.toggle('hidden', !txt);
  }

  function cardEl(card, size) {
    var d = document.createElement('div');
    d.className = 'pcard' + (size ? ' ' + size : '');
    if (!card) { d.className += ' back'; return d; }
    var rank = card.charAt(0);
    var suit = card.charAt(1);
    if (suit === 'h' || suit === 'd') { d.className += ' red'; }
    var r = document.createElement('div');
    r.className = 'rk';
    r.textContent = (rank === 'T' ? '10' : rank);
    var s = document.createElement('div');
    s.className = 'st';
    s.textContent = SUIT_SYM[suit] || '';
    d.appendChild(r);
    d.appendChild(s);
    return d;
  }

  function isSeatOnline(playerId) {
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === playerId) { return U.isOnline(players[i].last_seen); }
    }
    return true;
  }

  function renderTable() {
    elPhaseTag.textContent = tableAnimating ? '发牌中' : (PHASE_TXT[st.phase] || '');
    elPot.innerHTML = '奖池 <span class="chip-ico"></span>' + U.money(Poker.potSize(st));

    elSeatLayer.innerHTML = '';
    var seats = st.seats || [];
    if (!seats.length) { return; }

    var n = seats.length;
    var base = myIdx >= 0 ? myIdx : 0;
    // 真正摊牌（多人比牌）时所有人的底牌都公开；别人放弃直接获胜时不公开
    var revealAll = st.phase === 'showdown' && !!(st.showdown && !st.showdown.uncontested) && !tableAnimating;
    var revealed = (st.showdown && st.showdown.revealed) || [];
    var showdownMap = {};
    if (st.showdown && st.showdown.results) {
      st.showdown.results.forEach(function (r) { showdownMap[r.i] = r; });
    }

    for (var pos = 0; pos < n; pos++) {
      var idx = (base + pos) % n;
      var s = seats[idx];

      var angle = Math.PI / 2 - (pos / n) * Math.PI * 2;
      var left = 50 + 43 * Math.cos(angle);
      var top = 50 + 40 * Math.sin(angle);

      var el = document.createElement('div');
      el.className = 'pseat';
      el.setAttribute('data-pid', s.playerId);
      el.style.left = left + '%';
      el.style.top = top + '%';
      if (idx === myIdx) { el.className += ' me'; }
      if (st.turnSeat === idx && st.phase !== 'idle' && st.phase !== 'showdown') { el.className += ' turn'; }
      if (s.folded) { el.className += ' folded'; }
      if (!isSeatOnline(s.playerId)) { el.className += ' offline'; }
      if (!tableAnimating && showdownMap[idx] && showdownMap[idx].won > 0) { el.className += ' winner'; }

      // 庄家 / 注额标记
      var badgeText = '';
      if (st.dealerSeat === idx && st.phase !== 'idle') { badgeText = 'D'; }
      if (st.sbSeat === idx && st.phase !== 'idle') { badgeText = badgeText ? badgeText + '/SB' : 'SB'; }
      if (st.bbSeat === idx && st.phase !== 'idle') { badgeText = badgeText ? badgeText + '/BB' : 'BB'; }
      if (badgeText) {
        var badge = document.createElement('div');
        badge.className = 'badge-mini';
        badge.textContent = badgeText;
        el.appendChild(badge);
      }

      // 昵称
      var nm = document.createElement('div');
      nm.className = 'pname';
      nm.textContent = s.nickname + (idx === myIdx ? '（你）' : '');
      el.appendChild(nm);

      // 手牌
      var cards = document.createElement('div');
      cards.className = 'pcards';
      var hole = s.hole || [];
      var shown = dealShown ? (dealShown[idx] || 0) : hole.length;
      if (hole.length) {
        var shownHere = (idx === myIdx) || revealed.indexOf(idx) >= 0 || (revealAll && !s.folded);
        for (var ci = 0; ci < hole.length; ci++) {
          var ce;
          if (ci < shown) {
            ce = cardEl(shownHere ? hole[ci] : null, 'tiny');
          } else {
            ce = document.createElement('div');
            ce.className = 'pcard tiny';
            ce.style.background = 'rgba(255,255,255,.06)';
            ce.style.boxShadow = 'none';
          }
          if (s.folded) { ce.classList.add('dim'); }
          cards.appendChild(ce);
        }
      } else {
        for (var h = 0; h < 2; h++) {
          var pe = document.createElement('div');
          pe.className = 'pcard tiny';
          pe.style.background = 'rgba(255,255,255,.06)';
          pe.style.boxShadow = 'none';
          cards.appendChild(pe);
        }
      }
      el.appendChild(cards);

      // 欢乐豆
      var ch = document.createElement('div');
      ch.className = 'pchips';
      ch.innerHTML = '<span class="chip-ico"></span>' + U.money(s.chips);
      el.appendChild(ch);

      // 本轮下注
      if (s.bet > 0 || s.allIn) {
        var bet = document.createElement('div');
        bet.className = 'bet-chip';
        var dx = (50 - left);
        var dy = (48 - top);
        var len = Math.sqrt(dx * dx + dy * dy) || 1;
        var ox = (dx / len) * 62;
        var oy = (dy / len) * 62;
        bet.style.left = '50%';
        bet.style.top = '50%';
        bet.style.transform = 'translate(calc(-50% + ' + ox.toFixed(1) + 'px), calc(-50% + ' + oy.toFixed(1) + 'px))';
        bet.textContent = s.allIn ? ('全押 ' + s.bet) : ('下注 ' + s.bet);
        el.appendChild(bet);
      }

      elSeatLayer.appendChild(el);
    }
  }

  function renderMyHand() {
    elMyCards.innerHTML = '';
    if (myIdx < 0) {
      elMyHandName.textContent = '观战中';
      return;
    }
    var s = st.seats[myIdx];
    if (!s || !s.hole || !s.hole.length) {
      elMyHandName.textContent = '还没发牌';
      return;
    }
    var shown = dealShown ? (dealShown[myIdx] || 0) : s.hole.length;
    for (var ci = 0; ci < s.hole.length; ci++) {
      if (ci >= shown) { continue; }          // 还没发到我
      var ce = cardEl(s.hole[ci]);
      if (s.folded) { ce.classList.add('dim'); }
      elMyCards.appendChild(ce);
    }

    if (dealShown && shown < s.hole.length) {
      elMyHandName.textContent = '发牌中…';
    } else if (s.folded) {
      elMyHandName.textContent = '已放弃';
    } else if (st.community.length >= 3) {
      var best = Poker.best7(s.hole.concat(st.community));
      elMyHandName.textContent = best ? best.name : '—';
    } else {
      elMyHandName.textContent = '底牌';
    }
  }

  function mkBtn(text, cls, onClick) {
    var b = document.createElement('button');
    b.className = cls;
    b.textContent = text;
    b.onclick = onClick;
    return b;
  }

  /**
   * 别人都放弃、我直接收下奖池时，底牌不公开。
   * 这时给我一个「展示我的手牌」按钮，亮不亮由我决定。
   */
  function addRevealButton() {
    if (st.phase !== 'showdown' || !st.showdown || myIdx < 0) { return; }
    if (!st.showdown.uncontested) { return; }        // 真摊牌时本来就全部亮牌
    if ((st.showdown.revealed || []).indexOf(myIdx) >= 0) { return; }

    var me = st.seats[myIdx];
    if (!me || !me.hole || !me.hole.length) { return; }

    var results = st.showdown.results || [];
    var mine = null;
    for (var i = 0; i < results.length; i++) {
      if (results[i].i === myIdx) { mine = results[i]; break; }
    }
    if (!mine || !mine.won) { return; }

    elActionBar.appendChild(mkBtn('展示我的手牌', 'btn btn-gold', submitReveal));
  }

  async function submitReveal() {
    if (busy) { return; }
    busy = true;
    try {
      var res = await applyState(function (s) {
        var r = Poker.revealHand(s, myIdx);
        if (!r.ok) { return { ok: false, error: r.error }; }
        return { ok: true };
      });
      if (!res.ok && res.error) { U.toast(res.error, 'err'); }
      if (res.ok) {
        st = Poker.normalizeState(res.room.state, cfg);
        syncMine();
        lastSig = '';
        renderAll();
      }
    } catch (e) {
      U.toast('操作失败：' + GH.errText(e), 'err');
    }
    busy = false;
  }

  /**
   * 我能不能「补发剩下的公共牌」？
   * 别人全放弃、本手提前结束时，公共牌还剩几张没发，桌上任何人都能点。
   * 纯看着爽，不影响任何结算。
   */
  function boardRevealable() {
    if (!st || tableAnimating || myIdx < 0) { return false; }
    if (st.phase !== 'showdown' || !st.showdown) { return false; }
    if (!st.showdown.uncontested || st.showdown.boardRevealed) { return false; }
    return st.community.length < 5;
  }

  function addBoardRevealButton() {
    if (!boardRevealable()) { return; }
    elActionBar.appendChild(mkBtn('翻开剩下的公牌', 'btn btn-gold', submitBoardReveal));
  }

  async function submitBoardReveal() {
    if (busy) { return; }
    busy = true;
    try {
      var res = await applyState(function (s) {
        var r = Poker.revealBoard(s, myIdx);
        if (!r.ok) { return { ok: false, error: r.error }; }
        return { ok: true };
      });
      if (!res.ok && res.error) { U.toast(res.error, 'err'); }
      if (res.ok) {
        st = Poker.normalizeState(res.room.state, cfg);
        syncMine();
        lastSig = '';
        renderAll();          // syncCommunity 会自动接着播剩下的翻牌动画
      }
    } catch (e) {
      U.toast('操作失败：' + GH.errText(e), 'err');
    }
    busy = false;
  }

  function renderActions() {
    if (tableAnimating) {
      if (lastSig === 'animating') { return; }
      lastSig = 'animating';
      elActionBar.innerHTML = '';
      var an = document.createElement('div');
      an.className = 'waiting-note';
      an.innerHTML = '<span class="pulse-dot"></span>公共牌发放中…';
      elActionBar.appendChild(an);
      return;
    }

    var meSeat = myIdx >= 0 ? st.seats[myIdx] : null;
    var sig = JSON.stringify([
      myIdx, st.phase, st.turnSeat, st.currentBet,
      meSeat ? meSeat.bet : null, meSeat ? meSeat.chips : null, meSeat ? meSeat.folded : null,
      st.community ? st.community.length : 0,
      st.showdown ? (st.showdown.revealed || []).join(',') : '',
      st.showdown && st.showdown.boardRevealed ? 1 : 0
    ]);
    if (sig === lastSig && elActionBar.children.length) { return; }
    lastSig = sig;

    elActionBar.innerHTML = '';

    var la = null;
    if (myIdx >= 0 && st.phase !== 'idle' && st.phase !== 'showdown') {
      la = Poker.legalActions(st, myIdx);
    }

    if (!la) {
      addRevealButton();
      addBoardRevealButton();

      var note = document.createElement('div');
      note.className = 'waiting-note';
      if (myIdx < 0) {
        note.textContent = '你在观战 · 回合结束或有座位空出时可以入座';
      } else if (st.phase === 'idle') {
        note.textContent = '等待开始 · 牌局开始后这里会显示操作按钮';
      } else if (st.phase === 'showdown') {
        note.textContent = '本手已结束，准备下一手';
      } else {
        var ts = st.seats[st.turnSeat];
        note.textContent = '等待 ' + (ts ? ts.nickname : '对手') + ' 行动…';
      }
      elActionBar.appendChild(note);
      return;
    }

    elActionBar.appendChild(mkBtn('放弃', 'btn btn-danger', function () {
      submit(myIdx, 'fold');
    }));

    var callLabel = la.canCheck ? '过牌' : ('跟注 ' + la.toCall + (la.allInCall ? '（全押）' : ''));
    elActionBar.appendChild(mkBtn(callLabel, 'btn btn-primary', function () {
      submit(myIdx, la.canCheck ? 'check' : 'call');
    }));

    if (la.canRaise) {
      var minTo = la.minRaiseTo;
      var maxTo = la.maxRaiseTo;
      var potNow = Poker.potSize(st);

      var clampTo = function (v) {
        v = Math.floor(Number(v));
        if (!isFinite(v) || isNaN(v)) { return minTo; }
        if (v < minTo) { return minTo; }
        if (v > maxTo) { return maxTo; }
        return v;
      };

      if (raiseValue < minTo || raiseValue > maxTo || !raiseValue) { raiseValue = minTo; }

      var slider = document.createElement('input');
      slider.type = 'range';
      slider.min = minTo;
      slider.max = maxTo;
      slider.step = 1;
      slider.value = raiseValue;

      var bRaise = mkBtn('加注到 ' + raiseValue, 'btn', function () {
        submit(myIdx, 'raise', raiseValue);
      });

      var num = document.createElement('input');
      num.type = 'number';
      num.className = 'raise-input';
      num.inputMode = 'numeric';
      num.min = minTo;
      num.max = maxTo;
      num.step = 1;
      num.value = raiseValue;

      var sync = function (v, skip) {
        raiseValue = clampTo(v);
        if (skip !== 'slider') { slider.value = raiseValue; }
        if (skip !== 'num') { num.value = raiseValue; }
        bRaise.textContent = '加注到 ' + raiseValue;
      };

      slider.oninput = function () { sync(slider.value, 'slider'); };

      // 输入过程中不打断：区间内实时同步，离开输入框或回车时再归位
      num.oninput = function () {
        var v = Math.floor(Number(num.value));
        if (!isFinite(v) || isNaN(v)) { return; }
        if (v < minTo || v > maxTo) { return; }
        raiseValue = v;
        slider.value = v;
        bRaise.textContent = '加注到 ' + v;
      };
      num.onblur = function () { sync(num.value, 'num'); };
      num.onkeydown = function (e) {
        if (e.key === 'Enter') {
          e.preventDefault();
          sync(num.value, 'num');
          submit(myIdx, 'raise', raiseValue);
        }
      };

      var bAllIn = mkBtn('全押 ' + maxTo, 'btn btn-gold', function () {
        submit(myIdx, 'raise', maxTo);
      });

      var quick = document.createElement('div');
      quick.className = 'raise-quick';
      [
        { t: '最小', v: minTo },
        { t: '半池', v: st.currentBet + Math.round(potNow * 0.5) },
        { t: '池底', v: st.currentBet + potNow },
        { t: '全押', v: maxTo }
      ].forEach(function (o) {
        quick.appendChild(mkBtn(o.t, 'btn btn-sm', function () { sync(o.v); }));
      });

      var box = document.createElement('div');
      box.className = 'raise-box';
      box.appendChild(slider);
      box.appendChild(num);

      elActionBar.appendChild(bRaise);
      elActionBar.appendChild(bAllIn);
      elActionBar.appendChild(box);
      elActionBar.appendChild(quick);
    }
  }

  function renderLog() {
    if (tableAnimating) { return; }          // 动画期间先别剧透
    elLog.innerHTML = '';
    var logs = (st.log || []).slice(-24);
    logs.forEach(function (l) {
      var d = document.createElement('div');
      d.className = 'li' + (l.hi ? ' hi' : '');
      d.textContent = l.text;
      elLog.appendChild(d);
    });
    elLog.scrollTop = elLog.scrollHeight;
  }

  function renderButtons() {
    var cs = Poker.canStart(st);
    var seated = myIdx >= 0;

    if (st.phase === 'idle') { btnStart.textContent = '开始这一手'; }
    else if (st.phase === 'showdown') { btnStart.textContent = '下一手'; }
    else { btnStart.textContent = '这一手进行中…'; }

    btnStart.disabled = !cs.ok || !seated;
    btnReset.disabled = !seated;

    // 「开始这一手 / 下一手」只在等待开局和本手结束时出现在牌桌内，
    // 牌局进行中隐藏，避免挡住桌面。
    var waiting = (st.phase === 'idle' || st.phase === 'showdown') && !tableAnimating;
    if (elTableCta) { elTableCta.classList.toggle('hidden', !waiting); }
  }

  /* ---------------- 按钮 ---------------- */

  // 空着的公共牌位也能直接点，跟「翻开剩下的公牌」按钮是同一件事
  elCommunity.addEventListener('click', function () {
    if (!boardRevealable()) { return; }
    submitBoardReveal();
  });

  btnStart.addEventListener('click', async function () {
    if (busy) { return; }
    busy = true;
    var res = await applyState(function (s) {
      var r = Poker.startHand(s);
      if (!r.ok) { return { ok: false, error: r.reason || '无法开始' }; }
      return { ok: true };
    });
    if (!res.ok && res.error) { U.toast(res.error, 'err'); }
    if (res.ok) {
      adoptState(Poker.normalizeState(res.room.state, cfg));
      lastSig = '';
      renderAll();
    }
    busy = false;
  });

  btnReset.addEventListener('click', async function () {
    var ok = await U.confirm('重置欢乐豆', '所有人欢乐豆回到初始值，牌局重新开始。确定吗？', '确定重置');
    if (!ok) { return; }
    var res = await applyState(function (s) {
      Poker.resetChips(s);
      return { ok: true };
    });
    if (res.ok) {
      adoptState(Poker.normalizeState(res.room.state, cfg));
      lastSig = '';
      renderAll();
      U.toast('欢乐豆已重置', 'ok');
    }
  });

  elRoomBadge.addEventListener('click', function () {
    var url = location.origin + location.pathname + '?room=' + roomCode;
    U.copyText(url).then(function (ok) {
      if (ok) { U.toast('邀请链接已复制，发给同学即可', 'ok'); }
      else { U.alert('邀请链接', url); }
    });
  });

  elBack.addEventListener('click', async function () {
    poller.stop();
    try { await GH.db.removePlayer(roomCode, myId); } catch (e) { /* 忽略 */ }
    location.href = 'index.html';
  });

  /* ---------------- 启动 ---------------- */

  GH.onReady(async function (err) {
    if (err) { U.toast(err, 'err'); return; }
    try {
      var r = await GH.db.getRoom(roomCode);
      if (!r) {
        U.toast('房间不存在或已结束', 'err');
        setTimeout(function () { location.href = 'index.html'; }, 1400);
        return;
      }
      if (r.game_type !== 'poker') {
        location.href = 'gomoku.html?room=' + roomCode;
        return;
      }
      room = r;
      cfg = readCfg(r.config);
      adoptState(Poker.normalizeState(r.state || {}, cfg));

      players = (await GH.db.listPlayers(roomCode)) || [];
      await ensureSeated();

      renderAll();
      poller.start();
    } catch (e) {
      U.toast('进入房间失败：' + GH.errText(e), 'err');
    }
  });

})();
