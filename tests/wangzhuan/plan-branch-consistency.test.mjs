import assert from "node:assert/strict";
import test from "node:test";

import {
  branchPlanCoverage,
  branchPlanSignature
} from "../../public/wangzhuan-common.js";

const branches = [
  { branchId: "branch_1", branchLabel: "改写 3.1", productName: "PerkPlay", materialDirection: "痛点开场" },
  { branchId: "branch_2", branchLabel: "改写 3.2", productName: "PerkPlay", materialDirection: "余额刺激" }
];

test("branch plan signature changes when fission branch coverage changes", () => {
  const singleBranchPlans = [
    { planId: "plan_1", branchId: "branch_1", branchVariantIndex: 1, segmentIndex: 1 }
  ];
  const multiBranchPlans = [
    ...singleBranchPlans,
    { planId: "plan_2", branchId: "branch_2", branchVariantIndex: 1, segmentIndex: 1 }
  ];

  assert.notEqual(
    branchPlanSignature(branches, singleBranchPlans),
    branchPlanSignature(branches, multiBranchPlans)
  );
});

test("branch plan coverage rejects stale single-branch plans for current multi-branch drafts", () => {
  const coverage = branchPlanCoverage(branches, [
    { planId: "plan_1", branchId: "branch_1", branchVariantIndex: 1, segmentIndex: 1 }
  ]);

  assert.equal(coverage.ok, false);
  assert.deepEqual(coverage.missingBranchIds, ["branch_2"]);
  assert.equal(coverage.currentBranchCount, 2);
  assert.equal(coverage.planBranchCount, 1);
});

test("branch plan coverage accepts complete multi-branch preview plans", () => {
  const coverage = branchPlanCoverage(branches, [
    { planId: "plan_1", branchId: "branch_1", branchVariantIndex: 1, segmentIndex: 1 },
    { planId: "plan_2", branchId: "branch_2", branchVariantIndex: 1, segmentIndex: 1 }
  ]);

  assert.equal(coverage.ok, true);
  assert.deepEqual(coverage.missingBranchIds, []);
  assert.equal(coverage.currentBranchCount, 2);
  assert.equal(coverage.planBranchCount, 2);
});

test("branch plan signature changes when a fission branch draft changes", () => {
  const plans = [
    { planId: "plan_1", branchId: "branch_1", branchVariantIndex: 1, segmentIndex: 1 },
    { planId: "plan_2", branchId: "branch_2", branchVariantIndex: 1, segmentIndex: 1 }
  ];
  const editedBranches = branches.map((branch) => branch.branchId === "branch_2"
    ? { ...branch, materialDirection: "强 CTA" }
    : branch);

  assert.notEqual(
    branchPlanSignature(branches, plans),
    branchPlanSignature(editedBranches, plans)
  );
});
