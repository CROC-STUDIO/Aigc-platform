import { REQUIRED_STRONG_TRUTH_FIELDS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { makePlanId } from "./ids.mjs";
import { llmUsesGeminiCompat, resolveLlmConfig } from "./llm-config.mjs";
import {
  buildReferenceAssetSlotGuide,
  formatReferenceAssetSlotGuide
} from "./reference-assets.mjs";
import { callGeminiCompatibleLlm, callOpenAiCompatibleLlm, parseLlmJsonContent } from "./reference-videos.mjs";
import { wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { join } from "node:path";

const REQUIRED_PLAN_FIELDS = Object.freeze([
  "hook",
  "body",
  "seedancePrompt",
  "imagePrompt",
  "cta",
  "negativePrompt"
]);

const SEEDANCE_PLAN_SCHEMA_HINT = Object.freeze({
  hook: "Opening hook in primary language; align to reference pacing without competitor branding",
  body: "Main script body in primary language for this 15s segment",
  voiceover: "Spoken lines in primary language",
  subtitles: ["Short subtitle lines in primary language, one beat per line"],
  cta: "Call to action in primary language",
  ending: "Ending beat in primary language",
  imagePrompt: "First-frame image prompt; if reference assets exist, use 图片n labels from slot guide",
  seedancePrompt: "15s 9:16 Seedance omni_reference prompt; use 图片n/视频n labels when reference assets exist",
  negativePrompt: "Things to avoid in generation",
  mediaRefs: {
    productIcon: "URL or empty",
    productScreenshot: "URL or empty",
    productRecording: "URL or empty",
    endingAsset: "URL or empty",
    personAsset: "URL or empty",
    rewardElement: "URL or empty"
  },
  complianceNotes: ["Policy-safe reminders in primary language; do not paste disclaimer overlay text into seedancePrompt"]
});

const LANGUAGE_LABELS = Object.freeze({
  "en-US": "English (United States)",
  "en-GB": "English (United Kingdom)",
  "pt-BR": "Portuguese (Brazil)",
  "pt-PT": "Portuguese (Portugal)",
  "es-MX": "Spanish (Mexico)",
  "es-ES": "Spanish (Spain)",
  "zh-CN": "Chinese (Simplified)",
  "zh-TW": "Chinese (Traditional)",
  "ja-JP": "Japanese",
  "ko-KR": "Korean",
  "id-ID": "Indonesian",
  "th-TH": "Thai",
  "vi-VN": "Vietnamese"
});

const REGION_LABELS = Object.freeze({
  US: "United States",
  GB: "United Kingdom",
  BR: "Brazil",
  PT: "Portugal",
  MX: "Mexico",
  ES: "Spain",
  CN: "China",
  TW: "Taiwan",
  JP: "Japan",
  KR: "Korea",
  ID: "Indonesia",
  TH: "Thailand",
  VN: "Vietnam"
});

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function resolveStringList(...values) {
  for (const value of values) {
    const list = normalizeStringList(value);
    if (list.length) return list;
  }
  return [];
}

function languageLabel(code = "") {
  const value = cleanString(code);
  return value ? (LANGUAGE_LABELS[value] || value) : "";
}

function regionLabel(code = "") {
  const value = cleanString(code).toUpperCase();
  return value ? (REGION_LABELS[value] || value) : "";
}

export function resolvePlanLocaleContext(batch = {}, branch = {}) {
  const draft = batch.templateSnapshot?.draft || {};
  const estimateRequest = batch.estimate?.request || {};
  const languages = resolveStringList(
    branch.languages,
    branch.language,
    estimateRequest.languages,
    batch.estimate?.languages,
    draft.languages,
    draft.language,
    estimateRequest.language,
    "en-US"
  );
  const regions = resolveStringList(
    branch.regions,
    estimateRequest.targetRegions,
    batch.estimate?.targetRegions,
    estimateRequest.targetRegion,
    draft.regions
  );
  return {
    primaryLanguage: languages[0] || "en-US",
    languages,
    regions,
    primaryRegion: regions[0] || "",
    currencySymbol: cleanString(branch.currencySymbol)
      || cleanString(draft.currencySymbol)
      || cleanString(estimateRequest.currencySymbol),
    targetChannel: cleanString(branch.targetChannels?.[0])
      || cleanString(estimateRequest.targetChannel)
      || cleanString(draft.targetChannels?.[0]),
    outputRatio: cleanString(batch.estimate?.outputRatio)
      || cleanString(estimateRequest.outputRatio)
      || cleanString(branch.defaultOutputRatio)
      || cleanString(draft.defaultOutputRatio)
      || "9:16",
    voiceoverStyle: cleanString(branch.voiceoverStyle) || cleanString(draft.voiceoverStyle),
    disclaimer: cleanString(branch.disclaimer) || cleanString(estimateRequest.disclaimer)
  };
}

export function formatPlanLocaleGuide(context = {}) {
  const primaryLanguageLabel = languageLabel(context.primaryLanguage);
  const regionLabels = (context.regions || []).map(regionLabel).filter(Boolean);
  const lines = [
    `主语言 primaryLanguage=${context.primaryLanguage}${primaryLanguageLabel ? ` (${primaryLanguageLabel})` : ""}`,
    context.languages?.length > 1 ? `全部语言 languages=${context.languages.join(", ")}` : "",
    context.regions?.length
      ? `目标地区 regions=${context.regions.join(", ")}${regionLabels.length ? ` (${regionLabels.join(", ")})` : ""}`
      : "目标地区 regions=未指定",
    context.currencySymbol ? `货币符号 currencySymbol=${context.currencySymbol}` : "货币符号 currencySymbol=未指定",
    context.targetChannel ? `投放渠道 targetChannel=${context.targetChannel}` : "",
    context.outputRatio ? `画面比例 outputRatio=${context.outputRatio}` : "",
    context.voiceoverStyle ? `口播风格 voiceoverStyle=${context.voiceoverStyle}` : "",
    "",
    "语言与地区输出规则：",
    `1. hook、body、voiceover、subtitles、cta、ending 必须使用主语言 ${context.primaryLanguage} 撰写。`,
    context.languages?.length > 1
      ? `2. 若存在多语言配置（${context.languages.join(", ")}），仍以前述主语言输出本段预案，不要混用语言。`
      : "2. 全部用户可见文案保持单一主语言，不要混用竞品原语言。",
    context.regions?.length
      ? `3. 叙事、奖励反馈、生活场景与金额表达需符合 ${context.regions.join(", ")} 当地习惯与合规预期。`
      : "3. 叙事与奖励表达需符合目标市场习惯。",
    context.currencySymbol
      ? `4. 所有金额、奖励数值使用 ${context.currencySymbol}，并与 truthRules 一致，禁止编造。`
      : "4. 如涉及金额，需与 truthRules 一致，禁止编造。",
    context.voiceoverStyle
      ? `5. voiceover 采用 ${context.voiceoverStyle} 口吻；subtitles 为主语言短句，每条对应一个镜头节点。`
      : "5. subtitles 为主语言短句，每条对应一个镜头节点。",
    "6. 参考视频若为其他语言，必须完整改写为目标语言，不得保留原文。",
    "7. seedancePrompt 与 imagePrompt 中的 UI 文案、口播、字幕描述也使用主语言。",
    "8. 免责声明只写入 complianceNotes（如需），不要写入 seedancePrompt。"
  ];
  return lines.filter(Boolean).join("\n");
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
  const localeContext = resolvePlanLocaleContext(batch, branch);
  const localeGuideText = formatPlanLocaleGuide(localeContext);
  const referenceSlotGuide = buildReferenceAssetSlotGuide(assetUrls, branch.assetFileNames || {});
  const referenceSlotGuideText = formatReferenceAssetSlotGuide(referenceSlotGuide);
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
    "语言与地区要求：",
    localeGuideText,
    "",
    "业务分支：",
    JSON.stringify({
      branchId: branch.branchId,
      branchLabel: branch.branchLabel,
      productName: branch.productName || draft.productName,
      productLink: branch.productLink || draft.productLink,
      language: localeContext.primaryLanguage,
      languages: localeContext.languages,
      regions: localeContext.regions,
      currencySymbol: localeContext.currencySymbol,
      targetChannels: branch.targetChannels || (localeContext.targetChannel ? [localeContext.targetChannel] : []),
      outputRatio: localeContext.outputRatio,
      promiseLevel: branch.promiseLevel || draft.promiseLevel,
      materialDirection: branch.materialDirection,
      voiceoverStyle: localeContext.voiceoverStyle,
      customPrompt: branch.customPrompt,
      negativePrompt: branch.negativePrompt,
      variantPrompt: branch.variantPrompt,
      truthRules: branch.truthRules || {},
      assetUrls,
      assetFileNames: branch.assetFileNames || {}
    }, null, 2),
    "",
    "Seedance 参考素材 slot 映射：",
    referenceSlotGuideText,
    "",
    referenceSlotGuide.length
      ? "输出要求：imagePrompt 与 seedancePrompt 必须明确使用上述 图片n/视频n 指代已上传素材；mediaRefs 填写对应 URL。"
      : "输出要求：未上传参考素材时，imagePrompt 与 seedancePrompt 不要使用 图片n/视频n 指代。",
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
        "所有 hook、body、voiceover、subtitles、cta、ending 必须使用指定主语言，并符合目标地区表达习惯。",
        "若提供了参考素材 slot 映射，imagePrompt 与 seedancePrompt 必须使用 图片1、图片2、视频1 等指代，并与 slot 顺序一致。",
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
  const dumpRequest = async (dump) => {
    const batchId = String(context?.currentBatchId || "").trim();
    const requestId = String(context?.requestId || "").trim();
    if (!batchId || !requestId || !context?.userProjectRoot) return;
    const target = join(wangzhuanPaths(context).batchesDir, batchId, `llm-request-plan-${requestId}.json`);
    await writeAtomicJson(target, dump);
  };
  return llmUsesGeminiCompat(llmConfig)
    ? callGeminiCompatibleLlm(llmConfig, messages, { requestId: context?.requestId, dumpRequest })
    : callOpenAiCompatibleLlm(llmConfig, messages, { requestId: context?.requestId, dumpRequest });
}

export async function generateSeedancePlan(context, input = {}) {
  const llmConfig = resolveLlmConfig(context.config || {}, input.llmConfig || {});
  const messages = buildSeedancePlanMessages(input);
  const content = await callPlanLlm({
    ...context,
    currentBatchId: input.batch?.batchId || context?.currentBatchId || ""
  }, messages, llmConfig);
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
