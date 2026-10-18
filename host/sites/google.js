"use strict";
/*
 * 站点: 谷歌搜索
 *
 * 完整高级查询参数(请求参数 > 扩展设置页默认 > 内置默认):
 *   q          基础查询词, 可含操作符(site: intitle: inurl: intext: filetype: link: "-词" "精确短语" OR)
 *   site       限定站点(可重复/逗号分隔)      -> site:xxx
 *   intitle    标题必须包含(可重复/逗号分隔)   -> intitle:xxx
 *   inurl      URL 必须包含(可重复/逗号分隔)   -> inurl:xxx
 *   intext     正文必须包含(可重复/逗号分隔)   -> intext:xxx
 *   filetype   文件类型: pdf/doc/docx/xls/xlsx/ppt/pptx/txt/rtf -> filetype:pdf
 *   link       链接到某 URL 的网页            -> link:xxx
 *   exact      精确短语                        -> "xxx"
 *   exclude    排除词(可重复/逗号分隔)         -> -xxx
 *   or         或关键词(可重复/逗号分隔)       -> (a OR b)
 *   num        每页条数: 10/20/30/50/100
 *   page       页码(1 起)                      -> start=(page-1)*num
 *   start      起始偏移(请求显式提供时覆盖 page) -> start=<n>
 *   time       时间范围: hour/day/week/month/year -> tbs=qdr:h/d/w/m/y
 *   after      起始日期(YYYY-MM-DD)            -> tbs=cdr:1,cd_min:M/D/YYYY
 *   before     截止日期(YYYY-MM-DD)            -> tbs=...,cd_max:M/D/YYYY
 *   hl         界面语言(默认 zh-CN)            -> hl=zh-CN
 *   gl         国家/地区代码(如 cn/us/jp)      -> gl=us
 *   lr         限定语言(如 lang_zh-CN)         -> lr=lang_zh-CN
 *   cr         限定国家(如 countryCN)          -> cr=countryCN
 *   safe       安全搜索: off/active
 *   tbm        垂直搜索: ""(网页)/nws(新闻)/isch(图片)/vid(视频) —— 结构化提取以网页/新闻为准
 *   nfpr       关闭拼写纠错(true -> nfpr=1)
 *   verbatim   逐字匹配, 不做同义词扩展(true -> tbs=li:1)
 *   resolve_urls  把 /url?q= 与 /aclk?url= 等跳转链接解析为真实 URL(先本地解参数, 再 302 兜底; 并发 8, 失败保留原链接)
 */
const { createDefaultsStore } = require("../lib/defaults");
const {
  openPage, closePage, needsHuman, extractSerp, decodeUrlCodes, resolveLinks,
  toSearchParams, paramList, truthy, strList,
} = require("../lib/util");

const SEARCH_URL = "https://www.google.com/search";
const NUMS = [10, 20, 30, 50, 100];
const TIMES = { hour: "h", day: "d", week: "w", month: "m", year: "y" };
const FILETYPES = ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf"];
const SAFE = ["", "off", "active"];
const TBM = ["", "nws", "isch", "vid"];

