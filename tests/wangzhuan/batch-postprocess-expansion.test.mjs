import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { __stitchTestHooks } from "../../server/wangzhuan/stitch.mjs";

test("batch expansion retains the original, skips its canvas size and links successful derivatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-batch-expand-"));
  try {
    const source = join(root, "stitched", "original.mp4");
    await mkdir(join(root, "stitched"), { recursive: true });
    await writeFile(source, "original-video", "utf8");
    const calls = [];
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      userId: "test",
      renderExpandedVideo: async ({ targetWidth, targetHeight, outputDir, outputFileName, timeoutMs }) => {
        calls.push({ sizeKey: `${targetWidth}x${targetHeight}`, outputFileName, timeoutMs });
        await mkdir(outputDir, { recursive: true });
        const outputPath = join(outputDir, outputFileName);
        await writeFile(outputPath, "expanded-video", "utf8");
        return { outputPath, fileName: outputFileName, width: targetWidth, height: targetHeight, durationSec: 24 };
      },
      syncWangzhuanAsset: async ({ assetKind }) => ({ storageKey: `mock/${assetKind}.mp4`, storageUrl: `https://cdn.test/${assetKind}.mp4` })
    };
    const batch = {
      batchId: "wzb_20260713121212_abcd",
      request: {
        postProcess: {
          expansionSizes: [
            { targetWidth: 720, targetHeight: 1280 },
            { targetWidth: 800, targetHeight: 800 },
            { targetWidth: 1280, targetHeight: 720 }
          ]
        }
      }
    };
    const original = {
      outputId: "out_abcd_001",
      batchId: batch.batchId,
      kind: "stitched_video",
      filePath: "stitched/original.mp4",
      displayFileName: "original.mp4",
      durationSec: 24,
      generationTaskIds: ["gen_1"]
    };
    const sequenceState = { next: 2 };
    const result = await __stitchTestHooks.deriveExpandedOutputs(context, batch, original, sequenceState, {
      sourceHealth: { width: 720, height: 1280, durationSec: 64.393 }
    });

    assert.deepEqual(calls.map((item) => item.sizeKey).sort(), ["1280x720", "800x800"]);
    assert.equal(result.outputs.length, 2);
    assert.deepEqual(result.outputs.map((item) => item.kind), ["expanded_video", "expanded_video"]);
    assert.deepEqual(result.outputs.map((item) => item.parentOutputId), [original.outputId, original.outputId]);
    assert.deepEqual(result.outputs.map((item) => item.sizeKey).sort(), ["1280x720", "800x800"]);
    assert.ok(calls.every((item) => item.outputFileName.includes(`__${item.sizeKey}.mp4`)));
    assert.ok(calls.every((item) => item.timeoutMs === 322000));
    assert.deepEqual(result.failures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("one expansion failure is reported without invalidating successful derivatives", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-batch-expand-fail-"));
  try {
    await mkdir(join(root, "stitched"), { recursive: true });
    await writeFile(join(root, "stitched", "original.mp4"), "original-video", "utf8");
    const context = {
      userProjectRoot: root,
      sharedProjectRoot: root,
      userId: "test",
      renderExpandedVideo: async ({ targetWidth, targetHeight, outputDir, outputFileName }) => {
        if (targetWidth === 1280) throw new Error("render failed");
        await mkdir(outputDir, { recursive: true });
        const outputPath = join(outputDir, outputFileName);
        await writeFile(outputPath, "expanded-video", "utf8");
        return { outputPath, fileName: outputFileName, width: targetWidth, height: targetHeight, durationSec: 24 };
      },
      syncWangzhuanAsset: async () => ({ storageKey: "mock/output.mp4", storageUrl: "https://cdn.test/output.mp4" })
    };
    const batch = {
      batchId: "wzb_20260713121212_abcd",
      request: { postProcess: { expansionSizes: [{ targetWidth: 800, targetHeight: 800 }, { targetWidth: 1280, targetHeight: 720 }] } }
    };
    const original = {
      outputId: "out_abcd_001",
      batchId: batch.batchId,
      kind: "stitched_video",
      filePath: "stitched/original.mp4",
      displayFileName: "original.mp4",
      durationSec: 24,
      generationTaskIds: ["gen_1"]
    };
    const result = await __stitchTestHooks.deriveExpandedOutputs(context, batch, original, { next: 2 }, {
      sourceHealth: { width: 720, height: 1280, durationSec: 24 }
    });

    assert.equal(result.outputs.length, 1);
    assert.equal(result.outputs[0].sizeKey, "800x800");
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].sizeKey, "1280x720");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
