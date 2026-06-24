function buildCheck(checkId, status, data = {}) {
  return {
    checkId,
    status,
    severity: status === "pass" ? "info" : "fail",
    message: checkId,
    ...(Object.keys(data).length ? { data } : {})
  };
}

export async function evaluateRemixQc({ output, executionPlan, mockSignals = {} }) {
  const competitorResidueScore = Number(mockSignals.competitorResidueScore ?? 1);
  const replacementCoverageScore = Number(mockSignals.replacementCoverageScore ?? 0);
  const visualIntegrityScore = Number(mockSignals.visualIntegrityScore ?? 0);
  const checks = [
    buildCheck(
      "competitor_residue_absent",
      competitorResidueScore <= 0.1 ? "pass" : "fail",
      { competitorResidueScore }
    ),
    buildCheck(
      "replacement_coverage",
      replacementCoverageScore >= 0.8 ? "pass" : "fail",
      {
        replacementCoverageScore,
        stepCount: Array.isArray(executionPlan?.steps) ? executionPlan.steps.length : 0
      }
    ),
    buildCheck(
      "visual_integrity",
      visualIntegrityScore >= 0.8 ? "pass" : "fail",
      { visualIntegrityScore }
    )
  ];
  const failed = checks.filter((item) => item.status !== "pass");
  return {
    outputId: output.outputId,
    qcStatus: failed.length ? "fail" : "pass",
    checks,
    summary: failed.length ? "自动质检未通过" : "自动质检通过"
  };
}
