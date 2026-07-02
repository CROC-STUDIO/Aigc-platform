#!/usr/bin/env node
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { checkReferenceVideo, decomposeReferenceVideo, draftReferenceVideoDecomposition } from "../server/wangzhuan/reference-videos.mjs";
import { estimateBatch, prepareBatchPlanFromEstimate } from "../server/wangzhuan/estimates.mjs";
import { confirmBatchPlan, getBatchDetail, submitPendingGenerationTasks } from "../server/wangzhuan/pipeline.mjs";
import { pollUpstreamBatch } from "../server/wangzhuan/upstream-poll.mjs";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runId = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const outDir = resolve(rootDir, "tmp", `wangzhuan-30s-pipeline-${runId}`);
const resultPath = join(outDir, "result.json");
const sourceVideoPath = process.argv[2] || "/Users/lucy/Downloads/V_40116_1_DramaGold_多场景拼接安利短剧网赚1_PT_HC_720X1280.mp4";

function now() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function saveResult(result) {
  await mkdir(outDir, { recursive: true });
  await writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
}

function userProjectRoot(baseRoot, userId = "admin") {
  const projectName = baseRoot.split("/").filter(Boolean).at(-1) || "project";
  return join(baseRoot, "用户数据", userId, projectName);
}

function makeContext(config) {
  const baseRoot = resolve(rootDir, config.projectRoot || "../project-data/PROJECT_ROOT_P");
  return {
    config,
    userId: "admin",
    user: { userId: "admin", username: "admin", role: "admin", isAdmin: true },
    projectName: "PROJECT_ROOT_P",
    sharedProjectRoot: baseRoot,
    userProjectRoot: userProjectRoot(baseRoot, "admin"),
    requestId: `smoke_${runId}`,
    currentUserId: () => "admin",
    currentUser: () => ({ userId: "admin", username: "admin", role: "admin", isAdmin: true }),
    currentBaseProjectRoot: () => baseRoot,
    currentProjectRoot: () => userProjectRoot(baseRoot, "admin"),
    getLegacyRunState: () => ({ running: false })
  };
}

function branchDraft() {
  return {
    branchId: "branch_br_pt_1",
    branchIndex: 1,
    branchLabel: "BR Portuguese localized fission",
    displayName: "DramaGold 30s PT Seedance pipeline smoke",
    productName: "DramaGold",
    productLink: "https://example.com/dramagold",
    targetChannels: ["meta_ads"],
    targetRegions: ["BR"],
    regions: ["BR"],
    language: "pt-BR",
    languages: ["pt-BR"],
    primaryLanguage: "pt-BR",
    currencySymbol: "R$",
    materialDirection: "reference_video_fission",
    materialDirectionCustom: "复用参考视频结构、节奏、镜头和转化逻辑；必须改变人物身份、职业/人群、具体场景、服装和道具；不要强制生成 CTA/ending。",
    voiceoverStyle: "UGC short drama and app demo, Portuguese",
    promiseLevel: "stable",
    truthRules: {},
    cta: "",
    ending: "",
    variantPrompt: "人物外观、人种/肤色范围、生活场景、职业身份、服装道具、城市/室内环境必须贴合 BR / pt-BR 本地语境；用户可见文字全部使用葡语；如出现币种只能是 R$；禁止编金额、提现档位、收益承诺、强到账承诺。",
    customPrompt: "",
    negativePrompt: "no gender drift within the same variant, no copied original character, no copied original exact room or washing shed, no fabricated money amount, no payout tier, no guaranteed withdrawal, no instant payment, no strong income promise",
    defaultDurationSec: 30,
    defaultOutputRatio: "9:16"
  };
}

