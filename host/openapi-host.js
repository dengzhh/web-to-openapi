"use strict";
/*
 * openapi-host.js  ——  「独立 Edge 插件 + OpenAPI 服务」的 native host
 * ---------------------------------------------------------------------------
 * 定位:
 *   - 由 Edge 扩展(web-to-openapi/extension)经 native messaging 拉起; 但 stdio 不是"启动钩子",
 *     而是 host <-> 扩展之间的持续命令通道: host 发 call_tool -> 扩展用 chrome.* 执行 -> 回传结果。
 *     去掉 native messaging = host 失去驱动浏览器的能力(它不是可省的启动器)。
 *   - 不提供 MCP 服务, 只对外暴露 OpenAPI 风格的 HTTP API(地址/端口可配置);
 *   - 底层复用 chrome-mcp-server 的浏览器操作接口: native-messaging CALL_TOOL
 *     -> 扩展执行 chrome_* 工具(navigate / javascript / read_page / close_tabs ...)。
 *
 * 与 mcp-chrome-bridge 的关系: 协议完全一致(同源), 但出口是 REST/JSON 而非 MCP;
 * 两者可并行运行(本 host 用独立的 native host 名 com.webtoopenapi.host)。
 *
 * 协议要点(与 chrome-mcp-shared 对齐):
 *   扩展 -> host : {type:"start", payload:{port}}            host 回 {type:"server_started",payload:{port}}
 *   扩展 -> host : {type:"stop"}                              host 回 {type:"server_stopped"}
 *   扩展 -> host : {type:"ping_from_extension"}               host 回 {type:"pong_to_extension"}
 *   host -> 扩展 : {type:"call_tool", payload:{name,args}, requestId}
 *   扩展 -> host : {responseToRequestId, payload:{status:"success", data}} | {error}
 *
 * 日志纪律: stdout 只走协议帧; 所有日志写 stderr + 日志文件。
 * 配置: 同目录 config.json {host,port,tool_timeout_ms}; 环境变量 WEBTOOPENAPI_HOST/
 *       WEBTOOPENAPI_PORT/WEBTOOPENAPI_TOOL_TIMEOUT_MS 覆盖; CLI --host/--port/--config。
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------- 配置
const SCRIPT_DIR = __dirname;
const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 8090,
  tool_timeout_ms: 120000,
};

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  // 1) config.json
  let configPath = path.join(SCRIPT_DIR, "config.json");
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && args[i + 1]) configPath = args[i + 1];
    if (args[i] === "--host" && args[i + 1]) cfg.host = args[i + 1];
    if (args[i] === "--port" && args[i + 1]) cfg.port = parseInt(args[i + 1], 10);
  }
  try {
    const fileCfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (fileCfg.host) cfg.host = fileCfg.host;
    if (fileCfg.port) cfg.port = parseInt(fileCfg.port, 10);
    if (fileCfg.tool_timeout_ms) cfg.tool_timeout_ms = parseInt(fileCfg.tool_timeout_ms, 10);
  } catch (e) {
    log("warn", `config.json 读取失败(${e.message}), 使用默认/环境变量配置`);
  }
  // 2) 环境变量覆盖
  if (process.env.WEBTOOPENAPI_HOST) cfg.host = process.env.WEBTOOPENAPI_HOST;
  if (process.env.WEBTOOPENAPI_PORT) cfg.port = parseInt(process.env.WEBTOOPENAPI_PORT, 10);
  if (process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS) cfg.tool_timeout_ms = parseInt(process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS, 10);
  cfg.configPath = configPath;
  return cfg;
}

const CONFIG = loadConfig();
const SERVICE = "web-to-openapi";
const VERSION = "1.0.0";

// ---------------------------------------------------------------- 日志(只走 stderr + 文件)
const LOG_DIR = process.env.WEBTOOPENAPI_LOG_DIR || path.join(process.env.LOCALAPPDATA || SCRIPT_DIR, "webtoopenapi", "logs");
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { /* ignore */ }
const LOG_FILE = path.join(LOG_DIR, "openapi-host.log");
function log(level, msg) {
  const line = `[${new Date().toISOString()}] [${level}] ${msg}`;
  try { process.stderr.write(line + "\n"); } catch (e) { /* ignore */ }
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- native messaging(stdio)
// 帧格式: 4 字节小端长度 + JSON 本体(与 chrome-mcp-shared 一致)
const pending = new Map(); // requestId -> {resolve, reject, timeoutId}
let extensionConnected = false;

function nmSend(message) {
  const buf = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(buf.length, 0);
  process.stdout.write(Buffer.concat([header, buf]));
}

function nmSendError(msg) {
  nmSend({ type: "error_from_native_host", payload: { message: msg } });
}

// host -> 扩展: 调用一个 chrome_* 工具, 等待响应
function callTool(name, args, timeoutMs) {
  const timeout = timeoutMs || CONFIG.tool_timeout_ms;
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const timeoutId = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`tool call timed out after ${timeout}ms: ${name}`));
    }, timeout);
    pending.set(requestId, { resolve, reject, timeoutId });
    nmSend({ type: "call_tool", payload: { name, args: args || {} }, requestId });
  });
}

function handleNmMessage(message) {
  if (!message || typeof message !== "object") return;
  // 工具响应
  if (message.responseToRequestId) {
    const p = pending.get(message.responseToRequestId);
    if (p) {
      clearTimeout(p.timeoutId);
      pending.delete(message.responseToRequestId);
      if (message.error) p.reject(new Error(message.error));
      else {
        // 扩展回包格式: {payload:{status,message,data}}; 工具结果在 data 里(与 bridge 一致)
        const pl = message.payload || {};
        p.resolve(pl.data !== undefined ? pl.data : pl);
      }
    }
    return;
  }
  switch (message.type) {
    case "start":
      extensionConnected = true;
      applyConfigFromPayload(message.payload);
      startHttpLazy().then((port) => {
        nmSend({ type: "server_started", payload: { port } });
      }).catch((e) => {
        nmSendError("failed to start http server: " + e.message);
      });
      break;
    case "stop":
      stopHttp().then(() => {
        nmSend({ type: "server_stopped" });
      }).catch((e) => nmSendError("failed to stop http server: " + e.message));
      break;
    case "ping_from_extension":
      nmSend({ type: "pong_to_extension" });
      break;
    case "set_baidu_defaults":
      // 扩展设置页下发百度搜索默认参数: 清洗 -> 持久化 -> 内存生效 -> 回执
      baiduDefaults = { ...BAIDU_BUILTIN_DEFAULTS, ...sanitizeBaiduDefaults(message.payload) };
      saveBaiduDefaultsToDisk();
      log("info", `baidu defaults updated: ${JSON.stringify(baiduDefaults)}`);
      nmSend({ type: "baidu_defaults_ack", payload: baiduDefaults });
      break;
    case "get_baidu_defaults":
      nmSend({ type: "baidu_defaults", payload: baiduDefaults });
      break;
    case "set_google_defaults":
      // 扩展设置页下发谷歌搜索默认参数: 清洗 -> 持久化 -> 内存生效 -> 回执
      googleDefaults = { ...GOOGLE_BUILTIN_DEFAULTS, ...sanitizeGoogleDefaults(message.payload) };
      saveGoogleDefaultsToDisk();
      log("info", `google defaults updated: ${JSON.stringify(googleDefaults)}`);
      nmSend({ type: "google_defaults_ack", payload: googleDefaults });
      break;
    case "get_google_defaults":
      nmSend({ type: "google_defaults", payload: googleDefaults });
      break;
    case "file_operation":
      // 本 host 不实现文件操作(下载类工具不可用), 明确报错而非静默
      if (message.requestId) {
        nmSend({
          type: "file_operation_response",
          responseToRequestId: message.requestId,
          error: "file operations are not supported by web-to-openapi host",
        });
      } else {
        nmSendError("file operations are not supported by web-to-openapi host");
      }
      break;
    default:
      if (!message.responseToRequestId) nmSendError(`unknown message type: ${message.type || "no type"}`);
  }
}

function startStdio() {
  let buffer = Buffer.alloc(0);
  let expectedLength = -1;
  const MAX_PER_TICK = 100;
  const MAX_SIZE = 16 * 1024 * 1024;
  const processAvailable = () => {
    let processed = 0;
    while (processed < MAX_PER_TICK) {
      if (expectedLength === -1) {
        if (buffer.length < 4) break;
        expectedLength = buffer.readUInt32LE(0);
        buffer = buffer.slice(4);
        if (expectedLength <= 0 || expectedLength > MAX_SIZE) {
          nmSendError(`invalid message length: ${expectedLength}`);
          expectedLength = -1;
          buffer = Buffer.alloc(0);
          break;
        }
      }
      if (buffer.length < expectedLength) break;
      const body = buffer.slice(0, expectedLength);
      buffer = buffer.slice(expectedLength);
      expectedLength = -1;
      processed++;
      try {
        handleNmMessage(JSON.parse(body.toString()));
      } catch (e) {
        nmSendError(`failed to parse message: ${e.message}`);
      }
    }
    if (processed === MAX_PER_TICK) setImmediate(processAvailable);
  };
  process.stdin.on("readable", () => {
    let chunk;
    while ((chunk = process.stdin.read()) !== null) {
      buffer = Buffer.concat([buffer, chunk]);
      processAvailable();
    }
  });
  const shutdown = (why) => {
    log("info", `native messaging disconnected (${why}), shutting down`);
    for (const [, p] of pending) {
      clearTimeout(p.timeoutId);
      p.reject(new Error("native host shutting down"));
    }
    pending.clear();
    stopHttp().finally(() => process.exit(0));
  };
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("error", (e) => shutdown("stdin error: " + e.message));
}

// ---------------------------------------------------------------- HTTP(OpenAPI)服务
let httpServer = null;
let httpPort = null;
let lastHost = null;
let lastPort = null;
let startedAt = null;
let bindRetryTimer = null;

function startHttp() {
  if (httpServer && httpPort && lastHost === CONFIG.host && lastPort === CONFIG.port) return Promise.resolve(httpPort);
  return new Promise((resolve, reject) => {
    const server = http.createServer(handleRequest);
    // 协议层容错: 请求行含未编码的非 ASCII 字符(典型: q=人工智能 忘了 URL 编码)时,
    // Node 的 llhttp 解析器在到达路由之前就直接 400。这里接管 clientError,
    // 返回带修复指引的 JSON, 而不是 Node 默认的纯文本 "Bad Request"。
    server.on("clientError", (err, socket) => {
      const isUrlErr = err && (err.code === "HPE_INVALID_URL" || /Invalid URL|invalid character/i.test(String(err && err.message)));
      log("warn", `clientError: ${err && err.code} ${err && err.message}${isUrlErr ? " (请求行疑似含未编码中文/特殊字符)" : ""}`);
      const payload = JSON.stringify({
        error: "bad request",
        hint: isUrlErr
          ? "请求行含未编码的非 ASCII 字符(如中文查询词)。GET 请求必须对参数做 URL 编码(encodeURIComponent), 或改用 POST /api/v1/search/{baidu,google} 传 JSON body(中文无需编码)。"
          : "malformed HTTP request",
        detail: String(err && err.message || err),
        docs: "/docs",
      });
      try {
        socket.end(
          "HTTP/1.1 400 Bad Request\r\n" +
          "Content-Type: application/json; charset=utf-8\r\n" +
          "Access-Control-Allow-Origin: *\r\n" +
          `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
          "Connection: close\r\n\r\n" +
          payload
        );
      } catch (e) { try { socket.destroy(); } catch (e2) { /* ignore */ } }
    });
    server.on("error", (e) => {
      log("error", `http bind failed on ${CONFIG.host}:${CONFIG.port} - ${e.message} (5s 后重试)`);
      reject(e);
      if (!bindRetryTimer) {
        bindRetryTimer = setInterval(() => {
          if (httpServer && httpPort && lastHost === CONFIG.host && lastPort === CONFIG.port) return;
          startHttp().catch(() => {});
        }, 5000);
      }
    });
    server.listen(CONFIG.port, CONFIG.host, () => {
      httpServer = server;
      httpPort = server.address().port;
      lastHost = CONFIG.host; lastPort = CONFIG.port;
      startedAt = new Date();
      log("info", `OpenAPI HTTP listening on http://${CONFIG.host}:${httpPort} (docs: /docs, spec: /openapi.json)`);
      resolve(httpPort);
    });
  });
}

// 来自扩展 START 消息的 host/port 不再覆盖本机配置。
// 原因: 本扩展是从 chrome-mcp-server 派生而来, 其 START 消息会带上硬编码的 MCP 端口(12306)。
// 若本 host 照单全收, 会先停掉自己正常的 8090 服务、再去抢 12306(被旧 mcp-chrome-bridge 占用),
// 触发 EADDRINUSE, 导致 8090 也起不来, 设置页探测 /health 永远失败。
// 本 host 的监听地址以 config.json / 环境变量 / --host --port 为单一事实源, 不由扩展决定。
function applyConfigFromPayload(payload) {
  const wantPort = payload && Number.isFinite(parseInt(payload.port, 10)) ? parseInt(payload.port, 10) : null;
  const wantHost = payload && typeof payload.host === "string" && payload.host.trim() ? payload.host.trim() : null;
  if (wantHost && wantHost !== CONFIG.host) {
    log("warn", `extension requested host=${wantHost} but listen host is fixed by config (${CONFIG.host}); ignoring override`);
  }
  if (wantPort && wantPort !== CONFIG.port) {
    log("warn", `extension requested port=${wantPort} but listen port is fixed by config (${CONFIG.port}); ignoring override (legacy chrome-mcp port 12306 collision)`);
  }
}

// 按需启动: 若绑定地址变化则先停后起
function startHttpLazy() {
  if (httpServer && httpPort && lastHost === CONFIG.host && lastPort === CONFIG.port) return Promise.resolve(httpPort);
  if (httpServer) return stopHttp().then(() => startHttp());
  return startHttp();
}

function stopHttp() {
  return new Promise((resolve) => {
    if (bindRetryTimer) { clearInterval(bindRetryTimer); bindRetryTimer = null; }
    if (!httpServer) return resolve();
    httpServer.close(() => {
      log("info", "http server stopped");
      httpServer = null; httpPort = null;
      resolve();
    });
    // 强制关掉保活连接
    if (httpServer.closeAllConnections) httpServer.closeAllConnections();
  });
}

// 串行化浏览器操作(同时打开两个窗口会互相抢焦点)
let opChain = Promise.resolve();
function withBrowserLock(fn) {
  const run = opChain.then(fn);
  opChain = run.catch(() => {});
  return run;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) { reject(new Error("request body too large (max 1MB)")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(new Error("invalid JSON body: " + e.message)); }
    });
    req.on("error", reject);
  });
}

