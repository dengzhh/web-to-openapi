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
const DEFAULT_CONFIG = { host: "127.0.0.1", port: 8090, tool_timeout_ms: 120000 };

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
  } catch (e) {
    cfg.warnings.push(`config.json 读取失败(${e.message}), 使用默认/环境变量配置`);
  }
  if (process.env.WEBTOOPENAPI_HOST) cfg.host = process.env.WEBTOOPENAPI_HOST;
  if (process.env.WEBTOOPENAPI_PORT) cfg.port = parseInt(process.env.WEBTOOPENAPI_PORT, 10);
  if (process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS) cfg.tool_timeout_ms = parseInt(process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS, 10);
  cfg.configPath = configPath;
  return cfg;
}

const CONFIG = loadConfig();
const SERVICE = "web-to-openapi";
const VERSION = "1.0.0";

// 本地状态目录(默认参数持久化也放这里)
const STATE_DIR = process.env.LOCALAPPDATA || HOST_DIR;

module.exports = { HOST_DIR, STATE_DIR, CONFIG, SERVICE, VERSION };
