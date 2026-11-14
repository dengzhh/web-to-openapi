"use strict";
/*
 * actions.js parseInput 数值参数解析回归测试(v1.9.1)
 * 锁死 URLSearchParams.get() 对不存在键返回 null、Number(null)===0 的坑:
 * 未传的 max/amount 曾被解析成 0, 导致 find 的 MAXN 被压成 1、truncated 误报 true。
 */
const test = require("node:test");
const assert = require("node:assert");
const actions = require("../sites/actions.js");

const findEp = actions.endpoints.find((e) => e.path === "/api/v1/act/find");
const scrollEp = actions.endpoints.find((e) => e.path === "/api/v1/act/scroll");

test("parseInput: 未传 max 应解析为 undefined(而非 0)", () => {
  const p = findEp.parse({ filters: [{ field: "id", value: "q" }] });
  assert.strictEqual(p.max, undefined);
});

test("parseInput: 显式传 max 正常解析", () => {
  const p = findEp.parse({ filters: [{ field: "id", value: "q" }], max: 5 });
  assert.strictEqual(p.max, 5);
});

test("parseInput: 未传 amount 应解析为 undefined(而非 0)", () => {
  const p = scrollEp.parse({ direction: "down" });
  assert.strictEqual(p.amount, undefined);
});

test("parseInput: 显式传 amount 正常解析", () => {
  const p = scrollEp.parse({ direction: "down", amount: 3 });
  assert.strictEqual(p.amount, 3);
});
