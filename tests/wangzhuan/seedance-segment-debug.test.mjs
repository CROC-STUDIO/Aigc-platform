import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildSeedanceSlices,
  parseDebugCliArgs,
  renderSeedancePromptsMarkdown,
  splitStorySegmentIntoSlices,
  writeDebugOutputs
} from "../../server/wangzhuan/seedance-segment-debug.mjs";

test("parseDebugCliArgs requires a local video path", () => {
  assert.throws(
    () => parseDebugCliArgs([]),
    /--video 必填/
  );
});

test("parseDebugCliArgs normalizes defaults and optional fields", () => {
  const parsed = parseDebugCliArgs([
    "--video", "./fixtures/source.mp4",
    "--out", "tmp/debug-run",
    "--language", "pt-BR",
    "--region", "BR",
    "--product-name", "Drama Gold",
    "--currency-symbol", "R$"
  ], { cwd: "/repo" });

  assert.equal(parsed.videoPath, resolve("/repo", "./fixtures/source.mp4"));
  assert.equal(parsed.outputDir, resolve("/repo", "tmp/debug-run"));
  assert.equal(parsed.language, "pt-BR");
  assert.equal(parsed.region, "BR");
  assert.equal(parsed.productName, "Drama Gold");
  assert.equal(parsed.currencySymbol, "R$");
  assert.equal(parsed.minSliceSec, 8);
  assert.equal(parsed.maxSliceSec, 15);
});

test("splitStorySegmentIntoSlices keeps short story segment as one slice", () => {
  assert.deepEqual(splitStorySegmentIntoSlices({
    storySegmentIndex: 1,
    startSec: 0,
    endSec: 12,
    durationSec: 12
  }), [
    {
      storySegmentIndex: 1,
      seedanceSliceIndex: 1,
      startSec: 0,
      endSec: 12,
      durationSec: 12
    }
  ]);
});

test("splitStorySegmentIntoSlices splits 16s story segment into two 8s slices", () => {
  assert.deepEqual(splitStorySegmentIntoSlices({
    storySegmentIndex: 2,
    startSec: 12,
    endSec: 28,
    durationSec: 16
  }), [
    {
      storySegmentIndex: 2,
      seedanceSliceIndex: 1,
      startSec: 12,
      endSec: 20,
      durationSec: 8
    },
    {
      storySegmentIndex: 2,
      seedanceSliceIndex: 2,
      startSec: 20,
      endSec: 28,
      durationSec: 8
    }
  ]);
});
