import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeBranchDrafts, normalizeStoredBranchDrafts } from "./branches.mjs";
import { ensureAssetReviewsApproved, validateAssetReviewState } from "./asset-review.mjs";
import { getChannelRules } from "./channel-rules.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeGenerationTaskId, makeScriptId } from "./ids.mjs";
import {
  hasWangzhuanFactsStore,
  loadActivePipelineRunFromMysql,
  loadBatchDetailFromMysql,
  loadEstimateFromMysql,
  loadLatestBatchEstimateForReferenceVideo,
  syncBatchFacts
} from "./mysql-facts.mjs";
import {
  buildSeedanceGenerationPayload,
  collectSeedanceMedia,
  createSeedanceProviderClient,
  DEFAULT_SEEDANCE_MODEL,
  mergeBranchMediaDraft,
  resolveSeedanceModel,
  summarizeSeedanceRequest,
  summarizeSeedanceResponse
} from "./seedance-provider.mjs";
import { toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";
import {
  buildGenerationPlanRecord,
  formatProtagonistFissionGuide,
  generateThirtySecondSeedancePlans,
  generateSeedancePlan,
  validateBranchTruthRulesForPlan,
  validateSeedancePlan
} from "./plan-preview.mjs";
import { listBackgroundJobs } from "./background-jobs.mjs";

const MODEL_IMAGE = "gpt-image-2";
const MODEL_VIDEO = DEFAULT_SEEDANCE_MODEL;
const STOPPABLE_BATCH_STATUSES = new Set(["draft", "checking", "queued", "running", "stitching", "qc", "preview_required"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "skipped", "stopped"]);
const SLICE_ROLES = ["hook_slice", "proof_slice", "withdrawal_slice", "cta_slice"];

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function validateBatchId(batchId) {
  if (!/^wzb_\d{14}_[a-f0-9]{4}$/.test(String(batchId || ""))) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  }
}

function batchDir(context, batchId) {
  validateBatchId(batchId);
  return join(wangzhuanPaths(context).batchesDir, batchId);
}

function userRelative(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

async function requireFactsStore() {
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取业务状态");
  }
}

async function readBatch(context, batchId) {
  validateBatchId(batchId);
  await requireFactsStore();
  const detail = await loadBatchDetailFromMysql(context, batchId);
  const batch = detail?.batch;
  if (!batch) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权访问该批次", { batchId });
  }
  return batch;
}

async function writeBatchWithTrigger(context, batch, triggerName = "batch_write") {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  if (typeof context.writeBatchForTest === "function") {
    return context.writeBatchForTest(next, triggerName);
  }
  const synced = await syncBatchFacts(context, next, triggerName);
  if (synced?.skipped) {
    const detail = synced.error?.message || synced.error?.code || null;
    if (!await hasWangzhuanFactsStore()) {
      throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存业务状态");
    }
    throw new WangzhuanError("database_unavailable", detail
      ? `批次状态保存失败：${String(detail).slice(0, 300)}`
      : "批次状态保存失败，请确认数据库迁移已执行到最新版本（含 pending_preview 任务状态）", {
      batchId: batch.batchId,
      triggerName,
      cause: detail
    });
  }
  return next;
}

export async function writeBatch(context, batch, triggerName = "batch_write") {
  return writeBatchWithTrigger(context, batch, triggerName);
}

function scriptBody(batch, branch, variantIndex, segmentIndex, requiredDisclaimers = [], durationSec = 15) {
  const productName = branch?.productName || batch.templateSnapshot?.draft?.productName || "Product";
  const materialDirection = branch?.materialDirection || batch.templateSnapshot?.draft?.materialDirection;
  const decomposition = batch.decomposition || {};
  const baseAction = decomposition.action || "Show the product benefit in a vertical app demo";
  const rewardFeedback = decomposition.rewardFeedback || "Show believable reward feedback inside the app";
  const languages = Array.isArray(branch?.languages) && branch.languages.length
    ? branch.languages
    : (branch?.language ? [branch.language] : []);
  const regions = Array.isArray(branch?.regions) ? branch.regions : [];
  return [
    `${baseAction}.`,
    `Variant ${variantIndex} focuses on ${productName} with ${batch.referenceVideo?.scene || decomposition.scene || "a reference-inspired scene"}.`,
    materialDirection ? `Creative angle: ${materialDirection}.` : "",
    languages.length ? `Primary spoken language is ${languages[0]}${languages.length > 1 ? `, with locale coverage for ${languages.join(", ")}` : ""}.` : "",
    regions.length ? `Target regions: ${regions.join(", ")}.` : "",
    `Segment ${segmentIndex} keeps pacing within ${durationSec} seconds and includes ${rewardFeedback}.`,
    ...requiredDisclaimers.map((item) => `Disclaimer: ${item}.`)
  ].filter(Boolean).join(" ");
}

function scriptHook(batch, branch, variantIndex) {
  const hook = batch.decomposition?.hook || "See rewards from daily app tasks";
  const branchPrefix = branch?.branchLabel ? `${branch.branchLabel}: ` : "";
  return variantIndex === 1 ? `${branchPrefix}${hook}` : `${branchPrefix}${hook} - angle ${variantIndex}`;
}

function rewardExpression(batch, branch) {
  const rules = branch?.truthRules || batch.templateSnapshot?.draft?.truthRules;
  if (!rules?.rewardAmountRange) return undefined;
  return `${rules.rewardAmountRange} when ${rules.rewardCondition}`;
}

function resolveSliceStrategy(batch = {}) {
  return batch.estimate?.request?.sliceStrategy
    || batch.templateSnapshot?.draft?.sliceStrategy
    || "fixed_15s";
}

function preferredSliceCount(duration, sliceStrategy) {
  if (Number(duration) === 30) return 2;
  if (sliceStrategy === "three_slice") return 3;
  if (sliceStrategy === "two_15s") return 2;
  if (sliceStrategy === "auto_10_15s_multi_slice") return Math.max(1, Math.ceil(duration / 15));
  return 1;
}

function feasibleSliceCount(duration, preferredCount) {
  const maxFeasible = Math.max(1, Math.floor(duration / 10));
  const minFeasible = Math.max(1, Math.ceil(duration / 15));
  if (minFeasible > maxFeasible) return maxFeasible;
  const count = Math.max(minFeasible, Math.min(preferredCount, maxFeasible));
  return Math.max(1, count);
}

