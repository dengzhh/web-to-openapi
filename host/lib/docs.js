"use strict";
/*
 * /docs 文档页。内容由站点注册表派生: 新增端点后文档页自动出现对应卡片(含 curl 示例)。
 * 卡片文案取自端点的 doc 字段(note / postNote / tryQuery / curlGet / curlPost / slow)。
 */
const { getCfg } = require("./config");
const state = require("./state");
const registry = require("./registry");

function card(opts) {
  const { method, path, note, button, curl, extra } = opts;
  const cls = method === "POST" ? "post" : "get";
  const btn = button === false ? "" : `\n    <button onclick="callApi('${button || path}')">试一下${opts.slow ? "(较慢)" : ""}</button>`;
  const pre = curl ? `\n<pre>${curl}</pre>` : "";
  // extra: 端点自带的补充说明块(HTML), 由站点模块提供(例如翻译的语言清单)
  const ex = extra ? `\n    <div class="extra">${extra}</div>` : "";
  return `  <div class="card"><span class="m ${cls}">${method}</span><span class="p">${path}</span>
    <div class="d">${note}</div>${ex}${btn}${pre}
  </div>`;
}

const NOTICE_CARD = `  <div class="card" style="border-color:#f59e0b; background:#fffbeb">
    <span class="m" style="background:#fef3c7; color:#92400e">注意</span><span class="p">中文查询词必须用 POST(或 URL 编码)</span>
    <div class="d">GET 的查询串不允许出现未编码的非 ASCII 字符——<code>?q=人工智能</code> 会被 HTTP 协议层直接拒绝, 返回 <code>400 Bad Request</code>(空响应体)。两种正确做法: ① 对参数做 URL 编码(<code>?q=%E4%BA%BA%E5%B7%A5%E6%99%BA%E8%83%BD</code>); ② <b>推荐</b>: 改用下方 <code>POST</code> 接口, JSON body 里中文无需任何编码。</div>
  </div>`;

// 页面打开策略(来自 config.page_mode): 读者最关心"会不会弹窗", 放在最前面
function pageCard() {
  const mode = getCfg().page_mode;
  const desc = {
    auto: "按站点自选(当前各站点均为后台标签)",
    tab: "在后台标签打开: 不新建窗口、不抢焦点, 提取完自动关闭",
    window: "独立窗口但不激活, 关标签后窗口随之消失",
    "window-front": "独立窗口并激活(每次调用都会弹窗抢焦点)",
  }[mode] || mode;
  return `  <div class="card" style="border-color:#0ea5e9; background:#f0f9ff">
    <span class="m" style="background:#e0f2fe; color:#075985">页面</span><span class="p">打开策略: ${mode}</span>
    <div class="d">${desc}。遇到登录 / 人机验证时会把页面切到前台并<b>保留</b>(不自动关闭), 同时返回 <code>503</code> + <code>needs_human: true</code>, 处理完再调一次即可。<br>浏览器窗口被最小化或完全遮挡时, Chromium 会冻结不可见标签的渲染 → 可能 20s 以上甚至返回 <code>504</code>; 把窗口露出来即恢复。修改 <code>host/config.json</code> 的 <code>page_mode</code> 或设环境变量 <code>WEBTOOPENAPI_PAGE_MODE</code>。</div>
  </div>`;
}

