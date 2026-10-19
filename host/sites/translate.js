"use strict";
/*
 * 站点: 在线翻译(统一入口 / 多引擎)
 *
 * 与"一个网页一个文件"的关系:
 *   本文件聚合"翻译"这一能力, 对外只有 /api/v1/translate, 用 engine 参数切换底层站点。
 *   加一个引擎 = 在下面 ENGINES 里加一项, 路由 / MCP 工具 / openapi.json / /docs 全部自动沿用。
 *   若某个引擎差异过大(例如需要注入文本、登录态), 也可以按常规做法单独建 sites/xxx.js。
 *
 * 参数:
 *   q       待翻译文本(必填, 上限 5000 字符 —— 百度网页版单次上限)
 *   from    源语言, 默认 auto(自动检测)
 *   to      目标语言, 默认 zh; 不接受 auto
 *   engine  引擎 id, 默认 baidu
 *   detail  是否附带词典/例句(默认 true; 不影响主流程, 解析失败只是返回空)
 *
 * from / to 的可选值由下面的 LANG_TABLE 定义(54 项, 每项都实测过), 并提供
 * GET /api/v1/translate/engines 查询; 文档页会渲染成折叠表格。
 *
 * 一层薄抽象: 每个引擎只负责 "把参数拼成 URL -> 打开 -> 等译文稳定 -> 归一化返回",
 * 返回结构统一为 { translation, segments, from_label, to_label, dict, details_text }。
 */

const { acquirePooled, touchPooled, dropPooled, swapUrlInTab, reloadInTab, setPooledTab, focusTab, jsEval, sleep } = require("../lib/util");
const { CONFIG } = require("../lib/config");
const { log } = require("../lib/log");

const MAX_TEXT = 5000;

// 同一请求(from/to/detail/q 完全相同)的短期记忆: 复用窗口内再问一次直接返回, 不用等百度
const LAST = new Map(); // engineId -> { sig, out, at }: 只用于"上一次的译文"判断新鲜度
const CACHE = new Map(); // sig -> { out, at }: 最多 20 条, 相同请求秒回
const CACHE_MAX = 20;

function cacheGet(sig) {
  const it = CACHE.get(sig);
  if (!it) return null;
  if (Date.now() - it.at > Math.max(CONFIG.keep_tab_ms, 0)) { CACHE.delete(sig); return null; }
  return it.out;
}

function cacheSet(sig, out) {
  if (!(CONFIG.keep_tab_ms > 0)) return; // 不复用标签页时不做缓存(保持"每次都是新结果")
  CACHE.set(sig, { out, at: Date.now() });
  while (CACHE.size > CACHE_MAX) CACHE.delete(CACHE.keys().next().value);
}

// 参数类错误回 400(其余异常走 http.js 的 500 兜底)
function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/*
 * 语言表 —— 唯一事实源。对外代码、中文名、别名、文档清单、MCP 参数描述全部由它派生。
 *
 * 每一行的 code 都在百度翻译网页版**实测返回过对应语种的译文**(2026-10-18)。
 * 为什么必须是白名单: 百度对不认识的语言代码不报错, 而是**静默回退成中文**——
 * 实测 to=uk / tl / km / lo / ne / ur / fa / mong / kaz / uzb 全部返回 200,
 * 但 to_label 变成「中文(简体)」、译文是中文。静默给错语种比直接报错危险得多,
 * 所以未收录代码一律 400, 并提示可用值。
 * (其中 uk / tl / lo / ne / ur / fa 的 ISO 简写已作为别名映射到正确代码。)
 *
 * aliases: ISO 639-1 / 639-2 或常见写法, 内部归一化成 code。
 * sourceOnly: 只能作 from(目前仅 auto)。
 */
