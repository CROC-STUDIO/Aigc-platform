import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { makeTimestampId } from "./ids.mjs";
import { WangzhuanError } from "./http.mjs";
import { readJsonOrDefault, toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { DEFAULT_CODEX_MODEL, DEFAULT_CODEX_TIMEOUT_MS, runCodexExec } from "./codex-cli.mjs";

export const SEEDANCE_PROMPT_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    prompt: { type: "string" },
    negativePrompt: { type: "string" },
    title: { type: "string" },
    reasoningSummary: { type: "string" },
    complianceChecks: {
      type: "array",
      items: { type: "string" }
    },
    warnings: {
      type: "array",
      items: { type: "string" }
    },
    approvedAssetKeysUsed: {
      type: "array",
      items: { type: "string" }
    }
  },
  required: [
    "prompt",
    "negativePrompt",
    "reasoningSummary",
    "complianceChecks",
    "warnings",
    "approvedAssetKeysUsed"
  ],
  additionalProperties: false
});

function ensureBatchId(batchId) {
  const value = String(batchId || "").trim();
  if (!value) {
    throw new WangzhuanError("validation_error", "batchId 不能为空", { field: "batchId" });
  }
  return value;
}

function cleanArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function cleanObject(value) {
  return value && typeof value === "object" ? structuredClone(value) : {};
}

function normalizeCommonInput(input = {}) {
  return {
    batchId: ensureBatchId(input.batchId),
    decompositionResult: cleanObject(input.decompositionResult),
    productContext: cleanObject(input.productContext),
    approvedAssets: Array.isArray(input.approvedAssets) ? structuredClone(input.approvedAssets) : [],
    targetRegion: String(input.targetRegion || "").trim(),
    language: String(input.language || "").trim(),
    durationSec: Number.isFinite(Number(input.durationSec)) ? Number(input.durationSec) : null,
    aspectRatio: String(input.aspectRatio || "").trim(),
    style: String(input.style || "").trim(),
    forbiddenItems: cleanArray(input.forbiddenItems),
    requestId: String(input.requestId || "").trim(),
    skillName: String(input.skillName || "").trim(),
    repoRoot: String(input.repoRoot || process.cwd()).trim() || process.cwd(),
    model: String(input.model || DEFAULT_CODEX_MODEL).trim() || DEFAULT_CODEX_MODEL,
    timeoutMs: Number.isFinite(Number(input.timeoutMs)) ? Math.max(1000, Number(input.timeoutMs)) : DEFAULT_CODEX_TIMEOUT_MS
  };
}

function promptStorageRoot(context, batchId) {
  return join(wangzhuanPaths(context).userRoot, "codex", "batches", batchId);
}

function publicPath(context, fullPath) {
  return toProjectRelative(context.userProjectRoot, fullPath);
}

function promptFilePaths(context, batchId, promptDraftId, jobId) {
  const root = promptStorageRoot(context, batchId);
  return {
    root,
    draftsDir: join(root, "prompt-drafts"),
    jobsDir: join(root, "jobs"),
    contextPath: join(root, "prompt-drafts", `${promptDraftId}.context.json`),
    resultPath: join(root, "prompt-drafts", `${promptDraftId}.result.json`),
    jobPath: join(root, "jobs", `${jobId}.json`),
    stdoutPath: join(root, "jobs", `${jobId}.stdout.log`),
    stderrPath: join(root, "jobs", `${jobId}.stderr.log`)
  };
}

function createPromptJobRecord({ jobId, promptDraftId, batchId, mode, model, requestId, contextPath, resultPath, status = "queued" }) {
  const now = new Date().toISOString();
  return {
    jobUid: jobId,
    promptDraftUid: promptDraftId,
    batchId,
    jobType: mode === "refine" ? "seedance_prompt_refine" : "seedance_prompt_base",
    status,
    model,
    requestId,
    contextPath,
    resultPath,
    stdoutPath: "",
    stderrPath: "",
    errorCode: "",
    errorMessage: "",
    exitCode: null,
    startedAt: status === "queued" ? null : now,
    finishedAt: null,
    durationMs: null,
    createdAt: now,
    updatedAt: now
  };
}

