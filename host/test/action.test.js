"use strict";
/*
 * 可信动作层单测(v1.8.0)
 * 全程 mock util.callTool, 不碰真浏览器、不发 native messaging。
 * 覆盖方案文档里承诺的每一条契约:
 *   - known-set 拒绝未观察的 ref, 且拒绝时绝不派发
 *   - DOCUMENT_CHANGED / OBSCURED / DISABLED 各有明确 stale 值
 *   - 超时 -> dispatched:"unknown" 且 retryable:false, 派发只发生一次
 *   - verdict 三态: 强信号 changed / 弱信号+页面在动 unattributable / 弱信号+页面静止 changed
 *   - postcondition 逐条 met/unmet
 *   - type 先聚焦点击再键入
 */
const test = require("node:test");
const assert = require("node:assert");
const util = require("../lib/util");
const action = require("../lib/action");

const TAB = 77;
let calls = [];

function reply(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj) }] };
}

function page(obj) {
  return reply({ success: true, tabId: TAB, result: obj });
}

/*
 * 装 mock: impl.resolve() / impl.settle() / impl.observe() 提供三段脚本各自的返回值。
 * dispatch 决定 chrome_computer 的反应('ok' | 'timeout' | 'error')。
 */
function mock(impl) {
  calls = [];
  const dispatch = impl.dispatch || "ok";
  util.callTool = async (name, args) => {
    calls.push({ name, args });
    if (name === "chrome_computer") {
      if (impl.computer) return reply(impl.computer(args));
      if (dispatch === "timeout") throw new Error("tool call timed out after 30000ms: chrome_computer");
      if (dispatch === "error") return reply({ success: false, error: "click failed" });
      return reply({ success: true, action: args.action, trusted: true, transport: "cdp", withheld: false });
    }
    if (name !== "chrome_javascript") throw new Error("unexpected tool: " + name);
    const code = args.code || "";
    if (code.indexOf("var LIMIT =") >= 0) return page(impl.settle ? impl.settle() : { verdict: "none", checks: [] });
    if (code.indexOf("var FILTERS =") >= 0) return page(impl.find ? impl.find() : {});
    if (code.indexOf("var VALUE =") >= 0) return page(impl.nativeSelect ? impl.nativeSelect() : { ok: true, kind: "native", before: "a", value: "b", text: "B" });
    if (code.indexOf("var REF =") >= 0) return page(impl.resolve ? impl.resolve() : {});
    if (code.indexOf("var SEL =") >= 0) return page(impl.observe ? impl.observe() : {});
    throw new Error("unrecognized injected script");
  };
}

function resolveOk(over) {
  return Object.assign({
    stale: null,
    tok: "p1a.r",
    quiet: 0,
    target: { ref: "p1a.r3", tag: "button", role: "button", name: "搜索", cx: 420, cy: 310, hit: "self", in_view: true, rect: { x: 400, y: 295 } },
    before: { uh: 111, path: "/list", title: "列表", mut: 10, focus: null, ready: "complete" },
    base: { value: null, checked: null, disabled: false },
  }, over || {});
}

const CHANGED = { verdict: "changed", signal: "url_changed", elapsed_ms: 320, checks: [], alive: true };
const CALLS_TO_TOOL = (n) => calls.filter((c) => c.name === n).length;

// ------------------------------------------------------------------ observe
test("observe: 返回 page_token 与元素清单, ref 也带 pageToken 前缀", async () => {
  mock({
    observe: () => ({
      tok: "p1a.r",
      state: { path: "/list", title: "订单列表" },
      scanned: 12,
      shown: 2,
      truncated: true,
      elements: [
        { ref: "p1a.r1", tag: "input", role: "textbox", name: "搜索框", hit: "self", in_view: true, disabled: false, rect: { x: 10, y: 20, cx: 60, cy: 34 } },
        { ref: "p1a.r2", tag: "button", role: "button", name: "查询", hit: "self", in_view: true, disabled: false, rect: { x: 90, y: 20, cx: 110, cy: 34 } },
      ],
    }),
  });
  const r = await action.observe({ tabId: TAB });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.tab_id, TAB);
  assert.strictEqual(r.page_token, "p1a.r");
  assert.strictEqual(r.shown, 2);
  assert.strictEqual(r.truncated, true);
  assert.ok(r.elements.every((e) => e.ref.indexOf("p1a.r") === 0), "ref 必须以 pageToken 为前缀");
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0, "observe 不应派发任何输入");
});

