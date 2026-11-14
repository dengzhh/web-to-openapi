"use strict";
/*
 * 假浏览器: 在 Node 里模拟 chrome_navigate / chrome_javascript / get_windows_and_tabs,
 * 让 ysbnag 站点模块的并发调度可以在不打开真实浏览器、不碰真实药师帮账号的前提下跑通。
 *
 * 用法(必须在 require("../sites") 之前调用 install):
 *   const fake = require("./helpers/fake-browser").install({ ignoresPageParam: false });
 *
 * 模拟的页面行为:
 *   - 标签的当前页 = URL 里的 page 参数(ignoresPageParam=true 时恒为 1, 用来模拟
 *     「SPA 不吃 page 参数」的情况, 验证并发路径会不会正确退回串行)
 *   - 点 .pagination-next/.pagination-prev 改当前页
 *   - 字体解码脚本返回每页 60 条(带价格/厂家, 供去重与过滤)
 *   - 页面级状态探针返回页码/条数/是否已切词/首条指纹
 */
const os = require("os");
const fs = require("fs");
const pathMod = require("path");

const PAGE_SIZE = 60;
const TOTAL = 300; // 5 页

/*
 * 状态目录隔离(2026-11-14 补)。
 * ---------------------------------------------------------------------------
 * 为什么必须放在 require("../../lib/nm") **之前**:
 *   nm -> lib/config, 而 lib/config 在**加载那一刻**就把 STATE_DIR 算好
 *   (STATE_DIR = process.env.LOCALAPPDATA || HOST_DIR)。只要 nm 先被 require,
 *   后面再改 env 都不生效 —— 实测就是这样漏的: 隔离写在 install() 里没用,
 *   假数据照样写进真实 %LOCALAPPDATA%\webtoopenapi\ysbang-cache.json。
 *
 * 不清洗的后果不是「测试脏」, 而是**污染生产**: v1.6.0 起药师帮缓存落盘,
 * 假条目("第1页药品1 / 某某医药")被真机 compare 命中, 直接返回给调用方。
 *
 * 已经在临时区的(如 stats-persist.test.js 显式指定了自己的临时目录)不覆盖,
 * 否则会打断那些用例对固定 STATE_FILE 路径的断言。
 */
function ensureIsolatedStateDir() {
  const cur = process.env.LOCALAPPDATA || "";
  const tmp = os.tmpdir().toLowerCase();
  if (cur && cur.toLowerCase().indexOf(tmp) === 0) return cur;
  const dir = fs.mkdtempSync(pathMod.join(os.tmpdir(), "wb-openapi-test-"));
  process.env.LOCALAPPDATA = dir;
  return dir;
}

ensureIsolatedStateDir(); // ⚠ 必须先于下面这行

const nm = require("../../lib/nm");

