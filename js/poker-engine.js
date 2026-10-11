/* =========================================================
   联机游戏厅 · 欢乐扑克规则引擎
   ---------------------------------------------------------
   纯逻辑，不碰 DOM。state 结构说明：
   {
     handNo, phase, dealerSeat, community[], deck[],
     currentBet, minRaise, turnSeat, turnDeadline,
     smallBlind, bigBlind, startChips,
     seats: [ { i, playerId, nickname, chips, bet, totalBet,
                folded, allIn, acted, hole[], inHand } ],
     log: [ { t, text, hi } ],
     showdown: null | { results, pots }
   }
   ========================================================= */
(function (global) {
  'use strict';

  var SUITS = ['s', 'h', 'd', 'c'];
  var RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];
  var RANK_VAL = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8, '9': 9, 'T': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14 };
  var CAT_NAME = { 8: '同花顺', 7: '四条', 6: '葫芦', 5: '同花', 4: '顺子', 3: '三条', 2: '两对', 1: '一对', 0: '高牌' };
  var ACTION_TIMEOUT_MS = 45000;
  var SUIT_SYM = { s: '♠', h: '♥', d: '♦', c: '♣' };

  function cardText(c) {
    var s = String(c || '');
    if (!s) { return ''; }
    var r = s.charAt(0);
    return (r === 'T' ? '10' : r) + (SUIT_SYM[s.charAt(1)] || '');
  }

  function fmtCards(cs) {
    return (cs || []).map(cardText).join(' ');
  }

  /* ---------------- 牌 ---------------- */

  function newDeck() {
    var d = [];
    for (var i = 0; i < SUITS.length; i++) {
      for (var j = 0; j < RANKS.length; j++) {
        d.push(RANKS[j] + SUITS[i]);
      }
    }
    return d;
  }

  function shuffle(arr) {
    var a = arr.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  function rankOf(c) { return RANK_VAL[c.charAt(0)]; }
  function suitOf(c) { return c.charAt(1); }

  /* ---------------- 牌型评估 ---------------- */

  function eval5(cards) {
    var ranks = cards.map(rankOf).sort(function (a, b) { return b - a; });
    var suits = cards.map(suitOf);
    var isFlush = suits[0] === suits[1] && suits[1] === suits[2] && suits[2] === suits[3] && suits[3] === suits[4];

    var uniq = [];
    for (var i = 0; i < ranks.length; i++) {
      if (uniq.indexOf(ranks[i]) < 0) { uniq.push(ranks[i]); }
    }

    var isStraight = false;
    var sHigh = 0;
    if (uniq.length === 5) {
      if (uniq[0] - uniq[4] === 4) { isStraight = true; sHigh = uniq[0]; }
      else if (uniq[0] === 14 && uniq[1] === 5) { isStraight = true; sHigh = 5; }
    }

    var counts = {};
    for (var k = 0; k < ranks.length; k++) { counts[ranks[k]] = (counts[ranks[k]] || 0) + 1; }
    var groups = Object.keys(counts).map(function (r) {
      return { r: Number(r), n: counts[r] };
    }).sort(function (a, b) { return b.n - a.n || b.r - a.r; });

    if (isStraight && isFlush) { return [8, sHigh]; }
    if (groups[0].n === 4) { return [7, groups[0].r, groups[1].r]; }
    if (groups[0].n === 3 && groups[1].n === 2) { return [6, groups[0].r, groups[1].r]; }
    if (isFlush) { return [5].concat(ranks); }
    if (isStraight) { return [4, sHigh]; }
    if (groups[0].n === 3) { return [3, groups[0].r, groups[1].r, groups[2].r]; }
    if (groups[0].n === 2 && groups[1].n === 2) { return [2, groups[0].r, groups[1].r, groups[2].r]; }
    if (groups[0].n === 2) { return [1, groups[0].r, groups[1].r, groups[2].r, groups[3].r]; }
    return [0].concat(ranks);
  }

  function cmpScore(a, b) {
    var n = Math.max(a.length, b.length);
    for (var i = 0; i < n; i++) {
      var x = a[i] || 0;
      var y = b[i] || 0;
      if (x !== y) { return x - y; }
    }
    return 0;
  }

  function best7(cards) {
    if (!cards || cards.length < 5) { return null; }
    var n = cards.length;
    var best = null;
    var bestCards = null;
    for (var i = 0; i < n - 4; i++) {
      for (var j = i + 1; j < n - 3; j++) {
        for (var k = j + 1; k < n - 2; k++) {
          for (var l = k + 1; l < n - 1; l++) {
            for (var m = l + 1; m < n; m++) {
              var five = [cards[i], cards[j], cards[k], cards[l], cards[m]];
              var sc = eval5(five);
              if (!best || cmpScore(sc, best) > 0) { best = sc; bestCards = five; }
            }
          }
        }
      }
    }
    return { score: best, name: nameOf(best), cards: bestCards };
  }

  function nameOf(sc) {
    if (!sc) { return '—'; }
    var cat = sc[0];
    if (cat === 8 && sc[1] === 14) { return '皇家同花顺'; }
    return CAT_NAME[cat] || '—';
  }

  /* ---------------- 初始化 / 座位 ---------------- */

  function newState(cfg) {
    return {
      handNo: 0,
      phase: 'idle',
      dealerSeat: -1,
      community: [],
      deck: [],
      currentBet: 0,
      minRaise: cfg.bigBlind,
      turnSeat: null,
      turnDeadline: null,
      smallBlind: cfg.smallBlind,
      bigBlind: cfg.bigBlind,
      startChips: cfg.startChips,
      seats: [],
      log: [],
      showdown: null
    };
  }

  function normalizeState(state, cfg) {
    if (!state || typeof state !== 'object') { state = {}; }
    if (!Array.isArray(state.seats)) { state.seats = []; }
    if (!Array.isArray(state.community)) { state.community = []; }
    if (!Array.isArray(state.deck)) { state.deck = []; }
    if (!Array.isArray(state.log)) { state.log = []; }
    if (typeof state.handNo !== 'number') { state.handNo = 0; }
    if (typeof state.dealerSeat !== 'number') { state.dealerSeat = -1; }
    if (typeof state.phase !== 'string') { state.phase = 'idle'; }
    if (typeof state.currentBet !== 'number') { state.currentBet = 0; }
    if (typeof state.minRaise !== 'number') { state.minRaise = cfg.bigBlind; }
    if (state.smallBlind == null) { state.smallBlind = cfg.smallBlind; }
    if (state.bigBlind == null) { state.bigBlind = cfg.bigBlind; }
    if (state.startChips == null) { state.startChips = cfg.startChips; }
    if (state.turnSeat === undefined) { state.turnSeat = null; }
    if (state.showdown === undefined) { state.showdown = null; }
    return state;
  }

  function maxSeats(cfg) { return 6; }

  /** 返回 0..5 中第一个未被占用的座位号，没有则返回 -1 */
  function freeSeatNo(state) {
    var used = {};
    for (var i = 0; i < state.seats.length; i++) { used[state.seats[i].seatNo] = true; }
    for (var s = 0; s < 6; s++) { if (!used[s]) { return s; } }
    return -1;
  }

  /** 幂等地把玩家放进牌桌；已有座位则只刷新昵称 */
  function allocateSeat(state, playerId, nickname) {
    var existing = null;
    for (var i = 0; i < state.seats.length; i++) {
      if (state.seats[i].playerId === playerId) { existing = state.seats[i]; break; }
    }
    if (existing) { existing.nickname = nickname; return existing; }

    var seatNo = freeSeatNo(state);
    if (seatNo < 0) { return null; }

    var seat = {
      seatNo: seatNo,
      playerId: playerId,
      nickname: nickname,
      chips: state.startChips || 1000,
      bet: 0,
      totalBet: 0,
      folded: false,
      allIn: false,
      acted: false,
      hole: [],
      inHand: false
    };
    state.seats.push(seat);
    reindex(state);
    return seat;
  }

  function reindex(state) {
    state.seats.sort(function (a, b) { return a.seatNo - b.seatNo; });
    for (var i = 0; i < state.seats.length; i++) { state.seats[i].i = i; }
  }

  function indexOfPlayer(state, playerId) {
    for (var i = 0; i < state.seats.length; i++) {
      if (state.seats[i].playerId === playerId) { return i; }
    }
    return -1;
  }

  function removeSeat(state, playerId) {
    for (var i = state.seats.length - 1; i >= 0; i--) {
      if (state.seats[i].playerId === playerId) { state.seats.splice(i, 1); }
    }
    reindex(state);
  }

  function potSize(state) {
    var sum = 0;
    for (var i = 0; i < state.seats.length; i++) { sum += state.seats[i].totalBet || 0; }
    return sum;
  }

  /* ---------------- 日志 ---------------- */

  function pushLog(state, text, hi) {
    state.log.push({ t: Date.now(), text: text, hi: !!hi });
    if (state.log.length > 40) { state.log = state.log.slice(-40); }
  }

  /* ---------------- 发牌 ---------------- */

  function nextInList(list, current) {
    if (!list.length) { return null; }
    var idx = list.indexOf(current);
    if (idx < 0) { return list[0]; }
    return list[(idx + 1) % list.length];
  }

  function postBlind(state, idx, amount) {
    var s = state.seats[idx];
    var pay = Math.min(amount, s.chips);
    s.chips -= pay;
    s.bet += pay;
    s.totalBet += pay;
    if (s.chips === 0) { s.allIn = true; }
  }

  function canStart(state) {
    var alive = 0;
    for (var i = 0; i < state.seats.length; i++) {
      if (state.seats[i].chips > 0) { alive++; }
    }
    if (state.seats.length < 2) { return { ok: false, reason: '至少要 2 位玩家上桌' }; }
    if (alive < 2) { return { ok: false, reason: '欢乐豆为 0 的玩家太多了，先重置欢乐豆' }; }
    if (state.phase !== 'idle' && state.phase !== 'showdown') { return { ok: false, reason: '这一手还没结束' }; }
    return { ok: true };
  }

  function startHand(state) {
    var chk = canStart(state);
    if (!chk.ok) { return chk; }

    var seats = state.seats;

    // 重置本手
    for (var i = 0; i < seats.length; i++) {
      var s = seats[i];
      s.bet = 0;
      s.totalBet = 0;
      s.folded = false;
      s.allIn = false;
      s.acted = false;
      s.hole = [];
      s.inHand = s.chips > 0;
    }

    var playing = [];
    for (var j = 0; j < seats.length; j++) {
      if (seats[j].inHand) { playing.push(j); }
    }

    // 庄家轮转
    state.dealerSeat = nextInList(playing, state.dealerSeat);
    if (state.dealerSeat === null || state.dealerSeat === undefined) { state.dealerSeat = playing[0]; }

    // 洗牌
    state.deck = shuffle(newDeck());
    state.community = [];
    state.showdown = null;
    state.phase = 'preflop';
    state.handNo = (state.handNo || 0) + 1;
    state.currentBet = 0;
    state.minRaise = state.bigBlind;
    state.log = [];

    // 注额位
    var sbIdx;
    var bbIdx;
    var firstIdx;
    if (playing.length === 2) {
      sbIdx = state.dealerSeat;
      bbIdx = nextInList(playing, sbIdx);
      firstIdx = sbIdx;
    } else {
      sbIdx = nextInList(playing, state.dealerSeat);
      bbIdx = nextInList(playing, sbIdx);
      firstIdx = nextInList(playing, bbIdx);
    }
    state.sbSeat = sbIdx;
    state.bbSeat = bbIdx;

    // 发底牌
    for (var r = 0; r < 2; r++) {
      for (var p = 0; p < playing.length; p++) {
        seats[playing[p]].hole.push(state.deck.pop());
      }
    }

    postBlind(state, sbIdx, state.smallBlind);
    postBlind(state, bbIdx, state.bigBlind);

    state.currentBet = state.bigBlind;
    state.minRaise = state.bigBlind;
    state.turnSeat = firstIdx - 1;      // progress 会从 firstIdx 开始找第一位行动者
    state.turnDeadline = Date.now() + ACTION_TIMEOUT_MS;

    pushLog(state, '第 ' + state.handNo + ' 手开始', true);
    pushLog(state, seats[sbIdx].nickname + ' 小注 ' + state.smallBlind + ' / ' + seats[bbIdx].nickname + ' 大注 ' + state.bigBlind);

    var pr = progress(state);
    if (pr && pr.type === 'error') { return { ok: false, reason: '牌局状态异常' }; }
    return { ok: true };
  }

  /* ---------------- 行动 ---------------- */

  function legalActions(state, idx) {
    var s = state.seats[idx];
    if (!s) { return null; }
    if (state.turnSeat !== idx) { return null; }
    if (state.phase === 'idle' || state.phase === 'showdown') { return null; }
    if (s.folded || s.allIn || s.chips <= 0) { return null; }

    var toCall = Math.max(0, state.currentBet - s.bet);
    var maxTo = s.bet + s.chips;

    var othersCanAct = false;
    for (var q = 0; q < state.seats.length; q++) {
      if (q === idx) { continue; }
      var o = state.seats[q];
      if (o.inHand && !o.folded && !o.allIn && o.chips > 0) { othersCanAct = true; break; }
    }

    var canRaise = maxTo > state.currentBet && othersCanAct;
    var minTo = Math.min(state.currentBet + state.minRaise, maxTo);

    return {
      toCall: Math.min(toCall, s.chips),
      canCheck: toCall === 0,
      canRaise: canRaise,
      minRaiseTo: minTo,
      maxRaiseTo: maxTo,
      allInCall: toCall >= s.chips
    };
  }

  function act(state, idx, action, amount) {
    var s = state.seats[idx];
    if (!s) { return { ok: false, error: '座位不存在' }; }
    if (state.turnSeat !== idx) { return { ok: false, error: '还没轮到你' }; }
    if (state.phase === 'idle' || state.phase === 'showdown') { return { ok: false, error: '当前不能行动' }; }
    if (s.folded || s.allIn || s.chips <= 0) { return { ok: false, error: '该玩家无法行动' }; }

    var toCall = Math.max(0, state.currentBet - s.bet);

    if (action === 'fold') {
      s.folded = true;
      s.acted = true;
      pushLog(state, s.nickname + ' 放弃');
    } else if (action === 'check') {
      if (toCall > 0) { return { ok: false, error: '有人下注，不能过牌' }; }
      s.acted = true;
      pushLog(state, s.nickname + ' 过牌');
    } else if (action === 'call') {
      if (toCall === 0) {
        s.acted = true;
        pushLog(state, s.nickname + ' 过牌');
      } else {
        var pay = Math.min(toCall, s.chips);
        s.chips -= pay;
        s.bet += pay;
        s.totalBet += pay;
        if (s.chips === 0) { s.allIn = true; }
        s.acted = true;
        pushLog(state, s.nickname + (s.allIn ? ' 全押 ' : ' 跟注 ') + pay);
      }
    } else if (action === 'raise') {
      var maxTo = s.bet + s.chips;
      var target = Math.floor(Number(amount) || 0);
      if (target > maxTo) { target = maxTo; }
      if (target <= state.currentBet) { return { ok: false, error: '加注额必须高于当前注额' }; }

      var isAllIn = (target === maxTo);
      var raiseBy = target - state.currentBet;
      if (!isAllIn && raiseBy < state.minRaise) {
        return { ok: false, error: '最少要加注 ' + state.minRaise };
      }

      var pay2 = target - s.bet;
      s.chips -= pay2;
      s.bet = target;
      s.totalBet += pay2;
      if (s.chips === 0) { s.allIn = true; }
      if (raiseBy >= state.minRaise) { state.minRaise = raiseBy; }
      state.currentBet = target;
      s.acted = true;

      for (var o = 0; o < state.seats.length; o++) {
        var other = state.seats[o];
        if (o !== idx && other.inHand && !other.folded && !other.allIn) { other.acted = false; }
      }

      pushLog(state, s.nickname + (s.allIn ? ' 全押到 ' : ' 加注到 ') + target, true);
    } else {
      return { ok: false, error: '未知操作' };
    }

    return resolveAfterProgress(state) || { ok: true };
  }

  /** 行动后推进牌局；返回 progress 的结果（可能直接结算） */
  function resolveAfterProgress(state) {
    var r = progress(state);
    if (r && r.type === 'error') { return { ok: false, error: '牌局状态异常' }; }
    return { ok: true, advanced: r ? r.type : 'continue' };
  }

  function nextActor(state, start) {
    var n = state.seats.length;
    for (var k = 0; k < n; k++) {
      var idx = ((start + k) % n + n) % n;
      var s = state.seats[idx];
      if (s && s.inHand && !s.folded && !s.allIn && s.chips > 0 && !s.acted) { return idx; }
    }
    return null;
  }

  function progress(state) {
    for (var guard = 0; guard < 30; guard++) {
      var seats = state.seats;
      var active = [];
      for (var i = 0; i < seats.length; i++) {
        if (seats[i].inHand && !seats[i].folded) { active.push(seats[i]); }
      }

      if (active.length <= 1) {
        return awardUncontested(state, active);
      }

      var canAct = [];
      for (var a = 0; a < active.length; a++) {
        if (!active[a].allIn && active[a].chips > 0) { canAct.push(active[a]); }
      }

      var allMatched = true;
      for (var b = 0; b < active.length; b++) {
        if (!active[b].allIn && active[b].bet !== state.currentBet) { allMatched = false; break; }
      }

      var allActed = true;
      for (var c = 0; c < canAct.length; c++) {
        if (!canAct[c].acted) { allActed = false; break; }
      }

      if (canAct.length <= 1 && allMatched) {
        return runOut(state);
      }

      if (allActed && allMatched) {
        if (state.phase === 'river') { return doShowdown(state); }
        for (var d = 0; d < seats.length; d++) { seats[d].bet = 0; seats[d].acted = false; }
        state.currentBet = 0;
        state.minRaise = state.bigBlind;
        dealNext(state);
        state.turnSeat = null;
        state.turnDeadline = null;
        continue;
      }

      var start;
      if (state.turnSeat === null || state.turnSeat === undefined) {
        start = state.dealerSeat + 1;
      } else {
        start = state.turnSeat + 1;
      }
      var nxt = nextActor(state, start);
      if (nxt === null) {
        for (var e = 0; e < canAct.length; e++) { canAct[e].acted = true; }
        continue;
      }
      state.turnSeat = nxt;
      state.turnDeadline = Date.now() + ACTION_TIMEOUT_MS;
      return { type: 'continue' };
    }
    return { type: 'error' };
  }

  function dealNext(state) {
    if (state.phase === 'preflop') {
      state.phase = 'flop';
      state.deck.pop();                            // 烧牌
      state.community.push(state.deck.pop(), state.deck.pop(), state.deck.pop());
      pushLog(state, '翻牌：' + fmtCards(state.community));
    } else if (state.phase === 'flop') {
      state.phase = 'turn';
      state.deck.pop();
      state.community.push(state.deck.pop());
      pushLog(state, '转牌：' + cardText(state.community[3]));
    } else if (state.phase === 'turn') {
      state.phase = 'river';
      state.deck.pop();
      state.community.push(state.deck.pop());
      pushLog(state, '河牌：' + cardText(state.community[4]));
    }
  }

  function runOut(state) {
    while (state.community.length < 5) {
      state.deck.pop();
      state.community.push(state.deck.pop());
    }
    for (var i = 0; i < state.seats.length; i++) {
      state.seats[i].bet = 0;
      state.seats[i].acted = false;
    }
    state.currentBet = 0;
    pushLog(state, '剩余公共牌全部发出', true);
    return doShowdown(state);
  }

  function awardUncontested(state, active) {
    var pot = potSize(state);
    var winner = active[0];
    if (winner) {
      winner.chips += pot;
      pushLog(state, winner.nickname + ' 赢得奖池 ' + pot, true);
    }
    for (var i = 0; i < state.seats.length; i++) {
      state.seats[i].bet = 0;
      state.seats[i].totalBet = 0;
      state.seats[i].acted = false;
    }
    state.phase = 'showdown';
    state.turnSeat = null;
    state.turnDeadline = null;
    state.showdown = {
      at: Date.now(),
      uncontested: true,
      results: winner ? [{ i: winner.i, name: '其他人都放弃了', won: pot }] : [],
      pots: [{ amount: pot, eligible: winner ? [winner.i] : [] }],
      revealed: []
    };
    return { type: 'win' };
  }

  /* ---------------- 边池与摊牌 ---------------- */

  function buildPots(state) {
    var seats = state.seats;
    var contributors = seats.filter(function (s) { return s.totalBet > 0; });
    var levels = [];
    contributors.forEach(function (s) {
      if (levels.indexOf(s.totalBet) < 0) { levels.push(s.totalBet); }
    });
    levels.sort(function (a, b) { return a - b; });

    var pots = [];
    var prev = 0;
    levels.forEach(function (lv) {
      var amount = 0;
      contributors.forEach(function (s) {
        amount += Math.min(s.totalBet, lv) - Math.min(s.totalBet, prev);
      });
      var eligible = seats.filter(function (s) {
        return s.inHand && !s.folded && s.totalBet >= lv;
      }).map(function (s) { return s.i; });
      if (amount > 0) { pots.push({ amount: amount, eligible: eligible }); }
      prev = lv;
    });
    return pots;
  }

  function doShowdown(state) {
    var seats = state.seats;
    var active = seats.filter(function (s) { return s.inHand && !s.folded; });

    var evals = {};
    active.forEach(function (s) {
      var seven = s.hole.concat(state.community);
      var best = best7(seven);
      evals[s.i] = best ? { score: best.score, name: best.name, cards: best.cards } : { score: [0], name: '—', cards: [] };
    });

    var pots = buildPots(state);
    var gains = {};

    pots.forEach(function (pot) {
      if (!pot.eligible.length) { return; }
      var bestScore = null;
      var winners = [];
      pot.eligible.forEach(function (i) {
        var sc = evals[i].score;
        if (!bestScore || cmpScore(sc, bestScore) > 0) { bestScore = sc; winners = [i]; }
        else if (cmpScore(sc, bestScore) === 0) { winners.push(i); }
      });
      var share = Math.floor(pot.amount / winners.length);
      var rem = pot.amount - share * winners.length;
      winners.forEach(function (i, k) {
        gains[i] = (gains[i] || 0) + share + (k < rem ? 1 : 0);
      });
    });

    for (var i = 0; i < seats.length; i++) {
      var s = seats[i];
      if (gains[s.i]) { s.chips += gains[s.i]; }
      s.bet = 0;
      s.totalBet = 0;
      s.acted = false;
    }

    state.phase = 'showdown';
    state.turnSeat = null;
    state.turnDeadline = null;
    state.showdown = {
      at: Date.now(),
      uncontested: false,
      results: active.map(function (s) {
        return { i: s.i, name: evals[s.i].name, won: gains[s.i] || 0 };
      }),
      pots: pots,
      revealed: []
    };

    active.forEach(function (s) {
      pushLog(state, s.nickname + ' 亮牌 ' + fmtCards(s.hole) + ' → ' + evals[s.i].name + (gains[s.i] ? '，赢得 ' + gains[s.i] : ''));
      
    });
    return { type: 'showdown' };
  }

  /**
   * 摊牌阶段：赢家可以主动把底牌亮给大家看。
   * 别人都放弃而直接获胜时，底牌默认不公开，由赢家自己决定要不要展示。
   */
  function revealHand(state, idx) {
    if (state.phase !== 'showdown' || !state.showdown) {
      return { ok: false, error: '现在不能展示手牌' };
    }
    var s = state.seats[idx];
    if (!s) { return { ok: false, error: '座位不存在' }; }

    var results = state.showdown.results || [];
    var mine = null;
    for (var i = 0; i < results.length; i++) {
      if (results[i].i === idx) { mine = results[i]; break; }
    }
    if (!mine || !mine.won) { return { ok: false, error: '只有赢家可以展示手牌' }; }
    if (!s.hole || !s.hole.length) { return { ok: false, error: '没有可展示的牌' }; }

    if (!Array.isArray(state.showdown.revealed)) { state.showdown.revealed = []; }
    if (state.showdown.revealed.indexOf(idx) >= 0) { return { ok: false, error: '' }; }

    state.showdown.revealed.push(idx);
    pushLog(state, s.nickname + ' 展示了手牌：' + fmtCards(s.hole), true);
    return { ok: true };
  }

  /**
   * 别人都放弃、本手提前结束时，公共牌还剩几张没发。
   * 桌上任何人都可以点一下把剩下的补发完 —— 纯看个乐，不参与任何结算
   * （奖池早就分完了，牌面也不会改变已产生的结果）。
   */
  function revealBoard(state, idx) {
    if (state.phase !== 'showdown' || !state.showdown) {
      return { ok: false, error: '现在不能翻公牌' };
    }
    if (!state.showdown.uncontested) { return { ok: false, error: '这手牌已经全部亮过了' }; }
    if (state.showdown.boardRevealed) { return { ok: false, error: '' }; }

    var s = state.seats[idx];
    if (!s) { return { ok: false, error: '座位不存在' }; }
    if (state.community.length >= 5) { return { ok: false, error: '' }; }

    var need = (5 - state.community.length) * 2;      // 每发一张牌都要先烧一张
    if (state.deck.length < need) { return { ok: false, error: '牌堆里没牌了' }; }

    while (state.community.length < 5) {
      state.deck.pop();                                // 烧牌
      state.community.push(state.deck.pop());
    }
    state.showdown.boardRevealed = true;
    pushLog(state, s.nickname + ' 翻开了剩下的公共牌：' + fmtCards(state.community), true);
    return { ok: true };
  }

  /* ---------------- 重置 ---------------- */

  function resetChips(state) {
    state.seats.forEach(function (s) {
      s.chips = state.startChips || 1000;
      s.bet = 0;
      s.totalBet = 0;
      s.folded = false;
      s.allIn = false;
      s.acted = false;
      s.hole = [];
      s.inHand = false;
    });
    state.phase = 'idle';
    state.community = [];
    state.deck = [];
    state.currentBet = 0;
    state.minRaise = state.bigBlind;
    state.turnSeat = null;
    state.turnDeadline = null;
    state.showdown = null;
    state.dealerSeat = -1;
    state.handNo = 0;
    state.log = [];
    pushLog(state, '欢乐豆已重置，所有人回到 ' + state.startChips);
    return state;
  }

  /* ---------------- 超时 ---------------- */

  function isTimedOut(state) {
    if (state.turnSeat === null || state.turnSeat === undefined) { return false; }
    if (state.phase === 'idle' || state.phase === 'showdown') { return false; }
    if (!state.turnDeadline) { return false; }
    return Date.now() > state.turnDeadline;
  }

  global.Poker = {
    SUITS: SUITS,
    RANKS: RANKS,
    RANK_VAL: RANK_VAL,
    CAT_NAME: CAT_NAME,
    ACTION_TIMEOUT_MS: ACTION_TIMEOUT_MS,
    newDeck: newDeck,
    shuffle: shuffle,
    eval5: eval5,
    best7: best7,
    cmpScore: cmpScore,
    nameOf: nameOf,
    cardText: cardText,
    fmtCards: fmtCards,
    newState: newState,
    normalizeState: normalizeState,
    allocateSeat: allocateSeat,
    indexOfPlayer: indexOfPlayer,
    removeSeat: removeSeat,
    reindex: reindex,
    maxSeats: maxSeats,
    potSize: potSize,
    pushLog: pushLog,
    canStart: canStart,
    startHand: startHand,
    legalActions: legalActions,
    act: act,
    progress: progress,
    buildPots: buildPots,
    doShowdown: doShowdown,
    revealHand: revealHand,
    revealBoard: revealBoard,
    resetChips: resetChips,
    isTimedOut: isTimedOut
  };

})(window);
