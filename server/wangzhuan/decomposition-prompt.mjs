import { FISSION_ANALYSIS_PROMPT_REQUIREMENTS } from "./fission-analysis.mjs";

export const DECOMPOSITION_JSON_SCHEMA_HINT = Object.freeze({
  scene: "视频主要场景：写清空间、时间段、人物所在环境、App 页面状态与关键可见元素；若视频可拆成多段，注明各段场景是否变化",
  subject: "画面主体：必须写具体人物——职业/身份（如外卖员、宝妈、上班族、退休大爷）、性别、年龄段、人种/肤色或外观、服装、姿态、手持物；无真人时明确主体是什么（仅手机 UI、仅手部等）",
  action: "核心动作：必须按参考视频时间轴分段（如 0-3s / 3-8s / 8-15s），每段写人物动作、口播功能、字幕功能、手机 UI 操作、奖励反馈与转折；便于后续裂变子节点和 30s 分段复用",
  camera: "镜头语言：景别、构图、运镜、切镜节奏、手机/人物在画面中的位置",
  lighting: "光线和画面氛围：室内/室外、冷暖、明暗、真实拍摄或广告质感",
  style: "素材风格：真人口播/字幕驱动/手持演示/App demo/UGC 等；若有口播，说明口播类型、语气、节奏、是否与字幕叠加，禁止只写“自然口播”",
  quality: "画质和生成质量：清晰度、稳定性、UI 可读性、人物一致性和需避免的失真",
  hook: "前三秒钩子：保留参考视频的结构逻辑，但不照搬竞品文案；写清靠人物、职业身份、字幕、奖励反馈还是痛点触发",
  phoneUi: "可选，手机/产品界面：页面模块、按钮、数字/金币/进度条/提现入口等可见信息",
  protagonist: "可选但能判断时必须填写：人物职业/身份、年龄段、外观、服装、情绪、姿态、手持物、是否延续到后续镜头",
  voiceover: "可选但能判断时必须填写：按时间段拆分口播/旁白的功能、语气、节奏、大意；只写话术功能，不复述竞品原文案",
  onscreenText: "可选但能判断时必须填写：屏幕字幕/贴纸/按钮文案的出现时机、位置、功能和视觉层级",
  ctaMoment: "可选，CTA 出现的具体时刻、触发画面、按钮/字幕/口播承接方式",
  endingMoment: "可选，Ending 收束画面、下载/奖励结果展示方式",
  continuityAnchors: "可选，后续裂变或 30s 分段需保持一致的主角职业/外观、服装、地点、手机 UI 状态、最后关键帧",
  actionReference: "Seedance 动作参考：可复用的人物/手部/手机操作/奖励反馈动作链，不照搬竞品品牌和原文案",
  cameraReference: "Seedance 运镜参考：景别、构图、镜头移动、切镜节奏",
  textElements: "Seedance 文字生成参考：字幕、气泡台词、按钮文案、CTA 的位置/层级/功能，不照搬竞品原文案",
  effectReference: "Seedance 特效参考：转场、金币/余额反馈、弹窗、强调动画、音效/节奏点",
  doNotCopyElements: "不得复刻：竞品品牌、logo、水印、UI 细节、原字幕/口播文案、人物身份或独有包装",
  rewardFeedback: "可选，奖励反馈：金币、余额、进度、到账感、弹窗或按钮反馈如何出现",
  cta: "可选，行动号召结构：出现时机、位置、按钮/字幕/口播表达方式",
  sourceVideoProfile: "裂变分析：整条参考视频的素材类型、主角/场景、产品露出方式、主要转化承诺与节奏概览",
  wholeVideoConversion: "裂变分析：整条视频的转化策略、核心转化语气、信任建立方式、奖励/提现证明和 CTA 承接",
  wholeVideoSummary: "裂变分析：先理解整条视频后给出的完整故事线摘要，不要直接按 UI/特效碎片拆段",
  storySegments: "裂变分析：按真实叙事 beat 拆分；每段必须包含 scene/subject/action/camera/lighting/style/quality 七维以及 coreHook、explosivePoint、segmentPurpose、timelineItems、conversionSignals、conversionEffectOpportunities、sliceSplitHints",
  timelineItems: "裂变分析：App UI、reward animation、cash/coin、subtitle/title、withdrawal、CTA overlay 等时间轴事件；除非改变叙事 beat，否则放在这里而不是新 storySegment",
  conversionSignals: "裂变分析：视频中真实观察到的提现成功、收益数字、情绪口播、现金金币反馈、快速奖励线索等转化信号",
  conversionEffectOpportunities: "裂变分析：可裂变放大的特效/反馈机会，与已观察到的 conversionSignals 分开记录",
  sliceSplitHints: "裂变分析：Seedance 8-15s 子段建议切点，必须基于叙事转折而不是 UI/字幕/特效独立出现",
  seedanceSlices: "裂变分析：可选的 Seedance 子段；字幕不烧录，字幕文本进入 subtitleWorkflow.subtitleScript 或 subtitles 供后处理"
});

