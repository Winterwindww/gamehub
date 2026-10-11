/* =========================================================
   联机游戏厅 · 云端数据层
   ---------------------------------------------------------
   publicConfig 由云服务开通时下发，集中在此处管理，
   所有云端调用都基于它初始化出来的同一个客户端实例。
   ========================================================= */
(function (global) {
  'use strict';

  /* 云端数据库按 Origin 精确白名单放行，只认应用登记的那个保留域名。
     所以这里优先用「当前页面自己的域名」发起请求（同源）：不管站点跑在
     保留域名还是别的域名上，请求都发给自己，再由服务器转发到云端。
     见 server.js —— 本地直连时它会代理 /.cloud/*。 */
  var FALLBACK_ENDPOINT = 'https://gamehub-61313.app.workbuddy.host';

  function pageOrigin() {
    try {
      var o = global.location && global.location.origin;
      if (o && o !== 'null' && /^https?:/i.test(o)) { return o; }
    } catch (e) { /* 忽略 */ }
    return FALLBACK_ENDPOINT;
  }

  var publicConfig = {
    endpoint: pageOrigin(),
    oauthRelayBaseUrl: 'https://www.workbuddy.cn/v2/as/genie-baas/oauth',
    publishableKey: 'wbpk_PoZriS3v9Nwtxfs3gHjpFo_WcHE1dKjQfWfDqFnVxLIgxrRsROp14Qp'
  };

  // 本地副本优先（不依赖公共 CDN 的稳定性），失败时依次回退
  var SDK_URLS = [
    'js/vendor/workbuddy-cloud-sdk.js',
    'https://unpkg.com/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js',
    'https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js'
  ];

  var client = null;
  var failed = null;
  var readyCbs = [];

  function createClient() {
    client = global.WorkBuddyCloud.createWorkBuddyCloud({
      endpoint: publicConfig.endpoint,
      oauthRelayBaseUrl: publicConfig.oauthRelayBaseUrl,
      publishableKey: publicConfig.publishableKey
    });
  }

  function flush() {
    var cbs = readyCbs.slice();
    readyCbs.length = 0;
    for (var i = 0; i < cbs.length; i++) { cbs[i](failed); }
  }

  function onReady(cb) {
    if (client || failed) { cb(failed); return; }
    readyCbs.push(cb);
  }

  function loadSdk(i) {
    if (i >= SDK_URLS.length) {
      failed = '云端组件加载失败，请检查网络后刷新页面';
      flush();
      return;
    }
    var s = document.createElement('script');
    s.src = SDK_URLS[i];
    s.async = false;
    s.onload = function () {
      if (global.WorkBuddyCloud && typeof global.WorkBuddyCloud.createWorkBuddyCloud === 'function') {
        try { createClient(); } catch (e) { failed = '云端初始化失败：' + (e && e.message ? e.message : e); }
      } else {
        failed = '云端组件内容异常，请刷新重试';
      }
      flush();
    };
    s.onerror = function () { loadSdk(i + 1); };
    document.head.appendChild(s);
  }

  /* ---------------- 基础封装 ---------------- */

  function tbl(name) {
    if (!client) throw new Error('尚未连接到云端数据服务');
    return client.database.from(name);
  }

  function unwrap(res) {
    if (res && res.error) throw res.error;
    return res ? res.data : null;
  }

  function errText(e) {
    if (!e) { return '未知错误'; }
    if (e.code === '42501') { return '没有权限执行该操作'; }
    if (e.code === '23505') { return '记录已存在'; }
    if (e.code === '42P01') { return '数据表尚未创建'; }
    var m = e.message ? String(e.message) : String(e);
    if (isBlocked({ message: m })) { return '网络连接被中断，请再试一次'; }
    return m;
  }

  /* ---------------- 写入通道 ----------------
   * 部分手机内置浏览器 / 网络代理会把 PATCH 请求拦掉（网关直接回 400），
   * 于是「修改」永远写不进去（落子失败、在线状态不刷新）。
   * 这里默认用 PATCH 走乐观锁，一旦发现被拦就整体降级为 POST upsert
   * （按唯一键合并），从此只用 GET / POST 两种方法。
   */
  var LS_MODE = 'gh_rest_write_mode';
  var useUpsert = false;
  try { useUpsert = localStorage.getItem(LS_MODE) === 'upsert'; } catch (e) { /* 忽略 */ }

  function markUpsert() {
    if (useUpsert) { return; }
    useUpsert = true;
    try { localStorage.setItem(LS_MODE, 'upsert'); } catch (e) { /* 忽略 */ }
  }

  /** 判断是不是"网络/网关层面的拦截"，而不是业务错误 */
  function isBlocked(e) {
    if (!e) { return false; }
    var m = e.message === undefined || e.message === null ? String(e) : String(e.message);
    return /<html|<!doctype|<\s*head|bad request|bad gateway|gateway|failed to fetch|networkerror|network error|load failed|502|503|504/i.test(m);
  }

  function pick(src) {
    var out = {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) { out[k] = src[k]; }
    }
    return out;
  }

  /** PATCH 失败后的兜底：POST + on_conflict 合并写入 */
  function upsertRoom(room, next) {
    var body = {
      code: room.code,
      game_type: room.game_type || null,
      status: room.status || 'waiting',
      config: room.config || {},
      host_player_id: room.host_player_id || null
    };
    for (var k in next) {
      if (Object.prototype.hasOwnProperty.call(next, k)) { body[k] = next[k]; }
    }
    if (!body.state) { body.state = room.state || {}; }
    return tbl('game_rooms')
      .upsert(body, { onConflict: 'code' })
      .select()
      .then(unwrap)
      .then(function (rows) { return (rows && rows.length) ? rows[0] : null; });
  }

  function upsertPlayer(player, patch) {
    var body = {
      room_code: player.room_code,
      player_id: player.player_id,
      nickname: player.nickname,
      seat: player.seat,
      is_host: !!player.is_host
    };
    for (var k in patch) {
      if (Object.prototype.hasOwnProperty.call(patch, k)) { body[k] = patch[k]; }
    }
    return tbl('game_players')
      .upsert(body, { onConflict: 'room_code,player_id' })
      .select()
      .then(unwrap)
      .then(function (rows) { return (rows && rows.length) ? rows[0] : null; });
  }

  var db = {

    /* ---------- 房间 ---------- */

    createRoom: function (o) {
      return tbl('game_rooms').insert({
        code: o.code,
        game_type: o.gameType,
        status: o.status || 'waiting',
        config: o.config || {},
        state: o.state || {},
        host_player_id: o.hostPlayerId || null
      }).select().then(unwrap).then(function (rows) { return rows && rows[0]; });
    },

    getRoom: function (code) {
      return tbl('game_rooms').select('*').eq('code', code).maybeSingle().then(unwrap);
    },

    /**
     * 乐观并发更新：只有版本号仍然一致时才会写入。
     * 返回更新后的行；返回 null 表示版本冲突（期间有人改过），调用方应重新拉取后重试。
     * room 传完整房间行（至少要 id / version / code）。
     */
    updateRoom: function (room, patch) {
      var next = pick(patch);
      next.version = (Number(room.version) || 0) + 1;
      next.updated_at = new Date().toISOString();

      if (useUpsert) { return upsertRoom(room, next); }

      return tbl('game_rooms')
        .update(next)
        .eq('id', room.id)
        .eq('version', room.version)
        .select()
        .then(unwrap)
        .then(function (rows) { return (rows && rows.length) ? rows[0] : null; })
        .catch(function (e) {
          if (!isBlocked(e)) { throw e; }
          markUpsert();
          return upsertRoom(room, next);
        });
    },

    /* ---------- 玩家 ---------- */

    listPlayers: function (code) {
      return tbl('game_players')
        .select('*')
        .eq('room_code', code)
        .order('seat', { ascending: true })
        .then(unwrap);
    },

    getPlayer: function (code, playerId) {
      return tbl('game_players')
        .select('*')
        .eq('room_code', code)
        .eq('player_id', playerId)
        .maybeSingle()
        .then(unwrap);
    },

    addPlayer: function (code, playerId, nickname, seat, isHost) {
      return tbl('game_players').insert({
        room_code: code,
        player_id: playerId,
        nickname: nickname,
        seat: seat,
        is_host: !!isHost
      }).select().then(unwrap).then(function (r) { return r && r[0]; });
    },

    updatePlayer: function (player, patch) {
      var next = pick(patch);
      if (useUpsert) { return upsertPlayer(player, next); }
      return tbl('game_players')
        .update(next)
        .eq('id', player.id)
        .select()
        .then(unwrap)
        .catch(function (e) {
          if (!isBlocked(e)) { throw e; }
          markUpsert();
          return upsertPlayer(player, next);
        });
    },

    touchPlayer: function (player) {
      var patch = { last_seen: new Date().toISOString() };
      if (useUpsert) { return upsertPlayer(player, patch); }
      return tbl('game_players')
        .update(patch)
        .eq('id', player.id)
        .select()
        .then(unwrap)
        .catch(function (e) {
          if (!isBlocked(e)) { throw e; }
          markUpsert();
          return upsertPlayer(player, patch);
        });
    },

    removePlayer: function (code, playerId) {
      return tbl('game_players')
        .delete()
        .eq('room_code', code)
        .eq('player_id', playerId)
        .select()
        .then(unwrap);
    },

    /* ---------- 公聊 ---------- */

    /** 拉取房间消息；afterId 有值时只取比它新的部分 */
    listChat: function (code, afterId, limit) {
      var q = tbl('chat_messages').select('*').eq('room_code', code);
      if (afterId) { q = q.gt('id', afterId); }
      return q.order('id', { ascending: false })
        .limit(limit || 60)
        .then(unwrap)
        .then(function (rows) { return (rows || []).reverse(); });
    },

    sendChat: function (code, playerId, nickname, body) {
      return tbl('chat_messages').insert({
        room_code: code,
        player_id: playerId,
        nickname: nickname,
        body: body
      }).select().then(unwrap).then(function (r) { return r && r[0]; });
    },

    /** 房间消息过多时，丢掉最旧的一批，只保留最近 200 条 */
    trimChat: function (code) {
      return tbl('chat_messages')
        .select('id')
        .eq('room_code', code)
        .order('id', { ascending: true })
        .limit(200)
        .then(unwrap)
        .then(function (rows) {
          if (!rows || rows.length < 200) { return 0; }
          var cutoff = rows[99].id;
          return tbl('chat_messages')
            .delete()
            .eq('room_code', code)
            .lt('id', cutoff)
            .then(unwrap)
            .then(function () { return cutoff; });
        });
    },

    /* ---------- 桌上表情 ---------- */

    /**
     * 表情同步。不传 afterId 时只取最新一条的 id，
     * 用来建立同步位点（避免把历史表情重播一遍）。
     */
    listEmotes: function (code, afterId) {
      if (!afterId) {
        return tbl('room_emotes')
          .select('id')
          .eq('room_code', code)
          .order('id', { ascending: false })
          .limit(1)
          .then(unwrap)
          .then(function (rows) { return rows || []; });
      }
      return tbl('room_emotes')
        .select('*')
        .eq('room_code', code)
        .gt('id', afterId)
        .order('id', { ascending: false })
        .limit(40)
        .then(unwrap)
        .then(function (rows) { return (rows || []).reverse(); });
    },

    sendEmote: function (code, playerId, nickname, emoji) {
      return tbl('room_emotes').insert({
        room_code: code,
        player_id: playerId,
        nickname: nickname,
        emoji: emoji
      }).select().then(unwrap).then(function (r) { return r && r[0]; });
    },

    /** 表情是临时数据，攒够 300 条就丢掉旧的 */
    trimEmotes: function (code) {
      return tbl('room_emotes')
        .select('id')
        .eq('room_code', code)
        .order('id', { ascending: true })
        .limit(300)
        .then(unwrap)
        .then(function (rows) {
          if (!rows || rows.length < 300) { return 0; }
          var cutoff = rows[149].id;
          return tbl('room_emotes')
            .delete()
            .eq('room_code', code)
            .lt('id', cutoff)
            .then(unwrap)
            .then(function () { return cutoff; });
        });
    }
  };

  global.GH = {
    config: publicConfig,
    onReady: onReady,
    isReady: function () { return !!client; },
    error: function () { return failed; },
    errText: errText,
    db: db
  };

  loadSdk(0);
})(window);