const defaults = createDefaultsStore({
  id: "google",
  file: "google-defaults.json",
  builtin: {
    num: 20, page: 1, time: "", after: "", before: "",
    hl: "zh-CN", gl: "", lr: "", cr: "", safe: "", tbm: "",
    nfpr: false, verbatim: false, resolve_urls: false,
  },
  sanitize(input) {
    const out = {};
    if (!input || typeof input !== "object") return out;
    const site = strList(input.site); if (site.length) out.site = site;
    const intitle = strList(input.intitle); if (intitle.length) out.intitle = intitle;
    const inurl = strList(input.inurl); if (inurl.length) out.inurl = inurl;
    const intext = strList(input.intext); if (intext.length) out.intext = intext;
    const exclude = strList(input.exclude); if (exclude.length) out.exclude = exclude;
    const or = strList(input.or); if (or.length) out.or = or;
    const exact = String(input.exact == null ? "" : input.exact).trim(); if (exact) out.exact = exact;
    const filetype = String(input.filetype == null ? "" : input.filetype).trim().toLowerCase();
    if (FILETYPES.includes(filetype)) out.filetype = filetype;
    const link = String(input.link == null ? "" : input.link).trim(); if (link) out.link = link;
    const num = parseInt(input.num, 10);
    if (Number.isFinite(num) && NUMS.includes(num)) out.num = num;
    const page = parseInt(input.page, 10);
    if (Number.isFinite(page) && page >= 1 && page <= 100) out.page = page;
    const time = String(input.time == null ? "" : input.time).trim().toLowerCase();
    if (TIMES[time]) out.time = time;
    const after = String(input.after == null ? "" : input.after).trim();
    if (after) { dateToUs(after); out.after = after; }
    const before = String(input.before == null ? "" : input.before).trim();
    if (before) { dateToUs(before); out.before = before; }
    const hl = String(input.hl == null ? "" : input.hl).trim(); if (hl) out.hl = hl;
    const gl = String(input.gl == null ? "" : input.gl).trim().toLowerCase();
    if (/^[a-z]{2}$/.test(gl)) out.gl = gl;
    const lr = String(input.lr == null ? "" : input.lr).trim();
    if (/^lang_[a-z]{2}(-[a-z]{2,4})?$/i.test(lr)) out.lr = lr;
    const cr = String(input.cr == null ? "" : input.cr).trim();
    if (/^country[a-z]{2}$/i.test(cr)) out.cr = cr;
    const safe = String(input.safe == null ? "" : input.safe).trim().toLowerCase();
    if (SAFE.includes(safe) && safe) out.safe = safe;
    const tbm = String(input.tbm == null ? "" : input.tbm).trim().toLowerCase();
    if (TBM.includes(tbm) && tbm) out.tbm = tbm;
    if (input.nfpr === true || input.nfpr === "true" || input.nfpr === 1) out.nfpr = true;
    if (input.verbatim === true || input.verbatim === "true" || input.verbatim === 1) out.verbatim = true;
    if (input.resolve_urls === true || input.resolve_urls === "true" || input.resolve_urls === 1) out.resolve_urls = true;
    return out;
  },
});

// 自定义日期区间用美式 M/D/YYYY(谷歌 tbs=cdr:1,cd_min:...,cd_max:...)
function dateToUs(v) {
  const m = String(v || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error(`invalid date(需 YYYY-MM-DD): ${v}`);
  const mo = Number(m[2]), d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) throw new Error(`invalid date(月份/日期越界): ${v}`);
  return `${mo}/${d}/${Number(m[1])}`;
}

