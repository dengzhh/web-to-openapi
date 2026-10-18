"use strict";
/*
 * 配置: 同目录 config.json {host,port,tool_timeout_ms}
 * 覆盖优先级(低 -> 高): 内置默认 < config.json < CLI --host/--port < 环境变量
 *   WEBTOOPENAPI_HOST / WEBTOOPENAPI_PORT / WEBTOOPENAPI_TOOL_TIMEOUT_MS
 * 读取失败不抛异常, 只把原因放进 CONFIG.warnings(由启动方打印), 保证 host 一定能起来。
 */
const fs = require("fs");
const path = require("path");

const HOST_DIR = path.join(__dirname, "..");
const PAGE_MODES = ["auto", "tab", "window", "window-front"];
const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 8090,
  tool_timeout_ms: 120000,
  // 页面打开策略(见 util.openPage):
  //   "auto"         按站点自选(默认): 轻量页面用后台标签, 渲染重的页面(如谷歌)用独立但不激活的窗口
  //   "tab"          一律后台标签: 不新建窗口、不抢焦点; 代价是后台标签会被浏览器节流(谷歌实测慢 4 倍)
  //   "window"       一律独立窗口但不激活(focused:false)
  //   "window-front" 独立窗口并激活: 旧行为, 每次调用都弹窗抢焦点
  page_mode: "auto",
};

function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG, warnings: [] };
  let configPath = path.join(HOST_DIR, "config.json");
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
    if (fileCfg.page_mode) cfg.page_mode = String(fileCfg.page_mode).trim().toLowerCase();
  } catch (e) {
    cfg.warnings.push(`config.json 读取失败(${e.message}), 使用默认/环境变量配置`);
  }
  if (process.env.WEBTOOPENAPI_HOST) cfg.host = process.env.WEBTOOPENAPI_HOST;
  if (process.env.WEBTOOPENAPI_PORT) cfg.port = parseInt(process.env.WEBTOOPENAPI_PORT, 10);
  if (process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS) cfg.tool_timeout_ms = parseInt(process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS, 10);
  if (process.env.WEBTOOPENAPI_PAGE_MODE) cfg.page_mode = process.env.WEBTOOPENAPI_PAGE_MODE.trim().toLowerCase();
  if (!PAGE_MODES.includes(cfg.page_mode)) {
    cfg.warnings.push(`page_mode "${cfg.page_mode}" 不合法(可选 ${PAGE_MODES.join(" / ")}), 已回退为 auto`);
    cfg.page_mode = "auto";
  }
  cfg.configPath = configPath;
  return cfg;
}

const CONFIG = loadConfig();
const SERVICE = "web-to-openapi";
const VERSION = "1.0.0";

// 本地状态目录(默认参数持久化也放这里)
const STATE_DIR = process.env.LOCALAPPDATA || HOST_DIR;

module.exports = { HOST_DIR, STATE_DIR, CONFIG, SERVICE, VERSION, PAGE_MODES };
