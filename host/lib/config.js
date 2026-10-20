"use strict";
/*
 * 配置: 同目录 config.json {host,port,tool_timeout_ms,page_mode,keep_tab_ms}
 * 覆盖优先级(低 -> 高): 内置默认 < config.json < CLI --host/--port < 环境变量
 *   WEBTOOPENAPI_HOST / WEBTOOPENAPI_PORT / WEBTOOPENAPI_TOOL_TIMEOUT_MS
 *   WEBTOOPENAPI_PAGE_MODE / WEBTOOPENAPI_KEEP_TAB_MS
 * 读取失败不抛异常, 只把原因放进 CONFIG.warnings(由启动方打印), 保证 host 一定能起来。
 *
 * page_mode / keep_tab_ms 额外支持"运行时覆盖": 扩展设置页(Edge / Chrome 选项页)下发,
 * 落盘到 %LOCALAPPDATA%\webtoopenapi\service-config.json, host 重启后仍生效。
 * 覆盖层优先级最高(高于 config.json 与环境变量), 因为它是用户最近一次显式操作。
 * 用 getCfg() 读"当前生效值" —— 不要在模块加载期把 CONFIG 解构成常量, 否则拿不到覆盖。
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
  // 页面复用: 同一站点连续调用时, 标签页保留多久(毫秒)后自动关闭。
  //   0      = 不复用, 每次调用结束就关(旧行为, 每次都重新加载网页)
  //   180000 = 3 分钟(默认): 这段时间内的重复调用不再加载网页, 实测百度翻译 4.2s -> 2.6s
  // 只影响"我们自己开的那个后台标签", 不影响用户自己的标签页。
  keep_tab_ms: 180000,
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
    if (fileCfg.keep_tab_ms != null) cfg.keep_tab_ms = parseInt(fileCfg.keep_tab_ms, 10);
  } catch (e) {
    cfg.warnings.push(`config.json 读取失败(${e.message}), 使用默认/环境变量配置`);
  }
  if (process.env.WEBTOOPENAPI_HOST) cfg.host = process.env.WEBTOOPENAPI_HOST;
  if (process.env.WEBTOOPENAPI_PORT) cfg.port = parseInt(process.env.WEBTOOPENAPI_PORT, 10);
  if (process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS) cfg.tool_timeout_ms = parseInt(process.env.WEBTOOPENAPI_TOOL_TIMEOUT_MS, 10);
  if (process.env.WEBTOOPENAPI_PAGE_MODE) cfg.page_mode = process.env.WEBTOOPENAPI_PAGE_MODE.trim().toLowerCase();
  if (process.env.WEBTOOPENAPI_KEEP_TAB_MS) cfg.keep_tab_ms = parseInt(process.env.WEBTOOPENAPI_KEEP_TAB_MS, 10);
  if (!(cfg.keep_tab_ms >= 0)) {
    cfg.warnings.push(`keep_tab_ms "${cfg.keep_tab_ms}" 不合法(应为 >=0 的毫秒数, 0=不复用), 已回退为 180000`);
    cfg.keep_tab_ms = 180000;
  }
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

/* ---------------------------------------------------------------- 运行时覆盖 */

const OVERRIDE_FILE = path.join(STATE_DIR, "webtoopenapi", "service-config.json");
// 只允许覆盖这两个"行为开关"; host/port/tool_timeout_ms 改了要重启才完整生效, 不开放
const OVERRIDABLE = ["page_mode", "keep_tab_ms"];
let overrides = {};

function loadOverrides() {
  try {
    const saved = JSON.parse(fs.readFileSync(OVERRIDE_FILE, "utf8"));
    if (saved && typeof saved === "object") overrides = saved;
  } catch (e) { /* 无文件或损坏: 无覆盖 */ }
  return overrides;
}

function saveOverrides() {
  try {
    fs.mkdirSync(path.dirname(OVERRIDE_FILE), { recursive: true });
    fs.writeFileSync(OVERRIDE_FILE, JSON.stringify(overrides, null, 2), "utf8");
  } catch (e) { /* 只影响持久化, 不影响本次生效 */ }
}

function sanitizeOverride(patch) {
  const out = {};
  if (!patch || typeof patch !== "object") return out;
  if (patch.page_mode != null && patch.page_mode !== "") {
    const m = String(patch.page_mode).trim().toLowerCase();
    if (PAGE_MODES.includes(m)) out.page_mode = m;
  }
  if (patch.keep_tab_ms != null && patch.keep_tab_ms !== "") {
    const ms = parseInt(patch.keep_tab_ms, 10);
    if (ms >= 0) out.keep_tab_ms = ms;
  }
  return out;
}

/*
 * 当前生效配置(合并启动配置与运行时覆盖)。
 * 注意: 返回新对象, 调用方不要缓存它 —— 覆盖可能在两次调用之间发生变化。
 */
function getCfg() {
  return { ...CONFIG, ...overrides };
}

/*
 * 由扩展设置页下发。传 null / 空串表示"恢复默认"(删掉那一项的覆盖)。
 * 返回生效值, 调用方直接回给设置页显示。
 */
function setServiceOverride(patch) {
  const clean = sanitizeOverride(patch);
  for (const k of OVERRIDABLE) {
    if (clean[k] !== undefined) overrides[k] = clean[k];
    else if (patch && (patch[k] === null || patch[k] === "")) delete overrides[k];
  }
  saveOverrides();
  return getCfg();
}

function resetServiceOverride() {
  overrides = {};
  try { fs.unlinkSync(OVERRIDE_FILE); } catch (e) { /* 本来就没有 */ }
  return getCfg();
}

// 当前有哪些项被覆盖了(设置页下发), 空对象 = 完全按 config.json / 环境变量走
function getOverrides() {
  return { ...overrides };
}

loadOverrides();

module.exports = {
  HOST_DIR, STATE_DIR, CONFIG, SERVICE, VERSION, PAGE_MODES,
  getCfg, setServiceOverride, resetServiceOverride, getOverrides, OVERRIDE_FILE,
};
