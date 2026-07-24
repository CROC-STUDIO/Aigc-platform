import assert from "node:assert/strict";
import test from "node:test";

import {
  buildThirtySecondSeedancePlanMessages,
  buildSeedancePlanMessages,
  generateSeedancePlan,
  generateThirtySecondSeedancePlans,
  validateBranchTruthRulesForPlan,
  validateSeedancePlan
} from "../../server/wangzhuan/plan-preview.mjs";

function messagesText(messages) {
  return messages.map((message) => message.content).join("\n\n");
}

test("Seedance plan prompt tolerates a missing decomposition", () => {
  assert.doesNotThrow(() => buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_missing_decomposition",
      templateSnapshot: { draft: { productName: "Drama App", language: "zh-CN", regions: ["CN"] } },
      estimate: { request: { language: "zh-CN", targetRegions: ["CN"] } }
    },
    branch: {
      branchId: "branch_1",
      productName: "Drama App",
      languages: ["zh-CN"],
      regions: ["CN"],
      truthRules: {}
    },
    decomposition: null,
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12,
    currentSlice: {}
  }));
});

test("short drama Seedance plans reserve market rules for the final app introduction", () => {
  const batch = {
    request: { sourceType: "story_seed" },
    templateSnapshot: { draft: { language: "zh-CN", regions: ["US"], currencySymbol: "$" } },
    estimate: { request: { sourceType: "story_seed", targetChannel: "meta_ads", promiseLevel: "strong_conversion" } }
  };
  const branch = { branchId: "branch_1", languages: ["zh-CN"], regions: ["US"], currencySymbol: "$", truthRules: {} };
  const messages = buildSeedancePlanMessages({ batch, branch, decomposition: { storySegments: [] }, channelRules: { rules: [{ channel: "meta_ads" }] }, branchVariantIndex: 1, segmentIndex: 1, sliceDurationSec: 10, currentSlice: {} });
  const text = messagesText(messages);
  assert.match(text, /恰好 4-5 个/);
  assert.match(text, /不要使用投放渠道、目标地区、币种/);
  assert.doesNotMatch(text, /targetChannel=meta_ads/);
  const finalText = messagesText(buildSeedancePlanMessages({ batch, branch, decomposition: { storySegments: [] }, channelRules: { rules: [{ channel: "meta_ads" }] }, branchVariantIndex: 1, segmentIndex: 3, sliceDurationSec: 10, currentSlice: {}, isFinalSeedanceSlice: true }));
  assert.match(finalText, /前 6-7 秒必须完成独立剧集高潮与反转/);
  assert.match(finalText, /最后 3-4 秒允许/);
  assert.match(finalText, /targetChannel=meta_ads/);
  assert.throws(() => validateSeedancePlan({ hook: "h", body: "b", imagePrompt: "i", seedancePrompt: "p", negativePrompt: "n", sliceBeatScript: [{}, {}, {}] }, { isStorySeed: true }), { code: "schema_invalid" });
});

test("Seedance plan prompt includes fission story segment and carrier context", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260709120000_abcd",
      templateSnapshot: { draft: { productName: "Drama App", language: "zh-CN", regions: ["CN"], currencySymbol: "¥" } },
      estimate: { request: { targetRegions: ["CN"], language: "zh-CN" } }
    },
    branch: {
      branchId: "branch_1",
      productName: "Drama App",
      languages: ["zh-CN"],
      regions: ["CN"],
      currencySymbol: "¥",
      truthRules: {}
    },
    decomposition: {
      wholeVideoConversion: { coreConversionTone: "fast proof with drama hook" },
      narrativePacingPlan: {
        appliesToContinuityGroupIds: ["cg_story"],
        centralConflict: "a family accusation escalates when phone evidence appears",
        beatSheet: [{ startSec: 0, endSec: 3, change: "one accusation changes the relationship" }],
        reversalPoints: [{ timestampSec: 8, reveal: "the accused person reveals proof" }],
        compressionWarnings: ["remove greetings and repeated explanation"]
      },
      storySegments: [{
        storySegmentIndex: 1,
        continuityGroupId: "cg_story",
        segmentRhythm: "fast opening",
        segmentStructureSkeleton: "conflict hook -> reward proof",
        timelineItems: [{ startSec: 0, endSec: 2, type: "drama_action", content: "conflict" }],
        conversionSignals: { earningsNumber: { present: true, shouldReplicate: true, evidence: "counter rises" } },
        conversionEffectOpportunities: [{ effect: "coin_burst", placement: "phone tap" }]
      }]
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12,
    currentSlice: {
      storySegmentIndex: 1,
      continuityGroupId: "cg_story",
      durationSec: 12,
      conversionEffectOpportunities: [{ effect: "coin_burst", placement: "phone tap" }]
    },
    mandatoryMoneyVisualCarrier: true
  });

  const text = messagesText(messages);
  assert.match(text, /fast proof with drama hook/);
  assert.match(text, /segmentStructureSkeleton/);
  assert.match(text, /conversionEffectOpportunities/);
  assert.match(text, /mandatoryMoneyVisualCarrier/);
  assert.match(text, /final-video high-attraction/);
  assert.match(text, /强视觉\/强开头\/强口播统一规则/);
  assert.match(text, /前 1-2 秒必须先给高吸引力场景/);
  assert.match(text, /情绪高昂、节奏快、感染力强/);
  assert.match(text, /high-energy, fast-paced, emotionally expressive, contagious delivery/);
  assert.match(text, /优先按已有 seedanceSlices 执行/);
  assert.match(text, /基于 storySegments \+ sliceSplitHints 自动切片/);
  assert.match(text, /narrativePacingPlan/);
  assert.match(text, /a family accusation escalates/);
  assert.match(text, /每 2-4 秒/);
  assert.match(text, /每 6-10 秒/);
  assert.match(text, /删除空镜、寒暄、走路过场、重复解释/);
});

