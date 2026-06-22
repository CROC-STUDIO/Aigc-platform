import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { normalizeBranchDrafts } from "./branches.mjs";
import { getChannelRules } from "./channel-rules.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeGenerationTaskId, makeScriptId } from "./ids.mjs";
import { loadActivePipelineRunFromMysql, syncBatchFacts } from "./mysql-facts.mjs";
import {
  buildSeedanceGenerationPayload,
  collectSeedanceMedia,
  createSeedanceProviderClient,
  DEFAULT_SEEDANCE_MODEL,
  summarizeSeedanceRequest,
  summarizeSeedanceResponse
} from "./seedance-provider.mjs";
import { appendJsonl, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const MODEL_IMAGE = "gpt-image-2";
const MODEL_VIDEO = DEFAULT_SEEDANCE_MODEL;
const STOPPABLE_BATCH_STATUSES = new Set(["draft", "checking", "queued", "running", "stitching", "qc"]);
const TERMINAL_TASK_STATUSES = new Set(["succeeded", "failed", "skipped", "stopped"]);

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

function batchPath(context, batchId) {
  return join(batchDir(context, batchId), "batch.json");
}

function eventPath(context, batchId) {
  return join(batchDir(context, batchId), "tasks.jsonl");
}

function userRelative(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

async function readBatch(context, batchId) {
  const target = batchPath(context, batchId);
  if (!existsSync(target)) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  }
  const batch = JSON.parse(await readFile(target, "utf8"));
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权访问该批次", { batchId });
  }
  return batch;
}

async function writeBatch(context, batch) {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  const paths = wangzhuanPaths(context);
  await writeAtomicJson(join(paths.batchesDir, next.batchId, "batch.json"), next);
  const indexPath = join(paths.batchesDir, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.items = Array.isArray(index.items) ? index.items : [];
    const item = index.items.find((entry) => entry.batchId === next.batchId);
    if (item) {
      item.status = next.status;
      item.updatedAt = now;
    }
    await writeAtomicJson(indexPath, index);
  }
  await syncBatchFacts(context, next, "batch_write");
  return next;
}

async function writeBatchWithTrigger(context, batch, triggerName) {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  const paths = wangzhuanPaths(context);
  await writeAtomicJson(join(paths.batchesDir, next.batchId, "batch.json"), next);
  const indexPath = join(paths.batchesDir, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.items = Array.isArray(index.items) ? index.items : [];
    const item = index.items.find((entry) => entry.batchId === next.batchId);
    if (item) {
      item.status = next.status;
      item.updatedAt = now;
    }
    await writeAtomicJson(indexPath, index);
  }
  await syncBatchFacts(context, next, triggerName);
  return next;
}