function estimateRequest(referenceVideoId) {
  const branch = branchDraft();
  return {
    batchName: `pipeline-smoke-${runId}`,
    projectName: "PROJECT_ROOT_P",
    referenceVideoId,
    targetChannel: "meta_ads",
    targetRegion: "BR",
    targetRegions: ["BR"],
    language: "pt-BR",
    languages: ["pt-BR"],
    primaryLanguage: "pt-BR",
    currencySymbol: "R$",
    promiseLevel: "stable",
    truthRules: {},
    durationSec: 30,
    variantCount: 1,
    requestedConcurrency: 1,
    outputRatio: "9:16",
    seedanceModel: "dreamina-seedance-2-0-260128",
    disclaimerEnabled: true,
    disclaimerPresetId: "auto",
    templateSnapshot: {
      draft: {
        ...branch,
        branches: [branch]
      }
    },
    branches: [branch]
  };
}

async function pollPipelineToTerminal(context, batchId, result) {
  for (let attempt = 1; attempt <= 120; attempt += 1) {
    const polled = await pollUpstreamBatch(context, batchId);
    const batch = polled.batch;
    const tasks = Array.isArray(batch.tasks) ? batch.tasks : [];
    const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
    result.events.push({
      at: now(),
      type: "pipeline_poll",
      attempt,
      batchStatus: batch.status,
      taskStatuses: tasks.map((task) => ({
        generationTaskId: task.generationTaskId,
        segmentIndex: task.segmentIndex,
        status: task.status,
        seedanceTaskId: task.seedanceTaskId || "",
        hasContinuity: Boolean(task.continuityReference?.review?.assetId),
        outputPath: task.outputPath || ""
      })),
      outputs: outputs.map((output) => ({
        outputId: output.outputId,
        kind: output.kind,
        status: output.status,
        filePath: output.filePath || output.outputPath || "",
        durationSec: output.durationSec || null
      })),
      needsPoll: polled.needsPoll,
      advanced: polled.advanced,
      polledCount: polled.polledCount
    });
    result.latestBatch = {
      batchId: batch.batchId,
      status: batch.status,
      tasks: tasks.map((task) => ({
        generationTaskId: task.generationTaskId,
        segmentIndex: task.segmentIndex,
        status: task.status,
        seedanceTaskId: task.seedanceTaskId || "",
        continuityAssetId: task.continuityReference?.review?.assetId || "",
        outputPath: task.outputPath || ""
      })),
      outputs: outputs
    };
    await saveResult(result);
    console.log(`[poll ${attempt}] batch=${batch.status} tasks=${tasks.map((task) => `${task.segmentIndex}:${task.status}`).join(",")} outputs=${outputs.length}`);
    if (["succeeded", "partial_failed", "failed", "stopped"].includes(batch.status)) return batch;
    await sleep(20_000);
  }
  throw new Error(`pipeline timed out: ${batchId}`);
}

