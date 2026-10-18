"use strict";
/*
 * 站点模块共用的浏览器操作与小工具。
 * 本文件只依赖 nm(命令通道) 与 log, 不认识任何具体站点。
 */
const { callTool } = require("./nm");
const { log } = require("./log");
const { CONFIG } = require("./config");

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

/*
 * 页面打开策略(核心: 默认不在用户面前弹窗)。
 *
 * 上游 chrome_navigate 的两条分支:
 *   传 newWindow/width/height -> chrome.windows.create({focused: background ? false : true})
 *   否则                       -> chrome.tabs.create({windowId: 最近聚焦窗口, active: !background})
 *
 * 四种模式(opts.siteMode 为站点声明, config.page_mode 为全局强制):
 *   "tab"          在最近窗口开**后台标签**: 不新建窗口、不抢焦点, 用户基本无感。
 *                  ⚠ 后台标签会被 Chromium 调度节流: 实测谷歌 SERP 要 20s 才渲染出结果,
 *                  而可见(哪怕未激活)的窗口 5s 就完整。轻量页面(百度/翻译/scnet)几乎无损。
 *   "window"       独立窗口但不激活(focused:false): 渲染优先级正常, 任务完成关标签窗口自动消失。
 *   "window-front" 独立窗口并激活: 旧行为, 每次调用都弹窗抢焦点, 只在调试时用。
 *   "auto"         按站点自选: 站点声明了 siteMode 就用它, 没声明就用 tab。
 *
 * 浏览器 API 没有"完全隐藏窗口"的能力(offscreen 文档不能导航任意站点), 所以
 * tab 是"看起来什么都没发生"的最优解; 需要人介入时用 needsHuman() 显式切到前台。
 */
const PAGE_MODES = ["auto", "tab", "window", "window-front"];

async function openPage(url, opts) {
  const o = opts || {};
  const global = PAGE_MODES.includes(CONFIG.page_mode) ? CONFIG.page_mode : "auto";
  const site = PAGE_MODES.includes(o.siteMode) && o.siteMode !== "auto" ? o.siteMode : (PAGE_MODES.includes(o.mode) ? o.mode : null);
  const mode = global === "auto" ? (site || "tab") : global;
  const args = { url };
  if (mode === "window" || mode === "window-front") {
    args.newWindow = true;
    args.width = o.width || 1280;
    args.height = o.height || 900;
    args.background = mode === "window"; // window: 不激活; window-front: 抢焦点
  } else {
    args.background = true; // 复用最近窗口, 后台标签, 不激活
    if (o.windowId) args.windowId = o.windowId;
  }
  const data = await callTool("chrome_navigate", args);
  const text = dataText(data);
  const tabM = text.match(/"tabId"\s*:\s*(\d+)/);
  const winM = text.match(/"windowId"\s*:\s*(\d+)/);
  const page = {
    tabId: tabM ? parseInt(tabM[1], 10) : null,
    windowId: winM ? parseInt(winM[1], 10) : null,
    mode,
    keepOpen: false,
  };
  if (page.tabId == null) throw new Error("打开页面失败(未拿到 tabId): " + String(text).slice(0, 200));
  log("browser", `open page mode=${mode} tab=${page.tabId} win=${page.windowId} url=${url.slice(0, 120)}`);
  return page;
}

// 把标签页切到前台并激活其所在窗口。仅用于"需要人工介入"的场景。
async function focusTab(page) {
  const tabId = typeof page === "number" ? page : page && page.tabId;
  const windowId = typeof page === "object" && page ? page.windowId : null;
  if (tabId == null) return false;
  try {
    const args = { tabId };
    if (windowId != null) args.windowId = windowId;
    await callTool("chrome_switch_tab", args, 15000);
    log("browser", `focus tab=${tabId} win=${windowId}`);
    return true;
  } catch (e) {
    log("warn", `focus tab ${tabId} failed: ${e.message}`);
    return false;
  }
}

