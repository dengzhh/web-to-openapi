"use strict";
/*
 * 站点清单 —— 新增能力只在这里加一行 require + register。
 * 路由 / MCP 工具 / openapi.json / 文档页 / 扩展默认参数消息 全部自动生效, 无需改动其它文件。
 *
 * 站点模块约定(host/sites/<name>.js):
 *   id         唯一标识, 同时派生扩展默认参数消息类型(set/get_<id>_defaults)
 *   title      展示名(文档页用)
 *   defaults   [可选] createDefaultsStore(...) 实例: 三层默认参数 + 持久化
 *   endpoints  REST 端点: {method, methods?, path, tool?, operationId, summary, description,
 *                          post?, example?, responses, parse?, run(input), browser?, doc?}
 *   tools      MCP 工具: {name, description, inputSchema, run(args), browser?}
 */
const registry = require("../lib/registry");

const sites = [
  require("./_service"), // 服务自身: /health + service_health + browser_tool
  require("./scnet"),
  require("./baidu"),
  require("./google"),
];

for (const s of sites) registry.register(s);

module.exports = { sites };
