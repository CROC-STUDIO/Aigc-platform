#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { loadRuntimeConfig } from "../server/runtime-config.mjs";
import { buildSlicePlanFromDecomposition } from "../server/wangzhuan/pipeline.mjs";
import { buildSeedancePlanMessages, generateSeedancePlan } from "../server/wangzhuan/plan-preview.mjs";

function argValue(name, fallback = "") {
  const flag = `--${name}`;
  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  const inline = process.argv.find((item) => item.startsWith(`${flag}=`));
  return inline ? inline.slice(flag.length + 1) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function loadBatch() {
  const batchJson = argValue("batch-json");
  if (batchJson) return JSON.parse(await readFile(resolve(batchJson), "utf8"));
  const batchId = argValue("batch-id");
  if (!batchId) throw new Error("Usage: node scripts/plan-prompt-ab.mjs --batch-json <file> OR --batch-id <batchId>");
  const root = resolve(argValue("project-root", process.cwd()));
  const target = join(root, "批处理记录", "网赚管线", "batches", batchId, "batch.json");
  return JSON.parse(await readFile(target, "utf8"));
}

function branchDrafts(batch = {}) {
  if (Array.isArray(batch.branchDrafts) && batch.branchDrafts.length) return batch.branchDrafts;
  if (Array.isArray(batch.estimate?.request?.branches) && batch.estimate.request.branches.length) return batch.estimate.request.branches;
  const draft = batch.templateSnapshot?.draft || {};
  return [{ ...draft, branchId: draft.branchId || "branch_1", branchLabel: draft.branchLabel || draft.productName || "default" }];
}

function firstVariantCount(batch = {}) {
  const value = Number(batch.estimate?.variantCount || batch.estimate?.request?.variantCount || 1);
  return Number.isFinite(value) && value > 0 ? Math.round(value) : 1;
}

function numericArg(name, fallback) {
  const value = Number(argValue(name, ""));
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

async function loadConfig(root) {
  const { config } = await loadRuntimeConfig({
    runtimePath: argValue("config", process.env.AIGC_CONFIG_PATH || join(root, "config.json")),
    defaultPath: argValue("default-config", join(root, "config.default.json"))
  });
  return config;
}

function rowFor({ mode, runIndex, branch, variantIndex, slice, messages, plan = null, error = null }) {
  const text = JSON.stringify(messages);
  const seedancePrompt = String(plan?.seedancePrompt || "");
  const imagePrompt = String(plan?.imagePrompt || "");
  return [
    branch.branchId || branch.branchLabel || "",
    variantIndex,
    slice.segmentIndex || slice.seedanceSliceIndex || "",
    mode,
    runIndex,
    text.length,
    seedancePrompt ? seedancePrompt.length : "",
    imagePrompt ? imagePrompt.length : "",
    plan ? Boolean(plan.voiceover) : /voiceover/i.test(text),
    plan ? Boolean(plan.cta) : /cta/i.test(text),
    plan ? /moneyVisual|金币|现金|cash|coin|coin_burst/i.test(JSON.stringify(plan)) : /moneyVisual|金币|现金|cash|coin/i.test(text),
    plan ? Boolean(plan.repairApplied) : "",
    error ? "false" : "true",
    error ? String(error?.message || error).replace(/\s+/g, " ").slice(0, 300) : ""
  ].map(csvEscape).join(",");
}

const batch = await loadBatch();
const projectRoot = resolve(argValue("project-root", process.cwd()));
const invokeLlm = hasFlag("invoke-llm");
const runs = invokeLlm ? numericArg("runs", 1) : 1;
const maxPairs = numericArg("max-pairs", Number.POSITIVE_INFINITY);
const config = invokeLlm ? await loadConfig(projectRoot) : {};
const variants = firstVariantCount(batch);
const slices = buildSlicePlanFromDecomposition(batch);
const rows = ["branch,variant,slice,mode,run,promptCharCount,seedancePromptLength,imagePromptLength,hasVoiceover,hasCta,hasMoneyVisual,repairApplied,success,error"];
const telemetry = [];
let pairCount = 0;

outer:
for (const branch of branchDrafts(batch)) {
  for (let branchVariantIndex = 1; branchVariantIndex <= variants; branchVariantIndex += 1) {
    for (let index = 0; index < slices.length; index += 1) {
      if (pairCount >= maxPairs) break outer;
      const slice = slices[index] || {};
      pairCount += 1;
      for (const compact of [false, true]) {
        const input = {
          batch,
          branch,
          decomposition: batch.decomposition || {},
          channelRules: batch.channelRules || { rules: [] },
          branchVariantIndex,
          segmentIndex: index + 1,
          segmentRole: slice.segmentRole,
          sliceDurationSec: slice.sliceDurationSec || slice.durationSec,
          currentSlice: slice,
          totalSegmentCount: slices.length,
          mandatoryMoneyVisualCarrier: index === 0,
          isFinalSeedanceSlice: index === slices.length - 1,
          knowledgeNotes: batch.estimate?.request?.knowledgeNotes || "",
          options: { compact }
        };
        const messages = buildSeedancePlanMessages(input);
        for (let runIndex = 1; runIndex <= runs; runIndex += 1) {
          if (!invokeLlm) {
            rows.push(rowFor({
              mode: compact ? "compact" : "full",
              runIndex,
              branch,
              variantIndex: branchVariantIndex,
              slice,
              messages
            }));
            continue;
          }
          try {
            const plan = await generateSeedancePlan({
              userProjectRoot: projectRoot,
              sharedProjectRoot: projectRoot,
              currentBatchId: batch.batchId || "",
              requestId: `ab_${compact ? "compact" : "full"}_${branchVariantIndex}_${index + 1}_${runIndex}`,
              config: {
                ...config,
                wangzhuan: {
                  ...(config.wangzhuan || {}),
                  planCacheEnabled: false,
                  planPromptCompact: compact,
                  planPromptCompactBranches: []
                }
              },
              recordTelemetryEvent: async (eventName, payload) => {
                telemetry.push({ eventName, payload });
              }
            }, {
              ...input,
              options: {}
            });
            rows.push(rowFor({
              mode: compact ? "compact" : "full",
              runIndex,
              branch,
              variantIndex: branchVariantIndex,
              slice,
              messages,
              plan
            }));
          } catch (error) {
            rows.push(rowFor({
              mode: compact ? "compact" : "full",
              runIndex,
              branch,
              variantIndex: branchVariantIndex,
              slice,
              messages,
              error
            }));
          }
        }
      }
    }
  }
}

const output = argValue("out");
if (output) {
  await writeFile(resolve(output), `${rows.join("\n")}\n`, "utf8");
} else {
  process.stdout.write(`${rows.join("\n")}\n`);
}
