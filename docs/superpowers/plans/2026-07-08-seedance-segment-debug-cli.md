# Seedance Segment Debug CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a local-only debug CLI that analyzes one reference video into story segments and writes Seedance-ready per-slice JSON plus editable prompts.

**Architecture:** Keep production wangzhuan UI, database, batch state, and Seedance submission untouched. Add a focused helper module for argument parsing, segment normalization, slice splitting, prompt rendering, and output writing; add a thin CLI that uses existing reference-video utilities for ffmpeg probing/frame extraction/scene hints and existing LLM helpers for JSON generation.

**Tech Stack:** Node.js ESM, Node built-in `node:test`, existing wangzhuan LLM/reference-video helpers, ffmpeg/ffprobe already used by the project.

---

## Rule Classification

- Project type: Node.js ESM backend plus local CLI script.
- Loaded user rules: base project understanding, execution discipline, risk escalation, verification, scope control, secrets/config, Node.js, file input/output, resource management, security input/output, documentation maintenance.
- Scope boundary: no UI, no database, no background jobs, no production Seedance task submission, no new runtime dependency.

## File Structure

- Create `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs`
  - Pure helper functions and one orchestration function.
  - Responsibilities: parse CLI args, normalize truth rules, build LLM messages, parse LLM segment JSON, split story segments into Seedance slices, render Markdown, write output files.
  - Must not execute work on import.
- Create `/Users/lucy/Desktop/project/Aigc-platform/scripts/wangzhuan-seedance-segment-debug.mjs`
  - Thin executable entry point.
  - Responsibilities: call helper orchestration, print output paths, set process exit code on failure.
- Create `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`
  - Unit tests for pure helper behavior and a stubbed orchestration smoke test.
- Modify `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/reference-videos.mjs`
  - Export existing internal helpers needed by the CLI: `buildSceneAwareFrameTimestamps`, `detectReferenceVideoScenes`, `extractReferenceFrames`, `ffmpegDetectReferenceVideoScenes`, and `ffmpegExtractReferenceFrames` if not already exported.
  - Do not change existing behavior.
- Modify `/Users/lucy/Desktop/project/Aigc-platform/docs/superpowers/specs/2026-07-08-seedance-segment-debug-cli-design.md`
  - Add the final CLI command and output file names if implementation changes the exact names.

## Implementation Notes

- Existing unrelated local edits must remain untouched:
  - `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/store-page.mjs`
  - `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/store-page.test.mjs`
- The helper module should expose pure functions for tests:
  - `parseDebugCliArgs(argv)`
  - `splitStorySegmentIntoSlices(segment, options)`
  - `buildSeedanceSlices(storySegments, options)`
  - `normalizeStorySegments(value, context)`
  - `buildSegmentAnalysisMessages(input)`
  - `renderSeedancePromptsMarkdown(plan)`
  - `writeDebugOutputs(outputDir, payload)`
  - `runSeedanceSegmentDebugCli(options)`
- The CLI should default to safe prompt behavior: no exact payout amount unless `truthRules` explicitly allows it.
- LLM-generated JSON must be parsed through existing `parseLlmJsonContent()`.
- All file paths from CLI input must be resolved locally; reject non-existent files before model calls.

---

### Task 1: Add Pure Segment Debug Helpers

**Files:**
- Create: `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs`
- Test: `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`

- [ ] **Step 1: Write failing tests for argument parsing and slice splitting**

Create `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs` with:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: FAIL with module-not-found for `server/wangzhuan/seedance-segment-debug.mjs`.

- [ ] **Step 3: Implement helper skeleton and slice splitting**

Create `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs`:

