import { REQUIRED_STRONG_TRUTH_FIELDS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { makePlanId } from "./ids.mjs";
import { llmUsesGeminiNativeApi, resolveLlmConfig } from "./llm-config.mjs";
import {
  buildReferenceAssetSlotGuide,
  formatReferenceAssetSlotGuide
} from "./reference-assets.mjs";
import { callGeminiCompatibleLlm, callOpenAiCompatibleLlm, parseLlmJsonContent, buildGeminiRequestBody } from "./reference-videos.mjs";
import { callLlmStreaming } from "./llm-stream.mjs";
import { wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { join } from "node:path";
import { resolveBranchMediaRefs, branchHasReferenceAssets } from "./branches.mjs";

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
  imagePrompt: "First-frame image prompt; explicitly state protagonist profession/identity, clothing and props; if reference assets exist, use 图片n labels from slot guide",
  seedancePrompt: "15s 9:16 Seedance omni_reference prompt; explicitly state protagonist profession/identity; use 图片n/视频n labels when reference assets exist",
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

export function formatProtagonistFissionGuide(decomposition = {}, branchVariantIndex = 1, variantPrompt = "") {
  const subject = cleanString(decomposition.subject);
  const protagonist = cleanString(decomposition.protagonist);
  const voiceover = cleanString(decomposition.voiceover);
  const continuity = cleanString(decomposition.continuityAnchors);
  const variantIndex = Number(branchVariantIndex) || 1;
  const customVariantPrompt = cleanString(variantPrompt);

  const lines = [
    "人物与职业裂变规则：",
    `- 参考拆解 subject：${subject || "未提供"}`,
    protagonist ? `- 参考拆解 protagonist：${protagonist}` : "",
    voiceover ? `- 参考拆解口播功能：${voiceover}` : "",
    continuity ? `- 连续性锚点：${continuity}` : "",
    "",
    variantIndex === 1
      ? "本变体 branchVariantIndex=1：使用参考视频拆解中的原始职业/身份作为主人物设定；seedancePrompt 与 imagePrompt 必须明确写出该职业、对应服装/道具/场景。"
      : `本变体 branchVariantIndex=${variantIndex}：在保留参考视频镜头结构、口播功能与转化节奏的前提下，将主角替换为「相似职业」裂变，不要复刻竞品人物 identity。`,
    variantIndex === 1
      ? "口播与字幕按参考拆解的功能结构改写为目标语言，人物职业与 subject/protagonist 一致。"
      : [
          "相似职业裂变要求：",
          "1. 新职业需与参考职业同属一个生活场景/人群带，例如：外卖员→快递员/跑腿员/配送员；网约车司机→出租车司机/货车司机；宝妈→全职妈妈/带娃年轻妈妈；便利店店员→超市收银员/快餐店员；上班族→白领/销售/文员；退休大爷→退休阿姨/老年夫妇；健身博主→瑜伽教练/跑步爱好者。",
          "2. 不要跳到完全无关身份（如 外卖员→医生、宝妈→程序员），除非参考视频本身就是该类型。",
          "3. seedancePrompt 与 imagePrompt 必须明确写出本变体选用的新职业，并体现在场景、服装、道具、口播语气与字幕细节中。",
          "4. 口播/字幕的转化功能（痛点/质疑/惊喜/引导下载）保持不变，只调整与新职业匹配的细节表达。",
          customVariantPrompt
            ? `5. 用户为本变体指定了 variantPrompt，人物/职业设定优先遵循：${customVariantPrompt}`
            : `5. 若用户填写了 variantPrompt，优先遵循用户对第 ${variantIndex} 个变体的人物/职业要求。`
        ].join("\n")
  ];
  return lines.filter(Boolean).join("\n");
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
    "8. seedancePrompt 与 imagePrompt 必须明确写出主角职业/身份、服装与关键道具，不能只写“用户/年轻人/女性”。",
    "9. 免责声明只写入 complianceNotes（如需），不要写入 seedancePrompt。"
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

function sanitizePlanAssetReferences(plan = {}, branch = {}) {
  if (branchHasReferenceAssets(branch)) return plan;
  const stripSlotRefs = (text = "") => String(text)
    .replace(/图片[0-9]+/g, "产品画面")
    .replace(/视频[0-9]+/g, "参考镜头")
    .replace(/\bimage[0-9]+\b/gi, "product visual")
    .replace(/\bvideo[0-9]+\b/gi, "reference clip");
  return {
    ...plan,
    imagePrompt: stripSlotRefs(plan.imagePrompt),
    seedancePrompt: stripSlotRefs(plan.seedancePrompt)
  };
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
  return sanitizePlanAssetReferences({
    hook: cleanString(plan.hook),
    body: cleanString(plan.body),
    voiceover: cleanString(plan.voiceover),
    subtitles: normalizeStringList(plan.subtitles),
    cta: cleanString(plan.cta),
    ending: cleanString(plan.ending || plan.cta),
    imagePrompt: cleanString(plan.imagePrompt),
    seedancePrompt: cleanString(plan.seedancePrompt),
    negativePrompt: cleanString(plan.negativePrompt),
    mediaRefs: resolveBranchMediaRefs(context.branch || {}, {
      productIcon: cleanString(plan.mediaRefs?.productIcon),
      productScreenshot: cleanString(plan.mediaRefs?.productScreenshot),
      productRecording: cleanString(plan.mediaRefs?.productRecording),
      endingAsset: cleanString(plan.mediaRefs?.endingAsset),
      personAsset: cleanString(plan.mediaRefs?.personAsset),
      rewardElement: cleanString(plan.mediaRefs?.rewardElement)
    }),
    complianceNotes: normalizeStringList(plan.complianceNotes)
  }, context.branch || {});
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
  const protagonistGuideText = formatProtagonistFissionGuide(
    decomposition,
    branchVariantIndex,
    branch.variantPrompt
  );
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
    protagonistGuideText,
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
    "Seedance prompt 补充要求：",
    "1. seedancePrompt 必须按参考拆解 action 的时间节奏写镜头，并明确主角职业/身份。",
    "2. branchVariantIndex>1 时使用相似职业裂变，同步调整服装、场景细节与口播语气，但保持转化结构不变。",
    "3. voiceover/subtitles 的每段功能需对应参考拆解中的口播/字幕功能，不要写成通用广告话术。",
    "4. imagePrompt 首帧必须锁定本变体的人物职业、外观与服装，便于后续视频生成保持一致。",
    "",
    "只返回 JSON 对象。"
  ].filter(Boolean).join("\n");

  return [
    {
      role: "system",
      content: [
        "你是网赚广告 Seedance 前置参数策划专家。",
        "你要基于参考结构和我方业务元素生成可执行的 Seedance 分镜与 prompt。",
        "必须继承参考拆解中的人物职业/身份设定；branchVariantIndex=1 用原职业，branchVariantIndex>1 可在相同人群带内替换为相似职业裂变。",
        "seedancePrompt 与 imagePrompt 必须明确写出主角职业、服装与关键道具，禁止“用户/年轻人”等泛化人物描述。",
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
  if (context.llmStreamHandlers) {
    return callLlmStreaming(
      llmConfig,
      messages,
      context.llmStreamHandlers,
      (messageList) => buildGeminiRequestBody(messageList, llmConfig.temperature)
    );
  }
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
  return llmUsesGeminiNativeApi(llmConfig)
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
    branch: input.branch || {},
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