function install(opts) {
  const o = opts || {};
  if (!o.keepStateDir) ensureIsolatedStateDir();
  const tabs = new Map();
  let nextTabId = 1000;
  let nextWinId = 10;
  const stats = { navigations: 0, jsCalls: 0, tabsOpened: 0, closed: 0 };

  function keywordOf(url) {
    try {
      const h = decodeURIComponent(String(url || ""));
      const m = h.match(/searchkey=([^&]*)/);
      return m ? m[1] : "";
    } catch (e) { return ""; }
  }
  function pageOf(url) {
    try {
      const h = decodeURIComponent(String(url || ""));
      const m = h.match(/[?&]page=(\d+)/);
      return m ? +m[1] : 1;
    } catch (e) { return 1; }
  }
  function mkTab(url, windowId) {
    const id = nextTabId++;
    const t = {
      id,
      windowId: windowId == null ? nextWinId++ : windowId,
      url,
      keyword: keywordOf(url),
      page: o.ignoresPageParam ? 1 : pageOf(url),
      fh: 1,
      pageReads: 0, // 轻量页码探针被读了几次(用于模拟 SPA 延迟应用 page 参数)
      // short: 这个标签打开该页后只渲染出 N 张卡(不再增长); 由 shortOnce 在开标签时决定
      short: 0,
    };
    const sp = o.shortOnce || {};
    const tp = t.page;
    if (sp[tp] != null && !shortUsed[tp]) {
      t.short = sp[tp];
      shortUsed[tp] = true;
    }
    tabs.set(id, t);
    stats.tabsOpened++;
    return t;
  }
  const shortUsed = {};
  function itemsFor(page, keyword) {
    const out = [];
    // 品名带上查询词: 比价逻辑要按品名基础名对齐品种(化积口服液 vs 消食化积口服液),
    // 假数据若全是「第N页药品M」, 这条路径就永远测不到。
    const prefix = String(keyword || "");
    for (let i = 1; i <= PAGE_SIZE; i++) {
      out.push({
        name: `${prefix}第${page}页药品${i}`,
        factory: `厂${page}-${i}`,
        shop: "某某医药",
        warehouse: "兰州仓",
        price: (1 + page / 100).toFixed(2),
        price_ok: true,
        moq: "1盒",
        spec: "12片*2板",
        expiry: "2027-10-01",
      });
    }
    return out;
  }
  function content(obj) {
    return { content: [{ type: "text", text: JSON.stringify(obj) }] };
  }
  /*
   * qshtyy(海豚药药)桩: 该站点走站内 JSON 接口, 页面脚本里固定含
   * /api/goods/search/onCondition 这个字面量, 用它做分派标记。
   * 返回短键结构(i/n/s/m/p/...), 与 sites/qshtyy.js 页面内脚本保持一致。
   */
  function qshtyyRowsFor(q, limit) {
    // 回调返回 undefined/null 表示「这一个词交回默认生成」, 便于单点覆盖个别关键词
    if (typeof o.qshtyyRows === "function") {
      const r = o.qshtyyRows(q, limit);
      if (r != null) return r;
    } else if (o.qshtyyRows && o.qshtyyRows[q]) {
      return o.qshtyyRows[q];
    }
    const n = Math.min(limit, 3);
    const out = [];
    for (let i = 1; i <= n; i++) {
      out.push({
        i: 1000 + i,
        n: `${q}(${i})`,
        s: "10ml*12支",
        m: "测试药业",
        p: (10 + i).toFixed(2),
        rp: (12 + i).toFixed(2),
        mp: "0.00",
        sq: 100 * i,
        e: "2028-06-01",
        mo: 1,
        pk: 10,
        pc: 100,
        u: "盒",
        ap: "国药准字H000000" + i,
        ins: "医保乙类",
        tg: "I-A+1",
        ct: "化学药",
        lb: "10",
      });
    }
    return out;
  }
  function statFor(tab, q) {
    tab.pageReads++;
    // pageApplyDelay: 模拟 SPA 在 document ready 之后才把 hash 里的 page 应用到路由
    const stale = o.pageApplyDelay && tab.pageReads <= o.pageApplyDelay;
    return {
      qok: !q || tab.keyword === q,
      page: stale ? 1 : tab.page,
      n: PAGE_SIZE,
      fh: tab.fh,
      total: TOTAL,
      ready: "complete",
      hasList: true,
      bodyLen: 5000,
      vcode: false,
      needLogin: false,
    };
  }

  async function callTool(name, args) {
    const a = args || {};
    if (name === "get_windows_and_tabs") {
      const byWin = new Map();
      for (const t of tabs.values()) {
        if (!byWin.has(t.windowId)) byWin.set(t.windowId, []);
        byWin.get(t.windowId).push({ tabId: t.id, windowId: t.windowId, url: t.url });
      }
      return content({
        windows: Array.from(byWin.entries()).map(([id, list]) => ({ id, tabs: list })),
      });
    }

    if (name === "chrome_navigate") {
      stats.navigations++;
      let tab;
      if (a.tabId != null && tabs.has(a.tabId)) {
        tab = tabs.get(a.tabId);
        tab.url = a.url;
        tab.keyword = keywordOf(a.url);
        tab.page = o.ignoresPageParam ? 1 : pageOf(a.url);
        tab.fh++;
      } else {
        tab = mkTab(a.url, a.newWindow ? nextWinId++ : null);
      }
      return content({ tabId: tab.id, windowId: tab.windowId });
    }

    if (name === "chrome_close_tabs") {
      for (const id of (a.tabIds || [])) { if (tabs.delete(id)) stats.closed++; }
      return content({ closed: (a.tabIds || []).length });
    }

    if (name === "chrome_switch_tab") return content({ ok: true });

    if (name === "chrome_javascript") {
      stats.jsCalls++;
      const code = String(a.code || "");
      const tab = tabs.get(a.tabId);
      if (!tab) return content({ result: { parse_error: "no tab" } });

      // 0) qshtyy(海豚药药): 站内 JSON 接口两次 POST。用脚本里的接口字面量分派。
      //    opts 控制: qshtyyNoToken / qshtyyExpired / qshtyyApiError / qshtyyRows / qshtyyTotal
      if (code.indexOf("/api/goods/search/onCondition") >= 0) {
        stats.qshtyyCalls = (stats.qshtyyCalls || 0) + 1;
        if (o.qshtyyNoToken) return content({ result: { error: "no_token" } });
        if (o.qshtyyExpired) return content({ result: { error: "unauthorized", message: "登录已过期" } });
        if (o.qshtyyApiError) return content({ result: { error: "api_error", code: 500, message: "系统繁忙" } });
        const mq = code.match(/const Q = ("(?:[^"\\]|\\.)*");/);
        let kw = "";
        if (mq) { try { kw = JSON.parse(mq[1]); } catch (e) { kw = ""; } }
        const ml = code.match(/const LIMIT = (\d+);/);
        const limit = ml ? +ml[1] : 100;
        const rows = qshtyyRowsFor(kw, limit);
        const total = o.qshtyyTotal != null ? o.qshtyyTotal : rows.length;
        return content({ result: { total, items: rows } });
      }

      // 1) 字体解码: 返回当前页 60 条
      if (code.indexOf("ysb-din-bold") >= 0) {
        /*
         * shortOnce: 模拟「某个标签打开某页后只渲染出半页卡片」(真机: 冷启动开 page=2 的
         * 窗口先渲第 1 页再切换, 切换途中停在 11 张, 之后不再增长)。
         * 粒度是「标签」而不是「第几次读取」—— 停住就是一直停住, 再多读几次也不会补齐;
         * 换一个标签(降级后的串行重取)才会拿到完整一页。
         */
        const list = itemsFor(tab.page, tab.keyword);
        const items = tab.short ? list.slice(0, tab.short) : list;
        return content({
          result: {
            hasList: true, page: tab.page, total: TOTAL, ready: "complete",
            bodyLen: 5000, needLogin: false, count: items.length, items,
          },
        });
      }
      // 1.5) 轻量页码探针(PAGE_JS): 只读 hash 里的 page, 不碰 DOM
      //      真机上这一步会在 SPA 应用路由之前读到上一页, 所以支持 pageApplyDelay 模拟
      //      「前 N 次读到旧页码」, 用来验证 host 的短轮询是否等得住。
      if (code.indexOf("location.hash") >= 0 && code.indexOf("searchkey=") < 0 && code.indexOf("all-goods-wrapper") < 0) {
        tab.pageReads++;
        const stale = o.pageApplyDelay && tab.pageReads <= o.pageApplyDelay;
        return content({ result: { page: stale ? 1 : tab.page, vcode: false } });
      }
      // 2) 页面状态探针
      if (code.indexOf("all-goods-wrapper") >= 0 && code.indexOf("vcode") >= 0) {
        let q = "";
        const m = code.match(/const Q = ("(?:[^"\\]|\\.)*")/);
        if (m) { try { q = JSON.parse(m[1]); } catch (e) { q = ""; } }
        return content({ result: statFor(tab, q) });
      }
      // 3) 关键词是否已切到位
      if (code.indexOf("h.indexOf(") >= 0 && code.indexOf("searchkey=") >= 0) {
        const m = code.match(/searchkey=([^"]*)"/);
        const target = m ? m[1] : "";
        return content({ result: { ok: tab.keyword === target } });
      }
      // 4) 翻页
      if (code.indexOf("pagination-next") >= 0) {
        const nextPage = tab.page + 1;
        if (nextPage > Math.ceil(TOTAL / PAGE_SIZE)) return content({ result: { ok: false, why: "disabled" } });
        tab.page = nextPage;
        tab.fh++;
        return content({ result: { ok: true } });
      }
      if (code.indexOf("pagination-prev") >= 0) {
        if (tab.page <= 1) return content({ result: { ok: false, why: "disabled" } });
        tab.page -= 1;
        tab.fh++;
        return content({ result: { ok: true } });
      }
      // 5) 走入框打字: 统一失败, 让上层退回 URL 导航(测试只关心导航路径)
      if (code.indexOf("input.searchKey") >= 0) return content({ result: { ok: false, why: "no-input" } });
      // 6) 其余(滚动/点击排序等)一律当成功
      return content({ result: { ok: true } });
    }

    throw new Error("fake-browser 未实现的工具: " + name);
  }

  nm.callTool = callTool;
  return {
    stats,
    tabs,
    callTool,
    // 预置一个已存在的标签(模拟用户自己开着的药师帮搜索页), 用于验证标签复用/抢占
    seed: (url) => mkTab(url, null),
  };
}

module.exports = { install, PAGE_SIZE, TOTAL };
