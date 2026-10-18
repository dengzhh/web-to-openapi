"use strict";
/*
 * 站点: 百度搜索
 *
 * 完整高级查询参数(请求参数 > 扩展设置页默认 > 内置默认):
 *   q          基础查询词, 可含操作符(site: intitle: inurl: filetype: "-词" "精确短语")
 *   site       限定站点(可重复/逗号分隔)      -> site:xxx
 *   intitle    标题必须包含(可重复/逗号分隔)   -> intitle:xxx
 *   inurl      URL 必须包含(可重复/逗号分隔)   -> inurl:xxx
 *   filetype   文件类型: pdf/doc/xls/ppt/rtf  -> filetype:pdf
 *   exact      精确短语                        -> "xxx"
 *   exclude    排除词(可重复/逗号分隔)         -> -xxx
 *   rn         每页条数: 10/20/30/40/50/100
 *   page       页码(1 起)                      -> pn=(page-1)*rn
 *   time       时间范围: day/week/month/year   -> gpc=stf=<start>,<now>|stftype=1
 *              (实测该参数会点亮 SERP 上的"一天内/一周内..."时间筛选片)
 *   resolve_urls  是否把百度跳转链接解析为真实 URL(302 约 90ms/条, 并发 8, 失败保留原链接)
 */
const { createDefaultsStore } = require("../lib/defaults");
const {
  openPage, closePage, needsHuman, jsEval, extractSerp, decodeUrlCodes, resolveLinks,
  toSearchParams, paramList, truthy,
} = require("../lib/util");

const SEARCH_URL = "https://www.baidu.com/s";
const TIME_SPANS = {
  h: 86400, d: 86400, "1d": 86400, day: 86400,
  w: 604800, "1w": 604800, week: 604800,
  m: 2592000, "1m": 2592000, month: 2592000,
  y: 31536000, "1y": 31536000, year: 31536000,
};
const FILETYPES = ["pdf", "doc", "xls", "ppt", "rtf"];
const RN_VALUES = [10, 20, 30, 40, 50, 100];

const defaults = createDefaultsStore({
  id: "baidu",
  file: "baidu-defaults.json",
  builtin: { rn: 50, page: 1, time: "", resolve_urls: false },
  sanitize(input) {
    const out = {};
    if (!input || typeof input !== "object") return out;
    const str = (v) => String(v == null ? "" : v).trim();
    const strList = (v) => (Array.isArray(v) ? v : String(v == null ? "" : v).split(/[,，]/)).map(str).filter(Boolean);
    const site = strList(input.site); if (site.length) out.site = site;
    const intitle = strList(input.intitle); if (intitle.length) out.intitle = intitle;
    const inurl = strList(input.inurl); if (inurl.length) out.inurl = inurl;
    const filetype = str(input.filetype).toLowerCase();
    if (FILETYPES.includes(filetype)) out.filetype = filetype;
    const exact = str(input.exact); if (exact) out.exact = exact;
    const exclude = strList(input.exclude); if (exclude.length) out.exclude = exclude;
    const rn = parseInt(input.rn, 10);
    if (Number.isFinite(rn) && RN_VALUES.includes(rn)) out.rn = rn;
    const page = parseInt(input.page, 10);
    if (Number.isFinite(page) && page >= 1 && page <= 100) out.page = page;
    const time = str(input.time).toLowerCase();
    if (TIME_SPANS[time]) out.time = time;
    if (input.resolve_urls === true || input.resolve_urls === "true" || input.resolve_urls === 1) out.resolve_urls = true;
    return out;
  },
});