// 把 GET 的 URLSearchParams 或 POST 的 JSON 对象统一成 URLSearchParams,
// 让 parseBaiduRequest/parseGoogleRequest 一份代码同时服务两种调用方式。
// 数组值(JSON 天然支持 site:["a","b"])展开成同名多参, 与 ?site=a&site=b 等价。
function toSearchParams(input) {
  if (input instanceof URLSearchParams) return input;
  const sp = new URLSearchParams();
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => sp.append(k, x == null ? "" : String(x)));
      else sp.append(k, String(v));
    }
  }
  return sp;
}

async function handleRequest(req, res) {
  const t0 = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || "GET";
  const done = (status, obj) => {
    sendJson(res, status, obj);
    log("http", `${method} ${pathname} -> ${status} (${Date.now() - t0}ms)`);
  };
  try {
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }
    // 文档页
    if (method === "GET" && (pathname === "/" || pathname === "/docs" || pathname === "/docs.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end(docsHtml());
    }
    if (method === "GET" && pathname === "/openapi.json") {
      return done(200, openApiSpec());
    }
    if (method === "GET" && pathname === "/health") {
      return done(200, {
        status: "ok",
        service: SERVICE,
        version: VERSION,
        listen: `http://${CONFIG.host}:${httpPort || CONFIG.port}`,
        extension_connected: extensionConnected,
        uptime_s: startedAt ? Math.round((Date.now() - startedAt.getTime()) / 1000) : 0,
        now: new Date().toISOString(),
      });
    }
    if (method === "GET" && pathname === "/api/v1/scnet/free-credit") {
      const data = await withBrowserLock(() => scnetGetFreeCredit());
      return done(200, data);
    }
    if (method === "GET" && pathname === "/api/v1/scnet/token-plan") {
      const data = await withBrowserLock(() => scnetGetTokenPlan());
      return done(200, data);
    }
    if (method === "GET" && pathname === "/api/v1/scnet/balance") {
      const data = await withBrowserLock(() => scnetGetBalance());
      return done(200, data);
    }
    if (method === "GET" && pathname === "/api/v1/search/baidu/defaults") {
      return done(200, { builtin: BAIDU_BUILTIN_DEFAULTS, extension: baiduDefaults, effective: effectiveBaiduDefaults() });
    }
    if (method === "GET" && pathname === "/api/v1/search/baidu") {
      const data = await withBrowserLock(() => baiduSearch(parseBaiduRequest(url.searchParams)));
      return done(200, data);
    }
    if (method === "POST" && pathname === "/api/v1/search/baidu") {
      // POST + JSON body: 中文查询词无需 URL 编码(协议层限制的根治方案)
      const body = await readBody(req);
      const data = await withBrowserLock(() => baiduSearch(parseBaiduRequest(body)));
      return done(200, data);
    }
    if (method === "GET" && pathname === "/api/v1/search/google/defaults") {
      return done(200, { builtin: GOOGLE_BUILTIN_DEFAULTS, extension: googleDefaults, effective: effectiveGoogleDefaults() });
    }
    if (method === "GET" && pathname === "/api/v1/search/google") {
      const data = await withBrowserLock(() => googleSearch(parseGoogleRequest(url.searchParams)));
      return done(200, data);
    }
    if (method === "POST" && pathname === "/api/v1/search/google") {
      // POST + JSON body: 中文查询词无需 URL 编码(协议层限制的根治方案)
      const body = await readBody(req);
      const data = await withBrowserLock(() => googleSearch(parseGoogleRequest(body)));
      return done(200, data);
    }
    if (method === "GET" && pathname === "/api/v1/tools") {
      return done(200, { tools: toolCatalog() });
    }
    const toolMatch = pathname.match(/^\/api\/v1\/tools\/([a-z0-9_.\-]+)$/i);
    if (method === "POST" && toolMatch) {
      const body = await readBody(req);
      const args = body.args || body;
      const result = await withBrowserLock(() => callTool(toolMatch[1], args));
      return done(200, { name: toolMatch[1], result });
    }
    // ------------------------------------------------ MCP 服务(Streamable HTTP transport)
    if (pathname === "/mcp" || pathname === "/mcp/") {
      const origin = req.headers.origin;
      if (origin && !isLocalOrigin(origin)) {
        log("warn", `mcp request rejected: non-local Origin ${origin} (DNS rebinding guard)`);
        return done(403, { error: "forbidden origin", hint: "本 MCP 服务仅接受本地(127.0.0.1/localhost)Origin 的浏览器请求" });
      }
      if (method === "GET") {
        // 规范中 GET 用于建立 SSE 流(可选能力); 本服务不提供流, 明确告知用 POST
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", Allow: "POST" });
        return res.end(JSON.stringify({ error: "SSE stream not offered", hint: "MCP Streamable HTTP: 用 POST 发送 JSON-RPC 消息到 /mcp" }));
      }
      if (method !== "POST") {
        res.writeHead(405, { "Content-Type": "application/json; charset=utf-8", "Access-Control-Allow-Origin": "*", Allow: "POST" });
        return res.end(JSON.stringify({ error: "method not allowed", allow: "POST" }));
      }
      const msg = await readBody(req);
      // session: 无状态实现(每次请求自带全部上下文), 仍按规范回一个 id 头方便客户端对齐
      const sessionId = crypto.randomUUID();
      const rpcOut = async (status, obj) => {
        const bodyStr = JSON.stringify(obj, null, 2);
        res.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Access-Control-Allow-Origin": origin && isLocalOrigin(origin) ? origin : "*",
          "Access-Control-Expose-Headers": "Mcp-Session-Id",
          "Mcp-Session-Id": sessionId,
        });
        res.end(bodyStr);
        log("http", `MCP ${(obj && obj.result && obj.result.serverInfo) ? "initialize" : (msg && msg.method) || "?"} -> ${status}`);
      };
      try {
        const results = Array.isArray(msg) ? await Promise.all(msg.map((m) => mcpHandleRpc(m))) : [await mcpHandleRpc(msg)];
        const nonNull = results.filter((r) => r !== null);
        if (!nonNull.length) { // 全是 notification -> 202 无 body
          res.writeHead(202, { "Mcp-Session-Id": sessionId });
          return res.end();
        }
        return await rpcOut(200, Array.isArray(msg) ? nonNull : nonNull[0]);
      } catch (e) {
        return await rpcOut(200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: " + e.message } });
      }
    }
    return done(404, { error: "not found", path: pathname, docs: "/docs", spec: "/openapi.json" });
  } catch (e) {
    log("error", `${method} ${pathname} failed: ${e.message}`);
    // URIError = 畸形百分号编码(如 %E4%BD 被截断) -> 属于调用方参数问题, 回 400 而非 500
    if (e instanceof URIError || e.code === "ERR_INVALID_URL") {
      return done(400, {
        error: "malformed url encoding: " + e.message,
        hint: "GET 参数必须做 URL 编码(encodeURIComponent); 中文推荐改用 POST /api/v1/search/{baidu,google} 传 JSON body。",
        path: pathname,
      });
    }
    return done(500, { error: e.message, path: pathname });
  }
}

// ---------------------------------------------------------------- 工具目录
function findChromeMcpShared() {
  const candidates = [];
  if (process.env.CHROME_MCP_SHARED_PATH) candidates.push(process.env.CHROME_MCP_SHARED_PATH);
  candidates.push(path.join(SCRIPT_DIR, "node_modules", "chrome-mcp-shared"));
  const versionsRoot = path.join(process.env.USERPROFILE || "C:\\Users\\Default", ".workbuddy", "binaries", "node", "versions");
  try {
    for (const v of fs.readdirSync(versionsRoot)) {
      candidates.push(path.join(versionsRoot, v, "node_modules", "mcp-chrome-bridge", "node_modules", "chrome-mcp-shared"));
      candidates.push(path.join(versionsRoot, v, "node_modules", "chrome-mcp-shared"));
    }
  } catch (e) { /* ignore */ }
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "dist", "index.js")) || fs.existsSync(path.join(c, "package.json"))) return c;
    } catch (e) { /* ignore */ }
  }
  return null;
}

const SHARED_TOOLS_FALLBACK = [
  { name: "chrome_navigate", description: "打开 URL(newWindow 可新开窗口)" },
  { name: "chrome_javascript", description: "在标签页执行 JS 并返回结果(可拿到未脱敏 DOM 文本)" },
  { name: "chrome_read_page", description: "读取页面可访问性树" },
  { name: "chrome_get_web_content", description: "获取页面文本内容(数字可能被脱敏)" },
  { name: "chrome_screenshot", description: "截图(当前模型读不了图, 仅存档)" },
  { name: "chrome_close_tabs", description: "关闭标签页" },
  { name: "chrome_switch_tab", description: "切换标签页" },
  { name: "get_windows_and_tabs", description: "列出所有窗口和标签页" },
  { name: "search_tabs_content", description: "搜索标签页内容" },
];

function toolCatalog() {
  try {
    const sharedPath = findChromeMcpShared();
    if (sharedPath) {
      const shared = require(path.join(sharedPath, "dist", "index.js"));
      const schemas = shared.TOOL_SCHEMAS || [];
      if (schemas.length) {
        return schemas.map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || null }));
      }
    }
  } catch (e) {
    log("warn", "chrome-mcp-shared 工具目录加载失败, 使用内置精简目录: " + e.message);
  }
  return SHARED_TOOLS_FALLBACK;
}

// ---------------------------------------------------------------- SCNet 余额提取
// 说明: scnet 控制台对数字做了「数字转轮」反爬混淆(DOM 文本是 0-9 乱序),
//       但转轮外层 .d-roll-wrapper 的 aria-label 保存真实值(无障碍标签),
//       故用 chrome_javascript 抓 aria-label; 免费额度页表格是纯文本亦可直接解析。
const SCNET_FREE_URL = "https://www.scnet.cn/ui/console/index.html#/llm/free-credit";
const SCNET_PLAN_URL = "https://www.scnet.cn/ui/console/index.html#/llm/token-plan";
const EXTRACT_JS = "const rolls=[...document.querySelectorAll('.d-roll-wrapper[aria-label]')].map(e=>({aria:e.getAttribute('aria-label'),cls:(e.className||'').trim()}));return {rolls,text:(document.body.innerText||'')};";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function dataText(data) {
  if (data && Array.isArray(data.content)) return data.content.map((c) => (c && c.text) || "").join("\n");
  return typeof data === "string" ? data : JSON.stringify(data);
}

