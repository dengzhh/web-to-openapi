"use strict";
/*
 * 可信动作层(v1.8.0, 阶段 A)
 * ---------------------------------------------------------------------------
 * 把「透传一个工具」升级成「执行一次受控动作」: 派发前门禁 → 派发 → 取证 → 结构化回执。
 *
 *   resolve  校验 token / 元素存活 / 可见 / 未遮挡, 采基线 + 静默度
 *   guard    stale 非空即拒绝, 绝不带着疑问去点击
 *   dispatch 经 chrome_computer 派发(阶段 A 为扩展默认通道, 阶段 B 起可 forceCdp)
 *   settle   轮询强信号/弱信号, 上限可配
 *   verdict  changed / unattributable / none —— 弱证据且页面本来在动时不冒领
 *
 * 三条硬规则(承自重读 nanobrowser 后的结论, 见 docs/可信动作层方案_ActionReceipt.md):
 *   1) 超时不重试: callTool 超时 -> dispatched:"unknown", retryable:false
 *   2) 不冒领: 只有 mutation 这种弱证据时, 页面原本在动就判 unattributable
 *   3) known-set: 没 observe 过的 ref 一律 REF_NOT_PRESENTED, 不猜、不兜底
 *
 * 与站点模块的关系: 本层不碰任何具体站点逻辑, 只认 tabId + ref。
 */
const util = require("./util");
const { log } = require("./log");
const probe = require("./probe");

// 通过 util 间接调用, 便于测试时整体替换(单测不碰真浏览器)
const callTool = (name, args, timeoutMs) => util.callTool(name, args, timeoutMs);
const dataText = util.dataText;
const sleep = util.sleep;

const INPUT_KIND = "synthetic"; // 阶段 B 落地 forceCdp 后改 trusted
const OBSERVE_MAX = 120;
const SETTLE_MS = 1500;
const QUIET_MS = 300;

// ---------------------------------------------------------------- 页面执行
/*
 * 在页面主世界执行探针脚本, 同时拿回真实 tabId(未显式传 tabId 时由扩展选活动标签)。
 * 不走 util.js 的 jsEval: 那里只回 result 内层, 这里需要外层 tabId。
 */
async function evalInPage(tabId, code, timeoutMs) {
  const args = { code, timeoutMs: timeoutMs || 20000, maxOutputBytes: 262144 };
  if (tabId != null) args.tabId = tabId;
  const data = await callTool("chrome_javascript", args);
  const text = dataText(data);
  let outer;
  try {
    outer = JSON.parse(text);
  } catch (e) {
    throw new Error("页面脚本响应不是合法 JSON(可能被扩展 sanitize 截断): " + String(text).slice(0, 160));
  }
  if (outer && outer.success === false) {
    const err = (outer.error && (outer.error.message || outer.error.kind)) || "unknown";
    throw new Error("页面脚本执行失败: " + String(err).slice(0, 200));
  }
  let inner = outer && outer.result !== undefined ? outer.result : outer;
  if (typeof inner === "string") {
    try { inner = JSON.parse(inner); }
    catch (e) { throw new Error("页面脚本返回的不是 JSON: " + inner.slice(0, 160)); }
  }
  return { tabId: (outer && outer.tabId) || tabId, out: inner || {} };
}

// ---------------------------------------------------------------- 回执组装
function receipt(parts) {
  const r = {
    ok: !parts.stale,
    input_kind: parts.input_kind || INPUT_KIND,
    target: parts.target || null,
    dispatched: parts.dispatched === undefined ? false : parts.dispatched,
    // 是否确认输入真的到达目标: 阶段 A/C 之前无法证明, 一律 null 而不是假装 true
    reached_target: parts.reached_target === undefined ? null : parts.reached_target,
    mechanism: parts.mechanism || null,
    effect: parts.effect || { verdict: "none", signals: [], elapsed_ms: 0 },
    postcondition: parts.postcondition || { met: true, checks: [] },
    stale: parts.stale || null,
    retryable: parts.retryable === undefined ? false : parts.retryable,
  };
  if (parts.stale_reason) r.stale_reason = parts.stale_reason;
  if (parts.hit) r.hit = parts.hit;
  if (parts.withheld !== undefined) r.withheld = parts.withheld;
  if (parts.swapped) r.swapped = parts.swapped;
  if (parts.note) r.note = parts.note;
  return r;
}

function effectFromSettle(s) {
  const signals = [];
  if (s.signal) signals.push(s.signal);
  if (s.after && s.after.path) signals.push("path:" + s.after.path);
  return { verdict: "none", signals, elapsed_ms: s.elapsed_ms || 0 };
}