test("continuous slices preserve identity scene UI voice and audio instead of applying diversity", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_continuity_prompt",
      templateSnapshot: { draft: { productName: "Drama App", language: "zh-CN", regions: ["CN"] } },
      estimate: { request: { language: "zh-CN", targetRegions: ["CN"] } }
    },
    branch: {
      branchId: "branch_1",
      productName: "Drama App",
      languages: ["zh-CN"],
      regions: ["CN"],
      truthRules: {}
    },
    decomposition: {
      sourceAssemblyMode: "continuous_story",
      continuityPlan: {
        groups: [{
          continuityGroupId: "cg_1",
          storySegmentIndexes: [1, 2, 3],
          globalAnchors: {
            protagonist: "same courier",
            wardrobe: "blue jacket",
            scene: "same apartment",
            productUi: "reward popup remains open",
            voiceAndAudio: "same speaker and room tone"
          }
        }]
      },
      storySegments: [{
        storySegmentIndex: 2,
        continuityGroupId: "cg_1",
        startSec: 12,
        endSec: 24,
        durationSec: 12
      }]
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 2,
    sliceDurationSec: 12,
    currentSlice: {
      storySegmentIndex: 2,
      seedanceSliceIndex: 2,
      continuityGroupId: "cg_1",
      continuitySliceId: "cg_1_slice_2",
      previousSliceId: "cg_1_slice_1",
      continuityMode: "continuous_from_previous",
      startFrameState: { pose: "phone remains raised", productUi: "reward popup remains open" },
      endFrameState: { pose: "turns toward the door" },
      globalContinuityAnchors: { protagonist: "same courier", wardrobe: "blue jacket" },
      durationSec: 12
    },
    totalSegmentCount: 3
  });

  const text = messagesText(messages);
  assert.match(text, /连续性切片/);
  assert.match(text, /人物身份、服装、场景、产品\/UI、姿态、声音与环境音/);
  assert.match(text, /不得套用默认换人、换场、换服装、换声音/);
  assert.match(text, /"previousSliceId": "cg_1_slice_1"/);
  assert.match(text, /"protagonist": "same courier"/);

  const validated = validateSeedancePlan({
    hook: "continue",
    body: "continue from the prior frame",
    imagePrompt: "same subject and scene",
    seedancePrompt: "use the previous continuity frame",
    negativePrompt: "no identity drift",
    sliceDiversity: {
      personChangedFromPrevious: true,
      sceneChangedFromPrevious: true,
      clothingChangedFromPrevious: true,
      voiceChangedFromPrevious: true
    }
  }, { forceContinuity: true });
  assert.deepEqual(validated.sliceDiversity, {
    personChangedFromPrevious: false,
    sceneChangedFromPrevious: false,
    clothingChangedFromPrevious: false,
    voiceChangedFromPrevious: false
  });
});

test("continuous plan repair suppresses empty diversity and preserves continuity anchors", async () => {
  const context = {
    callWangzhuanLlm: async () => JSON.stringify({
      hook: "Continue the indoor story",
      body: "Continue from the prior shot",
      voiceover: "Keep watching",
      subtitles: ["Keep watching"],
      cta: "",
      ending: "",
      imagePrompt: "Same ensemble and room.",
      seedancePrompt: "Continue the same indoor ensemble scene from the previous frame.",
      negativePrompt: "No identity drift.",
      sliceDiversity: {
        personChangedFromPrevious: true,
        sceneChangedFromPrevious: true,
        clothingChangedFromPrevious: true,
        voiceChangedFromPrevious: true
      }
    })
  };

  const plan = await generateSeedancePlan(context, {
    batch: { templateSnapshot: { draft: { productName: "App", language: "en-US", regions: ["US"] } }, estimate: { request: {} } },
    branch: { branchId: "b1", productName: "App", languages: ["en-US"], regions: ["US"], truthRules: {} },
    decomposition: {},
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 2,
    sliceDurationSec: 10,
    currentSlice: {
      segmentIndex: 2,
      continuityMode: "continuous_from_previous",
      previousSliceId: "cg_story_slice_1",
      startFrameState: { cast: "same woman and man", wardrobe: "fixed coats and suit" },
      endFrameState: { action: "the conversation continues" },
      globalContinuityAnchors: { scene: "same living room", relationship: "same ensemble" },
      variableLayers: []
    }
  });

  assert.doesNotMatch(plan.seedancePrompt, /Character diversity requirement/);
  assert.doesNotMatch(plan.seedancePrompt, /must visibly differ from adjacent slices/);
  assert.match(plan.seedancePrompt, /Continuity preservation requirement/);
  assert.match(plan.seedancePrompt, /same living room/);
  assert.deepEqual(plan.sliceDiversity, {
    personChangedFromPrevious: false,
    sceneChangedFromPrevious: false,
    clothingChangedFromPrevious: false,
    voiceChangedFromPrevious: false
  });
});

test("story plan repair enforces compact causal beats in the final Seedance prompt", async () => {
  const context = {
    callWangzhuanLlm: async () => JSON.stringify({
      hook: "A confrontation begins",
      body: "The same argument continues",
      voiceover: "Tell me the truth",
      subtitles: ["Tell me the truth"],
      cta: "",
      ending: "",
      imagePrompt: "The same couple in one living room.",
      seedancePrompt: "A couple argues in a living room.",
      negativePrompt: "No identity drift."
    })
  };

  const plan = await generateSeedancePlan(context, {
    batch: { templateSnapshot: { draft: { productName: "App", language: "en-US", regions: ["US"] } }, estimate: { request: {} } },
    branch: { branchId: "b1", productName: "App", languages: ["en-US"], regions: ["US"], truthRules: {} },
    decomposition: {
      sourceAssemblyMode: "mixed",
      narrativePacingPlan: {
        appliesToContinuityGroupIds: ["cg_story"],
        centralConflict: "a hidden debt turns the couple against each other",
        beatSheet: [{ startSec: 0, endSec: 3, change: "an accusation interrupts the room" }],
        reversalPoints: [{ timestampSec: 8, reveal: "phone evidence reverses the accusation" }],
        compressionWarnings: ["remove repeated explanations"]
      },
      storySegments: [{
        storySegmentIndex: 1,
        continuityGroupId: "cg_story",
        timelineItems: [{ type: "drama_action", content: "confrontation" }]
      }]
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12,
    currentSlice: {
      storySegmentIndex: 1,
      continuityGroupId: "cg_story",
      continuityMode: "independent_slice"
    }
  });

  assert.match(plan.seedancePrompt, /Narrative pacing requirement/);
  assert.match(plan.seedancePrompt, /first second/i);
  assert.match(plan.seedancePrompt, /every 2-4 seconds/i);
  assert.match(plan.seedancePrompt, /every 6-10 seconds/i);
  assert.match(plan.seedancePrompt, /hidden debt/);
  assert.match(plan.seedancePrompt, /remove dead air/i);
});

test("product UI slices do not inherit the live-action narrative pacing rule", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      templateSnapshot: { draft: { productName: "App", language: "en-US", regions: ["US"] } },
      estimate: { request: {} }
    },
    branch: { branchId: "b1", productName: "App", languages: ["en-US"], regions: ["US"], truthRules: {} },
    decomposition: {
      sourceAssemblyMode: "mixed",
      narrativePacingPlan: {
        appliesToContinuityGroupIds: ["cg_story"],
        centralConflict: "a hidden debt breaks trust"
      },
      storySegments: [{
        storySegmentIndex: 2,
        continuityGroupId: "cg_product",
        style: "full-screen product UI demo",
        timelineItems: [{ type: "app_ui", content: "content library" }]
      }]
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 2,
    sliceDurationSec: 8,
    currentSlice: {
      storySegmentIndex: 2,
      continuityGroupId: "cg_product",
      segmentRole: "proof_slice"
    }
  });

  assert.doesNotMatch(messagesText(messages), /紧凑剧情硬规则/);
});

