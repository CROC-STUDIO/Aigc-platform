import { hasAnyStrongTruthRule } from "./constants.mjs";
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
  "negativePrompt"
]);

const SEEDANCE_PLAN_SCHEMA_HINT = Object.freeze({
  hook: "Opening hook in primary language; align to reference pacing without competitor branding",
  body: "Main script body in primary language for this 15s segment",
  voiceover: "Spoken lines in primary language",
  subtitles: ["Short subtitle lines in primary language, one beat per line"],
  cta: "Optional call to action in primary language; default to empty unless channel rules, branch customPrompt, or truthRules explicitly require a CTA",
  ending: "Optional ending beat in primary language; default to empty unless channel rules, branch customPrompt, or truthRules explicitly require an ending card/beat",
  imagePrompt: "First-frame image prompt using Seedance formula: new subject + motion + new environment + aesthetics; must redesign identity, scene, clothing and props; if reference assets exist, use 图片n labels from slot guide",
  seedancePrompt: "15s 9:16 Seedance omni_reference prompt; write shot-by-shot using subject + motion + environment + camera/cut + aesthetics + audio/text; reuse only the reference structure, pacing, shot functions and conversion logic; use 图片n/视频n labels when reference assets exist",
  negativePrompt: "Things to avoid in generation",
  segmentRole: "Role of this slice: hook_slice, proof_slice, withdrawal_slice, cta_slice, or continuity_slice",
  sliceDurationSec: "Target slice duration, preferably 10-15 seconds for multi-slice net-earning materials",
  outputTemplateMode: "reference_fission | three_slice_net_earning | short_drama_earning_highlight",
  moneyVisuals: ["coin_burst", "cash_rain", "reward_number_growth", "withdrawal_success"],
  withdrawalVisual: "Withdrawal or reward proof visual without invented exact amounts unless truthRules provide them",
  subtitleWorkflow: {
    burnedInSubtitles: false,
    postSubtitleRequired: true,
    provider: "pixel_tech",
    subtitleScript: ["Short post-process subtitle lines"]
  },
  sliceDiversity: {
    personChangedFromPrevious: "true for segmentIndex > 1 unless continuity mode explicitly requires same person",
    sceneChangedFromPrevious: "true for segmentIndex > 1 unless continuity mode explicitly requires same scene",
    clothingChangedFromPrevious: "true for segmentIndex > 1 unless continuity mode explicitly requires same clothing",
    voiceChangedFromPrevious: "true for segmentIndex > 1 unless continuity mode explicitly requires same voice"
  },
  mediaRefs: {
    productIcon: "URL or empty",
    productScreenshot: "URL or empty",
    productRecording: "URL or empty",
    endingAsset: "URL or empty",
    personAsset: "URL or empty",
    rewardElement: "URL or empty"
  },
  complianceNotes: ["Policy-safe reminders in primary language; do not paste disclaimer overlay text into seedancePrompt; record any omitted CTA/amount/claim risks here"]
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

function resolveCleanString(...values) {
  for (const value of values) {
    const text = cleanString(value);
    if (text) return text;
  }
  return "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const text = cleanString(value);
  return text ? [text] : [];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function clampSliceDuration(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 15;
  return Math.max(10, Math.min(15, Math.round(number)));
}

function normalizeSubtitleWorkflow(value = {}, subtitles = [], fallback = {}) {
  const source = normalizeObject(value);
  const fallbackSource = normalizeObject(fallback);
  const subtitleScript = normalizeStringList(source.subtitleScript);
  const fallbackSubtitleScript = normalizeStringList(fallbackSource.subtitleScript);
  return {
    burnedInSubtitles: false,
    postSubtitleRequired: source.postSubtitleRequired !== undefined
      ? source.postSubtitleRequired !== false
      : fallbackSource.postSubtitleRequired !== false,
    provider: cleanString(source.provider) || cleanString(fallbackSource.provider) || "pixel_tech",
    subtitleScript: subtitleScript.length
      ? subtitleScript
      : (normalizeStringList(subtitles).length
          ? normalizeStringList(subtitles)
      : fallbackSubtitleScript)
  };
}

function normalizeSubtitleWorkflowMode(mode = "") {
  const normalizedMode = cleanString(mode).toLowerCase();
  if (["none", "no_post_process", "off"].includes(normalizedMode)) {
    return {
      burnedInSubtitles: false,
      postSubtitleRequired: false,
      provider: "pixel_tech",
      subtitleScript: []
    };
  }
  return {
    burnedInSubtitles: false,
    postSubtitleRequired: true,
    provider: "pixel_tech",
    subtitleScript: []
  };
}

function resolveNormalizedSubtitleWorkflow(value, fallback = undefined) {
  const source = normalizeObject(value);
  if (Object.keys(source).length) {
    return normalizeSubtitleWorkflow(source, [], normalizeObject(fallback));
  }
  const text = cleanString(value);
  if (text) {
    return normalizeSubtitleWorkflowMode(text);
  }
  const fallbackObject = normalizeObject(fallback);
  if (Object.keys(fallbackObject).length) {
    return normalizeSubtitleWorkflow(fallbackObject);
  }
  const fallbackText = cleanString(fallback);
  if (fallbackText) {
    return normalizeSubtitleWorkflowMode(fallbackText);
  }
  return normalizeSubtitleWorkflow();
}

function normalizeSliceDiversity(value = {}, fallback = {}) {
  const source = normalizeObject(value);
  const fallbackSource = normalizeObject(fallback);
  return {
    personChangedFromPrevious: source.personChangedFromPrevious !== undefined
      ? Boolean(source.personChangedFromPrevious)
      : Boolean(fallbackSource.personChangedFromPrevious),
    sceneChangedFromPrevious: source.sceneChangedFromPrevious !== undefined
      ? Boolean(source.sceneChangedFromPrevious)
      : Boolean(fallbackSource.sceneChangedFromPrevious),
    clothingChangedFromPrevious: source.clothingChangedFromPrevious !== undefined
      ? Boolean(source.clothingChangedFromPrevious)
      : Boolean(fallbackSource.clothingChangedFromPrevious),
    voiceChangedFromPrevious: source.voiceChangedFromPrevious !== undefined
      ? Boolean(source.voiceChangedFromPrevious)
      : Boolean(fallbackSource.voiceChangedFromPrevious)
  };
}

function resolveSeedancePlanValidationContext(input = {}) {
  const draft = normalizeObject(input.batch?.templateSnapshot?.draft);
  const branch = normalizeObject(input.branch);
  const explicitSliceDiversity = normalizeObject(input.sliceDiversity);
  const draftSubtitleWorkflow = resolveNormalizedSubtitleWorkflow(draft.subtitleWorkflow);
  const branchSubtitleWorkflow = resolveNormalizedSubtitleWorkflow(branch.subtitleWorkflow, draftSubtitleWorkflow);
  const explicitSubtitleWorkflow = resolveNormalizedSubtitleWorkflow(input.subtitleWorkflow, branchSubtitleWorkflow);
  return {
    branch,
    branchId: branch.branchId,
    branchVariantIndex: input.branchVariantIndex,
    segmentIndex: input.segmentIndex,
    segmentRole: cleanString(input.segmentRole) || cleanString(branch.segmentRole) || cleanString(draft.segmentRole),
    sliceDurationSec: input.sliceDurationSec ?? branch.sliceDurationSec ?? draft.sliceDurationSec ?? 15,
    outputTemplateMode: cleanString(input.outputTemplateMode)
      || cleanString(branch.outputTemplateMode)
      || cleanString(draft.outputTemplateMode),
    moneyVisuals: resolveStringList(input.moneyVisuals, branch.moneyVisuals, draft.moneyVisuals),
    withdrawalVisual: cleanString(input.withdrawalVisual)
      || cleanString(branch.withdrawalVisual)
      || cleanString(draft.withdrawalVisual),
    subtitleWorkflow: explicitSubtitleWorkflow,
    sliceDiversity: {
      ...normalizeObject(draft.sliceDiversity),
      ...normalizeObject(branch.sliceDiversity),
      ...explicitSliceDiversity
    }
  };
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
  const scene = cleanString(decomposition.scene);
  const action = cleanString(decomposition.action);
  const camera = cleanString(decomposition.camera);
  const lighting = cleanString(decomposition.lighting);
  const style = cleanString(decomposition.style);
  const quality = cleanString(decomposition.quality);
  const voiceover = cleanString(decomposition.voiceover);
  const continuity = cleanString(decomposition.continuityAnchors);
  const variantIndex = Number(branchVariantIndex) || 1;
  const customVariantPrompt = cleanString(variantPrompt);

  const lines = [
    "画面骨架与人物场景重构规则：",
    "参考拆解只提供可迁移的画面骨架，不提供可照搬的人物、职业、场景、服装或道具。",
    "重点参考字段：scene、subject、action、camera、lighting、style、quality。",
    `- 参考拆解 subject：${subject || "未提供"}`,
    protagonist ? `- 参考拆解 protagonist：${protagonist}` : "",
    scene ? `- 参考拆解 scene：${scene}` : "",
    action ? `- 参考拆解 action：${action}` : "",
    camera ? `- 参考拆解 camera：${camera}` : "",
    lighting ? `- 参考拆解 lighting：${lighting}` : "",
    style ? `- 参考拆解 style：${style}` : "",
    quality ? `- 参考拆解 quality：${quality}` : "",
    voiceover ? `- 参考拆解口播功能：${voiceover}` : "",
    continuity ? `- 连续性锚点：${continuity}` : "",
    "",
    `本变体 branchVariantIndex=${variantIndex}：只复用参考视频的结构、节奏、镜头功能和转化逻辑；人物身份、职业/人群、具体场景、服装、道具和具体情节必须全部重构，不能继承原人物或限制为相似职业。`,
    [
      "重构要求：",
      "1. 必须改变参考视频的人物身份、职业/人群、具体场景、服装、道具、具体情节、口播表达和字幕表达。",
      "2. 不复刻竞品人物 identity、原场景、原 UI 细节、品牌、水印或原文案。",
      "3. seedancePrompt 与 imagePrompt 必须明确写出本变体的新人物/身份、场景、服装、道具和环境，不能只写“用户/年轻人/女性”。",
      "4. 口播/字幕只保留参考拆解的功能位置和转化作用（如开场吸引、痛点、质疑、反馈、引导），具体人设、场景和表达必须重写。",
      "5. scene 只参考场景功能，必须换成新的具体场景；subject 只参考主体在转化链路中的作用，必须换成新人群。",
      "6. action 重点复用动作节奏和转化功能，但动作表现要重写；camera、lighting、style、quality 作为镜头语言、光线、风格和质量约束。",
      "7. ending 和 CTA 不是必选；只有参考结构、渠道规则或业务分支需要时才写入，不要为了凑结构强行添加。",
      customVariantPrompt
        ? `8. 用户为本变体指定了 variantPrompt，人物、场景和表达优先遵循：${customVariantPrompt}`
        : `8. 若用户填写了 variantPrompt，优先遵循用户对第 ${variantIndex} 个变体的人物、场景和表达要求。`
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
    `1. 主语言强控制：hook、body、voiceover、subtitles 必须使用主语言 ${context.primaryLanguage} 撰写；cta、ending 如存在也必须使用主语言。`,
    context.languages?.length > 1
      ? `2. 若存在多语言配置（${context.languages.join(", ")}），仍以前述主语言输出本段预案，不要混用语言。`
      : "2. 全部用户可见文案保持单一主语言，不要混用竞品原语言。",
    context.regions?.length
      ? `3. 地区强控制：人物外观、人种/肤色范围、发型、生活场景、职业身份、服装道具、城市/室内环境、街景细节、叙事语境、奖励反馈和金额表达必须参考目标地区 ${context.regions.join(", ")}${regionLabels.length ? `（${regionLabels.join(", ")}）` : ""} 的常见真实人群与生活环境。`
      : "3. 地区强控制：人物外观、人种/肤色范围、生活场景、职业身份、服装道具、城市/室内环境、街景细节、叙事语境与奖励反馈必须符合目标市场习惯。",
    context.currencySymbol
      ? `4. 币种强控制：所有用户可见金额、余额、提现档位、奖励金额、UI 金额符号、字幕金额和口播金额只能使用 ${context.currencySymbol}，并与 truthRules 一致，禁止编造；不得混用其他币种符号或其他国家货币名称。`
      : "4. 币种强控制：如涉及金额，必须与 truthRules 一致，禁止编造；未指定 currencySymbol 时不要生成具体金额或货币符号。",
    context.voiceoverStyle
      ? `5. voiceover 采用 ${context.voiceoverStyle} 口吻；subtitles 为主语言短句，每条对应一个镜头节点。`
      : "5. subtitles 为主语言短句，每条对应一个镜头节点。",
    "6. 参考视频若为其他语言，必须完整改写为目标语言，不得保留原文。",
    "7. 用户可见文字强控制：seedancePrompt 与 imagePrompt 中出现的所有用户可见文字，包括口播、字幕、手机 UI、按钮、Slogan、CTA、弹窗、任务卡、奖励提示、进度条标签、页面标题，都必须使用主语言；除产品名/品牌名外，不得出现竞品原语言、英文默认按钮或其他非主语言文字。",
    "8. seedancePrompt 与 imagePrompt 必须明确写出新人物/身份、新场景、新服装与新关键道具，并让人物外观、人种/肤色范围、生活环境、职业身份、服装道具和城市/室内环境符合目标地区；不能只写“用户/年轻人/女性”。",
    "9. 免责声明只写入 complianceNotes（如需），不要写入 seedancePrompt。"
  ];
  return lines.filter(Boolean).join("\n");
}

export function validateBranchTruthRulesForPlan(branches = []) {
  for (const branch of branches) {
    if (branch.promiseLevel !== "strong_commitment") continue;
    if (!hasAnyStrongTruthRule(branch.truthRules)) {
      throw new WangzhuanError("strong_rule_missing", "强承诺需要补齐真实收益规则", {
        branchId: branch.branchId,
        branchLabel: branch.branchLabel,
        field: "truthRules"
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
  const contextSubtitleWorkflow = resolveNormalizedSubtitleWorkflow(
    context.subtitleWorkflow,
    resolveNormalizedSubtitleWorkflow(
      context.branch?.subtitleWorkflow,
      context.batch?.templateSnapshot?.draft?.subtitleWorkflow
    )
  );
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
    complianceNotes: normalizeStringList(plan.complianceNotes),
    segmentRole: cleanString(plan.segmentRole) || cleanString(context.segmentRole),
    sliceDurationSec: clampSliceDuration(plan.sliceDurationSec ?? context.sliceDurationSec ?? 15),
    outputTemplateMode: cleanString(plan.outputTemplateMode) || cleanString(context.outputTemplateMode),
    moneyVisuals: resolveStringList(plan.moneyVisuals, context.moneyVisuals),
    withdrawalVisual: cleanString(plan.withdrawalVisual) || cleanString(context.withdrawalVisual),
    subtitleWorkflow: normalizeSubtitleWorkflow(
      plan.subtitleWorkflow,
      plan.subtitles,
      contextSubtitleWorkflow
    ),
    sliceDiversity: normalizeSliceDiversity(plan.sliceDiversity, context.sliceDiversity)
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
  const outputTemplateMode = resolveCleanString(branch.outputTemplateMode, draft.outputTemplateMode, "reference_fission");
  const sliceStrategy = resolveCleanString(branch.sliceStrategy, draft.sliceStrategy, "fixed_15s");
  const moneyVisuals = resolveStringList(branch.moneyVisuals, draft.moneyVisuals);
  const subtitleWorkflow = resolveNormalizedSubtitleWorkflow(
    branch.subtitleWorkflow,
    resolveNormalizedSubtitleWorkflow(draft.subtitleWorkflow)
  );
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
    "你必须重构参考视频的人物身份、职业/人群、具体场景、服装、道具、具体情节、口播表达和字幕表达。",
    "参考拆解中的 scene、subject、action、camera、lighting、style、quality 只作为画面骨架和镜头约束，不得作为照搬内容。",
    "不得复刻竞品品牌、原文案、人物身份、水印、UI 细节。",
    "必须替换为我方产品资产和业务规则。",
    "不得编造收益金额、到账承诺或提现门槛。",
    "默认不要生成 CTA 或 ending；只有 channelRules、branch.customPrompt 或 truthRules 明确要求时才填写，否则 cta 和 ending 必须为空字符串。",
    "不得在 hook、body、voiceover、subtitles、imagePrompt、seedancePrompt、cta、ending 或 UI 文案中编造任何金额、积分点数、奖励数值、余额、提现档位、到账路径或时间。",
    "若 truthRules 没有提供明确金额、积分点数、奖励数值或门槛，禁止出现具体金额、点数增长、余额增长、提现金额、R$ 数字，或任何语言中的确定到账、直接到账、即时到账、保证提现、真实收入、固定收益、稳赚等强承诺语义。",
    "承诺强度规则：当 promiseLevel 不是 strong_commitment 时，只能使用弱承诺表达，禁止任何语言中的确定到账、直接到账、即时到账、保证提现、真实收入、固定收益、稳赚等强收益语义；当 promiseLevel 是 strong_commitment 时，可以表达强承诺，但必须严格受 truthRules 约束，不得新增 truthRules 未写明的金额、到账速度、保证性词汇、提现资格或限制条件。",
    "可以表达为“按规则完成任务后累积奖励/积分/进度”，但必须避免让用户理解为必然赚钱、固定金额或 guaranteed cashout。",
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
      targetChannel: localeContext.targetChannel,
      targetChannels: branch.targetChannels || (localeContext.targetChannel ? [localeContext.targetChannel] : []),
      outputRatio: localeContext.outputRatio,
      outputTemplateMode,
      sliceStrategy,
      moneyVisuals,
      subtitleWorkflow,
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
      ? "输出要求：imagePrompt 与 seedancePrompt 必须明确使用上述 图片n/视频n 指代已上传素材，并说明参考该素材的主体、构图、UI、动作、运镜或特效；mediaRefs 填写对应 URL。"
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
    "网赚出量模板规则：",
    "1. outputTemplateMode=three_slice_net_earning 时，优先采用三段式或多段式拼接结构；每个切片建议10-15秒，后端可按模型能力拆成 Seedance 片段。",
    "2. 不同切片之间必须体现人物、场景、服装和声音变化，避免同一人物或同一场景贯穿全片；sliceDiversity 必须记录变化点。",
    "3. 每个切片都要围绕“网赚安利 + 提现展示”展开，形式以单人或双人口播推荐 + 产品界面展示为主，减少大段屏幕文字。",
    "4. outputTemplateMode=short_drama_earning_highlight 时，开头先给短剧高光或冲突钩子，中后段切换至赚钱安利链路，重点展示产品剧源、产品界面、看短剧得奖励的链路，结尾强化提现能力。",
    "5. moneyVisuals 可使用真钞、金币、现金雨、金币爆发、收益数字增长、提现成功、到账动画、提现记录，也可扩展为满屏撒钱/撒金币或真实风格截图；未提供 truthRules 时，这些元素只能表现为无具体金额的数字增长或其他不含具体金额的视觉反馈，不得出现具体金额、到账速度或保证收益。",
    "6. withdrawalVisual 必须说明提现展示方式，例如 Pix/Nubank 选项、银行卡到账动画、提现记录截图或本地支付方式；具体金额、门槛和到账时间只能来自 truthRules。",
    "7. Seedance 原视频不得烧录字幕、不得生成长字幕或密集画面文字；字幕内容写入 subtitleWorkflow.subtitleScript，供 Pixel Tech 或后处理贴字幕。",
    "",
    "Seedance prompt 补充要求：",
    "1. seedancePrompt 必须按镜头拆分，每个镜头使用 Seedance 公式：主体 + 运动 + 环境 + 运镜/切镜 + 美学描述 + 音频/文字。",
    "2. 每个镜头必须说明该镜头的转化功能，例如开场吸引、痛点、产品动作、反馈、疑虑消除、自然收束或引导。",
    "3. subject 只保留主体功能，必须换成新的具体人物/人群；scene 只保留场景功能，必须换成新的具体场景。",
    "4. action 必须复用节奏和转化功能，但动作表现、人物行为和口播表达必须重写。",
    "5. camera、lighting、style、quality 分别作为运镜/切镜、光线、风格和画面质量约束写入 seedancePrompt。",
    "6. voiceover/subtitles 的每段功能需对应参考拆解中的口播/字幕功能，但具体文案必须重写，不要写成通用广告话术。",
    "7. imagePrompt 首帧必须锁定本变体的新人物/身份、新场景、新服装、新道具和产品露出，便于后续视频生成保持一致。",
    "8. 地区强控制：每个真人镜头的人物外观、人种/肤色范围、发型、职业身份、服装道具、生活场景、城市/室内环境和街景细节都必须参考 regions；不得使用与目标地区明显不匹配的人群、建筑、货币环境或社会语境。",
    "9. 主语言强控制：如果生成字幕、Slogan、CTA、按钮、手机 UI、任务卡、弹窗、奖励提示、进度条标签、页面标题或任何屏幕内文字，必须写清文字内容、出现时机、出现位置、出现方式、文字风格，且全部使用 primaryLanguage；除产品名/品牌名外，不得混用非主语言文字。",
    "10. 币种强控制：所有用户可见金额、余额、提现档位、奖励金额、UI 金额符号、字幕金额和口播金额只能使用 currencySymbol；未提供 currencySymbol 或 truthRules 未给出金额时，不得写具体金额或货币符号。",
    "11. ending 和 CTA 默认不生成；除非 channelRules、branch.customPrompt 或 truthRules 明确要求，否则 cta/ending 必须为空，不要为了凑结构强行添加。",
    "12. 奖励数字与收益承诺约束：只有 truthRules 明确给出的金额、积分点数、奖励数值、门槛、到账条件才能出现在用户可见文案或 UI 描述中；未提供时不要写任何具体金额、点数增长、余额增长、提现档位、到账时间或保证性收益。",
    "13. 承诺强度按 promiseLevel 控制：非 strong_commitment 分支只能使用弱承诺（任务、积分、进度、奖励反馈、按规则可查看/申请/兑换），禁止任何语言中的确定到账、直接到账、即时到账、保证提现、真实收入、固定收益、稳赚等强收益语义；strong_commitment 分支可以表达强承诺，但必须逐项来自 truthRules，不得扩写或增强。",
    "",
    "只返回 JSON 对象。"
  ].filter(Boolean).join("\n");

  return [
    {
      role: "system",
      content: [
        "你是网赚广告 Seedance 前置参数策划专家。",
        "你要基于参考视频的结构、节奏、镜头功能和转化逻辑，为我方业务重构可执行的 Seedance 分镜与 prompt。",
        "必须改变参考视频的人物身份、职业/人群、具体场景、服装、道具、具体情节、口播表达和字幕表达；禁止沿用原人物或把变化限制在相近职业。",
        "seedancePrompt 必须逐镜头使用 Seedance 公式：主体 + 运动 + 环境 + 运镜/切镜 + 美学描述 + 音频/文字。",
        "seedancePrompt 与 imagePrompt 必须明确写出新人物/身份、新场景、新服装与新关键道具，禁止“用户/年轻人”等泛化人物描述。",
        "所有 hook、body、voiceover、subtitles 必须使用指定主语言；cta、ending 如存在也必须使用指定主语言，并符合目标地区表达习惯。",
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

export function buildThirtySecondSeedancePlanMessages(input = {}) {
  const messages = buildSeedancePlanMessages({
    ...input,
    segmentIndex: "1-2"
  });
  const userMessage = messages.find((message) => message.role === "user");
  if (userMessage) {
    userMessage.content = [
      userMessage.content,
      "",
      "30s 连续预案覆盖规则：",
      "1. 本次不是分别独立生成两个 15s 预案；必须先生成一个完整 0-30s 总分镜计划 overallStoryboard，再拆成两个连续的 15s Seedance prompt。",
      "2. overallStoryboard 必须覆盖 0-30s 的完整结构、节奏、镜头、转化逻辑、人物状态、场景状态、UI/产品反馈状态和情绪递进。",
      "3. segment 1 覆盖 0-15s，必须自然结束在可作为第二段首帧的连续性边界；写清最后一帧的人物姿势、手机/UI 状态、场景、光线、镜头位置和运动方向。",
      "4. segment 2 覆盖 15-30s，必须从 segment 1 的最后一帧继续，不能重新开场、换人、跳场、重置 UI 或重复钩子。",
      "5. segment 2 的 seedancePrompt 必须明确写出“以上一段尾帧/continuity frame 作为首帧连续性参考”，并延续同一变体的新人物、新场景、新服装、新道具和产品状态。",
      "6. 两段都必须遵守同一个 0-30s 总分镜，不得互相矛盾；segment 2 只推进后半段转化，不要重复 segment 1 的痛点铺垫。",
      "7. 如果 ending/CTA 未被明确要求，两个 segment 的 cta/ending 都保持空字符串；不要因为 30s 自动添加结尾卡。",
      "",
      "30s 输出 JSON 结构覆盖上述单段字段说明：",
      JSON.stringify({
        overallStoryboard: "完整 0-30s 总分镜计划，按 0-15s 和 15-30s 写清连续叙事与边界状态",
        segments: [
          { segmentIndex: 1, ...SEEDANCE_PLAN_SCHEMA_HINT },
          { segmentIndex: 2, ...SEEDANCE_PLAN_SCHEMA_HINT }
        ]
      }, null, 2),
      "",
      "只返回上述 30s JSON 对象，不要返回 markdown，不要解释。"
    ].join("\n");
  }
  return messages;
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
  const parsed = validateSeedancePlan(
    parseLlmJsonContent(content),
    resolveSeedancePlanValidationContext(input)
  );
  return parsed;
}

function normalizePlanSegments(value = {}) {
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.segments)) return value.segments;
  if (Array.isArray(value.plans)) return value.plans;
  return [];
}

export async function generateThirtySecondSeedancePlans(context, input = {}) {
  const llmConfig = resolveLlmConfig(context.config || {}, input.llmConfig || {});
  const messages = buildThirtySecondSeedancePlanMessages(input);
  const content = await callPlanLlm({
    ...context,
    currentBatchId: input.batch?.batchId || context?.currentBatchId || ""
  }, messages, llmConfig);
  const parsed = parseLlmJsonContent(content);
  const segments = normalizePlanSegments(parsed);
  if (segments.length < 2) {
    throw new WangzhuanError("schema_invalid", "30s Seedance 预案必须包含两个连续 15s segment", {
      branchId: input.branch?.branchId,
      branchVariantIndex: input.branchVariantIndex,
      segmentCount: segments.length
    });
  }
  return [1, 2].map((segmentIndex) => {
    const segment = segments.find((item) => Number(item?.segmentIndex || 0) === segmentIndex)
      || segments[segmentIndex - 1];
    return validateSeedancePlan(segment, resolveSeedancePlanValidationContext({
      ...input,
      segmentIndex
    }));
  });
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
