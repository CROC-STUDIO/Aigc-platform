import assert from "node:assert/strict";
import test from "node:test";

import {
  repairFormalPlanContract,
  repairSeedancePromptContract
} from "../../server/wangzhuan/plan-repair.mjs";

test("repairSeedancePromptContract appends language region currency subtitle and diversity constraints", () => {
  const repaired = repairSeedancePromptContract("UGC phone proof shot with $50 reward text.", {
    targetLanguage: "id-ID",
    targetRegion: "ID",
    currencySymbol: "Rp",
    currencyName: "Indonesian rupiah",
    localeIdentity: "Indonesian Bahasa-speaking people in Jakarta-style commute scenes",
    characterDiversity: "Indonesian office worker in cafe, batik-accent shirt",
    moneyVisuals: ["top_balance_growth", "coin_burst"],
    conversionEffectOpportunities: [{ effect: "cash_rain", placement: "top overlay" }]
  });

  assert.match(repaired, /targetLanguage=id-ID/);
  assert.match(repaired, /targetRegion=ID/);
  assert.match(repaired, /Rp/);
  assert.match(repaired, /Indonesian Bahasa-speaking people/);
  assert.match(repaired, /Character diversity requirement/);
  assert.match(repaired, /no burned subtitles/i);
  assert.match(repaired, /top_balance_growth, coin_burst, cash_rain/);
  assert.doesNotMatch(repaired, /\$50/);
});

test("repairFormalPlanContract normalizes contract fields and carries conversionEffectOpportunities", () => {
  const repaired = repairFormalPlanContract({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Phone UI proof with reward feedback.",
    imagePrompt: "Phone close-up.",
    negativePrompt: "No watermark.",
    conversionSignals: {
      earningsNumber: {
        present: true,
        shouldReplicate: true,
        evidence: "reward number rises",
        roleInVideo: "result proof"
      }
    },
    conversionEffectOpportunities: [{ effect: "withdrawal_record", placement: "phone UI" }]
  }, {
    targetLanguage: "zh-CN",
    targetRegion: "CN",
    currencySymbol: "¥",
    currencyName: "Chinese yuan",
    localeIdentity: "Mainland Chinese Mandarin-speaking people",
    sourceSlice: {
      durationSec: 12,
      conversionEffectOpportunities: [{ effect: "cash_rain", placement: "reward beat" }]
    },
    defaultSubtitles: ["打开应用，马上继续看"],
    characterDiversity: "Chinese office worker on subway commute, light jacket",
    isOpeningSlice: true
  });

  assert.equal(repaired.targetLanguage, "zh-CN");
  assert.equal(repaired.targetRegion, "CN");
  assert.equal(repaired.currencySymbol, "¥");
  assert.equal(repaired.sliceDurationSec, 12);
  assert.deepEqual(repaired.subtitles, ["打开应用，马上继续看"]);
  assert.match(repaired.voiceover, /打开应用/);
  assert.deepEqual([...repaired.moneyVisuals].sort(), [
    "cash_rain",
    "coin_burst",
    "continuous_earnings_rise",
    "full_screen_coin_rain",
    "full_screen_money_rain",
    "real_cash_sound_cue",
    "real_cash_stack",
    "reward_number_growth",
    "top_balance_growth",
    "withdrawal_success"
  ].sort());
  assert.match(repaired.withdrawalVisual, /¥/);
  assert.match(repaired.seedancePrompt, /targetLanguage=zh-CN/);
  assert.match(repaired.seedancePrompt, /no burned subtitles/i);
  assert.match(repaired.seedancePrompt, /withdrawal_success/);
  assert.match(repaired.seedancePrompt, /final-video carrier/);
  assert.ok(repaired.moneyVisuals.includes("real_cash_stack"));
  assert.ok(repaired.moneyVisuals.includes("full_screen_money_rain"));
  assert.ok(repaired.moneyVisuals.includes("full_screen_coin_rain"));
  assert.ok(repaired.conversionEffectOpportunities.some((item) => item.effect === "withdrawal_success"));
  assert.ok(repaired.complianceNotes.some((item) => /Repair applied/.test(item)));
});