/*
 * 弱证据的归属判定: 只有 mutation 增长时, 看派发前那段窗口页面自己是否在动。
 * quiet > 0 说明点击前页面就在自己刷 DOM, 这次增长不能算在动作头上 -> unattributable。
 */
function verdictOf(settleOut, quiet) {
  if (settleOut.verdict === "changed") return "changed";
  if (settleOut.verdict === "weak") return quiet > 0 ? "unattributable" : "changed";
  return "none";
}

function postconditionOf(settleOut, expect) {
  const checks = (settleOut && settleOut.checks) || [];
  const met = expect && expect.length ? checks.every((c) => c.ok) : true;
  return { met, checks };
}

// ---------------------------------------------------------------- observe
async function observe(opts) {
  const o = opts || {};
  const code = probe.observeScript(o.max == null ? OBSERVE_MAX : o.max);
  const { tabId, out } = await evalInPage(o.tabId, code, o.timeout_ms);
  log("action", `observe tab=${tabId} tok=${out.tok} scanned=${out.scanned} shown=${out.shown}`);
  return {
    ok: true,
    tab_id: tabId,
    page_token: out.tok,
    url_path: out.state && out.state.path,
    title: out.state && out.state.title,
    scanned: out.scanned,
    shown: out.shown,
    truncated: !!out.truncated,
    elements: out.elements || [],
    hint: "把 ref 原样传给 act/click 或 act/type; 页面一旦重新加载, 旧 ref 会以 DOCUMENT_CHANGED 失效, 重新 observe 即可。",
  };
}

// ---------------------------------------------------------------- 目标解析
/*
 * page_token 自动推导: ref 格式是 "<tok>.r<N>", 前缀就是 token。
 * 调用方不传 page_token 时从 ref 推导 —— 页面侧仍会校验 curTok===WANT(挡跨文档混乱)
 * 和 refs 注册表(挡幻觉 ref), 安全性无损, 只是省掉一个多余参数。
 * 显式传 page_token 且与 ref 前缀不一致时以显式值为准(页面对比会拒绝)。
 */
function wantTokOf(ref, explicit) {
  if (explicit) return explicit;
  const m = /^([A-Za-z0-9]+)\.r\d+$/.exec(String(ref || ""));
  return m ? m[1] : "";
}

async function resolveTarget(tabId, ref, wantTok, quietMs) {
  const code = probe.resolveScript(ref, wantTok, quietMs == null ? QUIET_MS : quietMs);
  const { tabId: realTab, out } = await evalInPage(tabId, code, 25000);
  return { tabId: realTab, res: out };
}

// ---------------------------------------------------------------- 派发
function isTimeoutError(e) {
  return /timed out|timeout/i.test(String((e && e.message) || e));
}

/*
 * CDP 输入事件(Input.dispatchMouseEvent / insertText)对**后台标签不可靠**:
 * Runtime.evaluate 能到, 鼠标事件到了渲染器却不触发 handler(实测)。
 * 所以派发输入前先把标签激活到前台 —— 真人操作也总是发生在前台标签上。
 * 激活失败不阻断(输入照发, 只是可能无效, 由 settle 的 verdict 如实反映)。
 */
async function activateTab(tabId) {
  if (tabId == null) return;
  try {
    await callTool("chrome_switch_tab", { tabId }, 15000);
    await sleep(180); // 等渲染器完成切换与绘制
  } catch (e) {
    log("warn", `activate tab ${tabId} failed (继续派发): ${e.message}`);
  }
}

/*
 * 派发点击。默认走 forceCdp(扩展 v1.8.0 起支持): 直接用 Input.dispatchMouseEvent 发受信输入,
 * 绕开内容脚本合成事件与截图坐标缩放。旧扩展不认这个参数时会退回原通道 —— 此时扩展回包里
 * 没有 trusted 字段, 回执就如实标 synthetic, 不假装是真输入。
 */