const LANG_TABLE = [
  { code: "auto", label: "自动检测", aliases: ["detect", "none"], sourceOnly: true },
  { code: "zh", label: "中文(简体)", aliases: ["zh-cn", "zh-hans", "chs", "cn", "simplified"] },
  { code: "cht", label: "中文(繁体)", aliases: ["zh-tw", "zh-hk", "zh-hant", "tw", "traditional"] },
  { code: "yue", label: "中文(粤语)", aliases: ["zh-yue", "cantonese"] },
  { code: "wyw", label: "中文(文言文)", aliases: ["lzh", "classical"] },
  { code: "en", label: "英语", aliases: ["eng"] },
  { code: "jp", label: "日语", aliases: ["ja", "jpn"] },
  { code: "kor", label: "韩语", aliases: ["ko", "kr"] },
  { code: "fra", label: "法语", aliases: ["fr"] },
  { code: "spa", label: "西班牙语", aliases: ["es"] },
  { code: "de", label: "德语", aliases: ["ger", "deu"] },
  { code: "ru", label: "俄语", aliases: ["rus"] },
  { code: "it", label: "意大利语", aliases: ["ita"] },
  { code: "pt", label: "葡萄牙语", aliases: ["por"] },
  { code: "ara", label: "阿拉伯语", aliases: ["ar"] },
  { code: "th", label: "泰语", aliases: ["tha"] },
  { code: "vie", label: "越南语", aliases: ["vi"] },
  { code: "nl", label: "荷兰语", aliases: ["dut", "nld"] },
  { code: "pl", label: "波兰语", aliases: ["pol"] },
  { code: "tr", label: "土耳其语", aliases: ["tur"] },
  { code: "el", label: "希腊语", aliases: ["gre", "ell"] },
  { code: "fin", label: "芬兰语", aliases: ["fi"] },
  { code: "dan", label: "丹麦语", aliases: ["da"] },
  { code: "swe", label: "瑞典语", aliases: ["sv"] },
  { code: "cs", label: "捷克语", aliases: ["ces", "cz"] },
  { code: "hu", label: "匈牙利语", aliases: ["hun"] },
  { code: "rom", label: "罗马尼亚语", aliases: ["ro", "ron"] },
  { code: "bul", label: "保加利亚语", aliases: ["bg"] },
  { code: "ukr", label: "乌克兰语", aliases: ["uk"] },
  { code: "heb", label: "希伯来语", aliases: ["he", "iw"] },
  { code: "hi", label: "印地语", aliases: ["hin"] },
  { code: "id", label: "印尼语", aliases: ["ind"] },
  { code: "may", label: "马来语", aliases: ["ms", "msa"] },
  { code: "bur", label: "缅甸语", aliases: ["my", "mya"] },
  { code: "fil", label: "菲律宾语", aliases: ["tl", "tgl"] },
  { code: "lao", label: "老挝语", aliases: ["lo"] },
  { code: "nep", label: "尼泊尔语", aliases: ["ne"] },
  { code: "urd", label: "乌尔都语", aliases: ["ur"] },
  { code: "per", label: "波斯语", aliases: ["fa", "fas"] },
  { code: "srp", label: "塞尔维亚语(拉丁文)", aliases: ["sr"] },
  { code: "hrv", label: "克罗地亚语", aliases: ["hr"] },
  { code: "sk", label: "斯洛伐克语", aliases: ["slk"] },
  { code: "slo", label: "斯洛文尼亚语", aliases: ["sl", "slv"] },
  { code: "lit", label: "立陶宛语", aliases: ["lt"] },
  { code: "lav", label: "拉脱维亚语", aliases: ["lv"] },
  { code: "est", label: "爱沙尼亚语", aliases: ["et"] },
  { code: "nor", label: "挪威语", aliases: ["no", "nb"] },
  { code: "ice", label: "冰岛语", aliases: ["is"] },
  { code: "geo", label: "格鲁吉亚语", aliases: ["ka", "kat"] },
  { code: "arm", label: "亚美尼亚语", aliases: ["hy"] },
  { code: "aze", label: "阿塞拜疆语", aliases: ["az"] },
  { code: "tam", label: "泰米尔语", aliases: ["ta"] },
  { code: "tel", label: "泰卢固语", aliases: ["te"] },
  { code: "mal", label: "马拉雅拉姆语", aliases: ["ml"] },
  { code: "ben", label: "孟加拉语", aliases: ["bn"] },
];

// 任意写法 -> 表项; 之后再补别名(不覆盖已注册的主代码)
const LANG = new Map();
for (const it of LANG_TABLE) LANG.set(it.code, it);
for (const it of LANG_TABLE) for (const a of it.aliases) if (!LANG.has(a)) LANG.set(a, it);

