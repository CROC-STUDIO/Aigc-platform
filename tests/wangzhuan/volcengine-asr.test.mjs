import assert from "node:assert/strict";
import test from "node:test";

import { buildVolcengineAsrHeaders, transcribeVolcengineAudio } from "../../server/wangzhuan/volcengine-asr.mjs";

test("Volcengine ASR uses the new-console API key header without IAM AK/SK", () => {
  const headers = buildVolcengineAsrHeaders({ apiKey: "test-api-key", resourceId: "volc.seedasr.auc" }, "request-1", true);
  assert.equal(headers["X-Api-Key"], "test-api-key");
  assert.equal(headers["X-Api-Resource-Id"], "volc.seedasr.auc");
  assert.equal(headers["X-Api-Sequence"], "-1");
  assert.equal("Authorization" in headers, false);
});

test("Volcengine ASR submits an S3 audio URL and polls until word timestamps are ready", async () => {
  const calls = [];
  const responses = [
    new Response(null, { headers: { "X-Api-Status-Code": "20000000" } }),
    new Response(JSON.stringify({ result: { utterances: [{ text: "字幕", start_time: 0, end_time: 500, words: [{ text: "字幕", start_time: 0, end_time: 500 }] }] } }), { headers: { "X-Api-Status-Code": "20000000" } })
  ];
  const result = await transcribeVolcengineAudio({
    audioUrl: "https://assets.test/subtitles.mp3",
    language: "zh-CN",
    config: { apiKey: "test-api-key", resourceId: "volc.seedasr.auc", pollIntervalMs: 0, timeoutMs: 1000 },
    requestId: "request-1",
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    }
  });

  assert.equal(calls.length, 2);
  assert.match(calls[0].url, /\/submit$/);
  assert.match(calls[1].url, /\/query$/);
  assert.deepEqual(JSON.parse(calls[0].init.body).audio, { url: "https://assets.test/subtitles.mp3", format: "mp3", language: "zh-CN" });
  assert.equal(result.result.utterances[0].words[0].end_time, 500);
});
