import assert from "node:assert/strict";
import test from "node:test";

import { callOpenAiCompatibleLlmStream } from "../../server/wangzhuan/llm-stream.mjs";

function sseResponse(lines) {
  const body = lines.join("\n");
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
}

test("callOpenAiCompatibleLlmStream falls back from responses stream to chat stream", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    const payload = JSON.parse(String(init.body || "{}"));
    if (String(url).endsWith("/responses")) {
      return new Response(JSON.stringify({ error: { message: "responses unavailable" } }), {
        status: 404,
        headers: { "Content-Type": "application/json" }
      });
    }
    assert.equal(payload.stream, true);
    assert.equal(payload.response_format?.type, "json_object");
    return sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"plan\\\":\"}}]}",
      "",
      "data: {\"choices\":[{\"delta\":{\"content\":\"true}\"}}]}",
      "",
      "data: [DONE]",
      "",
      ""
    ]);
  };

  try {
    const text = await callOpenAiCompatibleLlmStream(
      {
        provider: "skylink",
        endpoint: "https://example.test/api/v1",
        model: "gpt-4o",
        temperature: 0.2,
        timeoutMs: 30000,
        apiKey: "test-key"
      },
      [{
        role: "user",
        content: [
          { type: "text", text: "generate plan" },
          { type: "file", file: { file_url: "https://example.test/video.mp4" } }
        ]
      }],
      {}
    );
    assert.equal(text, "{\"plan\":true}");
    assert.equal(calls.length, 2);
    assert.match(calls[0], /\/responses$/);
    assert.match(calls[1], /\/chat\/completions$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callOpenAiCompatibleLlmStream uses chat stream directly for gpt-5.4 video prompts", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"ok\\\":true}\"}}]}",
      "",
      "data: [DONE]",
      "",
      ""
    ]);
  };

  try {
    const text = await callOpenAiCompatibleLlmStream(
      {
        provider: "skylink",
        endpoint: "https://example.test/api/v1",
        model: "gpt-5.4",
        temperature: 0.2,
        timeoutMs: 30000,
        apiKey: "test-key"
      },
      [{
        role: "user",
        content: [
          { type: "text", text: "decompose video" },
          { type: "file", file: { file_url: "https://example.test/video.mp4" } }
        ]
      }],
      {}
    );
    assert.equal(text, "{\"ok\":true}");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/chat\/completions$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("callOpenAiCompatibleLlmStream uses chat stream directly for text-only prompts", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return sseResponse([
      "data: {\"choices\":[{\"delta\":{\"content\":\"{\\\"ok\\\":true}\"}}]}",
      "",
      "data: [DONE]",
      "",
      ""
    ]);
  };

  try {
    const text = await callOpenAiCompatibleLlmStream(
      {
        provider: "skylink",
        endpoint: "https://example.test/api/v1",
        model: "gpt-5.4",
        temperature: 0.2,
        timeoutMs: 30000,
        apiKey: "test-key"
      },
      [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      {}
    );
    assert.equal(text, "{\"ok\":true}");
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/chat\/completions$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