// ------------------------------------------------------------- known-set
test("known-set: 未 observe 过的 ref 被拒绝, 且浏览器一个输入都没收到", async () => {
  mock({ resolve: () => ({ stale: "REF_NOT_PRESENTED", tok: "p1a.r", why: "该 ref 不在本页观察集合里" }) });
  const r = await action.click({ ref: "p1a.r999" });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.stale, "REF_NOT_PRESENTED");
  assert.strictEqual(r.dispatched, false);
  assert.match(r.stale_reason, /观察集合/);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0, "门禁拒绝后绝不派发");
});

test("DOCUMENT_CHANGED: 页面换文档后旧 ref 明确失效, 原因可读", async () => {
  mock({ resolve: () => ({ stale: "DOCUMENT_CHANGED", tok: "p9z.q", why: "页面已重新加载或更换文档" }) });
  const r = await action.click({ ref: "p1a.r3", page_token: "p1a.r" });
  assert.strictEqual(r.stale, "DOCUMENT_CHANGED");
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0);
});

test("OBSCURED / DISABLED: 遮挡与禁用分别报错, 并能重试判定区分", async () => {
  mock({ resolve: () => ({ stale: "OBSCURED", tok: "p1a.r", hit: "overlay:div.mask", why: "目标被其他元素遮挡" }) });
  const a = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(a.stale, "OBSCURED");
  assert.strictEqual(a.hit, "overlay:div.mask");
  assert.strictEqual(a.retryable, true, "遮挡属于环境问题, 可重试");

  mock({ resolve: () => ({ stale: "DISABLED", tok: "p1a.r", hit: "self", why: "元素处于禁用态" }) });
  const b = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(b.stale, "DISABLED");
  assert.strictEqual(b.retryable, false, "禁用是确定性拒绝, 重试无意义");
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0);
});

// ------------------------------------------------------------- 超时不重试
test("超时: dispatched=unknown, retryable=false, 且只派发一次(绝不双发)", async () => {
  mock({ resolve: () => resolveOk(), dispatch: "timeout" });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.dispatched, "unknown");
  assert.strictEqual(r.retryable, false);
  assert.match(r.note, /双发/);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 1, "超时后严禁重新派发");
  assert.strictEqual(CALLS_TO_TOOL("chrome_javascript"), 1, "超时后也不该再跑 settle");
});

test("派发失败(非超时): dispatched=false 且允许重试", async () => {
  mock({ resolve: () => resolveOk(), dispatch: "error" });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.retryable, true);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 1);
});

// ------------------------------------------------------------- verdict 三态
test("verdict: 强信号(URL 变化) -> changed", async () => {
  mock({ resolve: () => resolveOk(), settle: () => CHANGED });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.effect.verdict, "changed");
  assert.ok(r.effect.signals.some((s) => s.indexOf("url_changed") >= 0));
  assert.strictEqual(r.reached_target, null, "无法证明输入到达时必须为 null, 不假装 true");
  assert.strictEqual(r.input_kind, "trusted", "扩展回报 trusted 时才标 trusted");
});