function parseRequest(input) {
  const sp = toSearchParams(input);
  const eff = defaults.effective();
  const p = {
    q: (sp.get("q") || "").trim(),
    site: paramList(sp, "site"),
    intitle: paramList(sp, "intitle"),
    inurl: paramList(sp, "inurl"),
    intext: paramList(sp, "intext"),
    exclude: paramList(sp, "exclude"),
    or: paramList(sp, "or"),
    exact: (sp.get("exact") || "").trim(),
    filetype: (sp.get("filetype") || "").trim().toLowerCase(),
    link: (sp.get("link") || "").trim(),
    num: sp.get("num") ? parseInt(sp.get("num"), 10) : eff.num,
    page: sp.get("page") ? parseInt(sp.get("page"), 10) : eff.page,
    start: sp.get("start") ? parseInt(sp.get("start"), 10) : 0,
    time: (sp.get("time") || "").trim().toLowerCase() || eff.time,
    after: (sp.get("after") || "").trim() || eff.after,
    before: (sp.get("before") || "").trim() || eff.before,
    hl: (sp.get("hl") || "").trim() || eff.hl,
    gl: (sp.get("gl") || "").trim().toLowerCase() || eff.gl,
    lr: (sp.get("lr") || "").trim() || eff.lr,
    cr: (sp.get("cr") || "").trim() || eff.cr,
    safe: (sp.get("safe") || "").trim().toLowerCase() || eff.safe,
    tbm: (sp.get("tbm") || "").trim().toLowerCase() || eff.tbm,
    nfpr: sp.get("nfpr") ? truthy(sp.get("nfpr")) : eff.nfpr,
    verbatim: sp.get("verbatim") ? truthy(sp.get("verbatim")) : eff.verbatim,
    resolve_urls: sp.get("resolve_urls") ? truthy(sp.get("resolve_urls")) : eff.resolve_urls,
  };
  // 列表/文本字段整体回退到扩展默认(不叠加)
  if (!p.site.length && eff.site) p.site = [...eff.site];
  if (!p.intitle.length && eff.intitle) p.intitle = [...eff.intitle];
  if (!p.inurl.length && eff.inurl) p.inurl = [...eff.inurl];
  if (!p.intext.length && eff.intext) p.intext = [...eff.intext];
  if (!p.exclude.length && eff.exclude) p.exclude = [...eff.exclude];
  if (!p.or.length && eff.or) p.or = [...eff.or];
  if (!p.exact && eff.exact) p.exact = eff.exact;
  if (!p.filetype && eff.filetype) p.filetype = eff.filetype;
  if (!p.link && eff.link) p.link = eff.link;
  if (!NUMS.includes(p.num)) p.num = eff.num;
  if (!Number.isFinite(p.page) || p.page < 1 || p.page > 100) p.page = eff.page;
  if (!Number.isFinite(p.start) || p.start < 0 || p.start > 900) p.start = 0;
  if (!TIMES[p.time]) p.time = "";
  if (p.after) dateToUs(p.after);
  if (p.before) dateToUs(p.before);
  if (p.after && p.before && p.after > p.before) {
    throw new Error(`after(${p.after}) 晚于 before(${p.before}), 日期区间为空`);
  }
  if (p.gl && !/^[a-z]{2}$/.test(p.gl)) p.gl = "";
  if (p.lr && !/^lang_[a-z]{2}(-[a-z]{2,4})?$/i.test(p.lr)) p.lr = "";
  if (p.cr && !/^country[a-z]{2}$/i.test(p.cr)) p.cr = "";
  if (!SAFE.includes(p.safe)) p.safe = "";
  if (!TBM.includes(p.tbm)) p.tbm = "";
  return p;
}

function buildUrl(p) {
  const parts = [];
  if (p.q) parts.push(p.q);
  (p.site || []).forEach((s) => parts.push(`site:${s}`));
  (p.intitle || []).forEach((t) => parts.push(`intitle:${t}`));
  (p.inurl || []).forEach((u) => parts.push(`inurl:${u}`));
  (p.intext || []).forEach((t) => parts.push(`intext:${t}`));
  if (p.filetype) parts.push(`filetype:${p.filetype}`);
  if (p.link) parts.push(`link:${p.link}`);
  if (p.exact) parts.push(`"${p.exact}"`);
  if ((p.or || []).length) parts.push(`(${p.or.join(" OR ")})`);
  (p.exclude || []).forEach((x) => parts.push(`-${x}`));
  const q = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!q) throw new Error("empty query: 至少提供 q / site / intitle / inurl / intext / filetype / exact / link / or 之一");
  const params = new URLSearchParams();
  params.set("q", q);
  params.set("num", String(p.num));
  params.set("hl", p.hl || "zh-CN");
  params.set("ie", "UTF-8");
  params.set("oe", "UTF-8");
  if (p.gl) params.set("gl", p.gl);
  if (p.lr) params.set("lr", p.lr);
  if (p.cr) params.set("cr", p.cr);
  if (p.safe) params.set("safe", p.safe);
  if (p.tbm) params.set("tbm", p.tbm);
  if (p.nfpr) params.set("nfpr", "1");
  const start = p.start > 0 ? p.start : (p.page - 1) * p.num; // 显式 start 覆盖 page 推导
  if (start > 0) params.set("start", String(start));
  const tbs = [];
  if (p.time && TIMES[p.time]) tbs.push(`qdr:${TIMES[p.time]}`);
  if (p.after || p.before) {
    tbs.push("cdr:1");
    if (p.after) tbs.push(`cd_min:${dateToUs(p.after)}`);
    if (p.before) tbs.push(`cd_max:${dateToUs(p.before)}`);
  }
  if (p.verbatim) tbs.push("li:1");
  if (tbs.length) params.set("tbs", tbs.join(","));
  return { q, start, url: `${SEARCH_URL}?${params.toString()}` };
}

