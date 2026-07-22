import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { __stitchTestHooks } from "../../server/wangzhuan/stitch.mjs";

const execFileAsync = promisify(execFile);

async function ffmpegAvailable() {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    await execFileAsync("ffprobe", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function createTinyVideo(target) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=160x284:d=0.6:r=12",
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
    "-shortest",
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    target
  ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
}

async function createTinyOverlay(target) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=red@0.8:s=120x24",
    "-frames:v", "1",
    target
  ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
}

test("stitch applies segment subtitles before creating stitched outputs", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/stitch.mjs", import.meta.url), "utf8");
  const segmentSubtitleIndex = source.indexOf("applyVolcengineSubtitles(context, batch, outputId, target");
  const stitchOutputIndex = source.indexOf("async function createSucceededStitchOutput");
  const stitchedOutputSource = source.slice(stitchOutputIndex, source.indexOf("export async function materializeBatchSegmentOutputs", stitchOutputIndex));

  assert.ok(segmentSubtitleIndex >= 0, "segment ASR subtitle post-processing should be present");
  assert.ok(stitchOutputIndex > segmentSubtitleIndex, "segment subtitles must be applied before stitched output creation");
  assert.doesNotMatch(stitchedOutputSource, /applyVolcengineSubtitles/);
  assert.match(source, /"-vf", `ass=/);
  assert.match(source, /mode: "burned_in"/);
  assert.doesNotMatch(source, /subtitleScriptFromPlan|applyScriptSubtitles/);
});

test("stitch refreshes display names when existing segment outputs are reused", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/stitch.mjs", import.meta.url), "utf8");
  assert.match(source, /if \(existingOutput\) \{/);
  assert.match(source, /existingOutput\.displayFileName = buildOutputDisplayName/);
  assert.match(source, /existingOutput\.durationSec = Number\(entry\.task\.durationSec/);
});

test("stitching state writes use the explicit stitch_progress trigger", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/stitch.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /writeBatch\(context, \{ \.\.\.batch, status: "stitching" \}, "stitch_progress"\)/
  );
});

test("post-process ffmpeg timeout has a five minute floor and scales with duration", () => {
  assert.equal(__stitchTestHooks.postProcessTimeoutMs(0), 300000);
  assert.equal(__stitchTestHooks.postProcessTimeoutMs(20), 300000);
  assert.equal(__stitchTestHooks.postProcessTimeoutMs(45), 450000);
});

test("stitch report database fields truncate short varchar values only at persistence", async () => {
  const factsSource = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const stitchSource = await readFile(new URL("../../server/wangzhuan/stitch.mjs", import.meta.url), "utf8");

  assert.match(factsSource, /function varcharValue\(value, maxLength\)/);
  assert.match(factsSource, /varcharValue\(report\.errorMessage, 512\)/);
  assert.match(factsSource, /varcharValue\(report\.commandSummary, 512\)/);
  assert.match(stitchSource, /errorMessage: safeErrorMessage\(error\)/);
  assert.doesNotMatch(stitchSource, /safeErrorMessage\(error\)\.slice/);
});

test("concat then disclaimer overlay stays decodable (two-phase stitch)", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg/ffprobe not available");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "wz-stitch-two-phase-"));
  try {
    const dir = join(root, "media");
    await mkdir(dir, { recursive: true });
    const seg1 = join(dir, "seg1.mp4");
    const seg2 = join(dir, "seg2.mp4");
    const overlay = join(dir, "overlay.png");
    const concatOut = join(dir, "concat.mp4");
    await createTinyVideo(seg1);
    await createTinyVideo(seg2);
    await createTinyOverlay(overlay);

    await __stitchTestHooks.concatSegmentVideos(concatOut, [seg1, seg2], { timeoutMs: 30000 });
    await __stitchTestHooks.assertDecodableVideo(concatOut, { timeoutMs: 30000 });

    const context = { userProjectRoot: root, sharedProjectRoot: root, userId: "test" };
    await __stitchTestHooks.applyDisclaimerOverlay(context, concatOut, concatOut, {
      applied: true,
      imageStoredPath: "media/overlay.png",
      boxHeight: 24,
      horizontalMargin: 10,
      bottomMargin: 2
    }, { timeoutMs: 30000 });

    const health = await __stitchTestHooks.assertDecodableVideo(concatOut, { timeoutMs: 30000 });
    assert.ok(health.durationSec > 0);
    assert.notEqual(health.profile, "unknown");
    assert.notEqual(health.pixFmt, "unknown");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concat and disclaimer overlay stay decodable in one encode pass", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg/ffprobe not available");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "wz-stitch-one-pass-"));
  try {
    const dir = join(root, "media");
    await mkdir(dir, { recursive: true });
    const seg1 = join(dir, "seg1.mp4");
    const seg2 = join(dir, "seg2.mp4");
    const overlay = join(dir, "overlay.png");
    const output = join(dir, "stitched.mp4");
    await createTinyVideo(seg1);
    await createTinyVideo(seg2);
    await createTinyOverlay(overlay);

    await __stitchTestHooks.concatSegmentVideos(output, [seg1, seg2], {
      canvas: { width: 160, height: 284 },
      overlay: { imagePath: overlay, boxHeight: 24, horizontalMargin: 10, bottomMargin: 2 },
      timeoutMs: 30000
    });
    const health = await __stitchTestHooks.assertDecodableVideo(output, { timeoutMs: 30000 });
    assert.equal(health.width, 160);
    assert.equal(health.height, 284);
    assert.ok(health.durationSec > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("assertDecodableVideo rejects corrupt stitched payloads", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg/ffprobe not available");
    return;
  }
  const corruptSource = "/tmp/wz-video-inspect/out_d33e_016.mp4";
  let hasCorrupt = false;
  try {
    await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", corruptSource], {
      timeout: 5000
    });
    hasCorrupt = true;
  } catch {
    hasCorrupt = false;
  }
  if (!hasCorrupt) {
    t.skip("corrupt sample not available locally");
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "wz-stitch-corrupt-"));
  try {
    const sample = join(root, "corrupt.mp4");
    await copyFile(corruptSource, sample);
    await assert.rejects(
      () => __stitchTestHooks.assertDecodableVideo(sample, { timeoutMs: 60000 }),
      (error) => {
        assert.equal(error?.code, "stitch_failed");
        return true;
      }
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