// 对外主代码(不含 auto 以外的 sourceOnly)
const LANG_CODES = LANG_TABLE.filter((x) => !x.sourceOnly).map((x) => x.code);
const LANG_SUMMARY = LANG_CODES.join(" ");
const LANG_COUNT = LANG_CODES.length;
const ALIAS_HINT = "别名: zh-CN / zh-TW / ja / ko / fr / es / ar / uk / fa ...";

function normKey(v) {
  return String(v == null ? "" : v).trim().toLowerCase().replace(/[\s_]+/g, "-");
}

// 解析并归一化语言参数; 未收录 -> 400(不静默回退)
function resolveLang(raw, fallback, field) {
  const key = normKey(raw);
  if (!key) return fallback;
  const hit = LANG.get(key);
  if (!hit) {
    throw badRequest(
      `${field} 不支持的语言代码: "${raw}"。可用 ${LANG_COUNT} 种: ${LANG_SUMMARY}（${ALIAS_HINT}）。完整清单(含中文名/别名): GET /api/v1/translate/engines`
    );
  }
  if (field === "to" && hit.sourceOnly) {
    throw badRequest(`to 不能是 "${hit.code}": 目标语言必须明确, 只有 from 支持 auto 自动检测`);
  }
  return hit.code;
}

// 语言清单(给 /engines 与文档页用)
function langList() {
  return LANG_TABLE.map((x) => ({
    code: x.code,
    label: x.label,
    aliases: x.aliases,
    ...(x.sourceOnly ? { source_only: true } : {}),
  }));
}

// 文档页用的语言表格(折叠展示, 避免刷屏)
function langTableHtml() {
  const rows = LANG_TABLE.map(
    (x) =>
      `<tr><td><code>${x.code}</code></td><td>${x.label}${x.sourceOnly ? ' <span class="mut">(仅 from)</span>' : ""}</td><td class="mut">${x.aliases.join(" / ") || "—"}</td></tr>`
  ).join("");
  return `<details><summary>from / to 可用值：${LANG_COUNT} 种语言 + auto（点击展开）</summary>
      <table><thead><tr><th>代码</th><th>语言</th><th>可接受的别名</th></tr></thead><tbody>${rows}</tbody></table>
      <div class="mut" style="margin-top:6px">未收录的代码会直接返回 <code>400</code>——百度对不认识的目标语言会静默回退成中文译文，所以这里不做透传。只想核对方向时看返回的 <code>from_label</code> / <code>to_label</code>。</div>
    </details>`;
}

/*
 * 百度翻译提取脚本(实测 2026-10):
 *   页面 https://fanyi.baidu.com/mtpe-individual/multimodal?query=<enc>&lang=<from>2<to>
 *   URL 带参直达即触发翻译, 无需模拟输入。
 *   译文容器: #machineResContent > #trans-selection(稳定 id, 不是哈希类名)
 *   词典词条: span.can-trans(语义类名, 未哈希)
 *
 * 复用标签页时页面里还留着**上一次**的译文, 所以除了译文还要取两个"新鲜度"信号:
 *   src_len / source —— 左栏源文本(和 #transBottom 里的 123/5000 计数), 与本次 q 对上才算新结果;
 *   done             —— 流式输出结束后才出现的「以上为AI翻译结果」标记。
 * 只看译文会拿到上一题的答案(实测踩过: 距上一题稳定只隔 100ms 就误判完成)。
 *
 * 注意: 不能返回 location.href —— 带查询串会被扩展侧 sanitize 整块拦截(只回 path 也够用)。
 */