test("generateSeedancePlan repairs prompt before returning validated plan", async () => {
  const context = {
    callWangzhuanLlm: async () => JSON.stringify({
      hook: "Hook",
      body: "Body",
      voiceover: "Voiceover",
      subtitles: ["打开应用"],
      cta: "",
      ending: "",
      imagePrompt: "Phone proof.",
      seedancePrompt: "UGC shot with $50 reward text.",
      negativePrompt: "No watermark."
    })
  };

  const plan = await generateSeedancePlan(context, {
    batch: { templateSnapshot: { draft: { productName: "App", language: "zh-CN", regions: ["CN"], currencySymbol: "¥" } }, estimate: { request: {} } },
    branch: { branchId: "b1", productName: "App", languages: ["zh-CN"], regions: ["CN"], currencySymbol: "¥", truthRules: {} },
    decomposition: {},
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12,
    mandatoryMoneyVisualCarrier: true
  });

  assert.doesNotMatch(plan.seedancePrompt, /\$50/);
  assert.match(plan.seedancePrompt, /¥/);
  assert.match(plan.seedancePrompt, /no burned subtitles/i);
  assert.match(plan.seedancePrompt, /Opening hook repair/);
  assert.match(plan.seedancePrompt, /Voiceover performance repair/);
  assert.ok(plan.moneyVisuals.includes("real_cash_stack"));
});

test("generateSeedancePlan retries invalid JSON content and succeeds", async () => {
  let calls = 0;
  const context = {
    callWangzhuanLlm: async () => {
      calls += 1;
      if (calls === 1) return "{ invalid json";
      return JSON.stringify({
        hook: "Hook",
        body: "Body",
        voiceover: "Voiceover",
        subtitles: ["打开应用"],
        cta: "",
        ending: "",
        imagePrompt: "Phone proof.",
        seedancePrompt: "UGC shot with coin burst, no burned subtitles.",
        negativePrompt: "No watermark."
      });
    }
  };

  const plan = await generateSeedancePlan(context, {
    batch: { templateSnapshot: { draft: { productName: "App", language: "zh-CN", regions: ["CN"], currencySymbol: "¥" } }, estimate: { request: {} } },
    branch: { branchId: "b1", productName: "App", languages: ["zh-CN"], regions: ["CN"], currencySymbol: "¥", truthRules: {} },
    decomposition: {},
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12,
    mandatoryMoneyVisualCarrier: true
  });

  assert.equal(calls, 2);
  assert.match(plan.seedancePrompt, /coin|金币|cash|现金/i);
});

test("Seedance plan prompt requires visual reconstruction with Seedance formula", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260629120000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Reward App",
          productLink: "https://example.test/app",
          language: "en-US",
          regions: ["US"],
          currencySymbol: "$",
          defaultOutputRatio: "9:16"
        }
      },
      estimate: {
        request: {
          targetChannel: "tiktok"
        }
      }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "US casual",
      productName: "Reward App",
      productLink: "https://example.test/app",
      languages: ["en-US"],
      regions: ["US"],
      currencySymbol: "$",
      targetChannels: ["tiktok"],
      truthRules: {
        rewardAmountRange: "$1-$3",
        rewardCondition: "after completing eligible tasks"
      },
      assetUrls: {
        productIcon: "https://assets.test/icon.png",
        productScreenshot: "https://assets.test/screen.png",
        productRecording: "https://assets.test/recording.mp4"
      },
      assetFileNames: {
        productIcon: "icon.png",
        productScreenshot: "screen.png",
        productRecording: "recording.mp4"
      }
    },
    decomposition: {
      scene: "delivery worker checking phone outside a restaurant",
      subject: "delivery worker with a phone",
      protagonist: "delivery worker",
      action: "opens the app, sees a reward notification, reacts with surprise",
      camera: "fast phone close-up, cut to reaction shot",
      lighting: "bright daylight",
      style: "UGC performance ad",
      quality: "clean realistic mobile video",
      voiceover: "quick testimonial-style conversion"
    },
    channelRules: { rules: [] },
    branchVariantIndex: 2,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /主体 \+ 运动 \+ 环境 \+ 运镜\/切镜 \+ 美学描述 \+ 音频\/文字/);
  assert.match(text, /人物身份、职业\/人群、具体场景、服装、道具和具体情节必须全部重构/);
  assert.match(text, /scene、subject、action、camera、lighting、style、quality/);
  assert.match(text, /说明参考该素材的主体、构图、UI、动作、运镜或特效/);
  assert.match(text, /投放渠道 targetChannel=tiktok/);
  assert.match(text, /"targetChannel": "tiktok"/);
  assert.match(text, /"targetChannels": \[\s*"tiktok"\s*\]/);
  assert.match(text, /地区强控制：人物外观、人种\/肤色范围、发型、生活场景、职业身份、服装道具、城市\/室内环境/);
  assert.match(text, /用户可见文字强控制：seedancePrompt 与 imagePrompt 中出现的所有用户可见文字/);
  assert.match(text, /手机 UI、按钮、Slogan、CTA、弹窗、任务卡、奖励提示、进度条标签、页面标题/);
  assert.match(text, /币种强控制：所有用户可见金额、余额、提现档位、奖励金额、UI 金额符号/);
  assert.match(text, /不得混用其他币种符号或其他国家货币名称/);
  assert.match(text, /图片1 = 产品 Logo/);
  assert.match(text, /图片2 = 产品截图/);
  assert.match(text, /视频1 = 产品录屏/);
  assert.match(text, /默认不要生成 CTA 或 ending/);
  assert.match(text, /cta 和 ending 必须为空字符串/);
  assert.match(text, /禁止出现具体金额、点数增长、余额增长、提现金额、R\$ 数字/);
  assert.match(text, /金额、积分点数、奖励数值、门槛、到账条件/);
  assert.match(text, /当 promiseLevel 不是 strong_commitment 时，只能使用弱承诺表达/);
  assert.match(text, /当 promiseLevel 是 strong_commitment 时，可以表达强承诺，但必须严格受 truthRules 约束/);
  assert.match(text, /任何语言中的确定到账、直接到账、即时到账、保证提现、真实收入、固定收益、稳赚等强收益语义/);
  assert.doesNotMatch(text, /direto na conta/);
  assert.doesNotMatch(text, /reais de verdade/);
  assert.doesNotMatch(text, /branchVariantIndex=1 用原职业/);
  assert.doesNotMatch(text, /相似职业裂变/);
  assert.doesNotMatch(text, /必须继承参考拆解中的人物职业/);
});