function scriptBody(batch, branch, variantIndex, segmentIndex, requiredDisclaimers = []) {
  const productName = branch?.productName || batch.templateSnapshot?.draft?.productName || "Product";
  const materialDirection = branch?.materialDirection || batch.templateSnapshot?.draft?.materialDirection;
  const decomposition = batch.decomposition || {};
  const baseAction = decomposition.action || "Show the product benefit in a vertical app demo";
  const rewardFeedback = decomposition.rewardFeedback || "Show believable reward feedback inside the app";
  return [
    `${baseAction}.`,
    `Variant ${variantIndex} focuses on ${productName} with ${batch.referenceVideo?.scene || decomposition.scene || "a reference-inspired scene"}.`,
    materialDirection ? `Creative angle: ${materialDirection}.` : "",
    `Segment ${segmentIndex} keeps pacing within 15 seconds and includes ${rewardFeedback}.`,
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
  const lines = [
    script.branchId ? `Branch: ${script.branchLabel || script.branchId} (${script.branchId})` : "",
    `Product: ${branch.productName || draft.productName || "Product"}`,
    branch.productLink ? `Store page: ${branch.productLink}` : "",
    `Language: ${branch.language || draft.language || batch.estimate?.request?.language || "en-US"}`,
    `Region: ${Array.isArray(branch.regions) ? branch.regions.join(", ") : branch.regions || ""}`,
    `Currency: ${branch.currencySymbol || draft.currencySymbol || ""}`,
    `Channel: ${channel}`,
    `Revenue promise level: ${branch.promiseLevel || draft.promiseLevel || "stable"}`,
    branch.materialDirection ? `Material direction: ${branch.materialDirection}` : "",
    branch.voiceoverStyle ? `Voiceover style: ${branch.voiceoverStyle}` : "",
    ...promptAssetLines(assetUrls),
    `Scene: ${decomposition.scene || "mobile app reward scene"}`,
    `Subject: ${decomposition.subject || "user with phone"}`,
    `Camera: ${decomposition.camera || "vertical close-up"}`,
    `Lighting: ${decomposition.lighting || "bright natural lighting"}`,
    `Style: ${decomposition.style || "clean performance ad"}`,
    `Script hook: ${script.hook}`,
    `Script body: ${script.body}`,
    `CTA: ${script.cta}`,
    `Ending: ${script.ending}`,
    branch.variantPrompt ? `Variant instructions: ${branch.variantPrompt}` : "",
    branch.customPrompt ? `Additional user prompt: ${branch.customPrompt}` : "",
    branch.negativePrompt ? `User restrictions: ${branch.negativePrompt}` : "",
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

async function appendEvent(context, batchId, event) {
  await appendJsonl(eventPath(context, batchId), {
    createdAt: new Date().toISOString(),
    batchId,
    ...event
  });
}

function mockSubmittedTask(task, now) {
  return {
    ...task,
    status: "waiting_upstream",
    imageTaskId: `mock_img_${task.generationTaskId}`,
    seedanceTaskId: `mock_seedance_${task.generationTaskId}`,
    provider: "mock",
    providerJobId: undefined,
    remoteUrlStored: false,
    attempts: Number(task.attempts || 0) + 1,
    startedAt: now,
    finishedAt: undefined,
    errorCode: undefined,
    errorMessage: undefined,
    nextAttemptAt: undefined
  };
}

async function buildSeedanceTaskPayload(context, batch, task, provider) {
  const promptTarget = join(context.userProjectRoot, task.promptPath);
  const prompt = await readFile(promptTarget, "utf8");
  const media = collectSeedanceMedia(batch, task);
  return buildSeedanceGenerationPayload({
    model: provider?.model || task.modelVideo || MODEL_VIDEO,
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
  if (!provider) return mockSubmittedTask(task, now);
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

async function ensureEventFile(context, batchId) {
  await appendEvent(context, batchId, { event: "batch_prepared" });
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

export async function prepareBatchForPipeline(context, batch) {
  if (Array.isArray(batch.scripts) && batch.scripts.length && Array.isArray(batch.tasks) && batch.tasks.length) {
    return batch;
  }

  const scripts = [];
  const tasks = [];
  const segmentMultiplier = Number(batch.estimate?.durationSec) === 30 ? 2 : 1;
  const branchDrafts = normalizeBranchDrafts(batch.templateSnapshot?.draft, batch.estimate?.request?.branches);
  let sequence = 1;

  for (const branch of branchDrafts) {
    const branchChannel = branch.targetChannels?.[0] || batch.estimate?.request?.targetChannel || "generic";
    const branchPromiseLevel = branch.promiseLevel || batch.estimate?.request?.promiseLevel || "stable";
    const channelRules = await getChannelRules(context, { channel: branchChannel, promiseLevel: branchPromiseLevel });
    const requiredDisclaimers = [...new Set(channelRules.rules.flatMap((rule) => rule.requiredDisclaimers || []))];
    for (let branchVariantIndex = 1; branchVariantIndex <= Number(batch.estimate?.variantCount || 0); branchVariantIndex += 1) {
      for (let segmentIndex = 1; segmentIndex <= segmentMultiplier; segmentIndex += 1) {
        const scriptId = makeScriptId(batch.batchId, sequence);
        const generationTaskId = makeGenerationTaskId(batch.batchId, sequence);
        const segmentSuffix = segmentMultiplier > 1 ? `_segment${segmentIndex}` : "";
        const scriptTarget = join(batchDir(context, batch.batchId), "scripts", `${scriptId}${segmentSuffix}.json`);
        const promptTarget = join(batchDir(context, batch.batchId), "prompts", `${generationTaskId}_seedance.txt`);
        const imagePromptTarget = join(batchDir(context, batch.batchId), "prompts", `${generationTaskId}_image.txt`);
        const script = {
          scriptId,
          batchId: batch.batchId,
          branchId: branch.branchId,
          branchIndex: branch.branchIndex,
          branchLabel: branch.branchLabel,
          branchVariantIndex,
          variantIndex: sequence,
          segmentIndex,
          durationSec: 15,
          hook: scriptHook(batch, branch, branchVariantIndex),
          body: scriptBody(batch, branch, branchVariantIndex, segmentIndex, requiredDisclaimers),
          cta: branch.cta || batch.decomposition?.cta || "Install now",
          ending: branch.ending || "Try it today",
          branchDraft: branch,
          ...(rewardExpression(batch, branch) ? { rewardExpression: rewardExpression(batch, branch) } : {}),
          promptPath: userRelative(context, promptTarget),
          scriptPath: userRelative(context, scriptTarget)
        };
        await writeAtomicJson(scriptTarget, script);
        await writePlainPrompt(promptTarget, buildPrompt(batch, script, "video"));
        await writePlainPrompt(imagePromptTarget, buildPrompt(batch, script, "image"));

        scripts.push(script);
        tasks.push({
          generationTaskId,
          batchId: batch.batchId,
          scriptId,
          branchId: branch.branchId,
          branchIndex: branch.branchIndex,
          branchLabel: branch.branchLabel,
          branchVariantIndex,
          segmentIndex,
          status: "pending",
          modelImage: MODEL_IMAGE,
          modelVideo: MODEL_VIDEO,
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

export async function getBatchDetail(context, batchId) {
  const initial = await readBatch(context, batchId);
  const { pollUpstreamBatch, shouldPollUpstreamBatch } = await import("./upstream-poll.mjs");
  if (shouldPollUpstreamBatch(initial)) {
    await pollUpstreamBatch(context, batchId);
  }
  const batch = await readBatch(context, batchId);
  let events = [];
  try {
    const text = await readFile(eventPath(context, batch.batchId), "utf8");
    events = text.trim() ? text.trim().split("\n").map((line) => JSON.parse(line)) : [];
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  return {
    batch,
    events,
    downloadSummary: {
      outputsTotal: outputs.length,
      downloadEligibleCount: outputs.filter((item) => item.downloadEligible).length,
      packageReady: outputs.some((item) => item.downloadEligible),
      missingFiles: []
    }
  };
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
  await appendEvent(context, stopped.batchId, { event: "batch_stopped", stoppedCount, reason: request.reason || "user_stopped" });
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
  if (batch.status === "stopped") {
    return { batch, submittedCount: 0 };
  }
  const now = new Date().toISOString();
  let submittedCount = 0;
  let failedSubmitCount = 0;
  const provider = createSeedanceProviderClient(context);
  const tasks = [];
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    if (task.status !== "pending") {
      tasks.push(task);
      continue;
    }
    const nextTask = await submitTaskToSeedance(context, batch, task, provider, now);
    if (nextTask.status === "waiting_upstream") submittedCount += 1;
    if (nextTask.status === "failed") failedSubmitCount += 1;
    tasks.push(nextTask);
  }
  const nextStatus = submittedCount > 0
    ? "running"
    : failedSubmitCount > 0
      ? "failed"
      : batch.status === "queued" ? "running" : batch.status;
  const saved = await writeBatch(context, { ...batch, status: nextStatus, tasks });
  await writeTaskMaps(context, saved);
  await appendEvent(context, saved.batchId, {
    event: provider ? "seedance_generation_submitted" : "mock_generation_submitted",
    submittedCount,
    failedSubmitCount
  });
  for (const task of saved.tasks.filter((item) => item.startedAt === now && item.status === "waiting_upstream")) {
    await recordTelemetryEvent(context, "generation_task_submitted", {
      batchId: saved.batchId,
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      imageTaskId: task.imageTaskId,
      seedanceTaskId: task.seedanceTaskId,
      provider: task.provider || (provider ? provider.provider : "mock"),
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
  await appendEvent(context, saved.batchId, { event: "generation_task_retried", generationTaskId, retriedCount });
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

export async function getActiveBatch(context) {
  const active = await loadActivePipelineRunFromMysql(context);
  if (active?.batchId) {
    return getBatchDetail(context, active.batchId);
  }
  const paths = wangzhuanPaths(context);
  const indexPath = join(paths.batchesDir, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    const items = Array.isArray(index.items) ? index.items : [];
    const match = items.find((item) => ["queued", "running", "stitching", "qc"].includes(item.status));
    if (match?.batchId) {
      return getBatchDetail(context, match.batchId);
    }
  }
  return {
    batch: null,
    events: [],
    downloadSummary: {
      outputsTotal: 0,
      downloadEligibleCount: 0,
      packageReady: false,
      missingFiles: []
    }
  };
}

export {
  appendEvent,
  readBatch,
  writeBatch,
  writeTaskMaps
};
