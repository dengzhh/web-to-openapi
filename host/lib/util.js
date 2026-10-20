"use strict";
/*
 * 站点模块共用的浏览器操作与小工具。
 * 本文件只依赖 nm(命令通道) 与 log, 不认识任何具体站点。
 */
const fs = require("fs");
const path = require("path");
const { callTool } = require("./nm");
const { log } = require("./log");
const { getCfg, STATE_DIR } = require("./config");

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
 * 五种模式(opts.siteMode 为站点声明, config.page_mode 为全局强制):
 *   "tab"            在最近窗口开**后台标签**: 不新建窗口、不抢焦点, 用户基本无感。
 *                    ⚠ 后台标签会被 Chromium 调度节流: 实测谷歌 SERP 要 20s 才渲染出结果,
 *                    而可见(哪怕未激活)的窗口 5s 就完整。轻量页面(百度/翻译/scnet)几乎无损。
 *   "window"         独立窗口但不激活(focused:false): 渲染优先级正常, 任务完成关标签窗口自动消失。
 *                    默认 1280x900, 位置由 Edge 自选(屏幕中部) —— 不抢焦点但占地方。
 *   "window-corner"  独立**小窗口**落右下角(避开任务栏), 不激活。渲染优先级正常,
 *                    视觉存在感约等于一个通知弹窗; 适合"要速度又想尽量不挡屏幕"。
 *   "window-front"   独立窗口并激活: 旧行为, 每次调用都弹窗抢焦点, 只在调试时用。
 *   "auto"           按站点自选: 站点声明了 siteMode 就用它, 没声明就用 tab。
 *
 * 为什么需要 corner: tab 模式下浏览器窗口一旦被最小化/完全遮挡, 标签页可能掉 hidden
 * 而被节流(渲染重的页面可慢 4 倍); window 模式能保 visible, 但默认窗口太大太挡。
 * 角落小窗是两者的折中。
 * 实测(2026-10-20, 本机 Edge 155):
 *   - corner 小窗落右下角后若被最大化浏览器窗口完全遮挡, 页面 visibilityState 会掉 hidden,
 *     但端到端翻译仍 3-5s(与未遮挡持平), 定时器未观测到实质节流;
 *   - 浏览器窗口未铺满屏幕时, 小窗可见但不抢焦点, 任务完成(keep_tab_ms 到期)自动消失。
 *
 * 已废弃的 "window-offscreen"(屏幕外 20000,20000)方案: chrome.windows.create 有
 * "Bounds must be at least 50% within visible screen space" 校验直接拒掉屏幕外坐标;
 * chrome.debugger 附加的 tab 会话上没有 Browser 域, CDP Browser.setWindowBounds 也用不了
 * (实测 -32601 wasn't found); 改 minimized 状态同样掉 hidden。此路不通, 故移除该模式。
 * 注: 早期用 playwright 在浏览器级 CDP 会话能把窗移出屏幕且页面仍 visible, 但扩展
 * (MV3 + chrome.* API)够不到那个会话, 那条实测结论对本项目不适用。
 *
 * 浏览器 API 没有"完全隐藏窗口"的能力(offscreen 文档不能导航任意站点), tab 之外的
 * 选择都在这里; 需要人介入时用 needsHuman() 显式切到前台。
 */
const PAGE_MODES = ["auto", "tab", "window", "window-front", "window-corner"];

// 角落小窗的默认尺寸(调用方可用 opts.width/height 覆盖)
const CORNER_WIN = { w: 360, h: 280 };

async function openPage(url, opts) {
  const o = opts || {};
  const global = PAGE_MODES.includes(getCfg().page_mode) ? getCfg().page_mode : "auto";
  const site = PAGE_MODES.includes(o.siteMode) && o.siteMode !== "auto" ? o.siteMode : (PAGE_MODES.includes(o.mode) ? o.mode : null);
  const mode = global === "auto" ? (site || "tab") : global;
  const args = { url };
  if (mode === "window" || mode === "window-front") {
    args.newWindow = true;
    args.width = o.width || 1280;
    args.height = o.height || 900;
    args.background = mode === "window"; // window: 不激活; window-front: 抢焦点
  } else if (mode === "window-corner") {
    // 位置由扩展算(右下角, 避开任务栏): 扩展用"最大化窗口尺寸+14px"推断屏幕大小,
    // MV3 service worker 里没有 window.screen, Edge 也没有 chrome.system.display;
    // 这里只定尺寸和意图
    args.newWindow = true;
    args.width = o.width || CORNER_WIN.w;
    args.height = o.height || CORNER_WIN.h;
    args.background = true;
    args.corner = true;
    args.type = "popup"; // 无地址栏/标签栏的小面板窗, 存在感最小
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
 * 页面复用池 —— 让"同一个站点连续调用"省掉网页加载时间。
 *
 * 背景: 每次调用都新开标签页 + 关标签页, 那么第 2 次调用仍然要重新加载整站(JS/CSS/接口),
 * 实测百度翻译冷启动 ~4.2s, 其中约 1.6s 纯粹是页面加载。而页面本身只要还活着,
 * 改动 URL 查询串就能触发一次新翻译(SPA 监听 popstate), 完全不需要重载文档。
 *
 * 做法:
 *   1) 首次调用 openPage() 正常打开, 把 tabId 记进池子, **不关**;
 *   2) 之后同一 key 的调用先试 swapUrlInTab(): replaceState + 派发 popstate —— 页内换参, 0 重载;
 *   3) 页内换参不可用(标签被关/被用户改作别用/页面不监听 popstate) → 退化为在原标签页重载;
 *      再不行才新开一个。三级降级, 任何一级失败都不影响正确性。
 *   4) 空闲超过 keep_tab_ms 毫秒后自动关闭标签页(默认 3 分钟, 0 表示不复用直接关)。
 *
 * 注意: replaceState 不产生历史记录(用 pushState 会让后退键变成翻历史译文)。
 * 换参前校验 location.host —— 防止用户把这个标签页导航到别处后我们改错页面。
 */
