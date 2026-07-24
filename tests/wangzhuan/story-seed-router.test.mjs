import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.body = "";
  }

  writeHead(statusCode) {
    this.statusCode = statusCode;
  }

  end(body = "") {
    this.body += body;
  }
}

async function call(body, overrides = {}) {
  const res = new TestResponse();
  const context = {
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    currentUser: () => ({ username: "tester", permissions: { "wangzhuan:view": true } }),
    currentUserId: () => "tester",
    readJson: async () => body,
    ...overrides
  };
  await handleWangzhuanRequest(
    { method: "POST", headers: {} },
    res,
    new URL("http://127.0.0.1/api/wangzhuan/story-seeds"),
    context
  );
  return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
}

test("story seed route delegates generation to the configured creator", async () => {
  const response = await call({ corePlot: "婚内背叛", durationSec: 30, language: "zh-CN" }, {
    createStorySeed: async (context, request) => ({
      sourceType: "story_seed",
      sourceConfidence: "luna_generated",
      generationModel: "gpt-5.6-luna",
      corePlot: request.corePlot,
      variants: [{ variantId: "story_variant_1" }, { variantId: "story_variant_2" }, { variantId: "story_variant_3" }]
    })
  });

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.code, "ok");
  assert.equal(response.payload.data.sourceType, "story_seed");
  assert.equal(response.payload.data.generationModel, "gpt-5.6-luna");
  assert.equal(response.payload.data.variants.length, 3);
});

test("story seed route rejects a blank core plot", async () => {
  const response = await call({ corePlot: " " });

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.code, "validation_error");
  assert.equal(response.payload.data.field, "corePlot");
});
