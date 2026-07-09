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

function messageContentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : part?.text || "")
      .join("\n");
  }
  return "";
}

function allMessageText(messages) {
  return messages.map((message) => messageContentText(message.content)).join("\n");
}

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

test("splitStorySegmentIntoSlices uses narrative split hints instead of equal duration", () => {
  assert.deepEqual(splitStorySegmentIntoSlices({
    storySegmentIndex: 2,
    startSec: 14,
    endSec: 40,
    durationSec: 26,
    sliceSplitHints: [
      { splitSec: 26, reason: "host claim changes into app UI proof" }
    ]
  }), [
    {
      storySegmentIndex: 2,
      seedanceSliceIndex: 1,
      startSec: 14,
      endSec: 26,
      durationSec: 12,
      sliceSplitReason: "host claim changes into app UI proof"
    },
    {
      storySegmentIndex: 2,
      seedanceSliceIndex: 2,
      startSec: 26,
      endSec: 40,
      durationSec: 14,
      sliceSplitReason: "host claim changes into app UI proof"
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
  assert.deepEqual(slices.map((slice) => slice.moneyEffects), [[], []]);
});

test("buildSeedanceSlices derives money effects only from observed replicated signals", () => {
  const slices = buildSeedanceSlices([
    {
      storySegmentIndex: 1,
      startSec: 0,
      endSec: 8,
      durationSec: 8,
      scene: "bus stop",
      subject: "commuter holding phone",
      action: "checks drama reward task",
      camera: "handheld close-up",
      lighting: "natural daylight",
      style: "UGC short-drama ad",
      quality: "realistic 720p vertical video",
      conversionSignals: {
        withdrawalSuccess: { present: false, shouldReplicate: false },
        earningsNumber: { present: true, timestampSec: 2, evidence: "counter rises", roleInVideo: "result proof", shouldReplicate: true },
        emotionalVoiceover: { present: true, timestampSec: 1, evidence: "excited host", roleInVideo: "urgency", shouldReplicate: true },
        cashCoinFeedback: { present: false, shouldReplicate: false },
        fastRewardCue: { present: false, shouldReplicate: false }
      },
      voiceoverObserved: {
        present: true,
        emotion: "excited",
        pace: "fast",
        energy: "high",
        evidence: "host speaks quickly",
        transcript: ["Watch this"]
      }
    }
  ]);

  assert.deepEqual(slices[0].moneyEffects, ["reward_number_growth"]);
  assert.equal(slices[0].conversionSignals.earningsNumber.shouldReplicate, true);
  assert.equal(slices[0].voiceoverObserved.pace, "fast");
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

test("design doc documents implemented CLI command and output files", async () => {
  const designDoc = await readFile(
    "docs/superpowers/specs/2026-07-08-seedance-segment-debug-cli-design.md",
    "utf8"
  );
  const cliSource = await readFile("scripts/wangzhuan-seedance-segment-debug.mjs", "utf8");
  const helperSource = await readFile("server/wangzhuan/seedance-segment-debug.mjs", "utf8");
  const outputFiles = [
    ...helperSource.matchAll(/const \w+Path = `\$\{outputDir\}\/([^`]+)`;/g)
  ].map((match) => match[1]);

  assert.match(cliSource, /runSeedanceSegmentDebugCli/);
  assert.match(designDoc, /node scripts\/wangzhuan-seedance-segment-debug\.mjs/);
  assert.match(designDoc, /--video \/absolute\/path\/reference\.mp4/);
  assert.deepEqual(outputFiles.sort(), [
    "analysis.json",
    "seedance-plan.json",
    "seedance-prompts.md"
  ]);

  for (const fileName of outputFiles) {
    assert.match(designDoc, new RegExp(`\`${fileName}\``));
  }
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

test("buildSegmentAnalysisMessages encodes segment and observed conversion signal rules", () => {
  const messages = buildSegmentAnalysisMessages({
    videoPath: "/tmp/ref.mp4",
    durationSec: 16,
    language: "pt-BR",
    region: "BR",
    productName: "Drama Gold",
    currencySymbol: "R$",
    sceneCutsSec: [4, 9],
    frames: [{ index: 1, timestampSec: 0.25, dataUrl: "data:image/jpeg;base64,AA==" }]
  });
  const userContent = messages.find((message) => message.role === "user")?.content;
  const text = allMessageText(messages);

  assert.equal(Array.isArray(userContent), true);
  assert.deepEqual(userContent[1], {
    type: "image_url",
    image_url: { url: "data:image/jpeg;base64,AA==" }
  });
  assert.match(text, /frame 1 at 0.25s/);
  assert.match(text, /scene, subject, action, camera, lighting, style, quality/);
  assert.match(text, /first understand the whole video end-to-end/);
  assert.match(text, /split by real narrative story beats only/);
  assert.match(text, /Do not create a new story segment only because the video cuts to app UI/);
  assert.match(text, /timelineItems/);
  assert.match(text, /Scene cuts are technical hints only/);
  assert.match(text, /conversionSignals/);
  assert.match(text, /withdrawalSuccess/);
  assert.match(text, /emotionalVoiceover/);
  assert.match(text, /Do not mark a signal present just because it would be useful for ads/);
  assert.match(text, /no burned subtitles/i);
  assert.match(text, /Do not invent or copy exact payout amounts/);
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

test("runSeedanceSegmentDebugCli completes when scene detection fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-scene-fail-"));
  const videoPath = join(root, "reference.mp4");
  await writeFile(videoPath, "fake video bytes");

  const result = await runSeedanceSegmentDebugCli({
    videoPath,
    outputDir: join(root, "out"),
    dependencies: {
      probeVideo: async () => ({ durationSec: 8, width: 720, height: 1280, ratio: "9:16" }),
      detectScenes: async () => {
        throw new Error("scene detector unavailable");
      },
      extractFrames: async () => [{ index: 1, timestampSec: 0.25, dataUrl: "data:image/jpeg;base64,AA==" }],
      callLlm: async () => JSON.stringify({
        storySegments: [
          {
            storySegmentIndex: 1,
            startSec: 0,
            endSec: 8,
            durationSec: 8,
            scene: "bus stop",
            subject: "commuter holding phone",
            action: "checks drama reward task",
            camera: "handheld close-up",
            lighting: "natural daylight",
            style: "UGC short-drama ad",
            quality: "realistic 720p vertical video",
            coreHook: "missed bus turns into earning discovery",
            explosivePoint: "reward number keeps rising",
            moneyEffects: ["reward_number_growth"],
            imagePrompt: "Brazilian commuter holding phone at bus stop.",
            seedancePrompt: "Source-inspired UGC, no burned subtitles.",
            negativePrompt: "No watermark.",
            subtitles: ["Watch drama"]
          }
        ]
      })
    }
  });

  assert.deepEqual(result.analysis.sourceVideo.sceneCutsSec, []);
  assert.equal(result.plan.slices.length, 1);
});

test("runSeedanceSegmentDebugCli completes when frame extraction fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-frame-fail-"));
  const videoPath = join(root, "reference.mp4");
  let llmUserContent = [];
  await writeFile(videoPath, "fake video bytes");

  const result = await runSeedanceSegmentDebugCli({
    videoPath,
    outputDir: join(root, "out"),
    dependencies: {
      probeVideo: async () => ({ durationSec: 8, width: 720, height: 1280, ratio: "9:16" }),
      detectScenes: async () => [3],
      extractFrames: async () => {
        throw new Error("ffmpeg unavailable");
      },
      callLlm: async (messages) => {
        llmUserContent = messages.find((message) => message.role === "user")?.content || "";
        return JSON.stringify({
          storySegments: [
            {
              storySegmentIndex: 1,
              startSec: 0,
              endSec: 8,
              durationSec: 8,
              scene: "bus stop",
              subject: "commuter holding phone",
              action: "checks drama reward task",
              camera: "handheld close-up",
              lighting: "natural daylight",
              style: "UGC short-drama ad",
              quality: "realistic 720p vertical video",
              coreHook: "missed bus turns into earning discovery",
              explosivePoint: "reward number keeps rising",
              moneyEffects: ["reward_number_growth"],
              imagePrompt: "Brazilian commuter holding phone at bus stop.",
              seedancePrompt: "Source-inspired UGC, no burned subtitles.",
              negativePrompt: "No watermark.",
              subtitles: ["Watch drama"]
            }
          ]
        });
      }
    }
  });

  assert.equal(result.plan.slices.length, 1);
  assert.match(messageContentText(llmUserContent), /Extracted frames:\n- no frames/);
});