test("旧扩展不回报 trusted -> input_kind 如实降级为 synthetic, 不冒充真输入", async () => {
  mock({
    resolve: () => resolveOk(),
    settle: () => CHANGED,
    computer: (args) => ({ success: true, action: args.action }), // 老版本扩展的回包, 没有 trusted 字段
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.input_kind, "synthetic");
});

// ------------------------------------------------------------- 阶段 C: withheld
test("withheld: press 后目标变了 -> 扣发 release, 判 none 且不跑 settle", async () => {
  mock({
    resolve: () => resolveOk(),
    settle: () => CHANGED,
    computer: () => ({
      success: true, action: "left_click", transport: "cdp", trusted: true,
      withheld: true, target_before: "BUTTON#go", target_after: "DIV.toast<BUTTON#go",
    }),
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.withheld, true);
  assert.strictEqual(r.effect.verdict, "none");
  assert.strictEqual(r.retryable, true);
  assert.deepStrictEqual(r.swapped, { before: "BUTTON#go", after: "DIV.toast<BUTTON#go" });
  assert.match(r.note, /没有激活任何元素/);
  assert.strictEqual(CALLS_TO_TOOL("chrome_javascript"), 1, "扣发后不该再跑 settle");
});

test("type: 聚焦点击被扣发 -> 停止键入, 文字不会打到别处", async () => {
  mock({
    resolve: () => resolveOk({ target: { ref: "p1a.r9", tag: "input", role: "textbox", name: "搜索", cx: 200, cy: 100, hit: "self", in_view: true } }),
    computer: () => ({ success: true, trusted: true, withheld: true, target_before: "INPUT#kw", target_after: "DIV.mask" }),
  });
  const r = await action.type({ ref: "p1a.r9", text: "金银花" });
  assert.strictEqual(r.withheld, true);
  assert.strictEqual(r.mechanism, "keyboard");
  assert.match(r.note, /停止键入/);
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu.length, 1, "只允许有那次聚焦点击, 不得继续 insertText");
});

test("verdict: 弱信号(仅 mutation) + 派发前页面就在动 -> unattributable, 不冒领", async () => {
  mock({
    resolve: () => resolveOk({ quiet: 37 }),
    settle: () => ({ verdict: "weak", signal: "mutations:12", elapsed_ms: 1500, checks: [], alive: true }),
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.effect.verdict, "unattributable");
  assert.match(r.note, /无法归因/);
});

test("verdict: 弱信号 + 派发前页面静止 -> changed(变动可归因于本次动作)", async () => {
  mock({
    resolve: () => resolveOk({ quiet: 0 }),
    settle: () => ({ verdict: "weak", signal: "mutations:5", elapsed_ms: 900, checks: [], alive: true }),
  });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.effect.verdict, "changed");
});

test("verdict: 完全无信号 -> none, 且标为可重试", async () => {
  mock({ resolve: () => resolveOk(), settle: () => ({ verdict: "none", signal: null, elapsed_ms: 1500, checks: [], alive: true }) });
  const r = await action.click({ ref: "p1a.r3" });
  assert.strictEqual(r.effect.verdict, "none");
  assert.strictEqual(r.retryable, true);
});

// ------------------------------------------------------------- postcondition
test("postcondition: 期望逐条判定, 任一 unmet 则整体不通过", async () => {
  mock({
    resolve: () => resolveOk(),
    settle: () => CHANGED,
  });
  // 第一条 met / 第二条 unmet
  util.callTool = (orig => async (name, args) => {
    if (name === "chrome_javascript" && (args.code || "").indexOf("var LIMIT =") >= 0) {
      return page({
        verdict: "changed", signal: "url_changed", elapsed_ms: 200, alive: true,
        checks: [
          { expect: "url", value: "/search", ok: true },
          { expect: "text", value: "共 0 条", ok: false },
        ],
      });
    }
    return orig(name, args);
  })(util.callTool);

  const r = await action.click({ ref: "p1a.r3", expect: [{ expect: "url", value: "/search" }, { expect: "text", value: "共 0 条" }] });
  assert.strictEqual(r.postcondition.met, false);
  assert.strictEqual(r.postcondition.checks.length, 2);
  assert.strictEqual(r.postcondition.checks[0].ok, true);
  assert.strictEqual(r.postcondition.checks[1].ok, false);
});

// ------------------------------------------------------------- type
test("type: 先点击聚焦再键入, 顺序与机制正确", async () => {
  mock({
    resolve: () => resolveOk({ target: { ref: "p1a.r9", tag: "input", role: "textbox", name: "搜索", cx: 200, cy: 100, hit: "self", in_view: true } }),
    settle: () => ({ verdict: "changed", signal: "focus_moved", elapsed_ms: 120, checks: [], alive: true }),
  });
  const r = await action.type({ ref: "p1a.r9", text: "金银花", mode: "replace" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.mechanism, "keyboard");
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu.length, 3, "replace 模式: 聚焦点击 + ctrl+a + 键入");
  assert.strictEqual(cpu[0].args.action, "left_click");
  assert.strictEqual(cpu[1].args.action, "key");
  assert.strictEqual(cpu[1].args.text, "ctrl+a");
  assert.strictEqual(cpu[2].args.action, "type");
  assert.strictEqual(cpu[2].args.text, "金银花");
  assert.ok(!("ref" in cpu[2].args), "不能把自己的 ref 透给扩展(那是另一套 ref 体系)");
});

test("type: 缺少 text 直接 400, 不碰浏览器", async () => {
  mock({});
  await assert.rejects(() => action.type({ ref: "p1a.r9" }), (e) => e.status === 400);
  assert.strictEqual(calls.length, 0);
});

// ------------------------------------------------------------- find
test("find: 语义匹配返回 matches, 不派发任何输入", async () => {
  mock({
    find: () => ({
      tok: "p1a.r",
      count: 1,
      truncated: false,
      matches: [
        { ref: "p1a.r5", tag: "input", role: "textbox", name: "手机号", label: null, placeholder: "请输入手机号", id: "mobile", name_attr: "phone" },
      ],
    }),
  });
  const r = await action.find({ tabId: TAB, filters: [{ field: "placeholder", value: "手机号" }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.matches[0].ref, "p1a.r5");
  assert.strictEqual(r.matches[0].placeholder, "请输入手机号");
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0, "find 不派发输入");
});

// ------------------------------------------------------------- scroll
test("scroll(direction): 直接滚动页面, 不 resolve 不 settle", async () => {
  mock({
    computer: (args) => ({ success: true, action: "scroll", coordinates: null, deltaX: 0, deltaY: 300 }),
  });
  const r = await action.scroll({ direction: "down", amount: 3 });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.mechanism, "wheel");
  assert.strictEqual(r.input_kind, "trusted");
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu.length, 1);
  assert.strictEqual(cpu[0].args.action, "scroll");
  assert.strictEqual(cpu[0].args.scrollDirection, "down");
  assert.strictEqual(cpu[0].args.scrollAmount, 3);
  assert.strictEqual(CALLS_TO_TOOL("chrome_javascript"), 0, "direction 模式不注入任何脚本");
});