// 请求查询串(GET)或 JSON 对象(POST) + 存储默认 -> 最终生效参数
// 请求显式提供的字段整体覆盖默认; 未提供则回退到扩展默认
function parseRequest(input) {
  const sp = toSearchParams(input);
  const eff = defaults.effective();
  const p = {
    q: (sp.get("q") || "").trim(),
    site: paramList(sp, "site"),
    intitle: paramList(sp, "intitle"),
    inurl: paramList(sp, "inurl"),
    exclude: paramList(sp, "exclude"),
    exact: (sp.get("exact") || "").trim(),
    filetype: (sp.get("filetype") || "").trim().toLowerCase(),
    rn: sp.get("rn") ? parseInt(sp.get("rn"), 10) : eff.rn,
    page: sp.get("page") ? parseInt(sp.get("page"), 10) : eff.page,
    time: (sp.get("time") || "").trim().toLowerCase() || eff.time,
    resolve_urls: sp.get("resolve_urls") ? truthy(sp.get("resolve_urls")) : eff.resolve_urls,
  };
  if (!p.site.length && eff.site) p.site = [...eff.site];
  if (!p.intitle.length && eff.intitle) p.intitle = [...eff.intitle];
  if (!p.inurl.length && eff.inurl) p.inurl = [...eff.inurl];
  if (!p.exclude.length && eff.exclude) p.exclude = [...eff.exclude];
  if (!p.exact && eff.exact) p.exact = eff.exact;
  if (!p.filetype && eff.filetype) p.filetype = eff.filetype;
  if (!Number.isFinite(p.rn) || !RN_VALUES.includes(p.rn)) p.rn = eff.rn;
  if (!Number.isFinite(p.page) || p.page < 1 || p.page > 100) p.page = eff.page;
  if (!TIME_SPANS[p.time]) p.time = "";
  return p;
}

function buildUrl(p) {
  const parts = [];
  if (p.q) parts.push(p.q);
  (p.site || []).forEach((s) => parts.push(`site:${s}`));
  (p.intitle || []).forEach((t) => parts.push(`intitle:${t}`));
  (p.inurl || []).forEach((u) => parts.push(`inurl:${u}`));
  if (p.filetype) parts.push(`filetype:${p.filetype}`);
  if (p.exact) parts.push(`"${p.exact}"`);
  (p.exclude || []).forEach((x) => parts.push(`-${x}`));
  const wd = parts.join(" ").trim();
  if (!wd) throw new Error("empty query: 至少提供 q / site / intitle / inurl / filetype / exact 之一");
  const params = new URLSearchParams();
  params.set("ie", "utf-8");
  params.set("rn", String(p.rn));
  params.set("pn", String((p.page - 1) * p.rn));
  params.set("wd", wd);
  if (p.time && TIME_SPANS[p.time]) {
    const now = Math.floor(Date.now() / 1000);
    params.set("gpc", `stf=${now - TIME_SPANS[p.time]},${now}|stftype=1`);
  }
  return { wd, url: `${SEARCH_URL}?${params.toString()}` };
}

// SERP 提取: 取 #content_left(或 #container)直接子容器里带 h3 a[href^=http] 的条目。
// 不能用 .result:not(.result-op) 过滤 —— 实测百科/翻译等自然结果也带 result-op 类, 会漏一半;
// 而热搜榜/相关搜索/用户反馈等噪音都没有 h3 外链, 天然被排除。类名被混淆, 摘要用文本兜底。
const EXTRACT_JS = `
const enc=(s)=>{const out=[];for(let i=0;i<s.length;i++)out.push(s.charCodeAt(i));return out;};
let boxes=[...document.querySelectorAll('#content_left > div')];
if(!boxes.length) boxes=[...document.querySelectorAll('#container > div')];
const noiseRe=/^(翻译此页|查看此网页|百度快照|举报|相关搜索|换一换|为您推荐|查看更多|展开全部|收起|广告)/;
const dateRe=/^(\\d{4})年(\\d{1,2})月(\\d{1,2})日$/;
const relDateRe=/^(\\d+)\\s*(分钟|小时|天)前$|^昨天$|^前天$/;
const items=[];const seen=new Set();
boxes.forEach(e=>{
  const a=e.querySelector('h3 a[href^="http"]');
  if(!a) return;
  const href=(a.getAttribute('href')||'').trim();
  if(!/^https?:\\/\\//.test(href)||seen.has(href)) return;
  seen.add(href);
  const h3=e.querySelector('h3');
  const title=(h3?h3.innerText:(a.innerText||'')).trim();
  if(!title) return;
  const lines=(e.innerText||'').split('\\n').map(s=>s.trim()).filter(Boolean);
  const body=lines.slice(1).filter(l=>l!==title&&!noiseRe.test(l));
  let date=null;
  for(let i=0;i<body.length;i++){
    if(dateRe.test(body[i])||relDateRe.test(body[i])){date=body[i];body.splice(i,1);break;}
  }
  items.push({title:title,url_c:enc(href),abstract:body.join(' ').slice(0,500),date:date,
    is_ad:[...e.querySelectorAll('span,div,em,a')].some(x=>(x.innerText||'').trim()==='广告')||/baidu\\.php\\?/i.test(href)});
});
const totalM=(document.body.innerText||'').match(/找到相关结果[约]?\\s*([\\d,]+)/);
const captcha=/百度安全验证|安全验证|点击图中字符|操作太频繁/.test(document.body.innerText||'');
return {items:items,total:totalM?parseInt(totalM[1].replace(/,/g,''),10):null,captcha:captcha,
  ready:document.readyState,hasLeft:!!document.querySelector('#content_left'),bodyLen:(document.body.innerText||'').length};
`;

