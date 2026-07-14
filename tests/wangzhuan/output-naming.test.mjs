import assert from "node:assert/strict";
import test from "node:test";

import { buildOutputDisplayName } from "../../server/wangzhuan/output-naming.mjs";

test("pipeline video names use batch, region, and actual dimensions", () => {
  assert.equal(buildOutputDisplayName({
    batch: { batchId: "wzb_20260713124628_76b4" },
    script: { branchDraft: { regions: ["US"] } },
    width: 720,
    height: 1280
  }), "wzb_20260713124628_76b4_US_720x1280.mp4");
});

test("pipeline video names resolve request region and sanitize fallback values", () => {
  assert.equal(buildOutputDisplayName({
    batch: { batchId: "wzb_20260713124628_76b4", request: { targetRegion: "BR" } },
    width: 800,
    height: 800
  }), "wzb_20260713124628_76b4_BR_800x800.mp4");
  assert.equal(buildOutputDisplayName({
    batch: { batchId: "wzb_20260713124628_76b4" },
    width: 720,
    height: 1280
  }), "wzb_20260713124628_76b4_UNKNOWN_720x1280.mp4");
});
