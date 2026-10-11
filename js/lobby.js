/* =========================================================
   联机游戏厅 · 大厅逻辑
   ========================================================= */
(function () {
  'use strict';

  var gameType = 'gomoku';
  var cfg = {};

  var PAGE = { gomoku: 'gomoku.html', jungle: 'jungle.html', poker: 'poker.html' };

  var elNick = document.getElementById('nickname');
  var elPick = document.getElementById('gamePick');
  var elPokerOpts = document.getElementById('pokerOpts');
  var elStartChips = document.getElementById('startChips');
  var elSB = document.getElementById('smallBlind');
  var elBB = document.getElementById('bigBlind');
  var btnCreate = document.getElementById('createBtn');
  var btnJoin = document.getElementById('joinBtn');
  var elJoinCode = document.getElementById('joinCode');

  btnCreate.disabled = true;
  btnJoin.disabled = true;

  /* ---------------- 昵称 ---------------- */
  elNick.value = U.getNickname();
  elNick.addEventListener('change', function () {
    U.setNickname(elNick.value.trim());
  });

  function nick() {
    var n = (elNick.value || '').trim();
    if (!n) {
      U.toast('先写个昵称吧', 'err');
      elNick.focus();
      return null;
    }
    if (n.length > 12) { n = n.slice(0, 12); }
    U.setNickname(n);
    return n;
  }

  /* ---------------- 游戏选择 ---------------- */
  elPick.addEventListener('click', function (e) {
    var opt = e.target.closest ? e.target.closest('.game-opt') : null;
    if (!opt) { return; }
    gameType = opt.getAttribute('data-game');
    var all = elPick.querySelectorAll('.game-opt');
    for (var i = 0; i < all.length; i++) {
      all[i].classList.toggle('active', all[i] === opt);
    }
    elPokerOpts.classList.toggle('hidden', gameType !== 'poker');
  });

  /* ---------------- 房间码输入 ---------------- */
  elJoinCode.addEventListener('input', function () {
    elJoinCode.value = U.cleanCode(elJoinCode.value);
  });

  var params = new URLSearchParams(location.search);
  var preRoom = U.cleanCode(params.get('room'));
  if (preRoom) { elJoinCode.value = preRoom; }

  /* ---------------- 云端就绪 ---------------- */
  GH.onReady(function (err) {
    if (err) {
      U.toast(err, 'err');
      return;
    }
    btnCreate.disabled = false;
    btnJoin.disabled = false;
    if (preRoom) {
      U.toast('房间码已填好，写下昵称就能进');
    }
  });

  /* ---------------- 初始状态 ---------------- */
  function gomokuState() {
    var board = [];
    for (var y = 0; y < 15; y++) {
      var row = [];
      for (var x = 0; x < 15; x++) { row.push(0); }
      board.push(row);
    }
    return {
      board: board,
      turn: 1,
      moves: [],
      winner: 0,
      winLine: null,
      startedAt: null,
      finishedAt: null,
      rematch: []
    };
  }

  function pokerState(c) {
    return {
      handNo: 0,
      dealerSeat: 0,
      phase: 'idle',
      community: [],
      pot: 0,
      currentBet: 0,
      minRaise: c.bigBlind,
      turnSeat: null,
      turnDeadline: null,
      seats: [],
      log: [],
      showdown: null
    };
  }

  function stateFor(type, c) {
    if (type === 'jungle') { return window.Jungle.newState(); }
    if (type === 'poker') { return pokerState(c); }
    return gomokuState();
  }

  /* ---------------- 创建房间 ---------------- */
  btnCreate.addEventListener('click', function () {
    var n = nick();
    if (!n) { return; }

    cfg = {};
    if (gameType === 'poker') {
      var sc = parseInt(elStartChips.value, 10);
      var sb = parseInt(elSB.value, 10);
      var bb = parseInt(elBB.value, 10);
      if (!sc || sc < 20) { U.toast('初始欢乐豆至少 20', 'err'); return; }
      if (!sb || sb < 1) { U.toast('小注至少 1', 'err'); return; }
      if (!bb || bb < sb) { U.toast('大注不能小于小注', 'err'); return; }
      if (sc < bb * 5) { U.toast('初始欢乐豆建议不少于大注的 5 倍', 'err'); return; }
      cfg = { startChips: sc, smallBlind: sb, bigBlind: bb };
    }

    btnCreate.disabled = true;
    btnCreate.textContent = '创建中…';
    createWithRetry(0, n);
  });

  function createWithRetry(attempt, nickname) {
    var code = U.makeCode(4);
    var playerId = U.getPlayerId();
    var state = stateFor(gameType, cfg);

    GH.db.createRoom({
      code: code,
      gameType: gameType,
      hostPlayerId: playerId,
      config: cfg,
      state: state
    }).then(function () {
      return GH.db.addPlayer(code, playerId, nickname, 0, true);
    }).then(function () {
      location.href = (PAGE[gameType] || 'index.html') + '?room=' + code;
    }).catch(function (e) {
      if (e && e.code === '23505' && attempt < 6) {
        createWithRetry(attempt + 1, nickname);
        return;
      }
      U.toast('创建失败：' + GH.errText(e), 'err');
      btnCreate.disabled = false;
      btnCreate.textContent = '创建房间';
    });
  }

  /* ---------------- 加入房间 ---------------- */
  btnJoin.addEventListener('click', function () {
    var n = nick();
    if (!n) { return; }

    var code = U.cleanCode(elJoinCode.value);
    if (code.length !== 4) {
      U.toast('房间码是 4 位数字', 'err');
      elJoinCode.focus();
      return;
    }

    btnJoin.disabled = true;
    btnJoin.textContent = '查找中…';

    GH.db.getRoom(code).then(function (room) {
      if (!room) {
        U.toast('没找到这个房间，检查一下房间码', 'err');
        btnJoin.disabled = false;
        btnJoin.textContent = '加入房间';
        return;
      }
      location.href = (PAGE[room.game_type] || 'index.html') + '?room=' + code;
    }).catch(function (e) {
      U.toast('查找失败：' + GH.errText(e), 'err');
      btnJoin.disabled = false;
      btnJoin.textContent = '加入房间';
    });
  });

})();
