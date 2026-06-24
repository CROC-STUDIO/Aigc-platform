import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRemixQc } from "../../server/wangzhuan/remix-qc.mjs";

test("evaluateRemixQc passes when competitor residue is absent and expected replacements exist", async () => {
  const qc = await evaluateRemixQc({
    output: { outputId: "out_1", previewUrl: "https://cdn.example.com/out.mp4" },
    executionPlan: { steps: [{ capabilityKey: "cta" }, { capabilityKey: "product_name" }] },
    mockSignals: {
      competitorResidueScore: 0.02,
      replacementCoverageScore: 0.96,
      visualIntegrityScore: 0.94
    }
  });
  assert.equal(qc.qcStatus, "pass");
});

test("evaluateRemixQc fails when residue and integrity scores are out of threshold", async () => {
  const qc = await evaluateRemixQc({
    output: { outputId: "out_2", previewUrl: "https://cdn.example.com/out.mp4" },
    executionPlan: { steps: [{ capabilityKey: "logo_icon" }] },
    mockSignals: {
      competitorResidueScore: 0.45,
      replacementCoverageScore: 0.52,
      visualIntegrityScore: 0.61
    }
  });
  assert.equal(qc.qcStatus, "fail");
  assert.equal(qc.checks.some((check) => check.status === "fail"), true);
});