const BAIDU_EXTRACT = `
const panel=document.getElementById('editor-text');
if(!panel) return {ready:false,bodyLen:document.body?(document.body.innerText||'').length:0};
const txt=panel.innerText||'';
const lines=txt.split('\\n').map(s=>s.trim()).filter(Boolean);
const srcEl=panel.querySelector('.scroll-y');
const cntEl=document.getElementById('transBottom');
const cnt=cntEl?(cntEl.innerText||'').match(/(\\d+)\\s*\\/\\s*5000/):null;
const sel=document.getElementById('trans-selection');
const res=document.getElementById('machineResContent')||document.getElementById('machineRes');
const translation=sel?(sel.innerText||'').trim():((res?res.innerText.trim().split('\\n')[0]:'')||'');
const segments=translation.split('\\n').map(s=>s.trim()).filter(Boolean);
const dict=[];const seen=new Set();
document.querySelectorAll('#editor-text span.can-trans').forEach(w=>{
  if(dict.length>=12) return;
  const word=(w.innerText||'').trim();
  if(!word||seen.has(word)) return;
  seen.add(word);
  const holder=w.parentElement;
  let defs=holder?(holder.innerText||'').trim():'';
  if(defs.indexOf(word)===0) defs=defs.slice(word.length).trim();
  dict.push({word:word,defs:defs.slice(0,300)});
});
let details='';
const anchor=[...panel.querySelectorAll('div')].find(e=>(e.innerText||'').trim().indexOf('以上为AI翻译结果')===0);
if(anchor){const arr=[];let n=anchor.nextElementSibling;let guard=0;
  while(n&&arr.length<4&&guard<8){const t=(n.innerText||'').trim();if(t)arr.push(t);n=n.nextElementSibling;guard++;}
  details=arr.join('\\n\\n').slice(0,2000);}
return {
  ready:!!translation,
  labels:lines.slice(0,2),
  translation:translation,
  segments:segments,
  dict:dict,
  details_text:details,
  src_len:cnt?parseInt(cnt[1],10):null,
  source:srcEl?(srcEl.innerText||'').slice(0,2000):'',
  done:txt.indexOf('以上为AI翻译结果')>=0,
  need_login:/登录后|请登录|开通会员/.test(txt.slice(0,200)),
  captcha:/安全验证|操作太频繁|访问过于频繁/.test(txt),
  path:location.pathname
};
`;

function normText(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim().toLowerCase();
}

/*
 * 页面上的源文本是不是本次请求(q)?
 *
 * 只比字符数是不够的 —— 实测踩过: "…test one." 和 "…test two." 同为 27 字符,
 * 复用页面时旧译文会被判为"新鲜", 直接把上一题的答案返回给调用方。
 * 所以主判据是**源文本内容比对**:
 *   1) 规范化(折叠空白/小写)后完全相等 —— 覆盖 2000 字符以内的全部场景;
 *   2) 超长文本(页面只回前 2000 字符)才退回"长度一致 + 前 400 字符一致"。
 * 拿不到源文本元素时只能退回字符计数(页面改版兜底), 这条最弱, 但好过整条链路报错。
 */
const SOURCE_CAP = 2000;

function isFresh(d, q) {
  if (!d) return false;
  const nq = normText(q);
  if (!nq) return false;
  const ns = normText(d.source);
  if (ns) {
    if (ns === nq) return true;
    if (q.length > SOURCE_CAP && d.src_len === q.length) {
      return ns.startsWith(nq.slice(0, 400));
    }
    return false;
  }
  return typeof d.src_len === "number" && Math.abs(d.src_len - q.length) <= 1;
}

/*
 * 复用标签页时的"换参是否真的生效"确认。
 * 页内换参是异步生效的(实测源文本约 0.5-0.8s 才刷新), 而且页面正忙时 popstate 会被丢掉,
 * 所以这里最多确认 3s, 中途再补发一次; 仍不生效就交给调用方降级为重载。
 */
async function ensureFresh(tabId, q, onRetry) {
  for (let i = 0; i < 12; i++) {
    const d = await jsEval(tabId, BAIDU_SRC, { timeoutMs: 8000 });
    if (isFresh(d, q)) return true;
    if (i === 4 && onRetry) {
      try { await onRetry(); } catch (e) { /* 补发失败不致命, 继续等 */ }
    }
    await sleep(250);
  }
  return false;
}

// 轻量探针: 只取"源文本 + 字符计数", 比整份提取便宜
const BAIDU_SRC = `
const root=document.getElementById('editor-text');
const srcEl=root?root.querySelector('.scroll-y'):null;
const cntEl=document.getElementById('transBottom');
const c=cntEl?(cntEl.innerText||'').match(/(\\d+)\\s*\\/\\s*5000/):null;
return { source: srcEl?(srcEl.innerText||'').slice(0,${SOURCE_CAP}):'', src_len: c?parseInt(c[1],10):null };
`;

