#!/usr/bin/env node
/**
 * 从 MySQL 读取批次脚本 + 参考图，按项目现有 seedance-provider 逻辑提交 Seedance。
 *
 * 用法:
 *   node --env-file=.env scripts/seedance-from-db.mjs --batch wzb_20260624203951_261b
 *   node --env-file=.env scripts/seedance-from-db.mjs --batch wzb_... --icon-batch wzb_...
 *   node --env-file=.env scripts/seedance-from-db.mjs --batch wzb_... --dry-run
 *   node --env-file=.env scripts/seedance-from-db.mjs --batch wzb_... --poll
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import mysql from "mysql2/promise";

import {
  buildSeedanceGenerationPayload,
  collectSeedanceMedia,
  createSeedanceProviderClient,
  resolveSeedanceModel
} from "../server/wangzhuan/seedance-provider.mjs";

const rootDir = dirname(fileURLToPath(import.meta.url));

function parseJson(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function argValue(flag, fallback = "") {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? String(process.argv[index + 1] || "").trim() : fallback;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

async function loadRun(conn, batchId) {
  const [rows] = await conn.execute(
    "SELECT id, run_uid, status, template_snapshot_json, request_json FROM workflow_runs WHERE run_uid = ? AND run_type = 'pipeline' LIMIT 1",
    [batchId]
  );
  return rows[0] || null;
}

async function loadPrompt(conn, runId, userRoot, batchId) {
  const [scriptRows] = await conn.execute(
    `SELECT gs.script_uid, af.storage_relative_path
     FROM generation_scripts gs
     LEFT JOIN asset_files af ON af.id = gs.prompt_asset_file_id
     WHERE gs.run_id = ?
     ORDER BY gs.id ASC
     LIMIT 1`,
    [runId]
  );
  const scriptId = scriptRows[0]?.script_uid || "scr_local_001";
  const rel = scriptRows[0]?.storage_relative_path;
  const candidates = [
    rel ? join(userRoot, rel) : "",
    join(userRoot, "批处理记录/网赚管线/batches", batchId, "prompts", "gen_261b_001_seedance.txt")
  ].filter(Boolean);
  for (const path of candidates) {
    try {
      const text = await readFile(path, "utf8");
      if (text.trim()) return { prompt: text.trim(), scriptId, promptPath: path, source: "file" };
    } catch {
      // try next
    }
  }

  const [taskRows] = await conn.execute(
    "SELECT request_summary_json FROM workflow_tasks WHERE run_id = ? ORDER BY id ASC LIMIT 1",
    [runId]
  );
  const summary = parseJson(taskRows[0]?.request_summary_json);
  if (summary?.prompt) {
    return {
      prompt: String(summary.prompt).trim(),
      scriptId: summary.scriptId || scriptId,
      promptPath: summary.promptPath || "",
      source: "workflow_tasks.request_summary_json"
    };
  }

  const [runRows] = await conn.execute(
    "SELECT capability_json FROM workflow_runs WHERE id = ? LIMIT 1",
    [runId]
  );
  const capability = parseJson(runRows[0]?.capability_json);
  const planPrompt = capability?.plans?.[0]?.seedancePrompt;
  if (planPrompt) {
    return {
      prompt: String(planPrompt).trim(),
      scriptId,
      promptPath: "",
      source: "workflow_runs.capability_json.plans"
    };
  }

  throw new Error(`未找到 Seedance prompt，batch=${batchId}`);
}

function branchDraftFromRun(run, iconBranch = null) {
  const snap = parseJson(run.template_snapshot_json);
  const req = parseJson(run.request_json);
  const base = snap?.draft?.branches?.[0] || snap?.draft || req?.branchDrafts?.[0] || req?.branches?.[0] || {};
  if (!iconBranch) return base;
  return {
    ...base,
    assetUrls: {
      ...(base.assetUrls || {}),
      ...(iconBranch.assetUrls || {})
    },
    assetReviews: {
      ...(base.assetReviews || {}),
      ...(iconBranch.assetReviews || {})
    },
    assetStoredPaths: {
      ...(base.assetStoredPaths || {}),
      ...(iconBranch.assetStoredPaths || {})
    }
  };
}

async function main() {
  const batchId = argValue("--batch");
  if (!batchId) {
    console.error("缺少 --batch wzb_...");
    process.exit(1);
  }
  const iconBatchId = argValue("--icon-batch", "");
  const dryRun = hasFlag("--dry-run");
  const poll = hasFlag("--poll");

  const config = JSON.parse(await readFile(join(rootDir, "../config.json"), "utf8"));
  const baseRoot = resolve(rootDir, "..", process.env.AIGC_PROJECT_ROOT || config.projectRoot || "../project-data/PROJECT_ROOT_P");
  const userRoot = join(baseRoot, "users", "admin");
  const ctx = {
    userProjectRoot: userRoot,
    sharedProjectRoot: baseRoot,
    userId: "admin",
    user: { userId: "admin", username: "admin", role: "admin", isAdmin: true },
    config
  };

  const conn = await mysql.createConnection({
    host: process.env.AIGC_DB_HOST,
    port: Number(process.env.AIGC_DB_PORT || 3306),
    user: process.env.AIGC_DB_USER,
    password: process.env.AIGC_DB_PASSWORD,
    database: process.env.AIGC_DB_NAME
  });

  try {
    const run = await loadRun(conn, batchId);
    if (!run) throw new Error(`批次不存在: ${batchId}`);

    let iconBranch = null;
    if (iconBatchId) {
      const iconRun = await loadRun(conn, iconBatchId);
      if (!iconRun) throw new Error(`icon 来源批次不存在: ${iconBatchId}`);
      iconBranch = branchDraftFromRun(iconRun);
    }

    const branch = branchDraftFromRun(run, iconBranch);
    const snap = parseJson(run.template_snapshot_json);
    const req = parseJson(run.request_json);
    const { prompt, scriptId, promptPath, source } = await loadPrompt(conn, run.id, userRoot, batchId);

    const batch = {
      batchId,
      status: run.status,
      templateSnapshot: {
        ...snap,
        draft: {
          ...(snap.draft || {}),
          branches: [branch],
          assetUrls: branch.assetUrls || {}
        }
      },
      branchDrafts: [branch],
      scripts: [{ scriptId }],
      estimate: { request: req }
    };

    const task = {
      scriptId,
      branchId: branch.branchId || "branch_1",
      durationSec: Number(req.durationSec || branch.defaultDurationSec || 15)
    };

    const media = collectSeedanceMedia(batch, task);
    const provider = createSeedanceProviderClient(ctx);
    const payload = buildSeedanceGenerationPayload({
      model: resolveSeedanceModel(batch, provider, task),
      prompt,
      media,
      mode: media.length ? "omni_reference" : "text_to_video",
      ratio: provider?.config?.ratio || req.outputRatio || "9:16",
      duration: task.durationSec,
      resolution: provider?.config?.resolution || "720p",
      generateAudio: provider?.config?.generateAudio ?? true,
      watermark: provider?.config?.watermark ?? false
    });

    console.log(JSON.stringify({
      batchId,
      batchStatus: run.status,
      scriptId,
      promptSource: source,
      promptPath,
      promptPreview: prompt.slice(0, 240),
      mediaCount: media.length,
      media,
      payload: {
        mode: payload.mode,
        model: payload.model,
        ratio: payload.ratio,
        duration: payload.duration,
        resolution: payload.resolution,
        content: payload.content,
        promptPreview: payload.prompt.slice(0, 240)
      }
    }, null, 2));

    if (dryRun) {
      console.log("\n[dry-run] 未提交上游任务");
      return;
    }

    let result;
    try {
      result = await provider.createTask(payload);
    } catch (error) {
      console.error("\n[submit failed]", error?.message || error);
      if (error?.data) console.error("[upstream]", JSON.stringify(error.data, null, 2));
      throw error;
    }
    console.log("\n[submit]", JSON.stringify(result, null, 2));
    if (!poll) return;
    for (let i = 0; i < 24; i += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 5000));
      const status = await provider.getTask(result.taskId);
      console.log(`[poll ${i + 1}]`, status.status, status.videoUrl || "");
      if (status.status === "succeeded" || status.status === "failed") {
        console.log("[final]", JSON.stringify(status, null, 2));
        break;
      }
    }
  } finally {
    await conn.end();
  }
}

main().catch((error) => {
  if (error?.data) console.error("[upstream detail]", JSON.stringify(error.data, null, 2));
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
