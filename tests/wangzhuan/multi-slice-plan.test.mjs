import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildSlicePlan,
  planSegmentMultiplier
} from "../../server/wangzhuan/pipeline.mjs";

test("planSegmentMultiplier supports three-slice output template", () => {
  assert.equal(planSegmentMultiplier({
    estimate: {
      durationSec: 36,
      request: {
        sliceStrategy: "three_slice",
        outputTemplateMode: "three_slice_net_earning"
      }
    },
    templateSnapshot: {
      draft: {
        sliceStrategy: "three_slice",
        outputTemplateMode: "three_slice_net_earning"
      }
    }
  }), 3);
});

test("buildSlicePlan creates 10-15s slices for multi-slice strategy", () => {
  assert.deepEqual(buildSlicePlan({
    durationSec: 36,
    sliceStrategy: "three_slice"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 12, durationSec: 12, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 12, endSec: 24, durationSec: 12, segmentRole: "proof_slice" },
    { segmentIndex: 3, startSec: 24, endSec: 36, durationSec: 12, segmentRole: "withdrawal_slice" }
  ]);
});

test("buildSlicePlan resolves fixed, two-slice, and auto strategies", () => {
  assert.deepEqual(buildSlicePlan({
    durationSec: 15,
    sliceStrategy: "fixed_15s"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 15, durationSec: 15, segmentRole: "hook_slice" }
  ]);
  assert.deepEqual(buildSlicePlan({
    durationSec: 30,
    sliceStrategy: "two_15s"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 15, durationSec: 15, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 15, endSec: 30, durationSec: 15, segmentRole: "proof_slice" }
  ]);
  assert.deepEqual(buildSlicePlan({
    durationSec: 40,
    sliceStrategy: "auto_10_15s_multi_slice"
  }), [
    { segmentIndex: 1, startSec: 0, endSec: 13, durationSec: 13, segmentRole: "hook_slice" },
    { segmentIndex: 2, startSec: 13, endSec: 26, durationSec: 13, segmentRole: "proof_slice" },
    { segmentIndex: 3, startSec: 26, endSec: 40, durationSec: 14, segmentRole: "withdrawal_slice" }
  ]);
});

test("prepareBatchForPipeline writes slice duration and role into payloads", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/pipeline.mjs", import.meta.url), "utf8");

  assert.match(source, /const slicePlan = buildSlicePlan\(/);
  assert.match(source, /const segmentMultiplier = slicePlan\.length/);
  assert.match(source, /durationSec: slice\.durationSec/);
  assert.match(source, /segmentRole: planRecord\?\.segmentRole \|\| slice\.segmentRole/);
  assert.match(source, /sliceDurationSec: planRecord\?\.sliceDurationSec \|\| slice\.durationSec/);
  assert.match(source, /segmentRole: slice\.segmentRole/);
  assert.match(source, /sliceDurationSec: slice\.durationSec/);
});
