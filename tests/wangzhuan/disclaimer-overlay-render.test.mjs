import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { __stitchTestHooks } from "../../server/wangzhuan/stitch.mjs";

const execFileAsync = promisify(execFile);

async function ffmpegAvailable() {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

test("disclaimer overlay uses source video width instead of hardcoded 720", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "wz-disclaimer-width-"));
  const videoPath = join(root, "source.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=360x640:d=0.2",
      "-pix_fmt", "yuv420p",
      videoPath
    ], {
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024
    });

    const width = await __stitchTestHooks.probeVideoWidth(videoPath);

    assert.equal(width, 360);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disclaimer overlay applies a prepared transparent png without text rendering", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "wz-disclaimer-image-"));
  const context = {
    userProjectRoot: root,
    sharedProjectRoot: root,
    userId: "test"
  };
  const videoPath = join(root, "source.mp4");
  const targetPath = join(root, "target.mp4");
  const overlayDir = join(root, "批处理记录", "网赚管线", "disclaimer-overlays");
  const overlayPath = join(overlayDir, "overlay.png");
  try {
    await mkdir(overlayDir, { recursive: true });
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=360x640:d=0.2",
      "-pix_fmt", "yuv420p",
      videoPath
    ], {
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024
    });
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=white@1:s=720x88:d=0.1",
      "-frames:v", "1",
      overlayPath
    ], {
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024
    });

    const result = await __stitchTestHooks.applyDisclaimerOverlay(context, videoPath, targetPath, {
      applied: true,
      imageStoredPath: "批处理记录/网赚管线/disclaimer-overlays/overlay.png",
      position: "bottom_center",
      boxHeight: 44,
      bottomMargin: 3,
      horizontalMargin: 20
    });

    assert.equal(result.applied, true);
    assert.equal(existsSync(targetPath), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
