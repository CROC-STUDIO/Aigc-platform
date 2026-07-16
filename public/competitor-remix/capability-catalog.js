const DEFAULT_SEEDANCE_PROMPT = "Remove visible app icon, logo, watermark, and overlay brand marks. Keep the original scene, timing, motion, and camera movement.";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mode(id, label, jobType, editor, defaults, { hidden = false } = {}) {
  return Object.freeze({
    id,
    label,
    jobType,
    editor,
    hidden,
    defaults: Object.freeze(clone(defaults)),
    createDraft() {
      return clone(defaults);
    }
  });
}

export const CAPABILITIES = Object.freeze([
  Object.freeze({
    id: "remove",
    label: "去除画面元素",
    description: "去除 logo、icon、水印或指定对象",
    modes: Object.freeze([
      mode("seedance", "智能重绘", "seedance_ai_remove", "none", {
        prompt: DEFAULT_SEEDANCE_PROMPT,
        ratio: "auto",
        resolution: "720p",
        segmentSeconds: 15,
        priority: 0
      }, { hidden: true }),
      mode("automatic", "自动检测", "ai_remove", "none", {
        maskThreshold: 1,
        priority: 0
      }),
      mode("kframe", "K 帧选对象", "auto_ai_remove", "kframe", {
        promptType: "box",
        pointLabel: "positive",
        frameIndex: 0,
        frameTime: 0,
        points: [],
        box: null,
        sampleFps: 1,
        maxFrames: 20,
        removalEngine: "configured",
        maskThreshold: 1,
        priority: 0
      }),
      mode("fixed_region", "固定区域", "ai_remove", "region", {
        box: null,
        startMs: 0,
        endMs: 15000,
        maskThreshold: 1,
        priority: 0
      })
    ])
  }),
  Object.freeze({
    id: "mask",
    label: "局部遮挡与模糊",
    description: "框选区域进行遮挡、填色或模糊",
    modes: Object.freeze([
      mode("region", "区域遮挡或模糊", "mask_edit", "region", {
        box: null,
        blurSigma: 40,
        maskThreshold: 1,
        fillColor: "#000000",
        fillOpacity: 1,
        priority: 0
      }),
      mode("sticker", "贴纸或水印模糊", "local_sticker_overlay", "region", {
        box: null,
        stickerScaleMode: "short_side",
        priority: 0
      })
    ])
  }),
  Object.freeze({
    id: "ending",
    label: "尾段处理",
    description: "检测并裁剪导流或竞品尾段",
    modes: Object.freeze([
      mode("detect_trim", "检测并裁剪", "end_trim_detection", "none", {
        tailDetectSeconds: 15,
        competitorKeywords: "",
        reviewThreshold: 0.55,
        trimMode: "fast",
        allowReencode: false,
        safeTrimMarginMs: 300,
        priority: 0
      })
    ])
  }),
  Object.freeze({
    id: "language",
    label: "语言处理",
    description: "翻译字幕或改写视频语言内容",
    modes: Object.freeze([
      mode("subtitle_translate", "字幕翻译回写", "video_copy_translate", "none", {
        targetLanguage: "en",
        sourceMode: "auto",
        renderMode: "subtitle_band",
        subtitleRoiMode: "auto",
        subtitleRemovalMode: "band",
        priority: 0
      }),
      mode("rewrite", "语言改写", "language_rewrite", "none", {
        targetLanguage: "en",
        priority: 0
      })
    ])
  }),
  Object.freeze({
    id: "analysis",
    label: "素材分析",
    description: "根据投放报告文本分析素材表现",
    modes: Object.freeze([
      mode("report", "分析报告文本", "material_analysis", "report", {
        useLlm: true,
        priority: 0
      })
    ])
  })
]);

export function getCapability(capabilityId) {
  return CAPABILITIES.find((item) => item.id === capabilityId) || null;
}

export function getMode(capabilityId, modeId) {
  return getCapability(capabilityId)?.modes.find((item) => item.id === modeId) || null;
}

export function listExecutionPaths() {
  return CAPABILITIES.flatMap((capability) => capability.modes.map((item) => ({
    capabilityId: capability.id,
    modeId: item.id,
    jobType: item.jobType
  })));
}