/*
 * 等译文: 先等"页面换成本次的文本"(fresh), 再等译文稳定。
 *
 * 完成判据:
 *   fresh + 译文非空 + 见过译文区被清空/换掉(sawReset) + 连续两次读数一致,
 *   且优先等「以上为AI翻译结果」标记出现(百度流式输出结束的信号)。
 *
 * 为什么要 sawReset: 复用标签页时页面上还留着上一题的译文, 若只看"两次读数一致",
 * 上一题的答案会被当成本次结果返回(实测踩过)。译文区被清空/替换是"页面确实在翻这一题"的证据。
 * 而 sawReset 单独也不够(页面可能在两次轮询之间就完成了), 所以再加一条"译文与上次答案不同"。
 *
 * 轮询间隔 250ms: 原来 1s 间隔光"确认稳定"就要多花 1s, 而 AI 翻译本身只要 2s 左右。
 */
const POLL_MS = 250;
const WAIT_MS = 20000;

async function waitBaidu(tabId, p, opts) {
  const o = opts || {};
  const prevOut = o.prevOut || null;
  const t0 = Date.now();
  const q = p.q;
  let prev = null;
  let sameCount = 0;
  let last = null;
  let sawReset = false;
  while (Date.now() - t0 < WAIT_MS) {
    const d = await jsEval(tabId, BAIDU_EXTRACT, { maxOutputBytes: 262144 });
    last = d;
    if (d && d.parse_error && Date.now() - t0 > WAIT_MS - POLL_MS * 2) {
      throw new Error("百度翻译提取失败(响应被拦截或页面结构变化): " + d.parse_error);
    }
    if (d && d.captcha) {
      const e = new Error("百度翻译触发安全验证(反爬)");
      e.status = 503;
      e.needs_human = true;
      e.hint = "页面已切到前台, 在浏览器(Edge / Chrome)里完成一次验证后重新调用即可";
      throw e;
    }
    const text = d && d.translation ? d.translation : "";
    if (!text) sawReset = true; // 译文区被清空 = 正在翻新的一题
    const fresh = isFresh(d, q);
    const changed = text && prevOut != null && text !== prevOut;
    if (fresh && text && (sawReset || changed || prevOut == null)) {
      if (text === prev) sameCount++;
      else { prev = text; sameCount = 0; }
      if (d.done && sameCount >= 1) return d;
      if (sameCount >= 3) return d;
    } else {
      prev = null;
      sameCount = 0;
    }
    await sleep(POLL_MS);
  }
  const hint = last && last.labels && last.labels.length
    ? `(页面语言: ${last.labels.join(" -> ")}，源语言/目标语言可能不被支持)`
    : "";
  throw new Error(`百度翻译未返回译文${hint}: 检查 from/to 语言代码是否正确，或该语言组合不受支持`);
}

const ENGINES = {
  baidu: {
    id: "baidu",
    title: "百度翻译",
    langs: LANG_CODES,
    buildUrl(p) {
      // p.from / p.to 已在 parseRequest 里归一化成主代码
      return `https://fanyi.baidu.com/mtpe-individual/multimodal?query=${encodeURIComponent(p.q)}&lang=${p.from}2${p.to}`;
    },
    async translate(p) {
      // 复用池: keep_tab_ms(默认 3 分钟)内的重复调用走"页内换参", 不重载网页
      const key = "translate:" + this.id;
      const url = this.buildUrl(p);
      // 完全相同的一次请求(同方向/同文本)直接返回上次结果 —— 免得再等百度 2 秒
      const sig = `${p.from}>${p.to}|${p.detail ? 1 : 0}|${p.q}`;
      const cachedOut = cacheGet(sig);
      const prev = LAST.get(this.id);
      const prevOut = prev && prev.out ? prev.out.translation : null;
      if (cachedOut) {
        log("info", `translate[${this.id}] 命中上次结果(同一请求), 跳过浏览器`);
        return { ...cachedOut, cached: true };
      }

      const pg = await acquirePooled(key, url);
      let tabId = pg.tabId;
      let warm = !!pg.warm;
      try {
        if (warm) {
          // 确认页面真的换成了本次文本, 否则(页面忙/popstate 被丢)退化为重载 —— 慢但正确
          const ok = await ensureFresh(tabId, p.q, () => swapUrlInTab(tabId, url));
          if (!ok) {
            log("warn", `translate[${this.id}] 页内换参未生效(2 次), 退化为重载`);
            tabId = await reloadInTab(tabId, url);
            setPooledTab(key, tabId);
            warm = false;
          }
        }
        const d = await waitBaidu(tabId, p, { prevOut });
        await touchPooled(key); // 保留标签页待下次复用(keep_tab_ms=0 时这里会直接关掉)
        const out = {
          translation: d.translation,
          segments: d.segments || [],
          from_label: (d.labels && d.labels[0]) || null,
          to_label: (d.labels && d.labels[1]) || null,
          dict: p.detail === false ? [] : (d.dict || []),
          details_text: p.detail === false ? "" : (d.details_text || ""),
          warm,
        };
        LAST.set(this.id, { sig, out, at: Date.now() });
        cacheSet(sig, out);
        return out;
      } catch (e) {
        LAST.delete(this.id);
        CACHE.clear(); // 出错说明页面状态不可信, 别再拿缓存冒充结果
        // 需要人工介入(验证码): 把页面留在前台让用户处理; 其余异常直接丢弃标签页, 下次重新加载
        if (e && e.needs_human) {
          await dropPooled(key, false);
          await focusTab(tabId);
        } else {
          await dropPooled(key, true);
        }
        throw e;
      }
    },
  },
  // 下一个引擎加在这里: deepl / bing / youdao ...
  // 需要"注入文本 + 点按钮"的引擎, 用 chrome_fill_or_select / chrome_click_element 组合即可,
  // 结构上不受影响(translate() 里自己实现等待逻辑)。
};