/*
 * SERP 结构实证(2026-10, Chromium 实测; Edge/Chrome 结构一致):
 *   自然结果在 #rso 顶层 div 块里, 每块有一个 h3 所在的 a[href^=http];
 *   广告块带 data-text-ad 属性或位于 #tads/#bottomads, 块内含 Sponsored/赞助 标记;
 *   相关搜索/大家还会问/反馈等噪音块没有 h3 外链, 天然被排除。
 *   块内 innerText 行序实证: 垂直标签("Web results"/"網頁搜尋結果") -> 标题(可能重复, 且带
 *   LRM 方向控制字符) -> 来源名 -> 展示 URL(面包屑行含 › 或裸 http 面行) -> 孤立 "·" ->
 *   "翻译此页" -> 日期+摘要行, 日期一律在行首("4天前 — xxx" / "2026年10月1日 — xxx")。
 */
const EXTRACT_JS = `
const enc=(s)=>{const out=[];for(let i=0;i<s.length;i++)out.push(s.charCodeAt(i));return out;};
let boxes=[...document.querySelectorAll('#rso > div')];
if(!boxes.length) boxes=[...document.querySelectorAll('#center_col > div')];
const noiseRe=/^(Sponsored|赞助|广告|相关搜索|大家还会问|人们还会问|关于此结果|反馈|查看更多|展开全部|收起|翻译此页|Translate this page|Web results|Images|Videos|News|Books|Shopping|網頁搜尋結果)$/i;
const crumbRe=/›/;                  // 展示 URL 面包屑行 "github.com › 路径", 不是摘要
const bareUrlRe=/^https?:\\/\\/\\S+$/i;   // 展示 URL 面行 "https://gemini.google.com"
const sepOnlyRe=/^[·•|]+$/;         // 孤立分隔符行
// 日期: 可能是独立行, 也可能是摘要行开头(实证格式 "4天前 — xxx" / "2026年10月1日 — xxx" / "Oct 10, 2026 — xxx")
// 行首锚定 + 连带尾部破折号一起剥离
const lineDateRe=/^(\\d{4}年\\d{1,2}月\\d{1,2}日|\\d{4}-\\d{2}-\\d{2}|\\d{1,2}\\s*(?:分钟|小时|天)前|昨天|前天|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\\.?\\s+\\d{1,2},?\\s*\\d{4})\\s*(?:—|–|-|·)?\\s*/;
const items=[];const seen=new Set();
boxes.forEach(e=>{
  if(e.hasAttribute&&e.hasAttribute('data-text-ad')) return;      // 文字广告块
  if(e.closest&&e.closest('#tads,#bottomads')) return;            // 顶部/底部广告容器
  const h3=e.querySelector('a h3');
  const a=h3?h3.closest('a'):null;
  if(!a) return;                                                  // 无 h3 外链的块(相关搜索/PAA 等噪音)
  const raw=(a.getAttribute('href')||'').trim();
  if(!/^https?:\\/\\//.test(raw)||seen.has(raw)) return;
  seen.add(raw);
  // 标题里可能带 LRM/RLM 等方向控制字符(谷歌渲染 innerText 时插入), 剥掉;
  // 行分割时同样剥离, 保证标题行与 title 变量能相等比对(否则标题行会漏进摘要)
  const title=(h3.innerText||'').replace(/[\\u200e\\u200f\\u202a-\\u202e]/g,'').replace(/\\s+/g,' ').trim();
  if(!title) return;
  const lines=(e.innerText||'').split('\\n').map(s=>s.replace(/[\\u200e\\u200f\\u202a-\\u202e]/g,'').trim()).filter(Boolean);
  const body=lines.filter(l=>l!==title&&!noiseRe.test(l)&&!crumbRe.test(l)&&!bareUrlRe.test(l)&&!sepOnlyRe.test(l));
  let date=null;
  for(let i=0;i<body.length;i++){
    const dm=body[i].match(lineDateRe);
    if(dm){date=dm[1];body[i]=body[i].slice(dm[0].length).trim();if(!body[i])body.splice(i,1);break;}
  }
  const txt=e.innerText||'';
  const adLine=lines.some(l=>/^(Sponsored|赞助|广告)$/.test(l));
  items.push({title:title,url_c:enc(raw),abstract:body.join(' ').slice(0,500),date:date,is_ad:adLine});
});
// 新闻垂直(tbm=nws)兜底: 文章在 div[data-news-cluster-id] 里且没有 h3(所以上面 0 条),
// 每个 cluster 的 a[href^=http] innerText 是 来源/标题/时间或摘要 两到三行。
// 只在网页提取全军覆没时启用, 避免误伤其它版式。
if(!items.length){
  [...document.querySelectorAll('div[data-news-cluster-id]')].forEach(c=>{
    const a=c.querySelector('a[href^="http"]');
    if(!a) return;
    const raw=(a.getAttribute('href')||'').trim();
    if(!/^https?:\\/\\//.test(raw)||seen.has(raw)) return;
    seen.add(raw);
    const ls=(a.innerText||'').split('\\n').map(s=>s.replace(/[\\u200e\\u200f\\u202a-\\u202e]/g,'').trim()).filter(Boolean);
    let date=null;const rest=[];
    for(const l of ls){
      const dm=l.match(lineDateRe);
      if(dm&&!date){date=dm[1];const left=l.slice(dm[0].length).trim();if(left)rest.push(left);}
      else rest.push(l);
    }
    if(!rest.length) return;
    const t=rest.length>1?rest[1]:rest[0];   // 第 0 行是来源, 第 1 行是标题
    if(!t) return;
    const abstract=rest.filter((l,i)=>i!==(rest.length>1?1:0)).join(' ').slice(0,500);
    items.push({title:t,url_c:enc(raw),abstract:abstract,date:date,is_ad:false});
  });
}
const statsEl=document.querySelector('#result-stats');
const stats=(statsEl&&statsEl.innerText)||'';
const totalM=stats.match(/([\\d,]+)\\s*条结果|About\\s+([\\d,]+)\\s+results/i);
const bodyTxt=document.body.innerText||'';
const sorry=/^\\/sorry\\//.test(location.pathname||'');
const blocked=/unusual traffic|异常流量|not a robot/i.test(bodyTxt);
const consent=/consent\\.google\\./.test(location.hostname||'');
const noResult=/did not match any documents|找不到|没有找到|未找到/.test(bodyTxt);
return {items:items,total:totalM?parseInt((totalM[1]||totalM[2]||'0').replace(/,/g,''),10):null,
  captcha:blocked||sorry,consent:consent,noResult:noResult,
  ready:document.readyState,hasRso:!!document.querySelector('#rso'),path:location.pathname,bodyLen:bodyTxt.length};
`;