function validatePromptResult(result = {}) {
  const prompt = String(result.prompt || "").trim();
  const negativePrompt = String(result.negativePrompt || "").trim();
  const reasoningSummary = String(result.reasoningSummary || "").trim();
  if (!prompt) {
    throw new WangzhuanError("schema_invalid", "Codex 返回结果缺少 prompt", {
      field: "prompt"
    }, 422);
  }
  if (!negativePrompt) {
    throw new WangzhuanError("schema_invalid", "Codex 返回结果缺少 negativePrompt", {
      field: "negativePrompt"
    }, 422);
  }
  if (!reasoningSummary) {
    throw new WangzhuanError("schema_invalid", "Codex 返回结果缺少 reasoningSummary", {
      field: "reasoningSummary"
    }, 422);
  }
  return {
    title: String(result.title || "").trim(),
    prompt,
    negativePrompt,
    reasoningSummary,
    complianceChecks: cleanArray(result.complianceChecks),
    warnings: cleanArray(result.warnings),
    approvedAssetKeysUsed: cleanArray(result.approvedAssetKeysUsed)
  };
}

function buildCodexInstruction(mode, payload) {
  const lines = [
    payload.skillName ? `使用 ${payload.skillName} skill 完成任务。` : "",
    "你要为 Seedance 生成一版可执行的首版视频 prompt。",
    mode === "refine"
      ? "当前任务是 refinement：必须在已有产品理解基础上，结合 approvedAssets 优化提示词。"
      : "当前任务是 base draft：先生成一版不依赖未审核素材的基础提示词。",
    "严格遵守 forbiddenItems，不得编造未提供的产品事实。",
    "如果存在 approvedAssets，只能引用 approvedAssets；不得把候选素材、待审核素材、网页图片直接当作可用 Seedance 素材。",
    "输出必须是严格 JSON，不要输出 Markdown，不要输出解释性前后缀。",
    "",
    "<context>",
    JSON.stringify(payload, null, 2),
    "</context>"
  ].filter(Boolean);
  return `${lines.join("\n")}\n`;
}

async function persistJobState(target, job) {
  const body = {
    ...job,
    updatedAt: new Date().toISOString()
  };
  await writeAtomicJson(target, body);
  return body;
}

async function persistLogs(paths, execResult) {
  await writeAtomicJson(paths.resultPath, execResult.resultBody);
  await writeAtomicJson(paths.jobPath, execResult.jobBody);
  if (execResult.stdout !== undefined) {
    await writeFile(paths.stdoutPath, String(execResult.stdout || ""), "utf8");
  }
  if (execResult.stderr !== undefined) {
    await writeFile(paths.stderrPath, String(execResult.stderr || ""), "utf8");
  }
}