export const DECOMPOSITION_ANTI_GENERALIZATION_PHRASES = Object.freeze([
  "手机奖励 App 页面",
  "用户点击按钮",
  "高清广告风格",
  "自然口播",
  "App 演示",
  "奖励页面",
  "展示产品优势",
  "吸引用户下载",
  "年轻女性",
  "男性用户"
]);

export const DECOMPOSITION_SYSTEM_PROMPT = [
  "你是网赚广告素材拆解专家，只做结构化拆解，不生成侵权复刻内容。",
  "你必须且只能输出一个合法 JSON 对象：不要 markdown、不要代码围栏、不要解释、不要前后缀文字。",
  "拆解目标是学习参考视频的镜头结构、时间节奏、人物设定、口播/字幕功能和转化逻辑，供后续产品改写与裂变子节点复用。",
  "严禁脚本泛化：每个字段都要基于参考视频里真实可见/可听的内容写具体细节，禁止空泛模板句。",
  "输出字段必须至少包含：scene, subject, action, camera, lighting, style, quality, hook。",
  "有真人时必须推断或合理补全人物职业/身份，并写入 subject；有口播时必须按时间段细化 voiceover，并把关键口播功能同步写入 action。"
].join("\n");

export function buildCompactDecompositionUserPrompt(probe, request = {}, llmConfig = {}, videoProbePrompt) {
  const notes = String(request.knowledgeNotes || "").trim();
  const requiredHint = Object.fromEntries(
    ["scene", "subject", "action", "camera", "lighting", "style", "quality", "hook"]
      .map((field) => [field, DECOMPOSITION_JSON_SCHEMA_HINT[field]])
  );
  return [
    "上次拆解输出不完整或不是合法 JSON。请重新生成，只返回一个合法 JSON 对象。",
    "",
    "【输出格式 — 强制 JSON】",
    "1. 只返回一个 JSON 对象，根层级直接是字段。",
    "2. 禁止 markdown、代码围栏、注释、解释性文字。",
    "3. 必须包含且仅优先保证这 8 个字段：scene, subject, action, camera, lighting, style, quality, hook。",
    "4. 若能判断，可额外附带简短 storySegments（每段含 scene/subject/action/camera/lighting/style/quality）。",
    "",
    "参考视频信息：",
    videoProbePrompt(probe),
    "",
    "字段说明：",
    JSON.stringify(requiredHint, null, 2),
    "",
    notes ? `业务经验规则：\n${notes}` : "业务经验规则：未填写",
    "",
    `模型配置：provider=${llmConfig.provider || "unknown"}，model=${llmConfig.model || "unknown"}`,
    "",
    "只返回 JSON 对象。"
  ].join("\n");
}

