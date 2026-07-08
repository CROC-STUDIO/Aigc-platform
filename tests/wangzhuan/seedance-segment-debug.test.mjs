import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  buildSegmentAnalysisMessages,
  buildSeedanceSlices,
  normalizeStorySegments,
  parseDebugCliArgs,
  renderSeedancePromptsMarkdown,
  runSeedanceSegmentDebugCli,
  splitStorySegmentIntoSlices,
  writeDebugOutputs
} from "../../server/wangzhuan/seedance-segment-debug.mjs";

const execFileAsync = promisify(execFile);

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

test("buildSeedanceSlices preserves seven dimensions and subtitle workflow", () => {
  const slices = buildSeedanceSlices([
    {
      storySegmentIndex: 1,
      startSec: 0,
      endSec: 16,
      durationSec: 16,
      scene: "bus stop",
      subject: "commuter holding phone",
      action: "checks drama reward task",
      camera: "handheld close-up then reaction",
      lighting: "natural daylight",
      style: "UGC short-drama ad",
      quality: "realistic 720p vertical video",
      coreHook: "missed bus turns into earning discovery",
      explosivePoint: "reward number keeps rising during drama clip",
      moneyEffects: ["reward_number_growth", "cash_rain"],
      subtitles: ["Watch clips", "See reward feedback"]
    }
  ]);

  assert.equal(slices.length, 2);
  assert.equal(slices[0].durationSec, 8);
  assert.equal(slices[1].durationSec, 8);
  assert.equal(slices[0].scene, "bus stop");
  assert.equal(slices[0].subject, "commuter holding phone");
  assert.equal(slices[0].quality, "realistic 720p vertical video");
  assert.equal(slices[0].coreHook, "missed bus turns into earning discovery");
  assert.deepEqual(slices[0].moneyEffects, ["reward_number_growth", "cash_rain"]);
  assert.equal(slices[0].subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(slices[0].subtitleWorkflow.postSubtitleRequired, true);
  assert.deepEqual(slices[0].subtitleWorkflow.subtitleScript, ["Watch clips", "See reward feedback"]);
});

test("buildSeedanceSlices uses proof role for the second slice when total is two", () => {
  const slices = buildSeedanceSlices([
    {
      storySegmentIndex: 1,
      startSec: 0,
      endSec: 16,
      durationSec: 16,
      scene: "bus stop",
      subject: "commuter holding phone",
      action: "checks drama reward task",
      camera: "handheld close-up then reaction",
      lighting: "natural daylight",
      style: "UGC short-drama ad",
      quality: "realistic 720p vertical video"
    }
  ]);

  assert.deepEqual(slices.map((slice) => slice.segmentRole), ["hook_slice", "proof_slice"]);
});

test("renderSeedancePromptsMarkdown includes duration, dimensions, prompts, and subtitle script", () => {
  const markdown = renderSeedancePromptsMarkdown({
    slices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 8,
        durationSec: 8,
        segmentRole: "hook_slice",
        scene: "bus stop",
        subject: "commuter holding phone",
        action: "checks drama reward task",
        camera: "handheld close-up",
        lighting: "daylight",
        style: "UGC",
        quality: "realistic vertical",
        coreHook: "missed bus discovery",
        explosivePoint: "reward number rises",
        moneyEffects: ["reward_number_growth"],
        imagePrompt: "Brazilian commuter at a bus stop holding a phone.",
        seedancePrompt: "0-8s: handheld UGC scene, no burned subtitles.",
        negativePrompt: "No watermark.",
        subtitleWorkflow: { subtitleScript: ["Watch and check rewards"] }
      }
    ]
  });

  assert.match(markdown, /durationSec: 8/);
  assert.match(markdown, /scene: bus stop/);
  assert.match(markdown, /quality: realistic vertical/);
  assert.match(markdown, /### imagePrompt/);
  assert.match(markdown, /### seedancePrompt/);
  assert.match(markdown, /Watch and check rewards/);
});

test("writeDebugOutputs writes analysis, plan, and markdown files", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-"));
  const paths = await writeDebugOutputs(root, {
    analysis: { sourceVideo: { durationSec: 16 }, storySegments: [] },
    plan: { slices: [{ storySegmentIndex: 1, seedanceSliceIndex: 1, durationSec: 8 }] }
  });

  await stat(paths.analysisPath);
  await stat(paths.planPath);
  await stat(paths.promptsPath);
  assert.match(await readFile(paths.analysisPath, "utf8"), /"durationSec": 16/);
  assert.match(await readFile(paths.planPath, "utf8"), /"slices"/);
  assert.match(await readFile(paths.promptsPath, "utf8"), /Seedance Segment Debug Prompts/);
});

test("normalizeStorySegments requires the seven dimensions", () => {
  assert.throws(
    () => normalizeStorySegments({ storySegments: [{ startSec: 0, endSec: 8, scene: "street" }] }),
    /subject 缺失/
  );
});

