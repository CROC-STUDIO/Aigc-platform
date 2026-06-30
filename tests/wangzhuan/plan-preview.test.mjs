import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeedancePlanMessages,
  validateBranchTruthRulesForPlan,
  validateSeedancePlan
} from "../../server/wangzhuan/plan-preview.mjs";

function messagesText(messages) {
  return messages.map((message) => message.content).join("\n\n");
}

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
