import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { getChannelRules } from "./channel-rules.mjs";
import { WangzhuanError } from "./http.mjs";
import { makeGenerationTaskId, makeScriptId } from "./ids.mjs";
import { appendJsonl, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const MODEL_IMAGE = "gpt-image-2";
const MODEL_VIDEO = "dreamina-seedance-2-0-260128";
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
  return next;
}

function scriptBody(batch, variantIndex, segmentIndex, requiredDisclaimers = []) {
  const productName = batch.templateSnapshot?.draft?.productName || "Product";
  const decomposition = batch.decomposition || {};
  const baseAction = decomposition.action || "Show the product benefit in a vertical app demo";
  const rewardFeedback = decomposition.rewardFeedback || "Show believable reward feedback inside the app";
  return [
    `${baseAction}.`,
    `Variant ${variantIndex} focuses on ${productName} with ${batch.referenceVideo?.scene || decomposition.scene || "a reference-inspired scene"}.`,
    `Segment ${segmentIndex} keeps pacing within 15 seconds and includes ${rewardFeedback}.`,
    ...requiredDisclaimers.map((item) => `Disclaimer: ${item}.`)
  ].join(" ");
}

function scriptHook(batch, variantIndex) {
  const hook = batch.decomposition?.hook || "See rewards from daily app tasks";
  return variantIndex === 1 ? hook : `${hook} - angle ${variantIndex}`;
}

function rewardExpression(batch) {
  const rules = batch.templateSnapshot?.draft?.truthRules;
  if (!rules?.rewardAmountRange) return undefined;
  return `${rules.rewardAmountRange} when ${rules.rewardCondition}`;
}

function buildPrompt(batch, script, kind) {
  const draft = batch.templateSnapshot?.draft || {};
  const decomposition = batch.decomposition || {};
  const channel = batch.estimate?.request?.targetChannel || batch.templateSnapshot?.draft?.targetChannels?.[0] || "generic";
  const lines = [
    `Product: ${draft.productName || "Product"}`,
    `Language: ${draft.language || batch.estimate?.request?.language || "en-US"}`,
    `Channel: ${channel}`,
    `Scene: ${decomposition.scene || "mobile app reward scene"}`,
    `Subject: ${decomposition.subject || "user with phone"}`,
    `Camera: ${decomposition.camera || "vertical close-up"}`,
    `Lighting: ${decomposition.lighting || "bright natural lighting"}`,
    `Style: ${decomposition.style || "clean performance ad"}`,
    `Script hook: ${script.hook}`,
    `Script body: ${script.body}`,
    `CTA: ${script.cta}`,
    `Ending: ${script.ending}`,
    "Do not include competitor names, watermarks, logos, signed URLs, or policy-unsafe income guarantees.",
    kind === "image" ? "Task: create the first-frame image prompt for Seedance." : "Task: create a 15 second 9:16 Seedance image-to-video prompt."
  ];
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

async function ensureEventFile(context, batchId) {
  await appendEvent(context, batchId, { event: "batch_prepared" });
}

export async function prepareBatchForPipeline(context, batch) {
  if (Array.isArray(batch.scripts) && batch.scripts.length && Array.isArray(batch.tasks) && batch.tasks.length) {
    return batch;
  }

  const scripts = [];
  const tasks = [];
  const count = Number(batch.estimate?.scriptCount || batch.estimate?.variantCount || 0);
  const segmentMultiplier = Number(batch.estimate?.durationSec) === 30 ? 2 : 1;
  const channel = batch.estimate?.request?.targetChannel || batch.templateSnapshot?.draft?.targetChannels?.[0] || "generic";
  const promiseLevel = batch.templateSnapshot?.draft?.promiseLevel || batch.estimate?.request?.promiseLevel || "stable";
  const channelRules = await getChannelRules(context, { channel, promiseLevel });
  const requiredDisclaimers = [...new Set(channelRules.rules.flatMap((rule) => rule.requiredDisclaimers || []))];
  let sequence = 1;

  for (let variantIndex = 1; variantIndex <= Number(batch.estimate?.variantCount || count); variantIndex += 1) {
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
        variantIndex,
        segmentIndex,
        durationSec: 15,
        hook: scriptHook(batch, variantIndex),
        body: scriptBody(batch, variantIndex, segmentIndex, requiredDisclaimers),
        cta: batch.templateSnapshot?.draft?.cta || batch.decomposition?.cta || "Install now",
        ending: batch.templateSnapshot?.draft?.ending || "Try it today",
        ...(rewardExpression(batch) ? { rewardExpression: rewardExpression(batch) } : {}),
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

  const prepared = {
    ...batch,
    scripts,
    tasks,
    outputs: Array.isArray(batch.outputs) ? batch.outputs : [],
    qcSummary: batch.qcSummary || { total: 0, passed: 0, failed: 0, warnings: [] }
  };
  const saved = await writeBatch(context, prepared);
  await writeTaskMaps(context, saved);
  await ensureEventFile(context, saved.batchId);
  return saved;
}

export async function getBatchDetail(context, batchId) {
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
  const stopped = await writeBatch(context, {
    ...batch,
    status: "stopped",
    tasks,
    stoppedAt: now,
    stopReason: request.reason || "user_stopped"
  });
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
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (task.status !== "pending") return task;
    submittedCount += 1;
    return {
      ...task,
      status: "waiting_upstream",
      imageTaskId: `mock_img_${task.generationTaskId}`,
      seedanceTaskId: `mock_seedance_${task.generationTaskId}`,
      remoteUrlStored: false,
      attempts: task.attempts + 1,
      startedAt: now
    };
  });
  const nextStatus = submittedCount > 0 || batch.status === "queued" ? "running" : batch.status;
  const saved = await writeBatch(context, { ...batch, status: nextStatus, tasks });
  await writeTaskMaps(context, saved);
  await appendEvent(context, saved.batchId, { event: "mock_generation_submitted", submittedCount });
  for (const task of saved.tasks.filter((item) => item.startedAt === now && item.status === "waiting_upstream")) {
    await recordTelemetryEvent(context, "generation_task_submitted", {
      batchId: saved.batchId,
      generationTaskId: task.generationTaskId,
      scriptId: task.scriptId,
      imageTaskId: task.imageTaskId,
      seedanceTaskId: task.seedanceTaskId,
      modelImage: task.modelImage,
      modelVideo: task.modelVideo
    }, { audit: true });
  }
  return { batch: saved, submittedCount };
}