test("Seedance plan prompt strongly binds locale to people, visible text, and currency", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260630120000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Reward App",
          language: "en-US",
          regions: ["US"],
          currencySymbol: "$"
        }
      },
      estimate: {
        request: {
          targetChannel: "meta_ads",
          targetRegions: ["BR"],
          languages: ["pt-BR"],
          currencySymbol: "R$"
        }
      }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "Brazil localized",
      productName: "Reward App",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      targetChannels: ["meta_ads"],
      truthRules: {}
    },
    decomposition: {
      scene: "worker discovers app after a stressful shift",
      subject: "worker with phone",
      action: "opens app and sees task feedback",
      camera: "vertical close-up",
      lighting: "natural",
      style: "UGC ad",
      quality: "clear"
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /主语言 primaryLanguage=pt-BR \(Portuguese \(Brazil\)\)/);
  assert.match(text, /目标地区 regions=BR \(Brazil\)/);
  assert.match(text, /货币符号 currencySymbol=R\$/);
  assert.match(text, /人物外观、人种\/肤色范围、发型、生活场景、职业身份、服装道具、城市\/室内环境/);
  assert.match(text, /全部使用 primaryLanguage/);
  assert.match(text, /不得混用非主语言文字/);
  assert.match(text, /所有用户可见金额、余额、提现档位、奖励金额、UI 金额符号、字幕金额和口播金额只能使用 currencySymbol/);
});

test("Seedance plan prompt includes Feishu wangzhuan output-template rules", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707120000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning",
          sliceStrategy: "auto_10_15s_multi_slice",
          moneyVisuals: ["coin_burst", "cash_rain", "withdrawal_success"],
          subtitleWorkflow: "post_process"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "BR workers",
      productName: "Drama Gold",
      language: "pt-BR",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "three_slice_net_earning",
      sliceStrategy: "auto_10_15s_multi_slice",
      moneyVisuals: ["coin_burst", "cash_rain", "withdrawal_success"],
      subtitleWorkflow: "post_process",
      promiseLevel: "strong_conversion",
      truthRules: {}
    },
    decomposition: {
      scene: "bus commute",
      subject: "commuter",
      action: "watches drama and checks rewards",
      camera: "handheld phone close-up",
      lighting: "daylight",
      style: "short-drama hook",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /出量模板由参考视频拆解决定/);
  assert.match(text, /切片策略由参考视频剧情段落决定/);
  assert.match(text, /优先按已有 seedanceSlices 执行/);
  assert.match(text, /storySegments \+ sliceSplitHints/);
  assert.match(text, /5-15s/);
  assert.match(text, /不要因为前端枚举值强行改成固定三段式或短剧高光模板/);
  assert.match(text, /人物、场景、服装.*变化/);
  assert.match(text, /主要依据参考视频拆解中该段是否存在对应结构/);
  assert.match(text, /真钞、金币、现金雨、金币爆发、满屏撒钱\/撒金币、收益数字增长、提现成功、到账动画、提现记录/);
  assert.match(text, /Seedance 原视频不得烧录字幕/);
  assert.match(text, /subtitleWorkflow/);
  assert.match(text, /无具体金额的数字增长|不含具体金额/);
  assert.match(text, /具体金额.*truthRules/);
});

test("Seedance plan prompt includes selected target segment count rules", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260709130000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          targetSegmentCount: 3
        }
      },
      estimate: {
        outputRatio: "9:16",
        request: {
          language: "pt-BR",
          targetRegions: ["BR"],
          targetSegmentCount: 3
        }
      }
    },
    branch: {
      branchId: "branch_1",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      targetSegmentCount: 3,
      truthRules: {}
    },
    decomposition: {
      storySegments: [{
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 26,
        durationSec: 26,
        scene: "home",
        subject: "student",
        action: "hook and proof",
        camera: "selfie",
        lighting: "warm",
        style: "UGC",
        quality: "clear"
      }]
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 9,
    currentSlice: { segmentIndex: 1, startSec: 0, endSec: 9, durationSec: 9 }
  });

  const text = messagesText(messages);
  assert.match(text, /"targetSegmentCount": 3/);
  assert.match(text, /user_selected_3_segments/);
  assert.match(text, /将参考视频剧情段落合并或拆分成用户选择的目标段数/);
  assert.match(text, /不要继续按原始拆解段数生成/);
});

