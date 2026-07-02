#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  buildSeedanceGenerationPayload,
  createSeedanceProviderClient
} from "../server/wangzhuan/seedance-provider.mjs";
import { refreshSeedanceAssetReview, reviewSeedanceAsset } from "../server/wangzhuan/asset-review.mjs";

const execFileAsync = promisify(execFile);
const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const resumeDirArgIndex = process.argv.indexOf("--resume-dir");
const resumeDir = resumeDirArgIndex >= 0 ? resolve(process.argv[resumeDirArgIndex + 1] || "") : "";
const runId = resumeDir
  ? resumeDir.split("/").at(-1).replace(/^seedance-30s-real-/, "")
  : new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const outDir = resumeDir || resolve(rootDir, "tmp", `seedance-30s-real-${runId}`);
const resultPath = join(outDir, "result.json");

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

async function loadPreviousResult() {
  if (!resumeDir) return null;
  return JSON.parse(await readFile(resultPath, "utf8"));
}

function approvedReview(review = {}) {
  return Boolean(review.assetId && ["approved", "active", "success", "succeeded", "pass", "passed"].includes(String(review.status || "").toLowerCase()));
}

async function waitForAssetApproval(context, review, asset, result) {
  let current = review;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    if (approvedReview(current)) return current;
    if (["failed", "rejected"].includes(String(current.status || "").toLowerCase())) return current;
    await sleep(attempt === 1 ? 15_000 : 20_000);
    current = await refreshSeedanceAssetReview(context, {
      ...asset,
      assetId: current.assetId,
      status: current.status,
      contentUrl: current.contentUrl,
      reviewReason: current.reviewReason
    });
    result.events.push({
      at: now(),
      type: "asset_review_poll",
      attempt,
      assetId: current.assetId,
      status: current.status,
      approved: approvedReview(current)
    });
    result.continuity = {
      ...(result.continuity || {}),
      review: current
    };
    await saveResult(result);
    console.log(`[continuity] review poll ${attempt}: assetId=${current.assetId || ""} status=${current.status || ""}`);
  }
  return current;
}

async function pollUntilDone(provider, taskId, label, result) {
  for (let attempt = 1; attempt <= 90; attempt += 1) {
    await sleep(attempt === 1 ? 10_000 : 20_000);
    const polled = await provider.getTask(taskId);
    result.events.push({
      at: now(),
      type: "poll",
      label,
      attempt,
      taskId,
      status: polled.status,
      hasVideoUrl: Boolean(polled.videoUrl)
    });
    await saveResult(result);
    console.log(`[${label}] poll ${attempt}: ${polled.status}${polled.videoUrl ? " video_url=yes" : ""}`);
    if (polled.status === "succeeded") return polled;
    if (polled.status === "failed") {
      throw new Error(`${label} failed upstream`);
    }
  }
  throw new Error(`${label} timed out waiting for Seedance`);
}

async function downloadVideo(provider, videoUrl, target) {
  const buffer = await provider.downloadVideo(videoUrl);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, buffer);
  return { path: target, bytes: buffer.length };
}

async function extractTailFrame(videoPath, target) {
  await mkdir(dirname(target), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-sseof", "-0.2",
    "-i", videoPath,
    "-frames:v", "1",
    "-q:v", "2",
    target
  ], { timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return target;
}

async function stitchVideos(segmentPaths, target) {
  const listPath = join(dirname(target), "concat.txt");
  const list = segmentPaths.map((item) => `file '${item.replaceAll("'", "'\\''")}'`).join("\n");
  await writeFile(listPath, `${list}\n`);
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "concat",
    "-safe", "0",
    "-i", listPath,
    "-c", "copy",
    target
  ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return target;
}

async function probeDuration(videoPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    videoPath
  ], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  return Number(stdout.trim());
}