export function buildSlicePlan({ durationSec = 15, sliceStrategy = "fixed_15s" } = {}) {
  const duration = Math.max(10, Number(durationSec) || 15);
  const count = feasibleSliceCount(duration, preferredSliceCount(duration, sliceStrategy));
  const base = Math.floor(duration / count);
  const remainder = duration % count;
  const slices = [];
  let startSec = 0;
  for (let index = 0; index < count; index += 1) {
    const sliceDuration = base + (index >= count - remainder ? 1 : 0);
    const endSec = startSec + sliceDuration;
    slices.push({
      segmentIndex: index + 1,
      startSec,
      endSec,
      durationSec: sliceDuration,
      segmentRole: SLICE_ROLES[index] || "proof_slice"
    });
    startSec = endSec;
  }
  return slices;
}

export function planSegmentMultiplier(batch = {}) {
  return buildSlicePlan({
    durationSec: Number(batch.estimate?.durationSec || batch.templateSnapshot?.draft?.defaultDurationSec || 15),
    sliceStrategy: resolveSliceStrategy(batch)
  }).length;
}

function usesThirtySecondContinuityPlan(batch = {}) {
  return Number(batch.estimate?.durationSec) === 30 && planSegmentMultiplier(batch) === 2;
}

function promptAssetLines(assetUrls = {}) {
  const labels = [
    ["productIcon", "Product icon"],
    ["productScreenshot", "Product screenshot"],
    ["productRecording", "Product recording"],
    ["endingAsset", "Ending asset"],
    ["personAsset", "Person asset"],
    ["rewardElement", "Reward element"]
  ];
  return labels.map(([key, label]) => assetUrls[key] ? `${label} URL: ${assetUrls[key]}` : "");
}

