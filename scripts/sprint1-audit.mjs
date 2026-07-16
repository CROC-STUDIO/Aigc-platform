#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

function readText(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function fileExists(root, path) {
  return existsSync(join(root, path));
}

function textIncludes(root, path, patterns = []) {
  const text = readText(join(root, path));
  return patterns.every((pattern) => pattern instanceof RegExp ? pattern.test(text) : text.includes(pattern));
}

function computePromptAb(root) {
  const csvPath = join(root, "tmp", "sprint1", "plan-prompt-ab-wzb_20260709020324_1d51.csv");
  if (!existsSync(csvPath)) return { status: "missing", csvPath };
  const rows = readText(csvPath).trim().split("\n").slice(1).map((line) => line.split(","));
  if (!rows.length || rows.length % 2 !== 0) return { status: "invalid", csvPath, rows: rows.length };
  const pairs = [];
  for (let index = 0; index < rows.length; index += 2) {
    const full = Number(rows[index][5]);
    const compact = Number(rows[index + 1][5]);
    if (!Number.isFinite(full) || !Number.isFinite(compact)) return { status: "invalid", csvPath, rows: rows.length };
    pairs.push({ full, compact, drop: (full - compact) / full });
  }
  const avgFull = pairs.reduce((sum, item) => sum + item.full, 0) / pairs.length;
  const avgCompact = pairs.reduce((sum, item) => sum + item.compact, 0) / pairs.length;
  const avgDrop = (avgFull - avgCompact) / avgFull;
  return { status: avgDrop >= 0.6 ? "passed" : "failed", csvPath, pairs: pairs.length, avgFull, avgCompact, avgDrop };
}

function scanBatches(root) {
  const batchesDir = join(root, "批处理记录", "网赚管线", "batches");
  const result = { total: 0, A: [], B: [], C: [] };
  if (!existsSync(batchesDir)) return result;
  for (const entry of readdirSync(batchesDir).filter((item) => item.startsWith("wzb_"))) {
    const batchPath = join(batchesDir, entry, "batch.json");
    const batch = readJson(batchPath);
    if (!batch) continue;
    result.total += 1;
    const durationSec = Number(batch.estimate?.durationSec ?? batch.estimate?.request?.durationSec ?? batch.request?.durationSec ?? 0) || 0;
    const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
    const hasTail = outputs.some((output) => Array.isArray(output.tailSegments) && output.tailSegments.length);
    const hasOverlay = outputs.some((output) => output.disclaimerOverlay?.applied) || JSON.stringify(outputs).includes("disclaimerOverlay");
    const record = { batchId: entry, status: batch.status, outputs: outputs.length };
    if (durationSec === 30 && hasTail) result.A.push(record);
    if (durationSec === 30 && !hasTail) result.B.push(record);
    if (durationSec === 15 && hasOverlay) result.C.push(record);
  }
  return result;
}

function mtimeIso(root, path) {
  const target = join(root, path);
  return existsSync(target) ? statSync(target).mtime.toISOString() : null;
}

const root = resolve(argValue("project-root", process.cwd()));
const defaultConfig = readJson(join(root, "config.default.json")) || {};
const runtimeConfig = readJson(join(root, "config.json")) || {};
const defaultWangzhuan = defaultConfig.wangzhuan || {};
const runtimeWangzhuan = runtimeConfig.wangzhuan || {};
const batchScan = scanBatches(root);
const promptAb = computePromptAb(root);

const checks = [
  {
    id: "4.1_llm_retry_wrapper",
    status: fileExists(root, "server/wangzhuan/llm-invoke.mjs")
      && textIncludes(root, "server/wangzhuan/reference-videos.mjs", ["invokeLlmWithRetry"])
      && textIncludes(root, "server/wangzhuan/plan-preview.mjs", ["invokeLlmWithRetry"])
      && textIncludes(root, "server/wangzhuan/pipeline.mjs", ["plan_batch_fallback", "batch.warnings"])
      && textIncludes(root, "tests/wangzhuan/llm-invoke.test.mjs", ["retries", "fallback"])
      && textIncludes(root, "tests/wangzhuan/plan-preview.test.mjs", ["retries invalid JSON content"])
      ? "passed" : "missing",
    evidence: [
      "server/wangzhuan/llm-invoke.mjs",
      "server/wangzhuan/reference-videos.mjs",
      "server/wangzhuan/plan-preview.mjs",
      "server/wangzhuan/pipeline.mjs",
      "tests/wangzhuan/llm-invoke.test.mjs",
      "tests/wangzhuan/plan-preview.test.mjs"
    ]
  },
  {
    id: "4.6_decomposition_cache_knowledge_notes",
    status: textIncludes(root, "server/wangzhuan/reference-videos.mjs", ["knowledgeNotesHash", "fission_decomposition_v2"])
      && textIncludes(root, "tests/wangzhuan/decomposition-cache-key.test.mjs", ["knowledgeNotes changes", "whitespace"])
      ? "passed" : "missing",
    evidence: ["server/wangzhuan/reference-videos.mjs", "tests/wangzhuan/decomposition-cache-key.test.mjs"]
  },
  {
    id: "4.2_plan_prompt_compact",
    status: defaultWangzhuan.planPromptCompact === false
      && runtimeWangzhuan.planPromptCompact === false
      && fileExists(root, "scripts/plan-prompt-ab.mjs")
      && promptAb.status === "passed"
      && textIncludes(root, "tests/wangzhuan/plan-prompt-compact.test.mjs", ["compact"])
      ? "passed" : "missing",
    evidence: ["config.default.json", "config.json", "scripts/plan-prompt-ab.mjs", promptAb.csvPath, "tests/wangzhuan/plan-prompt-compact.test.mjs"],
    metrics: promptAb
  },
  {
    id: "4.3_plan_cache",
    status: fileExists(root, "server/wangzhuan/plan-cache.mjs")
      && defaultWangzhuan.planCacheEnabled === true
      && runtimeWangzhuan.planCacheEnabled === true
      && textIncludes(root, "tests/wangzhuan/plan-cache.test.mjs", ["cache hit avoids second LLM call", "plan_cache_hit"])
      ? "passed" : "missing",
    evidence: ["server/wangzhuan/plan-cache.mjs", "tests/wangzhuan/plan-cache.test.mjs", "config.default.json", "config.json"]
  },
  {
    id: "4.4_upstream_poll_concurrency_timeout",
    status: defaultWangzhuan.upstreamPollConcurrency === 3
      && runtimeWangzhuan.upstreamPollConcurrency === 3
      && defaultWangzhuan.seedanceProvider?.pollTimeoutMs === 60000
      && runtimeWangzhuan.seedanceProvider?.pollTimeoutMs === 60000
      && textIncludes(root, "server/wangzhuan/upstream-poll.mjs", ["resolvePollConcurrency", "mapWithConcurrency"])
      && textIncludes(root, "server/wangzhuan/seedance-provider.mjs", ["pollTimeoutMs"])
      && textIncludes(root, "tests/wangzhuan/upstream-poll-state.test.mjs", ["upstream poll worker maps tasks concurrently"])
      ? "passed" : "missing",
    evidence: ["server/wangzhuan/upstream-poll.mjs", "server/wangzhuan/seedance-provider.mjs", "tests/wangzhuan/upstream-poll-state.test.mjs"]
  },
  {
    id: "4.5_variant_loop_concurrency",
    status: defaultWangzhuan.planLlmConcurrency?.variant === 3
      && runtimeWangzhuan.planLlmConcurrency?.variant === 3
      && textIncludes(root, "server/wangzhuan/pipeline.mjs", ["planConcurrency.variant", "mapWithConcurrency"])
      && textIncludes(root, "tests/wangzhuan/multi-slice-plan.test.mjs", ["variant-level plan generation"])
      ? "passed" : "missing",
    evidence: ["server/wangzhuan/pipeline.mjs", "tests/wangzhuan/multi-slice-plan.test.mjs", "config.default.json", "config.json"]
  },
  {
    id: "4.7_concat_overlay_single_path",
    status: textIncludes(root, "server/wangzhuan/stitch.mjs", ["overlayImagePath", "filter_complex", "applyDisclaimerOverlay"])
      && textIncludes(root, "tests/wangzhuan/stitch-single-encode.test.mjs", ["combine concat and disclaimer overlay"])
      ? "passed_local" : "missing",
    evidence: ["server/wangzhuan/stitch.mjs", "tests/wangzhuan/stitch-single-encode.test.mjs"],
    note: "Local ffmpeg unit coverage exists; true 15s + overlay batch C is still required for encoder-tag and visual acceptance."
  },
  {
    id: "abc_real_media_regression_batches",
    status: batchScan.A.length && batchScan.B.length && batchScan.C.length ? "passed" : "missing_external_evidence",
    evidence: batchScan,
    note: "Requires A=30s+tail, B=30s without tail, C=15s+overlay real batches from confirm to QC."
  },
  {
    id: "observability_doc",
    status: fileExists(root, "docs/网赚素材管线修改计划-observability.md") ? "passed" : "missing",
    evidence: ["docs/网赚素材管线修改计划-observability.md", ".gitignore"],
    mtime: mtimeIso(root, "docs/网赚素材管线修改计划-observability.md")
  }
];

const summary = {
  generatedAt: new Date().toISOString(),
  root,
  passed: checks.filter((check) => check.status === "passed" || check.status === "passed_local").length,
  missing: checks.filter((check) => !["passed", "passed_local"].includes(check.status)).map((check) => check.id),
  checks
};

const out = argValue("out");
const text = `${JSON.stringify(summary, null, 2)}\n`;
if (out) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const target = resolve(out);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf8");
} else {
  process.stdout.write(text);
}

if (summary.missing.length) {
  process.exitCode = 2;
}
