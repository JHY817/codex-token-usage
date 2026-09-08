import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { normalizeRateLimits, readQuota } from "../quota.mjs";

class FakeChild extends EventEmitter {
  constructor(onWrite = null) {
    super();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.killed = false;
    this.writes = [];
    this.stdin = {
      write: (value) => {
        this.writes.push(JSON.parse(value));
        onWrite?.(value, this);
      },
    };
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    queueMicrotask(() => this.emit("close", null, signal));
    return true;
  }
}

test("normalizeRateLimits supports primary/secondary and multiple limit buckets", () => {
  const fetchedAt = new Date("2026-08-29T10:00:00.000Z");
  const result = normalizeRateLimits({
    rateLimits: {
      limitId: "codex",
      primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_730_947_200 },
      secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_730_990_400 },
    },
    rateLimitsByLimitId: {
      codex: {
        limitId: "codex",
        limitName: "Codex",
        primary: { usedPercent: 25, windowDurationMins: 15, resetsAt: 1_730_947_200 },
        secondary: { usedPercent: 12, windowDurationMins: 10_080, resetsAt: 1_730_990_400 },
      },
      codex_other: {
        limitName: "Other",
        primary: { used_percent: "42", window_duration_mins: "60", resets_at: 1_730_950_800 },
      },
    },
  }, fetchedAt);

  assert.equal(result.available, true);
  assert.equal(result.windows.length, 3);
  assert.equal(result.selected.limitId, "codex_other");
  assert.equal(result.selected.usedPercent, 42);
  assert.equal(result.selected.remainingPercent, 58);
  assert.equal(result.fetchedAt, fetchedAt.toISOString());
  assert.equal(result.windows.filter((window) => window.limitId === "codex").length, 2);
});

test("readQuota performs only initialize and rate-limit JSON-RPC calls", async () => {
  let child;
  const spawnImpl = (command, args, options) => {
    assert.equal(command, "codex-test");
    assert.deepEqual(args, ["app-server", "--stdio"]);
    assert.deepEqual(options.stdio, ["pipe", "pipe", "pipe"]);
    child = new FakeChild((_value, process) => {
      if (process.writes.length === 3) {
        process.stdout.write("not-json\n");
        process.stdout.write(JSON.stringify({
          id: 2,
          result: {
            rateLimits: {
              limitId: "codex",
              primary: { usedPercent: 18, windowDurationMins: 10_080, resetsAt: 1_730_947_200 },
            },
          },
        }) + "\n");
      }
    });
    return child;
  };

  const result = await readQuota({ command: "codex-test", spawnImpl });
  assert.equal(result.available, true);
  assert.equal(result.selected.usedPercent, 18);
  assert.deepEqual(child.writes.map((message) => message.method), [
    "initialize",
    "initialized",
    "account/rateLimits/read",
  ]);
  assert.equal(child.writes.some((message) => message.method === "turn/start"), false);
  assert.equal(child.killed, true);
});

test("readQuota degrades on process error and timeout without throwing", async () => {
  const errorResult = await readQuota({
    command: "codex-test",
    spawnImpl: () => {
      const child = new FakeChild();
      queueMicrotask(() => child.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" })));
      return child;
    },
  });
  assert.equal(errorResult.available, false);
  assert.match(errorResult.error, /找不到 codex/);

  const timeoutResult = await readQuota({
    command: "codex-test",
    timeoutMs: 100,
    spawnImpl: () => new FakeChild(),
  });
  assert.equal(timeoutResult.available, false);
  assert.match(timeoutResult.error, /超时/);
});
