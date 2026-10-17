#!/usr/bin/env node
/**
 * web-to-openapi · MCP stdio 入口(独立进程, 零依赖)
 *
 * 用途: 让标准 MCP 客户端(Claude Desktop / WorkBuddy 等以 command 方式接入的宿主)
 *       使用本服务的全部能力。内部把 newline-delimited JSON-RPC 转发给
 *       openapi-host.js 的 HTTP /mcp 端点(http://127.0.0.1:8090/mcp)。
 *
 * 链路: MCP客户端 <--stdio--> mcp-stdio.js <--HTTP--> openapi-host.js(被浏览器拉起) --> 浏览器扩展(Edge / Chrome) --> 浏览器
 *
 * 前提: 浏览器(Edge 或 Chrome)已打开且扩展在线(openapi-host.js 由扩展自动拉起并监听 8090)。
 *       /health 不通时本入口会在 stderr 给出明确提示, 而不是静默失败。
 *
 * 纪律:
 *   - stdout 只写 MCP 协议消息(newline-delimited JSON), 日志一律 stderr。
 *   - 端口优先取 --port 参数, 其次 WEBTOOPENAPI_MCP_PORT 环境变量, 最后 8090。
 *
 * 客户端配置示例(Claude Desktop / claude_desktop_config.json):
 *   {
 *     "mcpServers": {
 *       "web-to-openapi": {
 *         "command": "node",
 *         "args": ["C:\\path\\to\\web-to-openapi\\host\\mcp-stdio.js"]
 *       }
 *     }
 *   }
 */
"use strict";

const http = require("http");
const readline = require("readline");

// ---------------------------------------------------------------- 配置
function resolvePort() {
  const argIdx = process.argv.indexOf("--port");
  if (argIdx >= 0 && process.argv[argIdx + 1]) return parseInt(process.argv[argIdx + 1], 10);
  if (process.env.WEBTOOPENAPI_MCP_PORT) return parseInt(process.env.WEBTOOPENAPI_MCP_PORT, 10);
  return 8090;
}
const PORT = resolvePort();
const HOST = process.env.WEBTOOPENAPI_MCP_HOST || "127.0.0.1";

function errLog(msg) {
  try { process.stderr.write(`[mcp-stdio] ${msg}\n`); } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------- HTTP 转发
let healthChecked = false;
function forward(line) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(JSON.parse(line)); // 顺带做一次 JSON 合法性校验
    const req = http.request(
      {
        host: HOST,
        port: PORT,
        path: "/mcp",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          Accept: "application/json",
        },
        timeout: 150000, // 搜索类工具真实驱动浏览器, 可能 5-15s; 留足余量
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          if (!healthChecked) { healthChecked = true; errLog(`upstream /mcp ok (HTTP ${res.statusCode})`); }
          // 上游 /mcp 返回 pretty-print 多行 JSON; MCP stdio 是 newline-delimited JSON,
          // 每条消息必须压成单行, 否则客户端按行解析会把一条响应拆成多行而全部失败。
          let out = body;
          try { out = JSON.stringify(JSON.parse(body)); } catch (e) { errLog("upstream body is not JSON, passing through: " + e.message); }
          resolve(out);
        });
      }
    );
    req.on("timeout", () => { req.destroy(new Error(`upstream timeout after 150s (port ${PORT})`)); });
    req.on("error", (e) => {
      errLog(`upstream http://${HOST}:${PORT}/mcp unreachable: ${e.message}`);
      errLog("请确认: ① 浏览器(Edge 或 Chrome)已启动并加载 web-to-openapi 扩展 ② 扩展已把 openapi-host 拉起(开机后第一次会自动拉起) ③ 端口未被 config.json/环境变量改掉");
      resolve(JSON.stringify({
        jsonrpc: "2.0",
        id: null,
        error: { code: -32000, message: `web-to-openapi 服务不可达(http://${HOST}:${PORT}/mcp): ${e.message}。请启动浏览器(Edge 或 Chrome)并确认扩展在线。` },
      }));
    });
    req.end(payload);
  });
}

// ---------------------------------------------------------------- stdio 主循环
// 注意: stdin EOF(close)可能早于在途 HTTP 转发完成。若此时直接 exit,
// 客户端(如管道测试/快速连续发消息的宿主)会一行响应都收不到。
// 故用 pending 计数: 关闭后必须等所有在途请求写完 stdout 才退出。
const rl = readline.createInterface({ input: process.stdin, terminal: false });
let inFlight = 0;
let closing = false;

function maybeExit() {
  if (closing && inFlight === 0) {
    errLog("stdin closed, all responses flushed, exiting");
    process.exit(0);
  }
}

async function handleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return;
  let out;
  try {
    out = await forward(trimmed);
  } catch (e) {
    // JSON.parse 失败等: 按 JSON-RPC 规范回 parse error
    out = JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error: " + e.message } });
  }
  await new Promise((resolve) => {
    // 用回调确保写入完成(管道场景下 process.exit 会截断未 flush 的输出)
    process.stdout.write(out + "\n", () => resolve());
  });
}

rl.on("line", (line) => {
  inFlight++;
  handleLine(line)
    .catch((e) => errLog("handleLine failed: " + (e && e.message)))
    .finally(() => { inFlight--; maybeExit(); });
});

rl.on("close", () => {
  closing = true;
  maybeExit();
});

process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

errLog(`MCP stdio bridge ready -> http://${HOST}:${PORT}/mcp (stdin JSON-RPC 按行读取)`);
errLog("提示: 上游服务由浏览器扩展自动拉起; 若长时间不可达请先打开 Edge 或 Chrome。");
