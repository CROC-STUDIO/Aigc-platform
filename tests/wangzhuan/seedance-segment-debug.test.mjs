import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
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

test("parseDebugCliArgs normalizes defaults and optional fields", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "seedance-debug-defaults-"));
  const parsed = parseDebugCliArgs([
    "--video", "./fixtures/source.mp4",
    "--out", "tmp/debug-run",
    "--language", "pt-BR",
    "--region", "BR",
    "--product-name", "Drama Gold",
    "--currency-symbol", "R$"
  ], { cwd });

  assert.equal(parsed.videoPath, resolve(cwd, "./fixtures/source.mp4"));
  assert.equal(parsed.outputDir, resolve(cwd, "tmp/debug-run"));
  assert.equal(parsed.language, "pt-BR");
  assert.equal(parsed.region, "BR");
  assert.equal(parsed.productName, "Drama Gold");
  assert.equal(parsed.currencySymbol, "R$");
  assert.equal(parsed.minSliceSec, 8);
  assert.equal(parsed.maxSliceSec, 15);
});

test("parseDebugCliArgs rejects output paths outside cwd", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "seedance-debug-outside-"));
  assert.throws(
    () => parseDebugCliArgs([
      "--video", "/videos/source.mp4",
      "--out", "../../outside"
    ], { cwd }),
    /--out 必须位于当前工作目录内/
  );
});

test("parseDebugCliArgs rejects truth-rules paths outside cwd", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-truth-outside-"));
  const cwd = join(root, "workspace");
  const outside = join(root, "truth.json");
  await mkdir(cwd);
  await writeFile(outside, "{}\n");

  assert.throws(
    () => parseDebugCliArgs([
      "--video", "/videos/source.mp4",
      "--truth-rules-json", "../truth.json"
    ], { cwd }),
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

test("parseDebugCliArgs rejects output paths through symlinked parents", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-paths-"));
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await symlink(outside, join(cwd, "link-out"));

  assert.throws(
    () => parseDebugCliArgs([
      "--video", "/videos/source.mp4",
      "--out", "link-out/run"
    ], { cwd }),
    /--out 必须位于当前工作目录内/
  );
});

test("parseDebugCliArgs rejects truth-rules paths through symlinks", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-truth-"));
  const cwd = join(root, "workspace");
  const outside = join(root, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  await writeFile(join(outside, "truth.json"), "{}\n");
  await symlink(join(outside, "truth.json"), join(cwd, "truth-link.json"));

  assert.throws(
    () => parseDebugCliArgs([
      "--video", "/videos/source.mp4",
      "--truth-rules-json", "truth-link.json"
    ], { cwd }),
    /--truth-rules-json 必须位于当前工作目录内/
  );
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
