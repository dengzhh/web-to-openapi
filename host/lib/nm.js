"use strict";
/*
 * native messaging(stdio): host <-> 浏览器扩展(Edge / Chrome 通用)之间的持续命令通道。
 * 由扩展拉起本 host 后, stdio 不是"启动钩子"而是命令通道:
 *   host  -> 扩展 : {type:"call_tool", payload:{name,args}, requestId}
 *   扩展  -> host : {responseToRequestId, payload:{status,data}}
 * 帧格式: 4 字节小端长度 + JSON 本体(与 chrome-mcp-shared 一致)。
 *
 * 协议要点:
 *   扩展 -> host : {type:"start", payload:{port}}   -> host 回 {type:"server_started"}
 *   扩展 -> host : {type:"stop"}                    -> host 回 {type:"server_stopped"}
 *   扩展 -> host : {type:"ping_from_extension"}     -> host 回 {type:"pong_to_extension"}
 * 站点自定义消息(如默认参数下发)由 registry 注册的 hook 处理, 本文件不认识具体站点。
 */
const crypto = require("crypto");
const { CONFIG } = require("./config");
const { log } = require("./log");

const pending = new Map(); // requestId -> {resolve, reject, timeoutId}
let connected = false;

const hooks = []; // (message, nmSend) => boolean(是否已处理)
let startHandler = null; // async (payload) => port
let stopHandler = null; // async () => void

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

function isConnected() { return connected; }
function registerHook(fn) { hooks.push(fn); }
function setStartHandler(fn) { startHandler = fn; }
function setStopHandler(fn) { stopHandler = fn; }

// 来自扩展 START 消息的 host/port 不再覆盖本机配置。
// 原因: 本扩展派生自 chrome-mcp-server, 其 START 会带上硬编码的 MCP 端口(12306)。
// 若照单全收, 会先停掉自己的 8090、再去抢被旧 mcp-chrome-bridge 占用的 12306,
// 触发 EADDRINUSE, 导致 8090 也起不来(设置页探测 /health 永远失败)。
// 监听地址以 config.json / 环境变量 / --host --port 为单一事实源。
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

function handleNmMessage(message) {
  if (!message || typeof message !== "object") return;
  if (message.responseToRequestId) {
    const p = pending.get(message.responseToRequestId);
    if (p) {
      clearTimeout(p.timeoutId);
      pending.delete(message.responseToRequestId);
      if (message.error) p.reject(new Error(message.error));
      else {
        // 扩展回包: {payload:{status,message,data}}; 工具结果在 data 里
        const pl = message.payload || {};
        p.resolve(pl.data !== undefined ? pl.data : pl);
      }
    }
    return;
  }
  // 站点自定义消息优先(默认参数下发等)
  for (const h of hooks) {
    try {
      if (h(message, nmSend) === true) return;
    } catch (e) {
      log("warn", `nm hook failed: ${e.message}`);
    }
  }
  switch (message.type) {
    case "start":
      connected = true;
      applyConfigFromPayload(message.payload);
      Promise.resolve(startHandler ? startHandler(message.payload) : CONFIG.port)
        .then((port) => nmSend({ type: "server_started", payload: { port } }))
        .catch((e) => nmSendError("failed to start http server: " + e.message));
      break;
    case "stop":
      Promise.resolve(stopHandler ? stopHandler() : null)
        .then(() => nmSend({ type: "server_stopped" }))
        .catch((e) => nmSendError("failed to stop http server: " + e.message));
      break;
    case "ping_from_extension":
      nmSend({ type: "pong_to_extension" });
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
    Promise.resolve(stopHandler ? stopHandler() : null).finally(() => process.exit(0));
  };
  process.stdin.on("end", () => shutdown("stdin end"));
  process.stdin.on("error", (e) => shutdown("stdin error: " + e.message));
}

module.exports = {
  nmSend,
  nmSendError,
  callTool,
  isConnected,
  registerHook,
  setStartHandler,
  setStopHandler,
  startStdio,
};
