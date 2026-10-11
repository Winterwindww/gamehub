/* =========================================================
   联机游戏厅 · 音效
   ---------------------------------------------------------
   全部用 Web Audio 实时合成，不加载任何音频文件：
   零网络依赖、不占体积；顺便避开了 CDN 不可达的坑。

   用法：Snd.play('chip') / Snd.toggle() / Snd.isMuted()
   浏览器要求先有一次用户交互才能出声，所以首次点击
   （任意位置）时会自动激活音频上下文。
   ========================================================= */
(function (global) {
  'use strict';

  var LS_MUTE = 'gh_sound_muted';
  var MASTER_VOL = 0.55;

  var ctx = null;
  var master = null;
  var muted = false;
  var listeners = [];
  var lastAt = {};          // 同名音效的最小间隔，防止机关枪

  /* 每个音效的最小间隔（毫秒） */
  var GAP = {
    deal: 50,
    flip: 55,
    chip: 90,
    place: 40,
    capture: 70,
    msg: 600,
    emote: 300,
    click: 40,
    turn: 800
  };

  /* ---------------- 状态 ---------------- */

  function readMute() {
    try { return localStorage.getItem(LS_MUTE) === '1'; }
    catch (e) { return false; }
  }

  function writeMute(v) {
    try { localStorage.setItem(LS_MUTE, v ? '1' : '0'); }
    catch (e) { /* 忽略 */ }
  }

  muted = readMute();

  /* ---------------- 音频上下文 ---------------- */

  function ensure() {
    if (ctx) { return ctx; }
    var AC = global.AudioContext || global.webkitAudioContext;
    if (!AC) { return null; }
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER_VOL;
      master.connect(ctx.destination);
    } catch (e) {
      ctx = null;
      master = null;
    }
    return ctx;
  }

  /** 首次用户交互时激活（浏览器自动播放策略） */
  function unlock() {
    var c = ensure();
    if (c && c.state === 'suspended' && c.resume) {
      try { c.resume(); } catch (e) { /* 忽略 */ }
    }
  }

  function bindUnlock() {
    var opts = { passive: true, once: true };
    global.addEventListener('pointerdown', unlock, opts);
    global.addEventListener('touchstart', unlock, opts);
    global.addEventListener('keydown', unlock, opts);
  }

  /* ---------------- 合成基元 ---------------- */

  function startAt(delay) {
    return ctx.currentTime + (delay || 0);
  }

  function shapeGain(g, start, dur, peak, attack) {
    var a = (attack == null) ? 0.006 : attack;
    var v = Math.max(0.0002, peak);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(v, start + a);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  }

  /** 一个带包络的振荡器音 */
  function tone(o) {
    if (!ctx) { return; }
    var osc = ctx.createOscillator();
    var g = ctx.createGain();
    var start = startAt(o.delay);
    var dur = o.dur || 0.12;
    var f0 = o.f0 || 440;
    var f1 = (o.f1 == null) ? f0 : o.f1;

    osc.type = o.type || 'sine';
    osc.frequency.setValueAtTime(f0, start);
    if (f1 !== f0) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, f1), start + dur);
    }
    if (o.detune) { osc.detune.value = o.detune; }

    shapeGain(g, start, dur, o.vol == null ? 0.2 : o.vol, o.attack);
    osc.connect(g);
    g.connect(master);
    osc.start(start);
    osc.stop(start + dur + 0.04);
  }

  /** 一段过滤后的白噪声（用于摩擦、点击、翻牌这类"质感"） */
  function noise(o) {
    if (!ctx) { return; }
    var dur = o.dur || 0.1;
    var start = startAt(o.delay);
    var len = Math.max(1, Math.ceil(ctx.sampleRate * dur));
    var buf = ctx.createBuffer(1, len, ctx.sampleRate);
    var data = buf.getChannelData(0);
    for (var i = 0; i < len; i++) { data[i] = Math.random() * 2 - 1; }

    var src = ctx.createBufferSource();
    src.buffer = buf;

    var filter = ctx.createBiquadFilter();
    filter.type = o.ftype || 'bandpass';
    filter.frequency.setValueAtTime(Math.max(40, o.f0 || 1200), start);
    if (o.f1 && o.f1 !== o.f0) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.f1), start + dur);
    }
    filter.Q.value = (o.q == null) ? 1.2 : o.q;

    var g = ctx.createGain();
    shapeGain(g, start, dur, o.vol == null ? 0.16 : o.vol,
      o.attack == null ? 0.004 : o.attack);

    src.connect(filter);
    filter.connect(g);
    g.connect(master);
    src.start(start);
    src.stop(start + dur + 0.03);
  }

  /* ---------------- 音色表 ---------------- */

  var SOUNDS = {

    /* ---- 欢乐扑克 ---- */

    /** 发牌：纸张擦过桌面的短促声 */
    deal: function (o) {
      var k = (o && o.alt) ? 1.14 : 1;
      noise({ ftype: 'highpass', f0: 1600, f1: 900, dur: 0.07, vol: 0.075, q: 0.7 });
      tone({ type: 'triangle', f0: 1180 * k, f1: 760 * k, dur: 0.05, vol: 0.04 });
    },

    /** 翻公共牌 */
    flip: function () {
      noise({ ftype: 'bandpass', f0: 900, f1: 2700, dur: 0.13, vol: 0.08, q: 0.9 });
      tone({ type: 'triangle', f0: 620, f1: 1200, dur: 0.09, vol: 0.05 });
    },

    /** 下注 / 跟注：欢乐豆碰撞 */
    chip: function (o) {
      var n = (o && o.n) || 3;
      for (var i = 0; i < n; i++) {
        var d = i * 0.032;
        tone({ type: 'triangle', f0: 1500 + i * 330, f1: 900 + i * 190, dur: 0.07, vol: 0.07, delay: d });
        noise({ ftype: 'highpass', f0: 3300, dur: 0.03, vol: 0.04, delay: d, q: 0.6 });
      }
    },

    /** 过牌：敲两下桌子 */
    check: function () {
      [0, 0.1].forEach(function (d) {
        tone({ type: 'sine', f0: 190, f1: 96, dur: 0.09, vol: 0.3, delay: d });
        noise({ ftype: 'lowpass', f0: 700, dur: 0.05, vol: 0.09, delay: d, q: 0.8 });
      });
    },

    /** 放弃 */
    fold: function () {
      tone({ type: 'triangle', f0: 460, f1: 170, dur: 0.2, vol: 0.13 });
      noise({ ftype: 'lowpass', f0: 1400, f1: 300, dur: 0.16, vol: 0.06 });
    },

    /** 全押：拉满的推进 + 落锤 */
    allin: function () {
      tone({ type: 'sawtooth', f0: 180, f1: 860, dur: 0.34, vol: 0.09 });
      tone({ type: 'square', f0: 90, f1: 430, dur: 0.34, vol: 0.045 });
      noise({ ftype: 'bandpass', f0: 600, f1: 3000, dur: 0.34, vol: 0.06, q: 0.7 });
      tone({ type: 'sine', f0: 150, f1: 60, dur: 0.3, vol: 0.26, delay: 0.34 });
    },

    /** 赢了：上行大三和弦 */
    win: function () {
      [523.25, 659.25, 783.99, 1046.5].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.34, vol: 0.12, delay: i * 0.075 });
        tone({ type: 'sine', f0: f * 2, dur: 0.22, vol: 0.045, delay: i * 0.075 });
      });
      tone({ type: 'sine', f0: 1568, dur: 0.5, vol: 0.045, delay: 0.3 });
    },

    /** 输了：下行两音 */
    lose: function () {
      [392, 311.13].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, f1: f * 0.98, dur: 0.34, vol: 0.11, delay: i * 0.16 });
      });
    },

    /** 轮到我：两声清脆提示 */
    turn: function () {
      tone({ type: 'sine', f0: 784, dur: 0.13, vol: 0.15 });
      tone({ type: 'sine', f0: 1174.7, dur: 0.24, vol: 0.11, delay: 0.11 });
    },

    /* ---- 五子棋 ---- */

    /** 落子：木石相击 */
    place: function (o) {
      var k = (o && o.stone === 2) ? 1.22 : 1;
      noise({ ftype: 'bandpass', f0: 1900 * k, f1: 900 * k, dur: 0.045, vol: 0.15, q: 1.4 });
      tone({ type: 'sine', f0: 320 * k, f1: 150 * k, dur: 0.09, vol: 0.19 });
      tone({ type: 'triangle', f0: 1400 * k, f1: 700 * k, dur: 0.04, vol: 0.055 });
    },

    /* ---- 斗兽棋 ---- */

    /** 吃子：一记闷响 + 短促的低吼 */
    capture: function () {
      noise({ ftype: 'lowpass', f0: 1100, f1: 240, dur: 0.17, vol: 0.13 });
      tone({ type: 'sawtooth', f0: 235, f1: 92, dur: 0.2, vol: 0.1 });
      tone({ type: 'sine', f0: 148, f1: 58, dur: 0.24, vol: 0.15 });
    },

    /* ---- 通用 ---- */

    /** 新的一条聊天消息 */
    msg: function () {
      tone({ type: 'sine', f0: 660, f1: 900, dur: 0.1, vol: 0.095 });
    },

    /** 表情 */
    emote: function () {
      tone({ type: 'sine', f0: 880, dur: 0.08, vol: 0.1 });
      tone({ type: 'sine', f0: 1318.5, dur: 0.12, vol: 0.075, delay: 0.07 });
    },

    /** 开局 */
    start: function () {
      [523.25, 659.25, 783.99].forEach(function (f, i) {
        tone({ type: 'triangle', f0: f, dur: 0.2, vol: 0.1, delay: i * 0.06 });
      });
    },

    /** 轻点反馈 */
    click: function () {
      tone({ type: 'sine', f0: 1200, f1: 880, dur: 0.035, vol: 0.05 });
    }
  };

  /* ---------------- 对外接口 ---------------- */

  function play(name, opts) {
    if (muted) { return; }

    var c = ensure();
    if (!c) { return; }
    if (c.state === 'suspended' && c.resume) {
      try { c.resume(); } catch (e) { /* 忽略 */ }
    }

    var fn = SOUNDS[name];
    if (!fn) { return; }

    var gap = GAP[name] || 0;
    var nowMs = Date.now();
    if (gap && lastAt[name] && (nowMs - lastAt[name]) < gap) { return; }
    lastAt[name] = nowMs;

    try { fn(opts || {}); } catch (e) { /* 单个音效出错不影响游戏 */ }
  }

  function notify() {
    listeners.forEach(function (f) {
      try { f(muted); } catch (e) { /* 忽略 */ }
    });
  }

  function setMuted(v) {
    var next = !!v;
    if (next === muted) { return; }
    muted = next;
    writeMute(muted);
    if (!muted) { play('click'); }      // 开启时给个反馈
    syncButton();
    notify();
  }

  function toggle() { setMuted(!muted); }
  function isMuted() { return muted; }

  function onChange(fn) {
    if (typeof fn !== 'function') { return; }
    listeners.push(fn);
    try { fn(muted); } catch (e) { /* 忽略 */ }
  }

  var btnEl = null;

  function renderButton() {
    if (!btnEl) { return; }
    btnEl.innerHTML = '<span class="ico">' + (muted ? '🔇' : '🔊') + '</span><span class="txt">音效</span>';
    btnEl.classList.toggle('off', muted);
    btnEl.title = muted ? '音效已关闭，点击开启' : '音效已开启，点击关闭';
  }

  function syncButton() { renderButton(); }

  function bindButton() {
    btnEl = document.getElementById('soundBtn');
    if (!btnEl) { return; }
    btnEl.onclick = function (e) {
      e.preventDefault();
      e.stopPropagation();
      unlock();
      toggle();
    };
    renderButton();
  }

  global.Snd = {
    play: play,
    toggle: toggle,
    setMuted: setMuted,
    isMuted: isMuted,
    onChange: onChange,
    unlock: unlock
  };

  bindUnlock();
  bindButton();

  /* 音效开关的显示文字随语言环境保持中文，图标随状态切换 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindButton);
  }
})(window);