/*
 * 需要人工介入(登录 / 人机验证 / 同意页):
 *   1) 把页面切到前台(此时才"打开窗口", 用户一眼能看到要做什么);
 *   2) 标记 keepOpen, 让 finally 里的 closePage 不要关掉 —— 关掉用户就得自己重找页面;
 *   3) 抛 503, 响应里带 needs_human 与 hint, 调用方(含 AI)知道这是可恢复的人为阻塞。
 */
async function needsHuman(page, reason, hint) {
  if (page && typeof page === "object") page.keepOpen = true;
  const shown = await focusTab(page);
  const tail = shown
    ? "已把页面切到前台, 请在该标签页完成操作后重试"
    : "请手动打开对应网站完成操作后重试";
  const e = new Error(`${reason} —— ${tail}`);
  e.status = 503;
  e.needs_human = true;
  e.hint = hint || "该接口复用你浏览器里已有的登录态; 遇到登录/验证码时会把页面切到前台, 处理完再次调用即可。";
  throw e;
}

async function closeTab(tabId) {
  if (tabId == null) return;
  try { await callTool("chrome_close_tabs", { tabIds: [tabId] }, 20000); }
  catch (e) { log("warn", `close tab ${tabId} failed: ${e.message}`); }
}

// 关闭 openPage 返回的页面; keepOpen=true(需要人工)时保留
async function closePage(page) {
  if (!page || typeof page !== "object") return closeTab(page);
  if (page.keepOpen) {
    log("browser", `keep tab=${page.tabId} open for manual step`);
    return;
  }
  await closeTab(page.tabId);
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
 *   guards(d) 提前判定: 抛错(反爬/consent)或提前返回(零结果页); 支持 async
 *             (需要在抛错前把页面切到前台时, 写成 async 并 await needsHuman)
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
    if (o.guards) await o.guards(d, i, tries);
    if (o.stopWhen && o.stopWhen(d)) return d;
    if (d && d.parse_error && i === tries - 1) {
      throw new Error("搜索结果提取失败(响应被拦截或解析失败): " + d.parse_error);
    }
    const n = d && Array.isArray(d.items) ? d.items.length : 0;
    // 有结果 + 结果容器在 = 可用。readyState 只作辅助判断:
    // 谷歌有长连接时可能长期停在 interactive/loading(后台标签更明显), 只看 complete 会白等到超时。
    const loaded = !!(d && d[flag] && (d.ready === "complete" || n > 0));
    // 稳定性还要求"条目够多或已 complete": SERP 渐进渲染, 只按"两次读数相等"会在
    // 第 1 条出现时就早退(实测谷歌只返回 1 条)。
    const stable = n > 0 && n === lastCount && (d.ready === "complete" || n >= 5);
    if (loaded && stable) return d;
    if (!loaded && i === tries - 1) {
      log("warn", `${label} page not fully loaded after ${tries}s: ${JSON.stringify({ ready: d && d.ready, [flag]: d && d[flag], bodyLen: d && d.bodyLen })}`);
    }
    lastCount = n;
    await sleep(1000);
  }
  // body 完全为空 = 导航根本没开始。最常见原因不是站点挂了, 而是浏览器窗口被最小化/完全遮挡:
  // Chromium 对不可见标签会冻结渲染与网络(实测谷歌 28s 才开始 loading)。给出可操作的提示,
  // 比安静地返回 0 条有用得多。
  if (d && d.bodyLen === 0 && !(d.items && d.items.length)) {
    const e = new Error(`${label} 页面没有渲染出任何内容: 浏览器窗口可能被最小化或完全遮挡, Chromium 会冻结不可见标签的加载`);
    e.status = 504;
    e.hint = "把浏览器窗口切到前台(最小化恢复到屏幕可见即可, 不需要操作)后重试; 或在本机 host/config.json 设 page_mode=\"window-front\", 让接口在需要时自己把窗口切到前台。";
    throw e;
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
  sleep, dataText, num, strList, openPage, closeTab, closePage, focusTab, needsHuman,
  jsEval, decodeUrlCodes, extractSerp, followRedirect, resolveLinks, toSearchParams,
  paramList, truthy, UA, withBrowserLock, callTool, PAGE_MODES,
};