async function dispatchClick(tabId, target, opts) {
  const o = opts || {};
  const args = {
    tabId,
    action: "left_click",
    coordinates: { x: target.cx, y: target.cy },
  };
  if (o.forceCdp !== false) args.forceCdp = true;
  // 阶段 C: press 后重新确认目标仍是同一个元素, 变了就把 release 送到视口外(不激活任何元素)
  if (o.splitPress !== false) args.splitPress = true;
  if (o.modifiers) args.modifiers = o.modifiers;
  await activateTab(tabId);
  try {
    const data = await callTool("chrome_computer", args, o.timeout_ms || 30000);
    const text = dataText(data);
    const parsed = safeParse(text);
    if (parsed && parsed.success === false) {
      return { dispatched: false, error: String(parsed.error || "click failed").slice(0, 200) };
    }
    return {
      dispatched: true,
      trusted: !!(parsed && parsed.trusted === true),
      transport: (parsed && parsed.transport) || null,
      withheld: !!(parsed && parsed.withheld === true),
      target_before: (parsed && parsed.target_before) || null,
      target_after: (parsed && parsed.target_after) || null,
      raw: parsed,
    };
  } catch (e) {
    // 超时 != 失败: 扩展可能已经点下去了, 只是回包慢
    if (isTimeoutError(e)) return { dispatched: "unknown", error: e.message };
    return { dispatched: false, error: e.message };
  }
}

async function dispatchType(tabId, text, opts) {
  const o = opts || {};
  const args = { tabId, action: "type", text: String(text) };
  if (o.forceCdp) args.forceCdp = true;
  try {
    const data = await callTool("chrome_computer", args, o.timeout_ms || 30000);
    const parsed = safeParse(dataText(data));
    if (parsed && parsed.success === false) {
      return { dispatched: false, error: String(parsed.error || "type failed").slice(0, 200) };
    }
    return { dispatched: true, raw: parsed };
  } catch (e) {
    if (isTimeoutError(e)) return { dispatched: "unknown", error: e.message };
    return { dispatched: false, error: e.message };
  }
}

async function dispatchKey(tabId, keys, opts) {
  const o = opts || {};
  try {
    await callTool("chrome_computer", { tabId, action: "key", text: String(keys) }, o.timeout_ms || 20000);
    return { dispatched: true };
  } catch (e) {
    if (isTimeoutError(e)) return { dispatched: "unknown", error: e.message };
    return { dispatched: false, error: e.message };
  }
}

function safeParse(s) {
  try { return JSON.parse(s); } catch (e) { return null; }
}

/*
 * 滚动: chrome_computer 的 scroll 走 CDP Input.dispatchMouseEvent(mouseWheel), 是真输入。
 * 参数 coordinates(可选, 滚动的锚点) + scrollDirection + scrollAmount。
 */
async function dispatchScroll(tabId, target, opts) {
  const o = opts || {};
  const args = { tabId, action: "scroll" };
  if (target && target.cx != null) args.coordinates = { x: target.cx, y: target.cy };
  if (o.direction) args.scrollDirection = o.direction;
  if (o.amount) args.scrollAmount = Math.max(1, Math.min(o.amount, 10));
  await activateTab(tabId);
  try {
    const data = await callTool("chrome_computer", args, o.timeout_ms || 30000);
    const parsed = safeParse(dataText(data));
    if (parsed && parsed.success === false) {
      return { dispatched: false, error: String(parsed.error || "scroll failed").slice(0, 200) };
    }
    return { dispatched: true, deltaX: (parsed && parsed.deltaX) || 0, deltaY: (parsed && parsed.deltaY) || 0, raw: parsed };
  } catch (e) {
    if (isTimeoutError(e)) return { dispatched: "unknown", error: e.message };
    return { dispatched: false, error: e.message };
  }
}

/*
 * 拖拽: chrome_computer 的 left_click_drag 走 CDP(moved→pressed→moved→released), 真输入。
 * 参数 startCoordinates(起点) + coordinates(终点)。
 */
async function dispatchDrag(tabId, fromTarget, toTarget, opts) {
  const o = opts || {};
  const args = {
    tabId,
    action: "left_click_drag",
    startCoordinates: { x: fromTarget.cx, y: fromTarget.cy },
    coordinates: { x: toTarget.cx, y: toTarget.cy },
  };
  await activateTab(tabId);
  try {
    const data = await callTool("chrome_computer", args, o.timeout_ms || 30000);
    const parsed = safeParse(dataText(data));
    if (parsed && parsed.success === false) {
      return { dispatched: false, error: String(parsed.error || "drag failed").slice(0, 200) };
    }
    return { dispatched: true, raw: parsed };
  } catch (e) {
    if (isTimeoutError(e)) return { dispatched: "unknown", error: e.message };
    return { dispatched: false, error: e.message };
  }
}

