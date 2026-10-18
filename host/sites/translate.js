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
 *   to      目标语言, 默认 zh
 *   engine  引擎 id, 默认 baidu
 *   detail  是否附带词典/例句(默认 true; 不影响主流程, 解析失败只是返回空)
 *
 * 一层薄抽象: 每个引擎只负责 "把参数拼成 URL -> 打开 -> 等译文稳定 -> 归一化返回",
 * 返回结构统一为 { translation, segments, from_label, to_label, dict, details_text }。
 */

const { openPage, closePage, jsEval, sleep } = require("../lib/util");
const { log } = require("../lib/log");

const MAX_TEXT = 5000;

// 参数类错误回 400(其余异常走 http.js 的 500 兜底)
function badRequest(msg) {
  const e = new Error(msg);
  e.status = 400;
  return e;
}

/*
 * 语言代码映射(统一用 ISO 639-1 / 常见写法作为对外入参, 内部转成各站点的方言代码)。
 * 未收录的代码原样透传 —— 站点不认识时译文为空, 错误信息里会带上页面实际识别的语言标签, 便于排查。
 */
const LANG = {
  auto: "auto",
  zh: "zh", "zh-cn": "zh", "zh-hans": "zh", chs: "zh",
  "zh-tw": "cht", "zh-hant": "cht", cht: "cht",
  en: "en", ja: "jp", jp: "jp", ko: "kor", kor: "kor",
  fr: "fra", es: "spa", de: "de", ru: "ru", it: "it", pt: "pt",
  ar: "ara", th: "th", vi: "vie", nl: "nl", pl: "pl", tr: "tr",
};

const LANG_LABELS = {
  auto: "自动检测", zh: "中文(简体)", cht: "中文(繁体)", en: "英语", jp: "日语", kor: "韩语",
  fra: "法语", spa: "西班牙语", de: "德语", ru: "俄语", it: "意大利语", pt: "葡萄牙语",
  ara: "阿拉伯语", th: "泰语", vie: "越南语", nl: "荷兰语", pl: "波兰语", tr: "土耳其语",
};

function normLang(v, fallback) {
  const s = String(v == null ? "" : v).trim().toLowerCase();
  if (!s) return fallback;
  return LANG[s] ? s : s; // 未收录: 保留原样(透传), 由站点决定是否支持
}

/*
 * 百度翻译提取脚本(实测 2026-10):
 *   页面 https://fanyi.baidu.com/mtpe-individual/multimodal?query=<enc>&lang=<from>2<to>
 *   URL 带参直达即触发翻译, 无需模拟输入。
 *   译文容器: #machineResContent > #trans-selection(稳定 id, 不是哈希类名)
 *   词典词条: span.can-trans(语义类名, 未哈希)
 *
 * 注意: 不能返回 location.href —— 带查询串会被扩展侧 sanitize 整块拦截(只回 path 也够用)。
 */
const BAIDU_EXTRACT = `
const panel=document.getElementById('editor-text');
if(!panel) return {ready:false,bodyLen:document.body?(document.body.innerText||'').length:0};
const txt=panel.innerText||'';
const lines=txt.split('\\n').map(s=>s.trim()).filter(Boolean);
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
  need_login:/登录后|请登录|开通会员/.test(txt.slice(0,200)),
  captcha:/安全验证|操作太频繁|访问过于频繁/.test(txt),
  path:location.pathname
};
`;

/*
 * 等译文稳定: AI 翻译是流式输出, 拿到一次不等于写完了。
 * 连续两次读数一致才返回(与 SCNet 转轮动画同样的教训: "拿到了" != "最终值").
 */
