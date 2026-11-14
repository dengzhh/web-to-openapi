"use strict";
/*
 * 站点: 可信动作层(不绑定任何具体网站)
 * ---------------------------------------------------------------------------
 * 三个端点, 全部返回结构化 ActionReceipt:
 *   POST /api/v1/act/observe  -> 观察页面, 分配本项目自己的 ref(<pageToken>.r<N>)
 *   POST /api/v1/act/click    -> 点击, 带回执
 *   POST /api/v1/act/type     -> 聚焦 + 键入文本, 带回执
 *
 * 与 /api/v1/tools/{name} 透传的区别:
 *   透传只知道"发出去了"; 这里知道"有没有把关、发没发出去、页面变没变、变化能不能归因"。
 *   写操作请走这三个端点, 别直接用 chrome_computer —— 那样拿不到回执。
 */
const action = require("../lib/action");
const { toSearchParams, truthy } = require("../lib/util");

function num(v, def) {
  // URLSearchParams.get() 对不存在的键返回 null, 而 Number(null)===0;
  // 若不挡掉会把"未传"解析成 0, 导致 find/observe 的 max 被压成 1。null/undefined/空串都视为未传。
  if (v == null || v === "") return def;
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

// 统一 GET 查询串 / POST JSON body
function parseInput(input) {
  const isSp = input instanceof URLSearchParams;
  const sp = isSp ? input : toSearchParams(input);
  const raw = isSp ? null : (input || {});

  const expectRaw = raw && Array.isArray(raw.expect) ? raw.expect : null;
  const expect = [];
  if (expectRaw) {
    for (const e of expectRaw) {
      if (!e || typeof e !== "object" || !e.expect) continue;
      expect.push({ expect: String(e.expect), value: e.value });
    }
  } else if (isSp) {
    // GET 只支持单个简单断言: expect=url&expect_value=/foo
    const k = sp.get("expect");
    if (k) expect.push({ expect: String(k), value: sp.get("expect_value") });
  }

  // find 的 filters: 支持 filters 数组、单 field/value 对(GET)、或简写字段名
  const FILTER_FIELDS = ["text", "name", "label", "placeholder", "id", "role", "tag", "type"];
  const filters = [];
  if (raw && Array.isArray(raw.filters)) {
    for (const f of raw.filters) {
      if (f && typeof f === "object" && f.field) {
        filters.push({ field: String(f.field), value: f.value, op: f.op || "contains" });
      }
    }
  } else if (isSp) {
    const f = sp.get("field");
    if (f) filters.push({ field: String(f), value: sp.get("value"), op: sp.get("op") || "contains" });
  } else if (raw) {
    for (const k of Object.keys(raw)) {
      if (FILTER_FIELDS.indexOf(k) >= 0) {
        filters.push({ field: k, value: raw[k], op: "contains" });
      }
    }
  }

  const tabIdRaw = sp.get("tabId") || sp.get("tab_id");
  return {
    tabId: tabIdRaw == null || tabIdRaw === "" ? null : num(tabIdRaw, null),
    ref: sp.get("ref") || null,
    page_token: sp.get("page_token") || sp.get("pageToken") || null,
    text: sp.get("text") == null ? null : String(sp.get("text")),
    mode: sp.get("mode") || "append",
    max: num(sp.get("max"), undefined),
    quiet_ms: num(sp.get("quiet_ms"), undefined),
    settle_ms: num(sp.get("settle_ms"), undefined),
    timeout_ms: num(sp.get("timeout_ms"), undefined),
    expect,
    filters,
    direction: sp.get("direction") || null,
    amount: num(sp.get("amount"), undefined),
    from: sp.get("from") || null,
    to: sp.get("to") || null,
    to_x: sp.get("to_x") == null ? undefined : num(sp.get("to_x"), undefined),
    to_y: sp.get("to_y") == null ? undefined : num(sp.get("to_y"), undefined),
    // 三态: 不传 = undefined(action.js 默认开启真输入); 显式 false 才关闭。
    // (bug 修复: 原先 truthy() 把"未传"折叠成 false, 导致 forceCdp 永远关着, 点击落到
    //  clickTool 合成路径 —— 那条路坐标缩放有 bug, 会点到别的元素上。)
    forceCdp:
      sp.get("forceCdp") == null && sp.get("force_cdp") == null
        ? undefined
        : truthy(sp.get("forceCdp") || sp.get("force_cdp")),
    splitPress:
      sp.get("splitPress") == null && sp.get("split_press") == null
        ? undefined
        : truthy(sp.get("splitPress") || sp.get("split_press")),
    // select: value(原生 select 的 option value/文本) 或 option_text(自定义下拉显示文本)
    value: sp.get("value") == null ? null : String(sp.get("value")),
    option_text: sp.get("option_text") == null ? null : String(sp.get("option_text")),
    // run: 多步编排
    steps: raw && Array.isArray(raw.steps) ? raw.steps : null,
    continueOnError: truthy(sp.get("continueOnError") || sp.get("continue_on_error")),
  };
}

// ---------------------------------------------------------------- run
async function runObserve(p) {
  return await action.observe({ tabId: p.tabId, max: p.max, timeout_ms: p.timeout_ms });
}

async function runClick(p) {
  return await action.click({
    tabId: p.tabId,
    ref: p.ref,
    page_token: p.page_token,
    expect: p.expect,
    settle_ms: p.settle_ms,
    quiet_ms: p.quiet_ms,
    timeout_ms: p.timeout_ms,
    forceCdp: p.forceCdp,
    splitPress: p.splitPress,
  });
}

async function runType(p) {
  return await action.type({
    tabId: p.tabId,
    ref: p.ref,
    page_token: p.page_token,
    text: p.text,
    mode: p.mode,
    expect: p.expect,
    settle_ms: p.settle_ms,
    quiet_ms: p.quiet_ms,
    timeout_ms: p.timeout_ms,
    forceCdp: p.forceCdp,
  });
}

async function runFind(p) {
  return await action.find({ tabId: p.tabId, filters: p.filters, max: p.max, timeout_ms: p.timeout_ms });
}

async function runScroll(p) {
  return await action.scroll({
    tabId: p.tabId,
    ref: p.ref,
    page_token: p.page_token,
    direction: p.direction,
    amount: p.amount,
    expect: p.expect,
    settle_ms: p.settle_ms,
    quiet_ms: p.quiet_ms,
    timeout_ms: p.timeout_ms,
  });
}

async function runDrag(p) {
  return await action.drag({
    tabId: p.tabId,
    from: p.from,
    to: p.to,
    to_x: p.to_x,
    to_y: p.to_y,
    page_token: p.page_token,
    expect: p.expect,
    settle_ms: p.settle_ms,
    quiet_ms: p.quiet_ms,
    timeout_ms: p.timeout_ms,
  });
}

async function runSelect(p) {
  return await action.select({
    tabId: p.tabId,
    ref: p.ref,
    page_token: p.page_token,
    value: p.value,
    option_text: p.option_text,
    expect: p.expect,
    settle_ms: p.settle_ms,
    quiet_ms: p.quiet_ms,
    timeout_ms: p.timeout_ms,
    forceCdp: p.forceCdp,
    splitPress: p.splitPress,
  });
}

async function runRun(p) {
  return await action.run({
    tabId: p.tabId,
    page_token: p.page_token,
    steps: p.steps,
    continueOnError: p.continueOnError,
    timeout_ms: p.timeout_ms,
  });
}

const EXPECT_SCHEMA = {
  type: "array",
  description: "期望的后置条件, 逐条判 met/unmet。支持: {expect:'url',value:'/search'} 地址含子串; {expect:'text',value:'成功'} 页面文本含子串; {expect:'checked',value:true} 勾选态; {expect:'gone'} 目标消失。注意: 只有 value 长度会参与比较, 不回传明文。",
  items: {
    type: "object",
    properties: {
      expect: { type: "string", enum: ["url", "text", "value", "checked", "gone"] },
      value: {},
    },
    required: ["expect"],
  },
};

module.exports = {
  id: "actions",
  title: "可信动作层(点击/输入带回执)",
  concurrency: 1,
  endpoints: [
    {
      method: "POST",
      methods: ["POST", "GET"],
      path: "/api/v1/act/observe",
      tool: "browser_observe",
      operationId: "actObserve",
      summary: "观察当前页面并分配 ref",
      description:
        "遍历可见可交互元素, 为每个分配本项目自己的 ref(<pageToken>.r<N>), 返回清单(标签/角色/名称/坐标/是否可见/是否被遮挡)。后续 click/type 必须用这里返回的 ref: 没 observe 过的 ref 会被直接拒绝(REF_NOT_PRESENTED), 防止凭空编造元素。页面一旦重新加载 pageToken 会变, 旧 ref 全部失效并明确报 DOCUMENT_CHANGED。",
      responses: { 200: { description: "元素清单 + page_token + tab_id" }, 500: { description: "页面脚本执行失败" } },
      browser: true,
      parse: parseInput,
      run: runObserve,
      doc: {
        note: "观察页面, 拿 ref 与 page_token。这是所有点击/输入的前置步骤。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/observe \\
  -H "Content-Type: application/json" \\
  -d '{"tabId":123}'`,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/click",
      tool: "browser_click",
      operationId: "actClick",
      summary: "点击元素并返回 ActionReceipt",
      description:
        "派发前门禁(token/存活/可见/未遮挡/未禁用) → 派发 → 收敛取证 → 结构化回执。回执字段: dispatched(true/false/unknown) / reached_target(null 表示无法证明) / effect.verdict(changed/unattributable/none) / postcondition / stale / retryable。三条硬规则: 超时不重试、弱证据不冒领、未观察过的 ref 直接拒绝。",
      example: { tabId: 123, ref: "p3k2.r7", expect: [{ expect: "url", value: "/search" }] },
      responses: { 200: { description: "ActionReceipt" }, 400: { description: "缺少 ref" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runClick,
      doc: {
        note: "点击并取证。ref 必须来自 act/observe; page_token 建议一并传(不传会用当前页 token, 但无法区分跨文档)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/click \\
  -H "Content-Type: application/json" \\
  -d '{"tabId":123,"ref":"p3k2.r7","expect":[{"expect":"url","value":"/search"}]}'`,
        slow: true,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/type",
      tool: "browser_type",
      operationId: "actType",
      summary: "键入文本并返回 ActionReceipt",
      description:
        "先按 ref 真坐标点击聚焦, 再插入文本(扩展侧走 Input.insertText)。mode=append 追加 / replace 先 ctrl+a 全选再键入。返回 ActionReceipt, 字段同 click。注意: 回执里只回值长度与前 3 字符, 不回明文, 避免把密码/手机号写进日志。",
      example: { tabId: 123, ref: "p3k2.r9", text: "金银花", mode: "replace" },
      responses: { 200: { description: "ActionReceipt" }, 400: { description: "缺少 ref 或 text" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runType,
      doc: {
        note: "聚焦 + 键入。replace 模式会先 ctrl+a 全选, 适合覆盖已有内容。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/type \\
  -H "Content-Type: application/json" \\
  -d '{"tabId":123,"ref":"p3k2.r9","text":"金银花","mode":"replace"}'`,
        slow: true,
      },
    },
    {
      method: "POST",
      methods: ["POST", "GET"],
      path: "/api/v1/act/find",
      tool: "browser_find",
      operationId: "actFind",
      summary: "按语义字段查找已观察元素",
      description:
        "在 observe 登记过的集合里按 label/placeholder/name/id/text/role/tag/type 查找, 返回匹配 ref 列表。只查已知集合(known-set), 不定位没 observe 过的新元素。filters 数组 [{field,value,op}] 或简写字段名(如 {\"placeholder\":\"手机号\"})。",
      example: { filters: [{ field: "placeholder", value: "手机号" }] },
      responses: { 200: { description: "匹配清单 + page_token" }, 500: { description: "页面脚本执行失败" } },
      browser: true,
      parse: parseInput,
      run: runFind,
      doc: {
        note: "语义定位: 先 observe 再 find, 把 matches[].ref 传给后续动作。跨刷新自动重建(重新 observe + find)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/find \\
  -H "Content-Type: application/json" \\
  -d '{"filters":[{"field":"placeholder","value":"手机号"}]}'`,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/scroll",
      tool: "browser_scroll",
      operationId: "actScroll",
      summary: "滚动页面或滚动到某元素",
      description:
        "两种模式: 带 ref 则先门禁校验该元素并以它为锚点滚动到视口; 带 direction(up/down/left/right)+amount 则直接滚动页面(amount 1-10, 单位 100px)。走 CDP mouseWheel 真输入。",
      example: { direction: "down", amount: 3 },
      responses: { 200: { description: "ActionReceipt" }, 400: { description: "缺少 ref 或 direction" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runScroll,
      doc: {
        note: "滚动。带 ref 会做门禁 + 取证; 只带 direction 则直接滚(不做归因)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/scroll \\
  -H "Content-Type: application/json" \\
  -d '{"direction":"down","amount":3}'`,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/drag",
      tool: "browser_drag",
      operationId: "actDrag",
      summary: "拖拽元素并返回 ActionReceipt",
      description:
        "from 必须给 ref; to 给 ref 或 to_x/to_y 坐标。两个端点都过门禁, CDP 序列 moved→pressed→moved→released 全真输入。返回 ActionReceipt, 字段同 click。",
      example: { from: "p3k2.r3", to: "p3k2.r9" },
      responses: { 200: { description: "ActionReceipt" }, 400: { description: "缺少 from 或 to" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runDrag,
      doc: {
        note: "拖拽。to 可以是 ref 或坐标(to_x/to_y)。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/drag \\
  -H "Content-Type: application/json" \\
  -d '{"from":"p3k2.r3","to_x":400,"to_y":300}'`,
        slow: true,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/select",
      tool: "browser_select",
      operationId: "actSelect",
      summary: "下拉选择并返回 ActionReceipt",
      description:
        "统一处理两种下拉: 原生 <select> 走 JS 设值 + change 事件(快, 但非受信点击, input_kind=synthetic); 自定义下拉(div 模拟) 走 点开触发器 -> 重新 observe -> 按文本找选项 -> 点选项(真输入, trusted)。参数 ref + value(原生, 匹配 option 的 value 或文本) 或 option_text(自定义, 匹配显示文本)。",
      example: { ref: "p3k2.r7", option_text: "上海市" },
      responses: { 200: { description: "ActionReceipt" }, 400: { description: "缺少 ref 或 value/option_text" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runSelect,
      doc: {
        note: "下拉选择。原生 select 用 value; 自定义下拉用 option_text(显示文本)。找不到选项时回执会列出可用候选项。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/select \\
  -H "Content-Type: application/json" \\
  -d '{"ref":"p3k2.r7","option_text":"上海市"}'`,
        slow: true,
      },
    },
    {
      method: "POST",
      path: "/api/v1/act/run",
      tool: "browser_run",
      operationId: "actRun",
      summary: "多步动作编排(序列执行)",
      description:
        "按顺序执行 steps 数组, 每步独立 ActionReceipt 回执。step.action 支持 observe/find/click/type/select/scroll/drag; 其余字段为该动作的参数。默认 fail-fast(任一步失败即停), continueOnError=true 则继续跑完。返回 {ok,total,done,failed_at,continue_on_error,steps:[{index,action,ok,receipt|error}]}。",
      example: { steps: [{ action: "type", ref: "p3k2.r9", text: "金银花" }, { action: "click", ref: "p3k2.r13" }] },
      responses: { 200: { description: "编排汇总" }, 400: { description: "缺少 steps" }, 500: { description: "执行失败" } },
      browser: true,
      parse: parseInput,
      run: runRun,
      doc: {
        note: "多步编排。tabId/page_token 可放在顶层(各步继承)或逐条覆盖。",
        curlPost: `curl -s -X POST http://127.0.0.1:8090/api/v1/act/run \\
  -H "Content-Type: application/json" \\
  -d '{"steps":[{"action":"type","ref":"p3k2.r9","text":"金银花"},{"action":"click","ref":"p3k2.r13"}]}'`,
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "browser_observe",
      description:
        "观察当前页面(或指定 tabId), 返回可见可交互元素清单与 page_token。每项含 ref(后续点击/输入必须用它)、tag、role、name、type、disabled、rect、hit(self/descendant/overlay:...)、in_view。写操作前必须先调本工具拿 ref: 没 observe 过的 ref 会被拒绝。页面重新加载后 page_token 变化, 旧 ref 失效。",
      inputSchema: {
        type: "object",
        properties: {
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          max: { type: "integer", minimum: 1, maximum: 300, description: "最多返回多少个元素(默认 120)" },
        },
        additionalProperties: false,
      },
      browser: true,
      run: runObserve,
    },
    {
      name: "browser_click",
      description:
        "点击页面上由 browser_observe 返回的 ref, 并返回 ActionReceipt 回执。回执关键字段: dispatched=true/false/'unknown'(unknown 表示超时、可能已生效, 因此绝不会自动重试) / effect.verdict=changed|unattributable|none / postcondition.met / stale(REF_NOT_PRESENTED / DOCUMENT_CHANGED / OBSCURED / NOT_VISIBLE / DISABLED / FRAME_DETACHED, 附带原因)。派发前会做门禁: 不在观察集合、被遮挡、不可见、禁用一律拒绝。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "browser_observe 返回的 ref" },
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          page_token: { type: "string", description: "browser_observe 返回的 page_token; 传入可识别跨文档失效" },
          expect: EXPECT_SCHEMA,
          settle_ms: { type: "integer", minimum: 200, maximum: 8000, description: "取证收敛上限(默认 1500)" },
        },
        required: ["ref"],
        additionalProperties: false,
      },
      browser: true,
      run: runClick,
    },
    {
      name: "browser_type",
      description:
        "向 browser_observe 返回的 ref 键入文本并返回 ActionReceipt。先按真坐标点击聚焦, 再插入文本。mode=append(默认)追加 / replace 先 ctrl+a 全选再键入。回执只包含值长度与前 3 字符, 不回传明文。适合表单填写; 填完建议用 browser_observe 或带 expect 复核。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "browser_observe 返回的 ref" },
          text: { type: "string", description: "要键入的文本" },
          mode: { type: "string", enum: ["append", "replace"], description: "append 追加(默认) / replace 先全选再键入" },
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          page_token: { type: "string", description: "browser_observe 返回的 page_token" },
          expect: EXPECT_SCHEMA,
          settle_ms: { type: "integer", minimum: 200, maximum: 8000, description: "取证收敛上限(默认 1500)" },
        },
        required: ["ref", "text"],
        additionalProperties: false,
      },
      browser: true,
      run: runType,
    },
    {
      name: "browser_find",
      description:
        "按语义字段在 browser_observe 登记过的元素里查找, 返回匹配 ref 列表。field 支持 label(关联label文本)/placeholder/name(name属性)/id/text(可读名称)/role/tag/type; op 支持 contains(默认)/equals/starts_with。这是表单填写的定位入口: 先 observe 再 find(如 placeholder=手机号) 拿 ref, 再交给 click/type。",
      inputSchema: {
        type: "object",
        properties: {
          filters: {
            type: "array",
            description: "匹配条件, 多条取交集(AND)",
            items: {
              type: "object",
              properties: {
                field: { type: "string", enum: ["text", "name", "label", "placeholder", "id", "role", "tag", "type"] },
                value: { type: "string", description: "要匹配的值" },
                op: { type: "string", enum: ["contains", "equals", "starts_with"], description: "默认 contains" },
              },
              required: ["field", "value"],
            },
          },
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          max: { type: "integer", minimum: 1, maximum: 300, description: "最多返回多少个匹配(默认 50)" },
        },
        additionalProperties: false,
      },
      browser: true,
      run: runFind,
    },
    {
      name: "browser_scroll",
      description:
        "滚动页面或滚动到指定元素并返回 ActionReceipt。带 ref 时先门禁校验并以它为锚点滚动到视口; 带 direction(up/down/left/right)+amount(1-10, 单位 100px) 则直接滚动页面。走 CDP mouseWheel 真输入。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "滚动到该 ref 元素(可选; 与 direction 二选一)" },
          direction: { type: "string", enum: ["up", "down", "left", "right"], description: "滚动方向" },
          amount: { type: "integer", minimum: 1, maximum: 10, description: "滚动量(单位 100px, 默认 3)" },
          tabId: { type: "integer", description: "目标标签页 id" },
          page_token: { type: "string", description: "browser_observe 返回的 page_token" },
          expect: EXPECT_SCHEMA,
          settle_ms: { type: "integer", minimum: 200, maximum: 8000, description: "取证收敛上限(默认 1500)" },
        },
        additionalProperties: false,
      },
      browser: true,
      run: runScroll,
    },
    {
      name: "browser_drag",
      description:
        "拖拽元素并返回 ActionReceipt。from 必须给 browser_observe 返回的 ref; to 给 ref 或 to_x/to_y 坐标。两个端点都过门禁, CDP 序列 moved→pressed→moved→released 全真输入。",
      inputSchema: {
        type: "object",
        properties: {
          from: { type: "string", description: "拖拽起点 ref" },
          to: { type: "string", description: "拖拽终点 ref(与 to_x/to_y 二选一)" },
          to_x: { type: "integer", description: "终点 x 坐标(视口)" },
          to_y: { type: "integer", description: "终点 y 坐标(视口)" },
          tabId: { type: "integer", description: "目标标签页 id" },
          page_token: { type: "string", description: "browser_observe 返回的 page_token" },
          expect: EXPECT_SCHEMA,
          settle_ms: { type: "integer", minimum: 200, maximum: 8000, description: "取证收敛上限(默认 1500)" },
        },
        required: ["from"],
        additionalProperties: false,
      },
      browser: true,
      run: runDrag,
    },
    {
      name: "browser_select",
      description:
        "下拉选择并返回 ActionReceipt。统一处理两种下拉: 原生 <select> 走 JS 设值 + change 事件(快, input_kind=synthetic); 自定义下拉(div 模拟) 走 点开触发器 -> 重新 observe -> 按文本找选项 -> 点选项(真输入, trusted)。参数 ref + value(原生, 匹配 option 的 value 或文本) 或 option_text(自定义, 匹配显示文本)。找不到选项时回执会列出可用候选项。",
      inputSchema: {
        type: "object",
        properties: {
          ref: { type: "string", description: "browser_observe 返回的下拉框 ref(原生 select 或自定义下拉触发器)" },
          value: { type: "string", description: "原生 <select> 要选中的 option value(或显示文本)" },
          option_text: { type: "string", description: "自定义下拉的选项显示文本" },
          tabId: { type: "integer", description: "目标标签页 id; 省略则用当前活动标签" },
          page_token: { type: "string", description: "browser_observe 返回的 page_token" },
          expect: EXPECT_SCHEMA,
          settle_ms: { type: "integer", minimum: 200, maximum: 8000, description: "取证收敛上限(默认 1500)" },
        },
        required: ["ref"],
        additionalProperties: false,
      },
      browser: true,
      run: runSelect,
    },
    {
      name: "browser_run",
      description:
        "多步动作编排: 按顺序执行 steps 数组, 每步独立 ActionReceipt。step.action 支持 observe/find/click/type/select/scroll/drag, 其余字段为该动作参数。默认 fail-fast(任一步失败即停), continueOnError=true 则继续。返回 {ok,total,done,failed_at,steps}。适合把一次自动填表拆成 观察->定位->填入->提交 的序列一次跑完。",
      inputSchema: {
        type: "object",
        properties: {
          steps: {
            type: "array",
            description: "动作序列; 每项必含 action 字段, 其余为对应动作参数",
            items: {
              type: "object",
              properties: {
                action: { type: "string", enum: ["observe", "find", "click", "type", "select", "scroll", "drag"] },
              },
              required: ["action"],
              additionalProperties: true,
            },
          },
          tabId: { type: "integer", description: "各步继承的标签页 id; 单步可覆盖" },
          page_token: { type: "string", description: "各步继承的 page_token; 单步可覆盖" },
          continueOnError: { type: "boolean", description: "true 则某步失败后继续执行后续步骤(默认 false, fail-fast)" },
        },
        required: ["steps"],
        additionalProperties: false,
      },
      browser: true,
      run: runRun,
    },
  ],
};