async function main() {
  process.env.AIGC_DB_PORT = process.env.AIGC_DB_PORT_OVERRIDE || "3308";
  const config = JSON.parse(await readFile(resolve(rootDir, "config.json"), "utf8"));
  const context = makeContext(config);
  const result = {
    runId,
    sourceVideoPath,
    outDir,
    resultPath,
    startedAt: now(),
    context: {
      projectName: context.projectName,
      sharedProjectRoot: context.sharedProjectRoot,
      userProjectRoot: context.userProjectRoot,
      dbHost: process.env.AIGC_DB_HOST,
      dbPort: process.env.AIGC_DB_PORT
    },
    events: []
  };
  await saveResult(result);

  const source = await readFile(sourceVideoPath);
  const fileName = sourceVideoPath.split("/").at(-1);
  const checked = await checkReferenceVideo(context, {
    fileName,
    name: fileName,
    mimeType: "video/mp4",
    content: `data:video/mp4;base64,${source.toString("base64")}`
  });
  result.referenceVideo = checked.referenceVideo;
  await saveResult(result);
  console.log(`[reference] ${checked.referenceVideo.referenceVideoId} status=${checked.referenceVideo.status} duration=${checked.referenceVideo.durationSec}`);

  const draft = await draftReferenceVideoDecomposition(context, {
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    targetRegion: "BR",
    targetRegions: ["BR"],
    language: "pt-BR",
    languages: ["pt-BR"],
    primaryLanguage: "pt-BR",
    currencySymbol: "R$",
    productName: "DramaGold",
    promiseLevel: "stable"
  }, { requestId: context.requestId });
  result.decompositionDraft = draft.decomposition || draft.draft || draft;
  await saveResult(result);
  console.log("[decomposition] draft ready");

  const decomposition = result.decompositionDraft.decomposition || result.decompositionDraft;
  const confirmedDecomposition = await decomposeReferenceVideo(context, {
    idempotencyKey: `decompose-${runId}`,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    decomposition
  });
  result.decomposition = confirmedDecomposition.decomposition;
  await saveResult(result);
  console.log("[decomposition] confirmed");

  const estimatePayload = estimateRequest(checked.referenceVideo.referenceVideoId);
  const estimated = await estimateBatch(context, {
    ...estimatePayload,
    idempotencyKey: `estimate-${runId}`
  });
  result.estimate = estimated.estimate;
  await saveResult(result);
  console.log(`[estimate] ${estimated.estimate.estimateId} segments=${estimated.estimate.seedanceSegmentCount}`);

  const planned = await prepareBatchPlanFromEstimate(context, {
    estimateId: estimated.estimate.estimateId,
    idempotencyKey: `plan-${runId}`,
    llmConfig: {},
    knowledgeNotes: "本次为30s Seedance真实生成实验。以参考视频结构/节奏/镜头/转化逻辑为准，但必须改变人物身份、职业/人群、具体场景、服装、道具；BR本地化；用户可见文字pt-BR；币种只能R$；CTA/ending可选且默认不生成；禁止编金额、提现档位、收益承诺、强到账承诺。"
  });
  result.planBatch = {
    batchId: planned.batch.batchId,
    status: planned.batch.status,
    planCount: planned.plans?.length || planned.batch.plans?.length || 0,
    plans: planned.batch.plans
  };
  await saveResult(result);
  console.log(`[plan] batch=${planned.batch.batchId} plans=${result.planBatch.planCount}`);

  const plans = planned.batch.plans || [];
  const confirmed = await confirmBatchPlan(context, planned.batch.batchId, {
    idempotencyKey: `confirm-${runId}`,
    planIds: plans.map((plan) => plan.planId),
    confirmedPlanIds: plans.map((plan) => plan.planId),
    plans,
    branchDrafts: estimatePayload.branches,
    confirmationNotes: "pipeline smoke auto-confirmed"
  });
  result.confirmed = {
    batchId: confirmed.batch.batchId,
    status: confirmed.batch.status,
    confirmedPlanIds: confirmed.confirmedPlanIds
  };
  await saveResult(result);
  console.log(`[confirm] batch=${confirmed.batch.batchId} status=${confirmed.batch.status}`);

  const submitted = await submitPendingGenerationTasks(context, confirmed.batch.batchId);
  result.initialSubmit = {
    batchStatus: submitted.batch.status,
    submittedCount: submitted.submittedCount,
    tasks: submitted.batch.tasks?.map((task) => ({
      generationTaskId: task.generationTaskId,
      segmentIndex: task.segmentIndex,
      status: task.status,
      seedanceTaskId: task.seedanceTaskId || ""
    }))
  };
  await saveResult(result);
  console.log(`[submit] count=${submitted.submittedCount} status=${submitted.batch.status}`);

  const terminal = await pollPipelineToTerminal(context, confirmed.batch.batchId, result);
  const detail = await getBatchDetail(context, terminal.batchId);
  result.final = {
    batch: detail.batch,
    outputs: detail.batch?.outputs || []
  };
  result.finishedAt = now();
  await saveResult(result);
  console.log(JSON.stringify({
    resultPath,
    referenceVideoId: checked.referenceVideo.referenceVideoId,
    estimateId: estimated.estimate.estimateId,
    batchId: terminal.batchId,
    status: terminal.status,
    outputs: (detail.batch?.outputs || []).map((output) => ({
      outputId: output.outputId,
      kind: output.kind,
      status: output.status,
      filePath: output.filePath || output.outputPath || "",
      durationSec: output.durationSec
    }))
  }, null, 2));
}

main().catch(async (error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
