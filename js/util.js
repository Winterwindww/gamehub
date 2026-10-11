/* =========================================================
   联机游戏厅 · 通用工具
   ========================================================= */
(function (global) {
  'use strict';

  var LS_ID = 'gh_player_id';
  var LS_NAME = 'gh_nickname';

  /* ---------------- 身份 ---------------- */

  function uid() {
    return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
  }

  function getPlayerId() {
    var v = null;
    try { v = localStorage.getItem(LS_ID); } catch (e) { v = null; }
    if (!v) {
      v = uid();
      try { localStorage.setItem(LS_ID, v); } catch (e) { /* 忽略 */ }
    }
    return v;
  }

  function getNickname() {
    try { return localStorage.getItem(LS_NAME) || ''; } catch (e) { return ''; }
  }

  function setNickname(n) {
    try { localStorage.setItem(LS_NAME, n); } catch (e) { /* 忽略 */ }
  }

  /* ---------------- 房间码 ---------------- */

  /* 房间码 = 4 位数字，好念好记 */
  var CODE_LEN = 4;

  function makeCode(len) {
    var n = len || CODE_LEN;
    var out = '';
    for (var i = 0; i < n; i++) {
      out += String(Math.floor(Math.random() * 10));
    }
    return out;
  }

  function cleanCode(v) {
    return String(v || '').replace(/[^0-9]/g, '').slice(0, CODE_LEN);
  }

  /* ---------------- 展示辅助 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function avatarColor(name) {
    var h = 0;
    var s = String(name || '?');
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) % 360; }
    return 'hsl(' + h + ', 62%, 62%)';
  }

  function initial(name) {
    var s = String(name || '?').trim();
    return s ? s.charAt(0).toUpperCase() : '?';
  }

  var ONLINE_WINDOW_MS = 15000;

  function isOnline(lastSeen) {
    if (!lastSeen) { return false; }
    return (Date.now() - new Date(lastSeen).getTime()) < ONLINE_WINDOW_MS;
  }

  function money(n) {
    var v = Number(n) || 0;
    return v.toLocaleString('zh-CN');
  }

  /* ---------------- Toast ---------------- */

  function toastHost() {
    var el = document.getElementById('gh-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'gh-toast';
      document.body.appendChild(el);
    }
    return el;
  }

  function toast(msg, type) {
    var host = toastHost();
    var item = document.createElement('div');
    item.className = 'toast-item' + (type ? ' ' + type : '');
    item.textContent = msg;
    host.appendChild(item);
    setTimeout(function () {
      item.style.transition = 'opacity .25s';
      item.style.opacity = '0';
      setTimeout(function () { if (item.parentNode) { item.parentNode.removeChild(item); } }, 260);
    }, 2400);
  }

  /* ---------------- Modal ---------------- */

  function modal(opts) {
    return new Promise(function (resolve) {
      var mask = document.createElement('div');
      mask.className = 'gh-modal-mask';

      var box = document.createElement('div');
      box.className = 'gh-modal';

      var h = document.createElement('h3');
      h.textContent = opts.title || '提示';
      box.appendChild(h);

      if (opts.message) {
        var p = document.createElement('p');
        p.textContent = opts.message;
        box.appendChild(p);
      }

      var row = document.createElement('div');
      row.className = 'row';

      function close(val) {
        if (mask.parentNode) { mask.parentNode.removeChild(mask); }
        resolve(val);
      }

      if (opts.cancelText !== null) {
        var cancel = document.createElement('button');
        cancel.className = 'btn';
        cancel.textContent = opts.cancelText || '取消';
        cancel.onclick = function () { close(false); };
        row.appendChild(cancel);
      }

      var ok = document.createElement('button');
      ok.className = 'btn ' + (opts.danger ? 'btn-danger' : 'btn-primary');
      ok.textContent = opts.okText || '确定';
      ok.onclick = function () { close(true); };
      row.appendChild(ok);

      box.appendChild(row);
      mask.appendChild(box);
      mask.addEventListener('click', function (e) {
        if (e.target === mask && opts.cancelText !== null) { close(false); }
      });
      document.body.appendChild(mask);
      ok.focus();
    });
  }

  function confirmBox(title, message, okText) {
    return modal({ title: title, message: message, okText: okText || '确定' });
  }

  function alertBox(title, message) {
    return modal({ title: title, message: message, okText: '知道了', cancelText: null });
  }

  /* ---------------- 剪贴板 ---------------- */

  function copyText(text) {
    return new Promise(function (resolve) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { resolve(true); }, function () { resolve(fallbackCopy(text)); });
      } else {
        resolve(fallbackCopy(text));
      }
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) {
      return false;
    }
  }

  /* ---------------- 轮询 ---------------- */

  function createPoller(fn, intervalMs) {
    var timer = null;
    var busy = false;
    var stopped = false;

    function tick() {
      if (stopped || busy) { return; }
      busy = true;
      Promise.resolve()
        .then(fn)
        .catch(function (e) { console.warn('[poll]', e); })
        .then(function () { busy = false; });
    }

    return {
      start: function () {
        if (timer) { return; }
        stopped = false;
        tick();
        timer = setInterval(tick, intervalMs);
      },
      stop: function () {
        stopped = true;
        if (timer) { clearInterval(timer); timer = null; }
      },
      kick: function () { setTimeout(tick, 0); }
    };
  }

  /* ---------------- 默认配置 ---------------- */

  var DEFAULTS = {
    poker: {
      startChips: 1000,
      smallBlind: 10,
      bigBlind: 20
    }
  };

  global.U = {
    getPlayerId: getPlayerId,
    getNickname: getNickname,
    setNickname: setNickname,
    makeCode: makeCode,
    cleanCode: cleanCode,
    CODE_LEN: CODE_LEN,
    esc: esc,
    avatarColor: avatarColor,
    initial: initial,
    isOnline: isOnline,
    money: money,
    toast: toast,
    modal: modal,
    confirm: confirmBox,
    alert: alertBox,
    copyText: copyText,
    createPoller: createPoller,
    DEFAULTS: DEFAULTS
  };
})(window);