// ---------------------------------------------------------------- settle
async function settle(tabId, ref, res, expect, maxMs) {
  const base = Object.assign({}, res.before || {}, { base: res.base || null });
  const code = probe.settleScript(ref, base, expect || [], maxMs == null ? SETTLE_MS : maxMs);
  try {
    const r = await evalInPage(tabId, code, (maxMs || SETTLE_MS) + 15000);
    return r.out;
  } catch (e) {
    // 取证失败不能把动作判成失败: 派发已经发生, 这里只降级证据
    log("warn", `settle failed (${e.message}); 降级为 unknown 证据`);
    return { verdict: "none", signal: null, elapsed_ms: 0, error: e.message, checks: [] };
  }
}

// ---------------------------------------------------------------- click
async function click(opts) {
  const o = opts || {};
  if (!o.ref) {
    const e = new Error("act/click 需要 ref(先调 act/observe 取)");
    e.status = 400;
    throw e;
  }
  const t0 = Date.now();
  const r0 = await resolveTarget(o.tabId, o.ref, wantTokOf(o.ref, o.page_token), o.quiet_ms);
  const res = r0.res;
  const tabId = r0.tabId;

  if (res.stale) {
    log("action", `click rejected: ${res.stale} ref=${o.ref}`);
    return receipt({
      stale: res.stale,
      stale_reason: res.why,
      target: o.ref ? { ref: o.ref } : null,
      dispatched: false,
      hit: res.hit,
      retryable: res.stale === "REF_NOT_PRESENTED" || res.stale === "NOT_VISIBLE" || res.stale === "OBSCURED",
      note: "派发前门禁拒绝, 浏览器未收到任何输入。",
    });
  }

  const target = res.target;
  const d = await dispatchClick(tabId, target, o);
  if (d.dispatched !== true) {
    return receipt({
      target,
      dispatched: d.dispatched,
      mechanism: "pointer",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: d.dispatched === false,
      note: d.dispatched === "unknown"
        ? "派发结果未知(超时): 点击可能已经生效, 重复调用有双发风险, 因此不重试。请先 observe 看页面当前状态再决定。"
        : "派发失败: " + (d.error || "unknown"),
    });
  }

  // 阶段 C: press 之后目标被换掉 —— release 已扣发(送到视口外), 本次点击没有激活任何元素
  if (d.withheld) {
    log("action", `click withheld: 目标在 press 后变更为 ${d.target_after} (原 ${d.target_before})`);
    return receipt({
      target,
      input_kind: d.trusted ? "trusted" : "synthetic",
      dispatched: true,
      mechanism: "pointer",
      hit: target.hit,
      withheld: true,
      swapped: { before: d.target_before, after: d.target_after },
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: true,
      note: "按下之后目标元素已变(页面在按下瞬间改动了布局或弹出浮层), 已扣发 release 并送到视口外, 因此本次点击没有激活任何元素。建议重新 observe 后再试。",
    });
  }

  const s = await settle(tabId, o.ref, res, o.expect, o.settle_ms);
  const verdict = verdictOf(s, res.quiet);
  return receipt({
    target,
    input_kind: d.trusted ? "trusted" : "synthetic",
    dispatched: true,
    mechanism: "pointer",
    hit: target.hit,
    effect: { verdict, signals: effectFromSettle(s).signals, elapsed_ms: s.elapsed_ms || Date.now() - t0 },
    postcondition: postconditionOf(s, o.expect),
    retryable: verdict === "none",
    note: verdict === "unattributable"
      ? "只看到 DOM 变动, 但派发前页面自身就在变动, 无法归因于本次点击。"
      : undefined,
  });
}

// ---------------------------------------------------------------- type
/*
 * 输入流程: 先真点击聚焦(坐标), 再 insertText。
 * 不把 ref 透给 chrome_computer —— 那边认的是扩展自己的 ref_N, 跟本层的 ref 不是一套。
 */