```js
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const SEVEN_DIMENSIONS = Object.freeze([
  "scene",
  "subject",
  "action",
  "camera",
  "lighting",
  "style",
  "quality"
]);

const DEFAULT_MONEY_EFFECTS = Object.freeze([
  "reward_number_growth",
  "coin_burst",
  "cash_rain",
  "withdrawal_success"
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundSec(value) {
  return Math.round(numberOrFallback(value, 0) * 100) / 100;
}

function requireValue(value, message) {
  const text = cleanString(value);
  if (!text) throw new Error(message);
  return text;
}

export function parseDebugCliArgs(argv = process.argv.slice(2), { cwd = process.cwd(), now = new Date() } = {}) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`未知参数：${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`参数 --${key} 缺少值`);
    values[key] = next;
    index += 1;
  }

  const video = requireValue(values.video, "--video 必填");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return {
    videoPath: resolve(cwd, video),
    outputDir: resolve(cwd, cleanString(values.out) || `tmp/seedance-segment-debug/${stamp}`),
    language: cleanString(values.language) || "pt-BR",
    region: cleanString(values.region) || "BR",
    productName: cleanString(values["product-name"]) || "Product",
    currencySymbol: cleanString(values["currency-symbol"]),
    truthRulesPath: cleanString(values["truth-rules-json"]) ? resolve(cwd, values["truth-rules-json"]) : "",
    minSliceSec: Math.max(1, Math.round(numberOrFallback(values["min-slice-sec"], 8))),
    maxSliceSec: Math.max(1, Math.round(numberOrFallback(values["max-slice-sec"], 15)))
  };
}

export function splitStorySegmentIntoSlices(segment = {}, options = {}) {
  const minSliceSec = Math.max(1, Math.round(numberOrFallback(options.minSliceSec, 8)));
  const maxSliceSec = Math.max(minSliceSec, Math.round(numberOrFallback(options.maxSliceSec, 15)));
  const startSec = roundSec(segment.startSec);
  const durationSec = roundSec(segment.durationSec || (numberOrFallback(segment.endSec, 0) - startSec));
  const endSec = roundSec(segment.endSec || (startSec + durationSec));
  const storySegmentIndex = Math.max(1, Math.round(numberOrFallback(segment.storySegmentIndex, 1)));

  if (durationSec <= maxSliceSec) {
    return [{
      storySegmentIndex,
      seedanceSliceIndex: 1,
      startSec,
      endSec,
      durationSec: roundSec(endSec - startSec)
    }];
  }

  const firstDuration = Math.max(minSliceSec, Math.min(maxSliceSec, Math.round(durationSec / 2)));
  const firstEndSec = roundSec(startSec + firstDuration);
  return [
    {
      storySegmentIndex,
      seedanceSliceIndex: 1,
      startSec,
      endSec: firstEndSec,
      durationSec: roundSec(firstEndSec - startSec)
    },
    {
      storySegmentIndex,
      seedanceSliceIndex: 2,
      startSec: firstEndSec,
      endSec,
      durationSec: roundSec(endSec - firstEndSec)
    }
  ];
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => cleanString(item)).filter(Boolean);
  const text = cleanString(value);
  return text ? [text] : [];
}

function segmentRoleFor(globalIndex, total) {
  if (globalIndex === 1) return "hook_slice";
  if (globalIndex === total) return "withdrawal_slice";
  return "proof_slice";
}

function copySevenDimensions(source = {}) {
  const result = {};
  for (const key of SEVEN_DIMENSIONS) result[key] = cleanString(source[key]);
  return result;
}

export function buildSeedanceSlices(storySegments = [], options = {}) {
  const rawSlices = [];
  for (const segment of storySegments) {
    const timingSlices = splitStorySegmentIntoSlices(segment, options);
    for (const timing of timingSlices) {
      rawSlices.push({
        ...timing,
        ...copySevenDimensions(segment),
        coreHook: cleanString(segment.coreHook),
        explosivePoint: cleanString(segment.explosivePoint),
        moneyEffects: normalizeStringList(segment.moneyEffects).length
          ? normalizeStringList(segment.moneyEffects)
          : [...DEFAULT_MONEY_EFFECTS],
        imagePrompt: cleanString(segment.imagePrompt),
        seedancePrompt: cleanString(segment.seedancePrompt),
        negativePrompt: cleanString(segment.negativePrompt) || "No competitor logo, no watermark, no burned subtitles, no invented exact payout amount.",
        subtitleWorkflow: {
          burnedInSubtitles: false,
          postSubtitleRequired: true,
          provider: "pixel_tech",
          subtitleScript: normalizeStringList(segment.subtitleScript || segment.subtitles)
        }
      });
    }
  }
  return rawSlices.map((slice, index) => ({
    ...slice,
    segmentRole: slice.segmentRole || segmentRoleFor(index + 1, rawSlices.length)
  }));
}