async function search(p) {
  const built = buildUrl(p);
  const page = await openPage(built.url);
  try {
    const raw = await extractSerp(page.tabId, EXTRACT_JS, {
      flag: "hasLeft",
      label: "baidu",
      guards: async (d) => {
        // 反爬验证页: 把标签页切到前台让用户过验证, 并保留页面(不自动关闭)
        if (d && d.captcha) await needsHuman(page, "百度安全验证(反爬)");
      },
    });
    let items = (raw.items || []).map((it) => {
      let date = it.date || null;
      let abstract = it.abstract || "";
      // 日期常以 "2024年3月22日" / "3天前" 前缀嵌在摘要行首, 兜底提取并剥离
      if (!date) {
        const m = abstract.match(/^(\d{4}年\d{1,2}月\d{1,2}日|\d+\s*(?:分钟|小时|天)前|昨天|前天)\s*/);
        if (m) { date = m[1]; abstract = abstract.slice(m[0].length); }
      }
      return { title: it.title || "", url: decodeUrlCodes(it.url_c), abstract, date, is_ad: !!it.is_ad };
    });
    if (p.resolve_urls) {
      items = await resolveLinks(items, { match: /^https?:\/\/(www\.)?baidu\.com\/link\?/i });
    }
    return {
      source: "baidu via web-to-openapi",
      fetched_at: new Date().toISOString(),
      query: built.wd,
      page: p.page,
      rn: p.rn,
      time: p.time || null,
      total: raw.total != null ? raw.total : null,
      count: items.length,
      items,
    };
  } finally {
    await closePage(page); // 正常关闭; 遇到需要人工介入时保留(见 needsHuman)
  }
}