test("scroll(ref): 先门禁再滚动, 走 settle 取证", async () => {
  mock({ resolve: () => resolveOk(), settle: () => CHANGED });
  const r = await action.scroll({ ref: "p1a.r3" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.effect.verdict, "changed");
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu[0].args.coordinates.x, 420, "以 ref 元素中心为滚动锚点");
  assert.strictEqual(cpu[0].args.coordinates.y, 310);
});

test("scroll: 缺少 ref 和 direction -> 400", async () => {
  mock({});
  await assert.rejects(() => action.scroll({}), (e) => e.status === 400);
  assert.strictEqual(calls.length, 0);
});

// ------------------------------------------------------------- drag
test("drag(ref->ref): 两个端点都过门禁, 走 CDP 拖拽并 settle", async () => {
  mock({ resolve: () => resolveOk(), settle: () => CHANGED });
  const r = await action.drag({ from: "p1a.r3", to: "p1a.r9" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.mechanism, "drag");
  assert.strictEqual(r.input_kind, "trusted");
  assert.strictEqual(r.effect.verdict, "changed");
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu.length, 1);
  assert.strictEqual(cpu[0].args.action, "left_click_drag");
  assert.deepStrictEqual(cpu[0].args.startCoordinates, { x: 420, y: 310 });
  assert.deepStrictEqual(cpu[0].args.coordinates, { x: 420, y: 310 });
  assert.strictEqual(CALLS_TO_TOOL("chrome_javascript"), 3, "resolve(from) + resolve(to) + settle");
});

test("drag(ref->坐标): to 用 to_x/to_y, 只 resolve 起点一次", async () => {
  mock({ resolve: () => resolveOk(), settle: () => CHANGED });
  const r = await action.drag({ from: "p1a.r3", to_x: 500, to_y: 600 });
  assert.strictEqual(r.dispatched, true);
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.deepStrictEqual(cpu[0].args.coordinates, { x: 500, y: 600 });
  assert.strictEqual(CALLS_TO_TOOL("chrome_javascript"), 2, "resolve(from) + settle");
});

test("drag: to 端点 stale -> 拒绝且不派发", async () => {
  let n = 0;
  mock({
    resolve: () => (++n === 1 ? resolveOk() : { stale: "NOT_VISIBLE", tok: "p1a.r", hit: "self", why: "元素不可见" }),
  });
  const r = await action.drag({ from: "p1a.r3", to: "p1a.r9" });
  assert.strictEqual(r.stale, "NOT_VISIBLE");
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0);
});

test("drag: 缺少 from 或 to -> 400", async () => {
  mock({});
  await assert.rejects(() => action.drag({ from: "p1a.r3" }), (e) => e.status === 400);
  await assert.rejects(() => action.drag({}), (e) => e.status === 400);
  assert.strictEqual(calls.length, 0);
});

// ------------------------------------------------------------- select
function resolveTag(tag) {
  return Object.assign(resolveOk(), {
    target: { ref: "p1a.r3", tag: tag, role: tag === "select" ? "combobox" : "button", name: "选择", cx: 420, cy: 310, hit: "self", in_view: true, rect: { x: 400, y: 295 } },
  });
}