function parseRequest(input) {
  const sp = input instanceof URLSearchParams ? input : new URLSearchParams();
  if (!(input instanceof URLSearchParams)) {
    for (const [k, v] of Object.entries(input || {})) if (v != null) sp.append(k, String(v));
  }
  const q = (sp.get("q") || sp.get("text") || "").trim();
  const engine = (sp.get("engine") || "baidu").trim().toLowerCase();
  const from = resolveLang(sp.get("from") || sp.get("source"), "auto", "from");
  const to = resolveLang(sp.get("to") || sp.get("target"), "zh", "to");
  const detailRaw = sp.get("detail");
  const detail = detailRaw == null ? true : /^(1|true|yes)$/i.test(detailRaw);
  return { q, engine, from, to, detail };
}

async function translate(p) {
  if (!p.q) throw badRequest("empty q: 请提供待翻译文本(q)");
  if (p.q.length > MAX_TEXT) throw badRequest(`text too long: ${p.q.length} 字符, 百度网页版单次上限 ${MAX_TEXT} 字符, 请分段`);
  const engine = ENGINES[p.engine];
  if (!engine) throw badRequest(`unknown engine: ${p.engine} (可用: ${Object.keys(ENGINES).join(", ")})`);

  const t0 = Date.now();
  const r = await engine.translate(p);
  if (!r.translation) throw new Error(`${engine.title} 返回空译文`);

  // 方向兜底: 白名单已挡住"未知代码静默回退中文", 这里再核一次页面实际识别的目标语言,
  // 万一百度改版/某组合不受支持, 调用方能从 to_label_mismatch 立刻发现而不是拿到错语种的译文。
  const expectTo = (LANG.get(p.to) || {}).label || null;
  const mismatch = !!(expectTo && r.to_label && r.to_label !== expectTo);
  if (mismatch) {
    log("warn", `translate[${engine.id}] 目标语言不符: 请求 ${p.to}(${expectTo}) 实际 ${r.to_label}`);
  }
  log("info", `translate[${engine.id}] ${p.from}->${p.to} ${p.q.length} chars in ${Date.now() - t0}ms (${r.cached ? "命中上次结果" : r.warm ? "复用标签页" : "加载网页"})`);

  return {
    source: "web-to-openapi (online translator)",
    engine: engine.id,
    engine_title: engine.title,
    fetched_at: new Date().toISOString(),
    from: p.from,
    to: p.to,
    from_label: r.from_label,
    to_label: r.to_label,
    ...(mismatch ? { to_label_mismatch: true } : {}),
    text: p.q,
    translation: r.translation,
    segments: r.segments,
    dict: r.dict || [],
    details_text: r.details_text || "",
    // reused=true: 这次没有重新加载网页(同一引擎 keep_tab_ms 内的重复调用), 所以明显更快
    // cached=true: 与上一次请求完全相同, 直接返回了上次的结果(不碰浏览器)
    reused: !!r.warm,
    ...(r.cached ? { cached: true } : {}),
    elapsed_ms: Date.now() - t0,
  };
}

