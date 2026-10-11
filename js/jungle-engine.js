/* =========================================================
   联机游戏厅 · 斗兽棋规则引擎
   ---------------------------------------------------------
   纯逻辑，不碰 DOM，可单独在 Node 里跑回归测试。

   棋盘 7 列 × 9 行（横 7 纵 9）。
   蓝方（side 1）在上方，红方（side 2）在下方。

   地形：
     · 小河   两块 2×3 —— x∈{1,2} 与 x∈{4,5}，y∈{3,4,5}
     · 兽穴   (3,0) 归蓝方、(3,8) 归红方
     · 陷阱   兽穴的「前、左、右」三个邻格：
               蓝方 (2,0)/(3,1)/(4,0)，红方 (2,8)/(3,7)/(4,8)
     x=0 / x=3 / x=6 三列是贯穿南北的陆地通道。

   规则要点（本引擎采用的版本）：
     · 每次走一格，横竖皆可，不可斜行；不可进入己方兽穴
     · 只有鼠可以下水，水中走法与陆地相同
     · 等级：象8 > 狮7 > 虎6 > 豹5 > 狼4 > 狗3 > 猫2 > 鼠1
     · 同级可以互吃（先吃到的一方留下）
     · 鼠能吃象；象不能吃鼠
     · 水陆互不相吃（水里的吃不到岸上，岸上的也吃不到水里）
     · 敌子踩进我方陷阱即失去战斗力，我方任意棋子都能吃
     · 狮、虎可纵横跳过小河直接吃对岸的兽；跳跃路线上若有子（尤其是鼠）则跳不过去
     · 进入对方兽穴、吃光对方棋子、或对方无子可动，均为获胜
   ========================================================= */