const PAGE_POOL = new Map(); // key -> { tabId, timer, host }

// 池里的 tabId 落盘: host 被强杀(Stop-Process / 崩溃)时来不及跑清理, 下次启动据此关掉残留标签
const POOL_STATE = path.join(STATE_DIR, "webtoopenapi", "pool-tabs.json");

function savePoolState() {
  try {
    const obj = {};
    for (const [k, e] of PAGE_POOL) {
      if (e && e.tabId != null) obj[k] = { tabId: e.tabId, host: e.host || null };
    }
    fs.mkdirSync(path.dirname(POOL_STATE), { recursive: true });
    fs.writeFileSync(POOL_STATE, JSON.stringify(obj));
  } catch (e) { /* 清理用辅助信息, 写失败不影响主流程 */ }
}

/*
 * 关闭上次运行遗留的复用标签(host 被杀 / 扩展重载时池子记录会丢)。
 * 关掉前先确认这个标签还在原站点上 —— 万一用户把它改作了别用, 就别动它。
 */
async function closeOrphanTabs() {
  let obj = null;
  try { obj = JSON.parse(fs.readFileSync(POOL_STATE, "utf8")); } catch (e) { return 0; }
  let n = 0;
  for (const it of Object.values(obj || {})) {
    if (!it || it.tabId == null) continue;
    try {
      if (it.host) {
        const r = await jsEval(it.tabId, "return { host: String(location.host) };", { timeoutMs: 6000 });
        if (!r || r.host !== it.host) continue; // 已经不是我们的页面了
      }
      await closeTab(it.tabId);
      n++;
    } catch (e) { /* 标签早就没了 */ }
  }
  try { fs.unlinkSync(POOL_STATE); } catch (e) { /* ignore */ }
  if (n) log("info", `closed ${n} leftover reused tab(s) from previous run`);
  return n;
}

function poolKey(k) { return String(k || "default"); }

function poolEntry(key) {
  const e = PAGE_POOL.get(poolKey(key));
  return e && e.tabId != null ? e : null;
}

function clearPoolTimer(e) {
  if (e && e.timer) { clearTimeout(e.timer); e.timer = null; }
}

// 只在需要复用时挂空闲计时(不关页面)。给 acquire 阶段用: 刚打开/刚复用的页面不能立刻关掉。
function armPoolTimer(key) {
  const k = poolKey(key);
  const e = PAGE_POOL.get(k);
  if (!e) return;
  clearPoolTimer(e);
  const ms = getCfg().keep_tab_ms;
  if (!(ms > 0)) return; // 不复用: 由调用方在本次调用结束后关闭
  e.timer = setTimeout(() => { dropPooled(k, true).catch(() => {}); }, ms);
  if (e.timer.unref) e.timer.unref(); // 不因为"等关闭"而拖住进程退出
}

