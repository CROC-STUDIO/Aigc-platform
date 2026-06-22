import { REQUIRED_STRONG_TRUTH_FIELDS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { makePlanId } from "./ids.mjs";
import { resolveLlmConfig } from "./llm-config.mjs";
import { callOpenAiCompatibleLlm, parseLlmJsonContent } from "./reference-videos.mjs";

const REQUIRED_PLAN_FIELDS = Object.freeze([
  "hook",
  "body",
  "seedancePrompt",
  "imagePrompt",
  "cta",
  "negativePrompt"
]);

const SEEDANCE_PLAN_SCHEMA_HINT = Object.freeze({
  hook: "Opening hook aligned to reference pacing, without competitor branding",
  body: "Main script body for this 15s segment",
  voiceover: "Optional spoken lines",
  subtitles: ["Optional subtitle lines"],
  cta: "Call to action",
  ending: "Ending beat",
  imagePrompt: "First-frame image prompt for Seedance",
  seedancePrompt: "15s 9:16 Seedance image-to-video prompt",
  negativePrompt: "Things to avoid in generation",
  mediaRefs: {
    productIcon: "URL or empty",
    productScreenshot: "URL or empty",
    productRecording: "URL or empty"
  },
  complianceNotes: ["Policy-safe reminders"]
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => cleanString(item)).filter(Boolean);
}

export function validateBranchTruthRulesForPlan(branches = []) {
  for (const branch of branches) {
    if (branch.promiseLevel !== "strong_commitment") continue;
    const missingFields = REQUIRED_STRONG_TRUTH_FIELDS.filter((field) => !isNonEmptyString(branch.truthRules?.[field]));
    if (missingFields.length) {
      throw new WangzhuanError("strong_rule_missing", "强承诺需要补齐真实收益规则", {
        branchId: branch.branchId,
        branchLabel: branch.branchLabel,
        missingFields
      });
    }
  }
}

export function validateSeedancePlan(plan = {}, context = {}) {
  const missingFields = REQUIRED_PLAN_FIELDS.filter((field) => !isNonEmptyString(plan[field]));
  if (missingFields.length) {
    throw new WangzhuanError("schema_invalid", "Seedance 预案不完整，请重试", {
      planId: plan.planId,
      branchId: context.branchId,
      branchVariantIndex: context.branchVariantIndex,
      segmentIndex: context.segmentIndex,
      missingFields
    });
  }
  return {
    hook: cleanString(plan.hook),
    body: cleanString(plan.body),
    voiceover: cleanString(plan.voiceover),
    subtitles: normalizeStringList(plan.subtitles),
    cta: cleanString(plan.cta),
    ending: cleanString(plan.ending || plan.cta),
    imagePrompt: cleanString(plan.imagePrompt),
    seedancePrompt: cleanString(plan.seedancePrompt),
    negativePrompt: cleanString(plan.negativePrompt),
    mediaRefs: {
      productIcon: cleanString(plan.mediaRefs?.productIcon),
      productScreenshot: cleanString(plan.mediaRefs?.productScreenshot),
      productRecording: cleanString(plan.mediaRefs?.productRecording),
      endingAsset: cleanString(plan.mediaRefs?.endingAsset),
      personAsset: cleanString(plan.mediaRefs?.personAsset),
      rewardElement: cleanString(plan.mediaRefs?.rewardElement)
    },
    complianceNotes: normalizeStringList(plan.complianceNotes)
  };
}

export function buildSeedancePlanMessages({
  batch,
  branch,
  decomposition,
  channelRules = {},
  branchVariantIndex,
  segmentIndex,
  knowledgeNotes = ""
}) {
  const draft = batch.templateSnapshot?.draft || {};
  const assetUrls = branch.assetUrls || {};
  const notes = cleanString(knowledgeNotes);
  const requiredDisclaimers = [...new Set((channelRules.rules || []).flatMap((rule) => rule.requiredDisclaimers || []))];
  const promptText = [
    "你要复用参考视频的结构、节奏、镜头功能和转化逻辑。",
    "不得复刻竞品品牌、原文案、人物身份、水印、UI 细节。",
    "必须替换为我方产品资产和业务规则。",
    "不得编造收益金额、到账承诺或提现门槛。",
    "",
    "参考视频拆解：",
    JSON.stringify(decomposition || {}, null, 2),
    "",
    "业务分支：",
    JSON.stringify({
      branchId: branch.branchId,
      branchLabel: branch.branchLabel,
      productName: branch.productName || draft.productName,
      productLink: branch.productLink || draft.productLink,
      language: branch.language || draft.language,
      regions: branch.regions,
      targetChannels: branch.targetChannels,
      promiseLevel: branch.promiseLevel || draft.promiseLevel,
      materialDirection: branch.materialDirection,
      voiceoverStyle: branch.voiceoverStyle,
      customPrompt: branch.customPrompt,
      negativePrompt: branch.negativePrompt,
      variantPrompt: branch.variantPrompt,
      truthRules: branch.truthRules || {},
      assetUrls
    }, null, 2),
    "",
    "渠道规则：",
    JSON.stringify(channelRules.rules || [], null, 2),
    requiredDisclaimers.length ? `Required disclaimers: ${requiredDisclaimers.join("; ")}` : "",
    "",
    `变体编号 branchVariantIndex=${branchVariantIndex}`,
    `分段编号 segmentIndex=${segmentIndex}`,
    `输出时长 durationSec=15`,
    notes ? `业务经验规则：\n${notes}` : "业务经验规则：未填写",
    "",
    "字段说明：",
    JSON.stringify(SEEDANCE_PLAN_SCHEMA_HINT, null, 2),
    "",
    "只返回 JSON 对象。"
  ].filter(Boolean).join("\n");

  return [
    {
      role: "system",
      content: [
        "你是网赚广告 Seedance 前置参数策划专家。",
        "你要基于参考结构和我方业务元素生成可执行的 Seedance 分镜与 prompt。",
        "必须输出严格 JSON 对象，不要 markdown，不要解释。"
      ].join("\n")
    },
    {
      role: "user",
      content: promptText
    }
  ];
}

async function callPlanLlm(context, messages, llmConfig) {
  if (typeof context.callWangzhuanLlm === "function") {
    return context.callWangzhuanLlm({
      messages,
      llmConfig: {
        provider: llmConfig.provider,
        endpoint: llmConfig.endpoint,
        model: llmConfig.model,
        temperature: llmConfig.temperature,
        timeoutMs: llmConfig.timeoutMs,
        apiKeyEnv: llmConfig.apiKeyEnv
      },
      planGeneration: true
    });
  }
  return callOpenAiCompatibleLlm(llmConfig, messages);
}

export async function generateSeedancePlan(context, input = {}) {
  const llmConfig = resolveLlmConfig(context.config || {}, input.llmConfig || {});
  const messages = buildSeedancePlanMessages(input);
  const content = await callPlanLlm(context, messages, llmConfig);
  const parsed = validateSeedancePlan(parseLlmJsonContent(content), {
    branchId: input.branch?.branchId,
    branchVariantIndex: input.branchVariantIndex,
    segmentIndex: input.segmentIndex
  });
  return parsed;
}

export function buildGenerationPlanRecord({
  batch,
  branch,
  scriptId,
  generationTaskId,
  branchVariantIndex,
  segmentIndex,
  sequence,
  planPayload,
  status = "drafted"
}) {
  return {
    planId: makePlanId(batch.batchId, sequence),
    batchId: batch.batchId,
    scriptId,
    generationTaskId,
    branchId: branch.branchId,
    branchLabel: branch.branchLabel,
    branchIndex: branch.branchIndex,
    branchVariantIndex,
    variantIndex: sequence,
    segmentIndex,
    durationSec: 15,
    previewType: "seedance_plan",
    ...planPayload,
    status
  };
}
