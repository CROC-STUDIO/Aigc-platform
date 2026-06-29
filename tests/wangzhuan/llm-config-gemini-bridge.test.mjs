import assert from "node:assert/strict";
import test from "node:test";

import {
  llmUsesGeminiCompat,
  llmUsesGeminiNativeApi,
  llmUsesSkylinkGeminiChatBridge
} from "../../server/wangzhuan/llm-config.mjs";
import { callLlmStreaming } from "../../server/wangzhuan/llm-stream.mjs";

const skylinkGemini = {
  provider: "skylink",
  endpoint: "https://skylink-gateway.com/api/v1",
  model: "gemini-3.5-flash",
  temperature: 0.2,
  timeoutMs: 30000,
  apiKey: "test-key"
};

const googleGemini = {
  provider: "gemini",
  endpoint: "https://generativelanguage.googleapis.com/v1beta",
  model: "gemini-2.5-flash",
  temperature: 0.2,
  timeoutMs: 30000,
  apiKey: "test-key"
};

test("llmUsesGeminiCompat matches gemini model names and providers", () => {
  assert.equal(llmUsesGeminiCompat(skylinkGemini), true);
  assert.equal(llmUsesGeminiCompat(googleGemini), true);
  assert.equal(llmUsesGeminiCompat({ provider: "skylink", model: "gpt-4o" }), false);
});

test("llmUsesGeminiNativeApi is true only for Google official endpoints", () => {
  assert.equal(llmUsesGeminiNativeApi(googleGemini), true);
  assert.equal(llmUsesGeminiNativeApi(skylinkGemini), false);
});

test("llmUsesSkylinkGeminiChatBridge routes Skylink gemini through chat completions", () => {
  assert.equal(llmUsesSkylinkGeminiChatBridge(skylinkGemini), true);
  assert.equal(llmUsesSkylinkGeminiChatBridge(googleGemini), false);
  assert.equal(llmUsesSkylinkGeminiChatBridge({ provider: "skylink", model: "gpt-4o" }), false);
});

test("callLlmStreaming uses chat stream for Skylink gemini instead of gemini SSE", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const payload = JSON.parse(String(init.body || "{}"));
    assert.equal(payload.stream, true);
    assert.equal(payload.model, "gemini-3.5-flash");
    return new Response([
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"ok\\\":true}\"}}]}",
      "",
      "data: [DONE]",
      "",
      ""
    ].join("\n"), {
      status: 200,
      headers: { "Content-Type": "text/event-stream" }
    });
  };

  try {
    const text = await callLlmStreaming(
      skylinkGemini,
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      {}
    );
    assert.equal(text, "{\"ok\":true}");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/chat\/completions$/);
    assert.doesNotMatch(calls[0], /streamGenerateContent/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