function buildPrompt(batch, script, kind) {
  const draft = batch.templateSnapshot?.draft || {};
  const branch = script.branchDraft || draft;
  const decomposition = batch.decomposition || {};
  const assetUrls = branch.assetUrls || {};
  const channel = branch.targetChannels?.[0] || batch.estimate?.request?.targetChannel || batch.templateSnapshot?.draft?.targetChannels?.[0] || "generic";
  const languages = Array.isArray(branch.languages) && branch.languages.length
    ? branch.languages
    : [branch.language || draft.language || batch.estimate?.request?.language || "en-US"];
  const regions = Array.isArray(branch.regions) && branch.regions.length
    ? branch.regions
    : (Array.isArray(draft.regions) && draft.regions.length ? draft.regions : []);
  const lines = [
    script.branchId ? `Branch: ${script.branchLabel || script.branchId} (${script.branchId})` : "",
    `Product: ${branch.productName || draft.productName || "Product"}`,
    branch.productLink ? `Store page: ${branch.productLink}` : "",
    `Primary language: ${languages[0] || "en-US"}`,
    `All languages: ${languages.join(", ")}`,
    `Target regions: ${regions.join(", ") || "US"}`,
    `Currency: ${branch.currencySymbol || draft.currencySymbol || ""}`,
    `Channel: ${channel}`,
    `Revenue promise level: ${branch.promiseLevel || draft.promiseLevel || "stable"}`,
    branch.materialDirection ? `Material direction: ${branch.materialDirection}` : "",
    branch.voiceoverStyle ? `Voiceover style: ${branch.voiceoverStyle}` : "",
    ...promptAssetLines(assetUrls),
    `Scene: ${decomposition.scene || "mobile app reward scene"}`,
    `Subject: ${decomposition.subject || "user with phone"}`,
    decomposition.protagonist ? `Protagonist: ${decomposition.protagonist}` : "",
    decomposition.voiceover ? `Voiceover function: ${decomposition.voiceover}` : "",
    `Camera: ${decomposition.camera || "vertical close-up"}`,
    `Lighting: ${decomposition.lighting || "bright natural lighting"}`,
    `Style: ${decomposition.style || "clean performance ad"}`,
    `Script hook: ${script.hook}`,
    `Script body: ${script.body}`,
    `CTA: ${script.cta}`,
    `Ending: ${script.ending}`,
    branch.variantPrompt ? `Variant instructions: ${branch.variantPrompt}` : "",
    formatProtagonistFissionGuide(decomposition, script.branchVariantIndex || script.variantIndex || 1, branch.variantPrompt),
    branch.customPrompt ? `Additional user prompt: ${branch.customPrompt}` : "",
    branch.negativePrompt ? `User restrictions: ${branch.negativePrompt}` : "",
    `Locale rule: all on-screen UI text, subtitles, CTA phrasing, and voiceover must match the primary language ${languages[0] || "en-US"}; multi-language config (${languages.join(", ")}) and target regions (${regions.join(", ") || "US"}) should only affect localization style, scenario, and wording choices, never mixed-language output in one segment.`,
    "Protagonist rule: seedancePrompt must name a specific profession/identity and reflect it in clothing, props, scene, and voiceover tone; do not use generic labels like user or young woman.",
    "Do not include competitor names, watermarks, logos, signed URLs, or policy-unsafe income guarantees.",
    kind === "image" ? "Task: create the first-frame image prompt for Seedance." : "Task: create a 15 second 9:16 Seedance image-to-video prompt."
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

async function writePlainPrompt(target, text) {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text, "utf8");
}

async function writeTaskMaps(context, batch) {
  const dir = join(batchDir(context, batch.batchId), "task-map");
  const jsonPath = join(dir, "task-id-map.json");
  const csvPath = join(dir, "task-id-map.csv");
  await writeAtomicJson(jsonPath, batch.tasks);
  const header = [
    "source_type",
    "batch_id",
    "branch_id",
    "branch_label",
    "script_id",
    "generation_task_id",
    "image_task_id",
    "seedance_task_id",
    "model_image",
    "model_video",
    "output_id",
    "output_file",
    "qc_status",
    "error_code"
  ];
  const rows = batch.tasks.map((task) => [
    "pipeline",
    batch.batchId,
    task.branchId || "",
    task.branchLabel || "",
    task.scriptId,
    task.generationTaskId,
    task.imageTaskId || "",
    task.seedanceTaskId || "",
    task.modelImage,
    task.modelVideo,
    "",
    task.outputPath || "",
    "",
    task.errorCode || ""
  ]);
  const csv = [header, ...rows].map((row) => row.map((value) => `"${String(value).replace(/"/g, '""')}"`).join(",")).join("\n");
  await writePlainPrompt(csvPath, `${csv}\n`);
}

async function buildSeedanceTaskPayload(context, batch, task, provider) {
  let promptRelPath = task.promptPath;
  if (!promptRelPath) {
    const script = (Array.isArray(batch.scripts) ? batch.scripts : []).find((item) => item.scriptId === task.scriptId);
    promptRelPath = script?.promptPath || "";
  }
  if (!promptRelPath) {
    throw new WangzhuanError("missing_required_file", "Seedance prompt 文件缺失", {
      generationTaskId: task.generationTaskId,
      batchId: batch.batchId,
      scriptId: task.scriptId || ""
    });
  }
  const promptTarget = join(context.userProjectRoot, promptRelPath);
  const prompt = await readFile(promptTarget, "utf8");
  const media = [
    ...collectSeedanceMedia(batch, task),
    ...continuityReferenceMedia(task)
  ];
  return buildSeedanceGenerationPayload({
    model: resolveSeedanceModel(batch, provider, task),
    prompt,
    media,
    mode: media.length ? "omni_reference" : "text_to_video",
    ratio: provider?.config?.ratio || batch.templateSnapshot?.draft?.defaultOutputRatio || "9:16",
    duration: task.durationSec || 15,
    resolution: provider?.config?.resolution || "720p",
    generateAudio: provider?.config?.generateAudio,
    watermark: provider?.config?.watermark ?? false,
    metadata: {
      metadata: {
        batchId: batch.batchId,
        generationTaskId: task.generationTaskId,
        scriptId: task.scriptId,
        branchId: task.branchId || "",
        branchLabel: task.branchLabel || ""
      }
    }
  });
}

async function submitTaskToSeedance(context, batch, task, provider, now) {
  if (!provider) {
    throw new WangzhuanError("upstream_failed", "Seedance 未配置，无法提交生成任务", {
      generationTaskId: task.generationTaskId,
      requiredConfig: "wangzhuan.seedanceProvider.endpoint",
      requiredEnv: ["WANGZHUAN_SEEDANCE_ENDPOINT", "WANGZHUAN_LLM_API_KEY"]
    });
  }
  const payload = await buildSeedanceTaskPayload(context, batch, task, provider);
  let result;
  try {
    result = await provider.createTask(payload, {
      batchId: batch.batchId,
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      branchId: task.branchId || "",
      branchLabel: task.branchLabel || ""
    });
  } catch (error) {
    return {
      ...task,
      status: "failed",
      imageTaskId: task.imageTaskId || "",
      seedanceTaskId: task.seedanceTaskId || "",
      provider: provider.provider || "seedance",
      providerJobId: task.providerJobId,
      remoteUrlStored: false,
      attempts: Number(task.attempts || 0) + 1,
      startedAt: now,
      finishedAt: now,
      errorCode: error?.code || "upstream_failed",
      errorMessage: error?.message || "Seedance 上游请求失败",
      requestSummary: summarizeSeedanceRequest(payload, provider),
      responseSummary: {
        status: "failed",
        upstreamCode: error?.data?.upstreamCode || error?.code || "",
        upstreamMessage: error?.data?.upstreamMessage || error?.message || "",
        httpStatus: error?.data?.status
      }
    };
  }
  const seedanceTaskId = result.taskId || result.id || result.task_id;
  if (!seedanceTaskId) {
    return {
      ...task,
      status: "failed",
      imageTaskId: task.imageTaskId || "",
      seedanceTaskId: "",
      provider: provider.provider || "seedance",
      remoteUrlStored: false,
      attempts: Number(task.attempts || 0) + 1,
      startedAt: now,
      finishedAt: now,
      errorCode: "upstream_failed",
      errorMessage: "Seedance 上游响应缺少 task id",
      requestSummary: summarizeSeedanceRequest(payload, provider),
      responseSummary: summarizeSeedanceResponse(result)
    };
  }
  return {
    ...task,
    status: "waiting_upstream",
    imageTaskId: task.imageTaskId || "",
    seedanceTaskId,
    provider: provider.provider || "seedance",
    providerJobId: seedanceTaskId,
    remoteUrlStored: false,
    attempts: Number(task.attempts || 0) + 1,
    startedAt: now,
    finishedAt: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined,
    requestSummary: summarizeSeedanceRequest(payload, provider),
    responseSummary: summarizeSeedanceResponse(result)
  };
}

function taskSegmentKey(task = {}) {
  return [
    task.branchId || "default",
    String(task.branchVariantIndex || task.variantIndex || 1)
  ].join(":");
}

function previousSegmentDownloaded(tasks = [], task = {}) {
  const segmentIndex = Number(task.segmentIndex || 1);
  if (segmentIndex <= 1) return true;
  return tasks.some((candidate) => {
    return taskSegmentKey(candidate) === taskSegmentKey(task)
      && Number(candidate.segmentIndex || 1) === segmentIndex - 1
      && candidate.status === "downloaded"
      && Boolean(candidate.outputPath);
  });
}

function isApprovedContinuityReference(reference = {}) {
  const status = String(reference.review?.status || "").toLowerCase();
  return Boolean(reference.review?.assetId && ["approved", "active", "success", "succeeded", "pass", "passed"].includes(status));
}

export function isGenerationTaskSubmitReady(batch = {}, task = {}) {
  if (task.status !== "pending") return false;
  if (!usesThirtySecondContinuityPlan(batch)) return true;
  if (!previousSegmentDownloaded(Array.isArray(batch.tasks) ? batch.tasks : [], task)) return false;
  if (Number(task.segmentIndex || 1) <= 1) return true;
  return isApprovedContinuityReference(task.continuityReference);
}

function continuityReferenceMedia(task = {}) {
  if (!isApprovedContinuityReference(task.continuityReference)) return [];
  return [{
    type: "image_asset",
    assetId: task.continuityReference.review.assetId,
    assetKey: "continuityFrame",
    assetRole: "reference",
    storedPath: task.continuityReference.storedPath || ""
  }];
}

async function ensureEventFile(_context, _batchId) {
  // `batch_prepared` was a legacy trigger name from the pre-preview flow.
  // The current preview-required pipeline already persists the prepared batch
  // via `writeBatch()`, so replaying a state transition here can incorrectly
  // push `preview_required` runs through an unsupported transition.
}

async function writeProcessTraceFiles(context, batch) {
  const root = batchDir(context, batch.batchId);
  const draft = batch.templateSnapshot?.draft || {};
  const assets = draft.assetFileNames || {};
  const assetUrls = draft.assetUrls || {};
  const promptItems = [];
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    const seedancePromptTarget = join(context.userProjectRoot, task.promptPath);
    const imagePromptTarget = join(dirname(seedancePromptTarget), `${task.generationTaskId}_image.txt`);
    promptItems.push({
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      branchId: task.branchId || "",
      branchLabel: task.branchLabel || "",
      seedancePromptPath: task.promptPath,
      imagePromptPath: userRelative(context, imagePromptTarget),
      seedancePrompt: await readFile(seedancePromptTarget, "utf8"),
      imagePrompt: await readFile(imagePromptTarget, "utf8")
    });
  }

  await writeAtomicJson(join(root, "00-brief.json"), {
    schemaVersion: "wangzhuan-brief.v1",
    batchId: batch.batchId,
    product: {
      productName: draft.productName || "",
      productLink: draft.productLink || "",
      cta: draft.cta || "",
      ending: draft.ending || "",
      currencySymbol: draft.currencySymbol || "",
      language: draft.language || "",
      regions: Array.isArray(draft.regions) ? draft.regions : [],
      targetChannels: Array.isArray(draft.targetChannels) ? draft.targetChannels : []
    },
    assets,
    assetUrls,
    branches: batch.branchDrafts || normalizeBranchDrafts(draft, batch.estimate?.request?.branches),
    rules: {
      promiseLevel: draft.promiseLevel || "stable",
      truthRules: draft.truthRules || {},
      materialDirection: draft.materialDirection || "",
      voiceoverStyle: draft.voiceoverStyle || "",
      customPrompt: draft.customPrompt || "",
      negativePrompt: draft.negativePrompt || "",
      outputRatio: draft.defaultOutputRatio || batch.estimate?.outputRatio || "9:16",
      durationSec: batch.estimate?.durationSec || draft.defaultDurationSec || 15,
      variantCount: batch.estimate?.variantCount || 0
    },
    systemAssumptions: [
      "15s outputs use one Seedance prompt per variant.",
      "30s outputs use two 15s segments per variant and require stitching.",
      "The system must not invent exact rewards, withdrawal thresholds, or payout timing without truth rules."
    ],
    createdAt: batch.createdAt
  });
  await writeAtomicJson(join(root, "01-reference-breakdown.json"), {
    schemaVersion: "reference-breakdown.v1",
    referenceVideo: batch.referenceVideo,
    decomposition: batch.decomposition
  });
  await writeAtomicJson(join(root, "02-product-script.json"), {
    schemaVersion: "product-script.v1",
    replacementScope: [
      "productName",
      "icon",
      "cta",
      "ending",
      "subtitleProductName",
      "voiceoverProductName",
      "phoneUiDescription",
      "rewardVisualDescription"
    ],
    product: {
      productName: draft.productName || "",
      productLink: draft.productLink || "",
      iconAsset: assets.productIcon || "",
      iconUrl: assetUrls.productIcon || "",
      cta: draft.cta || "",
      ending: draft.ending || ""
    },
    scripts: batch.scripts
  });
  await writeAtomicJson(join(root, "03-localized-variants.json"), {
    schemaVersion: "localized-variants.v1",
    language: draft.language || "",
    regions: Array.isArray(draft.regions) ? draft.regions : [],
    currencySymbol: draft.currencySymbol || "",
    variants: batch.scripts
  });
  await writeAtomicJson(join(root, "04-seedance-prompts.json"), {
    schemaVersion: "seedance-prompts.v1",
    model: MODEL_VIDEO,
    items: promptItems
  });
  await writeAtomicJson(join(root, "05-video-tasks.json"), {
    schemaVersion: "video-tasks.v1",
    tasks: batch.tasks
  });
}

