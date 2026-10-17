"use strict";
/*
 * 站点模块共用的浏览器操作与小工具。
 * 本文件只依赖 nm(命令通道) 与 log, 不认识任何具体站点。
 */
const { callTool } = require("./nm");
const { log } = require("./log");

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 串行化浏览器操作(同时开两个窗口会互相抢焦点)。
// 端点/工具声明 browser:true 时, 由 http.js 与 mcp.js 统一包这把锁。
let opChain = Promise.resolve();
function withBrowserLock(fn) {
  const run = opChain.then(fn);
  opChain = run.catch(() => {});
  return run;
}

function dataText(data) {
  if (data && Array.isArray(data.content)) return data.content.map((c) => (c && c.text) || "").join("\n");
  return typeof data === "string" ? data : JSON.stringify(data);
}

function num(s) { return parseFloat(String(s).replace(/,/g, "")); }

// 逗号(中英文)分隔字符串或数组 -> 去空白非空数组。列表型查询参数统一走这里。
function strList(v) {
  const arr = Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,，]/);
  return arr.map((s) => String(s == null ? "" : s).trim()).filter(Boolean);
}

// 打开新窗口并返回 tabId(浏览器窗口会互抢焦点, 调用方需包在 withBrowserLock 里)
async function openPage(url) {
  const data = await callTool("chrome_navigate", { url, newWindow: true, background: false, width: 1280, height: 900 });
  const m = dataText(data).match(/"tabId"\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

async function closeTab(tabId) {
  if (tabId == null) return;
  try { await callTool("chrome_close_tabs", { tabIds: [tabId] }, 20000); }
  catch (e) { log("warn", `close tab ${tabId} failed: ${e.message}`); }
}

/*
 * 在标签页里执行提取脚本并取回对象。
 * 两个防过滤要点(chrome_javascript 的响应会被扩展侧 sanitize):
 *   1) 页面内不要返回 location.href 等完整带参 URL(只回 path/hostname);
 *   2) 链接一律用字符码数组传输, host 侧用 decodeUrlCodes 还原
 *      (长 base64/查询串整块返回会触发"Cookies/query string data"整块拦截)。
 * 同样的原因, 提取脚本必须 return 对象而不是 JSON.stringify 后的字符串:
 * 扩展对"单字符串"有 10KB 截断上限(长摘要页会被截断 -> host 解析失败),
 * 返回对象则按字段独立限额。
 *
 * opts.strict = true 时解析失败直接抛(用于页面结构固定的场景, 如 scnet 控制台);
 * 默认 false, 解析失败返回 {parse_error}, 交给重试逻辑决定是否放弃(SERP 渐进渲染会短暂失败)。
 */
async function jsEval(tabId, code, opts) {
  const o = opts || {};
  const timeoutMs = o.timeoutMs || 20000;
  const maxOutputBytes = o.maxOutputBytes || 262144; // rn=100/num=100 时格式化输出会超过默认 50KB
  const data = await callTool("chrome_javascript", { tabId, code, timeoutMs, maxOutputBytes });
  const text = dataText(data);
  let obj;
  try { obj = JSON.parse(text); }
  catch (e) {
    if (o.strict) throw new Error("提取响应解析失败: " + String(text).slice(0, 200));
    return { parse_error: String(text).slice(0, 120) };
  }
  let inner = obj.result;
  if (typeof inner === "string") {
    try { inner = JSON.parse(inner); }
    catch (e) {
      if (o.strict) throw new Error("提取响应内层不是合法 JSON");
      return { parse_error: "inner result is not json" };
    }
  }
  return inner || (o.strict ? {} : { parse_error: "empty result" });
}

// 字符码数组 -> 字符串; 顺带剥掉页面塞进 href 尾部的 NUL 等控制字符
function decodeUrlCodes(codes) {
  if (!Array.isArray(codes) || !codes.length) return "";
  let s = "";
  for (let i = 0; i < codes.length; i += 8000) {
    s += String.fromCharCode.apply(null, codes.slice(i, i + 8000));
  }
  return s.replace(/[\u0000-\u001f\u007f]/g, "");
}

/*
 * SERP 通用重试提取: 新窗口可能后台加载、SERP 又是渐进渲染,
 * 所以要等 readyState=complete + 结果容器出现 + 条目数连续两轮稳定(每轮 1s)。
 * opts:
 *   flag      结果容器标志字段名(如 hasLeft / hasRso)
 *   guards(d) 提前判定: 直接抛错(反爬/consent 之类不可恢复的情况)
 *   stopWhen(d) 返回 true 时立即结束重试并原样返回(如谷歌明确返回零结果页)
 */
async function extractSerp(tabId, code, opts) {
  const o = opts || {};
  const tries = o.tries || 12;
  const flag = o.flag || "hasRso";
  const label = o.label || "serp";
  let lastCount = -1;
  let d = null;
  for (let i = 0; i < tries; i++) {
    d = await jsEval(tabId, code, { maxOutputBytes: 262144 });
    if (o.guards) o.guards(d, i, tries);
    if (o.stopWhen && o.stopWhen(d)) return d;
    if (d && d.parse_error && i === tries - 1) {
      throw new Error("搜索结果提取失败(响应被拦截或解析失败): " + d.parse_error);
    }
    const n = d && Array.isArray(d.items) ? d.items.length : 0;
    const loaded = d && d.ready === "complete" && d[flag];
    if (n > 0 && loaded && n === lastCount) return d;
    if (!loaded && i === tries - 1) {
      log("warn", `${label} page not fully loaded after ${tries}s: ${JSON.stringify({ ready: d && d.ready, [flag]: d && d[flag], bodyLen: d && d.bodyLen })}`);
    }
    lastCount = n;
    await sleep(1000);
  }
  return d;
}

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

// 跟随 302 拿到最终 URL(失败返回 null, 调用方保留原链接)
async function followRedirect(link, timeoutMs) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 6000);
    const res = await fetch(link, { redirect: "follow", signal: ctrl.signal, headers: { "User-Agent": UA } });
    clearTimeout(timer);
    return res.url || null;
  } catch (e) { return null; }
}

