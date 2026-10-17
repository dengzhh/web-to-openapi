"use strict";
/*
 * 站点: SCNet(国家超算互联网)控制台余额
 *
 * 反爬说明: 控制台对数字做了「数字转轮」混淆(DOM 文本是 0-9 乱序),
 * 但转轮外层 .d-roll-wrapper 的 aria-label 保存真实值(无障碍标签),
 * 故用 chrome_javascript 抓 aria-label; 免费额度页表格是纯文本亦可直接解析。
 */
const { openPage, closeTab, jsEval, sleep, num } = require("../lib/util");

const FREE_URL = "https://www.scnet.cn/ui/console/index.html#/llm/free-credit";
const PLAN_URL = "https://www.scnet.cn/ui/console/index.html#/llm/token-plan";

const EXTRACT_JS = "const rolls=[...document.querySelectorAll('.d-roll-wrapper[aria-label]')].map(e=>({aria:e.getAttribute('aria-label'),cls:(e.className||'').trim()}));return {rolls,text:(document.body.innerText||'')};";

async function extractOnce(tabId) {
  // strict: 页面结构固定, 解析失败应直接报错而不是静默重试到底
  return await jsEval(tabId, EXTRACT_JS, { strict: true });
}

/*
 * 不能"拿到 rolls 就返回": 数字转轮有滚动动画, aria-label 的初值是 0,
 * 动画结束后才写入真实数值(实测立即读会得到 0/0/0)。
 * 因此等 aria 序列连续两次一致才算稳定(每轮 2s, 上限约 16s)。
 */
async function extractWithRetry(tabId, tries = 8) {
  let lastSig = "";
  let d = null;
  for (let i = 0; i < tries; i++) {
    d = await extractOnce(tabId);
    const rolls = d && Array.isArray(d.rolls) ? d.rolls : [];
    const sig = rolls.map((x) => x.aria || "").join("|");
    if (sig && sig === lastSig) return d;
    lastSig = sig;
    await sleep(2000);
  }
  return d;
}

async function fetchPage(url) {
  const tabId = await openPage(url);
  const data = await extractWithRetry(tabId);
  await closeTab(tabId);
  return data;
}

function parseFree(d) {
  const rolls = (d.rolls || []).filter((x) => /free-credit-summary__digi/.test(x.cls || ""));
  const vals = rolls.map((x) => num((x.aria || "").replace(/[^\d.]/g, "")));
  const text = d.text || "";
  const out = {};
  if (vals.length >= 3) {
    out.remaining = Math.round(vals[0]);
    out.total = Math.round(vals[1]);
    out.used = Math.round(vals[2]);
  }
  let m = text.match(/剩余\s*(\d+)\s*%/);
  if (m) out.remaining_percent = parseInt(m[1], 10);
  m = text.match(/(GLM-[\w.\-]+)/);
  if (m) out.model = m[1];
  m = text.match(/剩[余]?\s*(\d+)\s*天/);
  if (m) out.days_left = parseInt(m[1], 10);
  const dates = text.match(/\d{4}-\d{2}-\d{2}/g) || [];
  if (dates.length >= 2) { out.claim_date = dates[0]; out.expire_date = dates[1]; }
  return out;
}

