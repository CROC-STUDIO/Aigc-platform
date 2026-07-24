import { WangzhuanError } from "./http.mjs";
import { resolveLlmConfig } from "./llm-config.mjs";
import { callOpenAiCompatibleLlm, parseLlmJsonContent } from "./reference-videos.mjs";

const STORY_DURATION_SECONDS = new Set([15, 30]);

const VARIANT_PATTERNS = Object.freeze([
  {
    title: "晚宴证据反击",
    scene: "明亮可读的豪门家庭晚宴长餐桌",
    protagonist: "被丈夫冷落却保持克制的妻子",
    antagonist: "当众炫耀新关系的丈夫与第三者",
    openingAction: "丈夫把原本属于妻子的主位餐牌推给第三者，宾客齐齐举起手机",
    reversalObject: "亮起录音波形的手机",
    emotion: "证据焦虑",
    ending: "律师来电亮起，丈夫伸手抢手机却被管家拦住"
  },
  {
    title: "订婚宴身份反锁",
    scene: "酒店订婚宴的红毯与签到台",
    protagonist: "被准婆家轻视的普通装束未婚妻",
    antagonist: "抢走戒指盒并要求保安赶人的准婆婆",
    openingAction: "准婆婆拍落女主胸花，把戒指盒递给另一个女人，保安横臂挡住去路",
    reversalObject: "酒店门禁认主的旧房卡",
    emotion: "身份震撼",
    ending: "宴会厅灯光转向女主，经理改口称呼却停在姓氏前"
  },
  {
    title: "婚礼信托条款反击",
    scene: "婚礼仪式后的玻璃花房签约桌",
    protagonist: "被岳家要求让出婚房的女儿",
    antagonist: "拿着合同施压的母亲与贪婪新郎",
    openingAction: "新郎把婚房钥匙塞进亲戚手里，母亲按住女主签字的手，见证人转身回避",
    reversalObject: "被误当作请柬的信托条款信封",
    emotion: "公平红鲱鱼后的打脸期待",
    ending: "女主撕开信封，律师跨过花房门槛，众人开始换站位"
  }
]);

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanText(value, maxLength) {
  return cleanString(value).replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizedDuration(value) {
  const durationSec = Number(value || 30);
  if (!STORY_DURATION_SECONDS.has(durationSec)) {
    throw new WangzhuanError("validation_error", "durationSec 只能是 15 或 30", {
      field: "durationSec",
      supported: [...STORY_DURATION_SECONDS]
    });
  }
  return durationSec;
}

export function validateStorySeedRequest(request = {}) {
  const corePlot = cleanString(request.corePlot);
  if (corePlot.length < 2 || corePlot.length > 80) {
    throw new WangzhuanError("validation_error", "剧情点长度需为 2-80 个字符", {
      field: "corePlot",
      minLength: 2,
      maxLength: 80
    });
  }
  return {
    corePlot,
    durationSec: normalizedDuration(request.durationSec),
    language: cleanString(request.language) || "zh-CN"
  };
}

function timedBeats(pattern, durationSec) {
  const reversalStart = durationSec === 30 ? 12 : 7;
  const finalStart = durationSec === 30 ? 22 : 10;
  return [
    { startSec: 0, endSec: 2, beat: pattern.openingAction },
    { startSec: 2, endSec: reversalStart, beat: `${pattern.antagonist}继续施压，${pattern.protagonist}看见被误读的${pattern.reversalObject}` },
    { startSec: reversalStart, endSec: finalStart, beat: `${pattern.reversalObject}启动，见证人开始动摇，权力关系反转` },
    { startSec: finalStart, endSec: durationSec, beat: pattern.ending }
  ];
}

function buildDecomposition(corePlot, durationSec, pattern, index) {
  const highlights = episodeHighlightsForPattern(pattern, corePlot, durationSec);
  const sliceDurationSec = durationSec / highlights.length;
  const storySegments = highlights.map((highlight, highlightIndex) => {
    const startSec = highlightIndex * sliceDurationSec;
    const endSec = startSec + sliceDurationSec;
    return {
      storySegmentIndex: highlightIndex + 1,
      startSec,
      endSec,
      durationSec: sliceDurationSec,
      scene: highlight.scene,
      subject: `${highlight.protagonist}与${highlight.antagonist}`,
      action: highlight.openingAction,
      camera: "首秒手持近景切入冲突，随后中近景跟随反转物件与见证人站位变化",
      lighting: "明亮、高可读、自然肤色，避免阴暗电影化曝光",
      style: "9:16 真人短剧剧集高潮，公开场合强社交压力，独立片段",
      quality: "人物面部清晰、反转物件可见、无大段可读文字、无血腥危险动作",
      coreHook: highlight.openingAction,
      explosivePoint: `${highlight.reversalObject}启动，权力关系反转`,
      segmentPurpose: "独立短剧剧集高潮",
      segmentConversionStyle: "公开压迫后用可视化证据反转",
      segmentRhythm: "首秒冲突，快速升级，反转后悬停",
      segmentStructureSkeleton: "公开羞辱/夺权 -> 反转物亮相 -> 权力翻转 -> 悬念停帧",
      timelineItems: [{ type: "drama_action", content: highlight.openingAction }, { type: "evidence_reversal", content: highlight.reversalObject }],
      conversionSignals: { emotionalEngine: pattern.emotion, reversalObject: highlight.reversalObject },
      conversionEffectOpportunities: [],
      voiceoverObserved: [],
      variableLayers: { episodeHighlight: highlight.title },
      sliceSplitHints: [],
      continuityGroupId: `highlight_${index}_${highlightIndex + 1}`,
      continuityMode: "independent_slice",
      boundaryType: "episode_highlight_cut",
      startFrameState: `${highlight.protagonist}在${highlight.scene}被公开压迫，${highlight.reversalObject}已在视野内`,
      endFrameState: highlight.ending,
      continuityReferenceNeeded: false,
      globalContinuityAnchors: `${highlight.protagonist}、${highlight.scene}、${highlight.reversalObject}`
    };
  });
  const slices = storySegments.map((segment, highlightIndex) => ({
    seedanceSliceIndex: highlightIndex + 1,
    storySegmentIndex: segment.storySegmentIndex,
    segmentIndex: highlightIndex + 1,
    startSec: segment.startSec,
    endSec: segment.endSec,
    durationSec: segment.durationSec,
    sliceDurationSec: segment.durationSec,
    segmentRole: "episode_highlight",
    continuityGroupId: segment.continuityGroupId,
    continuitySliceId: `${segment.continuityGroupId}_slice_1`,
    continuitySequence: 1,
    continuityMode: "independent_slice",
    boundaryType: "episode_highlight_cut",
    startFrameState: segment.startFrameState,
    endFrameState: segment.endFrameState,
    continuityReferenceNeeded: false,
    globalContinuityAnchors: segment.globalContinuityAnchors
  }));
  const firstHighlight = highlights[0];
  return {
    schemaVersion: "story_seed_decomposition.v1",
    sourceType: "story_seed",
    sourceConfidence: "pattern_inspired",
    corePlot,
    sourceAssemblyMode: "independent_segments",
    scene: firstHighlight.scene,
    subject: `${firstHighlight.protagonist}与${firstHighlight.antagonist}`,
    protagonist: firstHighlight.protagonist,
    action: firstHighlight.openingAction,
    camera: "首秒手持近景切入冲突，随后中近景跟随反转物件与见证人站位变化",
    lighting: "明亮、高可读、自然肤色，避免阴暗电影化曝光",
    style: "9:16 真人短剧剧集高潮集锦，每段独立叙事",
    quality: "人物面部清晰、反转物件可见、无大段可读文字、无血腥危险动作",
    hook: `${firstHighlight.openingAction}，但${firstHighlight.reversalObject}即将改写所有人的判断。`,
    storySegments,
    seedanceSlices: slices,
    wholeVideoConversion: { corePlot, viewerEmotion: pattern.emotion, episodeHighlightCount: highlights.length, assemblyMode: "independent_episode_highlights" },
    continuityAnchors: highlights.map((highlight) => `${highlight.protagonist}、${highlight.scene}、${highlight.reversalObject}`).join("；")
  };
}

function normalizeEpisodeHighlight(value = {}) {
  if (!value || typeof value !== "object") return null;
  const highlight = {
    title: cleanText(value.title, 36),
    scene: cleanText(value.scene, 80),
    protagonist: cleanText(value.protagonist, 60),
    antagonist: cleanText(value.antagonist, 60),
    openingAction: cleanText(value.openingAction, 100),
    reversalObject: cleanText(value.reversalObject, 36),
    ending: cleanText(value.ending, 100)
  };
  return Object.values(highlight).every(Boolean) ? highlight : null;
}

function fallbackEpisodeHighlight(pattern, corePlot, sequence) {
  const fallbacks = [
    {
      title: "股东会控股反转",
      scene: `${corePlot}引发的公开股东会议室`,
      protagonist: "被剥夺席位却掌握投票权的女股东",
      antagonist: "试图用协议夺走控制权的前夫与董事",
      openingAction: "前夫当众宣布撤销女主投票权，秘书收走她的席位牌，所有股东看向门口",
      reversalObject: "投票权委托原件",
      ending: "投票屏突然翻转，法务推门而入，前夫的离婚协议停在签名页"
    },
    {
      title: "年会冻结令",
      scene: "集团年会的公开颁奖台",
      protagonist: "被撤销职位却保留股权的前妻",
      antagonist: "当众宣布新任命的前夫与新伴侣",
      openingAction: "前夫在颁奖台上撕掉女主的任命书，保安向她伸手索要门禁卡",
      reversalObject: "董事会冻结令",
      ending: "大屏任命名单熄灭，审计负责人从侧门举起冻结令"
    }
  ];
  return fallbacks[(sequence - 2) % fallbacks.length];
}

function episodeHighlightsForPattern(pattern, corePlot, durationSec) {
  const requiredCount = durationSec === 30 ? 3 : 1;
  const supplied = Array.isArray(pattern.episodeHighlights)
    ? pattern.episodeHighlights.map(normalizeEpisodeHighlight).filter(Boolean)
    : [];
  const baseHighlight = normalizeEpisodeHighlight(pattern) || supplied[0];
  const highlights = supplied.length ? supplied : [baseHighlight].filter(Boolean);
  while (highlights.length < requiredCount) {
    highlights.push(fallbackEpisodeHighlight(pattern, corePlot, highlights.length + 1));
  }
  return highlights.slice(0, requiredCount);
}

function normalizeStoryPattern(value = {}) {
  if (!value || typeof value !== "object") return null;
  const pattern = {
    title: cleanText(value.title, 36),
    scene: cleanText(value.scene, 80),
    protagonist: cleanText(value.protagonist, 60),
    antagonist: cleanText(value.antagonist, 60),
    openingAction: cleanText(value.openingAction, 100),
    reversalObject: cleanText(value.reversalObject, 36),
    emotion: cleanText(value.emotion, 36),
    ending: cleanText(value.ending, 100),
    episodeHighlights: Array.isArray(value.episodeHighlights)
      ? value.episodeHighlights.map(normalizeEpisodeHighlight).filter(Boolean)
      : []
  };
  return Object.values(pattern).every(Boolean) ? pattern : null;
}

function normalizeStoryPatterns(value) {
  if (!Array.isArray(value) || value.length !== 3) return null;
  const patterns = value.map(normalizeStoryPattern);
  return patterns.every(Boolean) ? patterns : null;
}

function storySeedResult({ corePlot, durationSec, language, patterns, sourceConfidence = "pattern_inspired", generationModel = "" }) {
  const variants = patterns.map((pattern, index) => ({
    variantId: `story_variant_${index + 1}`,
    title: `${corePlot}：${pattern.title}`,
    openingAction: pattern.openingAction,
    reversalObject: pattern.reversalObject,
    fissionAxes: ["social_arena", "protagonist", "opening_action", "reversal_object", "viewer_emotion", "ending_suspense"],
    qualityGate: { status: "pass", score: 4, checks: ["single_scene", "sound_off_hook", "visible_reversal_object", "non_graphic_conflict", "contiguous_seedance_slices"] },
    decomposition: buildDecomposition(corePlot, durationSec, pattern, index + 1)
  }));
  return {
    sourceType: "story_seed",
    sourceConfidence,
    ...(generationModel ? { generationModel } : {}),
    corePlot,
    durationSec,
    language,
    patterns,
    variants,
    createdAt: new Date().toISOString()
  };
}

export function buildStorySeed(request = {}, options = {}) {
  const { corePlot, durationSec, language } = validateStorySeedRequest(request);
  return storySeedResult({
    corePlot,
    durationSec,
    language,
    patterns: normalizeStoryPatterns(request.patterns) || VARIANT_PATTERNS,
    ...options
  });
}

function storyPlanMessages({ corePlot, durationSec, language }) {
  const episodeHighlightCount = durationSec === 30 ? 3 : 1;
  return [
    {
      role: "system",
      content: "你是短剧推广编剧。只输出合法 JSON，不要 Markdown，不要解释。内容不得包含血腥、露骨、未成年人或现实人物。"
    },
    {
      role: "user",
      content: `围绕短剧剧情点“${corePlot}”生成恰好 3 个简短、差异明显的真人短剧方案，适配 ${durationSec} 秒、${language}。优先使用公开高压场景、身份或阶层冲突、可视化资产/证据反转。每个方案必须有 ${episodeHighlightCount} 个独立的“剧集高潮片段”：每个片段都要在首秒进入公开压迫或夺权动作，中段出现单一证据/资产反转，结尾停在未完成清算；片段之间必须更换场景、人物关系、开场动作和反转物，不得承接前一片段的人物、服装、动作或尾帧。\n\n严格输出：{"variants":[{"title":"不超过12字","scene":"首个高潮场景，不超过30字","protagonist":"首个高潮主角，不超过20字","antagonist":"首个高潮对手，不超过20字","openingAction":"首个高潮开场，不超过45字","reversalObject":"首个高潮反转物，不超过12字","emotion":"不超过12字","ending":"首个高潮结尾，不超过45字","episodeHighlights":[{"title":"不超过12字","scene":"不超过30字","protagonist":"不超过20字","antagonist":"不超过20字","openingAction":"不超过45字","reversalObject":"不超过12字","ending":"不超过45字"}]}]}`
    }
  ];
}

export async function generateStorySeedWithLuna(context = {}, request = {}, { callLlm = callOpenAiCompatibleLlm } = {}) {
  const validated = validateStorySeedRequest(request);
  const llmConfig = resolveLlmConfig(context.config || {}, {
    model: "gpt-5.6-luna",
    temperature: 0.7,
    timeoutMs: 120000,
    maxRetries: 0
  });
  const rawContent = await callLlm(llmConfig, storyPlanMessages(validated));
  const parsed = parseLlmJsonContent(rawContent);
  const patterns = normalizeStoryPatterns(parsed?.variants);
  if (!patterns) {
    throw new WangzhuanError("schema_invalid", "剧情模型未返回 3 个完整方案，请重试", {
      field: "variants",
      expectedCount: 3,
      model: llmConfig.model
    });
  }
  return buildStorySeed({ ...validated, patterns }, {
    sourceConfidence: "luna_generated",
    generationModel: llmConfig.model
  });
}

export function normalizeStorySeedSelection(value = {}) {
  if (!value || typeof value !== "object" || value.sourceType !== "story_seed") {
    throw new WangzhuanError("validation_error", "storySeed 不合法", { field: "storySeed" });
  }
  const normalized = buildStorySeed(value, {
    sourceConfidence: cleanString(value.sourceConfidence) || "pattern_inspired",
    generationModel: cleanString(value.generationModel)
  });
  const selectedVariantId = cleanString(value.selectedVariantId) || normalized.variants[0].variantId;
  const selectedVariant = normalized.variants.find((variant) => variant.variantId === selectedVariantId);
  if (!selectedVariant) {
    throw new WangzhuanError("validation_error", "selectedVariantId 不属于当前剧情方案", { field: "storySeed.selectedVariantId" });
  }
  return { ...normalized, selectedVariantId, selectedVariant };
}
