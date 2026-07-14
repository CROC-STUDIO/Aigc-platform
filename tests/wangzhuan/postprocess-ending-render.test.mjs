import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import test from "node:test";

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

async function createImage(target) {
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=green:s=120x80", "-frames:v", "1", target
  ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
}

async function createSilentVideo(target) {
  await execFileAsync("ffmpeg", [
    "-y", "-f", "lavfi", "-i", "color=c=blue:s=120x80:d=0.8:r=12",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", target
  ], { timeout: 30000, maxBuffer: 10 * 1024 * 1024 });
}

async function probeStreams(target) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "stream=codec_type,width,height", "-show_entries", "format=duration", "-of", "json", target
  ], { encoding: "utf8", timeout: 10000 });
  return JSON.parse(stdout);
}

test("image post-process Ending becomes a one-second canvas-matched video with silent audio", async (t) => {
  if (!await ffmpegAvailable()) return t.skip("ffmpeg/ffprobe not available");
  const root = await mkdtemp(join(tmpdir(), "wz-ending-image-"));
  try {
    await mkdir(join(root, "assets"), { recursive: true });
    const source = join(root, "assets", "ending.png");
    await createImage(source);
    const result = await __stitchTestHooks.createPostProcessEndingVideo({ userProjectRoot: root, sharedProjectRoot: root, userId: "test" }, "wzb_20260713121212_abcd", "out_abcd_001", {
      fileName: "ending.png",
      mediaType: "image",
      storedPath: "assets/ending.png",
      imageDurationSec: 1
    }, { width: 160, height: 284 }, { timeoutMs: 30000 });

    const probe = await probeStreams(result.fullPath);
    const video = probe.streams.find((stream) => stream.codec_type === "video");
    assert.equal(video.width, 160);
    assert.equal(video.height, 284);
    assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
    assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.12);
    assert.equal(result.durationSec, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("silent video post-process Ending preserves duration and gains normalized audio", async (t) => {
  if (!await ffmpegAvailable()) return t.skip("ffmpeg/ffprobe not available");
  const root = await mkdtemp(join(tmpdir(), "wz-ending-video-"));
  try {
    await mkdir(join(root, "assets"), { recursive: true });
    const source = join(root, "assets", "ending.mp4");
    await createSilentVideo(source);
    const result = await __stitchTestHooks.createPostProcessEndingVideo({ userProjectRoot: root, sharedProjectRoot: root, userId: "test" }, "wzb_20260713121212_abcd", "out_abcd_001", {
      fileName: "ending.mp4",
      mediaType: "video",
      storedPath: "assets/ending.mp4"
    }, { width: 160, height: 284 }, { timeoutMs: 30000 });

    const probe = await probeStreams(result.fullPath);
    assert.ok(probe.streams.some((stream) => stream.codec_type === "audio"));
    assert.ok(Math.abs(Number(probe.format.duration) - 0.8) < 0.15);
    assert.ok(Math.abs(result.durationSec - 0.8) < 0.15);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
