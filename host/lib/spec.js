"use strict";
/*
 * OpenAPI 3.0 规范生成。paths 由站点注册表派生 —— 新增站点端点后 /openapi.json 自动跟上,
 * 参数描述取自 MCP 工具的 inputSchema(唯一数据源, 见 lib/mcp.js)。
 */
const { CONFIG, VERSION } = require("./config");
const state = require("./state");
const registry = require("./registry");
const mcp = require("./mcp");

function openApiSpec() {
  const base = `http://${CONFIG.host}:${state.httpPort || CONFIG.port}`;
  const paths = {};

  for (const ep of registry.allEndpoints()) {
    const methods = ep.methods || [ep.method || "GET"];
    const tool = ep.tool ? registry.findTool(ep.tool) : null;
    const item = {};
    if (methods.includes("GET")) {
      item.get = {
        summary: ep.summary,
        operationId: ep.operationId,
        description: ep.description,
        parameters: tool ? mcp.queryParameters(tool) : [],
        responses: ep.responses,
      };
    }
    if (methods.includes("POST")) {
      item.post = {
        summary: (ep.post && ep.post.summary) || ep.summary,
        operationId: (ep.post && ep.post.operationId) || `${ep.operationId}Post`,
        description: (ep.post && ep.post.description) || ep.description,
        requestBody: tool ? mcp.requestBody(tool, ep.example) : undefined,
        responses: ep.responses,
      };
    }
    paths[ep.path] = item;
  }

  // 非站点专属: 浏览器工具目录与透传调用
  paths["/api/v1/tools"] = {
    get: {
      summary: "列出可用的浏览器操作工具",
      operationId: "listTools",
      description: "底层 chrome-mcp-server 提供的工具清单(navigate / javascript / read_page ...), 可经下方透传接口调用。",
      responses: { 200: { description: "工具目录" } },
    },
  };
  paths["/api/v1/tools/{name}"] = {
    post: {
      summary: "透传调用任意浏览器工具(新能力入口)",
      operationId: "callTool",
      description: "把任意浏览器工具透传给浏览器扩展(Edge / Chrome)执行。固化端点(百度/谷歌搜索、SCNet 余额)覆盖不到的场景用它。",
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
  };

  return {
    openapi: "3.0.3",
    info: {
      title: "Web To OpenAPI",
      version: VERSION,
      description: "浏览器插件(Edge / Chrome 通用)驱动的浏览器操作 HTTP API, 一套代码同时提供 REST 与 MCP(/mcp)两套接口。不依赖 MCP 客户端; 底层经 native messaging 调用 chrome-mcp-server 的浏览器操作接口。",
    },
    servers: [{ url: base, description: "本地服务(可在 config.json 配置地址/端口)" }],
    paths,
  };
}

module.exports = { openApiSpec };
