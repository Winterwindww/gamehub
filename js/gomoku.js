/* =========================================================
   联机游戏厅 · 五子棋
   ========================================================= */
(function () {
  'use strict';

  var N = 15;
  var SIZE = 600;
  var PAD = 30;
  var GAP = (SIZE - PAD * 2) / (N - 1);
  var R = GAP * 0.42;
  var STARS = [[3, 3], [11, 3], [3, 11], [11, 11], [7, 7]];

  var params = new URLSearchParams(location.search);
  var roomCode = U.cleanCode(params.get('room'));
  var myId = U.getPlayerId();

  var room = null;
  var players = [];
  var st = null;
  var board = null;
  var mySeat = null;
  var myStone = 0;          // 1 黑 / 2 白 / 0 观战
  var busy = false;
  var lastBeat = 0;

  var Snd = window.Snd || { play: function () { } };
  var lastMoveCount = -1;   // -1 表示还没完成首次同步
  var lastTurn = 0;
  var lastWinner = 0;

  var elRoomCode = document.getElementById('roomCode');
  var elRoomBadge = document.getElementById('roomBadge');
  var elConnDot = document.getElementById('connDot');
  var elSeatList = document.getElementById('seatList');
  var elTurnBar = document.getElementById('turnBar');
  var elBottomNote = document.getElementById('bottomNote');
  var btnResign = document.getElementById('resignBtn');
  var btnUndo = document.getElementById('undoBtn');
  var btnRematch = document.getElementById('rematchBtn');
  var elBack = document.getElementById('backBtn');
  var canvas = document.getElementById('board');
  var ctx = canvas.getContext('2d');

  if (!roomCode || roomCode.length !== 4) {
    document.body.innerHTML =
      '<div class="wrap"><div class="card"><h2>缺少房间码</h2>' +
      '<p class="hint">请回到大厅创建或加入一个房间。</p>' +
      '<a class="btn btn-primary" href="index.html" style="margin-top:14px">返回大厅</a></div></div>';
    return;
  }

  elRoomCode.textContent = roomCode;

  /* ---------------- 工具 ---------------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function emptyBoard() {
    var b = [];
    for (var y = 0; y < N; y++) {
      var row = [];
      for (var x = 0; x < N; x++) { row.push(0); }
      b.push(row);
    }
    return b;
  }

  function normalizeBoard(b) {
    if (!Array.isArray(b) || b.length !== N) { return emptyBoard(); }
    for (var y = 0; y < N; y++) {
      if (!Array.isArray(b[y]) || b[y].length !== N) { return emptyBoard(); }
    }
    return b;
  }

  function findPlayerBySeat(seat) {
    for (var i = 0; i < players.length; i++) {
      if (players[i].seat === seat) { return players[i]; }
    }
    return null;
  }

  /* ---------------- 音效：状态差分 ---------------- */

  /*
   * 自己落子和对手落子都走同一条路：对比前后状态，看新增了哪些棋子。
   * 这样本地乐观更新和轮询同步不会重复发声。
   */
  function afterState() {
    var moves = (st && st.moves) ? st.moves : [];
    var winner = (st && st.winner) ? st.winner : 0;
    var turn = (st && !winner && st.turn) ? st.turn : 0;

    if (lastMoveCount < 0) {
      // 首次同步：只对位，不补放历史音效
      lastMoveCount = moves.length;
      lastTurn = turn;
      lastWinner = winner;
      return;
    }

    if (moves.length > lastMoveCount) {
      for (var i = lastMoveCount; i < moves.length; i++) {
        Snd.play('place', { stone: moves[i].p });
      }
      lastMoveCount = moves.length;
    } else if (moves.length < lastMoveCount) {
      if (moves.length === lastMoveCount - 1 && !winner && !lastWinner) {
        Snd.play('flip');                     // 刚好少一步又没结束 —— 有人悔棋
      }
      lastMoveCount = moves.length;         // 重开一局
    }

    if (!lastWinner && winner) {
      if (myStone) { Snd.play(winner === myStone ? 'win' : 'lose'); }
    } else if (lastWinner && !winner) {
      Snd.play('start');                    // 新一局
    }
    lastWinner = winner;

    if (myStone && turn === myStone && lastTurn !== myStone) { Snd.play('turn'); }
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

  /** 乐观并发更新 state；mutator 返回 null 表示放弃 */
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
    if (inGame) { return; }
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
    st = r.state || {};
    board = normalizeBoard(st.board);

    var ps = await GH.db.listPlayers(roomCode);
    players = ps || [];

    elConnDot.classList.remove('off');

    await heartbeat();
    await cleanupIdle();

    syncMe();
    afterState();
    renderSeats();
    renderTurn();
    renderButtons();
    draw();
  }, 1000);

  function syncMe() {
    var me = null;
    for (var i = 0; i < players.length; i++) {
      if (players[i].player_id === myId) { me = players[i]; break; }
    }
    mySeat = me ? me.seat : null;
    myStone = mySeat === 0 ? 1 : (mySeat === 1 ? 2 : 0);
  }

  /* ---------------- 渲染 ---------------- */

  function renderSeats() {
    if (!players.length) {
      elSeatList.innerHTML = '<div class="empty-tip">正在进入房间…</div>';
      return;
    }
    var list = players.slice().sort(function (a, b) { return a.seat - b.seat; });
    var turnSeat = null;
    if (st && !st.winner && st.moves && st.moves.length >= 0 && st.turn) {
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
      var role = p.seat === 0 ? '● 黑棋' : (p.seat === 1 ? '○ 白棋' : '观战');
      sub.textContent = role + (online ? '' : ' · 离线');
      who.appendChild(nm);
      who.appendChild(sub);

      chip.appendChild(av);
      chip.appendChild(who);
      elSeatList.appendChild(chip);
    });
  }

  function renderTurn() {
    var black = findPlayerBySeat(0);
    var white = findPlayerBySeat(1);
    var started = st && st.moves && st.moves.length > 0;

    if (!black || !white) {
      elTurnBar.innerHTML = '';
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

    elTurnBar.innerHTML = '';

    if (st && st.winner) {
      var winnerPlayer = findPlayerBySeat(st.winner === 1 ? 0 : 1);
      var wname = winnerPlayer ? winnerPlayer.nickname : '—';
      var stone = document.createElement('span');
      stone.className = 'turn-stone ' + (st.winner === 1 ? 'black' : 'white');
      var txt = document.createElement('span');
      txt.className = 'win-text';
      txt.textContent = '🏆 ' + wname + ' 获胜';
      elTurnBar.appendChild(stone);
      elTurnBar.appendChild(txt);
      if (!st.winLine) {
        var byResign = document.createElement('span');
        byResign.style.color = 'var(--muted)';
        byResign.style.fontSize = '13px';
        byResign.style.fontWeight = '400';
        byResign.textContent = '（认输）';
        elTurnBar.appendChild(byResign);
      }
      return;
    }

    var turnStone = st && st.turn ? st.turn : 1;
    var curPlayer = findPlayerBySeat(turnStone === 1 ? 0 : 1);
    var s2 = document.createElement('span');
    s2.className = 'turn-stone ' + (turnStone === 1 ? 'black' : 'white');
    var t2 = document.createElement('span');
    var base = '轮到 ' + (curPlayer ? curPlayer.nickname : '—');
    if (myStone === turnStone) {
      t2.textContent = base + ' 落子（就是你）';
    } else if (myStone === 0) {
      t2.textContent = base + ' 落子（观战中）';
    } else {
      t2.textContent = '等待 ' + (curPlayer ? curPlayer.nickname : '对手') + ' 落子…';
      t2.style.color = 'var(--muted)';
    }
    elTurnBar.appendChild(s2);
    elTurnBar.appendChild(t2);
  }

  function renderButtons() {
    var me = myStone !== 0;
    var over = st && !!st.winner;
    var started = st && st.moves && st.moves.length > 0;
    var opp = findPlayerBySeat(myStone === 1 ? 1 : 0);
    var oppAway = opp && !U.isOnline(opp.last_seen) && (Date.now() - new Date(opp.last_seen).getTime() > 30000);

    btnResign.disabled = !(me && started && !over);
    btnUndo.disabled = !canUndo();
    btnRematch.disabled = !(me && (over || oppAway));

    if (!me) {
      elBottomNote.innerHTML = '<span>观战中 · 房间满员时你会自动成为观战者</span>';
    } else if (!started) {
      elBottomNote.innerHTML = '<span>对局还没开始，等对手进来后由黑棋先行</span>';
    } else if (oppAway && !over) {
      elBottomNote.innerHTML = '<span style="color:var(--red)">对手似乎离开了，可以点「再来一局」重开</span>';
    } else {
      elBottomNote.innerHTML = '<span>先连成五子者获胜 · 点击棋盘落子</span>';
    }
  }

  /* ---------------- 绘制 ---------------- */

  function initCanvas() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = SIZE * dpr;
    canvas.height = SIZE * dpr;
    canvas.style.width = '100%';
    canvas.style.height = 'auto';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function pt(i) { return PAD + i * GAP; }

  function drawStone(cx, cy, v) {
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.42)';
    ctx.shadowBlur = 9;
    ctx.shadowOffsetY = 3;
    var grad = ctx.createRadialGradient(cx - R * 0.36, cy - R * 0.4, R * 0.1, cx, cy, R);
    if (v === 1) {
      grad.addColorStop(0, '#7d8695');
      grad.addColorStop(0.42, '#2b313c');
      grad.addColorStop(1, '#080a0f');
    } else {
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.58, '#f2f4f8');
      grad.addColorStop(1, '#bcc4d0');
    }
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, Math.PI * 2);
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.restore();
  }

  function draw() {
    ctx.clearRect(0, 0, SIZE, SIZE);

    var g = ctx.createLinearGradient(0, 0, SIZE, SIZE);
    g.addColorStop(0, '#ecd39a');
    g.addColorStop(0.5, '#e3c288');
    g.addColorStop(1, '#d3aa6b');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, SIZE, SIZE);

    ctx.save();
    ctx.globalAlpha = 0.05;
    ctx.strokeStyle = '#6b4a1f';
    ctx.lineWidth = 1;
    var i;
    for (i = 0; i < 34; i++) {
      var y = (i * 41) % SIZE;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.bezierCurveTo(SIZE * 0.32, y + 9, SIZE * 0.64, y - 9, SIZE, y + 4);
      ctx.stroke();
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(74, 48, 20, 0.5)';
    ctx.lineWidth = 1;
    for (i = 0; i < N; i++) {
      var p = pt(i);
      ctx.beginPath(); ctx.moveTo(PAD, p); ctx.lineTo(SIZE - PAD, p); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(p, PAD); ctx.lineTo(p, SIZE - PAD); ctx.stroke();
    }

    ctx.strokeStyle = 'rgba(74, 48, 20, 0.85)';
    ctx.lineWidth = 2;
    ctx.strokeRect(PAD, PAD, SIZE - PAD * 2, SIZE - PAD * 2);

    ctx.fillStyle = 'rgba(74, 48, 20, 0.8)';
    for (i = 0; i < STARS.length; i++) {
      ctx.beginPath();
      ctx.arc(pt(STARS[i][0]), pt(STARS[i][1]), 4, 0, Math.PI * 2);
      ctx.fill();
    }

    if (!board) { return; }

    for (var yy = 0; yy < N; yy++) {
      for (var xx = 0; xx < N; xx++) {
        var v = board[yy][xx];
        if (v) { drawStone(pt(xx), pt(yy), v); }
      }
    }

    if (st && st.moves && st.moves.length) {
      var last = st.moves[st.moves.length - 1];
      ctx.beginPath();
      ctx.arc(pt(last.x), pt(last.y), R * 0.26, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(240, 85, 79, 0.95)';
      ctx.fill();
    }

    if (st && st.winLine && st.winLine.length >= 2) {
      var a = st.winLine[0];
      var b = st.winLine[st.winLine.length - 1];
      ctx.save();
      ctx.strokeStyle = 'rgba(242, 181, 60, 0.95)';
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.shadowColor = 'rgba(242, 181, 60, 0.9)';
      ctx.shadowBlur = 15;
      ctx.beginPath();
      ctx.moveTo(pt(a[0]), pt(a[1]));
      ctx.lineTo(pt(b[0]), pt(b[1]));
      ctx.stroke();
      ctx.restore();
    }
  }

  /* ---------------- 判胜 ---------------- */

  function checkWin(b, x, y, p) {
    var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
    for (var d = 0; d < dirs.length; d++) {
      var dx = dirs[d][0];
      var dy = dirs[d][1];
      var line = [[x, y]];
      var s;
      for (s = 1; s <= 4; s++) {
        var nx = x + dx * s;
        var ny = y + dy * s;
        if (nx < 0 || nx >= N || ny < 0 || ny >= N || b[ny][nx] !== p) { break; }
        line.push([nx, ny]);
      }
      for (s = 1; s <= 4; s++) {
        var mx = x - dx * s;
        var my = y - dy * s;
        if (mx < 0 || mx >= N || my < 0 || my >= N || b[my][mx] !== p) { break; }
        line.unshift([mx, my]);
      }
      if (line.length >= 5) { return line; }
    }
    return null;
  }

  /* ---------------- 悔棋 ----------------
     收回自己刚下的那一步（对手还没落子时）。返回新的 state，不能悔棋返回 null。 */

  function revertLast(s, side) {
    if (!side || !s) { return null; }
    if (s.winner) { return null; }
    var ms = s.moves || [];
    var last = ms[ms.length - 1];
    if (!last || last.p !== side) { return null; }   // 只能收回自己的子
    if (s.turn === side) { return null; }            // 该我下，说明对手已经应招

    var b = normalizeBoard(s.board);
    if (b[last.y][last.x] !== side) { return null; }

    var nb = b.map(function (row) { return row.slice(); });
    nb[last.y][last.x] = 0;
    var rest = ms.slice(0, -1);

    return {
      board: nb,
      moves: rest,
      turn: side,
      winner: 0,
      winLine: null,
      startedAt: rest.length ? s.startedAt : null,
      finishedAt: null
    };
  }

  function canUndo() {
    if (!st || !myStone || st.winner) { return false; }
    var ms = st.moves || [];
    var last = ms[ms.length - 1];
    return !!last && last.p === myStone && st.turn !== myStone;
  }

  /* ---------------- 落子 ---------------- */

  async function play(x, y) {
    if (busy) { return; }
    if (!st || !board) { return; }
    if (st.winner) { return; }
    if (myStone === 0) { U.toast('你是观战者', 'err'); return; }
    if (st.turn !== myStone) { U.toast('还没轮到你', 'err'); return; }
    if (board[y][x] !== 0) { return; }
    if (players.length < 2) { U.toast('还没有对手', 'err'); return; }

    busy = true;
    try {
      var updated = await applyState(function (s) {
        var b = normalizeBoard(s.board);
        if (b[y][x] !== 0) { return null; }
        if (s.turn !== myStone) { return null; }
        if (s.winner) { return null; }

        var nb = b.map(function (row) { return row.slice(); });
        nb[y][x] = myStone;
        var line = checkWin(nb, x, y, myStone);
        var moves = (s.moves || []).concat([{ x: x, y: y, p: myStone }]);

        return {
          board: nb,
          moves: moves,
          turn: 3 - myStone,
          winner: line ? myStone : 0,
          winLine: line,
          startedAt: s.startedAt || new Date().toISOString(),
          finishedAt: line ? new Date().toISOString() : null
        };
      });

      if (!updated) {
        U.toast('网络有点忙，请再点一次', 'err');
      } else {
        st = updated.state;
        board = normalizeBoard(st.board);
        afterState();
        renderSeats();
        renderTurn();
        renderButtons();
        draw();
        poller.kick();
      }
    } catch (e) {
      U.toast('落子失败：' + GH.errText(e), 'err');
    }
    busy = false;
  }

  canvas.addEventListener('click', function (e) {
    if (!board || myStone === 0 || (st && st.winner)) { return; }
    var rect = canvas.getBoundingClientRect();
    var scale = SIZE / rect.width;
    var lx = (e.clientX - rect.left) * scale;
    var ly = (e.clientY - rect.top) * scale;
    var gx = Math.round((lx - PAD) / GAP);
    var gy = Math.round((ly - PAD) / GAP);
    if (gx < 0 || gx >= N || gy < 0 || gy >= N) { return; }
    play(gx, gy);
  });

  /* ---------------- 按钮 ---------------- */

  btnResign.addEventListener('click', async function () {
    if (!st || !myStone || st.winner) { return; }
    var ok = await U.confirm('认输', '确定认输吗？本局判对方获胜。', '确定认输');
    if (!ok) { return; }
    var updated = await applyState(function (s) {
      if (s.winner) { return null; }
      return {
        board: s.board,
        moves: s.moves || [],
        turn: s.turn,
        winner: 3 - myStone,
        winLine: null,
        startedAt: s.startedAt,
        finishedAt: new Date().toISOString()
      };
    });
    if (updated) {
      st = updated.state;
      afterState();
      renderSeats(); renderTurn(); renderButtons(); draw();
      poller.kick();
    }
  });

  btnUndo.addEventListener('click', async function () {
    if (busy) { return; }
    if (!myStone) { U.toast('观战不能悔棋', 'err'); return; }
    if (!canUndo()) { U.toast('只能收回自己刚下的那一步', 'err'); return; }
    busy = true;
    try {
      var updated = await applyState(function (s) {
        return revertLast(s, myStone);
      });
      if (!updated) {
        U.toast('对手已经应招了，收不回来啦', 'err');
      } else {
        st = updated.state;
        board = normalizeBoard(st.board);
        afterState();                 // 悔棋音效由状态差分统一播，这里不再重复
        renderSeats(); renderTurn(); renderButtons(); draw();
        poller.kick();
      }
    } catch (e) {
      U.toast('悔棋失败：' + GH.errText(e), 'err');
    }
    busy = false;
  });

  btnRematch.addEventListener('click', async function () {
    if (!myStone) { return; }
    var ok = await U.confirm('再来一局', '清空棋盘重新开始，先手自动交换。', '开始新一局');
    if (!ok) { return; }
    var updated = await applyState(function (s) {
      var first = (s.moves && s.moves.length) ? s.moves[0].p : 1;
      return {
        board: emptyBoard(),
        moves: [],
        turn: 3 - first,
        winner: 0,
        winLine: null,
        startedAt: null,
        finishedAt: null
      };
    });
    if (updated) {
      st = updated.state;
      board = normalizeBoard(st.board);
      afterState();
      renderSeats(); renderTurn(); renderButtons(); draw();
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
      st = r.state || {};
      board = normalizeBoard(st.board);

      await ensureJoined();

      var ps = (await GH.db.listPlayers(roomCode)) || [];
      players = ps;
      syncMe();

      initCanvas();
      renderSeats();
      renderTurn();
      renderButtons();
      draw();
      poller.start();
    } catch (e) {
      U.toast('进入房间失败：' + GH.errText(e), 'err');
    }
  });

})();
