/* =========================================================
   联机游戏厅 · 斗兽棋
   ---------------------------------------------------------
   座位 0 → 蓝方（上方），座位 1 → 红方（下方），蓝方先行。
   第三个人起自动成为观战。规则全部走 jungle-engine.js。
   ========================================================= */
(function () {
  'use strict';

  var JG = window.Jungle;
  var W = JG.W;
  var H = JG.H;

  var SIDE_NAME = { 1: '蓝方', 2: '红方' };
  var SIDE_CLS = { 1: 's1', 2: 's2' };

  var params = new URLSearchParams(location.search);
  var roomCode = U.cleanCode(params.get('room'));
  var myId = U.getPlayerId();

  var room = null;
  var players = [];
  var st = null;
  var mySeat = null;
  var mySide = 0;               // 1 蓝 / 2 红 / 0 观战
  var busy = false;
  var sel = null;               // 当前选中的己方棋子 { x, y }
  var legal = [];               // 选中棋子的合法落点
  var lastBeat = 0;
  var boardBuilt = false;

  var Snd = window.Snd || { play: function () { } };
  var lastMoveCount = -1;
  var lastTurn = 0;
  var lastWinner = 0;

  var elRoomCode = document.getElementById('roomCode');
  var elRoomBadge = document.getElementById('roomBadge');
  var elConnDot = document.getElementById('connDot');
  var elSeatList = document.getElementById('seatList');
  var elTurnBar = document.getElementById('turnBar');
  var elBottomNote = document.getElementById('bottomNote');
  var elBoard = document.getElementById('board');
  var elLegend = document.getElementById('legend');
  var btnResign = document.getElementById('resignBtn');
  var btnUndo = document.getElementById('undoBtn');
  var btnRematch = document.getElementById('rematchBtn');
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

  function sideOfSeat(seat) { return seat === 0 ? 1 : (seat === 1 ? 2 : 0); }

  function findPlayerBySeat(seat) {
    for (var i = 0; i < players.length; i++) {
      if (players[i].seat === seat) { return players[i]; }
    }
    return null;
  }

  function findPlayerBySide(side) { return findPlayerBySeat(side === 1 ? 0 : 1); }

  function reasonText(r) {
    var m = {
      den: '攻入兽穴', wipe: '全军覆没', stuck: '无子可动',
      draw: '久战无吃子', resign: '对手认输'
    };
    return m[r] || '分出胜负';
  }

  /* ---------------- 音效：状态差分 ---------------- */

  function afterState() {
    var moves = (st && st.moves) ? st.moves : [];
    var winner = (st && st.winner) ? st.winner : 0;
    var turn = (st && !winner && st.turn && players.length >= 2) ? st.turn : 0;

    if (lastMoveCount < 0) {
      lastMoveCount = moves.length;
      lastTurn = turn;
      lastWinner = winner;
      return;
    }

    if (moves.length > lastMoveCount) {
      for (var i = lastMoveCount; i < moves.length; i++) {
        var m = moves[i];
        if (m.cap) { Snd.play('capture'); }
        else { Snd.play('place', { stone: m.s === 2 ? 2 : 1 }); }
      }
      lastMoveCount = moves.length;
    } else if (moves.length < lastMoveCount) {
      if (moves.length === lastMoveCount - 1 && !winner && !lastWinner) {
        Snd.play('flip');                     // 刚好少一步又没结束 —— 有人悔棋
      } else {
        Snd.play('start');                    // 重开一局
      }
      lastMoveCount = moves.length;
    }

    if (!lastWinner && winner) {
      if (mySide) {
        if (winner === 3) { Snd.play('lose'); }
        else { Snd.play(winner === mySide ? 'win' : 'lose'); }
      }
    }
    lastWinner = winner;

    if (mySide && turn === mySide && lastTurn !== mySide) { Snd.play('turn'); }
    lastTurn = turn;
  }

  /* ---------------- 云端交互 ---------------- */

  async function ensureJoined() {
    var me = await GH.db.getPlayer(roomCode, myId);
    if (me) { return me; }
    var ps = (await GH.db.listPlayers(roomCode)) || [];
    var taken = ps.map(function (p) { return p.seat; });
    var seat = 0;
    while (taken.indexOf(seat) >= 0) { seat++; }
    try {
      return await GH.db.addPlayer(roomCode, myId, U.getNickname() || '玩家', seat, ps.length === 0);
    } catch (e) {
      return await GH.db.getPlayer(roomCode, myId);
    }
  }

  async function applyState(mutator, tries) {
    var max = tries || 5;
    for (var i = 0; i < max; i++) {
      var r = await GH.db.getRoom(roomCode);
      if (!r) { return null; }
      var next = mutator(r.state || {});
      if (next === null) { return null; }
      var done = await GH.db.updateRoom(r, { state: next });
      if (done) { return done; }
      await sleep(110);
    }
    return null;
  }

  async function heartbeat() {
    var now = Date.now();
    if (now - lastBeat < 4000) { return; }
    lastBeat = now;
    var me = null;
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === myId) { me = players[i]; break; }
    }
    if (me) {
      try { await GH.db.touchPlayer(me); } catch (e) { /* 忽略 */ }
    }
  }

  async function cleanupIdle() {
    var cur = room ? (room.state || {}) : {};
    var inGame = cur.moves && cur.moves.length > 0 && !cur.winner;
    var now = Date.now();
    for (var i = 0; i < players.length; i++) {
      var p = players[i];
      if (p.player_id === myId) { continue; }
      var idle = now - new Date(p.last_seen).getTime();
      if (idle > 90000) {
        try { await GH.db.removePlayer(roomCode, p.player_id); } catch (e) { /* 忽略 */ }
      }
    }
  }

  /* ---------------- 轮询 ---------------- */

  var poller = U.createPoller(async function () {
    var r = await GH.db.getRoom(roomCode);
    if (!r) {
      elConnDot.classList.add('off');
      return;
    }
    room = r;
    st = JG.normalizeState(r.state || {});

    var ps = await GH.db.listPlayers(roomCode);
    players = ps || [];

    elConnDot.classList.remove('off');

    await heartbeat();
    await cleanupIdle();

    syncMe();
    afterState();
    if (!boardBuilt) { buildBoard(); renderLegend(); boardBuilt = true; }

    // 轮次不属于自己时，取消选中，免得点着点着状态变了
    if (sel && (st.winner || st.turn !== mySide)) { sel = null; legal = []; }

    renderSeats();
    renderTurn();
    renderBoard();
    renderButtons();
  }, 1000);

  function syncMe() {
    var me = null;
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === myId) { me = players[i]; break; }
    }
    mySeat = me ? me.seat : null;
    mySide = sideOfSeat(mySeat);
  }

  /* ---------------- 棋盘 ---------------- */

  var cellEls = [];

  function buildBoard() {
    elBoard.innerHTML = '';
    cellEls = [];
    for (var y = 0; y < H; y++) {
      var row = [];
      for (var x = 0; x < W; x++) {
        var d = document.createElement('div');
        d.className = 'jcell';
        if (JG.isWater(x, y)) { d.classList.add('water'); }

        var ts = JG.trapSide(x, y);
        var ds = JG.denSide(x, y);
        if (ds) {
          d.classList.add('den', 'den' + ds);
          var mk = document.createElement('span');
          mk.className = 'jmark';
          mk.textContent = '穴';
          d.appendChild(mk);
        } else if (ts) {
          d.classList.add('trap', 'trap' + ts);
          var mk2 = document.createElement('span');
          mk2.className = 'jmark';
          mk2.textContent = '陷';
          d.appendChild(mk2);
        }

        d.setAttribute('data-x', String(x));
        d.setAttribute('data-y', String(y));
        d._pt = null;
        elBoard.appendChild(d);
        row.push(d);
      }
      cellEls.push(row);
    }
  }

  function pieceEl(t, s, delayMs) {
    var el = document.createElement('div');
    el.className = 'jpiece ' + SIDE_CLS[s];
    el.style.animationDelay = delayMs + 'ms';
    var f = document.createElement('span');
    f.className = 'jface';
    f.textContent = JG.FACE[t];
    var r = document.createElement('span');
    r.className = 'jrank';
    r.textContent = String(JG.RANK[t]);
    el.appendChild(f);
    el.appendChild(r);
    el.title = SIDE_NAME[s] + '·' + JG.CN[t];
    return el;
  }

  function renderBoard() {
    if (!st || !cellEls.length) { return; }

    var board = st.board;
    var hints = {};
    for (var k = 0; k < legal.length; k++) { hints[legal[k].x + ',' + legal[k].y] = true; }

    var mv = (st.moves && st.moves.length) ? st.moves[st.moves.length - 1] : null;

    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var cell = cellEls[y][x];
        var p = board[y][x];
        var old = cell._pt;

        var same = (p && old && old.t === p.t && old.s === p.s) || (!p && !old);
        if (!same) {
          var node = cell.querySelector('.jpiece');
          if (node) { cell.removeChild(node); }
          if (p) {
            cell.appendChild(pieceEl(p.t, p.s, (x + y) * 14));
            cell._pt = { t: p.t, s: p.s };
          } else {
            cell._pt = null;
          }
        }

        var key = x + ',' + y;
        cell.classList.toggle('sel', !!(sel && sel.x === x && sel.y === y));
        cell.classList.toggle('moveable', !!hints[key] && !p);
        cell.classList.toggle('eat', !!hints[key] && !!p);
        cell.classList.toggle('lastfrom', !!(mv && mv.fx === x && mv.fy === y));
        cell.classList.toggle('lastto', !!(mv && mv.tx === x && mv.ty === y));
      }
    }
  }

  function renderLegend() {
    elLegend.innerHTML = '';
    var order = ['elephant', 'lion', 'tiger', 'leopard', 'wolf', 'dog', 'cat', 'rat'];
    order.forEach(function (t) {
      var s = document.createElement('span');
      s.className = 'jleg';
      s.innerHTML = '<b>' + JG.FACE[t] + '</b>' + JG.CN[t] + '<i>' + JG.RANK[t] + '</i>';
      elLegend.appendChild(s);
    });
  }

  /* ---------------- 座位 / 轮次 ---------------- */

  function renderSeats() {
    if (!players.length) {
      elSeatList.innerHTML = '<div class="empty-tip">正在进入房间…</div>';
      return;
    }
    var list = players.slice().sort(function (a, b) { return a.seat - b.seat; });
    var turnSeat = null;
    if (st && !st.winner && st.moves && st.turn) {
      turnSeat = st.turn === 1 ? 0 : 1;
    }

    elSeatList.innerHTML = '';
    list.forEach(function (p) {
      var online = U.isOnline(p.last_seen);
      var chip = document.createElement('div');
      var cls = 'seat-chip';
      if (p.player_id === myId) { cls += ' me'; }
      if (!online) { cls += ' offline'; }
      if (turnSeat === p.seat && online) { cls += ' active'; }
      chip.className = cls;
      chip.setAttribute('data-pid', p.player_id);

      var av = document.createElement('div');
      av.className = 'avatar';
      av.style.background = U.avatarColor(p.nickname);
      av.textContent = U.initial(p.nickname);

      var who = document.createElement('div');
      who.className = 'who';
      var nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = p.nickname + (p.player_id === myId ? '（你）' : '');
      var sub = document.createElement('div');
      sub.className = 'sub';
      var side = sideOfSeat(p.seat);
      var role = side === 1 ? '🔵 蓝方' : (side === 2 ? '🔴 红方' : '观战');
      sub.textContent = role + (online ? '' : ' · 离线');
      who.appendChild(nm);
      who.appendChild(sub);

      chip.appendChild(av);
      chip.appendChild(who);
      elSeatList.appendChild(chip);
    });
  }

  function renderTurn() {
    var blue = findPlayerBySeat(0);
    var red = findPlayerBySeat(1);
    elTurnBar.innerHTML = '';

    if (!blue || !red) {
      var span = document.createElement('span');
      span.className = 'waiting-note';
      var dot = document.createElement('span');
      dot.className = 'pulse-dot';
      var t = document.createElement('span');
      t.textContent = '等待对手加入 —— 把房间码 ' + roomCode + ' 发给同学';
      span.appendChild(dot);
      span.appendChild(t);
      elTurnBar.appendChild(span);
      return;
    }

    if (st && st.winner) {
      var mark = document.createElement('span');
      mark.className = 'turn-stone ' + SIDE_CLS[st.winner === 3 ? 1 : st.winner];
      var txt = document.createElement('span');
      txt.className = 'win-text';
      if (st.winner === 3) {
        txt.textContent = '🤝 和棋';
      } else {
        var wp = findPlayerBySide(st.winner);
        txt.textContent = '🏆 ' + (wp ? wp.nickname : SIDE_NAME[st.winner]) + '（' + SIDE_NAME[st.winner] + '）获胜';
      }
      var why = document.createElement('span');
      why.className = 'end-reason';
      why.textContent = '（' + reasonText(st.reason) + '）';
      elTurnBar.appendChild(mark);
      elTurnBar.appendChild(txt);
      elTurnBar.appendChild(why);
      return;
    }

    var turn = st && st.turn ? st.turn : 1;
    var cur = findPlayerBySeat(turn === 1 ? 0 : 1);
    var s2 = document.createElement('span');
    s2.className = 'turn-stone ' + SIDE_CLS[turn];
    var t2 = document.createElement('span');
    var base = '轮到 ' + (cur ? cur.nickname : SIDE_NAME[turn]) + '（' + SIDE_NAME[turn] + '）';
    if (mySide === turn) { t2.textContent = base + ' 走棋'; }
    else if (mySide === 0) { t2.textContent = base + ' 走棋（观战中）'; }
    else {
      t2.textContent = '等待 ' + (cur ? cur.nickname : '对手') + ' 走棋…';
      t2.style.color = 'var(--muted)';
    }
    elTurnBar.appendChild(s2);
    elTurnBar.appendChild(t2);
  }

  function renderButtons() {
    var me = mySide !== 0;
    var over = st && !!st.winner;
    var started = st && st.moves && st.moves.length > 0;
    var opp = findPlayerBySide(mySide === 1 ? 2 : 1);
    var oppAway = opp && !U.isOnline(opp.last_seen) && (Date.now() - new Date(opp.last_seen).getTime() > 30000);

    btnResign.disabled = !(me && started && !over);
    btnUndo.disabled = !canUndo();
    btnRematch.disabled = !(me && (over || (started && oppAway)));

    if (!me) {
      elBottomNote.innerHTML = '<span>观战中 · 满员时会自动成为观战者</span>';
    } else if (!started) {
      elBottomNote.innerHTML = '<span>蓝方先行 · 点自己的棋子选中，再点提示的格子走棋</span>';
    } else if (oppAway && !over) {
      elBottomNote.innerHTML = '<span style="color:var(--red)">对手似乎离开了，可以点「再来一局」重开</span>';
    } else {
      elBottomNote.innerHTML = '<span>象＞狮＞虎＞豹＞狼＞狗＞猫＞鼠 · 鼠能吃象 · 只有鼠能下水 · 狮虎可跳河</span>';
    }
  }

  /* ---------------- 交互 ---------------- */

  function selectPiece(x, y) {
    sel = { x: x, y: y };
    legal = JG.legalMoves(st.board, x, y);
    Snd.play('click');
    renderBoard();
  }

  function clearSel() {
    sel = null;
    legal = [];
    renderBoard();
  }

  elBoard.addEventListener('click', function (e) {
    var cell = e.target.closest ? e.target.closest('.jcell') : null;
    if (!cell) { return; }
    var x = parseInt(cell.getAttribute('data-x'), 10);
    var y = parseInt(cell.getAttribute('data-y'), 10);
    onCell(x, y);
  });

  function onCell(x, y) {
    if (!st || busy) { return; }
    if (st.winner) { return; }
    if (mySide === 0) { U.toast('你是观战者', 'err'); return; }
    if (st.turn !== mySide) { U.toast('还没轮到你', 'err'); return; }
    if (players.length < 2) { U.toast('还没有对手', 'err'); return; }

    var p = st.board[y][x];

    if (sel) {
      if (sel.x === x && sel.y === y) { clearSel(); return; }

      var hit = null;
      for (var i = 0; i < legal.length; i++) {
        if (legal[i].x === x && legal[i].y === y) { hit = legal[i]; break; }
      }
      if (hit) { play(sel.x, sel.y, x, y, !!hit.jump); return; }

      if (p && p.s === mySide) { selectPiece(x, y); return; }
      clearSel();
      return;
    }

    if (p && p.s === mySide) { selectPiece(x, y); }
  }

  async function play(fx, fy, tx, ty, jump) {
    busy = true;
    var pieceS = mySide;
    try {
      var updated = await applyState(function (s) {
        var stt = JG.normalizeState(s);
        if (stt.winner) { return null; }
        if (stt.turn !== pieceS) { return null; }

        var cell = stt.board[fy][fx];
        if (!cell || cell.s !== pieceS) { return null; }

        var moves = JG.legalMoves(stt.board, fx, fy);
        var found = null;
        for (var i = 0; i < moves.length; i++) {
          if (moves[i].x === tx && moves[i].y === ty) { found = moves[i]; break; }
        }
        if (!found) { return null; }

        var r = JG.applyMove(stt.board, fx, fy, tx, ty, stt.drawPly);
        var rec = {
          fx: fx, fy: fy, tx: tx, ty: ty,
          t: cell.t, s: cell.s,
          cap: r.captured ? r.captured.t : null,
          capS: r.captured ? r.captured.s : null,
          jump: !!found.jump
        };

        return {
          board: r.board,
          turn: 3 - pieceS,
          moves: (stt.moves || []).concat([rec]),
          drawPly: r.drawPly,
          winner: r.winner,
          reason: r.reason,
          startedAt: stt.startedAt || new Date().toISOString(),
          finishedAt: r.winner ? new Date().toISOString() : null
        };
      });

      if (!updated) {
        U.toast('网络有点忙，请再点一次', 'err');
      } else {
        sel = null;
        legal = [];
        st = JG.normalizeState(updated.state);
        room = updated;
        afterState();
        renderSeats();
        renderTurn();
        renderBoard();
        renderButtons();
        poller.kick();
      }
    } catch (e) {
      U.toast('走棋失败：' + GH.errText(e), 'err');
    }
    busy = false;
  }

  /* ---------------- 按钮 ---------------- */

  /* ---------------- 悔棋 ----------------
     收回自己刚走的那一步（对手还没应招时）。被吃的子会回到原位。 */

  function canUndo() {
    if (!st || !mySide || st.winner) { return false; }
    var ms = st.moves || [];
    var last = ms[ms.length - 1];
    return !!last && last.s === mySide && st.turn !== mySide;
  }

  async function undo() {
    if (busy) { return; }
    if (!mySide) { U.toast('观战不能悔棋', 'err'); return; }
    if (!canUndo()) { U.toast('只能收回自己刚走的那一步', 'err'); return; }
    busy = true;
    try {
      var updated = await applyState(function (s) {
        return JG.undoLast(s, mySide);
      });
      if (!updated) {
        U.toast('对手已经应招了，收不回来啦', 'err');
      } else {
        st = JG.normalizeState(updated.state);
        room = updated;
        sel = null;
        legal = [];
        afterState();                 // 悔棋音效由状态差分统一播，这里不再重复
        renderSeats();
        renderTurn();
        renderBoard();
        renderButtons();
        poller.kick();
      }
    } catch (e) {
      U.toast('悔棋失败：' + GH.errText(e), 'err');
    }
    busy = false;
  }

  btnUndo.addEventListener('click', undo);

  btnResign.addEventListener('click', async function () {
    if (!st || !mySide || st.winner) { return; }
    var ok = await U.confirm('认输', '确定认输吗？本局判对方获胜。', '确定认输');
    if (!ok) { return; }

    var updated = await applyState(function (s) {
      var stt = JG.normalizeState(s);
      if (stt.winner) { return null; }
      return {
        board: stt.board,
        turn: stt.turn,
        moves: stt.moves,
        drawPly: stt.drawPly,
        winner: 3 - mySide,
        reason: 'resign',
        startedAt: stt.startedAt,
        finishedAt: new Date().toISOString()
      };
    });

    if (updated) {
      st = JG.normalizeState(updated.state);
      sel = null;
      legal = [];
      afterState();
      renderSeats();
      renderTurn();
      renderBoard();
      renderButtons();
      poller.kick();
    }
  });

  btnRematch.addEventListener('click', async function () {
    if (!mySide) { return; }
    var ok = await U.confirm('再来一局', '棋盘复位，先手自动交换。', '开始新一局');
    if (!ok) { return; }

    var updated = await applyState(function (s) {
      var stt = JG.normalizeState(s);
      var first = (stt.moves && stt.moves.length) ? stt.moves[0].s : 1;
      var ns = JG.newState();
      ns.turn = 3 - first;
      return ns;
    });

    if (updated) {
      st = JG.normalizeState(updated.state);
      sel = null;
      legal = [];
      // 棋盘整体复位，把缓存清掉以便重新播放出场动画
      for (var y = 0; y < H; y++) {
        for (var x = 0; x < W; x++) { cellEls[y][x]._pt = undefined; }
      }
      afterState();
      renderSeats();
      renderTurn();
      renderBoard();
      renderButtons();
      U.toast('新的一局开始了', 'ok');
      poller.kick();
    } else {
      U.toast('重开失败，请重试', 'err');
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
      room = r;
      st = JG.normalizeState(r.state || {});

      await ensureJoined();

      var ps = (await GH.db.listPlayers(roomCode)) || [];
      players = ps;
      syncMe();

      buildBoard();
      renderLegend();
      boardBuilt = true;

      renderSeats();
      renderTurn();
      renderBoard();
      renderButtons();
      poller.start();
    } catch (e) {
      U.toast('进入房间失败：' + GH.errText(e), 'err');
    }
  });

})();