export function buildDecompositionUserPrompt(probe, request = {}, llmConfig = {}, videoProbePrompt, options = {}) {
  if (options?.compact) {
    return buildCompactDecompositionUserPrompt(probe, request, llmConfig, videoProbePrompt);
  }
  const notes = String(request.knowledgeNotes || "").trim();
  const durationHint = probe.durationSec
    ? `参考视频时长 ${probe.durationSec}s，action 至少按 2-4 个时间段拆分，每段标注起止秒数。`
    : "action 至少按 2-4 个时间段拆分，每段标注起止秒数。";

  return [
    "请根据参考视频文件和抽样画面帧，生成网赚素材脚本拆解 JSON 草稿。",
    "",
    "【输出格式 — 强制 JSON】",
    "1. 只返回一个 JSON 对象，根层级直接是字段，不要包在 decomposition/script/result 等容器里。",
    "2. 禁止 markdown、代码围栏、注释、解释性文字。",
    "3. 字段名必须使用英文 key（scene/subject/action 等），字段值用中文描述（除非视频本身是其他语言）。",
    "",
    "【拆解优化原则】",
    "1. 以参考视频为准做“结构学习 + 细节提炼”，不是写通用广告脚本。",
    "2. 按参考视频时间轴裂变拆分：action 必须分段，每段对应可见的镜头/动作/口播/字幕变化，方便后续 3.1/3.2/3.3 裂变和 30s 分段。",
    "3. subject 与 protagonist 必须细化人物：职业/身份优先（如网约车司机、便利店店员、健身博主、退休夫妻），再写性别、年龄段、外观、服装、情绪、手持物。",
    "4. voiceover 与 action 必须细化口播：按时间段写口播功能（痛点/质疑/惊喜/引导下载）、语气、节奏、是否与字幕叠加；只写功能，不复述竞品原话。",
    "5. hook/scene/style/onscreenText 也要落到参考视频的具体画面，不要抽象概括。",
    "",
    "【反泛化 — 禁止写法】",
    `以下写法视为不合格，必须改写成可见细节：${DECOMPOSITION_ANTI_GENERALIZATION_PHRASES.join("、")}。`,
    "不要写“展示产品优势”“吸引用户下载”这类空话；要写成谁、在什么场景、做什么动作、看到什么 UI/奖励反馈、口播/字幕承担什么转化功能。",
    "",
    "【Fission analysis requirements】",
    "First understand whole video, then split: first understand whole video, then split by real narrative beats.",
    "App UI/reward animation/cash/coin/subtitle/title/withdrawal/CTA overlay should be timelineItems unless narrative beat changes.",
    "Do not create a new story segment only because an app UI, reward animation, cash/coin effect, subtitle card, title card, withdrawal visual, or CTA overlay appears; keep these in timelineItems unless they change the narrative beat.",
    "Keep old fields scene/subject/action/camera/lighting/style/quality/hook for compatibility.",
    "If output storySegments, each segment includes seven dimensions: scene, subject, action, camera, lighting, style, quality.",
    "Seedance subtitles are not burned; subtitle text goes into subtitleWorkflow.subtitleScript or subtitles for post-processing.",
    ...FISSION_ANALYSIS_PROMPT_REQUIREMENTS.map((requirement, index) => `${index + 1}. ${requirement}`),
    "",
    "参考视频信息：",
    videoProbePrompt(probe),
    "",
    durationHint,
    "",
    "字段说明：",
    JSON.stringify(DECOMPOSITION_JSON_SCHEMA_HINT, null, 2),
    "",
    "Seedance decomposition dimensions:",
    "- actionReference = 动作参考：提炼人物/手部/手机操作/奖励反馈的可复用动作链。",
    "- cameraReference = 运镜参考：提炼景别、构图、镜头移动、切镜节奏。",
    "- textElements = 文字生成：提炼字幕、气泡台词、按钮文案、CTA 的位置、层级和功能，不照搬竞品原文案。",
    "- effectReference = 特效参考：提炼金币/余额反馈、弹窗、转场、强调动画、音效节奏点。",
    "- doNotCopyElements = 不得复刻：竞品品牌、logo、水印、UI 细节、原字幕/口播文案、人物身份或独有包装。",
    "",
    notes ? `业务经验规则：\n${notes}` : "业务经验规则：未填写",
    "",
    `模型配置：provider=${llmConfig.provider || "unknown"}，model=${llmConfig.model || "unknown"}`,
    "",
    "【字段填写要求】",
    "1. 必须结合上传视频/抽帧画面判断镜头、节奏、人物、口播、产品露出、CTA 和 ending，不要只依据元数据。",
    "2. hook 写结构化钩子逻辑，不照搬竞品品牌或原字幕。",
    "3. scene/subject/action/camera/lighting/style/quality 必须能直接供后续脚本裂变使用，每个字段都要对应参考视频里的真实内容。",
    "4. subject 必须包含人物职业/身份；无真人时说明主体类型。",
    "5. action 必须按时间顺序分段，格式建议：「0-3s：…；3-8s：…；8-15s：…」，每段包含动作、口播功能、字幕/UI/奖励反馈。",
    "6. style 必须说明素材形态与口播/字幕关系；有口播时禁止只写“自然口播”。",
    "7. protagonist/voiceover/onscreenText 能判断时必须填写；人物要有职业，口播要按段写功能与节奏。",
    "8. phoneUi/rewardFeedback/ctaMoment/endingMoment 能判断时必须填写具体 UI、按钮、数字、触发画面。",
    "9. continuityAnchors 必须总结后续裂变应保持一致的主角职业/外观、服装、地点、手机 UI 状态和最后关键帧。",
    "10. 只返回 JSON 对象。"
  ].join("\n");
}
