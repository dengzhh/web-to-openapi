"use strict";
/*
 * 浏览器工具目录: 底层复用 chrome-mcp-server(chrome-mcp-shared)的工具清单,
 * 找不到时退回内置精简清单。GET /api/v1/tools 与 MCP 的 browser_tool 都读这里。
 */
const fs = require("fs");
const path = require("path");
const { HOST_DIR } = require("./config");
const { log } = require("./log");

function findChromeMcpShared() {
  const candidates = [];
  if (process.env.CHROME_MCP_SHARED_PATH) candidates.push(process.env.CHROME_MCP_SHARED_PATH);
  candidates.push(path.join(HOST_DIR, "node_modules", "chrome-mcp-shared"));
  const versionsRoot = path.join(process.env.USERPROFILE || "C:\\Users\\Default", ".workbuddy", "binaries", "node", "versions");
  try {
    for (const v of fs.readdirSync(versionsRoot)) {
      candidates.push(path.join(versionsRoot, v, "node_modules", "mcp-chrome-bridge", "node_modules", "chrome-mcp-shared"));
      candidates.push(path.join(versionsRoot, v, "node_modules", "chrome-mcp-shared"));
    }
  } catch (e) { /* ignore */ }
  for (const c of candidates) {
    try {
      if (fs.existsSync(path.join(c, "dist", "index.js")) || fs.existsSync(path.join(c, "package.json"))) return c;
    } catch (e) { /* ignore */ }
  }
  return null;
}

const SHARED_TOOLS_FALLBACK = [
  { name: "chrome_navigate", description: "打开 URL(newWindow 可新开窗口)" },
  { name: "chrome_javascript", description: "在标签页执行 JS 并返回结果(可拿到未脱敏 DOM 文本)" },
  { name: "chrome_read_page", description: "读取页面可访问性树" },
  { name: "chrome_get_web_content", description: "获取页面文本内容(数字可能被脱敏)" },
  { name: "chrome_screenshot", description: "截图(当前模型读不了图, 仅存档)" },
  { name: "chrome_close_tabs", description: "关闭标签页" },
  { name: "chrome_switch_tab", description: "切换标签页" },
  { name: "get_windows_and_tabs", description: "列出所有窗口和标签页" },
  { name: "search_tabs_content", description: "搜索标签页内容" },
];

function toolCatalog() {
  try {
    const sharedPath = findChromeMcpShared();
    if (sharedPath) {
      const shared = require(path.join(sharedPath, "dist", "index.js"));
      const schemas = shared.TOOL_SCHEMAS || [];
      if (schemas.length) {
        return schemas.map((t) => ({ name: t.name, description: t.description || "", inputSchema: t.inputSchema || null }));
      }
    }
  } catch (e) {
    log("warn", "chrome-mcp-shared 工具目录加载失败, 使用内置精简目录: " + e.message);
  }
  return SHARED_TOOLS_FALLBACK;
}

module.exports = { findChromeMcpShared, toolCatalog, SHARED_TOOLS_FALLBACK };
