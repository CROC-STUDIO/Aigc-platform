import assert from "node:assert/strict";
import test from "node:test";

import { qcPathHelpers } from "../../server/wangzhuan/qc.mjs";

test("expanded videos skip repeated model QC and become downloadable after passing derivative checks", () => {
  const batch = { estimate: { durationSec: 24 } };
  const output = {
    outputId: "out_abcd_002",
    sourceType: "pipeline",
    kind: "expanded_video",
    parentOutputId: "out_abcd_001",
    durationSec: 24,
    targetWidth: 800,
    targetHeight: 800,
    filePath: "expanded/out.mp4"
  };
  const context = { userProjectRoot: "/tmp" , config: { wangzhuan: { qcLlm: { provider: "skylink" } } } };

  assert.equal(qcPathHelpers.shouldRunModelVideoQc(context, batch, output), false);
  assert.equal(qcPathHelpers.downloadEligibility(batch, output, "pass"), true);
});

test("expanded video parent eligibility is explicit", () => {
  const output = { kind: "expanded_video", parentOutputId: "out_abcd_001" };
  assert.equal(qcPathHelpers.expandedParentStatus(output, new Map([["out_abcd_001", { qcStatus: "pass" }]])).status, "pass");
  assert.equal(qcPathHelpers.expandedParentStatus(output, new Map([["out_abcd_001", { qcStatus: "fail" }]])).status, "fail");
  assert.equal(qcPathHelpers.expandedParentStatus({ kind: "expanded_video" }, new Map()).status, "fail");
});