test("Seedance plan prompt treats CTA and Ending images as final-tail only assets", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260709140000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Reward App",
          language: "zh-CN",
          regions: ["CN"],
          currencySymbol: "¥"
        }
      },
      estimate: { request: { language: "zh-CN", targetRegions: ["CN"] } }
    },
    branch: {
      branchId: "branch_1",
      productName: "Reward App",
      languages: ["zh-CN"],
      regions: ["CN"],
      currencySymbol: "¥",
      assetUrls: {
        productIcon: "https://assets.test/icon.png",
        ctaAsset: "https://assets.test/cta.png",
        endingAsset: "https://assets.test/ending.png"
      },
      assetFileNames: {
        productIcon: "icon.png",
        ctaAsset: "cta.png",
        endingAsset: "ending.png"
      },
      truthRules: {}
    },
    decomposition: {
      scene: "living room phone proof",
      subject: "viewer with phone",
      action: "checks reward feedback",
      camera: "close-up",
      lighting: "soft",
      style: "UGC",
      quality: "clear"
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1,
    segmentIndex: 2,
    totalSegmentCount: 2,
    isFinalSeedanceSlice: true
  });

  const text = messagesText(messages);
  assert.match(text, /CTA 图 \/ Ending 图引用规则/);
  assert.match(text, /仅图片尾图素材，不属于普通 Seedance 参考素材 slot/);
  assert.match(text, /isFinalSeedanceSlice=true/);
  assert.match(text, /最后一个 Seedance 切片会把 ctaAsset\/endingAsset 作为 closing tail/);
  assert.match(text, /最终视频分片中呈现/);
  assert.doesNotMatch(text, /ffmpeg 拼接|ffmpeg 拼到最后|后续会被 ffmpeg 拼接/i);
  assert.match(text, /mediaRefs\.ctaAsset/);
  assert.match(text, /mediaRefs\.endingAsset/);
  assert.match(text, /CTA 图 \/ Ending 图只允许出现在最终切片末尾/);
  assert.match(text, /最终切片需要把它们作为末尾视觉参考/);
  assert.match(text, /图片1 = 产品 Logo/);
  assert.doesNotMatch(text, /图片2 = CTA 图/);
  assert.doesNotMatch(text, /图片2 = Ending 图/);
});

test("Seedance plan prompt uses current slice duration instead of hardcoded 15s", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707120500_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning",
          sliceStrategy: "three_slice"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "BR workers",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "three_slice_net_earning",
      sliceStrategy: "three_slice",
      truthRules: {}
    },
    decomposition: {
      scene: "bus commute",
      subject: "commuter",
      action: "checks app rewards",
      camera: "phone close-up",
      lighting: "daylight",
      style: "UGC",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12
  });

  const text = messagesText(messages);
  assert.match(text, /输出时长 durationSec=12/);
  assert.match(text, /当前切片时长 sliceDurationSec=12s/);
  assert.match(text, /"sliceDurationSec": 12/);
  assert.match(text, /Current-slice 9:16 Seedance omni_reference prompt/);
  assert.doesNotMatch(text, /输出时长 durationSec=15/);
  assert.doesNotMatch(text, /15s 9:16 Seedance omni_reference prompt/);
});

test("Seedance plan prompt forbids gibberish UI text and in-frame disclaimers", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707120500_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "en-US",
          regions: ["US"],
          currencySymbol: "$"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "en-US", targetRegions: ["US"] } }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "US",
      productName: "Drama Gold",
      languages: ["en-US"],
      regions: ["US"],
      currencySymbol: "$",
      truthRules: {}
    },
    decomposition: {
      scene: "phone UI reward beat",
      subject: "viewer",
      action: "checks app progress",
      camera: "phone close-up",
      lighting: "bright",
      style: "UGC",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 12
  });

  const text = messagesText(messages);
  assert.match(text, /乱码/);
  assert.match(text, /伪文字/);
  assert.match(text, /no gibberish/);
  assert.match(text, /免责声明/);
  assert.match(text, /post-process|后处理/);
});

test("Seedance plan prompt and validation preserve coherent 16s slice duration", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707120600_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning",
          sliceStrategy: "auto_10_15s_multi_slice"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "BR workers",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "three_slice_net_earning",
      sliceStrategy: "auto_10_15s_multi_slice",
      truthRules: {}
    },
    decomposition: {
      scene: "bus commute",
      subject: "commuter",
      action: "checks app rewards",
      camera: "phone close-up",
      lighting: "daylight",
      style: "UGC",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1,
    sliceDurationSec: 16
  });
  const text = messagesText(messages);
  assert.match(text, /输出时长 durationSec=16/);
  assert.match(text, /当前切片时长 sliceDurationSec=16s/);
  assert.match(text, /"sliceDurationSec": 16/);

  const plan = validateSeedancePlan({
    hook: "Hook",
    body: "Body",
    voiceover: "Voiceover",
    subtitles: ["Subtitle"],
    cta: "",
    ending: "",
    imagePrompt: "Image prompt",
    seedancePrompt: "0-16s: coherent single slice.",
    negativePrompt: "No exact amount",
    mediaRefs: {},
    complianceNotes: []
  }, {
    sliceDurationSec: 16
  });

  assert.equal(plan.sliceDurationSec, 16);
});

test("Seedance plan prompt falls back when branch output-template strings are blank", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707123000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning",
          sliceStrategy: "auto_10_15s_multi_slice",
          moneyVisuals: ["coin_burst", "cash_rain"],
          subtitleWorkflow: "post_process"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_blank_fallback",
      branchLabel: "Blank fallback",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "   ",
      sliceStrategy: "   ",
      moneyVisuals: [],
      subtitleWorkflow: "   ",
      truthRules: {}
    },
    decomposition: {
      scene: "bus commute",
      subject: "commuter",
      action: "checks app rewards",
      camera: "phone close-up",
      lighting: "daylight",
      style: "UGC",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /"outputTemplateMode": "three_slice_net_earning"/);
  assert.match(text, /"sliceStrategy": "auto_10_15s_multi_slice"/);
  assert.match(text, /"subtitleWorkflow": \{/);
  assert.match(text, /"burnedInSubtitles": false/);
  assert.match(text, /"postSubtitleRequired": true/);
  assert.match(text, /"provider": "pixel_tech"/);
});

test("Seedance plan prompt preserves object-shaped subtitleWorkflow in prompt context", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707124000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning",
          subtitleWorkflow: "post_process"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_object_subtitle_workflow",
      branchLabel: "Object subtitle workflow",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "three_slice_net_earning",
      subtitleWorkflow: {
        burnedInSubtitles: false,
        postSubtitleRequired: true,
        provider: "pixel_tech",
        subtitleScript: ["Linha 1", "Linha 2"]
      },
      truthRules: {}
    },
    decomposition: {
      scene: "living room",
      subject: "viewer",
      action: "watches drama and checks rewards",
      camera: "phone close-up",
      lighting: "soft daylight",
      style: "short-drama hook",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /"subtitleWorkflow": \{/);
  assert.match(text, /"burnedInSubtitles": false/);
  assert.match(text, /"postSubtitleRequired": true/);
  assert.match(text, /"provider": "pixel_tech"/);
  assert.match(text, /"subtitleScript": \[/);
  assert.match(text, /"Linha 1"/);
});

