import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  repairFormalPlanContract,
  repairSeedancePromptContract
} from "../../server/wangzhuan/plan-repair.mjs";

const execFileAsync = promisify(execFile);

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
  const root = await mkdtemp(join(tmpdir(), "formal-plan-repair-products-"));
  const sourcePlanPath = join(root, "seedance-plan.json");
  const analysisPath = join(root, "analysis.json");
  await writeFile(sourcePlanPath, JSON.stringify({
    language: "pt-BR",
    region: "BR",
    productName: "Source Product",
    slices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 9,
        durationSec: 9,
        segmentRole: "hook_slice",
        scene: "apartment argument opening",
        subject: "source host holding phone",
        action: "reacts to drama twist and reward counter",
        camera: "handheld close-up reaction",
        lighting: "natural indoor light",
        style: "realistic UGC vertical ad",
        quality: "realistic 720p vertical video",
        coreHook: "drama conflict reveals app proof",
        explosivePoint: "reward counter rises after app action",
        segmentStructureSkeleton: "shock reaction -> phone proof -> reward feedback",
        segmentRhythm: "fast opening, quick proof beats",
        seedancePrompt: "UGC phone proof shot with $50 reward feedback.",
        imagePrompt: "Phone close-up in apartment.",
        negativePrompt: "No watermark.",
        conversionSignals: {
          earningsNumber: {
            present: true,
            shouldReplicate: true,
            evidence: "reward number rises on phone",
            roleInVideo: "result proof"
          },
          cashCoinFeedback: {
            present: true,
            shouldReplicate: true,
            evidence: "coin burst after app action",
            roleInVideo: "reward feedback"
          }
        },
        conversionEffectOpportunities: [
          { effect: "withdrawal_record", placement: "phone UI proof", reason: "reference has result proof slot" }
        ],
        voiceoverObserved: {
          present: true,
          emotion: "excited",
          pace: "fast",
          energy: "high"
        }
      },
      {
        storySegmentIndex: 2,
        seedanceSliceIndex: 1,
        startSec: 9,
        endSec: 21,
        durationSec: 12,
        segmentRole: "proof_slice",
        scene: "commute app proof",
        subject: "source user checking phone",
        action: "scrolls product UI and sees progress rise",
        camera: "phone close-up then face reaction",
        lighting: "daylight commute",
        style: "realistic UGC vertical ad",
        quality: "realistic 720p vertical video",
        coreHook: "proof continues on phone",
        explosivePoint: "top balance keeps rising",
        segmentStructureSkeleton: "app browsing -> reward/progress proof",
        segmentRhythm: "medium-fast proof sequence",
        seedancePrompt: "Phone UI proof sequence.",
        imagePrompt: "Phone UI close-up.",
        negativePrompt: "No watermark.",
        conversionSignals: {
          fastRewardCue: {
            present: true,
            shouldReplicate: true,
            evidence: "quick reward cue after tap",
            roleInVideo: "low barrier proof"
          }
        },
        conversionEffectOpportunities: [
          { effect: "top_balance_growth", placement: "top overlay", reason: "reference has top proof slot" }
        ]
      }
    ]
  }, null, 2));
  await writeFile(analysisPath, JSON.stringify({
    sourceVideoProfile: {
      durationSec: 21,
      language: "pt-BR",
      productType: "short drama reward app",
      personaSummary: "fast emotional app proof",
      sceneCount: 2,
      ctaType: "download"
    },
    wholeVideoConversion: {
      coreConversionTone: "fast drama hook with reward proof",
      mainPersuasionPath: "drama shock -> app proof -> reward feedback",
      globalRhythm: "fast opening and proof beats",
      mainSellingLogic: "short drama plus reward packaging",
      productRoleInVideo: "phone app proof with reward feedback",
      referenceVideoStructureSummary: "two source story segments"
    },
    fissionStrategy: {
      preserveOverallTone: "fast drama hook with reward proof"
    }
  }, null, 2));

  const cases = [
    {
      label: "ReelMate_CN",
      productDir: "product_info/ReelMate_DramaChat",
      region: "中国",
      targetRegion: "CN",
      language: "zh-CN",
      currency: "¥"
    },
    {
      label: "ReelMate_ID",
      productDir: "product_info/ReelMate_DramaChat",
      region: "印尼",
      targetRegion: "ID",
      language: "id-ID",
      currency: "Rp"
    },
    {
      label: "DramaWin_ID",
      productDir: "product_info/DramaWin",
      region: "印尼",
      targetRegion: "ID",
      language: "id-ID",
      currency: "Rp"
    },
    {
      label: "DramaWin_CN",
      productDir: "product_info/DramaWin",
      region: "中国",
      targetRegion: "CN",
      language: "zh-CN",
      currency: "¥"
    }
  ];

  for (const item of cases) {
    const outputPath = join(root, `${item.label}.json`);
    await execFileAsync(process.execPath, [
      "tmp/seedance-segment-debug/dramagold_40155_formal_plan/build-formal-plan.mjs"
    ], {
      cwd: resolve("."),
      encoding: "utf8",
      timeout: 20000,
      env: {
        ...process.env,
        PRODUCT_DIR: item.productDir,
        SOURCE_PLAN_PATH: sourcePlanPath,
        SOURCE_ANALYSIS_PATH: analysisPath,
        FORMAL_PLAN_PATH: outputPath,
        FISSION_VERSION_ID: `${item.label}_repair_test`,
        TARGET_REGION: item.region,
        TARGET_LANGUAGE: item.language,
        CURRENCY_SYMBOL: item.currency,
        ENABLE_CONVERSION_EFFECTS: "1"
      }
    });
    const output = JSON.parse(await readFile(outputPath, "utf8"));
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
      assert.ok(plan.sliceDurationSec >= 5 && plan.sliceDurationSec <= 30, `${item.label} plan ${index}`);
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
