// Seedance 方案生成 prompt 大小测量脚本（基线与验收共用）
// 用法：node scripts/measure-plan-prompt.mjs
// 输出：单切片 full / compact、variant 批量三种模式的 prompt 字符数与估算 token。
// 注意：本脚本不调用真实 LLM，通过注入 callWangzhuanLlm 捕获 messages 后中止。

import { buildSeedancePlanMessages, generateSeedanceVariantPlans } from "../server/wangzhuan/plan-preview.mjs";

// ---------- 仿真实数据（结构与线上拆解一致，勿随意精简，保证测量口径稳定） ----------
const seg = (i) => ({
  storySegmentIndex: i, startSec: (i - 1) * 15, endSec: i * 15, durationSec: 15,
  summary: "打工人下班路上刷手机看到赚钱App广告，好奇点开后完成任务领取金币，最后展示提现成功画面并引导下载".slice(0, 60),
  coreHook: "好奇心+收益反馈", explosivePoint: "金币爆发动画",
  voiceoverObserved: "葡语口播介绍任务玩法和奖励节奏，强调轻松上手",
  timelineItems: [
    { atSec: (i - 1) * 15 + 2, type: "ui_overlay", description: "金币+提现按钮UI反馈动画出现于屏幕下方" },
    { atSec: (i - 1) * 15 + 8, type: "subtitle_card", description: "字幕卡强调任务完成即可累计奖励进度" }
  ],
  conversionSignals: { withdrawalSuccess: true, earningsNumber: true, cashCoinFeedback: true },
  conversionEffectOpportunities: ["金币雨", "余额增长动画"],
  variableLayers: { person: "外卖骑手", scene: "夜晚街头" }
});
const slice = (i) => ({
  seedanceSliceIndex: i, storySegmentIndex: i, segmentIndex: i,
  startSec: (i - 1) * 15, endSec: i * 15, durationSec: 15, sliceDurationSec: 15,
  segmentRole: i === 1 ? "hook_slice" : i === 2 ? "proof_slice" : "withdrawal_slice",
  coreHook: "收益好奇", timelineItems: seg(i).timelineItems, conversionSignals: seg(i).conversionSignals
});
const decomposition = {
  referenceVideoId: "ref_x",
  scene: "夜晚城市街头与手机屏幕特写", subject: "30岁外卖骑手",
  action: "刷手机-点广告-做任务-领奖励-提现", camera: "手持跟拍+屏幕录制切换",
  lighting: "夜景霓虹+屏幕冷光", style: "UGC实拍感", quality: "1080p清晰",
  hook: "下班路上顺手赚外快?",
  sourceVideoProfile: { durationSec: 45, ratio: "9:16", style: "UGC" },
  wholeVideoConversion: { tone: "轻松真实", pacing: "快节奏", structure: "hook-proof-withdrawal" },
  storySegments: [seg(1), seg(2), seg(3)],
  seedanceSlices: [slice(1), slice(2), slice(3)]
};
const branch = {
  branchId: "b1", branchLabel: "巴西弱承诺", productName: "CashJoy",
  productLink: "https://play.google.com/store/apps/details?id=com.cashjoy.app",
  targetChannels: ["meta_ads"], promiseLevel: "stable", truthRules: {},
  variantPrompt: "换成家庭主妇场景",
  assetUrls: {
    productIcon: "https://harpoons3.s3.ap-southeast-1.amazonaws.com/uploads/prj/users/u1/assets/icon_abcdef.png",
    productScreenshot: "https://harpoons3.s3.ap-southeast-1.amazonaws.com/uploads/prj/users/u1/assets/shot_abcdef.png"
  },
  assetFileNames: { productIcon: "icon.png", productScreenshot: "shot.png" }
};
const batch = {
  batchId: "wzb_x",
  templateSnapshot: { draft: { productName: "CashJoy", primaryLanguage: "pt", regions: ["BR"] } },
  estimate: { variantCount: 3 }
};
const channelRules = {
  rules: [{
    channel: "meta_ads", promiseLevel: "stable",
    forbiddenTerms: ["guaranteed income", "instant payout", "risk free"],
    requiredDisclaimers: ["Rewards vary by eligibility and region."],
    ctaStrength: "medium"
  }]
};
const base = {
  batch, branch, decomposition, channelRules,
  branchVariantIndex: 1, segmentIndex: 1, sliceDurationSec: 15,
  currentSlice: slice(1), totalSegmentCount: 3,
  knowledgeNotes: "巴西用户重视Pix提现;避免过度承诺"
};

const size = (m) => JSON.stringify(m).length;
const tok = (n) => Math.round(n / 3.3);

// ---------- 1/2. 单切片 full / compact ----------
const full = buildSeedancePlanMessages({ ...base, options: { compact: false } });
const compact = buildSeedancePlanMessages({ ...base, options: { compact: true } });
console.log(`单切片 full    : ${size(full)} chars ≈ ${tok(size(full))} tokens`);
console.log(`单切片 compact : ${size(compact)} chars ≈ ${tok(size(compact))} tokens (省 ${(100 * (1 - size(compact) / size(full))).toFixed(1)}%)`);

// ---------- 3. variant 批量（默认路径），注入捕获后中止 ----------
let capturedBatch = 0;
const measureContext = (config = {}) => ({
  config: { wangzhuan: config },
  userProjectRoot: "", sharedProjectRoot: "",
  recordTelemetryEvent: async () => {},
  callWangzhuanLlm: async ({ messages }) => {
    capturedBatch = size(messages);
    const err = new Error("measure_abort");
    err.code = "measure_abort";
    throw err;
  }
});
try {
  await generateSeedanceVariantPlans(measureContext(), {
    ...base, slicePlan: [slice(1), slice(2), slice(3)]
  });
} catch { /* 预期中止 */ }
console.log(`variant批量(3切片, 当前配置): ${capturedBatch} chars ≈ ${tok(capturedBatch)} tokens`);

// 如需测 compact 开启后的批量（方案二完成后）：
try {
  await generateSeedanceVariantPlans(measureContext({ planPromptCompact: true }), {
    ...base, slicePlan: [slice(1), slice(2), slice(3)]
  });
} catch { /* 预期中止 */ }
console.log(`variant批量(3切片, planPromptCompact=true): ${capturedBatch} chars ≈ ${tok(capturedBatch)} tokens`);