test("normalizeStorySegments chains missing timing from the prior normalized segment", () => {
  const segments = normalizeStorySegments({
    storySegments: [
      {
        startSec: 0,
        durationSec: 8,
        scene: "bus stop",
        subject: "commuter holding phone",
        action: "checks drama reward task",
        camera: "handheld close-up",
        lighting: "daylight",
        style: "UGC",
        quality: "realistic vertical"
      },
      {
        durationSec: 8,
        scene: "street corner",
        subject: "commuter watching drama",
        action: "sees reward feedback",
        camera: "phone screen insert",
        lighting: "daylight",
        style: "UGC",
        quality: "realistic vertical"
      }
    ]
  });

  assert.equal(segments[1].startSec, 8);
  assert.equal(segments[1].endSec, 16);
});

test("buildSegmentAnalysisMessages encodes segment and money-effect rules", () => {
  const messages = buildSegmentAnalysisMessages({
    videoPath: "/tmp/ref.mp4",
    durationSec: 16,
    language: "pt-BR",
    region: "BR",
    productName: "Drama Gold",
    currencySymbol: "R$",
    sceneCutsSec: [4, 9],
    frames: [{ index: 1, timestampSec: 0.25 }]
  });
  const text = messages.map((message) => message.content).join("\n");

  assert.match(text, /scene, subject, action, camera, lighting, style, quality/);
  assert.match(text, /Scene cuts are hints, not authoritative boundaries/);
  assert.match(text, /reward_number_growth/);
  assert.match(text, /no burned subtitles/i);
  assert.match(text, /Do not invent exact payout amounts/);
});

test("runSeedanceSegmentDebugCli writes outputs using injected analysis dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-run-"));
  const videoPath = join(root, "reference.mp4");
  await writeFile(videoPath, "fake video bytes");

  const result = await runSeedanceSegmentDebugCli({
    videoPath,
    outputDir: join(root, "out"),
    language: "pt-BR",
    region: "BR",
    productName: "Drama Gold",
    currencySymbol: "R$",
    minSliceSec: 8,
    maxSliceSec: 15,
    dependencies: {
      probeVideo: async () => ({ durationSec: 16, width: 720, height: 1280, ratio: "9:16" }),
      detectScenes: async () => [4, 9],
      extractFrames: async () => [{ index: 1, timestampSec: 0.25, dataUrl: "data:image/jpeg;base64,AA==" }],
      callLlm: async () => JSON.stringify({
        storySegments: [
          {
            storySegmentIndex: 1,
            startSec: 0,
            endSec: 16,
            durationSec: 16,
            scene: "bus stop",
            subject: "commuter holding phone",
            action: "checks drama reward task",
            camera: "handheld close-up then reaction",
            lighting: "natural daylight",
            style: "UGC short-drama ad",
            quality: "realistic 720p vertical video",
            coreHook: "missed bus turns into earning discovery",
            explosivePoint: "reward number keeps rising during drama clip",
            moneyEffects: ["reward_number_growth"],
            imagePrompt: "Brazilian commuter holding phone at bus stop.",
            seedancePrompt: "0-8s and 8-16s source-inspired UGC, no burned subtitles.",
            negativePrompt: "No watermark.",
            subtitles: ["Watch drama", "Check reward feedback"]
          }
        ]
      })
    }
  });

  assert.equal(result.analysis.storySegments.length, 1);
  assert.equal(result.plan.slices.length, 2);
  assert.deepEqual(result.plan.slices.map((slice) => slice.durationSec), [8, 8]);
  assert.match(await readFile(result.paths.promptsPath, "utf8"), /Brazilian commuter/);
});

test("runSeedanceSegmentDebugCli writes raw LLM output when story validation fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-invalid-"));
  const videoPath = join(root, "reference.mp4");
  const outputDir = join(root, "out");
  const rawContent = JSON.stringify({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 8,
        durationSec: 8,
        scene: "bus stop"
      }
    ]
  });
  await writeFile(videoPath, "fake video bytes");

  await assert.rejects(
    () => runSeedanceSegmentDebugCli({
      videoPath,
      outputDir,
      dependencies: {
        probeVideo: async () => ({ durationSec: 8, width: 720, height: 1280, ratio: "9:16" }),
        detectScenes: async () => [],
        extractFrames: async () => [],
        callLlm: async () => rawContent
      }
    }),
    /subject 缺失/
  );

  assert.equal(await readFile(join(outputDir, "llm-raw-response.txt"), "utf8"), `${rawContent}\n`);
});

test("seedance segment debug CLI module is import safe", async () => {
  const { stdout } = await execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    "await import('./scripts/wangzhuan-seedance-segment-debug.mjs'); console.log('import-ok')"
  ], {
    cwd: resolve("."),
    encoding: "utf8",
    timeout: 20000
  });

  assert.equal(stdout, "import-ok\n");
});

test("runSeedanceSegmentDebugCli writes raw LLM output when JSON parsing fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-parse-invalid-"));
  const videoPath = join(root, "reference.mp4");
  const outputDir = join(root, "out");
  const rawContent = "{not json";
  await writeFile(videoPath, "fake video bytes");

  await assert.rejects(
    () => runSeedanceSegmentDebugCli({
      videoPath,
      outputDir,
      dependencies: {
        probeVideo: async () => ({ durationSec: 8, width: 720, height: 1280, ratio: "9:16" }),
        detectScenes: async () => [],
        extractFrames: async () => [],
        callLlm: async () => rawContent
      }
    })
  );

  assert.equal(await readFile(join(outputDir, "llm-raw-response.txt"), "utf8"), `${rawContent}\n`);
});
