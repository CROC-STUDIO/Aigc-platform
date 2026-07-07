import assert from "node:assert/strict";
import test from "node:test";

import { sendErrorEnvelope } from "../../server/wangzhuan/http.mjs";

class TestResponse {
  constructor() {
    this.statusCode = 0;
    this.headers = {};
    this.body = "";
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = "") {
    this.body += body;
  }
}

test("invalid state transition responses expose transition detail", () => {
  const res = new TestResponse();
  const error = new Error("invalid_state_transition");
  error.code = "invalid_state_transition";
  error.details = {
    entityType: "workflow_run",
    fromStatus: "preview_required",
    toStatus: "preview_required",
    triggerName: "batch_draft_saved"
  };

  sendErrorEnvelope(res, error, "req_test");

  const payload = JSON.parse(res.body);
  assert.equal(res.statusCode, 409);
  assert.equal(payload.code, "invalid_state_transition");
  assert.equal(
    payload.message,
    "任务状态流转不被允许：preview_required -> preview_required by batch_draft_saved"
  );
  assert.deepEqual(payload.data, error.details);
});