(function (global) {
  'use strict';

  var W = 7;
  var H = 9;

  var RANK = { elephant: 8, lion: 7, tiger: 6, leopard: 5, wolf: 4, dog: 3, cat: 2, rat: 1 };
  var CN = { elephant: '象', lion: '狮', tiger: '虎', leopard: '豹', wolf: '狼', dog: '狗', cat: '猫', rat: '鼠' };
  var FACE = { elephant: '🐘', lion: '🦁', tiger: '🐯', leopard: '🐆', wolf: '🐺', dog: '🐕', cat: '🐈', rat: '🐭' };

  var DRAW_PLY = 60;          // 连续 60 手（双方各 30 步）不落吃子即判和

  /* ---------------- 地形 ---------------- */

  function isWater(x, y) {
    if (y < 3 || y > 5) { return false; }
    return x === 1 || x === 2 || x === 4 || x === 5;
  }

  function denSide(x, y) {
    if (x === 3 && y === 0) { return 1; }
    if (x === 3 && y === 8) { return 2; }
    return 0;
  }

  var TRAP = {
    '2,0': 1, '3,1': 1, '4,0': 1,
    '2,8': 2, '3,7': 2, '4,8': 2
  };

  function trapSide(x, y) { return TRAP[x + ',' + y] || 0; }

  /* ---------------- 初始布局 ----------------
     国际通行标准摆法：
       底线两端   狮、虎（分守兽穴两翼）
       第二行     狗（左）、猫（右）
       前沿一行   鼠（左角）、豹、狼、象（右角）
     红方是蓝方旋转 180°，于是红方的「鼠」恰好对着蓝方的「象」。 */

  var SETUP = {
    1: [
      { x: 0, y: 0, t: 'lion' }, { x: 6, y: 0, t: 'tiger' },
      { x: 1, y: 1, t: 'dog' }, { x: 5, y: 1, t: 'cat' },
      { x: 0, y: 2, t: 'rat' }, { x: 2, y: 2, t: 'leopard' }, { x: 4, y: 2, t: 'wolf' }, { x: 6, y: 2, t: 'elephant' }
    ],
    2: [
      { x: 6, y: 8, t: 'lion' }, { x: 0, y: 8, t: 'tiger' },
      { x: 5, y: 7, t: 'dog' }, { x: 1, y: 7, t: 'cat' },
      { x: 6, y: 6, t: 'rat' }, { x: 4, y: 6, t: 'leopard' }, { x: 2, y: 6, t: 'wolf' }, { x: 0, y: 6, t: 'elephant' }
    ]
  };

  function emptyBoard() {
    var b = [];
    for (var y = 0; y < H; y++) {
      var row = [];
      for (var x = 0; x < W; x++) { row.push(null); }
      b.push(row);
    }
    return b;
  }

  function newBoard() {
    var b = emptyBoard();
    [1, 2].forEach(function (side) {
      SETUP[side].forEach(function (p) {
        b[p.y][p.x] = { t: p.t, s: side };
      });
    });
    return b;
  }

  function cloneBoard(b) {
    return b.map(function (row) {
      return row.map(function (c) { return c ? { t: c.t, s: c.s } : null; });
    });
  }

  function inBounds(x, y) { return x >= 0 && x < W && y >= 0 && y < H; }

  /* ---------------- 吃子 ---------------- */

  function canCapture(board, fx, fy, tx, ty) {
    var a = board[fy][fx];
    var d = board[ty][tx];
    if (!a || !d || a.s === d.s) { return false; }

    // 敌子站在我方的陷阱里 —— 失去战斗力，我方谁都能吃
    if (trapSide(tx, ty) === a.s) { return true; }

    var aInWater = isWater(fx, fy);
    var dInWater = isWater(tx, ty);
    if (aInWater !== dInWater) { return false; }   // 水陆互不相吃

    if (a.t === 'elephant' && d.t === 'rat') { return false; }   // 象吃不掉鼠
    if (a.t === 'rat' && d.t === 'elephant') { return true; }    // 鼠吃得掉象

    return RANK[a.t] >= RANK[d.t];
  }

  /* ---------------- 走法 ---------------- */

  var DIRS = [[0, -1], [0, 1], [-1, 0], [1, 0]];

  /** 某个棋子的全部合法落点，jump=true 表示这一步是狮虎跳河 */
  function legalMoves(board, x, y) {
    var p = board[y][x];
    if (!p || !inBounds(x, y)) { return []; }

    var out = [];

    /* 常规：四邻走一格 */
    for (var i = 0; i < DIRS.length; i++) {
      var tx = x + DIRS[i][0];
      var ty = y + DIRS[i][1];
      if (!inBounds(tx, ty)) { continue; }
      if (denSide(tx, ty) === p.s) { continue; }                 // 己方兽穴进不得
      if (isWater(tx, ty) && p.t !== 'rat') { continue; }        // 只有鼠能下水

      var d = board[ty][tx];
      if (!d) { out.push({ x: tx, y: ty, jump: false }); continue; }
      if (canCapture(board, x, y, tx, ty)) { out.push({ x: tx, y: ty, jump: false }); }
    }

    /* 狮虎跳河：沿直线越过整片水面，落到对岸第一块陆地 */
    if (p.t === 'lion' || p.t === 'tiger') {
      for (var j = 0; j < DIRS.length; j++) {
        var cx = x + DIRS[j][0];
        var cy = y + DIRS[j][1];
        var crossed = 0;
        while (inBounds(cx, cy) && isWater(cx, cy) && !board[cy][cx]) {
          cx += DIRS[j][0];
          cy += DIRS[j][1];
          crossed++;
        }
        if (crossed === 0) { continue; }               // 没跨过水
        if (!inBounds(cx, cy) || isWater(cx, cy)) { continue; }   // 半途而废
        if (denSide(cx, cy) === p.s) { continue; }     // 己方兽穴

        var t2 = board[cy][cx];
        if (!t2) { out.push({ x: cx, y: cy, jump: true }); continue; }
        if (canCapture(board, x, y, cx, cy)) { out.push({ x: cx, y: cy, jump: true }); }
      }
    }

    return out;
  }

  function eachPiece(board, fn) {
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        if (board[y][x] && fn(board[y][x], x, y) === false) { return; }
      }
    }
  }

  function hasAnyPiece(board, side) {
    var found = false;
    eachPiece(board, function (p) { if (p.s === side) { found = true; return false; } });
    return found;
  }

  function hasAnyMove(board, side) {
    var found = false;
    eachPiece(board, function (p, x, y) {
      if (p.s === side && legalMoves(board, x, y).length) { found = true; return false; }
    });
    return found;
  }

  /* ---------------- 落子 ---------------- */

  /**
   * 执行一步。返回 { board, captured, winner, reason }。
   * winner: 0 未结束 / 1 / 2 某方胜 / 3 和棋
   * reason: 'den' 入穴 | 'wipe' 吃光 | 'stuck' 困毙 | 'draw' 和棋
   */
  function applyMove(board, fx, fy, tx, ty, drawPly) {
    var nb = cloneBoard(board);
    var mover = nb[fy][fx];
    var captured = nb[ty][tx];
    nb[ty][tx] = mover;
    nb[fy][fx] = null;

    var foe = 3 - mover.s;
    var winner = 0;
    var reason = '';
    var ply = captured ? 0 : ((drawPly || 0) + 1);   // 连续不吃子的手数

    if (denSide(tx, ty) && denSide(tx, ty) !== mover.s) {
      winner = mover.s;
      reason = 'den';
    } else if (!hasAnyPiece(nb, foe)) {
      winner = mover.s;
      reason = 'wipe';
    } else if (!hasAnyMove(nb, foe)) {
      winner = mover.s;
      reason = 'stuck';
    } else if (ply >= DRAW_PLY) {
      winner = 3;
      reason = 'draw';
    }

    return {
      board: nb,
      captured: captured,
      winner: winner,
      reason: reason,
      drawPly: winner ? 0 : ply,
      lastMove: { fx: fx, fy: fy, tx: tx, ty: ty }
    };
  }

  /* ---------------- 状态 ---------------- */

  function newState() {
    return {
      board: newBoard(),
      turn: 1,
      moves: [],
      drawPly: 0,
      winner: 0,
      reason: '',
      startedAt: null,
      finishedAt: null
    };
  }

  function normalizeBoard(b) {
    if (!Array.isArray(b) || b.length !== H) { return newBoard(); }
    var out = emptyBoard();
    for (var y = 0; y < H; y++) {
      if (!Array.isArray(b[y]) || b[y].length !== W) { return newBoard(); }
      for (var x = 0; x < W; x++) {
        var c = b[y][x];
        if (c && typeof c === 'object' && RANK[c.t] && (c.s === 1 || c.s === 2)) {
          out[y][x] = { t: c.t, s: c.s };
        }
      }
    }
    return out;
  }

  function normalizeState(raw) {
    var s = raw && typeof raw === 'object' ? raw : {};
    var st = newState();
    st.board = normalizeBoard(s.board);
    st.turn = (s.turn === 2) ? 2 : 1;
    st.moves = Array.isArray(s.moves) ? s.moves.slice(-240) : [];
    st.drawPly = typeof s.drawPly === 'number' ? s.drawPly : 0;
    st.winner = (s.winner === 1 || s.winner === 2 || s.winner === 3) ? s.winner : 0;
    st.reason = typeof s.reason === 'string' ? s.reason : '';
    st.startedAt = s.startedAt || null;
    st.finishedAt = s.finishedAt || null;
    return st;
  }

  function countPieces(board, side) {
    var n = 0;
    eachPiece(board, function (p) { if (p.s === side) { n++; } });
    return n;
  }

  /* ---------------- 悔棋 ----------------
     收回自己刚走的那一步（必须是对手还没应招的时候）。
     被吃掉的子会原样回到原位，连续不吃子的手数也一并回退。
     返回新的 state；不能悔棋时返回 null。 */

  function undoLast(state, side) {
    var st = normalizeState(state);
    if (!side || st.winner) { return null; }

    var ms = st.moves || [];
    var last = ms[ms.length - 1];
    if (!last || last.s !== side) { return null; }      // 只能收回自己的棋
    if (last.fx === last.tx && last.fy === last.ty) { return null; }
    if (!inBounds(last.fx, last.fy) || !inBounds(last.tx, last.ty)) { return null; }

    var board = cloneBoard(st.board);
    if (!board[last.ty][last.tx]) { return null; }
    board[last.ty][last.tx] = last.cap ? { t: last.cap, s: last.capS } : null;
    board[last.fy][last.fx] = { t: last.t, s: last.s };

    var rest = ms.slice(0, -1);
    var ply = 0;                                        // 连续不吃子的手数
    for (var i = rest.length - 1; i >= 0; i--) {
      if (rest[i].cap) { break; }
      ply++;
    }

    return {
      board: board,
      turn: side,
      moves: rest,
      drawPly: ply,
      winner: 0,
      reason: '',
      startedAt: st.startedAt,
      finishedAt: null
    };
  }

  /** 开局前 sanity：双方各 8 子 */
  function canStart(state) {
    var st = normalizeState(state);
    if (st.winner) { return { ok: false, why: '本局已结束' }; }
    if (countPieces(st.board, 1) !== 8 || countPieces(st.board, 2) !== 8) {
      return { ok: false, why: '棋子数不对' };
    }
    return { ok: true };
  }

  global.Jungle = {
    W: W,
    H: H,
    RANK: RANK,
    CN: CN,
    FACE: FACE,
    DRAW_PLY: DRAW_PLY,
    isWater: isWater,
    denSide: denSide,
    trapSide: trapSide,
    newBoard: newBoard,
    cloneBoard: cloneBoard,
    legalMoves: legalMoves,
    canCapture: canCapture,
    applyMove: applyMove,
    undoLast: undoLast,
    hasAnyPiece: hasAnyPiece,
    hasAnyMove: hasAnyMove,
    countPieces: countPieces,
    newState: newState,
    normalizeState: normalizeState,
    normalizeBoard: normalizeBoard,
    canStart: canStart,
    /* 供界面与自测使用，避免两处各写一份 */
    SETUP: SETUP
  };
})(typeof window !== 'undefined' ? window : globalThis);