async function type(o) {
  const opts = o || {};
  if (!opts.ref) {
    const e = new Error("act/type 需要 ref(先调 act/observe 取)");
    e.status = 400;
    throw e;
  }
  if (opts.text == null) {
    const e = new Error("act/type 需要 text");
    e.status = 400;
    throw e;
  }
  const t0 = Date.now();
  const r0 = await resolveTarget(opts.tabId, opts.ref, wantTokOf(opts.ref, opts.page_token), opts.quiet_ms);
  const res = r0.res;
  const tabId = r0.tabId;

  if (res.stale) {
    log("action", `type rejected: ${res.stale} ref=${opts.ref}`);
    return receipt({
      stale: res.stale,
      stale_reason: res.why,
      target: { ref: opts.ref },
      dispatched: false,
      hit: res.hit,
      retryable: res.stale === "REF_NOT_PRESENTED" || res.stale === "NOT_VISIBLE",
      note: "派发前门禁拒绝, 浏览器未收到任何输入。",
    });
  }

  const target = res.target;
  const mode = opts.mode === "replace" ? "replace" : "append";

  // 聚焦: 用坐标点击, 与 click 同一条通道
  const focusRes = await dispatchClick(tabId, target, opts);
  if (focusRes.dispatched === "unknown") {
    return receipt({
      target,
      dispatched: "unknown",
      mechanism: "keyboard",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: false,
      note: "聚焦点击超时, 结果未知; 为避免双发与错位输入, 已停止后续键入。",
    });
  }
  if (focusRes.dispatched !== true) {
    return receipt({
      target,
      dispatched: false,
      mechanism: "keyboard",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: true,
      note: "聚焦点击失败: " + (focusRes.error || "unknown"),
    });
  }
  // 聚焦点击被扣发 = 焦点没落到目标上, 此时键入会打进别的元素, 必须停下
  if (focusRes.withheld) {
    return receipt({
      target,
      input_kind: focusRes.trusted ? "trusted" : "synthetic",
      dispatched: true,
      mechanism: "keyboard",
      hit: target.hit,
      withheld: true,
      swapped: { before: focusRes.target_before, after: focusRes.target_after },
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: true,
      note: "聚焦点击被扣发(按下后目标变了), 焦点未落到目标元素, 为避免文字打到别处已停止键入。",
    });
  }

  if (mode === "replace") {
    await dispatchKey(tabId, "ctrl+a", opts);
    await sleep(60);
  }

  const d = await dispatchType(tabId, opts.text, opts);
  if (d.dispatched !== true) {
    return receipt({
      target,
      dispatched: d.dispatched,
      mechanism: "keyboard",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: d.dispatched === false,
      note: d.dispatched === "unknown"
        ? "键入结果未知(超时): 文本可能已写入, 重复调用会叠加内容, 因此不重试。"
        : "键入失败: " + (d.error || "unknown"),
    });
  }

  const s = await settle(tabId, opts.ref, res, opts.expect, opts.settle_ms);
  const verdict = verdictOf(s, res.quiet);
  return receipt({
    target,
    input_kind: focusRes.trusted ? "trusted" : "synthetic",
    dispatched: true,
    mechanism: "keyboard",
    hit: target.hit,
    effect: { verdict, signals: effectFromSettle(s).signals, elapsed_ms: s.elapsed_ms || Date.now() - t0 },
    postcondition: postconditionOf(s, opts.expect),
    retryable: verdict === "none",
    note: mode === "replace" ? "已先 ctrl+a 全选再键入(替换模式)。" : undefined,
  });
}

// ---------------------------------------------------------------- find
/*
 * 语义查找: 在 observe 登记过的集合里按 label/placeholder/name/id/text/role/tag/type 匹配。
 * filters: [{field, value, op}]。只查已知集合(known-set), 不定位没 observe 过的新元素。
 */
async function find(opts) {
  const o = opts || {};
  const filters = o.filters || [];
  const code = probe.findScript(filters, o.max);
  const { tabId, out } = await evalInPage(o.tabId, code, o.timeout_ms);
  log("action", `find tab=${tabId} tok=${out.tok} count=${out.count} max=${o.max}`);
  return {
    ok: true,
    tab_id: tabId,
    page_token: out.tok,
    count: out.count,
    truncated: !!out.truncated,
    matches: out.matches || [],
    hint: "把 matches[].ref 原样传给 act/click|type|scroll|drag; 页面重新加载后旧 ref 失效, 重新 observe + find 即可。",
  };
}

// ---------------------------------------------------------------- scroll
/*
 * 滚动。两种模式:
 *   带 ref   -> 先门禁校验该元素, 以它为锚点滚动到视口(扩展以坐标处发 mouseWheel)
 *   带 direction(up/down/left/right) + amount -> 直接滚动页面(无 ref, 不做归因取证)
 * 滚动走 CDP mouseWheel 真输入, 且不是不可逆写操作, 归因要求比 click/type 宽松。
 */
