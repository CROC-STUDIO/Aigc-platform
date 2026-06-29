import assert from "node:assert/strict";
import test from "node:test";

import {
  initWangzhuanSse,
  writeSseDelta,
  writeSseDone,
  writeSseError,
  writeSseLog,
  writeSseReset
} from "../../server/wangzhuan/sse.mjs";
import { WangzhuanError } from "../../server/wangzhuan/http.mjs";

function createMockSseResponse() {
  const chunks = [];
  let ended = false;
  const res = {
    writeHead(_status, headers) {
      this.statusCode = _status;
      this.headers = headers;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end() {
      ended = true;
    }
  };
  return {
    res,
    raw: () => chunks.join(""),
    ended: () => ended
  };
}

function parseEvents(raw) {
  return raw
    .split("\n\n")
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data = line.slice(5).trimStart();
      }
      return { event, data: data ? JSON.parse(data) : null };
    });
}

test("writeSseLog and writeSseReset emit named SSE events", () => {
  const mock = createMockSseResponse();
  initWangzhuanSse(mock.res, "req_test");
  writeSseLog(mock.res, "hello");
  writeSseReset(mock.res);
  writeSseDelta(mock.res, "{\"x\":1}");

  const events = parseEvents(mock.raw());
  assert.equal(events[0].event, "log");
  assert.equal(events[0].data.line, "hello");
  assert.equal(events[1].event, "reset");
  assert.deepEqual(events[1].data, {});
  assert.equal(events[2].event, "delta");
  assert.equal(events[2].data.text, "{\"x\":1}");
  assert.equal(mock.res.headers["Content-Type"], "text/event-stream; charset=utf-8");
});

test("writeSseDone wraps okEnvelope and ends response", () => {
  const mock = createMockSseResponse();
  initWangzhuanSse(mock.res, "req_done");
  writeSseDone(mock.res, { decomposition: { scene: "test" } }, "req_done");

  assert.equal(mock.ended(), true);
  const events = parseEvents(mock.raw());
  const done = events.at(-1);
  assert.equal(done.event, "done");
  assert.equal(done.data.code, "ok");
  assert.deepEqual(done.data.data, { decomposition: { scene: "test" } });
  assert.equal(done.data.requestId, "req_done");
});

test("writeSseError wraps WangzhuanError envelope and ends response", () => {
  const mock = createMockSseResponse();
  initWangzhuanSse(mock.res, "req_err");
  writeSseError(
    mock.res,
    new WangzhuanError("model_failed", "upstream failed", { upstreamMessage: "bad key" }),
    "req_err"
  );

  assert.equal(mock.ended(), true);
  const events = parseEvents(mock.raw());
  const errorEvent = events.at(-1);
  assert.equal(errorEvent.event, "error");
  assert.equal(errorEvent.data.code, "model_failed");
  assert.equal(errorEvent.data.message, "upstream failed");
  assert.equal(errorEvent.data.data.upstreamMessage, "bad key");
});
