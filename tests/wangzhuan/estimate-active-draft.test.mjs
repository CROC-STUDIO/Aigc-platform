import assert from "node:assert/strict";
import test from "node:test";

import { canReuseActivePipelineDraft } from "../../server/wangzhuan/estimates.mjs";

test("plan regeneration may reuse the same preview_required batch before confirmation", () => {
  const active = { batchId: "wzb_20260626010101_abcd", status: "preview_required" };
  const request = { batchId: "wzb_20260626010101_abcd" };

  assert.equal(canReuseActivePipelineDraft(active, request), false);
  assert.equal(canReuseActivePipelineDraft(active, request, { allowPreviewRequired: true }), true);
});

test("active draft reuse still rejects different or submitted batches", () => {
  assert.equal(
    canReuseActivePipelineDraft(
      { batchId: "wzb_20260626010101_abcd", status: "queued" },
      { batchId: "wzb_20260626010101_abcd" },
      { allowPreviewRequired: true }
    ),
    false
  );

  assert.equal(
    canReuseActivePipelineDraft(
      { batchId: "wzb_20260626010101_abcd", status: "preview_required" },
      { batchId: "wzb_20260626010101_dcba" },
      { allowPreviewRequired: true }
    ),
    false
  );
});
