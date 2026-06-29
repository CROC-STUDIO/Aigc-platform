import assert from "node:assert/strict";
import test from "node:test";

import {
  consumeSkylinkSseResponse,
  extractTextFromSkylinkSsePayload,
  parseSseBlocks
} from "../../server/wangzhuan/llm-stream.mjs";

test("extractTextFromSkylinkSsePayload reads chat completion deltas", () => {
  assert.equal(
    extractTextFromSkylinkSsePayload({ choices: [{ delta: { content: "hello" } }] }),
    "hello"
  );
});

test("extractTextFromSkylinkSsePayload reads responses deltas but ignores done payloads", () => {
  assert.equal(
    extractTextFromSkylinkSsePayload({ type: "response.output_text.delta", delta: "abc" }),
    "abc"
  );
  assert.equal(
    extractTextFromSkylinkSsePayload({ type: "response.output_text.done", text: "abcdef" }),
    ""
  );
});

test("extractTextFromSkylinkSsePayload reads gemini candidate parts", () => {
  assert.equal(
    extractTextFromSkylinkSsePayload({
      candidates: [{ content: { parts: [{ text: "{\"ok\":true}" }] } }]
    }),
    "{\"ok\":true}"
  );
});

test("parseSseBlocks splits events and keeps trailing partial buffer", () => {
  const input = [
    "event: log",
    "data: {\"line\":\"boot\"}",
    "",
    "event: delta",
    "data: {\"text\":\"x\"}",
    "",
    "event: done",
    "data: {\"code\":\"ok\"}",
    "",
    "event: del"
  ].join("\n");
  const parsed = parseSseBlocks(input);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[0].event, "log");
  assert.deepEqual(JSON.parse(parsed.events[0].data), { line: "boot" });
  assert.equal(parsed.rest, "event: del");
});

test("consumeSkylinkSseResponse accumulates deltas until DONE", async () => {
  const body = [
    'data: {"choices":[{"delta":{"content":"{\\"a\\":"}}]}',
    "",
    'data: {"choices":[{"delta":{"content":"1}"}}]}',
    "",
    "data: [DONE]",
    "",
    ""
  ].join("\n");
  const response = new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
  const deltas = [];
  const fullText = await consumeSkylinkSseResponse(response, {
    onDelta: (delta) => deltas.push(delta)
  });
  assert.equal(fullText, "{\"a\":1}");
  assert.deepEqual(deltas, ["{\"a\":", "1}"]);
});

test("consumeSkylinkSseResponse throws on upstream error payload", async () => {
  const body = "data: {\"error\":{\"message\":\"bad key\"}}\n\ndata: [DONE]\n\n";
  const response = new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });
  await assert.rejects(
    () => consumeSkylinkSseResponse(response),
    (error) => error.code === "model_failed"
  );
});