test("repairFormalPlanContract forces wangzhuan visuals on final-video carrier slice", () => {
  const repaired = repairFormalPlanContract({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Clean drama app continuation shot.",
    imagePrompt: "Drama app screen.",
    negativePrompt: "No watermark.",
    conversionSignals: {}
  }, {
    targetLanguage: "id-ID",
    targetRegion: "ID",
    currencySymbol: "Rp",
    currencyName: "Indonesian rupiah",
    defaultSubtitles: ["Lanjutkan menonton sekarang"],
    characterDiversity: "Indonesian creator on urban street",
    mandatoryMoneyVisualCarrier: true
  });

  assert.ok(repaired.moneyVisuals.includes("real_cash_stack"));
  assert.ok(repaired.moneyVisuals.includes("coin_burst"));
  assert.ok(repaired.moneyVisuals.includes("cash_rain"));
  assert.ok(repaired.moneyVisuals.includes("full_screen_money_rain"));
  assert.ok(repaired.moneyVisuals.includes("full_screen_coin_rain"));
  assert.match(repaired.seedancePrompt, /Mandatory wangzhuan visual carrier repair/);
  assert.match(repaired.seedancePrompt, /real_cash_stack/);
  assert.match(repaired.seedancePrompt, /Rp/);
});

test("repairFormalPlanContract does not force high-attraction visuals on non-carrier clean slice", () => {
  const repaired = repairFormalPlanContract({
    hook: "Hook",
    body: "Body",
    seedancePrompt: "Clean drama app continuation shot.",
    imagePrompt: "Drama app screen.",
    negativePrompt: "No watermark.",
    conversionSignals: {}
  }, {
    targetLanguage: "zh-CN",
    targetRegion: "CN",
    currencySymbol: "¥",
    currencyName: "Chinese yuan",
    defaultSubtitles: ["继续看下一集"],
    characterDiversity: "Chinese creator in quiet bedroom",
    mandatoryMoneyVisualCarrier: false,
    isOpeningSlice: false
  });

  assert.deepEqual(repaired.moneyVisuals, []);
  assert.doesNotMatch(repaired.seedancePrompt, /Mandatory wangzhuan visual carrier repair/);
});