test("Seedance plan prompt uses branch post_process mode over contradictory draft subtitleWorkflow object", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707124500_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning",
          subtitleWorkflow: {
            burnedInSubtitles: false,
            postSubtitleRequired: false,
            provider: "custom_provider",
            subtitleScript: ["sub"]
          }
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_legacy_subtitle_workflow",
      branchLabel: "Legacy subtitle workflow",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "three_slice_net_earning",
      subtitleWorkflow: "post_process",
      truthRules: {}
    },
    decomposition: {
      scene: "living room",
      subject: "viewer",
      action: "watches drama and checks rewards",
      camera: "phone close-up",
      lighting: "soft daylight",
      style: "short-drama hook",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /"subtitleWorkflow": \{/);
  assert.match(text, /"burnedInSubtitles": false/);
  assert.match(text, /"postSubtitleRequired": true/);
  assert.match(text, /"provider": "pixel_tech"/);
  assert.match(text, /"subtitleScript": \[/);
  assert.doesNotMatch(text, /"sub"/);
  assert.doesNotMatch(text, /"custom_provider"/);
});

test("Seedance plan prompt preserves branch none subtitleWorkflow mode in prompt context", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260707124600_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning",
          subtitleWorkflow: {
            burnedInSubtitles: false,
            postSubtitleRequired: true,
            provider: "custom_provider",
            subtitleScript: ["draft line"]
          }
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_none_subtitle_workflow",
      branchLabel: "None subtitle workflow",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "three_slice_net_earning",
      subtitleWorkflow: "none",
      truthRules: {}
    },
    decomposition: {
      scene: "bedroom",
      subject: "viewer",
      action: "checks drama rewards",
      camera: "phone close-up",
      lighting: "soft daylight",
      style: "short-drama hook",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /"subtitleWorkflow": \{/);
  assert.match(text, /"burnedInSubtitles": false/);
  assert.match(text, /"postSubtitleRequired": false/);
  assert.match(text, /"provider": "pixel_tech"/);
  assert.match(text, /"subtitleScript": \[\s*\]/);
});

test("Seedance plan prompt falls back invalid branch outputTemplateMode to valid draft mode", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260708100000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "three_slice_net_earning"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_invalid_output_template_mode",
      branchLabel: "Invalid output template mode",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "garbage_mode",
      truthRules: {}
    },
    decomposition: {
      scene: "living room",
      subject: "viewer",
      action: "checks drama rewards",
      camera: "phone close-up",
      lighting: "soft daylight",
      style: "short-drama hook",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /"outputTemplateMode": "three_slice_net_earning"/);
  assert.doesNotMatch(text, /"outputTemplateMode": "garbage_mode"/);
});

test("Seedance plan prompt falls back blank branch and invalid draft outputTemplateMode to safe default", () => {
  const messages = buildSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260708101000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Drama Gold",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$",
          outputTemplateMode: "garbage_mode"
        }
      },
      estimate: { outputRatio: "9:16", request: { language: "pt-BR", targetRegions: ["BR"] } }
    },
    branch: {
      branchId: "branch_blank_invalid_output_template_mode",
      branchLabel: "Blank invalid output template mode",
      productName: "Drama Gold",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      outputTemplateMode: "   ",
      truthRules: {}
    },
    decomposition: {
      scene: "living room",
      subject: "viewer",
      action: "checks drama rewards",
      camera: "phone close-up",
      lighting: "soft daylight",
      style: "short-drama hook",
      quality: "realistic"
    },
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /"outputTemplateMode": "reference_fission"/);
  assert.doesNotMatch(text, /"outputTemplateMode": "garbage_mode"/);
});

test("30s Seedance plan prompt requires one complete storyboard split into two continuous segments", () => {
  const messages = buildThirtySecondSeedancePlanMessages({
    batch: {
      batchId: "wzb_20260701093000_abcd",
      templateSnapshot: {
        draft: {
          productName: "Reward App",
          language: "pt-BR",
          regions: ["BR"],
          currencySymbol: "R$"
        }
      },
      estimate: {
        durationSec: 30,
        request: {
          targetChannel: "meta_ads"
        }
      }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "Brazil 30s",
      productName: "Reward App",
      languages: ["pt-BR"],
      regions: ["BR"],
      currencySymbol: "R$",
      targetChannels: ["meta_ads"],
      truthRules: {}
    },
    decomposition: {
      scene: "stressful daily-life hook followed by app demo",
      subject: "person with phone",
      action: "problem, discovery, demo, reaction",
      camera: "vertical close-up and UI macro shots",
      lighting: "natural to bright UI contrast",
      style: "UGC ad",
      quality: "clear"
    },
    channelRules: { rules: [] },
    branchVariantIndex: 1
  });

  const text = messagesText(messages);
  assert.match(text, /30s 连续预案覆盖规则/);
  assert.match(text, /必须先生成一个完整 0-30s 总分镜计划 overallStoryboard，再拆成两个连续的 15s Seedance prompt/);
  assert.match(text, /segment 1 覆盖 0-15s/);
  assert.match(text, /segment 2 覆盖 15-30s/);
  assert.match(text, /不能重新开场、换人、跳场、重置 UI 或重复钩子/);
  assert.match(text, /以上一段尾帧\/continuity frame 作为首帧连续性参考/);
  assert.match(text, /"overallStoryboard"/);
  assert.match(text, /"segments"/);
  assert.match(text, /分段编号 segmentIndex=1-2/);
});

