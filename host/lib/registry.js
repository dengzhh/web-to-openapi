"use strict";
/*
 * 站点注册表 —— 本项目的扩展点。
 *
 * 一个"站点模块"(host/sites/*.js)描述一个网页能提供的能力:
 *   defaults   可选, 默认参数存储(三层合并 + 持久化 + 扩展设置页下发)
 *   endpoints  REST 端点(自动挂路由 / 进 openapi.json / 进 /docs 文档页)
 *   tools      MCP 工具(自动进 tools/list, 参数描述同时派生 REST 文档)
 *
 * 注册后四处自动生效, 新增一个网页只需在 host/sites/ 加一个文件并在 index.js 里 require:
 *   1. HTTP 路由(lib/http.js)   2. MCP 工具(lib/mcp.js)
 *   3. /openapi.json(lib/spec.js) 4. /docs 文档页(lib/docs.js) + 扩展默认参数消息
 */
const sites = [];
const cfg = require("./config");
const { log } = require("./log");

function register(site) {
  sites.push(site);
  return site;
}

function all() { return sites; }

function allEndpoints() {
  return sites.flatMap((s) => (s.endpoints || []).map((ep) => ({ ...ep, site: s })));
}

function allTools() {
  return sites.flatMap((s) => (s.tools || []).map((t) => ({ ...t, site: s })));
}

function findTool(name) { return allTools().find((t) => t.name === name) || null; }

function initAll() {
  for (const s of sites) if (s.defaults && s.defaults.load) s.defaults.load();
}

/*
 * 处理扩展下发的站点消息: set/get_<nmType>_defaults。
 * 消息类型由站点 id 派生, 扩展侧(extension/background.js)无需为每个站点手写分派。
 * 另外处理全局"服务配置"消息: set/get/reset_service_config(page_mode / keep_tab_ms)。
 * 返回 true 表示消息已被消费(调用方不再走内置 switch)。
 */
function handleNm(message, nmSend) {
  for (const s of sites) {
    if (!s.defaults) continue;
    const t = s.defaults.nmType;
    if (message.type === `set_${t}_defaults`) {
      const v = s.defaults.set(message.payload);
      nmSend({ type: `${t}_defaults_ack`, payload: v });
      return true;
    }
    if (message.type === `get_${t}_defaults`) {
      nmSend({ type: `${t}_defaults`, payload: s.defaults.get() });
      return true;
    }
  }
  // 全局服务配置(不属于任何站点): 扩展设置页 -> 运行时生效 + 持久化
  if (message.type === "set_service_config") {
    cfg.setServiceOverride(message.payload || {});
    log("info", `service config overridden: ${JSON.stringify(cfg.getOverrides())}`);
    nmSend({ type: "service_config", payload: publicServiceConfig() });
    return true;
  }
  if (message.type === "get_service_config") {
    nmSend({ type: "service_config", payload: publicServiceConfig() });
    return true;
  }
  if (message.type === "reset_service_config") {
    cfg.resetServiceOverride();
    nmSend({ type: "service_config", payload: publicServiceConfig() });
    return true;
  }
  return false;
}

// 只回给设置页需要的字段, 不把 warnings / configPath 这类内部细节泄漏出去
function publicServiceConfig() {
  return {
    page_mode: cfg.getCfg().page_mode,
    page_modes: cfg.PAGE_MODES,
    keep_tab_ms: cfg.getCfg().keep_tab_ms,
    config_override: cfg.getOverrides(),
  };
}

module.exports = { register, all, allEndpoints, allTools, findTool, initAll, handleNm };
