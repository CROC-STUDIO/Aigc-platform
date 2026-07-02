import assert from "node:assert/strict";
import test from "node:test";

import {
  WangzhuanApiError,
  apiEnvelopeStream,
  parseClientSseBlocks
} from "../../public/wangzhuan-common.js";

test("parseClientSseBlocks matches server-side SSE framing", () => {
  const raw = [
    "event: log",
    "data: {\"line\":\"boot\"}",
    "",
    "event: reset",
    "data: {}",
    "",
    "event: delta",
    "data: {\"text\":\"chunk\"}",
    "",
    "partial"
  ].join("\n");
  const parsed = parseClientSseBlocks(raw);
  assert.equal(parsed.events.length, 3);
  assert.equal(parsed.events[1].event, "reset");
  assert.equal(parsed.rest, "partial");
});

test("apiEnvelopeStream resolves done envelope data and drives console hooks", async () => {
  const sseBody = [
    "event: log",
    "data: {\"line\":\"starting\"}",
    "",
    "event: reset",
    "data: {}",
    "",
    "event: delta",
    "data: {\"text\":\"{\\\"scene\\\"\"}",
    "",
    "event: delta",
    "data: {\"text\":\":\\\"kitchen\\\"}\"}",
    "",
    "event: done",
    "data: {\"code\":\"ok\",\"message\":\"\",\"data\":{\"decomposition\":{\"scene\":\"kitchen\"}},\"requestId\":\"req_1\"}",
    "",
    ""
  ].join("\n");

  const logs = [];
  const deltas = [];
  let resets = 0;
  const consoleUi = {
    log(line) { logs.push(line); },
    delta(text) { deltas.push(text); },
    resetDelta() { resets += 1; },
    finish() {},
    fail() {},
    close() {}
  };

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody, {
    status: 200,
    headers: { "Content-Type": "text/event-stream; charset=utf-8" }
  });

  try {
    const data = await apiEnvelopeStream("/api/wangzhuan/reference-videos/draft-decomposition/stream", {
      method: "POST",
      body: "{}"
    }, { console: consoleUi, animated: false });

    assert.deepEqual(data, { decomposition: { scene: "kitchen" } });
    assert.ok(logs.includes("starting"));
    assert.equal(resets, 1);
    assert.deepEqual(deltas, ["{\"scene\"", ":\"kitchen\"}"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apiEnvelopeStream throws WangzhuanApiError on error events", async () => {
  const sseBody = [
    "event: log",
    "data: {\"line\":\"failed upstream\"}",
    "",
    "event: error",
    "data: {\"code\":\"model_failed\",\"message\":\"upstream failed\",\"data\":{\"batchId\":\"wzb_1\",\"upstreamMessage\":\"bad key\"},\"requestId\":\"req_2\"}",
    "",
    ""
  ].join("\n");

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(sseBody, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" }
  });

  try {
    await assert.rejects(
      () => apiEnvelopeStream("/api/wangzhuan/batches/plan/stream", { method: "POST", body: "{}" }, {
        console: {
          log() {},
          delta() {},
          resetDelta() {},
          finish() {},
          fail() {},
          close() {}
        }
      }),
      (error) => error instanceof WangzhuanApiError
        && error.code === "model_failed"
        && error.data.batchId === "wzb_1"
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apiEnvelopeStream falls back to JSON envelope for non-stream responses", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({
    code: "ok",
    message: "",
    data: { batch: { batchId: "wzb_ok" } },
    requestId: "req_json"
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });

  try {
    const data = await apiEnvelopeStream("/api/wangzhuan/batches/plan", { method: "POST", body: "{}" }, {
      console: {
        log() {},
        delta() {},
        resetDelta() {},
        finish() {},
        fail() {},
        close() {}
      }
    });
    assert.deepEqual(data, { batch: { batchId: "wzb_ok" } });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
