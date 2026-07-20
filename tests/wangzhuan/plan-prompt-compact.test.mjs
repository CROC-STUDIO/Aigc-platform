import assert from "node:assert/strict";
import test from "node:test";

import { buildSeedancePlanMessages } from "../../server/wangzhuan/plan-preview.mjs";

function baseInput(options = {}) {
  return {
    batch: {
      batchId: "wzb_20260710120000_abcd",
      templateSnapshot: { draft: { productName: "Drama App", language: "zh-CN", regions: ["CN"], currencySymbol: "¥" } },
      estimate: { request: { targetRegions: ["CN"], language: "zh-CN" } }
    },
    branch: {
      branchId: "branch_1",
      productName: "Drama App",
      languages: ["zh-CN"],
      regions: ["CN"],
      currencySymbol: "¥",
      targetChannels: ["meta_ads"],
      truthRules: {}
    },
    decomposition: {
      sourceVideoProfile: { style: "ugc" },
      wholeVideoConversion: { coreConversionTone: "fast reward proof" },
      narrativePacingPlan: {
        appliesToContinuityGroupIds: ["cg_story"],
        centralConflict: "a secret debt breaks trust",
        beatSheet: [{ startSec: 4, endSec: 7, change: "phone proof interrupts the accusation" }]
      },
      storySegments: [
        { storySegmentIndex: 1, summary: "开场冲突", timelineItems: [{ content: "opening" }] },
        { storySegmentIndex: 2, continuityGroupId: "cg_story", summary: "产品承接", timelineItems: [{ content: "current slice detail" }] },
        { storySegmentIndex: 3, summary: "结尾转化", timelineItems: [{ content: "ending" }] }
      ],
      seedanceSlices: [
        { seedanceSliceIndex: 1, storySegmentIndex: 1 },
        { seedanceSliceIndex: 2, storySegmentIndex: 2 },
        { seedanceSliceIndex: 3, storySegmentIndex: 3 }
      ]
    },
    channelRules: {
      rules: [
        { channel: "meta_ads", requiredDisclaimers: ["meta disclaimer"] },
        { channel: "tiktok_ads", requiredDisclaimers: ["tiktok disclaimer"] }
      ]
    },
    branchVariantIndex: 1,
    segmentIndex: 2,
    sliceDurationSec: 12,
    currentSlice: { seedanceSliceIndex: 2, storySegmentIndex: 2, continuityGroupId: "cg_story", durationSec: 12 },
    options
  };
}

function messagesText(messages) {
  return messages.map((message) => message.content).join("\n\n");
}

test("compact plan prompt keeps current story segment detail only", () => {
  const text = messagesText(buildSeedancePlanMessages(baseInput({ compact: true })));
  assert.match(text, /产品承接/);
  assert.match(text, /current slice detail/);
  assert.match(text, /adjacentStorySegments/);
  assert.match(text, /narrativePacingPlan/);
  assert.match(text, /a secret debt breaks trust/);
  assert.doesNotMatch(text, /"timelineItems":\s*\[\s*\{\s*"content":\s*"opening"/);
  assert.doesNotMatch(text, /"timelineItems":\s*\[\s*\{\s*"content":\s*"ending"/);
});

test("compact plan prompt filters channel rules to branch target channels", () => {
  const text = messagesText(buildSeedancePlanMessages(baseInput({ compact: true })));
  assert.match(text, /meta_ads/);
  assert.match(text, /meta disclaimer/);
  assert.doesNotMatch(text, /tiktok_ads/);
  assert.doesNotMatch(text, /tiktok disclaimer/);
});

test("full plan prompt keeps all story segment detail", () => {
  const text = messagesText(buildSeedancePlanMessages(baseInput({ compact: false })));
  assert.match(text, /opening/);
  assert.match(text, /current slice detail/);
  assert.match(text, /ending/);
});