async function scroll(opts) {
  const o = opts || {};
  if (!o.ref && !o.direction) {
    const e = new Error("act/scroll 需要 ref 或 direction(up/down/left/right)");
    e.status = 400;
    throw e;
  }
  const t0 = Date.now();
  let tabId = o.tabId;
  let target = null;
  let res = null;

  if (o.ref) {
    const r0 = await resolveTarget(o.tabId, o.ref, wantTokOf(o.ref, o.page_token), o.quiet_ms);
    res = r0.res;
    tabId = r0.tabId;
    if (res.stale) {
      log("action", `scroll rejected: ${res.stale} ref=${o.ref}`);
      return receipt({
        stale: res.stale,
        stale_reason: res.why,
        target: { ref: o.ref },
        dispatched: false,
        hit: res.hit,
        retryable: res.stale === "REF_NOT_PRESENTED" || res.stale === "NOT_VISIBLE",
        note: "派发前门禁拒绝, 浏览器未收到任何输入。",
      });
    }
    target = res.target;
  }

  const d = await dispatchScroll(tabId, target, o);
  if (d.dispatched !== true) {
    return receipt({
      target,
      dispatched: d.dispatched,
      mechanism: "wheel",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: d.dispatched === false,
      note: d.dispatched === "unknown"
        ? "滚动结果未知(超时): 可能已滚动, 请重新 observe 确认页面位置。"
        : "滚动失败: " + (d.error || "unknown"),
    });
  }

  if (!res) {
    return receipt({
      target: null,
      input_kind: "trusted",
      dispatched: true,
      mechanism: "wheel",
      effect: {
        verdict: "none",
        signals: [`wheel:${d.deltaX},${d.deltaY}`],
        elapsed_ms: Date.now() - t0,
      },
      postcondition: { met: true, checks: [] },
      retryable: false,
    });
  }

  const s = await settle(tabId, o.ref, res, o.expect, o.settle_ms);
  const verdict = verdictOf(s, res.quiet);
  return receipt({
    target,
    input_kind: "trusted",
    dispatched: true,
    mechanism: "wheel",
    hit: target.hit,
    effect: { verdict, signals: effectFromSettle(s).signals, elapsed_ms: s.elapsed_ms || Date.now() - t0 },
    postcondition: postconditionOf(s, o.expect),
    retryable: verdict === "none",
  });
}

// ---------------------------------------------------------------- drag
/*
 * 拖拽。from 必须给 ref; to 给 ref 或 to_x/to_y 坐标。
 * 两个端点都要过门禁(resolve); CDP 序列 moved→pressed→moved→released 全真输入。
 */
async function drag(opts) {
  const o = opts || {};
  if (!o.from) {
    const e = new Error("act/drag 需要 from(ref)");
    e.status = 400;
    throw e;
  }
  if (!o.to && (o.to_x == null || o.to_y == null)) {
    const e = new Error("act/drag 需要 to(ref) 或 to_x/to_y(坐标)");
    e.status = 400;
    throw e;
  }
  const t0 = Date.now();

  const r0 = await resolveTarget(o.tabId, o.from, wantTokOf(o.from, o.page_token), o.quiet_ms);
  const res = r0.res;
  const tabId = r0.tabId;
  if (res.stale) {
    log("action", `drag rejected(from): ${res.stale} ref=${o.from}`);
    return receipt({
      stale: res.stale,
      stale_reason: res.why,
      target: { ref: o.from },
      dispatched: false,
      hit: res.hit,
      retryable: res.stale === "REF_NOT_PRESENTED" || res.stale === "NOT_VISIBLE",
      note: "派发前门禁拒绝(from 端点), 浏览器未收到任何输入。",
    });
  }
  const fromTarget = res.target;

  let toTarget;
  if (o.to) {
    const r1 = await resolveTarget(tabId, o.to, wantTokOf(o.to, o.page_token), o.quiet_ms);
    if (r1.res.stale) {
      log("action", `drag rejected(to): ${r1.res.stale} ref=${o.to}`);
      return receipt({
        stale: r1.res.stale,
        stale_reason: r1.res.why,
        target: { ref: o.to },
        dispatched: false,
        hit: r1.res.hit,
        retryable: r1.res.stale === "REF_NOT_PRESENTED" || r1.res.stale === "NOT_VISIBLE",
        note: "派发前门禁拒绝(to 端点), 浏览器未收到任何输入。",
      });
    }
    toTarget = r1.res.target;
  } else {
    toTarget = { cx: Math.round(Number(o.to_x)), cy: Math.round(Number(o.to_y)) };
  }

  const d = await dispatchDrag(tabId, fromTarget, toTarget, o);
  if (d.dispatched !== true) {
    return receipt({
      target: { from: fromTarget, to: toTarget },
      dispatched: d.dispatched,
      mechanism: "drag",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: d.dispatched === false,
      note: d.dispatched === "unknown"
        ? "拖拽结果未知(超时): 可能已生效, 请重新 observe 确认。"
        : "拖拽失败: " + (d.error || "unknown"),
    });
  }

  const s = await settle(tabId, o.from, res, o.expect, o.settle_ms);
  const verdict = verdictOf(s, res.quiet);
  return receipt({
    target: { from: fromTarget, to: toTarget },
    input_kind: "trusted",
    dispatched: true,
    mechanism: "drag",
    hit: fromTarget.hit,
    effect: { verdict, signals: effectFromSettle(s).signals, elapsed_ms: s.elapsed_ms || Date.now() - t0 },
    postcondition: postconditionOf(s, o.expect),
    retryable: verdict === "none",
  });
}