test("select(原生): JS 设值走 synthetic, 不点鼠标", async () => {
  mock({
    resolve: () => resolveTag("select"),
    nativeSelect: () => ({ ok: true, kind: "native", before: "a", value: "b", text: "选项B" }),
    settle: () => CHANGED,
  });
  const r = await action.select({ ref: "p1a.r3", value: "b" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.mechanism, "select");
  assert.strictEqual(r.input_kind, "synthetic", "原生 select 是 JS 设值, 非受信点击");
  assert.strictEqual(r.effect.verdict, "changed");
  assert.strictEqual(CALLS_TO_TOOL("chrome_computer"), 0, "原生 select 不派发鼠标事件");
});

test("select(原生): 选项不存在 -> 拒绝并列出可用项", async () => {
  mock({
    resolve: () => resolveTag("select"),
    nativeSelect: () => ({ ok: false, why: "option_not_found", available: [{ value: "x", text: "甲" }, { value: "y", text: "乙" }] }),
  });
  const r = await action.select({ ref: "p1a.r3", value: "不存在" });
  assert.strictEqual(r.dispatched, false);
  assert.strictEqual(r.retryable, true);
  assert.match(r.note, /可用/);
});

test("select(自定义): 点开->找选项->点选项, 真输入 trusted", async () => {
  mock({
    resolve: () => resolveTag("div"),
    observe: () => ({ tok: "p1a.r", state: { path: "/form" }, scanned: 5, shown: 5, truncated: false, elements: [] }),
    find: () => ({ tok: "p1a.r", count: 1, truncated: false, matches: [{ ref: "p1a.r9", tag: "li", role: "option", name: "上海市", cx: 400, cy: 500 }] }),
    settle: () => CHANGED,
  });
  const r = await action.select({ ref: "p1a.r3", option_text: "上海市" });
  assert.strictEqual(r.dispatched, true);
  assert.strictEqual(r.mechanism, "select");
  assert.strictEqual(r.input_kind, "trusted", "点选项走 CDP 真输入");
  const cpu = calls.filter((c) => c.name === "chrome_computer");
  assert.strictEqual(cpu.length, 2, "点开触发器 + 点选项");
  assert.strictEqual(cpu[0].args.action, "left_click");
  assert.deepStrictEqual(cpu[1].args.coordinates, { x: 400, y: 500 });
});

test("select: 缺少 value/option_text -> 400", async () => {
  mock({});
  await assert.rejects(() => action.select({ ref: "p1a.r3" }), (e) => e.status === 400);
  assert.strictEqual(calls.length, 0);
});

// ------------------------------------------------------------- run
test("run: 多步顺序执行, 全成功 ok=true done=全部", async () => {
  mock({ resolve: () => resolveOk(), settle: () => CHANGED });
  const r = await action.run({
    steps: [
      { action: "scroll", direction: "down", amount: 2 },
      { action: "click", ref: "p1a.r3" },
    ],
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.done, 2);
  assert.strictEqual(r.failed_at, null);
  assert.strictEqual(r.steps[0].ok, true);
  assert.strictEqual(r.steps[1].ok, true);
});

test("run: fail-fast 第一步失败即停", async () => {
  mock({ resolve: () => ({ stale: "REF_NOT_PRESENTED", tok: "p1a.r", why: "不在观察集合" }) });
  const r = await action.run({
    steps: [
      { action: "click", ref: "p1a.r999" },
      { action: "scroll", direction: "down", amount: 2 },
    ],
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.done, 1);
  assert.strictEqual(r.failed_at, 0);
});

test("run: continueOnError 继续跑完", async () => {
  let resolveN = 0;
  mock({
    resolve: () => (++resolveN === 1 ? { stale: "REF_NOT_PRESENTED", tok: "p1a.r", why: "不在观察集合" } : resolveOk()),
    settle: () => CHANGED,
  });
  const r = await action.run({
    continueOnError: true,
    steps: [
      { action: "click", ref: "p1a.r999" },
      { action: "click", ref: "p1a.r3" },
    ],
  });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.done, 2);
  assert.strictEqual(r.failed_at, 0);
  assert.strictEqual(r.steps[0].ok, false);
  assert.strictEqual(r.steps[1].ok, true);
});

test("run: 未知动作 -> 立即失败并报错", async () => {
  mock({});
  const r = await action.run({ steps: [{ action: "nope" }] });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.failed_at, 0);
  assert.match(r.steps[0].error, /未知动作/);
  assert.strictEqual(calls.length, 0);
});

test("run: 缺少 steps -> 400", async () => {
  mock({});
  await assert.rejects(() => action.run({}), (e) => e.status === 400);
});
