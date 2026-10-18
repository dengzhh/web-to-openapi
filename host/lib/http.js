"use strict";
/*
 * HTTP(OpenAPI)服务。路由由三部分组成:
 *   1. 内置: /docs /openapi.json /api/v1/tools[/{name}] /mcp
 *   2. 站点端点: registry.allEndpoints()(新增站点自动挂载)
 *   3. 兜底 404
 */
const http = require("http");
const crypto = require("crypto");
const { CONFIG } = require("./config");
const state = require("./state");
const { log } = require("./log");
const registry = require("./registry");
const mcp = require("./mcp");
const { openApiSpec } = require("./spec");
const { docsHtml } = require("./docs");
const { toolCatalog } = require("./tools");
const { withBrowserLock, callTool } = require("./util");

let httpServer = null;
let httpPort = null;
let lastHost = null;
let lastPort = null;
let bindRetryTimer = null;

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

// 站点端点 -> 请求处理器。GET 用查询串, POST 用 JSON body, 交给站点自己的 parse 归一化。
function endpointHandler(ep) {
  return async (ctx) => {
    const input = ctx.method === "POST" ? ctx.body : ctx.searchParams;
    const args = ep.parse ? ep.parse(input) : input;
    const run = () => ep.run(args);
    return ep.browser ? await withBrowserLock(run) : await run();
  };
}

const routes = [];
function addRoute(method, path, handler) { routes.push({ method, path, handler }); }

// 路由表必须在站点注册之后构建(入口 openapi-host.js 注册完 sites 再调用本函数)。
// handleRequest 里还有一次惰性兜底, 避免漏调用时静默 404。
function buildRoutes() {
  routes.length = 0;
  for (const ep of registry.allEndpoints()) {
    const methods = ep.methods || [ep.method || "GET"];
    const h = endpointHandler(ep);
    for (const m of methods) addRoute(m, ep.path, h);
  }
  return routes.length;
}

const TOOL_PATH_RE = /^\/api\/v1\/tools\/([a-z0-9_.\-]+)$/i;

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
    if (!routes.length) buildRoutes(); // 惰性兜底: 入口漏调 buildRoutes 时不至于静默 404
    if (method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      });
      return res.end();
    }
    if (method === "GET" && (pathname === "/" || pathname === "/docs" || pathname === "/docs.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Access-Control-Allow-Origin": "*" });
      return res.end(docsHtml());
    }
    if (method === "GET" && pathname === "/openapi.json") return done(200, openApiSpec());

    // 站点端点
    const hit = routes.find((r) => r.method === method && r.path === pathname);
    if (hit) {
      const ctx = {
        method,
        searchParams: url.searchParams,
        body: method === "POST" ? await readBody(req) : {},
      };
      return done(200, await hit.handler(ctx));
    }

    if (method === "GET" && pathname === "/api/v1/tools") {
      return done(200, { tools: toolCatalog() });
    }
    const toolMatch = pathname.match(TOOL_PATH_RE);
    if (method === "POST" && toolMatch) {
      const body = await readBody(req);
      const args = body.args || body;
      const result = await withBrowserLock(() => callTool(toolMatch[1], args));
      return done(200, { name: toolMatch[1], result });
    }

    // ------------------------------------------------ MCP 服务(Streamable HTTP transport)
    if (pathname === "/mcp" || pathname === "/mcp/") {
      const origin = req.headers.origin;
      if (origin && !mcp.isLocalOrigin(origin)) {
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
          "Access-Control-Allow-Origin": origin && mcp.isLocalOrigin(origin) ? origin : "*",
          "Access-Control-Expose-Headers": "Mcp-Session-Id",
          "Mcp-Session-Id": sessionId,
        });
        res.end(bodyStr);
        log("http", `MCP ${(obj && obj.result && obj.result.serverInfo) ? "initialize" : (msg && msg.method) || "?"} -> ${status}`);
      };
      try {
        const results = Array.isArray(msg) ? await Promise.all(msg.map((m) => mcp.handleRpc(m))) : [await mcp.handleRpc(msg)];
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
    // 站点可用 e.status 主动声明状态码(如参数校验失败抛 400), 未声明则按 500 处理
    const body = { error: e.message, path: pathname };
    if (e.needs_human) body.needs_human = true; // 503: 需要人工登录/验证, 处理后可重试
    if (e.hint) body.hint = e.hint;
    return done(Number.isFinite(e.status) ? e.status : 500, body);
  }
}

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
      state.httpPort = httpPort;
      lastHost = CONFIG.host; lastPort = CONFIG.port;
      state.startedAt = new Date();
      log("info", `OpenAPI HTTP listening on http://${CONFIG.host}:${httpPort} (docs: /docs, spec: /openapi.json)`);
      resolve(httpPort);
    });
  });
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
      state.httpPort = null;
      resolve();
    });
    // 强制关掉保活连接
    if (httpServer.closeAllConnections) httpServer.closeAllConnections();
  });
}

module.exports = { startHttp, startHttpLazy, stopHttp, handleRequest, sendJson, readBody, buildRoutes, routes };
