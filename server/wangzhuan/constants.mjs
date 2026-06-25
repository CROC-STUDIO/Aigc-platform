export const TARGET_CHANNELS = Object.freeze([
  "generic",
  "meta_ads",
  "tiktok_ads",
  "google_ads",
  "unity_ads",
  "iron_source"
]);

export const PROMISE_LEVELS = Object.freeze(["stable", "strong_conversion", "strong_commitment"]);
export const DEFAULT_RULE_PROMISE_LEVELS = Object.freeze(["stable", "strong_conversion"]);
export const TEMPLATE_STATUSES = Object.freeze(["active", "archived", "deleted"]);
export const TEMPLATE_SAVE_MODES = Object.freeze(["create", "copy", "edit_new_version"]);
export const TEMPLATE_ADMIN_ACTIONS = Object.freeze(["rename", "archive", "delete", "set_default", "rollback_default"]);

export const DEFAULT_LIMITS = Object.freeze({
  maxUploadVideoBytes: 314572800,
  maxReferenceDurationSec: 90,
  minReferenceDurationSec: 3,
  confirmGenerationTasks: 10,
  hardGenerationTasks: 50,
  confirm30sSegments: 20,
  maxConcurrency: 4,
  maxRetryPerTask: 1,
  maxRemixRegions: 8
});

export const REQUIRED_DRAFT_FIELDS = Object.freeze([
  "displayName",
  "productName",
  "currencySymbol",
  "language",
  "regions",
  "targetChannels",
  "defaultOutputRatio",
  "defaultDurationSec",
  "promiseLevel"
]);

export const REQUIRED_STRONG_TRUTH_FIELDS = Object.freeze([
  "rewardAmountRange",
  "rewardCondition",
  "withdrawalThreshold",
  "withdrawalMethod",
  "arrivalTime",
  "applicableRegion",
  "applicableChannel",
  "sourceOrUpdatedAt"
]);

function rule(channel, promiseLevel, ctaStrength, forbiddenTerms, requiredDisclaimers = []) {
  return {
    ruleId: `rule_${channel}_${promiseLevel}_v1`,
    channel,
    promiseLevel,
    version: "2026-06-17",
    forbiddenTerms,
    requiredDisclaimers,
    ctaStrength,
    fallbackUsed: false
  };
}

export const DEFAULT_CHANNEL_RULES = Object.freeze([
  rule("generic", "stable", "medium", ["guaranteed income", "instant rich"], ["Rewards vary by user"]),
  rule("generic", "strong_conversion", "high", ["guaranteed income", "no risk"], ["Rewards are not guaranteed"]),
  rule("meta_ads", "stable", "medium", ["guaranteed income", "free money"], ["Results vary by user"]),
  rule("meta_ads", "strong_conversion", "high", ["guaranteed income", "instant payout"], ["Rewards vary by eligibility"]),
  rule("tiktok_ads", "stable", "medium", ["guaranteed income", "get rich"], ["Rewards vary by user"]),
  rule("tiktok_ads", "strong_conversion", "high", ["guaranteed income", "cash guaranteed"], ["Actual rewards may vary"]),
  rule("google_ads", "stable", "low", ["guaranteed income", "misleading rewards"], ["Eligibility required"]),
  rule("google_ads", "strong_conversion", "medium", ["guaranteed income", "instant wealth"], ["Terms apply"]),
  rule("unity_ads", "stable", "medium", ["guaranteed income", "free cash"], ["Rewards vary"]),
  rule("unity_ads", "strong_conversion", "high", ["guaranteed income", "easy money"], ["Rewards vary"]),
  rule("iron_source", "stable", "medium", ["guaranteed income", "free cash"], ["Rewards vary"]),
  rule("iron_source", "strong_conversion", "high", ["guaranteed income", "easy money"], ["Rewards vary"])
]);
