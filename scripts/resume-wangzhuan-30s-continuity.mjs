#!/usr/bin/env node
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { refreshSeedanceAssetReview, reviewSeedanceAsset } from "../server/wangzhuan/asset-review.mjs";
import { loadBatchDetailFromMysql, syncBatchFacts } from "../server/wangzhuan/mysql-facts.mjs";
import { submitPendingGenerationTasks, writeTaskMaps, getBatchDetail } from "../server/wangzhuan/pipeline.mjs";
import { pollUpstreamBatch } from "../server/wangzhuan/upstream-poll.mjs";
import { wangzhuanPaths, writeAtomicJson } from "../server/wangzhuan/storage.mjs";

const batchId = process.argv[2] || "wzb_20260702130359_5fa5";
const repoRoot = resolve(".");
const baseRoot = resolve(repoRoot, "../project-data/PROJECT_ROOT_P");
const userRoot = join(baseRoot, "用户数据", "admin", "PROJECT_ROOT_P");
const outDir = join(repoRoot, "tmp", `resume-${batchId}`);
const resultPath = join(outDir, "result.json");

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function save(result) {
  await mkdir(outDir, { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

function approved(review = {}) {
  return Boolean(review.assetId && ["approved", "active", "success", "succeeded", "pass", "passed"].includes(String(review.status || "").toLowerCase()));
}

async function waitReview(context, review, asset, result) {
  let current = review;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    if (approved(current) || ["failed", "rejected"].includes(String(current.status || "").toLowerCase())) return current;
    await sleep(attempt === 1 ? 15_000 : 20_000);
    current = await refreshSeedanceAssetReview(context, {
      ...asset,
      assetId: current.assetId,
      status: current.status,
      contentUrl: current.contentUrl,
      reviewReason: current.reviewReason
    });
    result.events.push({ at: now(), type: "asset_review_poll", attempt, assetId: current.assetId, status: current.status });
    await save(result);
    console.log(`[asset] poll ${attempt}: ${current.status}`);
  }
  return current;
}

async function pollToTerminal(context, batchId, result) {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    const polled = await pollUpstreamBatch(context, batchId);
    const batch = polled.batch;
    result.events.push({
      at: now(),
      type: "poll",
      attempt,
      batchStatus: batch.status,
      tasks: (batch.tasks || []).map((task) => ({
        generationTaskId: task.generationTaskId,
        segmentIndex: task.segmentIndex,
        status: task.status,
        seedanceTaskId: task.seedanceTaskId || "",
        continuityAssetId: task.continuityReference?.review?.assetId || "",
        outputPath: task.outputPath || "",
        errorCode: task.errorCode || "",
        errorMessage: task.errorMessage || ""
      })),
      outputs: (batch.outputs || []).map((output) => ({
        outputId: output.outputId,
        kind: output.kind,
        status: output.status,
        filePath: output.filePath || output.outputPath || "",
        durationSec: output.durationSec || null
      })),
      needsPoll: polled.needsPoll,
      advanced: polled.advanced
    });
    await save(result);
    console.log(`[poll ${attempt}] batch=${batch.status} tasks=${(batch.tasks || []).map((task) => `${task.segmentIndex}:${task.status}`).join(",")} outputs=${(batch.outputs || []).length}`);
    if (["succeeded", "partial_failed", "failed", "stopped"].includes(batch.status)) return batch;
    await sleep(20_000);
  }
  throw new Error("timed out");
}

async function main() {
  process.env.AIGC_DB_PORT = process.env.AIGC_DB_PORT_OVERRIDE || "3308";
  const config = JSON.parse(await readFile(join(repoRoot, "config.json"), "utf8"));
  const context = {
    config,
    userId: "admin",
    user: { userId: "admin", username: "admin", role: "admin", isAdmin: true },
    projectName: "PROJECT_ROOT_P",
    sharedProjectRoot: baseRoot,
    userProjectRoot: userRoot,
    requestId: `resume_${Date.now()}`
  };
  const result = { batchId, resultPath, startedAt: now(), events: [] };
  await save(result);

  const detail = await loadBatchDetailFromMysql(context, batchId);
  const batch = detail?.batch;
  if (!batch) throw new Error(`batch not found: ${batchId}`);
  const task1 = (batch.tasks || []).find((task) => Number(task.segmentIndex || 1) === 1);
  const task2 = (batch.tasks || []).find((task) => Number(task.segmentIndex || 1) === 2);
  if (!task1?.outputPath) throw new Error("segment 1 has no downloaded output");
  if (!task2) throw new Error("segment 2 task not found");

  const tailPath = join(wangzhuanPaths(context).batchesDir, batchId, "continuity", `${task1.generationTaskId}_last_frame.jpg`);
  const buffer = await readFile(tailPath);
  let review = task2.continuityReference?.review;
  if (!approved(review)) {
    const asset = {
      branchId: task2.branchId || "",
      assetKey: "continuityFrame",
      fileName: `${task1.generationTaskId}_last_frame.jpg`,
      mimeType: "image/jpeg",
      buffer,
      storedPath: tailPath
    };
    if (!review?.assetId) review = await reviewSeedanceAsset(context, asset);
    review = await waitReview(context, review, asset, result);
  }
  if (!approved(review)) throw new Error(`continuity review not approved: ${review?.status || "missing"}`);

  const continuityReference = {
    sourceGenerationTaskId: task1.generationTaskId,
    storedPath: tailPath.slice(userRoot.length).replace(/^[\\/]+/, "").replace(/\\/g, "/"),
    storageKey: "",
    storageUrl: review.contentUrl || "",
    review,
    createdAt: now()
  };

  const nextTasks = (batch.tasks || []).map((task) => {
    if (task.generationTaskId !== task2.generationTaskId) return task;
    const next = {
      ...task,
      status: "pending",
      continuityReference,
      errorCode: "",
      errorMessage: "",
      finishedAt: "",
      responseSummary: {
        ...(task.responseSummary || {}),
        continuityReference: {
          sourceGenerationTaskId: continuityReference.sourceGenerationTaskId,
          storedPath: continuityReference.storedPath,
          assetId: review.assetId,
          status: review.status
        }
      }
    };
    delete next.errorCode;
    delete next.errorMessage;
    return next;
  });

  const nextBatch = {
    ...batch,
    status: "running",
    tasks: nextTasks,
    finishedAt: "",
    updatedAt: now()
  };
  const synced = await syncBatchFacts(context, nextBatch, "scheduler_retry");
  if (synced?.skipped) throw new Error(`sync skipped: ${synced.error?.message || "unknown"}`);
  await writeTaskMaps(context, nextBatch);
  await writeAtomicJson(join(wangzhuanPaths(context).batchesDir, batchId, "task-map", "task-id-map.json"), nextTasks);
  result.continuityReference = continuityReference;
  await save(result);
  console.log(`[resume] continuity asset=${review.assetId} status=${review.status}`);

  const submitted = await submitPendingGenerationTasks(context, batchId);
  result.submitted = {
    submittedCount: submitted.submittedCount,
    batchStatus: submitted.batch.status,
    tasks: (submitted.batch.tasks || []).map((task) => ({
      generationTaskId: task.generationTaskId,
      segmentIndex: task.segmentIndex,
      status: task.status,
      seedanceTaskId: task.seedanceTaskId || ""
    }))
  };
  await save(result);
  console.log(`[submit] count=${submitted.submittedCount} status=${submitted.batch.status}`);

  const terminal = await pollToTerminal(context, batchId, result);
  const finalDetail = await getBatchDetail(context, batchId);
  result.final = finalDetail.batch;
  result.finishedAt = now();
  await save(result);
  console.log(JSON.stringify({
    resultPath,
    batchId,
    status: terminal.status,
    outputs: (finalDetail.batch?.outputs || []).map((output) => ({
      outputId: output.outputId,
      kind: output.kind,
      status: output.status,
      filePath: output.filePath || output.outputPath || "",
      durationSec: output.durationSec
    }))
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