test("build-formal-plan repair works for ReelMate and DramaWin across China and Indonesia", async () => {
  const sourceSlices = [
    {
      segmentIndex: 1,
      durationSec: 9,
      seedancePrompt: "UGC phone proof shot with $50 reward feedback.",
      conversionSignals: {
        earningsNumber: { present: true, shouldReplicate: true },
        cashCoinFeedback: { present: true, shouldReplicate: true }
      },
      conversionEffectOpportunities: [
        { effect: "withdrawal_record", placement: "phone UI proof", reason: "reference has result proof slot" }
      ]
    },
    {
      segmentIndex: 2,
      durationSec: 12,
      seedancePrompt: "Phone UI proof sequence.",
      conversionSignals: {
        fastRewardCue: { present: true, shouldReplicate: true }
      },
      conversionEffectOpportunities: [
        { effect: "top_balance_growth", placement: "top overlay", reason: "reference has top proof slot" }
      ]
    }
  ];
  const cases = [
    {
      label: "ReelMate_CN",
      targetRegion: "CN",
      language: "zh-CN",
      currency: "¥",
      defaultSubtitles: ["打开应用，马上继续看"]
    },
    {
      label: "ReelMate_ID",
      targetRegion: "ID",
      language: "id-ID",
      currency: "Rp",
      defaultSubtitles: ["Buka aplikasi dan lanjutkan"]
    },
    {
      label: "DramaWin_ID",
      targetRegion: "ID",
      language: "id-ID",
      currency: "Rp",
      defaultSubtitles: ["Unduh sekarang dan lanjutkan"]
    },
    {
      label: "DramaWin_CN",
      targetRegion: "CN",
      language: "zh-CN",
      currency: "¥",
      defaultSubtitles: ["下载后继续观看"]
    }
  ];

  for (const item of cases) {
    const output = {
      targetLanguage: item.language,
      targetRegion: item.targetRegion,
      currencySymbol: item.currency,
      plans: sourceSlices.map((sourceSlice) => repairFormalPlanContract({
        segmentIndex: sourceSlice.segmentIndex,
        seedancePrompt: sourceSlice.seedancePrompt,
        conversionSignals: sourceSlice.conversionSignals,
        conversionEffectOpportunities: sourceSlice.conversionEffectOpportunities
      }, {
        targetLanguage: item.language,
        targetRegion: item.targetRegion,
        currencySymbol: item.currency,
        currencyName: item.currency === "¥" ? "Chinese yuan" : "Indonesian rupiah",
        defaultSubtitles: item.defaultSubtitles,
        characterDiversity: `${item.label} localized product user`,
        sourceSlice,
        isOpeningSlice: sourceSlice.segmentIndex === 1,
        mandatoryMoneyVisualCarrier: sourceSlice.segmentIndex === 1
      }))
    };

    assert.equal(output.targetLanguage, item.language, item.label);
    assert.equal(output.targetRegion, item.targetRegion, item.label);
    assert.equal(output.currencySymbol, item.currency, item.label);
    assert.equal(output.plans.length, 2, item.label);

    const mandatoryVisuals = [
      "real_cash_stack",
      "coin_burst",
      "cash_rain",
      "full_screen_money_rain",
      "full_screen_coin_rain"
    ];
    assert.ok(
      output.plans.some((plan) => mandatoryVisuals.some((visual) => plan.moneyVisuals.includes(visual))),
      `${item.label} final video has at least one high-attraction money visual`
    );
    assert.ok(
      mandatoryVisuals.some((visual) => output.plans[0].moneyVisuals.includes(visual)),
      `${item.label} first slice is the default high-attraction visual carrier`
    );

    for (const [index, plan] of output.plans.entries()) {
      assert.equal(plan.targetLanguage, item.language, `${item.label} plan ${index}`);
      assert.equal(plan.targetRegion, item.targetRegion, `${item.label} plan ${index}`);
      assert.equal(plan.currencySymbol, item.currency, `${item.label} plan ${index}`);
      assert.ok(plan.repairApplied, `${item.label} plan ${index}`);
      assert.ok(plan.sliceDurationSec >= 5 && plan.sliceDurationSec <= 15, `${item.label} plan ${index}`);
      assert.ok(plan.subtitles.length >= 1 && plan.subtitles.length <= 2, `${item.label} plan ${index}`);
      assert.match(plan.seedancePrompt, new RegExp(`targetLanguage=${item.language}`), `${item.label} plan ${index}`);
      assert.match(plan.seedancePrompt, new RegExp(`targetRegion=${item.targetRegion}`), `${item.label} plan ${index}`);
      assert.match(plan.seedancePrompt, new RegExp(item.currency === "¥" ? "¥" : "Rp"), `${item.label} plan ${index}`);
      assert.match(plan.seedancePrompt, /no burned subtitles/i, `${item.label} plan ${index}`);
      assert.match(plan.seedancePrompt, /Character diversity requirement/, `${item.label} plan ${index}`);
      assert.doesNotMatch(plan.seedancePrompt, /\$50/, `${item.label} plan ${index}`);
    }
    assert.match(output.plans[0].seedancePrompt, /Mandatory wangzhuan visual carrier repair/, item.label);
    assert.ok(output.plans[0].conversionEffectOpportunities.length > 0, item.label);
    assert.ok(output.plans[0].moneyVisuals.includes("withdrawal_success"), item.label);
    assert.ok(output.plans[0].conversionEffectOpportunities.some((effect) => effect.effect === "withdrawal_success"), item.label);
    if (item.language === "zh-CN") {
      assert.ok(output.plans[0].subtitles.some((line) => /打开|下载|观看/.test(line)), item.label);
    } else {
      assert.ok(output.plans[0].subtitles.some((line) => /Buka|Unduh|Lanjutkan/.test(line)), item.label);
    }
  }
});
