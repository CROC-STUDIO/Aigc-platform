import assert from "node:assert/strict";
import test from "node:test";

import { ensureReferenceVideo } from "../../server/wangzhuan/batch-drafts.mjs";
import { WangzhuanError } from "../../server/wangzhuan/http.mjs";

test("ensureReferenceVideo returns validation error when draft omits reference video", () => {
  assert.throws(
    () => ensureReferenceVideo({}),
    (error) => {
      assert.ok(error instanceof WangzhuanError);
      assert.equal(error.code, "validation_error");
      assert.equal(error.status, 400);
      assert.equal(error.data.field, "referenceVideo.referenceVideoId");
      return true;
    }
  );
});

test("ensureReferenceVideo accepts reference video object", () => {
  assert.deepEqual(
    ensureReferenceVideo({ referenceVideo: { referenceVideoId: "ref_20260629_001" } }),
    { referenceVideoId: "ref_20260629_001" }
  );
});
