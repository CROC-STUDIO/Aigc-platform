#!/usr/bin/env node
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { loadEnvFile, loadRuntimeConfig } from "../server/runtime-config.mjs";
import { loadBatchDetailFromMysql, syncBatchFacts } from "../server/wangzhuan/mysql-facts.mjs";
import { writeTaskMaps } from "../server/wangzhuan/pipeline.mjs";
import { pollUpstreamBatch } from "../server/wangzhuan/upstream-poll.mjs";
import { wangzhuanPaths, writeAtomicJson } from "../server/wangzhuan/storage.mjs";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "..");

loadEnvFile({ envPath: join(repoRoot, ".env") });

function userProjectRoot(baseRoot, userId) {
  return join(resolve(baseRoot), "用户数据", userId, basename(resolve(baseRoot)));
}

function shouldRewindTask(task = {}) {
  if (task.status !== "failed") return false;
  if (task.errorCode !== "upstream_failed") return false;
  const message = String(task.errorMessage || "");
  if (message.includes("未返回视频地址")) return true;
  const upstream = String(task.responseSummary?.upstreamStatus || task.responseSummary?.status || "");
  return upstream === "succeeded" && !task.outputPath;
}

function rewindTask(task) {
  const next = {
    ...task,
    status: "waiting_upstream",
    errorCode: "",
    errorMessage: "",
    finishedAt: "",
    outputPath: task.outputPath || "",
    remoteUrlStored: false,
    missingVideoUrlPolls: 0
  };
  delete next.errorCode;
  delete next.errorMessage;
  if (!next.responseSummary) next.responseSummary = {};
  next.responseSummary = {
    ...next.responseSummary,
    waitingForVideoUrl: true,
    videoUrlStored: false
  };
  return next;
}

function buildContext(config, userId = "admin") {
  const baseRoot = resolve(config.projectRoot || config.projects?.[0]?.path || repoRoot);
  return {
    userProjectRoot: userProjectRoot(baseRoot, userId),
    sharedProjectRoot: baseRoot,
    userId,
    user: { userId, username: userId, role: "admin", isAdmin: true },
    config
  };
}

async function repairBatch(context, batchId, { poll = true } = {}) {
  const detail = await loadBatchDetailFromMysql(context, batchId);
  const batch = detail?.batch;
  if (!batch) throw new Error(`batch not found: ${batchId}`);

  let changed = 0;
  const tasks = (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    if (!shouldRewindTask(task)) return task;
    changed += 1;
    return rewindTask(task);
  });

  if (!changed) {
    console.log(`[repair] ${batchId}: no failed upstream-url tasks to rewind`);
    return { batch, changed: 0 };
  }

  const terminalStatuses = new Set(["failed", "stopped", "succeeded", "partial_failed"]);
  const nextBatch = {
    ...batch,
    tasks,
    status: terminalStatuses.has(batch.status) ? "running" : batch.status,
    finishedAt: "",
    stopReason: batch.status === "stopped" ? batch.stopReason : ""
  };

  const synced = await syncBatchFacts(context, nextBatch, "scheduler_retry");
  if (synced?.skipped) {
    throw new Error(`syncBatchFacts skipped for ${batchId}`);
  }

  await writeTaskMaps(context, nextBatch);
  const taskMapTarget = join(wangzhuanPaths(context).batchesDir, batchId, "task-map", "task-id-map.json");
  await writeAtomicJson(taskMapTarget, tasks);

  console.log(`[repair] ${batchId}: rewound ${changed} task(s) -> waiting_upstream, batch status=${nextBatch.status}`);

  if (poll) {
    const polled = await pollUpstreamBatch(context, batchId);
    console.log(`[repair] ${batchId}: poll polledCount=${polled.polledCount} advanced=${polled.advanced} batchStatus=${polled.batch.status}`);
    for (const task of polled.batch.tasks || []) {
      console.log(`  - ${task.generationTaskId}: ${task.status}${task.errorMessage ? ` (${task.errorMessage})` : ""}${task.outputPath ? ` -> ${task.outputPath}` : ""}`);
    }
    return { batch: polled.batch, changed };
  }

  return { batch: nextBatch, changed };
}

async function main() {
  const batchIds = process.argv.slice(2).filter(Boolean);
  if (!batchIds.length) {
    console.error("Usage: node scripts/repair-upstream-poll-tasks.mjs <batchId> [batchId...]");
    process.exit(1);
  }

  const { config } = await loadRuntimeConfig({
    runtimePath: process.env.AIGC_CONFIG_PATH || join(repoRoot, "config.json"),
    defaultPath: join(repoRoot, "config.default.json")
  });
  const context = buildContext(config, process.env.AIGC_REPAIR_USER || "admin");

  for (const batchId of batchIds) {
    await repairBatch(context, batchId, { poll: process.env.AIGC_REPAIR_NO_POLL !== "1" });
  }
}

main().catch((error) => {
  console.error("[repair] failed:", error?.stack || error?.message || error);
  process.exit(1);
});