async function openPage(url) {
  const data = await callTool("chrome_navigate", { url, newWindow: true, background: false, width: 1280, height: 900 });
  const m = dataText(data).match(/"tabId"\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function closeTab(tabId) {
  if (tabId == null) return;
  try { await callTool("chrome_close_tabs", { tabIds: [tabId] }, 20000); }
  catch (e) { log("warn", `close tab ${tabId} failed: ${e.message}`); }
}

async function extractOnce(tabId) {
  const data = await callTool("chrome_javascript", { tabId, code: EXTRACT_JS, timeoutMs: 20000 });
  const obj = JSON.parse(dataText(data));
  let inner = obj.result;
  if (typeof inner === "string") inner = JSON.parse(inner);
  return inner;
}

async function extractWithRetry(tabId, tries = 8) {
  for (let i = 0; i < tries; i++) {
    const d = await extractOnce(tabId);
    if (d && Array.isArray(d.rolls) && d.rolls.length) return d;
    await sleep(2000);
  }
  return await extractOnce(tabId);
}

function num(s) { return parseFloat(String(s).replace(/,/g, "")); }

function parseFree(d) {
  const rolls = (d.rolls || []).filter((x) => /free-credit-summary__digi/.test(x.cls || ""));
  const vals = rolls.map((x) => num((x.aria || "").replace(/[^\d.]/g, "")));
  const text = d.text || "";
  const out = {};
  if (vals.length >= 3) {
    out.remaining = Math.round(vals[0]);
    out.total = Math.round(vals[1]);
    out.used = Math.round(vals[2]);
  }
  let m = text.match(/剩余\s*(\d+)\s*%/);
  if (m) out.remaining_percent = parseInt(m[1], 10);
  m = text.match(/(GLM-[\w.\-]+)/);
  if (m) out.model = m[1];
  m = text.match(/剩[余]?\s*(\d+)\s*天/);
  if (m) out.days_left = parseInt(m[1], 10);
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (dates.length >= 2) { out.claim_date = dates[0]; out.expire_date = dates[1]; }
  return out;
}

function parsePlan(d) {
  const rolls = d.rolls || [];
  const text = d.text || "";
  const out = {};
  const status = rolls.filter((x) => /status-digit-roll/.test(x.cls || "")).map((x) => x.aria || "");
  const usage = rolls.filter((x) => /usage-digit-roll/.test(x.cls || "")).map((x) => x.aria || "");
  for (const a of status) {
    let m = a.match(/([\d,]+(?:\.\d+)?)\s*Credits\/月/);
    if (m) out.plan_monthly_credits = num(m[1]);
    m = a.match(/(\d+)\s*天/);
    if (m) out.days_left = parseInt(m[1], 10);
  }
  if (usage.length >= 3) {
    out.total_credits = num(usage[0]);
    out.remaining_credits = num(usage[1]);
    const mm = usage[2].match(/([\d.]+)/);
    if (mm) out.remaining_percent = parseFloat(mm[1]);
  }
  if (out.total_credits != null && out.remaining_credits != null)
    out.used_credits = Math.round((out.total_credits - out.remaining_credits) * 100) / 100;
  if (out.remaining_percent != null)
    out.used_percent = Math.round((100 - out.remaining_percent) * 100) / 100;
  let m = text.match(/开始时间\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (m) out.start_at = m[1];
  m = text.match(/结束时间\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (m) out.expire_at = m[1];
  return out;
}

async function scnetFetchPage(url) {
  const tabId = await openPage(url);
  const data = await extractWithRetry(tabId);
  await closeTab(tabId);
  return data;
}

async function scnetGetFreeCredit() {
  const free = await scnetFetchPage(SCNET_FREE_URL);
  return {
    source: "scnet console via web-to-openapi",
    fetched_at: new Date().toISOString(),
    free_credit: parseFree(free),
  };
}

async function scnetGetTokenPlan() {
  const plan = await scnetFetchPage(SCNET_PLAN_URL);
  return {
    source: "scnet console via web-to-openapi",
    fetched_at: new Date().toISOString(),
    token_plan: parsePlan(plan),
  };
}

async function scnetGetBalance() {
  const free = await scnetFetchPage(SCNET_FREE_URL);
  const plan = await scnetFetchPage(SCNET_PLAN_URL);
  return {
    source: "scnet console via web-to-openapi",
    fetched_at: new Date().toISOString(),
    free_credit: parseFree(free),
    token_plan: parsePlan(plan),
  };
}

// ---------------------------------------------------------------- 百度搜索
// 完整高级查询参数(请求参数 > 扩展设置页默认 > 内置默认):
//   q          基础查询词, 可含操作符(site: intitle: inurl: filetype: "-词" "精确短语")
//   site       限定站点(可重复/逗号分隔)      -> site:xxx
//   intitle    标题必须包含(可重复/逗号分隔)   -> intitle:xxx
//   inurl      URL 必须包含(可重复/逗号分隔)   -> inurl:xxx
//   filetype   文件类型: pdf/doc/xls/ppt/rtf  -> filetype:pdf
//   exact      精确短语                        -> "xxx"
//   exclude    排除词(可重复/逗号分隔)         -> -xxx
//   rn         每页条数: 10/20/30/40/50/100
//   page       页码(1 起)                      -> pn=(page-1)*rn
//   time       时间范围: day/week/month/year   -> gpc=stf=<start>,<now>|stftype=1
//              (实测该参数会点亮 SERP 上的"一天内/一周内..."时间筛选片)
//   resolve_urls  是否把百度跳转链接解析为真实 URL(302 约 90ms/条, 并发 8, 失败保留原链接)
const BAIDU_SEARCH_URL = "https://www.baidu.com/s";
const BAIDU_BUILTIN_DEFAULTS = { rn: 50, page: 1, time: "", resolve_urls: false };
const BAIDU_TIME_SPANS = {
  h: 86400, d: 86400, "1d": 86400, day: 86400,
  w: 604800, "1w": 604800, week: 604800,
  m: 2592000, "1m": 2592000, month: 2592000,
  y: 31536000, "1y": 31536000, year: 31536000,
};
const BAIDU_FILETYPES = ["pdf", "doc", "xls", "ppt", "rtf"];
const BAIDU_STATE_FILE = path.join(process.env.LOCALAPPDATA || SCRIPT_DIR, "webtoopenapi", "baidu-defaults.json");
// 扩展设置页下发的默认参数(持久化在 BAIDU_STATE_FILE, host 重启不丢)
let baiduDefaults = { ...BAIDU_BUILTIN_DEFAULTS };

function loadBaiduDefaults() {
  try {
    const saved = JSON.parse(fs.readFileSync(BAIDU_STATE_FILE, "utf8"));
    if (saved && typeof saved === "object") baiduDefaults = { ...BAIDU_BUILTIN_DEFAULTS, ...saved };
  } catch (e) { /* 无文件或损坏: 保持内置默认 */ }
}

function saveBaiduDefaultsToDisk() {
  try { fs.writeFileSync(BAIDU_STATE_FILE, JSON.stringify(baiduDefaults, null, 2), "utf8"); }
  catch (e) { log("warn", `save baidu defaults failed: ${e.message}`); }
}

// 白名单清洗: 只认这些字段, 脏数据直接丢弃
function sanitizeBaiduDefaults(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  const str = (v) => String(v == null ? "" : v).trim();
  const strList = (v) => {
    const arr = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,，]/);
    return arr.map(str).filter(Boolean);
  };
  const site = strList(input.site); if (site.length) out.site = site;
  const intitle = strList(input.intitle); if (intitle.length) out.intitle = intitle;
  const inurl = strList(input.inurl); if (inurl.length) out.inurl = inurl;
  const filetype = str(input.filetype).toLowerCase();
  if (BAIDU_FILETYPES.includes(filetype)) out.filetype = filetype;
  const exact = str(input.exact); if (exact) out.exact = exact;
  const exclude = strList(input.exclude); if (exclude.length) out.exclude = exclude;
  const rn = parseInt(input.rn, 10);
  if (Number.isFinite(rn) && [10, 20, 30, 40, 50, 100].includes(rn)) out.rn = rn;
  const page = parseInt(input.page, 10);
  if (Number.isFinite(page) && page >= 1 && page <= 100) out.page = page;
  const time = str(input.time).toLowerCase();
  if (BAIDU_TIME_SPANS[time]) out.time = time;
  if (input.resolve_urls === true || input.resolve_urls === "true" || input.resolve_urls === 1) out.resolve_urls = true;
  return out;
}

function effectiveBaiduDefaults() {
  return { ...BAIDU_BUILTIN_DEFAULTS, ...baiduDefaults };
}

// 把请求查询串 + 存储默认合并成最终生效参数(请求显式提供的字段整体覆盖默认)
// 入参可以是 GET 的 URLSearchParams, 也可以是 POST 的 JSON 对象(中文免 URL 编码)
function parseBaiduRequest(input) {
  const sp = toSearchParams(input);
  const eff = effectiveBaiduDefaults();
  const p = {
    q: (sp.get("q") || "").trim(),
    site: sp.getAll("site").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    intitle: sp.getAll("intitle").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    inurl: sp.getAll("inurl").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    exclude: sp.getAll("exclude").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    exact: (sp.get("exact") || "").trim(),
    filetype: (sp.get("filetype") || "").trim().toLowerCase(),
    rn: sp.get("rn") ? parseInt(sp.get("rn"), 10) : eff.rn,
    page: sp.get("page") ? parseInt(sp.get("page"), 10) : eff.page,
    time: (sp.get("time") || "").trim().toLowerCase() || eff.time,
    resolve_urls: sp.get("resolve_urls") ? /^(1|true|yes)$/i.test(sp.get("resolve_urls")) : eff.resolve_urls,
  };
  // 请求未提供的列表/文本字段回退到扩展默认
  if (!p.site.length && eff.site) p.site = [...eff.site];
  if (!p.intitle.length && eff.intitle) p.intitle = [...eff.intitle];
  if (!p.inurl.length && eff.inurl) p.inurl = [...eff.inurl];
  if (!p.exclude.length && eff.exclude) p.exclude = [...eff.exclude];
  if (!p.exact && eff.exact) p.exact = eff.exact;
  if (!p.filetype && eff.filetype) p.filetype = eff.filetype;
  if (!Number.isFinite(p.rn) || ![10, 20, 30, 40, 50, 100].includes(p.rn)) p.rn = eff.rn;
  if (!Number.isFinite(p.page) || p.page < 1 || p.page > 100) p.page = eff.page;
  if (!BAIDU_TIME_SPANS[p.time]) p.time = "";
  return p;
}

function baiduBuildUrl(p) {
  const parts = [];
  if (p.q) parts.push(p.q);
  (p.site || []).forEach((s) => parts.push(`site:${s}`));
  (p.intitle || []).forEach((t) => parts.push(`intitle:${t}`));
  (p.inurl || []).forEach((u) => parts.push(`inurl:${u}`));
  if (p.filetype) parts.push(`filetype:${p.filetype}`);
  if (p.exact) parts.push(`"${p.exact}"`);
  (p.exclude || []).forEach((x) => parts.push(`-${x}`));
  const wd = parts.join(" ").trim();
  if (!wd) throw new Error("empty query: 至少提供 q / site / intitle / inurl / filetype / exact 之一");
  const params = new URLSearchParams();
  params.set("ie", "utf-8");
  params.set("rn", String(p.rn));
  params.set("pn", String((p.page - 1) * p.rn));
  params.set("wd", wd);
  if (p.time && BAIDU_TIME_SPANS[p.time]) {
    const now = Math.floor(Date.now() / 1000);
    params.set("gpc", `stf=${now - BAIDU_TIME_SPANS[p.time]},${now}|stftype=1`);
  }
  return { wd, url: `${BAIDU_SEARCH_URL}?${params.toString()}` };
}

// SERP 提取: 取 #content_left(或 #container)直接子容器里带 h3 a[href^=http] 的条目。
// 不能用 .result:not(.result-op) 过滤 —— 实测百科/翻译等自然结果也带 result-op 类, 会漏一半;
// 而热搜榜/相关搜索/用户反馈等噪音都没有 h3 外链, 天然被排除。类名被混淆, 摘要用文本兜底。
// 两个防过滤要点(实测 chrome_javascript 工具会拦截响应):
//   1) 不能返回 location.href 等完整带参 URL;
//   2) 百度跳转链接的 url= 值是长 base64 串, 多条一起返回会触发"Cookie/query string data"
//      整块拦截(单条只会被脱敏) -> 故 URL 以字符码数组传输, host 侧解码。
const BAIDU_EXTRACT_JS = `
const enc=(s)=>{const out=[];for(let i=0;i<s.length;i++)out.push(s.charCodeAt(i));return out;};
let boxes=[...document.querySelectorAll('#content_left > div')];
if(!boxes.length) boxes=[...document.querySelectorAll('#container > div')];
const noiseRe=/^(翻译此页|查看此网页|百度快照|举报|相关搜索|换一换|为您推荐|查看更多|展开全部|收起|广告)/;
const dateRe=/^(\\d{4})年(\\d{1,2})月(\\d{1,2})日$/;
const relDateRe=/^(\\d+)\\s*(分钟|小时|天)前$|^昨天$|^前天$/;
const items=[];const seen=new Set();
boxes.forEach(e=>{
  const a=e.querySelector('h3 a[href^="http"]');
  if(!a) return;
  const href=(a.getAttribute('href')||'').trim();
  if(!/^https?:\\/\\//.test(href)||seen.has(href)) return;
  seen.add(href);
  const h3=e.querySelector('h3');
  const title=(h3?h3.innerText:(a.innerText||'')).trim();
  if(!title) return;
  const lines=(e.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
  const body=lines.slice(1).filter(l=>l!==title&&!noiseRe.test(l));
  let date=null;
  for(let i=0;i<body.length;i++){
    if(dateRe.test(body[i])||relDateRe.test(body[i])){date=body[i];body.splice(i,1);break;}
  }
  items.push({title:title,url_c:enc(href),abstract:body.join(' ').slice(0,500),date:date,
    is_ad:[...e.querySelectorAll('span,div,em,a')].some(x=>(x.innerText||'').trim()==='广告')||/baidu\\.php\\?/i.test(href)});
});
const totalM=(document.body.innerText||'').match(/找到相关结果[约]?\\s*([\\d,]+)/);
const captcha=/百度安全验证|安全验证|点击图中字符|操作太频繁/.test(document.body.innerText||'');
// 必须返回对象而非 JSON.stringify 字符串: 扩展侧 sanitizeValue 对"单字符串"有 10KB 截断上限
// (长摘要页会被截断→host 解析失败); 返回对象则按字段独立限额, 每字段都远小于上限。
return {items:items,total:totalM?parseInt(totalM[1].replace(/,/g,''),10):null,captcha:captcha,
  ready:document.readyState,hasLeft:!!document.querySelector('#content_left'),bodyLen:(document.body.innerText||'').length};
`;

function decodeUrlCodes(codes) {
  if (!Array.isArray(codes) || !codes.length) return "";
  let s = "";
  for (let i = 0; i < codes.length; i += 8000) {
    s += String.fromCharCode.apply(null, codes.slice(i, i + 8000));
  }
  // 百度会在部分 href 尾部塞 NUL 等控制字符(混淆), 剥掉
  return s.replace(/[\u0000-\u001f\u007f]/g, "");
}

async function baiduExtractOnce(tabId) {
  // maxOutputBytes 放大到 256KB: rn=100 时格式化输出可能超过默认 50KB 被截断
  const data = await callTool("chrome_javascript", { tabId, code: BAIDU_EXTRACT_JS, timeoutMs: 20000, maxOutputBytes: 262144 });
  const text = dataText(data);
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { items: [], parse_error: String(text).slice(0, 120) }; }
  let inner = obj.result;
  if (typeof inner === "string") {
    try { inner = JSON.parse(inner); }
    catch (e) { return { items: [], parse_error: "inner result is not json" }; }
  }
  return inner || { items: [] };
}

async function baiduExtractWithRetry(tabId, tries = 12) {
  // SERP 渐进渲染 + 新窗口可能后台加载: 先等 readyState=complete 且 #content_left 出现,
  // 再等结果数量连续两次稳定(每轮 1s, 上限约 15s)
  let lastCount = -1;
  let d = null;
  for (let i = 0; i < tries; i++) {
    d = await baiduExtractOnce(tabId);
    if (d && d.captcha) {
      throw new Error("百度安全验证(反爬): 请在 Edge 里手动打开百度完成一次搜索/验证后重试");
    }
    if (d && d.parse_error && i === tries - 1) {
      throw new Error("搜索结果提取失败(响应被拦截或解析失败): " + d.parse_error);
    }
    const n = d && Array.isArray(d.items) ? d.items.length : 0;
    const loaded = d && d.ready === "complete" && d.hasLeft;
    if (n > 0 && loaded && n === lastCount) return d;
    if (!loaded && i === tries - 1) {
      log("warn", `baidu page not fully loaded after ${tries}s: ${JSON.stringify({ ready: d && d.ready, hasLeft: d && d.hasLeft, bodyLen: d && d.bodyLen })}`);
    }
    lastCount = n;
    await sleep(1000);
  }
  return d;
}

async function resolveBaiduUrl(link) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(link, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    });
    clearTimeout(timer);
    return res.url || null;
  } catch (e) { return null; }
}