// 谷歌跳转链接本地解析: /url?q=<target> 与 /aclk?url=<target> 不必发请求
function redirectTarget(link) {
  try {
    const u = new URL(link);
    if (/\/url$/.test(u.pathname)) {
      const q = u.searchParams.get("q");
      if (q && /^https?:\/\//.test(q)) return q;
    }
    if (/\/aclk$/.test(u.pathname)) {
      const q = u.searchParams.get("url") || u.searchParams.get("q");
      if (q && /^https?:\/\//.test(q)) return q;
    }
  } catch (e) { /* ignore */ }
  return null;
}

async function search(p) {
  const built = buildUrl(p);
  // 谷歌 SERP 渲染重: 后台标签会被 Chromium 调度节流, 实测 15s 才开始出结果、约 20s 完整
  // (前台窗口 5s)。也曾试过"独立窗口但不激活", 但 focused:false 的窗口一旦被判为遮挡,
  // renderer 同样被冻结(实测 20s 仍 bodyLen=0), 反而不如后台标签可预测。
  // 所以这里坚持后台标签(不弹窗), 只把等待上限放宽到 20 轮; 需要更快可在 config 设 page_mode=window-front。
  const page = await openPage(built.url);
  try {
    const raw = await extractSerp(page.tabId, EXTRACT_JS, {
      flag: "hasRso",
      label: "google",
      tries: 20,
      // 同意页/反爬验证: 把标签页切到前台让用户处理, 并保留页面(不自动关闭)
      guards: async (d) => {
        if (d && d.consent) await needsHuman(page, "谷歌返回 consent 同意页");
        if (d && d.captcha) await needsHuman(page, "谷歌反爬验证(unusual traffic)");
      },
      // 合法的零结果页: 不用再等 12 秒
      stopWhen: (d) => !!(d && d.noResult && !d.hasRso),
    });
    let items = (raw.items || []).map((it) => {
      let date = it.date || null;
      let abstract = it.abstract || "";
      // 日期常以 "2024年3月22日" / "Jan 1, 2024" / "3天前" 前缀嵌在摘要行首, 兜底提取并剥离
      if (!date) {
        const m = abstract.match(/^(\d{4}年\d{1,2}月\d{1,2}日|\d{4}-\d{2}-\d{2}|\d+\s*(?:分钟|小时|天)前|昨天|前天|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*\d{4})\s*[—\-:：]?\s*/i);
        if (m) { date = m[1]; abstract = abstract.slice(m[0].length); }
      }
      return { title: it.title || "", url: decodeUrlCodes(it.url_c), abstract, date, is_ad: !!it.is_ad };
    });
    if (p.resolve_urls) {
      items = await resolveLinks(items, {
        match: /^https?:\/\/(www\.)?google\.[a-z.]+\/(url|aclk)\?/i,
        local: redirectTarget,
      });
    }
    return {
      source: "google via web-to-openapi",
      fetched_at: new Date().toISOString(),
      query: built.q,
      page: Math.floor(built.start / p.num) + 1,
      num: p.num,
      start: built.start,
      time: p.time || null,
      after: p.after || null,
      before: p.before || null,
      total: raw.total != null ? raw.total : null,
      count: items.length,
      // page_loaded = 是否成功拿到结果(谷歌有长连接时 readyState 可能长期卡在 interactive,
      // 不能只信 DOM 标志; 拿到条目/零结果页都算加载成功)
      page_loaded: items.length > 0 || !!(raw && raw.noResult) || !!(raw && raw.ready === "complete" && raw.hasRso),
      no_result: !!(raw && raw.noResult), // true = 谷歌明确返回零结果页(与"页面没加载完"区分)
      items,
    };
  } finally {
    await closePage(page); // 正常关闭; 遇到需要人工介入时保留(见 needsHuman)
  }
}

module.exports = {
  id: "google",
  title: "谷歌搜索",
  defaults,
  endpoints: [
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/search/google",
      tool: "google_search",
      operationId: "googleSearch",
      summary: "谷歌搜索(完整高级查询参数)",
      description: "实时驱动浏览器(Edge / Chrome)打开谷歌搜索并解析结果。参数: q(基础词, 可含 site:/intitle:/inurl:/intext:/filetype:/link:/-排除/\"精确短语\"/OR); site/intitle/inurl/intext/exclude/or(可重复或逗号分隔); filetype(pdf/doc/docx/xls/xlsx/ppt/pptx/txt/rtf); exact(精确短语); link(链接页); num(10/20/30/50/100); page(页码); start(显式偏移, 覆盖 page); time(hour/day/week/month/year); after/before(YYYY-MM-DD 自定义日期区间); hl(界面语言); gl(国家); lr(限定语言, 如 lang_zh-CN); cr(限定国家, 如 countryCN); safe(off/active); tbm(网页/新闻 nws/图片 isch/视频 vid); nfpr(关闭纠错); verbatim(逐字匹配); resolve_urls(解析跳转链接)。合并顺序: 请求参数 > 扩展设置页默认(/api/v1/search/google/defaults 查看) > 内置默认。每次调用约 5-15 秒。",
      post: {
        operationId: "googleSearchPost",
        summary: "谷歌搜索(POST JSON body, 中文免 URL 编码)",
        description: "与 GET 完全相同的参数, 改为 JSON body 传递。列表参数直接传数组(如 site:[\"github.com\"])。推荐有中文查询词时使用本方式: GET 的查询串必须做 URL 编码, 未编码的中文会被 HTTP 协议层直接拒绝(400 Bad Request)。",
      },
      example: { q: "人工智能", site: ["github.com"], num: 10 },
      responses: { 200: { description: "搜索结果 JSON(items/total/count)" }, 400: { description: "参数为空或日期非法" }, 500: { description: "提取失败(consent/反爬验证/网络不通/页面结构变化)" } },
      browser: true,
      parse: parseRequest,
      run: (p) => search(p),
      doc: {
        note: "谷歌搜索(完整高级参数)。q 可含 <code>site:</code> <code>intitle:</code> <code>inurl:</code> <code>intext:</code> <code>filetype:</code> <code>link:</code> <code>-排除词</code> <code>\"精确短语\"</code> <code>OR</code>; 结构化参数 site/intitle/inurl/intext/filetype/exact/exclude/or/link(可重复或逗号分隔); num=每页条数(10~100), page=页码, start=显式偏移, time=hour/day/week/month/year, after/before=YYYY-MM-DD 自定义区间, hl/gl/lr/cr=语言地区, safe=off/active, tbm=新闻 nws/视频 vid, nfpr=关闭纠错, verbatim=逐字匹配, resolve_urls=true 解析真实 URL。约 5-15 秒。",
        tryQuery: "/api/v1/search/google?q=transformer&site=github.com&num=10",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/search/google?q=AI&intitle=tutorial&filetype=pdf&time=week&num=20&page=1&resolve_urls=true"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/search/google \\
  -H "Content-Type: application/json" \\
  -d '{"q":"人工智能","site":["github.com"],"num":10,"time":"week"}'`,
        postNote: "同上, JSON body 传参。<b>中文查询词推荐用这个</b>——body 里的中文不需要 URL 编码, 数组参数直接传 <code>site:[\"github.com\"]</code>。",
        slow: true,
      },
    },
    {
      method: "GET",
      path: "/api/v1/search/google/defaults",
      operationId: "googleSearchDefaults",
      summary: "查看谷歌搜索当前生效的默认参数",
      description: "返回 builtin(内置默认) / extension(扩展设置页下发) / effective(最终生效) 三层。",
      responses: { 200: { description: "默认参数 JSON" } },
      run: () => ({ builtin: defaults.builtin, extension: defaults.get(), effective: defaults.effective() }),
      doc: {
        note: "查看谷歌搜索默认参数(内置 / 扩展设置页下发 / 最终生效)。在插件设置页配置默认参数后, 未显式传参的请求会自动套用。",
      },
    },
  ],
  tools: [
    {
      name: "google_search",
      description: "谷歌搜索(实时驱动浏览器打开 SERP 解析, 约 5-15 秒)。q 为基础查询词, 可含 site:/intitle:/inurl:/intext:/filetype:/link: 操作符、-排除词、\"精确短语\"、OR; 也可用结构化参数(列表参数传数组如 site:[\"github.com\"], 也接受逗号分隔字符串)。time 支持 hour/day/week/month/year; after/before 传 YYYY-MM-DD 自定义区间; hl/gl/lr/cr 控制语言地区; tbm=nws/isch/vid 切换新闻/图片/视频垂直; nfpr=true 关闭拼写纠错; verbatim=true 逐字匹配; resolve_urls=true 把谷歌跳转链接解析为真实 URL。中文查询词直接传(MCP 无 URL 编码问题)。参数优先级: 请求显式参数 > 扩展设置页默认 > 内置默认。",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "基础查询词(可含高级操作符)。可单独使用, 也可与结构化参数组合" },
          site: { type: "array", items: { type: "string" }, description: "限定站点(可多个) -> site:github.com(数组或逗号分隔字符串)" },
          intitle: { type: "array", items: { type: "string" }, description: "标题必须包含(可多个) -> intitle:tutorial" },
          inurl: { type: "array", items: { type: "string" }, description: "URL 必须包含(可多个) -> inurl:docs" },
          intext: { type: "array", items: { type: "string" }, description: "正文必须包含(可多个) -> intext:安装" },
          filetype: { type: "string", enum: ["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf"], description: "文件类型 -> filetype:pdf" },
          exact: { type: "string", description: "精确短语(整体匹配) -> \"xxx\"" },
          exclude: { type: "array", items: { type: "string" }, description: "排除词(可多个) -> -xxx" },
          or: { type: "array", items: { type: "string" }, description: "或关键词(可多个) -> (a OR b)" },
          link: { type: "string", description: "链接到指定 URL 的网页 -> link:example.com" },
          num: { type: "integer", enum: [10, 20, 30, 50, 100], description: "每页条数(默认 20, 非法值回退默认)" },
          page: { type: "integer", minimum: 1, description: "页码(1 起, 默认 1)。与 start 二选一, 同时提供时 start 优先" },
          start: { type: "integer", minimum: 0, description: "起始结果偏移(0~900, 显式提供时覆盖 page 推导的偏移)" },
          time: { type: "string", enum: ["hour", "day", "week", "month", "year"], description: "时间范围(默认不限)" },
          after: { type: "string", description: "自定义区间起始日期 YYYY-MM-DD(与 before 搭配使用)" },
          before: { type: "string", description: "自定义区间截止日期 YYYY-MM-DD(与 after 搭配使用)" },
          hl: { type: "string", description: "界面语言(如 zh-CN/en, 默认 zh-CN)" },
          gl: { type: "string", description: "国家/地区(两位字母, 如 cn/us)" },
          lr: { type: "string", description: "限定结果语言(如 lang_zh-CN/lang_en)" },
          cr: { type: "string", description: "限定结果国家(如 countryCN)" },
          safe: { type: "string", enum: ["off", "active"], description: "安全搜索(默认关闭)" },
          tbm: { type: "string", enum: ["nws", "isch", "vid"], description: "垂直搜索: nws=新闻 isch=图片 vid=视频(空=网页)" },
          nfpr: { type: "boolean", description: "关闭拼写纠错(默认 false)" },
          verbatim: { type: "boolean", description: "逐字匹配(禁用同义词扩展, 默认 false)" },
          resolve_urls: { type: "boolean", description: "把谷歌跳转链接解析为真实 URL(302 解析, 并发 8, 默认 false)" },
        },
      },
      browser: true,
      run: (args) => search(parseRequest(args || {})),
    },
    {
      name: "google_search_defaults",
      description: "查看谷歌搜索默认参数。返回三层: builtin(内置默认) / extension(扩展设置页下发, 持久化在本地) / effective(最终生效值)。修改默认参数请到扩展设置页, 本工具只读。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => ({ builtin: defaults.builtin, extension: defaults.get(), effective: defaults.effective() }),
    },
  ],
};