export async function prepareBatchForPipeline(context, batch, options = {}) {
  if (Array.isArray(batch.scripts) && batch.scripts.length && Array.isArray(batch.tasks) && batch.tasks.length) {
    return batch;
  }

  const useLlmPlans = Boolean(options.useLlmPlans);
  const scripts = [];
  const tasks = [];
  const plans = [];
  const slicePlan = buildSlicePlan({
    durationSec: Number(batch.estimate?.durationSec || batch.templateSnapshot?.draft?.defaultDurationSec || 15),
    sliceStrategy: resolveSliceStrategy(batch)
  });
  const segmentMultiplier = slicePlan.length;
  const useThirtySecondContinuityPlan = usesThirtySecondContinuityPlan(batch);
  const branchDrafts = normalizeBranchDrafts(batch.templateSnapshot?.draft, batch.estimate?.request?.branches);
  if (useLlmPlans) {
    validateBranchTruthRulesForPlan(branchDrafts);
  }
  let sequence = 1;
  const variantCount = Number(batch.estimate?.variantCount || 0);
  const totalPlans = useLlmPlans ? branchDrafts.length * variantCount * (useThirtySecondContinuityPlan ? 1 : segmentMultiplier) : 0;
  let planSequence = 0;

  for (const branch of branchDrafts) {
    const branchChannel = branch.targetChannels?.[0] || batch.estimate?.request?.targetChannel || "generic";
    const branchPromiseLevel = branch.promiseLevel || batch.estimate?.request?.promiseLevel || "stable";
    const channelRules = typeof context.getChannelRulesForTest === "function"
      ? await context.getChannelRulesForTest({ channel: branchChannel, promiseLevel: branchPromiseLevel })
      : await getChannelRules(context, { channel: branchChannel, promiseLevel: branchPromiseLevel });
    const requiredDisclaimers = [...new Set(channelRules.rules.flatMap((rule) => rule.requiredDisclaimers || []))];
    for (let branchVariantIndex = 1; branchVariantIndex <= Number(batch.estimate?.variantCount || 0); branchVariantIndex += 1) {
      let thirtySecondPlanPayloads = null;
      if (useLlmPlans && useThirtySecondContinuityPlan) {
        planSequence += 1;
        options.onPlanProgress?.({
          index: planSequence,
          total: totalPlans,
          branchLabel: branch.branchLabel || branch.branchId,
          branchVariantIndex,
          segmentIndex: "1-2"
        });
        thirtySecondPlanPayloads = await generateThirtySecondSeedancePlans(context, {
          batch,
          branch,
          decomposition: batch.decomposition,
          channelRules,
          branchVariantIndex,
          knowledgeNotes: options.knowledgeNotes,
          llmConfig: options.llmConfig || {}
        });
      }
      for (let segmentIndex = 1; segmentIndex <= segmentMultiplier; segmentIndex += 1) {
        const slice = slicePlan[segmentIndex - 1] || { segmentIndex, durationSec: 15, segmentRole: "proof_slice" };
        const scriptId = makeScriptId(batch.batchId, sequence);
        const generationTaskId = makeGenerationTaskId(batch.batchId, sequence);
        const segmentSuffix = segmentMultiplier > 1 ? `_segment${segmentIndex}` : "";
        const scriptTarget = join(batchDir(context, batch.batchId), "scripts", `${scriptId}${segmentSuffix}.json`);
        const promptTarget = join(batchDir(context, batch.batchId), "prompts", `${generationTaskId}_seedance.txt`);
        const imagePromptTarget = join(batchDir(context, batch.batchId), "prompts", `${generationTaskId}_image.txt`);
        let hook = scriptHook(batch, branch, branchVariantIndex);
        let body = scriptBody(batch, branch, branchVariantIndex, segmentIndex, requiredDisclaimers, slice.durationSec);
        let cta = branch.cta || batch.decomposition?.cta || "Install now";
        let ending = branch.ending || "Try it today";
        let seedancePrompt = "";
        let imagePrompt = "";
        let negativePrompt = branch.negativePrompt || "";
        let voiceover = "";
        let subtitles = [];
        let complianceNotes = [];
        let mediaRefs = branch.assetUrls || {};
        let planRecord = null;

        if (useLlmPlans) {
          let planPayload = thirtySecondPlanPayloads?.[segmentIndex - 1];
          if (!planPayload) {
            planSequence += 1;
            options.onPlanProgress?.({
              index: planSequence,
              total: totalPlans,
              branchLabel: branch.branchLabel || branch.branchId,
              branchVariantIndex,
              segmentIndex
            });
            planPayload = await generateSeedancePlan(context, {
              batch,
              branch,
              decomposition: batch.decomposition,
              channelRules,
              branchVariantIndex,
              segmentIndex,
              segmentRole: slice.segmentRole,
              sliceDurationSec: slice.durationSec,
              knowledgeNotes: options.knowledgeNotes,
              llmConfig: options.llmConfig || {}
            });
          }
          hook = planPayload.hook;
          body = planPayload.body;
          cta = planPayload.cta;
          ending = planPayload.ending;
          seedancePrompt = planPayload.seedancePrompt;
          imagePrompt = planPayload.imagePrompt;
          negativePrompt = planPayload.negativePrompt;
          voiceover = planPayload.voiceover;
          subtitles = planPayload.subtitles;
          complianceNotes = planPayload.complianceNotes;
          mediaRefs = planPayload.mediaRefs;
          const segmentRole = planPayload.segmentRole || slice.segmentRole;
          const sliceDurationSec = slice.durationSec;
          planPayload = {
            ...planPayload,
            segmentRole,
            sliceDurationSec
          };
          const outputTemplateMode = planPayload.outputTemplateMode;
          const moneyVisuals = planPayload.moneyVisuals;
          const withdrawalVisual = planPayload.withdrawalVisual;
          const subtitleWorkflow = planPayload.subtitleWorkflow;
          const sliceDiversity = planPayload.sliceDiversity;
          planRecord = buildGenerationPlanRecord({
            batch,
            branch,
            scriptId,
            generationTaskId,
            branchVariantIndex,
            segmentIndex,
            sequence,
            planPayload: {
              hook,
              body,
              voiceover,
              subtitles,
              cta,
              ending,
              imagePrompt,
              seedancePrompt,
              negativePrompt,
              mediaRefs,
              complianceNotes,
              segmentRole,
              sliceDurationSec,
              outputTemplateMode,
              moneyVisuals,
              withdrawalVisual,
              subtitleWorkflow,
              sliceDiversity
            }
          });
          plans.push(planRecord);
        }

        const script = {
          scriptId,
          batchId: batch.batchId,
          branchId: branch.branchId,
          branchIndex: branch.branchIndex,
          branchLabel: branch.branchLabel,
          branchVariantIndex,
          variantIndex: sequence,
          segmentIndex,
          durationSec: slice.durationSec,
          segmentRole: planRecord?.segmentRole || slice.segmentRole,
          sliceDurationSec: planRecord?.sliceDurationSec || slice.durationSec,
          hook,
          body,
          cta,
          ending,
          branchDraft: branch,
          ...(rewardExpression(batch, branch) ? { rewardExpression: rewardExpression(batch, branch) } : {}),
          ...(planRecord ? {
            planId: planRecord.planId,
            voiceover,
            subtitles,
            imagePrompt,
            seedancePrompt,
            negativePrompt,
            mediaRefs,
            complianceNotes,
            segmentRole: planRecord.segmentRole,
            sliceDurationSec: planRecord.sliceDurationSec,
            outputTemplateMode: planRecord.outputTemplateMode,
            moneyVisuals: planRecord.moneyVisuals,
            withdrawalVisual: planRecord.withdrawalVisual,
            subtitleWorkflow: planRecord.subtitleWorkflow,
            sliceDiversity: planRecord.sliceDiversity
          } : {}),
          promptPath: userRelative(context, promptTarget),
          scriptPath: userRelative(context, scriptTarget)
        };
        await writeAtomicJson(scriptTarget, script);
        await writePlainPrompt(
          promptTarget,
          useLlmPlans ? seedancePrompt : buildPrompt(batch, script, "video")
        );
        await writePlainPrompt(
          imagePromptTarget,
          useLlmPlans ? imagePrompt : buildPrompt(batch, script, "image")
        );

        scripts.push(script);
        tasks.push({
          generationTaskId,
          batchId: batch.batchId,
          scriptId,
          ...(planRecord ? { planId: planRecord.planId } : {}),
          branchId: branch.branchId,
          branchIndex: branch.branchIndex,
          branchLabel: branch.branchLabel,
          branchVariantIndex,
          segmentIndex,
          durationSec: slice.durationSec,
          segmentRole: planRecord?.segmentRole || slice.segmentRole,
          sliceDurationSec: planRecord?.sliceDurationSec || slice.durationSec,
          status: useLlmPlans ? "pending_preview" : "pending",
          modelImage: MODEL_IMAGE,
          modelVideo: resolveSeedanceModel(batch),
          promptPath: script.promptPath,
          remoteUrlStored: false,
          attempts: 0
        });
        sequence += 1;
      }
    }
  }

  const prepared = {
    ...batch,
    ...(useLlmPlans ? {
      previewType: "seedance_plan",
      plans
    } : {}),
    branchDrafts,
    scripts,
    tasks,
    outputs: Array.isArray(batch.outputs) ? batch.outputs : [],
    qcSummary: batch.qcSummary || { total: 0, passed: 0, failed: 0, warnings: [] }
  };
  const saved = await writeBatch(context, prepared);
  await writeTaskMaps(context, saved);
  await writeProcessTraceFiles(context, saved);
  await ensureEventFile(context, saved.batchId);
  return saved;
}