const ENGINES_INFO = () => ({
  engines: Object.values(ENGINES).map((e) => ({ id: e.id, title: e.title, langs: e.langs })),
  languages: langList(),
  langs: LANG_CODES,
  lang_count: LANG_COUNT,
  default_engine: "baidu",
  default_from: "auto",
  default_to: "zh",
  max_text_chars: MAX_TEXT,
  keep_tab_ms: CONFIG.keep_tab_ms,
  reuse: CONFIG.keep_tab_ms > 0
    ? `首次调用加载网页(约 3-4s), 之后 ${Math.round(CONFIG.keep_tab_ms / 1000)} 秒内复用同一标签页不再加载(约 2s); 完全相同的请求毫秒级返回`
    : "本次配置不复用标签页(keep_tab_ms=0), 每次调用都重新加载网页(约 3-4s)",
  note: "from / to 只接受下表 languages 里的 code 或其 aliases。未收录代码直接 400 —— 百度对不认识的目标语言会静默回退成中文, 所以不做透传。",
});

module.exports = {
  id: "translate",
  title: "在线翻译",
  endpoints: [
    {
      method: "GET",
      methods: ["GET", "POST"],
      path: "/api/v1/translate",
      tool: "translate_text",
      operationId: "translateText",
      summary: "在线翻译(统一入口, engine 切换引擎)",
      description: `实时驱动浏览器(Edge / Chrome)打开在线翻译站点, 返回译文。参数: q(待翻译文本, 上限 5000 字符)、from(源语言, 默认 auto)、to(目标语言, 默认 zh)、engine(默认 baidu)、detail(是否附带词典/例句, 默认 true)。from / to 支持 ${LANG_COUNT} 种语言代码及 ISO 别名(如 zh-CN / zh-TW / ja / ko / fr / es), 完整清单见 GET /api/v1/translate/engines 的 languages 字段或 /docs 文档页; 未收录的代码返回 400 -- 百度对不认识的目标语言会静默回退成中文, 因此不做透传。当前支持引擎: baidu(百度翻译)。**速度**: 首次调用要加载网页(约 3-4 秒), 之后 keep_tab_ms(默认 3 分钟)内的调用复用同一个标签页、只改页面里的查询串, 不再加载网页(约 2 秒); 与上一次完全相同的请求直接命中结果(毫秒级)。返回里 reused=true 表示复用了页面, cached=true 表示命中上次结果。中文文本推荐用 POST 传 JSON body: GET 的查询串必须做 URL 编码。`,
      post: {
        operationId: "translateTextPost",
        summary: "在线翻译(POST JSON body, 中文免 URL 编码)",
        description: "与 GET 参数完全相同, 改为 JSON body 传递。推荐翻译中文文本时使用: GET 查询串必须 URL 编码, 未编码的中文会被 HTTP 协议层直接拒绝(400 Bad Request)。",
      },
      example: { q: "Hello world, nice to meet you.", from: "en", to: "zh" },
      responses: {
        200: { description: "译文 JSON(translation/segments/dict)" },
        400: { description: "参数为空或文本超长" },
        500: { description: "翻译失败(反爬验证/语言组合不支持/页面结构变化)" },
        503: { description: "需要人工处理(如触发安全验证): 页面已切到前台, 处理完重试即可" },
      },
      browser: true,
      parse: parseRequest,
      run: (p) => translate(p),
      doc: {
        note: `在线翻译统一入口。<code>engine</code> 切换引擎(当前 <code>baidu</code>); <code>from=auto</code> 自动检测; <code>to</code> 默认中文。返回 <code>translation</code>(整段译文)、<code>segments</code>(按行拆分)、<code>dict</code>(重点词汇)、<code>details_text</code>(词典+例句原文)。单次上限 5000 字符。<br><b>速度</b>: 首次约 3-4 秒(要加载网页); 之后 <code>keep_tab_ms</code>(默认 3 分钟)内复用同一个标签页、只改页面里的查询串, 约 2 秒; 与上一次完全相同的请求毫秒级返回(<code>cached:true</code>)。返回里的 <code>reused</code> 表示这次有没有复用页面。<br><code>from</code> / <code>to</code> 支持 <b>${LANG_COUNT} 种语言代码</b> + ISO 别名(<code>zh-CN</code> / <code>zh-TW</code> / <code>ja</code> / <code>ko</code> / <code>fr</code> / <code>es</code> ...), 清单见下方折叠表或 <code>GET /api/v1/translate/engines</code>。返回的 <code>from_label</code> / <code>to_label</code> 是页面实际识别的语言, 可用来核对方向。`,
        extra: langTableHtml(),
        tryQuery: "/api/v1/translate?q=The%20quick%20brown%20fox%20jumps%20over%20the%20lazy%20dog.&from=en&to=zh",
        curlGet: `curl -s "http://127.0.0.1:8090/api/v1/translate?q=hello%20world&from=en&to=zh&engine=baidu"`,
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/translate \\
  -H "Content-Type: application/json" \\
  -d '{"q":"今天天气很好，我们去公园散步吧。","from":"zh","to":"en"}'`,
        postNote: "同上, JSON body 传参。<b>中文文本推荐用这个</b>——body 里的中文不需要 URL 编码。",
        slow: true,
      },
    },
    {
      method: "GET",
      path: "/api/v1/translate/engines",
      tool: "translate_engines",
      operationId: "translateEngines",
      summary: "列出可用的翻译引擎与支持语言",
      description: "返回已接入的翻译引擎(id / 名称 / 支持语言代码)与单次文本上限。新增引擎后自动出现。",
      responses: { 200: { description: "引擎清单 JSON" } },
      run: () => ENGINES_INFO(),
      doc: { note: "列出可用翻译引擎、支持的语言代码、单次文本上限。新引擎接入后自动出现在这里。" },
    },
  ],
  tools: [
    {
      name: "translate_text",
      description:
        `在线翻译: 实时驱动浏览器打开在线翻译站点并返回译文。q=待翻译文本(上限 5000 字符); from=源语言(默认 auto 自动检测); to=目标语言(默认 zh 中文); engine=引擎(默认 baidu, 用 translate_engines 查看可用值); detail=false 时跳过词典/例句。from/to 支持 ${LANG_COUNT} 种语言代码及 ISO 别名(如 ja/ko/fr/es/zh-CN/zh-TW), 完整清单用 translate_engines 查 languages 字段; 未收录代码会返回错误(百度对不认识的目标语言会静默回退成中文, 故不做透传)。返回 translation(整段译文)、segments(按行拆分)、dict(重点词汇数组)、details_text(词典与例句原文)、from_label/to_label(页面实际识别的语言, 用于核对方向)。速度: 首次约 3-4 秒, 之后同一引擎的重复调用复用已打开的页面(约 2 秒, 返回里 reused=true), 完全相同的请求毫秒级返回(cached=true)。中文文本直接传即可(MCP 无 URL 编码问题)。`,
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "待翻译文本(必填, 上限 5000 字符; 超长请自行分段)" },
          from: { type: "string", description: `源语言代码(默认 auto 自动检测)。可用: ${LANG_SUMMARY}。${ALIAS_HINT}`, default: "auto" },
          to: { type: "string", description: `目标语言代码(默认 zh 中文, 不支持 auto)。可用: ${LANG_SUMMARY}。${ALIAS_HINT}`, default: "zh" },
          engine: { type: "string", description: "翻译引擎 id(默认 baidu); 用 translate_engines 查看全部可用值", default: "baidu" },
          detail: { type: "boolean", description: "是否附带词典/例句(默认 true); 设为 false 可略微加快返回", default: true },
        },
        required: ["q"],
      },
      browser: true,
      run: (args) => translate(parseRequest(args || {})),
    },
    {
      name: "translate_engines",
      description: `列出可用的翻译引擎(id / 名称)与全部语言代码: languages 每项含 code、中文名 label、可接受的 aliases; langs 是纯代码数组(${LANG_COUNT} 项, 含 auto)。用返回的 code 作为 translate_text 的 from/to。`,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => ENGINES_INFO(),
    },
  ],
};
