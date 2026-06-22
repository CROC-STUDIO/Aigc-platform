import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function writeMinimalMp4(target) {
  await mkdir(dirname(target), { recursive: true });
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=720x1280:d=1",
    "-t", "1",
    "-pix_fmt", "yuv420p",
    target
  ], { windowsHide: true });
}

export async function minimalMp4Buffer() {
  const dir = await mkdtemp(join(tmpdir(), "wz-mp4-"));
  const target = join(dir, "segment.mp4");
  try {
    await writeMinimalMp4(target);
    return await readFile(target);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function testSeedanceProviderClient(options = {}) {
  let videoBuffer = options.videoBuffer || null;
  return {
    provider: "seedance",
    model: "test-model",
    async createTask(_payload, meta) {
      return {
        taskId: `remote_${meta.generationTaskId}`,
        status: "queued",
        responsePayload: { id: `remote_${meta.generationTaskId}`, status: "queued" }
      };
    },
    async getTask(taskId) {
      return {
        taskId,
        status: "succeeded",
        videoUrl: `https://cdn.example.com/${taskId}.mp4`,
        responsePayload: { id: taskId, status: "succeeded" }
      };
    },
    async downloadVideo() {
      if (!videoBuffer) videoBuffer = await minimalMp4Buffer();
      return videoBuffer;
    }
  };
}

export async function prepareDownloadedSegmentsWithoutStitch(ctx, batchId) {
  const { syncBatchFacts, loadBatchDetailFromMysql } = await import("../../server/wangzhuan/mysql-facts.mjs");
  const { submitPendingGenerationTasks } = await import("../../server/wangzhuan/pipeline.mjs");
  const { toProjectRelative, wangzhuanPaths } = await import("../../server/wangzhuan/storage.mjs");
  await submitPendingGenerationTasks(ctx, batchId);
  const detail = await loadBatchDetailFromMysql(ctx, batchId);
  const batch = detail.batch;
  const segmentBuffer = await minimalMp4Buffer();
  const tasks = [];
  for (const task of batch.tasks) {
    const segmentTarget = join(wangzhuanPaths(ctx).batchesDir, batchId, "segments", `${task.generationTaskId}.mp4`);
    await mkdir(dirname(segmentTarget), { recursive: true });
    await writeFile(segmentTarget, segmentBuffer);
    tasks.push({
      ...task,
      status: task.status === "waiting_upstream" ? "downloaded" : task.status,
      outputPath: toProjectRelative(ctx.userProjectRoot, segmentTarget)
    });
  }
  await syncBatchFacts(ctx, {
    ...batch,
    status: batch.status === "running" ? "running" : batch.status,
    tasks
  }, "stitch_progress");
}
