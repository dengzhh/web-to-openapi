"use strict";
/*
 * openapi-host.js —— 启动入口(薄)
 * ---------------------------------------------------------------------------
 * 定位:
 *   - 由浏览器扩展(web-to-openapi/extension, Edge / Chrome 通用)经 native messaging 拉起; stdio 不是"启动钩子",
 *     而是 host <-> 扩展之间的持续命令通道: host 发 call_tool -> 扩展用 chrome.* 执行 -> 回传结果。
 *     去掉 native messaging = host 失去驱动浏览器的能力(它不是可省的启动器)。
 *   - 同时对外暴露两套等价接口: OpenAPI 风格 HTTP(/docs 有文档) 与 MCP(/mcp, Streamable HTTP)。
 *   - 底层复用 chrome-mcp-server 的浏览器操作接口: native-messaging CALL_TOOL
 *     -> 扩展执行 chrome_* 工具(navigate / javascript / read_page / close_tabs ...)。
 *
 * 代码组织(2026-10-17 重构: 一个网页一个文件, 加能力不必再改这里):
 *   lib/config.js    配置(host/port/超时)
 *   lib/log.js       日志(只走 stderr + 文件, stdout 被协议帧占用)
 *   lib/nm.js        native messaging 命令通道(不认识任何具体站点)
 *   lib/util.js      浏览器操作与通用小工具(开页/执行 JS/重试提取/链接还原)
 *   lib/defaults.js  站点默认参数三层合并 + 持久化
 *   lib/registry.js  站点注册表 —— 新增能力的唯一入口
 *   lib/mcp.js       MCP 协议 + 工具清单(参数描述是 REST 文档的唯一数据源)
 *   lib/spec.js      /openapi.json(由注册表派生)
 *   lib/docs.js      /docs 文档页(由注册表派生)
 *   lib/http.js      HTTP 服务与路由分发
 *   sites/*.js       每个网页一个文件: scnet / baidu / google(以及服务自身的 _service)
 *
 * 新增一个网页要做的全部事情:
 *   1. 在 host/sites/ 下加一个模块(导出 id / endpoints / tools / 可选 defaults)
 *   2. 在 host/sites/index.js 的清单里加一行 require
 *   —— 路由、MCP 工具、/openapi.json、/docs 文档页、扩展默认参数消息全部自动生效。
 *
 * 与 mcp-chrome-bridge 的关系: 协议完全一致(同源), 但出口是 REST/JSON + MCP;
 * 两者可并行运行(本 host 用独立的 native host 名 com.webtoopenapi.host)。
 *
 * 协议要点(与 chrome-mcp-shared 对齐):
 *   扩展 -> host : {type:"start", payload:{port}}            host 回 {type:"server_started",payload:{port}}
 *   扩展 -> host : {type:"stop"}                              host 回 {type:"server_stopped"}
 *   扩展 -> host : {type:"ping_from_extension"}               host 回 {type:"pong_to_extension"}
 *   扩展 -> host : {type:"set_<site>_defaults", payload}      host 回 {type:"<site>_defaults_ack"}
 *   host -> 扩展 : {type:"call_tool", payload:{name,args}, requestId}
 *   扩展 -> host : {responseToRequestId, payload:{status:"success", data}} | {error}
 *
 * 日志纪律: stdout 只走协议帧; 所有日志写 stderr + 日志文件。
 * 配置: 同目录 config.json {host,port,tool_timeout_ms}; 环境变量 WEBTOOPENAPI_HOST/
 *       WEBTOOPENAPI_PORT/WEBTOOPENAPI_TOOL_TIMEOUT_MS 覆盖; CLI --host/--port/--config。
 */

const { CONFIG, SERVICE, VERSION } = require("./lib/config");

// stderr 副本由 host 自己追加写, 不靠 run_host.bat 的 "2>>"。
// 原因: 已经有一个 host 在跑时(两个浏览器 / 残留进程), cmd 打不开这个文件做追加,
// 而重定向失败会让 cmd 把整条脚本剩下的命令全部作废 —— node 根本不会被执行,
// 浏览器只会报 "Error when communicating with the native messaging host",
// 两个日志文件都是空的, 完全查不出原因。node 的追加写允许多进程共存。
(function teeStderrToFile() {
  try {
    const fs = require("fs");
    const path = require("path");
    const dir = process.env.WEBTOOPENAPI_LOG_DIR ||
      path.join(process.env.LOCALAPPDATA || __dirname, "webtoopenapi", "logs");
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(path.join(dir, "host-stderr.log"), "a");
    const origWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = function (chunk, enc, cb) {
      try {
        fs.writeSync(fd, typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
      } catch (e) { /* 写不进日志也不能影响 host */ }
      return origWrite(chunk, enc, cb);
    };
  } catch (e) { /* 日志不可用时就只用 openapi-host.log */ }
})();

const { log } = require("./lib/log");
const nm = require("./lib/nm");
const util = require("./lib/util");
const registry = require("./lib/registry");
const httpSvc = require("./lib/http");

// 注册全部站点(必须先于路由构建与启动: 路由表与默认参数都在这里就绪)
require("./sites");
const routeCount = httpSvc.buildRoutes();

process.on("uncaughtException", (e) => log("error", "uncaughtException: " + (e && e.stack || e)));
process.on("unhandledRejection", (e) => log("error", "unhandledRejection: " + (e && e.stack || e)));

for (const w of CONFIG.warnings || []) log("warn", w);
log("info", `${SERVICE} v${VERSION} starting; config: ${JSON.stringify({ host: CONFIG.host, port: CONFIG.port, tool_timeout_ms: CONFIG.tool_timeout_ms, configPath: CONFIG.configPath })}`);
log("info", `sites: ${registry.all().map((s) => s.id).join(", ")}; routes: ${routeCount}`);

// 站点自定义 native 消息(默认参数下发等)
nm.registerHook(registry.handleNm);
registry.initAll(); // 从磁盘恢复各站点默认参数

nm.setStartHandler(async () => {
  const port = await httpSvc.startHttpLazy();
  // 顺手关掉上次运行遗留的复用标签(host 被强杀时来不及清理, 池子记录已落盘)
  util.closeOrphanTabs().catch((e) => log("warn", "closeOrphanTabs failed: " + e.message));
  return port;
});
nm.setStopHandler(() => httpSvc.stopHttp());

nm.startStdio();
// native host 由扩展拉起即代表扩展已连接; 不等待 start 消息, 直接起 HTTP
httpSvc.startHttp().catch((e) => log("error", "initial http start failed: " + e.message));