function parsePlan(d) {
  const rolls = d.rolls || [];
  const text = d.text || "";
  const out = {};
  const status = rolls.filter((x) => /status-digit-roll/.test(x.cls || "")).map((x) => x.aria || "");
  const usage = rolls.filter((x) => /usage-digit-roll/.test(x.cls || "")).map((x) => x.aria || "");
  for (const a of status) {
    let m = a.match(/([\d,]+(?:\.\d+)?)\s*Credits\/月/);
    if (m) out.plan_monthly_credits = num(m[1]);
    m = a.match(/(\d+)\s*天/);
    if (m) out.days_left = parseInt(m[1], 10);
  }
  if (usage.length >= 3) {
    out.total_credits = num(usage[0]);
    out.remaining_credits = num(usage[1]);
    const mm = usage[2].match(/([\d.]+)/);
    if (mm) out.remaining_percent = parseFloat(mm[1]);
  }
  if (out.total_credits != null && out.remaining_credits != null)
    out.used_credits = Math.round((out.total_credits - out.remaining_credits) * 100) / 100;
  if (out.remaining_percent != null)
    out.used_percent = Math.round((100 - out.remaining_percent) * 100) / 100;
  let m = text.match(/开始时间\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (m) out.start_at = m[1];
  m = text.match(/结束时间\s*(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/);
  if (m) out.expire_at = m[1];
  return out;
}

async function getFreeCredit() {
  const free = await fetchPage(FREE_URL);
  return {
    source: "scnet console via web-to-openapi",
    fetched_at: new Date().toISOString(),
    free_credit: parseFree(free),
  };
}

async function getTokenPlan() {
  const plan = await fetchPage(PLAN_URL);
  return {
    source: "scnet console via web-to-openapi",
    fetched_at: new Date().toISOString(),
    token_plan: parsePlan(plan),
  };
}

async function getBalance() {
  const free = await fetchPage(FREE_URL);
  const plan = await fetchPage(PLAN_URL);
  return {
    source: "scnet console via web-to-openapi",
    fetched_at: new Date().toISOString(),
    free_credit: parseFree(free),
    token_plan: parsePlan(plan),
  };
}

module.exports = {
  id: "scnet",
  title: "SCNet 余额",
  endpoints: [
    {
      method: "GET",
      path: "/api/v1/scnet/free-credit",
      tool: "scnet_free_credit",
      operationId: "scnetFreeCredit",
      summary: "查询 SCNet 免费额度(实时驱动浏览器打开控制台提取)",
      description: "只返回免费额度(free_credit): 剩余/总额/已用/百分比/模型/剩余天数/领取与到期时间。每次调用约 5-10 秒(真实浏览器现读)。",
      responses: { 200: { description: "免费额度 JSON" }, 500: { description: "提取失败(未登录/页面结构变化)" } },
      browser: true,
      run: getFreeCredit,
      doc: {
        note: "查询 SCNet 免费额度。实时驱动浏览器打开 scnet 控制台「免费额度」页提取, 每次约 5-10 秒。返回剩余/总额/已用/百分比/模型/剩余天数/领取与到期时间。",
        slow: true,
      },
    },
    {
      method: "GET",
      path: "/api/v1/scnet/token-plan",
      tool: "scnet_token_plan",
      operationId: "scnetTokenPlan",
      summary: "查询 SCNet Token Plan(实时驱动浏览器打开控制台提取)",
      description: "只返回 Token Plan(token_plan): 月度 Credits/总额/剩余/已用/百分比/周期起止时间。每次调用约 5-10 秒(真实浏览器现读)。",
      responses: { 200: { description: "Token Plan JSON" }, 500: { description: "提取失败(未登录/页面结构变化)" } },
      browser: true,
      run: getTokenPlan,
      doc: {
        note: "查询 SCNet Token Plan。实时驱动浏览器打开 scnet 控制台「Token Plan」页提取, 每次约 5-10 秒。返回月度 Credits/总额/剩余/已用/百分比/周期起止时间。",
        slow: true,
      },
    },
    {
      method: "GET",
      path: "/api/v1/scnet/balance",
      tool: "scnet_balance",
      operationId: "scnetBalance",
      summary: "查询 SCNet 全部余额(免费额度 + Token Plan 聚合)",
      description: "聚合接口, 一次返回免费额度(free_credit)与 Token Plan(token_plan)。若只需其中一项, 建议用 /api/v1/scnet/free-credit 或 /api/v1/scnet/token-plan, 省一次页面打开。每次调用约 10-20 秒(真实浏览器现读)。",
      responses: { 200: { description: "余额 JSON" }, 500: { description: "提取失败(未登录/页面结构变化)" } },
      browser: true,
      run: getBalance,
      doc: {
        note: "查询 SCNet 全部余额(聚合)。一次打开两页返回免费额度与 Token Plan, 每次约 10-20 秒。只需单项时建议用上面两个拆分接口, 省一次页面打开。",
        slow: true,
      },
    },
  ],
  tools: [
    {
      name: "scnet_free_credit",
      description: "查询 SCNet 免费额度(实时驱动浏览器打开控制台提取, 约 5-10 秒)。返回 {free_credit:{total,remaining,used,percent,reset_at}}(金额单位与页面一致)。只需免费额度时用这个, 比 scnet_balance 少开一个页面。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      browser: true,
      run: getFreeCredit,
    },
    {
      name: "scnet_token_plan",
      description: "查询 SCNet Token Plan(约 5-10 秒)。返回 {token_plan:{total,remaining,used,percent,period_start,period_end}}(Credits 额度与周期起止时间)。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      browser: true,
      run: getTokenPlan,
    },
    {
      name: "scnet_balance",
      description: "查询 SCNet 全部余额(免费额度 + Token Plan 聚合, 约 10-20 秒)。返回 {free_credit:{...}, token_plan:{...}}。只需单项时建议用 scnet_free_credit / scnet_token_plan。",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      browser: true,
      run: getBalance,
    },
  ],
};