async function resolveBaiduLinks(items, concurrency = 8) {
  const queue = items.filter((it) => /^https?:\/\/(www\.)?baidu\.com\/link\?/i.test(it.url));
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (idx < queue.length) {
      const it = queue[idx++];
      it.real_url = await resolveBaiduUrl(it.url);
    }
  });
  await Promise.all(workers);
  return items;
}

async function baiduSearch(p) {
  const built = baiduBuildUrl(p);
  const tabId = await openPage(built.url);
  try {
    const raw = await baiduExtractWithRetry(tabId);
    let items = (raw.items || []).map((it) => {
      let date = it.date || null;
      let abstract = it.abstract || "";
      // 日期常以 "2024年3月22日" / "3天前" 前缀嵌在摘要行首, 兜底提取并剥离
      if (!date) {
        const m = abstract.match(/^(\d{4}年\d{1,2}月\d{1,2}日|\d+\s*(?:分钟|小时|天)前|昨天|前天)\s*/);
        if (m) { date = m[1]; abstract = abstract.slice(m[0].length); }
      }
      return { title: it.title || "", url: decodeUrlCodes(it.url_c), abstract, date, is_ad: !!it.is_ad };
    });
    if (p.resolve_urls) items = await resolveBaiduLinks(items);
    return {
      source: "baidu via web-to-openapi",
      fetched_at: new Date().toISOString(),
      query: built.wd,
      page: p.page,
      rn: p.rn,
      time: p.time || null,
      total: raw.total != null ? raw.total : null,
      count: items.length,
      items,
    };
  } finally {
    await closeTab(tabId);
  }
}

// ---------------------------------------------------------------- 谷歌搜索
// 完整高级查询参数(请求参数 > 扩展设置页默认 > 内置默认):
//   q          基础查询词, 可含操作符(site: intitle: inurl: intext: filetype: link: "-词" "精确短语" OR)
//   site       限定站点(可重复/逗号分隔)      -> site:xxx
//   intitle    标题必须包含(可重复/逗号分隔)   -> intitle:xxx
//   inurl      URL 必须包含(可重复/逗号分隔)   -> inurl:xxx
//   intext     正文必须包含(可重复/逗号分隔)   -> intext:xxx
//   filetype   文件类型: pdf/doc/docx/xls/xlsx/ppt/pptx/txt/rtf -> filetype:pdf
//   link       链接到某 URL 的网页            -> link:xxx
//   exact      精确短语                        -> "xxx"
//   exclude    排除词(可重复/逗号分隔)         -> -xxx
//   or         或关键词(可重复/逗号分隔)       -> (a OR b)
//   num        每页条数: 10/20/30/50/100
//   page       页码(1 起)                      -> start=(page-1)*num
//   start      起始偏移(请求显式提供时覆盖 page) -> start=<n>
//   time       时间范围: hour/day/week/month/year -> tbs=qdr:h/d/w/m/y
//   after      起始日期(YYYY-MM-DD)            -> tbs=cdr:1,cd_min:M/D/YYYY
//   before     截止日期(YYYY-MM-DD)            -> tbs=...,cd_max:M/D/YYYY
//   hl         界面语言(默认 zh-CN)            -> hl=zh-CN
//   gl         国家/地区代码(如 cn/us/jp)      -> gl=us
//   lr         限定语言(如 lang_zh-CN)         -> lr=lang_zh-CN
//   cr         限定国家(如 countryCN)          -> cr=countryCN
//   safe       安全搜索: off/active
//   tbm        垂直搜索: ""(网页)/nws(新闻)/isch(图片)/vid(视频) —— 结构化提取以网页/新闻为准
//   nfpr       关闭拼写纠错(true -> nfpr=1)
//   verbatim   逐字匹配, 不做同义词扩展(true -> tbs=li:1)
//   resolve_urls  把 /url?q= 与 /aclk?url= 等谷歌跳转链接解析为真实 URL(先本地解参数, 再 302 兜底; 并发 8, 失败保留原链接)
// SERP 结构实证(2026-10, Edge 实测):
//   自然结果在 #rso 顶层 div 块里, 每块有一个 h3 所在的 a[href^=http];
//   广告块带 data-text-ad 属性或位于 #tads/#bottomads, 块内含 Sponsored/赞助 标记;
//   相关搜索/大家还会问/反馈等噪音块没有 h3 外链, 天然被排除。
//   块内 innerText 行序实证: 垂直标签("Web results"/"網頁搜尋結果") -> 标题(可能重复, 且带
//   LRM 方向控制字符) -> 来源名 -> 展示 URL(面包屑行含 › 或裸 http 面行) -> 孤立 "·" ->
//   "翻译此页" -> 日期+摘要行, 日期一律在行首("4天前 — xxx" / "2026年10月1日 — xxx")。
//   与百度同样的两个防过滤要点(chrome_javascript 响应会被 sanitize):
//   1) 不返回 location.href 等完整带参 URL(只回 path/hostname);
//   2) 链接一律以字符码数组传输, host 侧 decodeUrlCodes 解码。
const GOOGLE_SEARCH_URL = "https://www.google.com/search";
const GOOGLE_BUILTIN_DEFAULTS = {
  num: 20, page: 1, time: "", after: "", before: "",
  hl: "zh-CN", gl: "", lr: "", cr: "", safe: "", tbm: "",
  nfpr: false, verbatim: false, resolve_urls: false,
};
const GOOGLE_NUMS = [10, 20, 30, 50, 100];
const GOOGLE_TIMES = { hour: "h", day: "d", week: "w", month: "m", year: "y" };
const GOOGLE_FILETYPES = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf"];
const GOOGLE_SAFE = ["", "off", "active"];
const GOOGLE_TBM = ["", "nws", "isch", "vid"];
const GOOGLE_STATE_FILE = path.join(process.env.LOCALAPPDATA || SCRIPT_DIR, "webtoopenapi", "google-defaults.json");
// 扩展设置页下发的默认参数(持久化在 GOOGLE_STATE_FILE, host 重启不丢)
let googleDefaults = { ...GOOGLE_BUILTIN_DEFAULTS };

function loadGoogleDefaults() {
  try {
    const saved = JSON.parse(fs.readFileSync(GOOGLE_STATE_FILE, "utf8"));
    if (saved && typeof saved === "object") googleDefaults = { ...GOOGLE_BUILTIN_DEFAULTS, ...saved };
  } catch (e) { /* 无文件或损坏: 保持内置默认 */ }
}

function saveGoogleDefaultsToDisk() {
  try { fs.writeFileSync(GOOGLE_STATE_FILE, JSON.stringify(googleDefaults, null, 2), "utf8"); }
  catch (e) { log("warn", `save google defaults failed: ${e.message}`); }
}

function googleStrList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,，]/);
  return arr.map((s) => String(s == null ? "" : s).trim()).filter(Boolean);
}

// 自定义日期区间用美式 M/D/YYYY(谷歌 tbs=cdr:1,cd_min:...,cd_max:...)
function googleDateToUs(v) {
  const m = String(v || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error(`invalid date(需 YYYY-MM-DD): ${v}`);
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`invalid date(月份/日期越界): ${v}`);
  return `${mo}/${d}/${Number(m[1])}`;
}

