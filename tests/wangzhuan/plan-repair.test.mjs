import assert from "node:assert/strict";
import test from "node:test";

import {
  repairSeedancePromptContract,
  copyrightMusicRestriction,
  repairFormalPlanContract,
  MANDATORY_HIGH_ATTRACTION_MONEY_VISUALS
} from "../../server/wangzhuan/plan-repair.mjs";

test("repairSeedancePromptContract locks language region currency subtitle and carrier visual", () => {
  const prompt = repairSeedancePromptContract("UGC shot with $50 payout text.", {
    targetLanguage: "id-ID",
    targetRegion: "ID",
    currencySymbol: "Rp",
    currencyName: "Indonesian rupiah",
    localeIdentity: "Indonesian Bahasa-speaking people in Jakarta-style commute scenes",
    characterDiversity: "Indonesian office worker in cafe, batik-accent shirt",
    moneyVisuals: ["coin_burst"],
    conversionEffectOpportunities: [{ effect: "cash_rain", placement: "top overlay" }],
    mandatoryMoneyVisualCarrier: true
  });

  assert.match(prompt, /targetLanguage=id-ID/);
  assert.match(prompt, /visible scene text/);
  assert.match(prompt, /voiceover, spoken dialogue/);
  assert.match(prompt, /use id-ID only/);
  assert.match(prompt, /Do not show Chinese/);
  assert.match(prompt, /targetRegion=ID/);
  assert.match(prompt, /Rp/);
  assert.doesNotMatch(prompt, /\$50/);
  assert.match(prompt, /no burned subtitles/i);
  assert.match(prompt, /no dense text blocks/i);
  assert.match(prompt, /avoid AI-generated gibberish text/i);
  assert.match(prompt, /do not generate disclaimer/i);
  assert.match(prompt, /Mandatory wangzhuan visual carrier repair/);
  assert.match(prompt, /Voiceover performance repair/);
  assert.match(prompt, /high-energy, fast-paced, emotionally expressive/);
  assert.match(prompt, /copyrighted music|berhak cipta/i);
});

test("repairSeedancePromptContract localizes the copyright music restriction", () => {
  const prompt = repairSeedancePromptContract("UGC shot.", { sourceLanguage: "zh-CN" });
  assert.match(prompt, /禁止使用版权音乐。只使用原创、免版税或已获授权的音频。/);
  assert.doesNotMatch(prompt, /copyrighted music/i);
});

test("copyrightMusicRestriction falls back to English", () => {
  assert.match(copyrightMusicRestriction("en-US"), /Do not use copyrighted music/);
});

test("repairFormalPlanContract injects mandatory visuals only on carrier slice", () => {
  const carrier = repairFormalPlanContract({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Clean app proof shot.",
    imagePrompt: "Phone close-up.",
    negativePrompt: "No watermark.",
    subtitles: ["打开应用"]
  }, {
    targetLanguage: "zh-CN",
    targetRegion: "CN",
    currencySymbol: "¥",
    currencyName: "Chinese yuan",
    mandatoryMoneyVisualCarrier: true,
    sliceDurationSec: 12
  });

  assert.equal(carrier.sliceDurationSec, 12);
  assert.equal(carrier.cta, "继续");
  assert.equal(carrier.ending, "继续按步骤体验");
  assert.ok(MANDATORY_HIGH_ATTRACTION_MONEY_VISUALS.some((item) => carrier.moneyVisuals.includes(item)));
  assert.match(carrier.seedancePrompt, /Mandatory wangzhuan visual carrier repair/);
  assert.match(carrier.seedancePrompt, /Voiceover performance repair/);

  const nonCarrier = repairFormalPlanContract({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Clean drama scene.",
    imagePrompt: "Drama screen.",
    negativePrompt: "No watermark.",
    subtitles: ["继续观看"]
  }, {
    targetLanguage: "zh-CN",
    targetRegion: "CN",
    currencySymbol: "¥",
    mandatoryMoneyVisualCarrier: false,
    isOpeningSlice: false
  });

  assert.deepEqual(nonCarrier.moneyVisuals, []);
  assert.equal(nonCarrier.cta, "继续");
  assert.equal(nonCarrier.ending, "继续按步骤体验");
  assert.doesNotMatch(nonCarrier.seedancePrompt, /Mandatory wangzhuan visual carrier repair/);
});

test("repairFormalPlanContract front-loads opening hook energy", () => {
  const repaired = repairFormalPlanContract({
    hook: "打开手机",
    body: "用户说明 app 怎么用",
    seedancePrompt: "A person calmly walks and opens the phone.",
    imagePrompt: "Person with phone.",
    negativePrompt: "No watermark.",
    subtitles: ["先打开看看"]
  }, {
    targetLanguage: "zh-CN",
    targetRegion: "CN",
    currencySymbol: "¥",
    isOpeningSlice: true,
    mandatoryMoneyVisualCarrier: true,
    voiceoverPerformance: "情绪高昂、节奏很快、感染力强的真人口播",
    openingHookRepair: "第一秒先看到金币爆发和奖励进度快速上涨，再切人物强反应"
  });

  assert.match(repaired.seedancePrompt, /Opening hook repair/);
  assert.match(repaired.seedancePrompt, /第一秒先看到金币爆发/);
  assert.match(repaired.seedancePrompt, /情绪高昂、节奏很快、感染力强/);
  assert.ok(repaired.complianceNotes.some((item) => /opening slice must start with a high-impact hook/.test(item)));
});

test("repairFormalPlanContract keeps subtitles in subtitleWorkflow", () => {
  const repaired = repairFormalPlanContract({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Phone app shot with captions.",
    imagePrompt: "Phone close-up.",
    negativePrompt: "No watermark.",
    subtitles: ["领取奖励", "继续看剧"],
    subtitleWorkflow: { postSubtitleRequired: true, provider: "pixel_tech", subtitleScript: [] }
  }, {
    targetLanguage: "zh-CN",
    targetRegion: "CN",
    currencySymbol: "¥"
  });

  assert.equal(repaired.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(repaired.subtitleWorkflow.provider, "pixel_tech");
  assert.deepEqual(repaired.subtitleWorkflow.subtitleScript, ["领取奖励", "继续看剧"]);
  assert.match(repaired.seedancePrompt, /no burned subtitles/i);
});

test("repairFormalPlanContract clamps slice duration to 5-15 seconds", () => {
  const basePlan = {
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Clean app proof shot.",
    imagePrompt: "Phone close-up.",
    negativePrompt: "No watermark."
  };

  assert.equal(repairFormalPlanContract({ ...basePlan, sliceDurationSec: 4 }, {}).sliceDurationSec, 5);
  assert.equal(repairFormalPlanContract({ ...basePlan, sliceDurationSec: 7.2 }, {}).sliceDurationSec, 7.2);
  assert.equal(repairFormalPlanContract({ ...basePlan, sliceDurationSec: 31 }, {}).sliceDurationSec, 15);
  assert.equal(repairFormalPlanContract({ ...basePlan, sliceDurationSec: 17 }, {}).sliceDurationSec, 15);
});