async function enrichBatchWorkbenchContext(context, detail) {
  const batch = detail?.batch;
  if (!batch) return detail;

  let estimateId = batch.estimate?.estimateId || batch.request?.estimateId || null;
  let estimateRecord = estimateId ? await loadEstimateFromMysql(context, estimateId) : null;
  if (!estimateRecord) {
    const referenceVideoId = batch.referenceVideo?.referenceVideoId || batch.request?.referenceVideoId || "";
    if (referenceVideoId) {
      estimateRecord = await loadLatestBatchEstimateForReferenceVideo(context, referenceVideoId);
      estimateId = estimateRecord?.estimate?.estimateId || estimateId;
    }
  }

  const decomposition = [batch.decomposition, estimateRecord?.decomposition, batch.request?.decomposition]
    .find((item) => item && (item.referenceVideoId || item.scene || item.hook || item.action)) || null;
  const templateSnapshot = batch.templateSnapshot?.draft
    ? batch.templateSnapshot
    : (estimateRecord?.templateSnapshot || batch.templateSnapshot || null);
  const rawBranchDrafts = batch.branchDrafts?.length
    ? batch.branchDrafts
    : (estimateRecord?.request?.branches || batch.request?.branchDrafts || batch.request?.branches || []);
  const branchDrafts = normalizeStoredBranchDrafts(templateSnapshot, rawBranchDrafts);
  const estimate = estimateRecord
    ? {
        ...estimateRecord.estimate,
        ...batch.estimate,
        estimateId: estimateId || estimateRecord.estimate?.estimateId,
        request: {
          ...(estimateRecord.request || {}),
          ...(batch.estimate?.request || {})
        }
      }
    : batch.estimate;

  const referenceVideo = batch.referenceVideo?.referenceVideoId
    ? batch.referenceVideo
    : (estimateRecord?.referenceVideo || batch.referenceVideo || null);

  const changed = referenceVideo !== batch.referenceVideo
    || decomposition !== batch.decomposition
    || templateSnapshot !== batch.templateSnapshot
    || branchDrafts !== batch.branchDrafts
    || estimate !== batch.estimate;
  if (!changed) return detail;

  return {
    ...detail,
    batch: {
      ...batch,
      referenceVideo,
      decomposition,
      templateSnapshot,
      branchDrafts,
      estimate
    }
  };
}