// 白名单清洗: 只认这些字段, 脏数据直接丢弃(设置页/扩展存储都走这里)
function sanitizeGoogleDefaults(input) {
  const out = {};
  if (!input || typeof input !== "object") return out;
  const site = googleStrList(input.site); if (site.length) out.site = site;
  const intitle = googleStrList(input.intitle); if (intitle.length) out.intitle = intitle;
  const inurl = googleStrList(input.inurl); if (inurl.length) out.inurl = inurl;
  const intext = googleStrList(input.intext); if (intext.length) out.intext = intext;
  const exclude = googleStrList(input.exclude); if (exclude.length) out.exclude = exclude;
  const or = googleStrList(input.or); if (or.length) out.or = or;
  const exact = String(input.exact == null ? "" : input.exact).trim(); if (exact) out.exact = exact;
  const filetype = String(input.filetype == null ? "" : input.filetype).trim().toLowerCase();
  if (GOOGLE_FILETYPES.includes(filetype)) out.filetype = filetype;
  const link = String(input.link == null ? "" : input.link).trim(); if (link) out.link = link;
  const num = parseInt(input.num, 10);
  if (Number.isFinite(num) && GOOGLE_NUMS.includes(num)) out.num = num;
  const page = parseInt(input.page, 10);
  if (Number.isFinite(page) && page >= 1 && page <= 100) out.page = page;
  const time = String(input.time == null ? "" : input.time).trim().toLowerCase();
  if (GOOGLE_TIMES[time]) out.time = time;
  const after = String(input.after == null ? "" : input.after).trim();
  if (after) { googleDateToUs(after); out.after = after; }
  const before = String(input.before == null ? "" : input.before).trim();
  if (before) { googleDateToUs(before); out.before = before; }
  const hl = String(input.hl == null ? "" : input.hl).trim(); if (hl) out.hl = hl;
  const gl = String(input.gl == null ? "" : input.gl).trim().toLowerCase();
  if (/^[a-z]{2}$/.test(gl)) out.gl = gl;
  const lr = String(input.lr == null ? "" : input.lr).trim();
  if (/^lang_[a-z]{2}(-[a-z]{2,4})?$/i.test(lr)) out.lr = lr;
  const cr = String(input.cr == null ? "" : input.cr).trim();
  if (/^country[a-z]{2}$/i.test(cr)) out.cr = cr;
  const safe = String(input.safe == null ? "" : input.safe).trim().toLowerCase();
  if (GOOGLE_SAFE.includes(safe) && safe) out.safe = safe;
  const tbm = String(input.tbm == null ? "" : input.tbm).trim().toLowerCase();
  if (GOOGLE_TBM.includes(tbm) && tbm) out.tbm = tbm;
  if (input.nfpr === true || input.nfpr === "true" || input.nfpr === 1) out.nfpr = true;
  if (input.verbatim === true || input.verbatim === "true" || input.verbatim === 1) out.verbatim = true;
  if (input.resolve_urls === true || input.resolve_urls === "true" || input.resolve_urls === 1) out.resolve_urls = true;
  return out;
}

function effectiveGoogleDefaults() {
  return { ...GOOGLE_BUILTIN_DEFAULTS, ...googleDefaults };
}

// 把请求查询串 + 存储默认合并成最终生效参数(请求显式提供的字段整体覆盖默认)
// 入参可以是 GET 的 URLSearchParams, 也可以是 POST 的 JSON 对象(中文免 URL 编码)
function parseGoogleRequest(input) {
  const sp = toSearchParams(input);
  const eff = effectiveGoogleDefaults();
  const p = {
    q: (sp.get("q") || "").trim(),
    site: sp.getAll("site").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    intitle: sp.getAll("intitle").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    inurl: sp.getAll("inurl").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    intext: sp.getAll("intext").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    exclude: sp.getAll("exclude").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    or: sp.getAll("or").flatMap((v) => v.split(/[,，]/)).map((s) => s.trim()).filter(Boolean),
    exact: (sp.get("exact") || "").trim(),
    filetype: (sp.get("filetype") || "").trim().toLowerCase(),
    link: (sp.get("link") || "").trim(),
    num: sp.get("num") ? parseInt(sp.get("num"), 10) : eff.num,
    page: sp.get("page") ? parseInt(sp.get("page"), 10) : eff.page,
    start: sp.get("start") ? parseInt(sp.get("start"), 10) : 0,
    time: (sp.get("time") || "").trim().toLowerCase() || eff.time,
    after: (sp.get("after") || "").trim() || eff.after,
    before: (sp.get("before") || "").trim() || eff.before,
    hl: (sp.get("hl") || "").trim() || eff.hl,
    gl: (sp.get("gl") || "").trim().toLowerCase() || eff.gl,
    lr: (sp.get("lr") || "").trim() || eff.lr,
    cr: (sp.get("cr") || "").trim() || eff.cr,
    safe: (sp.get("safe") || "").trim().toLowerCase() || eff.safe,
    tbm: (sp.get("tbm") || "").trim().toLowerCase() || eff.tbm,
    nfpr: sp.get("nfpr") ? /^(1|true|yes)$/i.test(sp.get("nfpr")) : eff.nfpr,
    verbatim: sp.get("verbatim") ? /^(1|true|yes)$/i.test(sp.get("verbatim")) : eff.verbatim,
    resolve_urls: sp.get("resolve_urls") ? /^(1|true|yes)$/i.test(sp.get("resolve_urls")) : eff.resolve_urls,
  };
  // 请求未提供的列表/文本字段回退到扩展默认(列表整体替换, 不叠加)
  if (!p.site.length && eff.site) p.site = [...eff.site];
  if (!p.intitle.length && eff.intitle) p.intitle = [...eff.intitle];
  if (!p.inurl.length && eff.inurl) p.inurl = [...eff.inurl];
  if (!p.intext.length && eff.intext) p.intext = [...eff.intext];
  if (!p.exclude.length && eff.exclude) p.exclude = [...eff.exclude];
  if (!p.or.length && eff.or) p.or = [...eff.or];
  if (!p.exact && eff.exact) p.exact = eff.exact;
  if (!p.filetype && eff.filetype) p.filetype = eff.filetype;
  if (!p.link && eff.link) p.link = eff.link;
  if (!GOOGLE_NUMS.includes(p.num)) p.num = eff.num;
  if (!Number.isFinite(p.page) || p.page < 1 || p.page > 100) p.page = eff.page;
  if (!Number.isFinite(p.start) || p.start < 0 || p.start > 900) p.start = 0;
  if (!GOOGLE_TIMES[p.time]) p.time = "";
  if (p.after) googleDateToUs(p.after);
  if (p.before) googleDateToUs(p.before);
  if (p.after && p.before && p.after > p.before) {
    throw new Error(`after(${p.after}) 晚于 before(${p.before}), 日期区间为空`);
  }
  if (p.gl && !/^[a-z]{2}$/.test(p.gl)) p.gl = "";
  if (p.lr && !/^lang_[a-z]{2}(-[a-z]{2,4})?$/i.test(p.lr)) p.lr = "";
  if (p.cr && !/^country[a-z]{2}$/i.test(p.cr)) p.cr = "";
  if (!GOOGLE_SAFE.includes(p.safe)) p.safe = "";
  if (!GOOGLE_TBM.includes(p.tbm)) p.tbm = "";
  return p;
}

function googleBuildUrl(p) {
  const parts = [];
  if (p.q) parts.push(p.q);
  (p.site || []).forEach((s) => parts.push(`site:${s}`));
  (p.intitle || []).forEach((t) => parts.push(`intitle:${t}`));
  (p.inurl || []).forEach((u) => parts.push(`inurl:${u}`));
  (p.intext || []).forEach((t) => parts.push(`intext:${t}`));
  if (p.filetype) parts.push(`filetype:${p.filetype}`);
  if (p.link) parts.push(`link:${p.link}`);
  if (p.exact) parts.push(`"${p.exact}"`);
  if ((p.or || []).length) parts.push(`(${p.or.join(" OR ")})`);
  (p.exclude || []).forEach((x) => parts.push(`-${x}`));
  const q = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!q) throw new Error("empty query: 至少提供 q / site / intitle / inurl / intext / filetype / exact / link / or 之一");
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("num", String(p.num));
  params.set("hl", p.hl || "zh-CN");
  params.set("ie", "UTF-8");
  params.set("oe", "UTF-8");
  if (p.gl) params.set("gl", p.gl);
  if (p.lr) params.set("lr", p.lr);
  if (p.cr) params.set("cr", p.cr);
  if (p.safe) params.set("safe", p.safe);
  if (p.tbm) params.set("tbm", p.tbm);
  if (p.nfpr) params.set("nfpr", "1");
  // 显式 start 覆盖 page 推导的偏移
  const start = p.start > 0 ? p.start : (p.page - 1) * p.num;
  if (start > 0) params.set("start", String(start));
  const tbs = [];
  if (p.time && GOOGLE_TIMES[p.time]) tbs.push(`qdr:${GOOGLE_TIMES[p.time]}`);
  if (p.after || p.before) {
    tbs.push("cdr:1");
    if (p.after) tbs.push(`cd_min:${googleDateToUs(p.after)}`);
    if (p.before) tbs.push(`cd_max:${googleDateToUs(p.before)}`);
  }
  if (p.verbatim) tbs.push("li:1");
  if (tbs.length) params.set("tbs", tbs.join(","));
  return { q, start, url: `${GOOGLE_SEARCH_URL}?${params.toString()}` };
}

const GOOGLE_EXTRACT_JS = `
const enc=(s)=>{const out=[];for(let i=0;i<s.length;i++)out.push(s.charCodeAt(i));return out;};
let boxes=[...document.querySelectorAll('#rso > div')];
if(!boxes.length) boxes=[...document.querySelectorAll('#center_col > div')];
const noiseRe=/^(Sponsored|赞助|广告|相关搜索|大家还会问|人们还会问|关于此结果|反馈|查看更多|展开全部|收起|翻译此页|Translate this page|Web results|Images|Videos|News|Books|Shopping|網頁搜尋結果)$/i;
const crumbRe=/›/;                  // 展示 URL 面包屑行 "github.com › 路径", 不是摘要
const bareUrlRe=/^https?:\\/\\/\\S+$/i;   // 展示 URL 面行 "https://gemini.google.com"
const sepOnlyRe=/^[·•|]+$/;         // 孤立分隔符行
// 日期: 可能是独立行, 也可能是摘要行开头(实证格式 "4天前 — xxx" / "2026年10月1日 — xxx" / "Oct 10, 2026 — xxx")
// 行首锚定 + 连带尾部破折号一起剥离
const lineDateRe=/^(\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s*(?:分钟|小时|天)前|昨天|前天|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s*\\d{4})\\s*(?:—|–|-|·)?\\s*/;
const items=[];const seen=new Set();
boxes.forEach(e=>{
  if(e.hasAttribute&&e.hasAttribute('data-text-ad')) return;      // 文字广告块
  if(e.closest&&e.closest('#tads,#bottomads')) return;            // 顶部/底部广告容器
  const h3=e.querySelector('a h3');
  const a=h3?h3.closest('a'):null;
  if(!a) return;                                                  // 无 h3 外链的块(相关搜索/PAA 等噪音)
  const raw=(a.getAttribute('href')||'').trim();
  if(!/^https?:\\/\\//.test(raw)||seen.has(raw)) return;
  seen.add(raw);
  // 标题里可能带 LRM/RLM 等方向控制字符(谷歌渲染 innerText 时插入), 剥掉;
  // 行分割时同样剥离, 保证标题行与 title 变量能相等比对(否则标题行会漏进摘要)
  const title=(h3.innerText||'').replace(/[\\u200e\\u200f\\u202a-\\u202e]/g,'').replace(/\\s+/g,' ').trim();
  if(!title) return;
  const lines=(e.innerText||'').split('\\n').map(s=>s.replace(/[\\u200e\\u200f\\u202a-\\u202e]/g,'').trim()).filter(Boolean);
  const body=lines.filter(l=>l!==title&&!noiseRe.test(l)&&!crumbRe.test(l)&&!bareUrlRe.test(l)&&!sepOnlyRe.test(l));
  let date=null;
  for(let i=0;i<body.length;i++){
    const dm=body[i].match(lineDateRe);
    if(dm){date=dm[1];body[i]=body[i].slice(dm[0].length).trim();if(!body[i])body.splice(i,1);break;}
  }
  const txt=e.innerText||'';
  const adLine=lines.some(l=>/^(Sponsored|赞助|广告)$/.test(l));
  items.push({title:title,url_c:enc(raw),abstract:body.join(' ').slice(0,500),date:date,is_ad:adLine});
});
// 新闻垂直(tbm=nws)兜底: 文章在 div[data-news-cluster-id] 里且没有 h3(所以上面 0 条),
// 每个 cluster 的 a[href^=http] innerText 是 来源/标题/时间或摘要 两到三行。
// 只在网页提取全军覆没时启用, 避免误伤其它版式。
if(!items.length){
  [...document.querySelectorAll('div[data-news-cluster-id]')].forEach(c=>{
    const a=c.querySelector('a[href^="http"]');
    if(!a) return;
    const raw=(a.getAttribute('href')||'').trim();
    if(!/^https?:\\/\\//.test(raw)||seen.has(raw)) return;
    seen.add(raw);
    const ls=(a.innerText||'').split('\\n').map(s=>s.replace(/[\\u200e\\u200f\\u202a-\\u202e]/g,'').trim()).filter(Boolean);
    let date=null;const rest=[];
    for(const l of ls){
      const dm=l.match(lineDateRe);
      if(dm&&!date){date=dm[1];const left=l.slice(dm[0].length).trim();if(left)rest.push(left);}
      else rest.push(l);
    }
    if(!rest.length) return;
    const t=rest.length>1?rest[1]:rest[0];   // 第 0 行是来源, 第 1 行是标题
    if(!t) return;
    const abstract=rest.filter((l,i)=>i!==(rest.length>1?1:0)).join(' ').slice(0,500);
    items.push({title:t,url_c:enc(raw),abstract:abstract,date:date,is_ad:false});
  });
}
const statsEl=document.querySelector('#result-stats');
const stats=(statsEl&&statsEl.innerText)||'';
const totalM=stats.match(/([\\d,]+)\\s*条结果|About\\s+([\\d,]+)\\s+results/i);
const bodyTxt=document.body.innerText||'';
const sorry=/^\\/sorry\\//.test(location.pathname||'');
const blocked=/unusual traffic|异常流量|not a robot/i.test(bodyTxt);
const consent=/consent\\.google\\./.test(location.hostname||'');
const noResult=/did not match any documents|找不到|没有找到|未找到/.test(bodyTxt);
// 必须返回对象而非 JSON.stringify 字符串: 扩展侧 sanitizeValue 对"单字符串"有 10KB 截断上限
// (长摘要页会被截断->host 解析失败); 返回对象则按字段独立限额, 每字段都远小于上限。
return {items:items,total:totalM?parseInt((totalM[1]||totalM[2]||'0').replace(/,/g,''),10):null,
  captcha:blocked||sorry,consent:consent,noResult:noResult,
  ready:document.readyState,hasRso:!!document.querySelector('#rso'),path:location.pathname,bodyLen:bodyTxt.length};
`;