async function waitBaidu(tabId) {
  let prev = null;
  let last = null;
  for (let i = 0; i < 15; i++) {
    const d = await jsEval(tabId, BAIDU_EXTRACT, { maxOutputBytes: 262144 });
    if (d && d.parse_error && i === 14) throw new Error("百度翻译提取失败(响应被拦截或页面结构变化): " + d.parse_error);
    last = d;
    if (d && d.captcha) throw new Error("百度翻译触发安全验证(反爬): 请在浏览器(Edge / Chrome)里手动打开 fanyi.baidu.com 完成一次翻译后重试");
    if (d && d.translation) {
      if (prev === d.translation) return d;
      prev = d.translation;
    }
    await sleep(1000);
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
    langs: Object.keys(LANG_LABELS),
    buildUrl(p) {
      const from = LANG[String(p.from).toLowerCase()] || p.from;
      const to = LANG[String(p.to).toLowerCase()] || p.to;
      return `https://fanyi.baidu.com/mtpe-individual/multimodal?query=${encodeURIComponent(p.q)}&lang=${from}2${to}`;
    },
    async translate(p) {
      const page = await openPage(this.buildUrl(p));
      try {
        const d = await waitBaidu(page.tabId);
        return {
          translation: d.translation,
          segments: d.segments || [],
          from_label: (d.labels && d.labels[0]) || null,
          to_label: (d.labels && d.labels[1]) || null,
          dict: p.detail === false ? [] : (d.dict || []),
          details_text: p.detail === false ? "" : (d.details_text || ""),
        };
      } finally {
        await closePage(page);
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
  const from = normLang(sp.get("from"), "auto");
  const to = normLang(sp.get("to") || sp.get("target"), "zh");
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
  log("info", `translate[${engine.id}] ${p.from}->${p.to} ${p.q.length} chars in ${Date.now() - t0}ms`);

  return {
    source: "web-to-openapi (online translator)",
    engine: engine.id,
    engine_title: engine.title,
    fetched_at: new Date().toISOString(),
    from: p.from,
    to: p.to,
    from_label: r.from_label,
    to_label: r.to_label,
    text: p.q,
    translation: r.translation,
    segments: r.segments,
    dict: r.dict || [],
    details_text: r.details_text || "",
    elapsed_ms: Date.now() - t0,
  };
}

const ENGINES_INFO = () => ({
  engines: Object.values(ENGINES).map((e) => ({ id: e.id, title: e.title, langs: e.langs })),
  default_engine: "baidu",
  max_text_chars: MAX_TEXT,
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
      description: "实时驱动浏览器(Edge / Chrome)打开在线翻译站点, 返回译文。参数: q(待翻译文本, 上限 5000 字符)、from(源语言, 默认 auto)、to(目标语言, 默认 zh)、engine(默认 baidu)、detail(是否附带词典/例句, 默认 true)。当前支持引擎: baidu(百度翻译)。中文文本推荐用 POST 传 JSON body: GET 的查询串必须做 URL 编码。每次调用约 5-10 秒。",
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
      },
      browser: true,
      parse: parseRequest,
      run: (p) => translate(p),
      doc: {
        note: "在线翻译统一入口。<code>engine</code> 切换引擎(当前 <code>baidu</code>); <code>from=auto</code> 自动检测; <code>to</code> 默认中文。返回 <code>translation</code>(整段译文)、<code>segments</code>(按行拆分)、<code>dict</code>(重点词汇)、<code>details_text</code>(词典+例句原文)。单次上限 5000 字符, 约 5-10 秒。",
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
        "在线翻译: 实时驱动浏览器打开在线翻译站点并返回译文(约 5-10 秒)。q=待翻译文本(上限 5000 字符); from=源语言(默认 auto 自动检测); to=目标语言(默认 zh 中文); engine=引擎(默认 baidu, 用 translate_engines 查看可用值); detail=false 时跳过词典/例句以加快返回。返回 translation(整段译文)、segments(按行拆分)、dict(重点词汇数组)、details_text(词典与例句原文)。中文文本直接传即可(MCP 无 URL 编码问题)。",
      inputSchema: {
        type: "object",
        properties: {
          q: { type: "string", description: "待翻译文本(必填, 上限 5000 字符; 超长请自行分段)" },
          from: { type: "string", description: "源语言代码(默认 auto 自动检测); 常用: auto/zh/en/jp/kor/fra/spa/de/ru", default: "auto" },
          to: { type: "string", description: "目标语言代码(默认 zh 中文); 常用: zh/cht/en/jp/kor/fra/spa/de/ru", default: "zh" },
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
      description: "列出可用的翻译引擎: 返回每个引擎的 id、名称、支持的语言代码, 以及单次文本字符上限。用返回的 id 作为 translate_text 的 engine 参数。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      run: () => ENGINES_INFO(),
    },
  ],
};