test("30s Seedance plan parser validates two segment payloads from one LLM response", async () => {
  let callCount = 0;
  const plans = await generateThirtySecondSeedancePlans({
    callWangzhuanLlm: async ({ messages }) => {
      callCount += 1;
      assert.match(messagesText(messages), /overallStoryboard/);
      return JSON.stringify({
        overallStoryboard: "0-15s sets up a new local character and problem; 15-30s continues from the same phone UI state into product feedback.",
        segments: [
          {
            segmentIndex: 1,
            hook: "Comeco tenso",
            body: "A new cafe worker checks the phone during a short break.",
            voiceover: "Ela tenta uma tarefa simples no intervalo.",
            subtitles: ["Tarefa simples", "Feedback no app"],
            cta: "",
            ending: "",
            imagePrompt: "Brazilian cafe worker in a small break room holding a phone, local cafe props, clear product screen.",
            seedancePrompt: "0-5s: cafe worker enters break room; 5-10s: phone close-up; 10-15s: UI feedback appears, camera holds on the phone as continuity boundary.",
            negativePrompt: "No competitor brand, no payout guarantee.",
            mediaRefs: {},
            complianceNotes: []
          },
          {
            segmentIndex: 2,
            hook: "Continua do celular",
            body: "Continue from the previous tail frame and show the same worker following the app flow.",
            voiceover: "Depois ela acompanha o progresso dentro do app.",
            subtitles: ["Mesmo celular", "Progresso no app"],
            cta: "",
            ending: "",
            imagePrompt: "Same Brazilian cafe worker and phone UI continuing from the prior tail frame.",
            seedancePrompt: "Use the previous segment tail frame as continuity reference. 15-20s: same phone UI continues; 20-25s: worker reacts naturally; 25-30s: product feedback settles without adding a CTA.",
            negativePrompt: "No scene reset, no new character, no invented money.",
            mediaRefs: {},
            complianceNotes: []
          }
        ]
      });
    }
  }, {
    batch: {
      batchId: "wzb_20260701093000_abcd",
      templateSnapshot: { draft: { productName: "Reward App" } },
      estimate: { durationSec: 30, request: {} }
    },
    branch: {
      branchId: "branch_1",
      branchLabel: "Brazil 30s",
      productName: "Reward App",
      truthRules: {}
    },
    decomposition: {},
    channelRules: { rules: [] },
    branchVariantIndex: 1
  });

  assert.equal(callCount, 1);
  assert.equal(plans.length, 2);
  assert.equal(plans[0].hook, "Comeco tenso");
  assert.equal(plans[1].hook, "Continua do celular");
  assert.match(plans[1].seedancePrompt, /previous segment tail frame/);
});

test("Seedance plan validation allows optional CTA and ending", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during your break",
    body: "A cashier checks the app after a shift and sees a small eligible-task reward.",
    voiceover: "I tried one quick task before going home.",
    subtitles: ["One quick task", "Small reward feedback"],
    cta: "",
    ending: "",
    imagePrompt: "A cashier in a convenience store break room holds a phone with the app open.",
    seedancePrompt: "Shot 1: subject cashier; motion checks phone; environment break room; camera phone close-up; aesthetics warm indoor light; audio natural voiceover.",
    negativePrompt: "No competitor logo, no watermark, no guaranteed income.",
    mediaRefs: {},
    complianceNotes: []
  }, {
    branchId: "branch_1",
    branchVariantIndex: 1,
    segmentIndex: 1
  });

  assert.equal(plan.cta, "");
  assert.equal(plan.ending, "");
});

test("Seedance plan validation preserves wangzhuan output-template fields", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A different worker checks drama tasks and sees reward feedback.",
    voiceover: "I used my break to watch a short drama and check the app rewards.",
    subtitles: ["Break time", "Reward feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Brazilian bus commuter holding a phone, local street background, Drama Gold screen visible.",
    seedancePrompt: "0-5s: commuter reacts to a bus delay; 5-10s: phone close-up shows drama task; 10-15s: reward feedback appears with coin burst, no exact amount.",
    negativePrompt: "No competitor logo, no burned subtitles, no exact cash amount.",
    mediaRefs: {},
    complianceNotes: ["No guaranteed payout claim."],
    segmentRole: "hook_slice",
    sliceDurationSec: 12,
    outputTemplateMode: "three_slice_net_earning",
    moneyVisuals: ["coin_burst", "reward_number_growth", "withdrawal_success"],
    withdrawalVisual: "Pix/Nubank option shown without exact amount",
    subtitleWorkflow: {
      burnedInSubtitles: false,
      postSubtitleRequired: true,
      provider: "pixel_tech",
      subtitleScript: ["Break time", "Reward feedback"]
    },
    sliceDiversity: {
      personChangedFromPrevious: true,
      sceneChangedFromPrevious: true,
      clothingChangedFromPrevious: true,
      voiceChangedFromPrevious: true
    }
  });

  assert.equal(plan.segmentRole, "hook_slice");
  assert.equal(plan.sliceDurationSec, 12);
  assert.equal(plan.outputTemplateMode, "three_slice_net_earning");
  assert.deepEqual(plan.moneyVisuals, ["coin_burst", "reward_number_growth", "withdrawal_success"]);
  assert.equal(plan.withdrawalVisual, "Pix/Nubank option shown without exact amount");
  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(plan.subtitleWorkflow.postSubtitleRequired, true);
  assert.deepEqual(plan.subtitleWorkflow.subtitleScript, ["Break time", "Reward feedback"]);
  assert.equal(plan.sliceDiversity.personChangedFromPrevious, true);
});

test("Seedance plan validation applies safe defaults for older plans without output-template fields", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: []
  });

  assert.equal(plan.segmentRole, "");
  assert.equal(plan.sliceDurationSec, 15);
  assert.equal(plan.outputTemplateMode, "");
  assert.deepEqual(plan.moneyVisuals, []);
  assert.equal(plan.withdrawalVisual, "");
  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(plan.subtitleWorkflow.postSubtitleRequired, true);
  assert.equal(plan.subtitleWorkflow.provider, "pixel_tech");
  assert.deepEqual(plan.subtitleWorkflow.subtitleScript, ["Break time", "App feedback"]);
  assert.deepEqual(plan.sliceDiversity, {
    personChangedFromPrevious: false,
    sceneChangedFromPrevious: false,
    clothingChangedFromPrevious: false,
    voiceChangedFromPrevious: false
  });
});

test("Seedance plan validation falls back to context for output-template fields when plan omits them", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: []
  }, {
    segmentRole: "hook_slice",
    sliceDurationSec: 12,
    outputTemplateMode: "three_slice_net_earning",
    moneyVisuals: ["coin_burst", "reward_number_growth"],
    withdrawalVisual: "Pix option shown without exact amount",
    subtitleWorkflow: {
      burnedInSubtitles: true,
      postSubtitleRequired: true,
      provider: "pixel_tech",
      subtitleScript: ["Context line 1", "Context line 2"]
    },
    sliceDiversity: {
      personChangedFromPrevious: true,
      sceneChangedFromPrevious: true,
      clothingChangedFromPrevious: false,
      voiceChangedFromPrevious: true
    }
  });

  assert.equal(plan.segmentRole, "hook_slice");
  assert.equal(plan.sliceDurationSec, 12);
  assert.equal(plan.outputTemplateMode, "three_slice_net_earning");
  assert.deepEqual(plan.moneyVisuals, ["coin_burst", "reward_number_growth"]);
  assert.equal(plan.withdrawalVisual, "Pix option shown without exact amount");
  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(plan.subtitleWorkflow.postSubtitleRequired, true);
  assert.equal(plan.subtitleWorkflow.provider, "pixel_tech");
  assert.deepEqual(plan.subtitleWorkflow.subtitleScript, ["Break time", "App feedback"]);
  assert.deepEqual(plan.sliceDiversity, {
    personChangedFromPrevious: true,
    sceneChangedFromPrevious: true,
    clothingChangedFromPrevious: false,
    voiceChangedFromPrevious: true
  });
});