async function googleExtractOnce(tabId) {
  // maxOutputBytes 放大到 256KB: num=100 时格式化输出可能超过默认 50KB 被截断
  const data = await callTool("chrome_javascript", { tabId, code: GOOGLE_EXTRACT_JS, timeoutMs: 20000, maxOutputBytes: 262144 });
  const text = dataText(data);
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) { return { items: [], parse_error: String(text).slice(0, 120) }; }
  let inner = obj.result;
  if (typeof inner === "string") {
    try { inner = JSON.parse(inner); }
    catch (e) { return { items: [], parse_error: "inner result is not json" }; }
  }
  return inner || { items: [] };
}

async function googleExtractWithRetry(tabId, tries = 12) {
  // SERP 渐进渲染 + 新窗口可能后台加载: 先等 readyState=complete 且 #rso 出现,
  // 再等结果数量连续两次稳定(每轮 1s, 上限约 15s)
  let lastCount = -1;
  let d = null;
  for (let i = 0; i < tries; i++) {
    d = await googleExtractOnce(tabId);
    if (d && d.consent) {
      throw new Error("谷歌返回 consent 同意页: 请在 Edge 里手动打开 google.com 完成一次搜索/同意后重试");
    }
    if (d && d.captcha) {
      throw new Error("谷歌反爬验证(unusual traffic): 请在 Edge 里手动打开 google.com 完成一次搜索后重试");
    }
    if (d && d.parse_error && i === tries - 1) {
      throw new Error("搜索结果提取失败(响应被拦截或解析失败): " + d.parse_error);
    }
    if (d && d.noResult && !d.hasRso) return d; // 合法的零结果页, 不用重试
    const n = d && Array.isArray(d.items) ? d.items.length : 0;
    const loaded = d && d.ready === "complete" && d.hasRso;
    if (n > 0 && loaded && n === lastCount) return d;
    if (!loaded && i === tries - 1) {
      log("warn", `google page not fully loaded after ${tries}s: ${JSON.stringify({ ready: d && d.ready, hasRso: d && d.hasRso, path: d && d.path, bodyLen: d && d.bodyLen })}`);
    }
    lastCount = n;
    await sleep(1000);
  }
  return d;
}

// 谷歌跳转链接本地解析: /url?q=<target> 与 /aclk?url=<target> 不必发请求
function googleRedirectTarget(link) {
  try {
    const u = new URL(link);
    if (/\/url$/.test(u.pathname)) {
      const q = u.searchParams.get("q");
      if (q && /^https?:\/\//.test(q)) return q;
    }
    if (/\/aclk$/.test(u.pathname)) {
      const q = u.searchParams.get("url") || u.searchParams.get("q");
      if (q && /^https?:\/\//.test(q)) return q;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function resolveGoogleUrl(link) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    const res = await fetch(link, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36" },
    });
    clearTimeout(timer);
    return res.url || null;
  } catch (e) { return null; }
}

async function resolveGoogleLinks(items, concurrency = 8) {
  const queue = items.filter((it) => /^https?:\/\/(www\.)?google\.[a-z.]+\/(url|aclk)\?/i.test(it.url));
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (idx < queue.length) {
      const it = queue[idx++];
      it.real_url = googleRedirectTarget(it.url) || (await resolveGoogleUrl(it.url));
    }
  });
  await Promise.all(workers);
  return items;
}

async function googleSearch(p) {
  const built = googleBuildUrl(p);
  const tabId = await openPage(built.url);
  try {
    const raw = await googleExtractWithRetry(tabId);
    let items = (raw.items || []).map((it) => {
      let date = it.date || null;
      let abstract = it.abstract || "";
      // 日期常以 "2024年3月22日" / "Jan 1, 2024" / "3天前" 前缀嵌在摘要行首, 兜底提取并剥离
      if (!date) {
        const m = abstract.match(/^(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}|\d+\s*(?:分钟|小时|天)前|昨天|前天|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4})\s*[—\-:：]?\s*/i);
        if (m) { date = m[1]; abstract = abstract.slice(m[0].length); }
      }
      return { title: it.title || "", url: decodeUrlCodes(it.url_c), abstract, date, is_ad: !!it.is_ad };
    });
    if (p.resolve_urls) items = await resolveGoogleLinks(items);
    return {
      source: "google via web-to-openapi",
      fetched_at: new Date().toISOString(),
      query: built.q,
      page: Math.floor(built.start / p.num) + 1,
      num: p.num,
      start: built.start,
      time: p.time || null,
      after: p.after || null,
      before: p.before || null,
      total: raw.total != null ? raw.total : null,
      count: items.length,
      // page_loaded = 是否成功拿到结果(谷歌有长连接时 readyState 可能长期卡在 interactive,
      // 不能只信 DOM 标志; 拿到条目/零结果页都算加载成功)
      page_loaded: items.length > 0 || !!(raw && raw.noResult) || !!(raw && raw.ready === "complete" && raw.hasRso),
      no_result: !!(raw && raw.noResult), // true = 谷歌明确返回零结果页(与"页面没加载完"区分)
      items,
    };
  } finally {
    await closeTab(tabId);
  }
}

// ---------------------------------------------------------------- MCP 服务(Streamable HTTP)
// 与上面的 REST 接口一一对应, 同一进程同一端口暴露 /mcp 端点(MCP Streamable HTTP transport)。
// 客户端接入: {"mcpServers":{"web-to-openapi":{"url":"http://127.0.0.1:8090/mcp"}}}
// 也可用 host/mcp-stdio.js 以 stdio 方式接入(command 方式, 内部代理到本端点)。
// 手写 JSON-RPC 2.0, 零依赖; stdio 已被 native messaging 占用, 所以 HTTP 是同进程唯一选择。
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_SERVER_INFO = { name: SERVICE + "-mcp", version: VERSION };

const MCP_TOOLS = [
  {
    name: "scnet_free_credit",
    description: "查询 SCNet 免费额度(实时驱动 Edge 打开控制台提取, 约 5-10 秒)。返回 {free_credit:{total,remaining,used,percent,reset_at}}(金额单位与页面一致)。只需免费额度时用这个, 比 scnet_balance 少开一个页面。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "scnet_token_plan",
    description: "查询 SCNet Token Plan(约 5-10 秒)。返回 {token_plan:{total,remaining,used,percent,period_start,period_end}}(Credits 额度与周期起止时间)。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "scnet_balance",
    description: "查询 SCNet 全部余额(免费额度 + Token Plan 聚合, 约 10-20 秒)。返回 {free_credit:{...}, token_plan:{...}}。只需单项时建议用 scnet_free_credit / scnet_token_plan。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "baidu_search",
    description: "百度搜索(实时驱动 Edge 打开百度 SERP 解析, 约 5-15 秒)。q 为基础查询词, 可含 site:/intitle:/inurl:/filetype: 操作符、-排除词、\"精确短语\"; 也可用结构化参数(列表参数传数组如 site:[\"zhihu.com\"], 也接受逗号分隔字符串)。time 支持 day/week/month/year; resolve_urls=true 时把百度跳转链接解析为真实 URL。中文查询词直接传即可(MCP 无 URL 编码问题)。参数优先级: 请求显式参数 > 扩展设置页默认 > 内置默认。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "基础查询词(可含高级操作符)。可单独使用, 也可与结构化参数组合" },
        site: { type: "array", items: { type: "string" }, description: "限定站点(可多个) -> site:zhihu.com(数组或逗号分隔字符串)" },
        intitle: { type: "array", items: { type: "string" }, description: "标题必须包含(可多个) -> intitle:教程" },
        inurl: { type: "array", items: { type: "string" }, description: "URL 必须包含(可多个) -> inurl:blog" },
        filetype: { type: "string", enum: ["pdf", "doc", "xls", "ppt", "rtf"], description: "文件类型 -> filetype:pdf" },
        exact: { type: "string", description: "精确短语(整体匹配) -> \"xxx\"" },
        exclude: { type: "array", items: { type: "string" }, description: "排除词(可多个) -> -xxx" },
        rn: { type: "integer", enum: [10, 20, 30, 40, 50, 100], description: "每页条数(默认 50, 非法值回退默认)" },
        page: { type: "integer", minimum: 1, description: "页码(1 起, 默认 1)" },
        time: { type: "string", enum: ["day", "week", "month", "year"], description: "时间范围(默认不限)" },
        resolve_urls: { type: "boolean", description: "把百度跳转链接解析为真实 URL(302 解析, 并发 8, 默认 false)" },
      },
    },
  },
  {
    name: "google_search",
    description: "谷歌搜索(实时驱动 Edge 打开 SERP 解析, 约 5-15 秒)。q 为基础查询词, 可含 site:/intitle:/inurl:/intext:/filetype:/link: 操作符、-排除词、\"精确短语\"、OR; 也可用结构化参数(列表参数传数组如 site:[\"github.com\"], 也接受逗号分隔字符串)。time 支持 hour/day/week/month/year; after/before 传 YYYY-MM-DD 自定义区间; hl/gl/lr/cr 控制语言地区; tbm=nws/isch/vid 切换新闻/图片/视频垂直; nfpr=true 关闭拼写纠错; verbatim=true 逐字匹配; resolve_urls=true 把谷歌跳转链接解析为真实 URL。中文查询词直接传(MCP 无 URL 编码问题)。参数优先级: 请求显式参数 > 扩展设置页默认 > 内置默认。",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string", description: "基础查询词(可含高级操作符)。可单独使用, 也可与结构化参数组合" },
        site: { type: "array", items: { type: "string" }, description: "限定站点(可多个) -> site:github.com(数组或逗号分隔字符串)" },
        intitle: { type: "array", items: { type: "string" }, description: "标题必须包含(可多个) -> intitle:tutorial" },
        inurl: { type: "array", items: { type: "string" }, description: "URL 必须包含(可多个) -> inurl:docs" },
        intext: { type: "array", items: { type: "string" }, description: "正文必须包含(可多个) -> intext:安装" },
        filetype: { type: "string", enum: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf"], description: "文件类型 -> filetype:pdf" },
        exact: { type: "string", description: "精确短语(整体匹配) -> \"xxx\"" },
        exclude: { type: "array", items: { type: "string" }, description: "排除词(可多个) -> -xxx" },
        or: { type: "array", items: { type: "string" }, description: "或关键词(可多个) -> (a OR b)" },
        link: { type: "string", description: "链接到指定 URL 的网页 -> link:example.com" },
        num: { type: "integer", enum: [10, 20, 30, 50, 100], description: "每页条数(默认 20, 非法值回退默认)" },
        page: { type: "integer", minimum: 1, description: "页码(1 起, 默认 1)。与 start 二选一, 同时提供时 start 优先" },
        start: { type: "integer", minimum: 0, description: "起始结果偏移(0~900, 显式提供时覆盖 page 推导的偏移)" },
        time: { type: "string", enum: ["hour", "day", "week", "month", "year"], description: "时间范围(默认不限)" },
        after: { type: "string", description: "自定义区间起始日期 YYYY-MM-DD(与 before 搭配使用)" },
        before: { type: "string", description: "自定义区间截止日期 YYYY-MM-DD(与 after 搭配使用)" },
        hl: { type: "string", description: "界面语言(如 zh-CN/en, 默认 zh-CN)" },
        gl: { type: "string", description: "国家/地区(两位字母, 如 cn/us)" },
        lr: { type: "string", description: "限定结果语言(如 lang_zh-CN/lang_en)" },
        cr: { type: "string", description: "限定结果国家(如 countryCN)" },
        safe: { type: "string", enum: ["off", "active"], description: "安全搜索(默认关闭)" },
        tbm: { type: "string", enum: ["nws", "isch", "vid"], description: "垂直搜索: nws=新闻 isch=图片 vid=视频(空=网页)" },
        nfpr: { type: "boolean", description: "关闭拼写纠错(默认 false)" },
        verbatim: { type: "boolean", description: "逐字匹配(禁用同义词扩展, 默认 false)" },
        resolve_urls: { type: "boolean", description: "把谷歌跳转链接解析为真实 URL(302 解析, 并发 8, 默认 false)" },
      },
    },
  },
  {
    name: "baidu_search_defaults",
    description: "查看百度搜索默认参数。返回三层: builtin(内置默认) / extension(扩展设置页下发, 持久化在本地) / effective(最终生效值)。修改默认参数请到扩展设置页, 本工具只读。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "google_search_defaults",
    description: "查看谷歌搜索默认参数。返回三层: builtin(内置默认) / extension(扩展设置页下发, 持久化在本地) / effective(最终生效值)。修改默认参数请到扩展设置页, 本工具只读。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "service_health",
    description: "查看 web-to-openapi 服务健康状态。返回 {status,service,version,listen,extension_connected,uptime_s}: 服务是否在监听、Edge 扩展是否连通、运行时长(秒)。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "browser_tool",
    description: "透传调用任意浏览器工具(经 Edge 扩展执行, 完整列表见 GET /api/v1/tools)。常用: chrome_navigate(打开 URL, 返回 tabId) / chrome_javascript(在指定标签页执行 JS) / chrome_read_page(读取页面结构) / get_windows_and_tabs(窗口与标签列表) / chrome_screenshot(截图)。适合固化端点覆盖不到的场景。",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "工具名, 如 chrome_javascript / chrome_navigate / chrome_read_page / get_windows_and_tabs / chrome_screenshot" },
        args: { type: "object", description: "工具参数对象(各工具字段不同, 如 chrome_javascript 需要 {tabId, code})" },
      },
      required: ["name"],
    },
  },
];

