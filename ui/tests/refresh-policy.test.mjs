import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_REFRESH_STALE_MS,
  createRangeRefreshGate,
  dashboardNeedsRefresh,
} from "../src/refresh-policy.js";

const now = Date.parse("2026-08-29T02:00:00.000Z");

test("keeps a snapshot younger than 60 seconds", () => {
  assert.equal(dashboardNeedsRefresh({ generatedAt: new Date(now - 59_000).toISOString() }, now), false);
});

test("refreshes a snapshot at the 60 second boundary", () => {
  assert.equal(dashboardNeedsRefresh({ generatedAt: new Date(now - AUTO_REFRESH_STALE_MS).toISOString() }, now), true);
});

test("refreshes snapshots with missing or invalid timestamps", () => {
  assert.equal(dashboardNeedsRefresh({}, now), true);
  assert.equal(dashboardNeedsRefresh({ generatedAt: "not-a-date" }, now), true);
});

test("does not treat a future timestamp as stale", () => {
  assert.equal(dashboardNeedsRefresh({ generatedAt: new Date(now + 5_000).toISOString() }, now), false);
});

test("deduplicates concurrent automatic refreshes for the same range", async () => {
  const gate = createRangeRefreshGate();
  let calls = 0;
  let finish;
  const task = () => {
    calls += 1;
    return new Promise((resolve) => { finish = resolve; });
  };

  const first = gate.run("today", task);
  const second = gate.run("today", task);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish("done");
  assert.equal(await first, "done");
});

test("allows a new refresh after the previous request settles", async () => {
  const gate = createRangeRefreshGate();
  let calls = 0;
  const task = async () => { calls += 1; };
  await gate.run("7d", task);
  await gate.run("7d", task);
  assert.equal(calls, 2);
});