test("runSeedanceSegmentDebugCli rejects exact money claims without truthRules and preserves raw output", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-money-reject-"));
  const videoPath = join(root, "reference.mp4");
  const outputDir = join(root, "out");
  const rawContent = JSON.stringify({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 8,
        durationSec: 8,
        scene: "bus stop",
        subject: "commuter holding phone",
        action: "checks drama task and sees reward_number_growth",
        camera: "handheld close-up",
        lighting: "natural daylight",
        style: "UGC short-drama ad",
        quality: "realistic 720p vertical video",
        coreHook: "R$ 50 reward surprise",
        explosivePoint: "cash_rain without concrete amount",
        moneyEffects: ["reward_number_growth", "coin_burst", "cash_rain"],
        imagePrompt: "Brazilian commuter holding phone at bus stop.",
        seedancePrompt: "Phone UI shows R$ 50 reward, no burned subtitles.",
        negativePrompt: "No watermark.",
        subtitles: ["Earn R$ 50 today"]
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
    /exact money claim requires truthRules/
  );

  assert.equal(await readFile(join(outputDir, "llm-raw-response.txt"), "utf8"), `${rawContent}\n`);
});

test("runSeedanceSegmentDebugCli allows exact money claims when truthRules are present", async () => {
  const root = await mkdtemp(join(tmpdir(), "seedance-debug-money-allow-"));
  const videoPath = join(root, "reference.mp4");
  await writeFile(videoPath, "fake video bytes");

  const result = await runSeedanceSegmentDebugCli({
    videoPath,
    outputDir: join(root, "out"),
    truthRules: { payoutExample: "R$ 50 is authorized copy from product rules" },
    dependencies: {
      probeVideo: async () => ({ durationSec: 8, width: 720, height: 1280, ratio: "9:16" }),
      detectScenes: async () => [],
      extractFrames: async () => [],
      callLlm: async () => JSON.stringify({
        storySegments: [
          {
            storySegmentIndex: 1,
            startSec: 0,
            endSec: 8,
            durationSec: 8,
            scene: "bus stop",
            subject: "commuter holding phone",
            action: "checks drama task",
            camera: "handheld close-up",
            lighting: "natural daylight",
            style: "UGC short-drama ad",
            quality: "realistic 720p vertical video",
            coreHook: "authorized R$ 50 reward example",
            explosivePoint: "reward_number_growth with coin_burst",
            moneyEffects: ["reward_number_growth", "coin_burst"],
            imagePrompt: "Brazilian commuter holding phone at bus stop.",
            seedancePrompt: "Phone UI shows R$ 50 reward, no burned subtitles.",
            negativePrompt: "No watermark.",
            subtitles: ["R$ 50 reward example"]
          }
        ]
      })
    }
  });

  assert.equal(result.plan.slices.length, 1);
  assert.match(result.plan.slices[0].seedancePrompt, /R\$ 50/);
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

test("seedance segment debug module imports existing reference video frame utilities", async () => {
  const source = await readFile("server/wangzhuan/seedance-segment-debug.mjs", "utf8");
  assert.match(source, /function defaultFrameTimestamps[\s\S]*?buildSceneAwareFrameTimestamps/);
  assert.match(source, /async function defaultDetectScenes[\s\S]*?detectReferenceVideoScenes/);
  assert.match(source, /async function defaultExtractFrames[\s\S]*?extractReferenceFrames/);
});

test("seedance segment debug resolves LLM config through runtime Skylink defaults", async () => {
  const source = await readFile("server/wangzhuan/seedance-segment-debug.mjs", "utf8");
  assert.match(source, /loadRuntimeConfig/);
  assert.match(source, /resolveLlmConfig/);
  assert.doesNotMatch(source, /https:\/\/api\\.openai\\.com\/v1/);
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