// ---------------------------------------------------------------- select
/*
 * 下拉选择。两种下拉统一成一个动作:
 *   原生 <select>           -> 页面脚本设 value + 派发 change(快, 但非受信点击, input_kind=synthetic)
 *   自定义下拉(div 模拟)     -> 点开触发器 -> 重新 observe -> find 选项文本 -> 点选项(真输入 trusted)
 * 参数: ref + value(原生, 匹配 option 的 value 或文本) 或 option_text(自定义, 匹配显示文本)
 */
async function select(opts) {
  const o = opts || {};
  if (!o.ref) {
    const e = new Error("act/select 需要 ref(先调 act/observe 取)");
    e.status = 400;
    throw e;
  }
  const want = o.value != null ? String(o.value) : (o.option_text != null ? String(o.option_text) : null);
  if (want == null) {
    const e = new Error("act/select 需要 value(原生 select) 或 option_text(自定义下拉)");
    e.status = 400;
    throw e;
  }
  const t0 = Date.now();

  const r0 = await resolveTarget(o.tabId, o.ref, wantTokOf(o.ref, o.page_token), o.quiet_ms);
  const res = r0.res;
  const tabId = r0.tabId;
  if (res.stale) {
    log("action", `select rejected: ${res.stale} ref=${o.ref}`);
    return receipt({
      stale: res.stale,
      stale_reason: res.why,
      target: { ref: o.ref },
      dispatched: false,
      hit: res.hit,
      retryable: res.stale === "REF_NOT_PRESENTED" || res.stale === "NOT_VISIBLE" || res.stale === "OBSCURED",
      note: "派发前门禁拒绝, 浏览器未收到任何输入。",
    });
  }
  const target = res.target;

  // --- 原生 <select>: 快速路径(JS 设值) ---
  if (target.tag === "select") {
    const { out } = await evalInPage(tabId, probe.nativeSelectScript(o.ref, want), 20000);
    if (!out || out.ok !== true) {
      const why = (out && out.why) || "unknown";
      log("action", `select native rejected: ${why} ref=${o.ref}`);
      return receipt({
        target,
        dispatched: false,
        mechanism: "select",
        effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
        retryable: why === "option_not_found",
        note: why === "option_not_found"
          ? `原生下拉里没有匹配 "${want}" 的选项。可用: ${JSON.stringify((out && out.available) || [])}`
          : `原生 <select> 设值失败: ${why}`,
      });
    }
    const s = await settle(tabId, o.ref, res, o.expect, o.settle_ms);
    const verdict = verdictOf(s, res.quiet);
    return receipt({
      target,
      input_kind: "synthetic",
      dispatched: true,
      mechanism: "select",
      hit: target.hit,
      effect: { verdict, signals: effectFromSettle(s).signals, elapsed_ms: s.elapsed_ms || Date.now() - t0 },
      postcondition: postconditionOf(s, o.expect),
      retryable: verdict === "none",
      note: `原生 <select> 用 JS 设值 + change 事件(非受信, input_kind=synthetic)。值 ${out.before} -> ${out.value} ("${out.text}")`,
    });
  }

  // --- 自定义下拉: 点开 -> 观察 -> 找选项 -> 点选项 ---
  const d0 = await dispatchClick(tabId, target, o);
  if (d0.dispatched !== true) {
    return receipt({
      target,
      dispatched: d0.dispatched,
      mechanism: "select",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: d0.dispatched === false,
      note: d0.dispatched === "unknown"
        ? "点开下拉超时, 结果未知; 请重新 observe 看下拉是否已展开。"
        : "点开下拉失败: " + (d0.error || "unknown"),
    });
  }
  if (d0.withheld) {
    return receipt({
      target,
      input_kind: d0.trusted ? "trusted" : "synthetic",
      dispatched: true,
      mechanism: "select",
      hit: target.hit,
      withheld: true,
      swapped: { before: d0.target_before, after: d0.target_after },
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: true,
      note: "点开下拉被扣发(按下后目标变了), 下拉未展开。",
    });
  }

  // 重新 observe 拿下拉展开后的选项(它们是新出现的元素)
  const ob = await observe({ tabId, max: OBSERVE_MAX, timeout_ms: o.timeout_ms });

  // 找选项: 按显示文本精确匹配, 排除触发器自己(它可能正显示着同一段文本)
  const f = await find({ tabId, filters: [{ field: "text", value: want, op: "equals" }], max: 100, timeout_ms: o.timeout_ms });
  const opt = (f.matches || []).filter((m) => m.ref !== o.ref)[0];
  if (!opt || opt.cx == null || opt.cy == null) {
    const cands = (f.matches || []).map((m) => m.name).filter(Boolean).slice(0, 20);
    log("action", `select option not found: want=${want} candidates=${cands.join("|")}`);
    return receipt({
      target,
      input_kind: d0.trusted ? "trusted" : "synthetic",
      dispatched: true,
      mechanism: "select",
      hit: target.hit,
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: true,
      note: `已点开下拉, 但没找到选项文本 "${want}"。候选项: ${cands.join(", ") || "(空)"}`,
    });
  }

  const d1 = await dispatchClick(tabId, { cx: opt.cx, cy: opt.cy }, o);
  if (d1.dispatched !== true) {
    return receipt({
      target,
      dispatched: d1.dispatched,
      mechanism: "select",
      effect: { verdict: "none", signals: [], elapsed_ms: Date.now() - t0 },
      retryable: d1.dispatched === false,
      note: d1.dispatched === "unknown"
        ? "点选项超时, 结果未知; 请重新 observe 看选项是否已选中。"
        : "点选项失败: " + (d1.error || "unknown"),
    });
  }

  const s = await settle(tabId, o.ref, res, o.expect, o.settle_ms);
  const verdict = verdictOf(s, res.quiet);
  return receipt({
    target,
    input_kind: d1.trusted ? "trusted" : "synthetic",
    dispatched: true,
    mechanism: "select",
    hit: target.hit,
    effect: { verdict, signals: effectFromSettle(s).signals, elapsed_ms: s.elapsed_ms || Date.now() - t0 },
    postcondition: postconditionOf(s, o.expect),
    retryable: verdict === "none",
    note: `自定义下拉: 点开触发器 -> 定位选项 -> 点击选项 "${opt.name}"`,
  });
}