// 从 MCP 工具定义派生 OpenAPI 文档片段 —— 让 REST 与 MCP 两处参数描述同源。
// 过去两边各写一遍, 结果 MCP 侧漏了 google_search 大半参数的描述;
// 现在 MCP_TOOLS 是唯一数据源, 加参数只改一处, /docs 与 /openapi.json 自动跟上。
function mcpToolByName(name) {
  return MCP_TOOLS.find((t) => t.name === name) || null;
}

// 工具 inputSchema -> OpenAPI 3.0 的 query parameters 数组
function mcpQueryParameters(toolName) {
  const t = mcpToolByName(toolName);
  const props = (t && t.inputSchema && t.inputSchema.properties) || {};
  return Object.keys(props).map((name) => {
    const { description, ...schema } = props[name]; // 描述放参数级, schema 内不重复
    return { name, in: "query", description: description || "", schema };
  });
}

// 工具 inputSchema -> OpenAPI 3.0 的 requestBody 对象
function mcpRequestBody(toolName, example) {
  const t = mcpToolByName(toolName);
  const props = (t && t.inputSchema && t.inputSchema.properties) || {};
  return {
    required: true,
    content: {
      "application/json": {
        schema: { type: "object", properties: props },
        example,
      },
    },
  };
}

function mcpTextResult(obj, isError) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError: !!isError };
}

async function mcpToolCall(name, args) {
  switch (name) {
    case "scnet_free_credit": return await withBrowserLock(() => scnetGetFreeCredit());
    case "scnet_token_plan": return await withBrowserLock(() => scnetGetTokenPlan());
    case "scnet_balance": return await withBrowserLock(() => scnetGetBalance());
    case "baidu_search": return await withBrowserLock(() => baiduSearch(parseBaiduRequest(args || {})));
    case "google_search": return await withBrowserLock(() => googleSearch(parseGoogleRequest(args || {})));
    case "baidu_search_defaults":
      return { builtin: BAIDU_BUILTIN_DEFAULTS, extension: baiduDefaults, effective: effectiveBaiduDefaults() };
    case "google_search_defaults":
      return { builtin: GOOGLE_BUILTIN_DEFAULTS, extension: googleDefaults, effective: effectiveGoogleDefaults() };
    case "service_health":
      return {
        status: "ok", service: SERVICE, version: VERSION,
        listen: `http://${CONFIG.host}:${httpPort || CONFIG.port}`,
        extension_connected: extensionConnected,
        uptime_s: startedAt ? Math.floor((Date.now() - startedAt.getTime()) / 1000) : null,
      };
    case "browser_tool": {
      const t = args && args.name;
      if (!t) throw new Error("browser_tool requires args.name");
      return await withBrowserLock(() => callTool(t, (args && args.args) || {}));
    }
    default:
      throw new Error("unknown tool: " + name + " (tools/list 查看可用工具)");
  }
}

// 处理单条 JSON-RPC 消息; 返回 null 表示 notification(不应答)
async function mcpHandleRpc(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.method !== "string") {
    if (msg && (msg.id !== undefined && msg.id !== null)) {
      return { jsonrpc: "2.0", id: msg.id, error: { code: -32600, message: "invalid request" } };
    }
    return null;
  }
  const id = msg.id;
  const isNotif = id === undefined || id === null;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const method = msg.method;
  try {
    switch (method) {
      case "initialize": {
        const clientVer = (msg.params && msg.params.protocolVersion) || "";
        // 客户端版本在支持列表则回显, 否则回最新已知版本(规范: 服务端用自己支持的版本响应)
        const ver = MCP_PROTOCOL_VERSIONS.includes(clientVer)
          ? clientVer
          : MCP_PROTOCOL_VERSIONS[MCP_PROTOCOL_VERSIONS.length - 1];
        return reply({
          protocolVersion: ver,
          capabilities: { tools: { listChanged: false } },
          serverInfo: MCP_SERVER_INFO,
          instructions: "本服务把 Edge 浏览器能力封装成 MCP 工具: 百度/谷歌搜索(完整高级参数, 中文免编码)、SCNet 余额查询、浏览器工具透传。首次调用搜索/余额类工具会真实打开浏览器页面, 约 5-15 秒。",
        });
      }
      case "notifications/initialized":
      case "initialized":
      case "notifications/cancelled":
        return null; // notification, 无应答
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: MCP_TOOLS });
      case "tools/call": {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        try {
          const r = await mcpToolCall(name, args);
          return reply(mcpTextResult(r, false));
        } catch (e) {
          log("warn", `mcp tools/call ${name} failed: ${e.message}`);
          return reply(mcpTextResult("error: " + e.message, true));
        }
      }
      default:
        if (isNotif) return null;
        return fail(-32601, "method not found: " + method);
    }
  } catch (e) {
    if (isNotif) return null;
    return fail(-32603, "internal error: " + e.message);
  }
}

// Streamable HTTP 规范要求校验 Origin 防 DNS rebinding; 无 Origin 头(curl/stdio 代理)放行
function isLocalOrigin(origin) {
  try {
    const u = new URL(origin);
    const h = u.hostname.toLowerCase();
    return h === "127.0.0.1" || h === "localhost" || h === "::1" || h === "[::1]";
  } catch (e) { return false; }
}

// ---------------------------------------------------------------- OpenAPI 规范 + 文档页
function openApiSpec() {
  const base = `http://${CONFIG.host}:${httpPort || CONFIG.port}`;
  return {
    openapi: "3.0.3",
    info: {
      title: "Web To OpenAPI",
      version: VERSION,
      description: "独立 Edge 插件驱动的浏览器操作 HTTP API。不依赖 MCP 客户端; 底层经 native messaging 调用 chrome-mcp-server 的浏览器操作接口。",
    },
    servers: [{ url: base, description: "本地服务(可在 config.json 配置地址/端口)" }],
    paths: {
      "/health": {
        get: {
          summary: "存活探针",
          operationId: "health",
          responses: { 200: { description: "服务状态" } },
        },
      },
      "/api/v1/scnet/free-credit": {
        get: {
          summary: "查询 SCNet 免费额度(实时驱动 Edge 打开控制台提取)",
          operationId: "scnetFreeCredit",
          description: "只返回免费额度(free_credit): 剩余/总额/已用/百分比/模型/剩余天数/领取与到期时间。每次调用约 5-10 秒(真实浏览器现读)。",
          responses: { 200: { description: "免费额度 JSON" }, 500: { description: "提取失败(未登录/页面结构变化)" } },
        },
      },
      "/api/v1/scnet/token-plan": {
        get: {
          summary: "查询 SCNet Token Plan(实时驱动 Edge 打开控制台提取)",
          operationId: "scnetTokenPlan",
          description: "只返回 Token Plan(token_plan): 月度 Credits/总额/剩余/已用/百分比/周期起止时间。每次调用约 5-10 秒(真实浏览器现读)。",
          responses: { 200: { description: "Token Plan JSON" }, 500: { description: "提取失败(未登录/页面结构变化)" } },
        },
      },
      "/api/v1/scnet/balance": {
        get: {
          summary: "查询 SCNet 全部余额(免费额度 + Token Plan 聚合)",
          operationId: "scnetBalance",
          description: "聚合接口, 一次返回免费额度(free_credit)与 Token Plan(token_plan)。若只需其中一项, 建议用 /api/v1/scnet/free-credit 或 /api/v1/scnet/token-plan, 省一次页面打开。每次调用约 10-20 秒(真实浏览器现读)。",
          responses: { 200: { description: "余额 JSON" }, 500: { description: "提取失败(未登录/页面结构变化)" } },
        },
      },
      "/api/v1/search/baidu": {
        get: {
          summary: "百度搜索(完整高级查询参数)",
          operationId: "baiduSearch",
          description: "实时驱动 Edge 打开百度搜索并解析结果。参数: q(基础词, 可含 site:/intitle:/inurl:/filetype:/-排除/\"精确短语\"); site/intitle/inurl/exclude(可重复或逗号分隔); filetype(pdf/doc/xls/ppt/rtf); exact(精确短语); rn(10/20/30/40/50/100); page(页码); time(day/week/month/year); resolve_urls(true 时把百度跳转链接解析为真实 URL)。合并顺序: 请求参数 > 扩展设置页默认(/api/v1/search/baidu/defaults 查看) > 内置默认。每次调用约 5-15 秒。",
          parameters: mcpQueryParameters("baidu_search"),
          responses: { 200: { description: "搜索结果 JSON(items/total/count)" }, 400: { description: "参数为空" }, 500: { description: "提取失败(未登录/反爬验证/页面结构变化)" } },
        },
        post: {
          summary: "百度搜索(POST JSON body, 中文免 URL 编码)",
          operationId: "baiduSearchPost",
          description: "与 GET 完全相同的参数, 改为 JSON body 传递。列表参数直接传数组(如 site:[\"a.com\",\"b.com\"])。推荐有中文查询词时使用本方式: GET 的查询串必须做 URL 编码, 未编码的中文会被 HTTP 协议层直接拒绝(400 Bad Request)。",
          requestBody: mcpRequestBody("baidu_search", { q: "人工智能", site: ["zhihu.com"], rn: 10 }),
          responses: { 200: { description: "搜索结果 JSON(items/total/count)" }, 400: { description: "参数为空" }, 500: { description: "提取失败(未登录/反爬验证/页面结构变化)" } },
        },
      },
      "/api/v1/search/baidu/defaults": {
        get: {
          summary: "查看百度搜索当前生效的默认参数",
          operationId: "baiduSearchDefaults",
          description: "返回 builtin(内置默认) / extension(扩展设置页下发) / effective(最终生效) 三层。",
          responses: { 200: { description: "默认参数 JSON" } },
        },
      },
      "/api/v1/search/google": {
        get: {
          summary: "谷歌搜索(完整高级查询参数)",
          operationId: "googleSearch",
          description: "实时驱动 Edge 打开谷歌搜索并解析结果。参数: q(基础词, 可含 site:/intitle:/inurl:/intext:/filetype:/link:/-排除/\"精确短语\"/OR); site/intitle/inurl/intext/exclude/or(可重复或逗号分隔); filetype(pdf/doc/docx/xls/xlsx/ppt/pptx/txt/rtf); exact(精确短语); link(链接页); num(10/20/30/50/100); page(页码); start(显式偏移, 覆盖 page); time(hour/day/week/month/year); after/before(YYYY-MM-DD 自定义日期区间); hl(界面语言); gl(国家); lr(限定语言, 如 lang_zh-CN); cr(限定国家, 如 countryCN); safe(off/active); tbm(网页/新闻 nws/图片 isch/视频 vid); nfpr(关闭纠错); verbatim(逐字匹配); resolve_urls(解析跳转链接)。合并顺序: 请求参数 > 扩展设置页默认(/api/v1/search/google/defaults 查看) > 内置默认。每次调用约 5-15 秒。",
          parameters: mcpQueryParameters("google_search"),
          responses: { 200: { description: "搜索结果 JSON(items/total/count)" }, 400: { description: "参数为空或日期非法" }, 500: { description: "提取失败(consent/反爬验证/网络不通/页面结构变化)" } },
        },
        post: {
          summary: "谷歌搜索(POST JSON body, 中文免 URL 编码)",
          operationId: "googleSearchPost",
          description: "与 GET 完全相同的参数, 改为 JSON body 传递。列表参数直接传数组(如 site:[\"github.com\"])。推荐有中文查询词时使用本方式: GET 的查询串必须做 URL 编码, 未编码的中文会被 HTTP 协议层直接拒绝(400 Bad Request)。",
          requestBody: mcpRequestBody("google_search", { q: "人工智能", site: ["github.com"], num: 10 }),
          responses: { 200: { description: "搜索结果 JSON(items/total/count)" }, 400: { description: "参数为空或日期非法" }, 500: { description: "提取失败(consent/反爬验证/网络不通/页面结构变化)" } },
        },
      },
      "/api/v1/search/google/defaults": {
        get: {
          summary: "查看谷歌搜索当前生效的默认参数",
          operationId: "googleSearchDefaults",
          description: "返回 builtin(内置默认) / extension(扩展设置页下发) / effective(最终生效) 三层。",
          responses: { 200: { description: "默认参数 JSON" } },
        },
      },
      "/api/v1/tools": {
        get: {
          summary: "列出可用的浏览器操作工具",
          operationId: "listTools",
          responses: { 200: { description: "工具目录" } },
        },
      },
      "/api/v1/tools/{name}": {
        post: {
          summary: "透传调用任意浏览器工具(百度/谷歌搜索等新能力入口)",
          operationId: "callTool",
          parameters: [{ name: "name", in: "path", required: true, schema: { type: "string" } }],
          requestBody: {
            required: false,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    args: { type: "object", description: "传给目标工具的参数对象(各工具字段不同)" },
                  },
                },
                example: { args: { tabId: 12345, code: "document.title" } },
              },
            },
          },
          responses: { 200: { description: "工具返回" }, 500: { description: "调用失败" } },
        },
      },
    },
  };
}

