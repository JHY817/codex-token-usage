import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { SnapshotStore } from "../store.mjs";

test("upserts and reloads the latest local snapshot", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "codex-usage-store-"));
  const store = new SnapshotStore(dir);
  const first = {
    range: "today",
    periodStart: "2026-08-28",
    periodEnd: "2026-08-28",
    generatedAt: "2026-08-28T12:00:00.000Z",
    totals: { tokens: 10 },
  };
  const second = {
    ...first,
    generatedAt: "2026-08-28T12:05:00.000Z",
    totals: { tokens: 20 },
  };
  store.save(first);
  store.save(second);
  assert.equal(store.loadLatest("today").totals.tokens, 20);
  store.close();
});
