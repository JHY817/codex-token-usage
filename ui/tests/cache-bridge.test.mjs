import assert from 'node:assert/strict';
import test from 'node:test';
import { callTool } from '../src/bridge.js';

test('local bridge preserves cumulative cache denominators', async () => {
  const originalWindow = globalThis.window;
  const originalFetch = globalThis.fetch;
  const payload = { totals: { task: 120 }, cumulativeBreakdowns: { task: { inputTokens: 100, cachedInputTokens: 80, cacheTokensKnown: true } } };
  globalThis.window = {};
  globalThis.window.parent = globalThis.window;
  globalThis.fetch = async () => ({ ok: true, json: async () => payload });
  try {
    const result = await callTool('get_conversation_usage_totals', { conversationIds: ['task'] });
    assert.deepEqual(result.structuredContent, payload);
  } finally {
    globalThis.window = originalWindow;
    globalThis.fetch = originalFetch;
  }
});
