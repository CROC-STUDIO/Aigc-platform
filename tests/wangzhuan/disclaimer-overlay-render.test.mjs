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

test("Arabic built-in disclaimer template is transparent and renders through the overlay path", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "wz-disclaimer-arabic-"));
  const context = {
    userProjectRoot: root,
    sharedProjectRoot: root,
    userId: "test"
  };
  const videoPath = join(root, "source.mp4");
  const targetPath = join(root, "target.mp4");
  try {
    const overlay = {
      applied: true,
      language: "ar-SA",
      templateId: "auto",
      position: "bottom_center",
      boxHeight: 88,
      bottomMargin: 3,
      horizontalMargin: 50
    };
    const imagePath = __stitchTestHooks.resolveDisclaimerOverlayImagePath(context, overlay);
    assert.match(imagePath, /[/\\]public[/\\]assets[/\\]wangzhuan[/\\]disclaimers[/\\]ar\.png$/);
    assert.equal(existsSync(imagePath), true);

    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,pix_fmt",
      "-of", "json",
      imagePath
    ], {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    const stream = JSON.parse(stdout).streams?.[0] || {};
    assert.deepEqual(
      { width: stream.width, height: stream.height, pixFmt: stream.pix_fmt },
      { width: 720, height: 88, pixFmt: "rgba" }
    );

    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=black:s=720x1280:d=0.2",
      "-pix_fmt", "yuv420p",
      videoPath
    ], {
      timeout: 20000,
      maxBuffer: 4 * 1024 * 1024
    });

    const result = await __stitchTestHooks.applyDisclaimerOverlay(
      context,
      videoPath,
      targetPath,
      overlay
    );

    assert.equal(result.applied, true);
    assert.equal(result.imagePath, imagePath);
    assert.equal(existsSync(targetPath), true);
    const health = await __stitchTestHooks.assertDecodableVideo(targetPath);
    assert.equal(health.width, 720);
    assert.equal(health.height, 1280);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("common-language built-in disclaimer templates are transparent 720x88 PNGs", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg unavailable");
    return;
  }
  const context = {
    userProjectRoot: process.cwd(),
    sharedProjectRoot: process.cwd(),
    userId: "test"
  };
  const locales = ["es-MX", "fr-FR", "de-DE", "id-ID", "th-TH", "vi-VN"];

  for (const language of locales) {
    const preset = language.split("-")[0];
    const imagePath = __stitchTestHooks.resolveDisclaimerOverlayImagePath(context, {
      applied: true,
      language,
      templateId: "auto"
    });
    assert.match(imagePath, new RegExp(`[/\\\\]${preset}\\.png$`), language);
    assert.equal(existsSync(imagePath), true, language);
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,pix_fmt",
      "-of", "json",
      imagePath
    ], {
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    const stream = JSON.parse(stdout).streams?.[0] || {};
    assert.deepEqual(
      { width: stream.width, height: stream.height, pixFmt: stream.pix_fmt },
      { width: 720, height: 88, pixFmt: "rgba" },
      language
    );

    const { stdout: pixels } = await execFileAsync("ffmpeg", [
      "-v", "error",
      "-i", imagePath,
      "-frames:v", "1",
      "-f", "rawvideo",
      "-pix_fmt", "rgba",
      "pipe:1"
    ], {
      encoding: "buffer",
      timeout: 10000,
      maxBuffer: 1024 * 1024
    });
    let hasTransparentPixel = false;
    let hasOpaquePixel = false;
    for (let offset = 3; offset < pixels.length; offset += 4) {
      hasTransparentPixel ||= pixels[offset] === 0;
      hasOpaquePixel ||= pixels[offset] === 255;
      if (hasTransparentPixel && hasOpaquePixel) break;
    }
    assert.equal(hasTransparentPixel, true, `${language} must have a transparent background`);
    assert.equal(hasOpaquePixel, true, `${language} must have visible text`);
  }
});
