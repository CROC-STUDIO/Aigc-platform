import assert from "node:assert/strict";
import test from "node:test";

import { invokeLlmWithRetry } from "../../server/wangzhuan/llm-invoke.mjs";

test("invokeLlmWithRetry retries retryable errors", async () => {
  const attempts = [];
  let calls = 0;
  const result = await invokeLlmWithRetry({
    call: async (attempt) => {
      attempts.push(attempt);
      calls += 1;
      if (calls < 3) throw new Error("timeout");
      return "ok";
    },
    isRetryable: (error) => error.message === "timeout",
    maxRetries: 3,
    initialBackoffMs: 1,
    maxBackoffMs: 2
  });
  assert.equal(result, "ok");
  assert.deepEqual(attempts, [1, 2, 3]);
});

test("invokeLlmWithRetry throws non retryable errors immediately", async () => {
  let calls = 0;
  await assert.rejects(() => invokeLlmWithRetry({
    call: async () => {
      calls += 1;
      throw new Error("schema_invalid");
    },
    isRetryable: () => false,
    maxRetries: 3,
    initialBackoffMs: 1
  }), /schema_invalid/);
  assert.equal(calls, 1);
});

test("invokeLlmWithRetry switches fallback modes", async () => {
  const modes = [];
  const result = await invokeLlmWithRetry({
    call: async (_attempt, { mode }) => {
      modes.push(mode);
      if (mode === "file_url") throw new Error("url_unavailable");
      return "ok";
    },
    isRetryable: () => false,
    fallbackChain: [
      { mode: "file_url", isFallbackNeededError: (error) => error.message === "url_unavailable" },
      { mode: "file_data" }
    ],
    initialBackoffMs: 1
  });
  assert.equal(result, "ok");
  assert.deepEqual(modes, ["file_url", "file_data"]);
});