// 重置空闲计时; keep_tab_ms<=0 时立刻关闭(等于关闭复用) —— 给"本次调用结束"时用
function touchPooled(key, keepMs) {
  const k = poolKey(key);
  const e = PAGE_POOL.get(k);
  if (!e) return;
  clearPoolTimer(e);
  const ms = keepMs == null ? getCfg().keep_tab_ms : keepMs;
  if (!ms || ms <= 0) {
    // 不复用: 立刻关掉(不要留下"池里还有条目但不关"的状态, 否则下次会误复用旧页面)
    return dropPooled(k, true).catch(() => {});
  }
  armPoolTimer(k);
}

async function dropPooled(key, close) {
  const k = poolKey(key);
  const e = PAGE_POOL.get(k);
  if (!e) return;
  clearPoolTimer(e);
  PAGE_POOL.delete(k);
  savePoolState();
  if (close && e.tabId != null) await closeTab(e.tabId);
}

/*
 * 在已打开的标签页里换 URL 查询串, 不重载文档。失败抛错(调用方自行降级)。
 */
async function swapUrlInTab(tabId, absUrl) {
  const u = new URL(absUrl);
  const rel = u.pathname + u.search;
  const code = `
const want = ${JSON.stringify(u.host)};
if (location.host !== want) return { ok:false, wrongHost:String(location.host).slice(0,60) };
history.replaceState({}, '', ${JSON.stringify(rel)});
window.dispatchEvent(new PopStateEvent('popstate'));
return { ok:true, path:location.pathname };
`;
  const r = await jsEval(tabId, code, { timeoutMs: 8000 });
  if (r && r.wrongHost) throw new Error(`标签页已不是目标站点(${r.wrongHost})`);
  if (!r || r.ok !== true) throw new Error("页内换参未生效: " + JSON.stringify(r).slice(0, 120));
  return true;
}

// 在原标签页里重载目标 URL(页内换参不生效时的降级); tabId 变了就返回新的
async function reloadInTab(tabId, url) {
  const text = dataText(await callTool("chrome_navigate", { url, tabId, background: true }, 25000));
  if (/"success"\s*:\s*false/.test(text)) throw new Error(String(text).slice(0, 160));
  const m = text.match(/"tabId"\s*:\s*(\d+)/);
  return m ? parseInt(m[1], 10) : tabId;
}

function setPooledTab(key, tabId, mode) {
  const k = poolKey(key);
  const old = PAGE_POOL.get(k);
  PAGE_POOL.set(k, { tabId, mode: mode || (old && old.mode) || null, timer: old ? old.timer : null, host: (old && old.host) || null });
  savePoolState();
}

/*
 * 复用或新开: 返回 { tabId, warm, mode }
 * warm=true 表示没有重载文档(纯页内换参), 这是"第 2 次调用更快"的关键。
 */
async function acquirePooled(key, url, opts) {
  const k = poolKey(key);
  const e = poolEntry(k);
  if (e) {
    try {
      await swapUrlInTab(e.tabId, url);
      armPoolTimer(k);
      log("browser", `reuse page key=${k} tab=${e.tabId} (页内换参, 未重载)`);
      return { tabId: e.tabId, warm: true, mode: e.mode || null };
    } catch (err) {
      log("warn", `reuse page key=${k} 页内换参失败: ${err.message}; 退化为原标签页重载`);
      try {
        const tabId = await reloadInTab(e.tabId, url);
        setPooledTab(k, tabId, e.mode);
        armPoolTimer(k);
        log("browser", `reload pooled tab=${tabId} url=${url.slice(0, 100)}`);
        return { tabId, warm: false, mode: e.mode || null };
      } catch (err2) {
        log("warn", `reuse page key=${k} 原标签页重载也失败: ${err2.message}; 新开标签页`);
        await dropPooled(k, false);
      }
    }
  }
  const page = await openPage(url, opts);
  PAGE_POOL.set(k, { tabId: page.tabId, mode: page.mode, timer: null, host: new URL(url).host });
  savePoolState();
  armPoolTimer(k);
  return { tabId: page.tabId, warm: false, mode: page.mode };
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
  acquirePooled, dropPooled, touchPooled, armPoolTimer, swapUrlInTab, reloadInTab, setPooledTab,
  closeOrphanTabs,
};