function docsHtml() {
  const cfg = getCfg();
  const base = `http://${cfg.host}:${state.httpPort || cfg.port}`;
  const cards = [];
  let noticeInserted = false;
  cards.push(pageCard());

  for (const ep of registry.allEndpoints()) {
    const methods = ep.methods || [ep.method || "GET"];
    const doc = ep.doc || {};
    // 第一个需要 POST 的端点前插入"中文必须 POST"提示(POST 存在的意义就是绕过 URL 编码)
    if (methods.includes("POST") && !noticeInserted) {
      cards.push(NOTICE_CARD);
      noticeInserted = true;
    }
    if (methods.includes("GET")) {
      cards.push(card({
        method: "GET", path: ep.path,
        note: doc.note || ep.description || ep.summary,
        button: doc.tryQuery || ep.path,
        curl: doc.curlGet,
        slow: !!doc.slow,
        extra: doc.extra,
      }));
    }
    if (methods.includes("POST")) {
      cards.push(card({
        method: "POST", path: ep.path,
        note: doc.postNote || (ep.post && ep.post.description) || ep.description || ep.summary,
        button: false,
        curl: doc.curlPost,
      }));
    }
  }

  cards.push(card({
    method: "GET", path: "/api/v1/tools",
    note: "列出可用的浏览器操作工具(navigate / javascript / read_page ...)。新增百度搜索、谷歌搜索等能力即通过此目录 + 下方透传接口暴露。",
  }));
  cards.push(card({
    method: "POST", path: "/api/v1/tools/{name}",
    note: "透传调用任意浏览器工具。请求体 <code>{\"args\":{...}}</code>。例: 百度搜索 = navigate 到 <code>https://www.baidu.com/s?wd=关键词</code> 后 javascript 取 innerText。",
    button: false,
    curl: `curl -s -X POST ${base}/api/v1/tools/chrome_navigate \\
  -H "Content-Type: application/json" \\
  -d '{"args":{"url":"https://www.baidu.com/s?wd=AI","newWindow":true}}'`,
  }));
  cards.push(card({
    method: "GET", path: "/openapi.json",
    note: "OpenAPI 3.0 规范(可导入 Postman / Swagger UI / 任何代码生成器)。",
    button: false,
  }));

  const toolNames = registry.allTools().map((t) => t.name).join(" / ");
  cards.push(`  <div class="card" style="border-color:#0f766e">
    <span class="m post">MCP</span><span class="p">/mcp</span>
    <div class="d"><b>MCP 服务(Streamable HTTP)</b>: 与上述 REST 接口一一对应的 MCP 端点, 任何 MCP 客户端可直接接入(<code>{"mcpServers":{"web-to-openapi":{"url":"http://127.0.0.1:8090/mcp"}}}</code>)。工具: ${toolNames}。也支持 stdio 接入: <code>node host/mcp-stdio.js</code>(内部代理到本端点, 供 Claude Desktop 类客户端)。中文查询词直接传, 无 URL 编码问题。</div>
    <button onclick="callMcp('initialize',{protocolVersion:'2025-06-18',capabilities:{},clientInfo:{name:'docs-page',version:'1.0'}},'initialize')">试一下: initialize</button>
    <button onclick="callMcp('tools/list',{},'tools/list')">试一下: tools/list</button>
  </div>`);

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Web To OpenAPI · 文档</title>
<style>
  :root { --bd:#e2e8f0; --fg:#1e293b; --mut:#64748b; --acc:#0f766e; --bg:#f8fafc; --card:#fff; }
  * { box-sizing: border-box; }
  body { margin:0; font-family:-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  .wrap { max-width:880px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:22px; margin:0 0 4px; }
  .sub { color:var(--mut); font-size:13px; margin-bottom:24px; }
  .card { background:var(--card); border:1px solid var(--bd); border-radius:10px; padding:16px 18px; margin-bottom:14px; }
  .m { display:inline-block; font-size:11px; font-weight:700; padding:2px 8px; border-radius:4px; margin-right:8px; }
  .get { background:#dcfce7; color:#166534; } .post { background:#dbeafe; color:#1e40af; }
  .p { font-family:ui-monospace,Consolas,monospace; font-size:13px; font-weight:600; }
  .d { color:var(--mut); font-size:13px; margin-top:6px; }
  pre { background:#0f172a; color:#e2e8f0; padding:12px 14px; border-radius:8px; font-size:12px; overflow:auto; margin:10px 0 0; }
  .extra { margin-top:10px; font-size:12px; }
  .extra details { border:1px solid var(--bd); border-radius:8px; padding:8px 12px; background:#fcfdfe; }
  .extra summary { cursor:pointer; color:var(--fg); font-weight:600; font-size:12px; }
  .extra table { border-collapse:collapse; width:100%; margin-top:8px; font-size:12px; }
  .extra th, .extra td { border-bottom:1px solid var(--bd); padding:4px 6px; text-align:left; vertical-align:top; }
  .extra th { color:var(--mut); font-weight:600; }
  .extra code { background:#eef2f7; padding:1px 5px; border-radius:3px; font-family:ui-monospace,Consolas,monospace; }
  .extra .mut { color:var(--mut); }
  button { background:var(--acc); color:#fff; border:0; border-radius:6px; padding:7px 14px; font-size:13px; cursor:pointer; margin-top:10px; }
  button:hover { filter:brightness(1.1); }
  #out { white-space:pre-wrap; word-break:break-all; }
  a { color:var(--acc); }
</style>
</head>
<body>
<div class="wrap">
  <h1>Web To OpenAPI</h1>
  <div class="sub">浏览器插件(Edge / Chrome 通用) + 本地 OpenAPI HTTP 服务 · 不依赖 MCP 客户端 · 底层复用 chrome-mcp-server 浏览器操作接口 · 当前监听 <b>${base}</b></div>

${cards.join("\n\n")}

  <div class="card"><div class="d" style="margin:0">响应输出</div><pre id="out">(点击「试一下」查看响应)</pre></div>

  <div class="sub" style="margin-top:24px">配置: host/config.json · 日志: %LOCALAPPDATA%\\webtoopenapi\\logs\\openapi-host.log · 前提: 浏览器(Edge 或 Chrome)已加载 web-to-openapi 扩展且已登录 scnet</div>
</div>
<script>
async function callApi(p) {
  const out = document.getElementById('out');
  out.textContent = '请求中 ' + p + ' ...';
  try {
    const r = await fetch(p);
    const t = await r.text();
    try { out.textContent = JSON.stringify(JSON.parse(t), null, 2); }
    catch (e) { out.textContent = t; }
  } catch (e) { out.textContent = '请求失败: ' + e.message; }
}
async function callMcp(method, params, label) {
  const out = document.getElementById('out');
  out.textContent = 'MCP ' + (label || method) + ' ...';
  try {
    const r = await fetch('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: params || {} }),
    });
    const t = await r.text();
    try { out.textContent = JSON.stringify(JSON.parse(t), null, 2); }
    catch (e) { out.textContent = t; }
  } catch (e) { out.textContent = 'MCP 请求失败: ' + e.message; }
}
</script>
</body>
</html>`;
}

module.exports = { docsHtml };