test("Seedance plan validation falls back when template fields are blank and forces burned subtitles off", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    outputTemplateMode: "   ",
    withdrawalVisual: "   ",
    subtitleWorkflow: {
      burnedInSubtitles: true
    }
  }, {
    outputTemplateMode: "three_slice_net_earning",
    withdrawalVisual: "Pix option shown without exact amount"
  });

  assert.equal(plan.outputTemplateMode, "three_slice_net_earning");
  assert.equal(plan.withdrawalVisual, "Pix option shown without exact amount");
  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
});

test("Seedance plan validation falls back to branch subtitleWorkflow string mode none", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: []
  }, {
    branch: {
      subtitleWorkflow: "none"
    }
  });

  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(plan.subtitleWorkflow.postSubtitleRequired, false);
  assert.equal(plan.subtitleWorkflow.provider, "pixel_tech");
  assert.deepEqual(plan.subtitleWorkflow.subtitleScript, ["Break time", "App feedback"]);
});

test("Seedance plan validation falls back to draft subtitleWorkflow string mode none", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: []
  }, {
    batch: {
      templateSnapshot: {
        draft: {
          subtitleWorkflow: "none"
        }
      }
    }
  });

  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(plan.subtitleWorkflow.postSubtitleRequired, false);
  assert.equal(plan.subtitleWorkflow.provider, "pixel_tech");
  assert.deepEqual(plan.subtitleWorkflow.subtitleScript, ["Break time", "App feedback"]);
});

test("Seedance plan validation honors legacy plan subtitleWorkflow string mode none", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    subtitleWorkflow: "none"
  });

  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(plan.subtitleWorkflow.postSubtitleRequired, false);
  assert.equal(plan.subtitleWorkflow.provider, "pixel_tech");
  assert.deepEqual(plan.subtitleWorkflow.subtitleScript, ["Break time", "App feedback"]);
});

test("Seedance plan validation honors legacy plan subtitleWorkflow string mode post_process", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    subtitleWorkflow: "post_process"
  });

  assert.equal(plan.subtitleWorkflow.burnedInSubtitles, false);
  assert.equal(plan.subtitleWorkflow.postSubtitleRequired, true);
  assert.equal(plan.subtitleWorkflow.provider, "pixel_tech");
  assert.deepEqual(plan.subtitleWorkflow.subtitleScript, ["Break time", "App feedback"]);
});

test("Seedance plan validation normalizes object subtitleWorkflow boolean-like values", () => {
  const falseStringPlan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    subtitleWorkflow: {
      postSubtitleRequired: "false"
    }
  });
  const zeroPlan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    subtitleWorkflow: {
      postSubtitleRequired: 0
    }
  });

  assert.equal(falseStringPlan.subtitleWorkflow.postSubtitleRequired, false);
  assert.equal(zeroPlan.subtitleWorkflow.postSubtitleRequired, false);
});

test("Seedance plan validation falls back invalid outputTemplateMode to valid context mode", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    outputTemplateMode: "totally_invalid_mode"
  }, {
    outputTemplateMode: "three_slice_net_earning"
  });

  assert.equal(plan.outputTemplateMode, "three_slice_net_earning");
});

test("Seedance plan validation omits invalid branch outputTemplateMode and falls back to valid draft mode", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: []
  }, {
    branch: {
      outputTemplateMode: "garbage_mode"
    },
    batch: {
      templateSnapshot: {
        draft: {
          outputTemplateMode: "three_slice_net_earning"
        }
      }
    }
  });

  assert.equal(plan.outputTemplateMode, "three_slice_net_earning");
});

test("Seedance plan validation omits plan outputTemplateMode and falls back blank branch plus invalid draft to safe default", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: []
  }, {
    branch: {
      outputTemplateMode: "   "
    },
    batch: {
      templateSnapshot: {
        draft: {
          outputTemplateMode: "garbage_mode"
        }
      }
    }
  });

  assert.equal(plan.outputTemplateMode, "reference_fission");
});

test("Seedance plan validation falls back invalid outputTemplateMode to safe default", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    outputTemplateMode: "totally_invalid_mode"
  });

  assert.equal(plan.outputTemplateMode, "reference_fission");
});

test("Seedance plan validation normalizes sliceDiversity string booleans defensively", () => {
  const plan = validateSeedancePlan({
    hook: "Try it during a break",
    body: "A worker checks the app and sees feedback.",
    voiceover: "I checked the app during my break.",
    subtitles: ["Break time", "App feedback"],
    cta: "",
    ending: "",
    imagePrompt: "Worker with a phone in a local break area.",
    seedancePrompt: "0-5s: worker checks phone; 5-10s: app close-up; 10-15s: feedback appears.",
    negativePrompt: "No competitor logo.",
    mediaRefs: {},
    complianceNotes: [],
    sliceDiversity: {
      personChangedFromPrevious: "false",
      sceneChangedFromPrevious: "0",
      clothingChangedFromPrevious: "no",
      voiceChangedFromPrevious: "true"
    }
  });

  assert.deepEqual(plan.sliceDiversity, {
    personChangedFromPrevious: false,
    sceneChangedFromPrevious: false,
    clothingChangedFromPrevious: false,
    voiceChangedFromPrevious: true
  });
});

test("strong commitment plan validation accepts any non-empty truth rule", () => {
  assert.doesNotThrow(() => validateBranchTruthRulesForPlan([{
    branchId: "branch_1",
    branchLabel: "Single rule branch",
    promiseLevel: "strong_commitment",
    truthRules: {
      rewardCondition: "eligible completed tasks only"
    }
  }]));

  assert.throws(() => validateBranchTruthRulesForPlan([{
    branchId: "branch_2",
    branchLabel: "Empty rule branch",
    promiseLevel: "strong_commitment",
    truthRules: {
      rewardCondition: "   "
    }
  }]), /强承诺需要补齐真实收益规则/);
});