/*
 * 批量把跳转链接解析为真实 URL。
 * match  只处理匹配的链接(如百度的 /link?、谷歌的 /url?|/aclk?)
 * local  本地解析函数(谷歌 /url?q= 不必发请求), 返回 null 时再走 302
 */
async function resolveLinks(items, opts) {
  const o = opts || {};
  const concurrency = o.concurrency || 8;
  const queue = items.filter((it) => o.match.test(it.url));
  let idx = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (idx < queue.length) {
      const it = queue[idx++];
      it.real_url = (o.local ? o.local(it.url) : null) || (await followRedirect(it.url, o.timeoutMs));
    }
  });
  await Promise.all(workers);
  return items;
}

// 把 GET 的 URLSearchParams 或 POST 的 JSON 对象统一成 URLSearchParams,
// 让站点侧 parseRequest 一份代码同时服务两种调用方式。
// 数组值(JSON 天然支持 site:["a","b"])展开成同名多参, 与 ?site=a&site=b 等价。
function toSearchParams(input) {
  if (input instanceof URLSearchParams) return input;
  const sp = new URLSearchParams();
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input)) {
      if (v == null) continue;
      if (Array.isArray(v)) v.forEach((x) => sp.append(k, x == null ? "" : String(x)));
      else sp.append(k, String(v));
    }
  }
  return sp;
}

// URLSearchParams -> 同名多值数组(同时支持逗号分隔)
function paramList(sp, name) {
  return sp.getAll(name).flatMap((v) => String(v).split(/[,，]/)).map((s) => s.trim()).filter(Boolean);
}

// "1"/"true"/"yes" -> true
function truthy(v) { return /^(1|true|yes)$/i.test(String(v || "")); }

module.exports = {
  sleep, dataText, num, strList, openPage, closeTab, jsEval, decodeUrlCodes,
  extractSerp, followRedirect, resolveLinks, toSearchParams, paramList, truthy, UA,
  withBrowserLock, callTool,
};
