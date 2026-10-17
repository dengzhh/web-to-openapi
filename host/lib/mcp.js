"use strict";
/*
 * MCP 服务(Streamable HTTP transport, 与 REST 同进程同端口, 端点 /mcp)。
 * 客户端接入: {"mcpServers":{"web-to-openapi":{"url":"http://127.0.0.1:8090/mcp"}}}
 * 也可用 host/mcp-stdio.js 以 stdio 方式接入(内部代理到本端点)。
 * 手写 JSON-RPC 2.0, 零依赖; stdio 已被 native messaging 占用, 所以 HTTP 是同进程唯一选择。
 *
 * 工具清单来自 registry(站点注册表), 因此与 REST 端点一一对应;
 * 参数描述是唯一数据源 —— /openapi.json 的 query/body 由它派生(见 lib/spec.js)。
 */
const { SERVICE, VERSION } = require("./config");
const registry = require("./registry");
const { withBrowserLock } = require("./util");
const { log } = require("./log");

const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const MCP_SERVER_INFO = { name: SERVICE + "-mcp", version: VERSION };

const INSTRUCTIONS = "本服务把 Edge 浏览器能力封装成 MCP 工具: 百度/谷歌搜索(完整高级参数, 中文免编码)、SCNet 余额查询、浏览器工具透传。首次调用搜索/余额类工具会真实打开浏览器页面, 约 5-15 秒。";

// MCP 侧只暴露 schema 三要素
function tools() {
  return registry.allTools().map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
}

function findTool(name) { return registry.findTool(name); }

// 工具 inputSchema -> OpenAPI 3.0 的 query parameters 数组
function queryParameters(tool) {
  const props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
  return Object.keys(props).map((name) => {
    const { description, ...schema } = props[name]; // 描述放参数级, schema 内不重复
    return { name, in: "query", description: description || "", schema };
  });
}

// 工具 inputSchema -> OpenAPI 3.0 的 requestBody 对象
function requestBody(tool, example) {
  const props = (tool && tool.inputSchema && tool.inputSchema.properties) || {};
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

function textResult(obj, isError) {
  return { content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }], isError: !!isError };
}

async function toolCall(name, args) {
  const t = registry.findTool(name);
  if (!t) throw new Error("unknown tool: " + name + " (tools/list 查看可用工具)");
  const run = () => t.run(args || {});
  // 需要驱动浏览器的工具串行化(同时开两个窗口会互相抢焦点)
  return t.browser ? await withBrowserLock(run) : await run();
}

// 处理单条 JSON-RPC 消息; 返回 null 表示 notification(不应答)
async function handleRpc(msg) {
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
          instructions: INSTRUCTIONS,
        });
      }
      case "notifications/initialized":
      case "initialized":
      case "notifications/cancelled":
        return null; // notification, 无应答
      case "ping":
        return reply({});
      case "tools/list":
        return reply({ tools: tools() });
      case "tools/call": {
        const name = msg.params && msg.params.name;
        const args = (msg.params && msg.params.arguments) || {};
        try {
          const r = await toolCall(name, args);
          return reply(textResult(r, false));
        } catch (e) {
          log("warn", `mcp tools/call ${name} failed: ${e.message}`);
          return reply(textResult("error: " + e.message, true));
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

module.exports = {
  MCP_PROTOCOL_VERSIONS, MCP_SERVER_INFO, INSTRUCTIONS,
  tools, findTool, queryParameters, requestBody, textResult, toolCall, handleRpc, isLocalOrigin,
};
