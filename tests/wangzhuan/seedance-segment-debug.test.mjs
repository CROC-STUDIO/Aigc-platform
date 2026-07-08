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

test("parseDebugCliArgs rejects output paths outside cwd", () => {
  assert.throws(
    () => parseDebugCliArgs([
      "--video", "/videos/source.mp4",
      "--out", "../../outside"
    ], { cwd: "/repo/project" }),
    /--out 必须位于当前工作目录内/
  );
});

test("parseDebugCliArgs rejects truth-rules paths outside cwd", () => {
  assert.throws(
    () => parseDebugCliArgs([
      "--video", "/videos/source.mp4",
      "--truth-rules-json", "../../truth.json"
    ], { cwd: "/repo/project" }),
    /--truth-rules-json 必须位于当前工作目录内/
  );
});

test("parseDebugCliArgs allows explicit internal override for paths outside cwd", () => {
  const parsed = parseDebugCliArgs([
    "--video", "/videos/source.mp4",
    "--out", "../../outside",
    "--truth-rules-json", "../../truth.json"
  ], { cwd: "/repo/project", allowOutsideWorkspace: true });

  assert.equal(parsed.outputDir, resolve("/repo/project", "../../outside"));
  assert.equal(parsed.truthRulesPath, resolve("/repo/project", "../../truth.json"));
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

test("splitStorySegmentIntoSlices rejects durations over two Seedance slices", () => {
  assert.throws(
    () => splitStorySegmentIntoSlices({
      storySegmentIndex: 1,
      startSec: 0,
      endSec: 40,
      durationSec: 40
    }, { maxSliceSec: 15 }),
    /storySegmentIndex=1 时长超过两段 Seedance slice 上限/
  );
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