module.exports = {
  id: "baidu",
  title: "百度搜索",
  defaults,
  endpoints: [
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/search/baidu",
      tool: "baidu_search",
      operationId: "baiduSearch",
      summary: "百度搜索(完整高级查询参数)",
      description: "实时驱动浏览器(Edge / Chrome)打开百度搜索并解析结果。参数: q(基础词, 可含 site:/intitle:/inurl:/filetype:/-排除/\"精确短语\"); site/intitle/inurl/exclude(可重复或逗号分隔); filetype(pdf/doc/xls/ppt/rtf); exact(精确短语); rn(10/20/30/40/50/100); page(页码); time(day/week/month/year); resolve_urls(true 时把百度跳转链接解析为真实 URL)。合并顺序: 请求参数 > 扩展设置页默认(/api/v1/search/baidu/defaults 查看) > 内置默认。每次调用约 5-15 秒。",
      post: {
        operationId: "baiduSearchPost",
        summary: "百度搜索(POST JSON body, 中文免 URL 编码)",
        description: "与 GET 完全相同的参数, 改为 JSON body 传递。列表参数直接传数组(如 site:[\"a.com\",\"b.com\"])。推荐有中文查询词时使用本方式: GET 的查询串必须做 URL 编码, 未编码的中文会被 HTTP 协议层直接拒绝(400 Bad Request)。",
      },
      example: { q: "人工智能", site: ["zhihu.com"], rn: 10 },
      responses: { 200: { description: "搜索结果 JSON(items/total/count)" }, 400: { description: "参数为空" }, 500: { description: "提取失败(未登录/反爬验证/页面结构变化)" } },
      browser: true,
      parse: parseRequest,
      run: (p) => search(p),
      doc: {
        note: "百度搜索(完整高级参数)。q 可含 <code>site:</code> <code>intitle:</code> <code>inurl:</code> <code>filetype:</code> <code>-排除词</code> <code>\"精确短语\"</code>; 也可用结构化参数 site/intitle/inurl/filetype/exact/exclude(可重复或逗号分隔); rn=每页条数(10~100), page=页码, time=day/week/month/year, resolve_urls=true 解析真实 URL。约 5-15 秒。",
        tryQuery: "/api/v1/search/baidu?q=transformer&site=github.com&rn=10",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/search/baidu?q=AI&intitle=论文&filetype=pdf&time=week&rn=20&page=1&resolve_urls=true"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/search/baidu \\
  -H "Content-Type: application/json" \\
  -d '{"q":"人工智能","site":["zhihu.com"],"rn":10,"time":"week"}'`,
        postNote: "同上, JSON body 传参。<b>中文查询词推荐用这个</b>——body 里的中文不需要 URL 编码, 数组参数直接传 <code>site:[\"a.com\",\"b.com\"]</code>。",
        slow: true,
      },
    },
    {
      method: "GET",
      path: "/api/v1/search/baidu/defaults",
      operationId: "baiduSearchDefaults",
      summary: "查看百度搜索当前生效的默认参数",
      description: "返回 builtin(内置默认) / extension(扩展设置页下发) / effective(最终生效) 三层。",
      responses: { 200: { description: "默认参数 JSON" } },
      run: () => ({ builtin: defaults.builtin, extension: defaults.get(), effective: defaults.effective() }),
      doc: {
        note: "查看百度搜索默认参数(内置 / 扩展设置页下发 / 最终生效)。在插件设置页配置默认参数后, 未显式传参的请求会自动套用。",
      },
    },
  ],
  tools: [
    {
      name: "baidu_search",
      description: "百度搜索(实时驱动浏览器打开百度 SERP 解析, 约 5-15 秒)。q 为基础查询词, 可含 site:/intitle:/inurl:/filetype: 操作符、-排除词、\"精确短语\"; 也可用结构化参数(列表参数传数组如 site:[\"zhihu.com\"], 也接受逗号分隔字符串)。time 支持 day/week/month/year; resolve_urls=true 时把百度跳转链接解析为真实 URL。中文查询词直接传即可(MCP 无 URL 编码问题)。参数优先级: 请求显式参数 > 扩展设置页默认 > 内置默认。",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "基础查询词(可含高级操作符)。可单独使用, 也可与结构化参数组合" },
          site: { type: "array", items: { type: "string" }, description: "限定站点(可多个) -> site:zhihu.com(数组或逗号分隔字符串)" },
          intitle: { type: "array", items: { type: "string" }, description: "标题必须包含(可多个) -> intitle:教程" },
          inurl: { type: "array", items: { type: "string" }, description: "URL 必须包含(可多个) -> inurl:blog" },
          filetype: { type: "string", enum: ["pdf", "doc", "xls", "ppt", "rtf"], description: "文件类型 -> filetype:pdf" },
          exact: { type: "string", description: "精确短语(整体匹配) -> \"xxx\"" },
          exclude: { type: "array", items: { type: "string" }, description: "排除词(可多个) -> -xxx" },
          rn: { type: "integer", enum: [10, 20, 30, 40, 50, 100], description: "每页条数(默认 50, 非法值回退默认)" },
          page: { type: "integer", minimum: 1, description: "页码(1 起, 默认 1)" },
          time: { type: "string", enum: ["day", "week", "month", "year"], description: "时间范围(默认不限)" },
          resolve_urls: { type: "boolean", description: "把百度跳转链接解析为真实 URL(302 解析, 并发 8, 默认 false)" },
        },
      },
      browser: true,
      run: (args) => search(parseRequest(args || {})),
    },
    {
      name: "baidu_search_defaults",
      description: "查看百度搜索默认参数。返回三层: builtin(内置默认) / extension(扩展设置页下发, 持久化在本地) / effective(最终生效值)。修改默认参数请到扩展设置页, 本工具只读。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => ({ builtin: defaults.builtin, extension: defaults.get(), effective: defaults.effective() }),
    },
  ],
};
