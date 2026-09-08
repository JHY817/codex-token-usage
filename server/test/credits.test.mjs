import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { normalizeConversationCredits, readCreditsSummary, readConversationCredits, readThreadUsage } from "../credits.mjs";

test("microcredits become credits and speed rows merge by model and effort", () => {
  const row = normalizeConversationCredits({ threadUsage: { threadId: "a", estimatedUsageCreditsMicros: 2_500_000, groups: [
    { model: "m", reasoningEffort: "high", estimatedUsageCreditsMicros: 1_000_000 },
    { model: "m", reasoningEffort: "high", estimatedUsageCreditsMicros: 1_500_000 },
  ] } }, "a", new Date("2026-09-07T01:00:00Z"));
  assert.equal(row.cumulativeCredits, 2.5);
  assert.equal(row.models[0].cumulativeCredits, 2.5);
  assert.equal(row.models[0].id, "m|high");
  assert.equal(row.todayCredits, null);
  assert.equal(row.coverage.todayComplete, false);
});

test("missing, invalid and mismatched usage never becomes zero", () => {
  for (const payload of [{}, { threadUsage: null }, { threadUsage: { threadId: "other", estimatedUsageCreditsMicros: 0 } },
    { threadUsage: { threadId: "a", estimatedUsageCreditsMicros: null } }]) {
    const row = normalizeConversationCredits(payload, "a");
    assert.equal(row.available, false); assert.equal(row.cumulativeCredits, null);
  }
  assert.equal(normalizeConversationCredits({ threadUsage: { threadId: "a", estimatedUsageCreditsMicros: 0 } }, "a").cumulativeCredits, 0);
});

test("unknown effort remains unknown and incomplete group stays null", () => {
  const row = normalizeConversationCredits({ threadUsage: { threadId: "a", estimatedUsageCreditsMicros: 10, groups: [{ model: "m" }] } }, "a");
  assert.equal(row.models[0].id, "m|unknown"); assert.equal(row.models[0].cumulativeCredits, null);
});

test("account time ranges do not manufacture credits or coverage", async () => {
  for (const range of ["today", "7d", "30d", "all"]) {
    const row = await readCreditsSummary(range);
    assert.equal(row.totalCredits, null); assert.equal(row.coverage.complete, false);
    assert.equal(row.periodStart, null); assert.ok(row.timeZone);
  }
});

test("reader errors remain unavailable", async () => {
  const row = await readConversationCredits("failure", { force: true, reader: async () => { throw Error("private diagnostic"); } });
  assert.equal(row.available, false); assert.equal(row.cumulativeCredits, null);
  assert.ok(!row.error.includes("private diagnostic"));
});

test("read-only transport initializes before requesting thread usage", async () => {
  const sent = [];
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.kill = () => {};
  child.stdin = { write: (line) => {
    const message = JSON.parse(line); sent.push(message);
    if (message.id === 1) queueMicrotask(() => child.stdout.emit("data", '{"id":1,"result":{}}\n'));
    if (message.id === 2) queueMicrotask(() => child.stdout.emit("data", '{"id":2,"result":{"threadUsage":null}}\n'));
  } };
  const result = await readThreadUsage("example", { spawnImpl: () => child });
  assert.deepEqual(sent.map((m) => m.method), ["initialize", "initialized", "account/usage/read"]);
  assert.deepEqual(sent[2].params, { threadId: "example" });
  assert.equal(result.payload.threadUsage, null);
});
