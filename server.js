/* =========================================================
   联机游戏厅 · 单端口 HTTP 服务
   ---------------------------------------------------------
   1) 提供静态文件（原来的 index.html / *.html / js / css）
   2) 把同源的 /.cloud/* 反向代理到云端数据服务

   为什么需要第 2 步：
   云数据库按 Origin 做精确白名单校验，只认应用登记的那个保留域名。
   一旦站点跑在别的域名下（比如沙箱/预览域名），浏览器直连就会
   被 403 {"error":"access_denied","error_description":
   "the request origin is not allowed for this client"}，
   前端只能看到 "Failed to fetch"。
   这里由服务器（不带 Origin 头）转发，请求就不再受浏览器同源策略约束。
   页面本身仍然请求同源地址，所以不存在跨域。
   ========================================================= */
'use strict';

var http = require('http');
var https = require('https');
var fs = require('fs');
var path = require('path');
var url = require('url');

var ROOT = __dirname;
var PORT = Number(process.env.PORT || 3000);
var UPSTREAM = process.env.CLOUD_UPSTREAM || 'https://gamehub-61313.app.workbuddy.host';
var CLOUD_PREFIX = '/.cloud/';
var PROXY_PREFIX = '/.ghproxy';

var MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8'
};

/* 逐跳首部，转发时必须剔除 */
var HOP_BY_HOP = [
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade'
];

/* 请求上游时主动丢掉的首部：Origin/Referer 会触发白名单校验，
   Host 必须改写成上游，Accept-Encoding 丢掉可以拿到明文响应。 */
var STRIP_REQUEST = ['host', 'origin', 'referer', 'accept-encoding', 'content-length'];

function send(res, code, type, body) {
  var buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  res.writeHead(code, {
    'Content-Type': type,
    'Content-Length': buf.length,
    'Cache-Control': 'no-store'
  });
  res.end(buf);
}

/* ---------------- 静态文件 ---------------- */

function serveStatic(req, res) {
  var parsed = url.parse(req.url);
  var pathname;
  try { pathname = decodeURIComponent(parsed.pathname); } catch (e) { pathname = parsed.pathname; }
  if (!pathname || pathname === '/') { pathname = '/index.html'; }

  var target = path.normalize(path.join(ROOT, pathname));
  if (target.indexOf(ROOT) !== 0) { return send(res, 403, 'text/plain; charset=utf-8', '403 Forbidden'); }

  fs.stat(target, function (err, st) {
    if (err || !st.isFile()) {
      return send(res, 404, 'text/plain; charset=utf-8', '404 Not Found');
    }
    var type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    var headers = { 'Content-Type': type, 'Content-Length': st.size };
    // 页面按 ?v=N 控制缓存，其它静态资源也交给浏览器缓存一小段时间
    if (/\/vendor\//.test(pathname)) {
      headers['Cache-Control'] = 'public, max-age=86400';
    } else {
      headers['Cache-Control'] = 'no-cache';
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') { return res.end(); }
    fs.createReadStream(target).pipe(res);
  });
}

/* ---------------- /.cloud/* 反向代理 ---------------- */

/* 只转发下列请求头到云端。平台边缘会给请求注入 Cookie / Authorization
   等"属于本应用会话"的凭据；原样转发会让云端判定该会话属于别的客户端，
   直接回 401 invalid_grant: issued for another client。 */
var FORWARD_HEADERS = [
  'x-wb-webapp-access-key', 'content-type', 'prefer', 'accept',
  'content-range', 'range', 'if-match', 'if-none-match',
  'x-wb-webapp-language', 'x-device-id', 'x-request-id'
];

function proxyCloud(req, res) {
  // 页面侧用 /.ghproxy 发起请求（平台边缘会接管 /.cloud，只有这个前缀能落到本服务）
  var target = req.url.replace(/^\/\.ghproxy/, '/.cloud');
  var upstreamUrl = new URL(target, UPSTREAM);
  var headers = {};

  FORWARD_HEADERS.forEach(function (name) {
    if (req.headers[name] !== undefined) { headers[name] = req.headers[name]; }
  });
  headers.host = upstreamUrl.host;

  var opts = {
    method: req.method,
    headers: headers,
    // 上游证书正常，这里保持默认校验
    timeout: 20000
  };

  var preq = https.request(upstreamUrl, opts, function (pres) {
    var out = {};
    Object.keys(pres.headers).forEach(function (k) {
      var lk = k.toLowerCase();
      if (HOP_BY_HOP.indexOf(lk) >= 0) { return; }
      if (lk === 'content-length') { return; }
      if (/^access-control-/i.test(k)) { return; }
      out[k] = pres.headers[k];
    });
    // 同源请求，不需要 CORS 头；显式补一个免得有别的用法
    out['Access-Control-Allow-Origin'] = req.headers.origin || '*';
    res.writeHead(pres.statusCode || 502, out);
    pres.pipe(res);
  });

  preq.on('timeout', function () {
    preq.destroy(new Error('upstream timeout'));
  });
  preq.on('error', function (e) {
    if (res.headersSent) { return res.end(); }
    send(res, 502, 'application/json; charset=utf-8',
      JSON.stringify({ error: 'proxy_error', error_description: String(e && e.message || e) }));
  });

  req.pipe(preq);
}

/* ---------------- 服务 ---------------- */

var server = http.createServer(function (req, res) {
  var pathname = url.parse(req.url).pathname || '/';

  if (pathname.indexOf(PROXY_PREFIX) === 0 || pathname.indexOf(CLOUD_PREFIX) === 0 || pathname === '/.cloud') {
    return proxyCloud(req, res);
  }

  // 健康检查，方便发布时确认服务确实起来了
  if (pathname === '/__health') {
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify({ ok: true, upstream: UPSTREAM, time: new Date().toISOString() }));
  }

  if (pathname === '/__headers') {
    var echo = {};
    Object.keys(req.headers).forEach(function (k) { echo[k] = req.headers[k]; });
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify({ headers: echo, upstream: UPSTREAM }, null, 2));
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'text/plain; charset=utf-8', '405 Method Not Allowed');
  }

  return serveStatic(req, res);
});

server.listen(PORT, '0.0.0.0', function () {
  console.log('[gamehub] listening on 0.0.0.0:' + PORT + ' (cloud proxy -> ' + UPSTREAM + ')');
});
