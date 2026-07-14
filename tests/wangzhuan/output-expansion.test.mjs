import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildBlurPadFilter,
  buildExpandedOutputName,
  buildExpansionResultShape,
  ensureExpandableOutput,
  expansionTimeoutMs,
  expansionModeLabel,
  normalizeExpansionRequest,
  runOutputExpansion,
  renderExpandedVideo
} from "../../server/wangzhuan/output-expansion.mjs";

const execFileAsync = promisify(execFile);

async function ffmpegAvailable() {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

async function writeSampleVideo(target) {
  await execFileAsync("ffmpeg", [
    "-y",
    "-f", "lavfi",
    "-i", "color=c=black:s=720x1280:d=0.2",
    "-pix_fmt", "yuv420p",
    target
  ], {
    timeout: 20000,
    maxBuffer: 4 * 1024 * 1024
  });
}

test("normalizeExpansionRequest accepts preset and custom dimensions", () => {
  assert.deepEqual(
    normalizeExpansionRequest({ targetWidth: 800, targetHeight: 800, mode: "blur_pad" }),
    { targetWidth: 800, targetHeight: 800, mode: "blur_pad", presetKey: "800x800" }
  );
  assert.deepEqual(
    normalizeExpansionRequest({ targetWidth: 1080, targetHeight: 1920, mode: "blur_pad" }),
    { targetWidth: 1080, targetHeight: 1920, mode: "blur_pad", presetKey: "" }
  );
});

test("normalizeExpansionRequest rejects invalid dimensions", () => {
  assert.throws(
    () => normalizeExpansionRequest({ targetWidth: 0, targetHeight: 1920, mode: "blur_pad" }),
    /宽高需在 256-4096 像素之间/
  );
});

test("buildExpandedOutputName appends target size suffix", () => {
  assert.equal(buildExpandedOutputName("out_001.mp4", 800, 800), "out_001__800x800.mp4");
  assert.equal(buildExpandedOutputName("out_001", 1280, 720), "out_001__1280x720");
  assert.equal(
    buildExpandedOutputName("wzb_20260713124628_76b4_US_720x1280.mp4", 800, 800),
    "wzb_20260713124628_76b4_US_800x800.mp4"
  );
});

test("render timeout scales with long source duration", () => {
  assert.equal(expansionTimeoutMs(10), 120000);
  assert.equal(expansionTimeoutMs(64.393), 322000);
});

test("expansionModeLabel exposes only blur_pad in v1", () => {
  assert.equal(expansionModeLabel("blur_pad"), "原视频等比缩放，空白区域自动补高斯模糊背景");
});

test("buildBlurPadFilter keeps aspect ratio and blurs background", () => {
  const filter = buildBlurPadFilter(800, 800);
  assert.match(filter, /scale=800:800:force_original_aspect_ratio=decrease/);
  assert.match(filter, /gblur=/);
  assert.match(filter, /overlay=/);
});

test("buildExpansionResultShape includes preview and download metadata", () => {
  const result = buildExpansionResultShape({
    jobId: "expandjob_1",
    outputId: "out_1",
    targetWidth: 800,
    targetHeight: 800,
    fileName: "out_1__800x800.mp4",
    storedPath: "批处理记录/网赚管线/batches/wzb_x/results/out_1__800x800.mp4",
    previewUrl: "/file?path=abc",
    downloadUrl: "/file?path=abc"
  });
  assert.equal(result.status, "succeeded");
  assert.equal(result.sizeKey, "800x800");
  assert.equal(result.fileName, "out_1__800x800.mp4");
  assert.equal(result.previewUrl, "/file?path=abc");
});

test("ensureExpandableOutput allows video outputs even before downloadEligible", () => {
  const output = ensureExpandableOutput({
    outputId: "out_1",
    previewUrl: "/file?path=abc.mp4",
    filePath: "批处理记录/网赚管线/batches/wzb_x/out_1.mp4",
    downloadEligible: false
  });
  assert.equal(output.outputId, "out_1");
});

test("renderExpandedVideo writes a derived mp4 when ffmpeg is available", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "wz-expand-"));
  const inputPath = join(root, "source.mp4");
  try {
    await writeSampleVideo(inputPath);
    const result = await renderExpandedVideo({
      inputPath,
      targetWidth: 800,
      targetHeight: 800,
      outputDir: root
    });
    await access(result.outputPath);
    assert.equal(basename(result.outputPath), result.fileName);
    assert.match(result.fileName, /800x800/);
    assert.equal(result.width, 800);
    assert.equal(result.height, 800);
    assert.ok(result.durationSec > 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderExpandedVideo creates a missing derived output directory", async (t) => {
  if (!await ffmpegAvailable()) return t.skip("ffmpeg is unavailable");
  const root = await mkdtemp(join(tmpdir(), "wz-expand-missing-dir-"));
  try {
    const inputPath = join(root, "source.mp4");
    const outputDir = join(root, "expanded", "out_001");
    await writeSampleVideo(inputPath);
    const result = await renderExpandedVideo({
      inputPath,
      targetWidth: 800,
      targetHeight: 800,
      outputDir
    });
    await access(result.outputPath);
    assert.equal(result.outputPath, join(outputDir, "source__800x800.mp4"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("renderExpandedVideo rejects a non-decodable output even when ffmpeg leaves a non-empty file", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-expand-existing-output-"));
  const inputPath = join(root, "source.mp4");
  const binDir = join(root, "bin");
  const ffmpegPath = join(binDir, "ffmpeg");
  const originalPath = process.env.PATH || "";
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(binDir, { recursive: true });
    await writeFile(inputPath, Buffer.from("fake-input"));
    await writeFile(ffmpegPath, `#!/bin/sh
out=""
for last in "$@"; do out="$last"; done
printf 'generated-video' > "$out"
exit 1
`, "utf8");
    await chmod(ffmpegPath, 0o755);
    process.env.PATH = `${binDir}:${originalPath}`;
    await assert.rejects(() => renderExpandedVideo({
      inputPath,
      targetWidth: 800,
      targetHeight: 800,
      outputDir: root
    }));
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("runOutputExpansion falls back to remote source when local file is missing", async (t) => {
  if (!await ffmpegAvailable()) {
    t.skip("ffmpeg unavailable");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "wz-expand-remote-"));
  const localSource = join(root, "local-source.mp4");
  try {
    await writeSampleVideo(localSource);
    const sourceBuffer = await readFile(localSource);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(sourceBuffer, {
      status: 200,
      headers: { "Content-Type": "video/mp4" }
    });
    try {
      const result = await runOutputExpansion({
        userProjectRoot: root,
        currentProjectRoot: () => root,
        currentBaseProjectRoot: () => root,
        currentUserId: () => "tester"
      }, {
        outputId: "out_remote",
        fileName: "out_remote.mp4",
        filePath: "missing/out_remote.mp4",
        previewUrl: "https://example.com/out_remote.mp4",
        storageUrl: "https://example.com/out_remote.mp4"
      }, {
        targetWidth: 800,
        targetHeight: 800,
        mode: "blur_pad"
      });
      assert.equal(result.outputId, "out_remote");
      assert.match(result.fileName, /800x800/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