async function submitSegment(provider, payload, label, result) {
  result.events.push({
    at: now(),
    type: "submit_request",
    label,
    payload: {
      model: payload.model,
      mode: payload.mode,
      duration: payload.duration,
      ratio: payload.ratio,
      resolution: payload.resolution,
      generate_audio: payload.generate_audio,
      watermark: payload.watermark,
      contentCount: Array.isArray(payload.content) ? payload.content.length : 0,
      promptPreview: payload.prompt.slice(0, 260)
    }
  });
  await saveResult(result);
  const submitted = await provider.createTask(payload);
  result.events.push({
    at: now(),
    type: "submit_response",
    label,
    taskId: submitted.taskId,
    status: submitted.status
  });
  await saveResult(result);
  console.log(`[${label}] submitted taskId=${submitted.taskId}`);
  return submitted;
}

async function main() {
  const config = JSON.parse(await readFile(resolve(rootDir, "config.json"), "utf8"));
  const context = {
    config,
    userProjectRoot: rootDir,
    sharedProjectRoot: rootDir,
    user: { userId: "smoke", username: "smoke", role: "admin", isAdmin: true }
  };
  const provider = createSeedanceProviderClient(context);
  const previous = await loadPreviousResult();
  const result = previous || {
    runId,
    outDir,
    startedAt: now(),
    provider: {
      provider: provider.provider,
      endpoint: provider.endpoint,
      submitPath: provider.submitPath,
      taskPollPath: provider.taskPollPath,
      model: provider.model,
      ratio: provider.config?.ratio,
      resolution: provider.config?.resolution
    },
    events: []
  };
  await saveResult(result);

  const prompt1 = [
    "Vertical 9:16 Seedance video, first 15 seconds of a continuous 30-second ad-style storyboard.",
    "Scene: a compact neighborhood repair shop in Sao Paulo, morning light, tools on a metal bench, receipts pinned to a cork board, a phone on the counter.",
    "Subject: change the original character completely: use a Brazilian male bicycle mechanic in his late 20s, medium-brown skin, short curly black hair, green work shirt, dark apron, grease cloth and a cracked phone case.",
    "Action and rhythm: 0-5s he checks a stack of repair tickets and looks worried; 5-10s he wipes his hands and opens a practical local service app on the phone; 10-15s he reacts with cautious relief while the camera pushes toward the phone, ending on a clear phone-in-hand frame for continuity.",
    "Camera: handheld medium shot to close-up, realistic vertical short-video pacing, no final CTA, no ending card.",
    "Lighting/style/quality: natural shop light, grounded UGC realism, clear face and phone silhouette, all visible text in Portuguese, do not invent money amounts, payout tiers, guaranteed earnings, instant payment, or income promises."
  ].join(" ");

  const payload1 = buildSeedanceGenerationPayload({
    model: provider.model,
    prompt: prompt1,
    media: [],
    mode: "text_to_video",
    ratio: provider.config?.ratio || "9:16",
    duration: 15,
    resolution: provider.config?.resolution || "720p",
    generateAudio: provider.config?.generateAudio ?? true,
    watermark: provider.config?.watermark ?? false
  });

  const seg1Path = join(outDir, "segment_1.mp4");
  if (!result.segment1?.download?.path) {
    const submitted1 = await submitSegment(provider, payload1, "segment_1", result);
    const done1 = await pollUntilDone(provider, submitted1.taskId, "segment_1", result);
    result.segment1 = {
      taskId: submitted1.taskId,
      status: done1.status,
      videoUrlStored: Boolean(done1.videoUrl),
      download: await downloadVideo(provider, done1.videoUrl, seg1Path)
    };
    result.segment1.durationSec = await probeDuration(seg1Path);
    await saveResult(result);
  }

  const tailPath = join(outDir, "segment_1_tail.jpg");
  if (!result.continuity?.tailFramePath) {
    await extractTailFrame(result.segment1.download.path || seg1Path, tailPath);
  }
  const continuityAsset = {
    branchId: "real_smoke_branch",
    assetKey: "continuityFrame",
    fileName: "segment_1_tail.jpg",
    mimeType: "image/jpeg",
    buffer: await readFile(result.continuity?.tailFramePath || tailPath),
    storedPath: tailPath
  };
  let tailReview = result.continuity?.review;
  if (!tailReview?.assetId) {
    tailReview = await reviewSeedanceAsset(context, continuityAsset);
  }
  tailReview = await waitForAssetApproval(context, tailReview, continuityAsset, result);
  result.continuity = {
    tailFramePath: result.continuity?.tailFramePath || tailPath,
    review: tailReview
  };
  await saveResult(result);
  console.log(`[continuity] assetId=${tailReview.assetId || ""} status=${tailReview.status || ""}`);
  if (!approvedReview(tailReview)) {
    throw new Error(`continuity asset not approved: ${tailReview.status || "missing"}`);
  }

  const prompt2 = [
    "Vertical 9:16 Seedance video, second 15 seconds of the same continuous 30-second storyboard.",
    "Use the previous segment tail frame / continuity frame as the first-frame continuity reference. Continue naturally from the phone-in-hand frame, same new mechanic, same repair shop, same clothing and prop state.",
    "Scene: remain inside the compact Sao Paulo repair shop, then move from the bench to the open doorway with street light visible, keeping the environment coherent with segment 1.",
    "Subject: Brazilian male bicycle mechanic in late 20s, medium-brown skin, short curly black hair, green work shirt, dark apron, grease cloth and cracked phone case; do not change gender or identity within this variant.",
    "Action and rhythm: 15-20s he studies a simple task list on the phone; 20-25s he completes a lightweight check and sees a neutral progress feedback screen; 25-30s he relaxes, pockets the phone, and returns to the bicycle repair, ending on a natural work moment.",
    "Camera: start from the continuity frame, close-up on phone then medium shot, realistic handheld movement, no forced CTA, no ending card.",
    "Lighting/style/quality: natural UGC realism, readable Portuguese UI/subtitle text only, no invented money amounts, no payout tiers, no guaranteed earnings, no instant payment wording, no strong income promise."
  ].join(" ");

  const payload2 = buildSeedanceGenerationPayload({
    model: provider.model,
    prompt: prompt2,
    media: [{
      type: "image_asset",
      assetId: tailReview.assetId,
      assetKey: "continuityFrame",
      assetRole: "reference",
      storedPath: tailPath
    }],
    mode: "omni_reference",
    ratio: provider.config?.ratio || "9:16",
    duration: 15,
    resolution: provider.config?.resolution || "720p",
    generateAudio: provider.config?.generateAudio ?? true,
    watermark: provider.config?.watermark ?? false
  });

  const seg2Path = join(outDir, "segment_2.mp4");
  if (!result.segment2?.download?.path) {
    const submitted2 = await submitSegment(provider, payload2, "segment_2", result);
    const done2 = await pollUntilDone(provider, submitted2.taskId, "segment_2", result);
    result.segment2 = {
      taskId: submitted2.taskId,
      status: done2.status,
      videoUrlStored: Boolean(done2.videoUrl),
      download: await downloadVideo(provider, done2.videoUrl, seg2Path)
    };
    result.segment2.durationSec = await probeDuration(seg2Path);
    await saveResult(result);
  }

  const stitchedPath = join(outDir, "stitched_30s.mp4");
  await stitchVideos([seg1Path, seg2Path], stitchedPath);
  result.stitched = {
    path: stitchedPath,
    durationSec: await probeDuration(stitchedPath)
  };
  result.finishedAt = now();
  await saveResult(result);
  console.log(JSON.stringify({
    resultPath,
    segment1TaskId: result.segment1.taskId,
    segment2TaskId: result.segment2.taskId,
    continuityAssetId: tailReview.assetId,
    stitchedPath,
    stitchedDurationSec: result.stitched.durationSec
  }, null, 2));
}

main().catch(async (error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
