const JOB_TYPE_BY_CAPABILITY = Object.freeze({
  logo_icon: "auto_ai_remove",
  watermark: "mask_edit",
  phone_ui: "mask_edit",
  product_name: "language_rewrite",
  cta: "video_copy_translate",
  subtitle: "video_copy_translate",
  ending: "end_trim_detection"
});

const EXECUTION_ORDER = Object.freeze([
  "logo_icon",
  "watermark",
  "phone_ui",
  "product_name",
  "cta",
  "subtitle",
  "ending"
]);

function fallbackCapabilityKey({ operationType = "", capabilityKey = "" } = {}) {
  if (capabilityKey) return capabilityKey;
  if (operationType === "logo_icon_cover_or_replace") return "logo_icon";
  if (operationType === "text_cta_ending_replace") return "product_name";
  return "watermark";
}

export function buildRemixPlan({ sourceId, operationType = "", capabilityKey = "", regions = [] }) {
  const fallbackKey = fallbackCapabilityKey({ operationType, capabilityKey });
  const normalizedRegions = regions.map((item) => ({
    ...item,
    capabilityKey: item.capabilityKey || fallbackKey
  }));
  const hasAnyMatchedRegion = normalizedRegions.some((item) => item.capabilityKey && JOB_TYPE_BY_CAPABILITY[item.capabilityKey]);
  const steps = EXECUTION_ORDER.flatMap((capabilityKey) => {
    const matched = normalizedRegions.filter((item) => item.capabilityKey === capabilityKey);
    if (!matched.length) {
      if (hasAnyMatchedRegion || capabilityKey !== fallbackKey) return [];
      return [{
        stepId: `${capabilityKey}_1`,
        sourceId: String(sourceId || ""),
        capabilityKey,
        jobType: JOB_TYPE_BY_CAPABILITY[capabilityKey],
        regions: []
      }];
    }
    return [{
      stepId: `${capabilityKey}_1`,
      sourceId: String(sourceId || ""),
      capabilityKey,
      jobType: JOB_TYPE_BY_CAPABILITY[capabilityKey],
      regions: matched
    }];
  });
  return {
    planId: `rmp_${Date.now()}`,
    sourceId: String(sourceId || ""),
    steps,
    warnings: []
  };
}