function backgroundJobSummary(job = null) {
  if (!job) return null;
  return {
    id: job.id || "",
    type: job.type || "",
    subjectType: job.subjectType || "",
    subjectId: job.subjectId || "",
    status: job.status || "",
    progress: Number(job.progress || 0),
    message: job.message || "",
    draftSignature: job.draftSignature || "",
    createdAt: job.createdAt || null,
    updatedAt: job.updatedAt || null,
    error: job.error ? {
      code: job.error.code || "",
      message: job.error.message || "",
      recoverable: Boolean(job.error.recoverable),
      data: job.error.data && typeof job.error.data === "object" ? job.error.data : {}
    } : null
  };
}

async function attachBackgroundJobSummaries(context, detail) {
  const batch = detail?.batch;
  if (!batch?.batchId) return detail;
  const referenceVideoId = batch.referenceVideo?.referenceVideoId || batch.request?.referenceVideoId || "";
  const [planJobs, decompositionJobs] = await Promise.all([
    listBackgroundJobs(context, {
      type: "seedance_plan",
      subjectType: "batch",
      subjectId: batch.batchId
    }).catch(() => []),
    referenceVideoId
      ? listBackgroundJobs(context, {
        type: "decomposition",
        subjectType: "reference_video",
        subjectId: referenceVideoId
      }).catch(() => [])
      : Promise.resolve([])
  ]);
  return {
    ...detail,
    backgroundJobs: {
      latestPlanJob: backgroundJobSummary(planJobs[0] || null),
      latestDecompositionJob: backgroundJobSummary(decompositionJobs[0] || null)
    }
  };
}

export async function getBatchDetail(context, batchId) {
  const initial = await readBatch(context, batchId);
  const { pollUpstreamBatch, shouldPollUpstreamBatch } = await import("./upstream-poll.mjs");
  if (shouldPollUpstreamBatch(initial)) {
    try {
      await pollUpstreamBatch(context, batchId);
    } catch (error) {
      console.warn(`[wangzhuan] upstream poll failed for ${batchId}: ${error?.message || error}`);
    }
  }
  let detail = await loadBatchDetailFromMysql(context, batchId);
  if (!detail?.batch) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  detail = await enrichBatchWorkbenchContext(context, detail);
  detail = await attachBackgroundJobSummaries(context, detail);
  return detail;
}

export async function stopBatch(context, batchId, request = {}) {
  const batch = await readBatch(context, batchId);
  if (!STOPPABLE_BATCH_STATUSES.has(batch.status)) {
    throw new WangzhuanError("not_running", "批次当前状态不可停止", { batchId, status: batch.status });
  }
  const now = new Date().toISOString();
  let stoppedCount = 0;
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (TERMINAL_TASK_STATUSES.has(task.status)) return task;
    stoppedCount += 1;
    return {
      ...task,
      status: "stopped",
      errorCode: request.reason || "user_stopped",
      errorMessage: "用户已停止批次",
      finishedAt: now
    };
  });
  const stopped = await writeBatchWithTrigger(context, {
    ...batch,
    status: "stopped",
    tasks,
    stoppedAt: now,
    stopReason: request.reason || "user_stopped"
  }, "user_stop");
  await writeTaskMaps(context, stopped);
  await recordTelemetryEvent(context, "batch_stopped", {
    batchId: stopped.batchId,
    completedCount: tasks.filter((task) => task.status === "succeeded").length,
    failedCount: tasks.filter((task) => task.status === "failed" || task.status === "stopped").length
  });
  return {
    ...(await getBatchDetail(context, stopped.batchId)),
    stoppedCount
  };
}

export async function submitPendingGenerationTasks(context, batchId) {
  const batch = await readBatch(context, batchId);
  if (batch.status === "stopped" || batch.status === "preview_required") {
    return { batch, submittedCount: 0, failedSubmitCount: 0 };
  }
  const now = new Date().toISOString();
  let submittedCount = 0;
  let failedSubmitCount = 0;
  const provider = createSeedanceProviderClient(context);
  if (!provider) {
    throw new WangzhuanError("upstream_failed", "Seedance 未配置，无法提交生成任务", {
      batchId,
      requiredConfig: "wangzhuan.seedanceProvider.endpoint",
      requiredEnv: ["WANGZHUAN_SEEDANCE_ENDPOINT", "WANGZHUAN_LLM_API_KEY"]
    });
  }
  const limit = Math.max(
    1,
    Math.min(
      Number(context.config?.wangzhuan?.capabilities?.maxConcurrency || 4),
      Number(batch.estimate?.requestedConcurrency || batch.request?.requestedConcurrency || 1) || 1
    )
  );
  const originalTasks = Array.isArray(batch.tasks) ? batch.tasks : [];
  const tasks = [...originalTasks];
  const pendingIndexes = [];
  for (let index = 0; index < originalTasks.length; index += 1) {
    if (isGenerationTaskSubmitReady(batch, originalTasks[index])) pendingIndexes.push(index);
  }
  for (let offset = 0; offset < pendingIndexes.length; offset += limit) {
    const chunk = pendingIndexes.slice(offset, offset + limit);
    const chunkResults = await Promise.all(chunk.map(async (taskIndex) => {
      const nextTask = await submitTaskToSeedance(context, batch, originalTasks[taskIndex], provider, now);
      return { taskIndex, nextTask };
    }));
    for (const { taskIndex, nextTask } of chunkResults) {
      if (nextTask.status === "waiting_upstream") submittedCount += 1;
      if (nextTask.status === "failed") failedSubmitCount += 1;
      tasks[taskIndex] = nextTask;
    }
  }
  const nextStatus = submittedCount > 0
    ? "running"
    : failedSubmitCount > 0
      ? "failed"
      : batch.status === "queued" ? "running" : batch.status;
  const saved = await writeBatch(context, {
    ...batch,
    status: nextStatus,
    tasks,
    startedAt: batch.startedAt || (submittedCount > 0 ? now : undefined)
  });
  await writeTaskMaps(context, saved);
  for (const task of saved.tasks.filter((item) => item.startedAt === now && item.status === "waiting_upstream")) {
    await recordTelemetryEvent(context, "generation_task_submitted", {
      batchId: saved.batchId,
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      imageTaskId: task.imageTaskId,
      seedanceTaskId: task.seedanceTaskId,
      provider: task.provider || provider.provider,
      modelImage: task.modelImage,
      modelVideo: task.modelVideo
    }, { audit: true });
  }
  return { batch: saved, submittedCount, failedSubmitCount };
}

