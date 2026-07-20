import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { PLAN_PROMPT_VERSION, planCacheKey } from "../../server/wangzhuan/plan-cache.mjs";

test("plan cache version includes the narrative pacing contract", () => {
  assert.equal(PLAN_PROMPT_VERSION, "seedance_plan_v2_narrative_pacing");
});
import { generateSeedancePlan } from "../../server/wangzhuan/plan-preview.mjs";

test("plan cache key changes by slice params", () => {
  const base = {
    decomposition: { storySegments: [{ storySegmentIndex: 1 }] },
    branch: { branchId: "b1", productName: "App" },
    model: "gemini-3.5-flash",
    compact: false,
    branchVariantIndex: 1,
    sliceDurationSec: 12
  };
  assert.notEqual(
    planCacheKey({ ...base, segmentIndex: 1 }),
    planCacheKey({ ...base, segmentIndex: 2 })
  );
});

test("plan cache key separates compact and full prompt modes", () => {
  const base = {
    decomposition: { storySegments: [{ storySegmentIndex: 1 }] },
    branch: { branchId: "b1", productName: "App" },
    model: "gemini-3.5-flash",
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12
  };
  assert.notEqual(
    planCacheKey({ ...base, compact: false }),
    planCacheKey({ ...base, compact: true })
  );
});

test("generateSeedancePlan cache hit avoids second LLM call", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-plan-cache-"));
  let llmCalls = 0;
  const telemetry = [];
  const context = {
    userProjectRoot: root,
    sharedProjectRoot: root,
    config: { wangzhuan: { planCacheEnabled: true } },
    recordTelemetryEvent: async (eventName, payload) => {
      telemetry.push({ eventName, payload });
    },
    callWangzhuanLlm: async () => {
      llmCalls += 1;
      return JSON.stringify({
        hook: "打开就看到奖励进度",
        body: "用户打开 App 查看短剧任务和奖励反馈。",
        voiceover: "打开看看今天的短剧奖励。",
        subtitles: ["短剧奖励进度"],
        cta: "",
        ending: "",
        imagePrompt: "new person in a living room holding a phone with simple app UI",
        seedancePrompt: "shot 1: new person opens phone in living room, smooth push-in, no burned subtitles, simple UI",
        negativePrompt: "watermark, blurry"
      });
    }
  };
  const input = {
    batch: {
      batchId: "wzb_20260710120000_abcd",
      templateSnapshot: { draft: { productName: "App", language: "zh-CN", regions: ["CN"], currencySymbol: "¥" } },
      estimate: { request: { language: "zh-CN", targetRegions: ["CN"] } }
    },
    branch: { branchId: "b1", productName: "App", languages: ["zh-CN"], regions: ["CN"], currencySymbol: "¥", truthRules: {} },
    decomposition: { wholeVideoConversion: { coreConversionTone: "reward proof" }, storySegments: [{ storySegmentIndex: 1, summary: "hook" }] },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12,
    currentSlice: { storySegmentIndex: 1, durationSec: 12 }
  };
  try {
    const first = await generateSeedancePlan(context, input);
    const second = await generateSeedancePlan(context, input);
    assert.equal(llmCalls, 1);
    assert.deepEqual(second, first);
    assert.equal(telemetry.some((event) => event.eventName === "plan_cache_hit"), true);
    assert.equal(telemetry.find((event) => event.eventName === "plan_cache_hit")?.payload?.segmentIndex, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