// ---------------------------------------------------------------- run
/*
 * 多步编排: 一个任务 = 动作序列。逐步执行, 每步独立回执。
 * 默认 fail-fast(任一步失败即停), continueOnError 则继续跑完。
 * 每步可继承 run 级 tabId/page_token, 也可单步覆盖。
 */
const RUNNERS = { observe, find, click, type, select, scroll, drag };

async function run(opts) {
  const o = opts || {};
  if (!Array.isArray(o.steps) || o.steps.length === 0) {
    const e = new Error("act/run 需要 steps 数组(每项含 action)");
    e.status = 400;
    throw e;
  }
  const results = [];
  let failedAt = null;
  for (let i = 0; i < o.steps.length; i++) {
    const step = o.steps[i] || {};
    const fn = RUNNERS[step.action];
    if (!fn) {
      failedAt = i;
      results.push({ index: i, action: step.action || null, ok: false, error: "未知动作: " + (step.action || "(空)") });
      break;
    }
    try {
      const args = Object.assign({}, step, {
        tabId: step.tabId != null ? step.tabId : o.tabId,
        page_token: step.page_token != null ? step.page_token : o.page_token,
      });
      delete args.action;
      const r = await fn(args);
      // 硬失败口径: 门禁拒绝(stale) / 派发失败或未知(dispatched=false|"unknown") / 显式 ok:false
      const ok = !!(r && r.ok !== false && !r.stale && r.dispatched !== false && r.dispatched !== "unknown");
      results.push({ index: i, action: step.action, ok, receipt: r });
      if (!ok) {
        failedAt = i;
        if (!o.continueOnError) break;
      }
    } catch (e) {
      failedAt = i;
      results.push({ index: i, action: step.action, ok: false, error: String((e && e.message) || e) });
      if (!o.continueOnError) break;
    }
  }
  return {
    ok: failedAt == null,
    total: o.steps.length,
    done: results.length,
    failed_at: failedAt,
    continue_on_error: !!o.continueOnError,
    steps: results,
  };
}

module.exports = { observe, click, type, find, scroll, drag, select, run, INPUT_KIND };