async function generatePrompt(mode, context, input, deps = {}) {
  const normalized = normalizeCommonInput(input);
  const promptDraftId = makeTimestampId("cpd");
  const jobId = makeTimestampId("cdxjob");
  const filePaths = promptFilePaths(context, normalized.batchId, promptDraftId, jobId);
  const promptContext = {
    mode,
    batchId: normalized.batchId,
    decompositionResult: normalized.decompositionResult,
    productContext: normalized.productContext,
    approvedAssets: normalized.approvedAssets,
    targetRegion: normalized.targetRegion,
    language: normalized.language,
    durationSec: normalized.durationSec,
    aspectRatio: normalized.aspectRatio,
    style: normalized.style,
    forbiddenItems: normalized.forbiddenItems,
    requestId: normalized.requestId
  };
  const promptText = buildCodexInstruction(mode, {
    ...promptContext,
    ...(normalized.skillName ? { skillName: normalized.skillName } : {})
  });
  await writeAtomicJson(filePaths.contextPath, promptContext);
  const queuedJob = await persistJobState(filePaths.jobPath, createPromptJobRecord({
    jobId,
    promptDraftId,
    batchId: normalized.batchId,
    mode,
    model: normalized.model,
    requestId: normalized.requestId,
    contextPath: filePaths.contextPath,
    resultPath: filePaths.resultPath
  }));
  const execute = deps.runCodexExec || runCodexExec;
  const syncJobFact = deps.syncCodexExecJobFact || context.syncCodexExecJobFact;
  const syncPromptFact = deps.syncCodexPromptDraftFact || context.syncCodexPromptDraftFact;

  try {
    const runningJob = await persistJobState(filePaths.jobPath, {
      ...queuedJob,
      status: "running",
      startedAt: new Date().toISOString()
    });
    await syncJobFact?.({
      ...runningJob,
      batchId: normalized.batchId,
      model: normalized.model,
      cwdPath: normalized.repoRoot
    });
    const exec = await execute({
      cwd: normalized.repoRoot,
      prompt: promptText,
      model: normalized.model,
      timeoutMs: normalized.timeoutMs,
      outputSchema: SEEDANCE_PROMPT_OUTPUT_SCHEMA
    });
    const result = validatePromptResult(exec.json || {});
    const resultBody = {
      promptDraftUid: promptDraftId,
      batchId: normalized.batchId,
      draftType: mode,
      version: 1,
      status: "ready",
      usesApprovedAssets: result.approvedAssetKeysUsed.length > 0,
      ...result,
      contextPath: publicPath(context, filePaths.contextPath),
      resultPath: publicPath(context, filePaths.resultPath),
      requestId: normalized.requestId,
      createdAt: queuedJob.createdAt,
      updatedAt: new Date().toISOString()
    };
    const jobBody = {
      ...runningJob,
      status: "succeeded",
      exitCode: exec.exitCode,
      durationMs: exec.durationMs,
      finishedAt: exec.finishedAt,
      stdoutPath: publicPath(context, filePaths.stdoutPath),
      stderrPath: publicPath(context, filePaths.stderrPath)
    };
    await persistLogs(filePaths, {
      resultBody,
      jobBody,
      stdout: exec.stdout,
      stderr: exec.stderr
    });
    await syncPromptFact?.({
      ...resultBody,
      batchId: normalized.batchId,
      context: promptContext,
      createdByUser: context.user?.username || context.userId || ""
    });
    await syncJobFact?.({
      ...jobBody,
      promptDraftUid: promptDraftId,
      batchId: normalized.batchId,
      model: normalized.model,
      cwdPath: normalized.repoRoot
    });
    return {
      promptDraftId,
      jobId,
      contextPath: publicPath(context, filePaths.contextPath),
      resultPath: publicPath(context, filePaths.resultPath),
      jobPath: publicPath(context, filePaths.jobPath),
      ...resultBody
    };
  } catch (error) {
    const failedJob = {
      ...queuedJob,
      status: "failed",
      errorCode: error?.code || "model_failed",
      errorMessage: String(error?.message || "Codex 生成失败"),
      finishedAt: new Date().toISOString()
    };
    await writeAtomicJson(filePaths.jobPath, failedJob);
    await syncJobFact?.({
      ...failedJob,
      batchId: normalized.batchId,
      model: normalized.model,
      cwdPath: normalized.repoRoot
    });
    throw error;
  }
}

export async function generateBaseSeedancePrompt({ context, ...input }, deps = {}) {
  return generatePrompt("base", context, input, deps);
}

export async function refineSeedancePromptWithApprovedAssets({ context, ...input }, deps = {}) {
  return generatePrompt("refine", context, input, deps);
}

export async function loadSeedancePromptDraft(context, batchId, promptDraftId) {
  const target = promptFilePaths(context, ensureBatchId(batchId), String(promptDraftId || "").trim(), "unused").resultPath;
  return readJsonOrDefault(target, null);
}