export async function retryFailedGenerationTask(context, batchId, generationTaskId) {
  const batch = await readBatch(context, batchId);
  if (batch.status === "stopped") {
    return { batch, retriedCount: 0 };
  }
  const now = new Date().toISOString();
  let retriedCount = 0;
  let found = false;
  const provider = createSeedanceProviderClient(context);
  if (!provider) {
    throw new WangzhuanError("upstream_failed", "Seedance 未配置，无法重试生成任务", {
      batchId,
      generationTaskId,
      requiredConfig: "wangzhuan.seedanceProvider.endpoint",
      requiredEnv: ["WANGZHUAN_SEEDANCE_ENDPOINT", "WANGZHUAN_LLM_API_KEY"]
    });
  }
  const tasks = [];
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    if (task.generationTaskId !== generationTaskId) {
      tasks.push(task);
      continue;
    }
    found = true;
    if (task.status !== "failed") {
      throw new WangzhuanError("invalid_state_transition", "任务当前状态不可重试", {
        batchId,
        generationTaskId,
        status: task.status
      });
    }
    const attempts = Number(task.attempts || 0);
    const maxAttempts = Number(task.maxAttempts || 2);
    if (attempts >= maxAttempts) {
      throw new WangzhuanError("retry_exhausted", "任务重试次数已耗尽", {
        batchId,
        generationTaskId,
        attempts,
        maxAttempts
      });
    }
    retriedCount += 1;
    const resetTask = {
      ...task,
      attempts
    };
    tasks.push(await submitTaskToSeedance(context, batch, resetTask, provider, now));
  }
  if (!found) {
    throw new WangzhuanError("task_not_found", "任务不存在", { batchId, generationTaskId });
  }
  const saved = await writeBatchWithTrigger(context, { ...batch, status: "running", tasks }, "scheduler_retry");
  await writeTaskMaps(context, saved);
  if (retriedCount > 0) {
    const retried = saved.tasks.find((task) => task.generationTaskId === generationTaskId);
    await recordTelemetryEvent(context, "generation_task_retried", {
      batchId: saved.batchId,
      generationTaskId,
      scriptId: retried?.scriptId || "",
      attempts: retried?.attempts || 0,
      imageTaskId: retried?.imageTaskId || "",
      seedanceTaskId: retried?.seedanceTaskId || ""
    }, { audit: true });
  }
  return { batch: saved, retriedCount };
}

function currentPlanIds(batch, request = {}) {
  const requested = Array.isArray(request.confirmedPlanIds)
    ? request.confirmedPlanIds.filter(Boolean)
    : [];
  if (requested.length) return new Set(requested);
  return new Set((Array.isArray(batch.plans) ? batch.plans : []).map((plan) => plan.planId));
}

function editablePlanById(request = {}) {
  const map = new Map();
  if (!Array.isArray(request.plans)) return map;
  for (const plan of request.plans) {
    if (plan?.planId) map.set(plan.planId, plan);
  }
  return map;
}

export async function applyConfirmedPlanEdits(context, batch, plans, confirmedPlanIds, request = {}) {
  const edits = editablePlanById(request);
  const now = new Date().toISOString();
  const nextPlans = [];
  const nextScripts = [];

  for (const plan of plans) {
    const isConfirmed = confirmedPlanIds.has(plan.planId);
    const editedPlan = edits.get(plan.planId);
    const branch = (Array.isArray(batch.branchDrafts) ? batch.branchDrafts : []).find((item) => item.branchId === plan.branchId);
    const payload = validateSeedancePlan(isConfirmed && editedPlan ? { ...plan, ...editedPlan } : plan, {
      branch: branch || {},
      branchId: plan.branchId,
      branchVariantIndex: plan.branchVariantIndex,
      segmentIndex: plan.segmentIndex
    });
    nextPlans.push({
      ...plan,
      ...payload,
      status: isConfirmed ? "confirmed" : plan.status,
      ...(isConfirmed ? { confirmedAt: now } : {})
    });
  }

  const planMap = new Map(nextPlans.map((plan) => [plan.planId, plan]));
  for (const script of Array.isArray(batch.scripts) ? batch.scripts : []) {
    const plan = script.planId ? planMap.get(script.planId) : null;
    if (!plan || !confirmedPlanIds.has(plan.planId)) {
      nextScripts.push(script);
      continue;
    }
    const branch = (Array.isArray(batch.branchDrafts) ? batch.branchDrafts : []).find((item) => item.branchId === script.branchId);
    const nextScript = {
      ...script,
      ...(branch ? { branchDraft: mergeBranchMediaDraft(branch, script.branchDraft || {}) } : {}),
      hook: plan.hook,
      body: plan.body,
      voiceover: plan.voiceover,
      subtitles: plan.subtitles,
      cta: plan.cta,
      ending: plan.ending,
      imagePrompt: plan.imagePrompt,
      seedancePrompt: plan.seedancePrompt,
      negativePrompt: plan.negativePrompt,
      mediaRefs: plan.mediaRefs,
      complianceNotes: plan.complianceNotes,
      segmentRole: plan.segmentRole,
      sliceDurationSec: plan.sliceDurationSec,
      outputTemplateMode: plan.outputTemplateMode,
      moneyVisuals: plan.moneyVisuals,
      withdrawalVisual: plan.withdrawalVisual,
      subtitleWorkflow: plan.subtitleWorkflow,
      sliceDiversity: plan.sliceDiversity
    };
    nextScripts.push(nextScript);
    if (script.scriptPath) {
      await writeAtomicJson(join(context.userProjectRoot, script.scriptPath), nextScript);
    }
    if (script.promptPath) {
      await writePlainPrompt(join(context.userProjectRoot, script.promptPath), plan.seedancePrompt);
    }
    const task = (Array.isArray(batch.tasks) ? batch.tasks : []).find((item) => item.scriptId === script.scriptId);
    if (task?.generationTaskId && script.promptPath) {
      await writePlainPrompt(
        join(dirname(join(context.userProjectRoot, script.promptPath)), `${task.generationTaskId}_image.txt`),
        plan.imagePrompt
      );
    }
  }

  return { nextPlans, nextScripts, confirmedAt: now };
}

