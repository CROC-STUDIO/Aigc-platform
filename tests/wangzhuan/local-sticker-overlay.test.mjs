import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildStickerFilter,
  normalizeLocalStickerRequest,
  normalizedRegionToPixels,
  renderLocalStickerVideo,
  scaledStickerSize
} from "../../server/wangzhuan/local-sticker-overlay.mjs";

const execFileAsync = promisify(execFile);

test("normalizes a delogo-only local sticker request", () => {
  const request = normalizeLocalStickerRequest({
    job_type: "local_sticker_overlay",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: {
      region_spec: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, coordinate_space: "normalized" }],
      sticker_scale_mode: "short_side"
    }
  });
  assert.equal(request.hasSticker, false);
  assert.equal(request.stickerScaleMode, "short_side");
  assert.deepEqual(request.region, { x: 0.1, y: 0.2, width: 0.3, height: 0.4 });
});

test("rejects unsupported sticker content", () => {
  assert.throws(() => normalizeLocalStickerRequest({
    job_type: "local_sticker_overlay",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: {
      region_spec: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, coordinate_space: "normalized" }],
      sticker_source_type: "base64_data_url",
      sticker_source: "data:image/svg+xml;base64,AAAA"
    }
  }), /PNG、JPG 或 WebP/);
});

test("converts normalized regions and scale modes without cropping the sticker", () => {
  assert.deepEqual(normalizedRegionToPixels({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }, 640, 360), {
    x: 64, y: 72, width: 192, height: 144
  });
  assert.deepEqual(scaledStickerSize({ width: 300, height: 100 }, { width: 192, height: 144 }, "short_side"), {
    width: 432, height: 144
  });
  assert.deepEqual(scaledStickerSize({ width: 300, height: 100 }, { width: 192, height: 144 }, "long_side"), {
    width: 192, height: 64
  });
});

test("builds delogo first and centers an uncropped optional sticker", () => {
  assert.equal(buildStickerFilter({ region: { x: 10, y: 20, width: 100, height: 80 } }),
    "[0:v]delogo=x=10:y=20:w=100:h=80:show=0,format=yuv420p[v]");
  assert.match(buildStickerFilter({
    region: { x: 10, y: 20, width: 100, height: 80 },
    sticker: { width: 180, height: 80 }
  }), /^\[0:v\]delogo=.*\[clean\];\[1:v\]scale=180:80\[sticker\];\[clean\]\[sticker\]overlay=-30:20/);
});

test("renders delogo-only and sticker-overlay videos with audio", async (t) => {
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5000 });
  } catch {
    return t.skip("ffmpeg unavailable");
  }
  const root = await mkdtemp(join(tmpdir(), "sticker-overlay-test-"));
  const source = join(root, "source.mp4");
  const sticker = join(root, "sticker.png");
  try {
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=blue:s=320x240:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", source], { timeout: 30000 });
    await execFileAsync("ffmpeg", ["-y", "-f", "lavfi", "-i", "color=c=red@0.8:s=80x40", "-frames:v", "1", sticker], { timeout: 30000 });

    const delogo = await renderLocalStickerVideo({ inputPath: source, outputPath: join(root, "delogo.mp4"), region: { x: 32, y: 24, width: 96, height: 72 } });
    const overlay = await renderLocalStickerVideo({ inputPath: source, stickerPath: sticker, outputPath: join(root, "overlay.mp4"), region: { x: 32, y: 24, width: 96, height: 72 }, stickerScaleMode: "short_side" });
    assert.equal(delogo.width, 320);
    assert.equal(overlay.height, 240);
    assert.ok((await readFile(delogo.outputPath)).length > 1024);
    assert.ok((await readFile(overlay.outputPath)).length > 1024);
    assert.equal(delogo.hasAudio, true);
    assert.equal(overlay.hasAudio, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