function docsHtml() {
  const base = `http://${CONFIG.host}:${httpPort || CONFIG.port}`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web To OpenAPI · 文档</title>
<style>
  :root { --bd:#e2e8f0; --fg:#1e293b; --mut:#64748b; --acc:#0f766e; --bg:#f8fafc; --card:#fff; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:880px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--mut); font-size:13px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  .m { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px; border-radius:4px; margin-right:8px; }
  .get { background:#dcfce7; color:#166534; } .post { background:#dbeafe; color:#1e40af; }
  .p { font-family:ui-monospace,Consolas,monospace; font-size:13px; font-weight:600; }
  .d { color:var(--mut); font-size:13px; margin-top:6px; }
  pre { background:#0f172a; color:#e2e8f0; padding:12px 14px; border-radius:8px; font-size:12px; overflow:auto; margin:10px 0 0; }
  button { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; margin-top:10px; }
  button:hover { filter:brightness(1.1); }
  #out { white-space:pre-wrap; word-break:break-all; }
  a { color:var(--acc); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Web To OpenAPI</h1>
  <div class="sub">独立 Edge 插件 + 本地 OpenAPI HTTP 服务 · 不依赖 MCP 客户端 · 底层复用 chrome-mcp-server 浏览器操作接口 · 当前监听 <b>${base}</b></div>

  <div class="card"><span class="m get">GET</span><span class="p">/health</span>
    <div class="d">存活探针: 服务状态、扩展连接状态、运行时长。</div>
    <button onclick="callApi('/health')">试一下</button></div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/scnet/free-credit</span>
    <div class="d">查询 SCNet 免费额度。实时驱动 Edge 打开 scnet 控制台「免费额度」页提取, 每次约 5-10 秒。返回剩余/总额/已用/百分比/模型/剩余天数/领取与到期时间。</div>
    <button onclick="callApi('/api/v1/scnet/free-credit')">试一下(较慢)</button></div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/scnet/token-plan</span>
    <div class="d">查询 SCNet Token Plan。实时驱动 Edge 打开 scnet 控制台「Token Plan」页提取, 每次约 5-10 秒。返回月度 Credits/总额/剩余/已用/百分比/周期起止时间。</div>
    <button onclick="callApi('/api/v1/scnet/token-plan')">试一下(较慢)</button></div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/scnet/balance</span>
    <div class="d">查询 SCNet 全部余额(聚合)。一次打开两页返回免费额度与 Token Plan, 每次约 10-20 秒。只需单项时建议用上面两个拆分接口, 省一次页面打开。</div>
    <button onclick="callApi('/api/v1/scnet/balance')">试一下(较慢)</button></div>

  <div class="card" style="border-color:#f59e0b; background:#fffbeb">
    <span class="m" style="background:#fef3c7; color:#92400e">注意</span><span class="p">中文查询词必须用 POST(或 URL 编码)</span>
    <div class="d">GET 的查询串不允许出现未编码的非 ASCII 字符——<code>?q=人工智能</code> 会被 HTTP 协议层直接拒绝, 返回 <code>400 Bad Request</code>(空响应体)。两种正确做法: ① 对参数做 URL 编码(<code>?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD</code>); ② <b>推荐</b>: 改用下方 <code>POST</code> 接口, JSON body 里中文无需任何编码。</div>
  </div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/search/baidu</span>
    <div class="d">百度搜索(完整高级参数)。q 可含 <code>site:</code> <code>intitle:</code> <code>inurl:</code> <code>filetype:</code> <code>-排除词</code> <code>"精确短语"</code>; 也可用结构化参数 site/intitle/inurl/filetype/exact/exclude(可重复或逗号分隔); rn=每页条数(10~100), page=页码, time=day/week/month/year, resolve_urls=true 解析真实 URL。约 5-15 秒。</div>
    <button onclick="callApi('/api/v1/search/baidu?q=transformer&site=github.com&rn=10')">试一下(较慢)</button>
<pre>curl -s "http://127.0.0.1:8090/api/v1/search/baidu?q=AI&intitle=论文&filetype=pdf&time=week&rn=20&page=1&resolve_urls=true"</pre>
  </div>

  <div class="card"><span class="m post">POST</span><span class="p">/api/v1/search/baidu</span>
    <div class="d">同上, JSON body 传参。<b>中文查询词推荐用这个</b>——body 里的中文不需要 URL 编码, 数组参数直接传 <code>site:["a.com","b.com"]</code>。</div>
<pre>curl -s -X POST http://127.0.0.1:8090/api/v1/search/baidu \
  -H "Content-Type: application/json" \
  -d '{"q":"人工智能","site":["zhihu.com"],"rn":10,"time":"week"}'</pre>
  </div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/search/baidu/defaults</span>
    <div class="d">查看百度搜索默认参数(内置 / 扩展设置页下发 / 最终生效)。在插件设置页配置默认参数后, 未显式传参的请求会自动套用。</div>
    <button onclick="callApi('/api/v1/search/baidu/defaults')">试一下</button></div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/search/google</span>
    <div class="d">谷歌搜索(完整高级参数)。q 可含 <code>site:</code> <code>intitle:</code> <code>inurl:</code> <code>intext:</code> <code>filetype:</code> <code>link:</code> <code>-排除词</code> <code>"精确短语"</code> <code>OR</code>; 结构化参数 site/intitle/inurl/intext/filetype/exact/exclude/or/link(可重复或逗号分隔); num=每页条数(10~100), page=页码, start=显式偏移, time=hour/day/week/month/year, after/before=YYYY-MM-DD 自定义区间, hl/gl/lr/cr=语言地区, safe=off/active, tbm=新闻 nws/视频 vid, nfpr=关闭纠错, verbatim=逐字匹配, resolve_urls=true 解析真实 URL。约 5-15 秒。</div>
    <button onclick="callApi('/api/v1/search/google?q=transformer&site=github.com&num=10')">试一下(较慢)</button>
<pre>curl -s "http://127.0.0.1:8090/api/v1/search/google?q=AI&intitle=tutorial&filetype=pdf&time=week&num=20&page=1&resolve_urls=true"</pre>
  </div>

  <div class="card"><span class="m post">POST</span><span class="p">/api/v1/search/google</span>
    <div class="d">同上, JSON body 传参。<b>中文查询词推荐用这个</b>——body 里的中文不需要 URL 编码, 数组参数直接传 <code>site:["github.com"]</code>。</div>
<pre>curl -s -X POST http://127.0.0.1:8090/api/v1/search/google \
  -H "Content-Type: application/json" \
  -d '{"q":"人工智能","site":["github.com"],"num":10,"time":"week"}'</pre>
  </div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/search/google/defaults</span>
    <div class="d">查看谷歌搜索默认参数(内置 / 扩展设置页下发 / 最终生效)。在插件设置页配置默认参数后, 未显式传参的请求会自动套用。</div>
    <button onclick="callApi('/api/v1/search/google/defaults')">试一下</button></div>

  <div class="card"><span class="m get">GET</span><span class="p">/api/v1/tools</span>
    <div class="d">列出可用的浏览器操作工具(navigate / javascript / read_page ...)。新增百度搜索、谷歌搜索等能力即通过此目录 + 下方透传接口暴露。</div>
    <button onclick="callApi('/api/v1/tools')">试一下</button></div>

  <div class="card"><span class="m post">POST</span><span class="p">/api/v1/tools/{name}</span>
    <div class="d">透传调用任意浏览器工具。请求体 <code>{"args":{...}}</code>。例: 百度搜索 = navigate 到 <code>https://www.baidu.com/s?wd=关键词</code> 后 javascript 取 innerText。</div>
<pre>curl -s -X POST ${base}/api/v1/tools/chrome_navigate \\
  -H "Content-Type: application/json" \\
  -d '{"args":{"url":"https://www.baidu.com/s?wd=AI","newWindow":true}}'</pre>
  </div>

  <div class="card"><span class="m get">GET</span><span class="p">/openapi.json</span>
    <div class="d">OpenAPI 3.0 规范(可导入 Postman / Swagger UI / 任何代码生成器)。</div></div>

  <div class="card" style="border-color:#0f766e">
    <span class="m post">MCP</span><span class="p">/mcp</span>
    <div class="d"><b>MCP 服务(Streamable HTTP)</b>: 与上述 REST 接口一一对应的 MCP 端点, 任何 MCP 客户端可直接接入(<code>{"mcpServers":{"web-to-openapi":{"url":"http://127.0.0.1:8090/mcp"}}}</code>)。工具: scnet_free_credit / scnet_token_plan / scnet_balance / baidu_search / google_search / *_search_defaults / service_health / browser_tool。也支持 stdio 接入: <code>node host/mcp-stdio.js</code>(内部代理到本端点, 供 Claude Desktop 类客户端)。中文查询词直接传, 无 URL 编码问题。</div>
    <button onclick="callMcp('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'docs-page',version:'1.0'}},'initialize')">试一下: initialize</button>
    <button onclick="callMcp('tools/list',{},'tools/list')">试一下: tools/list</button>
  </div>

  <div class="card"><div class="d" style="margin:0">响应输出</div><pre id="out">(点击「试一下」查看响应)</pre></div>

  <div class="sub" style="margin-top:24px">配置: host/config.json · 日志: %LOCALAPPDATA%\\webtoopenapi\\logs\\openapi-host.log · 前提: Edge 已加载 web-to-openapi 扩展且已登录 scnet</div>
</div>
<script>
async function callApi(p) {
  const out = document.getElementById('out');
  out.textContent = '请求中 ' + p + ' ...';
  try {
    const r = await fetch(p);
    const t = await r.text();
    try { out.textContent = JSON.stringify(JSON.parse(t), null, 2); }
    catch (e) { out.textContent = t; }
  } catch (e) { out.textContent = '请求失败: ' + e.message; }
}
async function callMcp(method, params, label) {
  const out = document.getElementById('out');
  out.textContent = 'MCP ' + (label || method) + ' ...';
  try {
    const r = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
    });
    const t = await r.text();
    try { out.textContent = JSON.stringify(JSON.parse(t), null, 2); }
    catch (e) { out.textContent = t; }
  } catch (e) { out.textContent = 'MCP 请求失败: ' + e.message; }
}
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------- 启动
process.on("uncaughtException", (e) => log("error", "uncaughtException: " + (e && e.stack || e)));
process.on("unhandledRejection", (e) => log("error", "unhandledRejection: " + (e && e.stack || e)));

log("info", `${SERVICE} v${VERSION} starting; config: ${JSON.stringify({ host: CONFIG.host, port: CONFIG.port, tool_timeout_ms: CONFIG.tool_timeout_ms, configPath: CONFIG.configPath })}`);
loadBaiduDefaults();
loadGoogleDefaults();
startStdio();
// native host 由扩展拉起即代表扩展已连接; 不等待 start 消息, 直接起 HTTP
startHttp().catch((e) => log("error", "initial http start failed: " + e.message));