export async function confirmBatchPlan(context, batchId, request = {}) {
  if (!request.idempotencyKey) {
    throw new WangzhuanError("validation_error", "idempotencyKey 必填", { field: "idempotencyKey" });
  }
  const batch = await readBatch(context, batchId);
  if (batch.status !== "preview_required") {
    throw new WangzhuanError("validation_error", "当前批次不在预案确认阶段", {
      batchId,
      status: batch.status
    });
  }
  if (batch.previewType !== "seedance_plan") {
    throw new WangzhuanError("validation_error", "当前批次不是 Seedance 预案确认", {
      batchId,
      previewType: batch.previewType || null
    });
  }
  const confirmedPlanIds = currentPlanIds(batch, request);
  const plans = Array.isArray(batch.plans) ? batch.plans : [];
  if (!plans.length) {
    throw new WangzhuanError("validation_error", "没有可确认的 Seedance 预案", { batchId });
  }
  const unknownPlanIds = [...confirmedPlanIds].filter((planId) => !plans.some((plan) => plan.planId === planId));
  if (unknownPlanIds.length) {
    throw new WangzhuanError("validation_error", "存在未知预案编号", { batchId, unknownPlanIds });
  }
  const assetReviewAlreadyConfirmed = Boolean(request.assetReviewConfirmed && (batch.assetReviewConfirmedAt || batch.request?.assetReviewConfirmed));
  const rawBranchSource = assetReviewAlreadyConfirmed
    ? batch.branchDrafts || batch.request?.branches || []
    : Array.isArray(request.branchDrafts) && request.branchDrafts.length
      ? request.branchDrafts
      : batch.branchDrafts || batch.request?.branches || [];
  const branchSource = normalizeBranchDrafts(batch.templateSnapshot?.draft || {}, rawBranchSource);
  const review = assetReviewAlreadyConfirmed
    ? { branches: branchSource, reviewResult: validateAssetReviewState(branchSource) }
    : await ensureAssetReviewsApproved(context, branchSource);
  const reviewResult = review.reviewResult;
  if (!reviewResult.ok) {
    throw new WangzhuanError("asset_review_pending", "产品素材审核未通过，请上传 Seedance 素材并完成审核后再确认生成", {
      failures: reviewResult.failures,
      assetsByBranch: reviewResult.assetsByBranch
    });
  }
  const reviewedBatch = {
    ...batch,
    branchDrafts: review.branches,
    request: {
      ...(batch.request || {}),
      branches: review.branches
    }
  };
  const { nextPlans, nextScripts, confirmedAt } = await applyConfirmedPlanEdits(context, reviewedBatch, plans, confirmedPlanIds, request);
  const nextTasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (task.status !== "pending_preview") return task;
    if (!task.planId || !confirmedPlanIds.has(task.planId)) return task;
    return { ...task, status: "pending" };
  });
  const unconfirmedPreviewTasks = nextTasks.filter((task) => task.status === "pending_preview");
  if (unconfirmedPreviewTasks.length) {
    throw new WangzhuanError("validation_error", "仍有未确认的 Seedance 预案", {
      batchId,
      pendingPreviewCount: unconfirmedPreviewTasks.length
    });
  }
  const saved = await writeBatchWithTrigger(context, {
    ...reviewedBatch,
    status: "queued",
    plans: nextPlans,
    scripts: nextScripts,
    tasks: nextTasks,
    previewConfirmedAt: confirmedAt,
    previewConfirmedBy: currentUserId(context),
    previewConfirmationNotes: cleanConfirmationNotes(request.confirmationNotes)
  }, "plan_confirmed");
  await writeTaskMaps(context, saved);
  await recordTelemetryEvent(context, "seedance_plan_confirmed", {
    batchId: saved.batchId,
    confirmedPlanCount: nextPlans.filter((plan) => plan.status === "confirmed").length,
    idempotencyKey: request.idempotencyKey
  }, { audit: true });
  return { batch: saved, confirmedPlanIds: [...confirmedPlanIds] };
}

export async function confirmBatchAssets(context, batchId, request = {}) {
  const batch = await readBatch(context, batchId);
  const rawBranchSource = Array.isArray(request.branchDrafts) && request.branchDrafts.length
    ? request.branchDrafts
    : batch.branchDrafts || batch.request?.branches || [];
  const branchSource = normalizeBranchDrafts(batch.templateSnapshot?.draft || {}, rawBranchSource);
  const review = await ensureAssetReviewsApproved(context, branchSource);
  if (!review.reviewResult.ok) {
    throw new WangzhuanError("asset_review_pending", "产品素材审核未通过，请等待审核通过后再确认结果", {
      failures: review.reviewResult.failures,
      assetsByBranch: review.reviewResult.assetsByBranch
    });
  }
  const saved = await writeBatchWithTrigger(context, {
    ...batch,
    branchDrafts: review.branches,
    request: {
      ...(batch.request || {}),
      branches: review.branches,
      branchDrafts: review.branches,
      assetReviewConfirmed: true
    },
    assetReviewConfirmedAt: new Date().toISOString(),
    assetReviewConfirmedBy: currentUserId(context)
  }, "seedance_assets_confirmed");
  return {
    batch: saved,
    branches: review.branches,
    reviewResult: review.reviewResult
  };
}

function cleanConfirmationNotes(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return text ? text.slice(0, 2000) : undefined;
}

export async function getActiveBatch(context) {
  await requireFactsStore();
  const active = await loadActivePipelineRunFromMysql(context);
  if (active?.batchId) {
    return getBatchDetail(context, active.batchId);
  }
  return {
    batch: null,
    events: [],
    backgroundJobs: {
      latestPlanJob: null,
      latestDecompositionJob: null
    },
    downloadSummary: {
      outputsTotal: 0,
      downloadEligibleCount: 0,
      packageReady: false,
      missingFiles: []
    }
  };
}

export {
  readBatch,
  writeTaskMaps
};