export function renderSeedancePromptsMarkdown(plan = {}) {
  const slices = Array.isArray(plan.slices) ? plan.slices : [];
  const lines = ["# Seedance Segment Debug Prompts", ""];
  for (const slice of slices) {
    lines.push(`## Story ${slice.storySegmentIndex} / Slice ${slice.seedanceSliceIndex}`);
    lines.push("");
    lines.push(`- Timing: ${slice.startSec}s-${slice.endSec}s`);
    lines.push(`- durationSec: ${slice.durationSec}`);
    lines.push(`- segmentRole: ${slice.segmentRole || ""}`);
    lines.push("- Seven dimensions:");
    for (const key of SEVEN_DIMENSIONS) lines.push(`  - ${key}: ${slice[key] || ""}`);
    lines.push(`- Core hook: ${slice.coreHook || ""}`);
    lines.push(`- Explosive point: ${slice.explosivePoint || ""}`);
    lines.push(`- Money effects: ${(slice.moneyEffects || []).join(", ")}`);
    lines.push("");
    lines.push("### imagePrompt");
    lines.push(slice.imagePrompt || "");
    lines.push("");
    lines.push("### seedancePrompt");
    lines.push(slice.seedancePrompt || "");
    lines.push("");
    lines.push("### negativePrompt");
    lines.push(slice.negativePrompt || "");
    lines.push("");
    lines.push("### subtitleScript");
    for (const line of slice.subtitleWorkflow?.subtitleScript || []) lines.push(`- ${line}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export async function writeDebugOutputs(outputDir, payload = {}) {
  await mkdir(outputDir, { recursive: true });
  const analysisPath = `${outputDir}/analysis.json`;
  const planPath = `${outputDir}/seedance-plan.json`;
  const promptsPath = `${outputDir}/seedance-prompts.md`;
  await writeFile(analysisPath, `${JSON.stringify(payload.analysis || {}, null, 2)}\n`);
  await writeFile(planPath, `${JSON.stringify(payload.plan || {}, null, 2)}\n`);
  await writeFile(promptsPath, renderSeedancePromptsMarkdown(payload.plan || {}));
  return { analysisPath, planPath, promptsPath };
}

export async function assertLocalVideoFile(videoPath) {
  const info = await stat(videoPath);
  if (!info.isFile()) throw new Error(`视频路径不是文件：${videoPath}`);
  return videoPath;
}

export async function loadTruthRules(truthRulesPath) {
  if (!truthRulesPath) return {};
  return JSON.parse(await readFile(truthRulesPath, "utf8"));
}

export const seedanceSegmentDebugInternals = {
  SEVEN_DIMENSIONS,
  basename
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git add server/wangzhuan/seedance-segment-debug.mjs tests/wangzhuan/seedance-segment-debug.test.mjs
git commit -m "feat: add seedance segment debug helpers"
```

---

### Task 2: Add LLM Segment Contract And Output Rendering Tests

**Files:**
- Modify: `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs`
- Modify: `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`

- [ ] **Step 1: Add failing tests for seven dimensions, prompt contract, and output files**

Append to `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`:

```js
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
```

- [ ] **Step 2: Run test to verify the current status**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: PASS if Task 1 implementation already included these helpers; otherwise FAIL on missing field/rendering behavior.

- [ ] **Step 3: Add LLM message builder and story segment normalizer**

Modify `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs` and add these exports before `writeDebugOutputs()`:

```js
export function normalizeStorySegments(value, context = {}) {
  const source = Array.isArray(value?.storySegments) ? value.storySegments : (Array.isArray(value) ? value : []);
  const durationSec = roundSec(context.durationSec);
  return source.map((segment, index) => {
    const startSec = roundSec(segment.startSec ?? (index === 0 ? 0 : source[index - 1]?.endSec));
    const fallbackEnd = index === source.length - 1 && durationSec > 0 ? durationSec : startSec + numberOrFallback(segment.durationSec, 0);
    const endSec = roundSec(segment.endSec ?? fallbackEnd);
    const normalized = {
      storySegmentIndex: Math.max(1, Math.round(numberOrFallback(segment.storySegmentIndex, index + 1))),
      startSec,
      endSec,
      durationSec: roundSec(segment.durationSec || (endSec - startSec)),
      ...copySevenDimensions(segment),
      coreHook: cleanString(segment.coreHook || segment.hook),
      explosivePoint: cleanString(segment.explosivePoint || segment.burstPoint || segment.baoDian),
      moneyEffects: normalizeStringList(segment.moneyEffects),
      imagePrompt: cleanString(segment.imagePrompt),
      seedancePrompt: cleanString(segment.seedancePrompt),
      negativePrompt: cleanString(segment.negativePrompt),
      subtitles: normalizeStringList(segment.subtitles || segment.subtitleScript)
    };
    for (const key of SEVEN_DIMENSIONS) {
      if (!normalized[key]) throw new Error(`storySegments[${index}].${key} 缺失`);
    }
    if (normalized.endSec <= normalized.startSec) throw new Error(`storySegments[${index}] 时间范围无效`);
    return normalized;
  });
}

export function buildSegmentAnalysisMessages(input = {}) {
  const frameLines = (input.frames || []).map((frame) => `- frame ${frame.index ?? ""} at ${frame.timestampSec}s`).join("\n") || "- no frames";
  const sceneCuts = (input.sceneCutsSec || []).join(", ") || "none";
  const truthRules = input.truthRules && Object.keys(input.truthRules).length ? JSON.stringify(input.truthRules) : "{}";
  const userText = [
    "Analyze the reference video into narrative story segments for Seedance ad generation.",
    `Source video: ${input.videoPath || ""}`,
    `Duration: ${input.durationSec || 0}s`,
    `Language: ${input.language || "pt-BR"}`,
    `Region: ${input.region || "BR"}`,
    `Product: ${input.productName || "Product"}`,
    `Currency: ${input.currencySymbol || ""}`,
    `Scene cut hints, for reference only: ${sceneCuts}`,
    "Extracted frames:",
    frameLines,
    "Required for every story segment: scene, subject, action, camera, lighting, style, quality, coreHook, explosivePoint, moneyEffects.",
    "The LLM chooses the story segment count. Scene cuts are hints, not authoritative boundaries.",
    "For wangzhuan effects, include visual motifs such as reward_number_growth, coin_burst, cash_rain, withdrawal_success, arrival_animation, withdrawal_record, real_cash_sound_cue when they fit.",
    "Do not invent exact payout amounts, thresholds, arrival speeds, or guaranteed earnings unless truthRules explicitly allow them.",
    `truthRules: ${truthRules}`,
    "Return strict JSON only: {\"storySegments\":[{\"storySegmentIndex\":1,\"startSec\":0,\"endSec\":12,\"durationSec\":12,\"scene\":\"...\",\"subject\":\"...\",\"action\":\"...\",\"camera\":\"...\",\"lighting\":\"...\",\"style\":\"...\",\"quality\":\"...\",\"coreHook\":\"...\",\"explosivePoint\":\"...\",\"moneyEffects\":[\"reward_number_growth\"],\"imagePrompt\":\"...\",\"seedancePrompt\":\"... no burned subtitles ...\",\"negativePrompt\":\"...\",\"subtitles\":[\"...\"]}]}"
  ].join("\n");

  return [
    {
      role: "system",
      content: "You are a Seedance wangzhuan video analyst. Preserve the source video's narrative structure, but redesign people, scene, clothing, props, and money visuals for safe original ad generation."
    },
    {
      role: "user",
      content: userText
    }
  ];
}
```

- [ ] **Step 4: Add tests for message builder and normalizer**

Append to `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`:

```js
import {
  buildSegmentAnalysisMessages,
  normalizeStorySegments
} from "../../server/wangzhuan/seedance-segment-debug.mjs";

test("normalizeStorySegments requires the seven dimensions", () => {
  assert.throws(
    () => normalizeStorySegments({ storySegments: [{ startSec: 0, endSec: 8, scene: "street" }] }),
    /subject 缺失/
  );
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
```

If Node reports duplicate import declarations, merge the new named imports into the existing import block from `../../server/wangzhuan/seedance-segment-debug.mjs`.

- [ ] **Step 5: Run focused test**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add server/wangzhuan/seedance-segment-debug.mjs tests/wangzhuan/seedance-segment-debug.test.mjs
git commit -m "feat: define seedance segment debug contract"
```

---

### Task 3: Add CLI Orchestration With Stub-Testable Dependencies

**Files:**
- Modify: `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs`
- Create: `/Users/lucy/Desktop/project/Aigc-platform/scripts/wangzhuan-seedance-segment-debug.mjs`
- Test: `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`

- [ ] **Step 1: Add failing orchestration test with stubbed dependencies**

Append to `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`:

```js
import { writeFile } from "node:fs/promises";
import { runSeedanceSegmentDebugCli } from "../../server/wangzhuan/seedance-segment-debug.mjs";

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
```

If Node reports duplicate import declarations, merge imports into the existing import blocks.

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: FAIL because `runSeedanceSegmentDebugCli` is not implemented.

- [ ] **Step 3: Implement orchestration and default dependency hooks**

Modify `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs` and add imports at the top:

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseLlmJsonContent, callOpenAiCompatibleLlm } from "./reference-videos.mjs";

const execFileAsync = promisify(execFile);
```

Add these functions before `seedanceSegmentDebugInternals`:

```js
async function defaultProbeVideo(videoPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    videoPath
  ], {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  const parsed = JSON.parse(stdout || "{}");
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] || {} : {};
  const durationSec = roundSec(parsed.format?.duration || 0);
  const width = Math.round(numberOrFallback(stream.width, 0));
  const height = Math.round(numberOrFallback(stream.height, 0));
  return {
    durationSec,
    width,
    height,
    ratio: width && height ? `${width}:${height}` : ""
  };
}

function defaultFrameTimestamps(durationSec) {
  const duration = roundSec(durationSec);
  if (duration <= 0) return [];
  return [0.25, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0.25, duration - 0.25)]
    .map(roundSec)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function defaultDetectScenes() {
  return [];
}

async function defaultExtractFrames() {
  return [];
}

function resolveLlmConfigFromEnv(options = {}) {
  return {
    provider: options.provider || process.env.WANGZHUAN_LLM_PROVIDER || "skylink",
    model: options.model || process.env.WANGZHUAN_LLM_MODEL || "gpt-5.4",
    endpoint: options.endpoint || process.env.WANGZHUAN_LLM_ENDPOINT || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
    apiKey: options.apiKey || process.env.WANGZHUAN_LLM_API_KEY || process.env.OPENAI_API_KEY || "",
    apiKeyEnv: options.apiKeyEnv || "WANGZHUAN_LLM_API_KEY",
    temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.2,
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 300000
  };
}

async function defaultCallLlm(messages, options = {}) {
  const llmConfig = resolveLlmConfigFromEnv(options.llmConfig || {});
  return callOpenAiCompatibleLlm(llmConfig, messages);
}

export async function runSeedanceSegmentDebugCli(options = {}) {
  await assertLocalVideoFile(options.videoPath);
  const dependencies = options.dependencies || {};
  const probeVideo = dependencies.probeVideo || defaultProbeVideo;
  const detectScenes = dependencies.detectScenes || defaultDetectScenes;
  const extractFrames = dependencies.extractFrames || defaultExtractFrames;
  const callLlm = dependencies.callLlm || defaultCallLlm;

  const truthRules = options.truthRules || await loadTruthRules(options.truthRulesPath);
  const probe = await probeVideo(options.videoPath, options);
  const sceneCutsSec = await detectScenes(options.videoPath, probe, options).catch((error) => {
    return { error };
  });
  const sceneCutList = Array.isArray(sceneCutsSec) ? sceneCutsSec : [];
  const frames = await extractFrames(options.videoPath, {
    ...probe,
    timestampsSec: defaultFrameTimestamps(probe.durationSec)
  }, options);
  const messages = buildSegmentAnalysisMessages({
    ...options,
    durationSec: probe.durationSec,
    sceneCutsSec: sceneCutList,
    frames,
    truthRules
  });
  const rawContent = await callLlm(messages, options);
  let parsed;
  try {
    parsed = typeof rawContent === "string" ? parseLlmJsonContent(rawContent) : rawContent;
  } catch (error) {
    await mkdir(options.outputDir, { recursive: true });
    await writeFile(`${options.outputDir}/llm-raw-response.txt`, String(rawContent || ""));
    throw error;
  }
  const storySegments = normalizeStorySegments(parsed, { durationSec: probe.durationSec });
  const slices = buildSeedanceSlices(storySegments, options);
  const analysis = {
    sourceVideo: {
      path: options.videoPath,
      fileName: basename(options.videoPath),
      durationSec: probe.durationSec,
      width: probe.width || 0,
      height: probe.height || 0,
      ratio: probe.ratio || "",
      sceneCutsSec: sceneCutList
    },
    storySegments
  };
  const plan = {
    language: options.language || "pt-BR",
    region: options.region || "BR",
    productName: options.productName || "Product",
    currencySymbol: options.currencySymbol || "",
    minSliceSec: options.minSliceSec || 8,
    maxSliceSec: options.maxSliceSec || 15,
    slices
  };
  const paths = await writeDebugOutputs(options.outputDir, { analysis, plan });
  return { analysis, plan, paths };
}
```

- [ ] **Step 4: Create CLI entry point**

Create `/Users/lucy/Desktop/project/Aigc-platform/scripts/wangzhuan-seedance-segment-debug.mjs`:

```js
#!/usr/bin/env node
import {
  parseDebugCliArgs,
  runSeedanceSegmentDebugCli
} from "../server/wangzhuan/seedance-segment-debug.mjs";

async function main() {
  const options = parseDebugCliArgs(process.argv.slice(2));
  const result = await runSeedanceSegmentDebugCli(options);
  console.log("Seedance segment debug files written:");
  console.log(`analysis: ${result.paths.analysisPath}`);
  console.log(`plan: ${result.paths.planPath}`);
  console.log(`prompts: ${result.paths.promptsPath}`);
}

main().catch((error) => {
  console.error(error?.message || error);
  process.exitCode = 1;
});
```

- [ ] **Step 5: Run focused tests and syntax check**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
node --check scripts/wangzhuan-seedance-segment-debug.mjs
node --check server/wangzhuan/seedance-segment-debug.mjs
```

Expected: all PASS / no syntax errors.

- [ ] **Step 6: Commit**

Run:

```bash
git add server/wangzhuan/seedance-segment-debug.mjs scripts/wangzhuan-seedance-segment-debug.mjs tests/wangzhuan/seedance-segment-debug.test.mjs
git commit -m "feat: add seedance segment debug cli"
```

---

### Task 4: Wire Existing Frame And Scene Utilities Into The CLI

**Files:**
- Modify: `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/reference-videos.mjs`
- Modify: `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs`
- Test: `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`

- [ ] **Step 1: Write static test for reuse of existing utilities**

Append to `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`:

```js
test("seedance segment debug module imports existing reference video frame utilities", async () => {
  const source = await readFile("server/wangzhuan/seedance-segment-debug.mjs", "utf8");
  assert.match(source, /buildSceneAwareFrameTimestamps/);
  assert.match(source, /detectReferenceVideoScenes/);
  assert.match(source, /extractReferenceFrames/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: FAIL because the CLI currently uses empty default frame/scene functions.

- [ ] **Step 3: Export existing reference-video helpers**

Modify the export block at the bottom of `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/reference-videos.mjs` to include:

```js
export {
  buildBatchReferenceFrameExtractionPlan,
  buildSceneAwareFrameTimestamps,
  callGeminiCompatibleLlm,
  callOpenAiCompatibleLlm,
  detectReferenceVideoScenes,
  extractReferenceFrames,
  parseLlmJsonContent
};
```

Keep existing exported names and add only missing names. Do not change helper implementations.

- [ ] **Step 4: Use existing helpers in default dependencies**

Modify imports in `/Users/lucy/Desktop/project/Aigc-platform/server/wangzhuan/seedance-segment-debug.mjs`:

```js
import {
  buildSceneAwareFrameTimestamps,
  callOpenAiCompatibleLlm,
  detectReferenceVideoScenes,
  extractReferenceFrames,
  parseLlmJsonContent
} from "./reference-videos.mjs";
```

Replace `defaultFrameTimestamps`, `defaultDetectScenes`, and `defaultExtractFrames` with:

```js
function createReferenceContext(options = {}) {
  return {
    userProjectRoot: process.cwd(),
    sharedProjectRoot: process.cwd(),
    config: {
      wangzhuan: {
        llm: {
          frameExtractTimeoutMs: Number(process.env.WANGZHUAN_DEBUG_FRAME_TIMEOUT_MS || 20000),
          sceneDetectTimeoutMs: Number(process.env.WANGZHUAN_DEBUG_SCENE_TIMEOUT_MS || 25000),
          sceneDetectThreshold: Number(process.env.WANGZHUAN_DEBUG_SCENE_THRESHOLD || 0.1),
          sceneDetectMinGapSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_MIN_GAP_SEC || 0.8),
          sceneLongThresholdSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_LONG_THRESHOLD_SEC || 8),
          sceneMaxFrames: Number(process.env.WANGZHUAN_DEBUG_SCENE_MAX_FRAMES || 40)
        }
      }
    },
    ...(options.context || {})
  };
}

function defaultFrameTimestamps(durationSec, sceneCutsSec = [], options = {}) {
  const duration = roundSec(durationSec);
  if (duration <= 0) return [];
  const timestamps = buildSceneAwareFrameTimestamps(duration, sceneCutsSec, {
    longSceneThresholdSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_LONG_THRESHOLD_SEC || 8),
    maxFrames: Number(process.env.WANGZHUAN_DEBUG_SCENE_MAX_FRAMES || 40),
    minSceneGapSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_MIN_GAP_SEC || 0.8)
  });
  if (timestamps.length) return timestamps;
  return [0.25, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0.25, duration - 0.25)]
    .map(roundSec)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function defaultDetectScenes(videoPath, probe, options = {}) {
  return detectReferenceVideoScenes(createReferenceContext(options), videoPath, probe.durationSec);
}

async function defaultExtractFrames(videoPath, probe, options = {}) {
  const timestampsSec = Array.isArray(probe.timestampsSec) && probe.timestampsSec.length
    ? probe.timestampsSec
    : defaultFrameTimestamps(probe.durationSec, options.sceneCutsSec || [], options);
  return extractReferenceFrames(createReferenceContext(options), videoPath, timestampsSec);
}
```

Then in `runSeedanceSegmentDebugCli()`, call `defaultFrameTimestamps()` with scene cuts before extracting frames:

```js
  const frameProbe = {
    ...probe,
    timestampsSec: defaultFrameTimestamps(probe.durationSec, sceneCutList, options)
  };
  const frames = await extractFrames(options.videoPath, frameProbe, { ...options, sceneCutsSec: sceneCutList });
```

- [ ] **Step 5: Run focused tests**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git add server/wangzhuan/reference-videos.mjs server/wangzhuan/seedance-segment-debug.mjs tests/wangzhuan/seedance-segment-debug.test.mjs
git commit -m "feat: reuse reference video analysis in segment debug cli"
```

---

### Task 5: Add CLI Usage Documentation And Final Verification

**Files:**
- Modify: `/Users/lucy/Desktop/project/Aigc-platform/docs/superpowers/specs/2026-07-08-seedance-segment-debug-cli-design.md`
- Test: `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`

- [ ] **Step 1: Add static test for documented CLI path**

Append to `/Users/lucy/Desktop/project/Aigc-platform/tests/wangzhuan/seedance-segment-debug.test.mjs`:

```js
test("design doc documents the implemented CLI command", async () => {
  const doc = await readFile("docs/superpowers/specs/2026-07-08-seedance-segment-debug-cli-design.md", "utf8");
  assert.match(doc, /scripts\/wangzhuan-seedance-segment-debug\.mjs/);
  assert.match(doc, /analysis\.json/);
  assert.match(doc, /seedance-plan\.json/);
  assert.match(doc, /seedance-prompts\.md/);
});
```

- [ ] **Step 2: Run test to verify it passes or exposes doc drift**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs
```

Expected: PASS. If it fails, update the design doc to match the implemented command and output file names.

- [ ] **Step 3: Run focused and related tests**

Run:

```bash
node --test tests/wangzhuan/seedance-segment-debug.test.mjs tests/wangzhuan/multi-slice-plan.test.mjs tests/wangzhuan/plan-preview.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS.

- [ ] **Step 5: Review git diff for scope**

Run:

```bash
git diff --stat HEAD
git diff -- server/wangzhuan/seedance-segment-debug.mjs scripts/wangzhuan-seedance-segment-debug.mjs server/wangzhuan/reference-videos.mjs tests/wangzhuan/seedance-segment-debug.test.mjs docs/superpowers/specs/2026-07-08-seedance-segment-debug-cli-design.md
```

Expected: only files listed in this plan changed, except pre-existing unrelated `store-page` edits remain unstaged.

- [ ] **Step 6: Commit final doc/test alignment if needed**

If Task 5 changed the design doc or tests after the previous commits, run:

```bash
git add docs/superpowers/specs/2026-07-08-seedance-segment-debug-cli-design.md tests/wangzhuan/seedance-segment-debug.test.mjs
git commit -m "test: verify seedance segment debug cli"
```

If there are no changes, skip this commit.

---

## Execution Checklist

Before reporting completion:

- [ ] `git status --short` shows only expected unrelated local edits or no changes.
- [ ] Focused debug CLI tests pass.
- [ ] Related Seedance planning tests pass.
- [ ] Full `npm test` passes, or any failure is clearly unrelated and documented.
- [ ] Final response includes exact commands run and commit hashes.
- [ ] Final response states that production UI, DB, background jobs, and Seedance submission were not changed.
