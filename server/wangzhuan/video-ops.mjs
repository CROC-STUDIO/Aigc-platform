import { DEFAULT_LIMITS } from "./constants.mjs";
import { effectiveLimits } from "./config.mjs";
import { WangzhuanError } from "./http.mjs";
import { createRemixProviderClient } from "./remix-provider.mjs";

export const VIDEO_OPS_JOB_TYPES = Object.freeze([
  "end_trim_detection",
  "mask_edit",
  "sticker_blur",
  "ai_remove",
  "auto_ai_remove",
  "seedance_ai_remove",
  "language_rewrite",
  "video_copy_translate",
  "material_analysis"
]);

const VIDEO_OPS_JOB_TYPE_SET = new Set(VIDEO_OPS_JOB_TYPES);
const VIDEO_INPUT_SOURCE_TYPES = new Set(["url", "base64_data_url", "local_path"]);

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberInRange(value, { min = -Infinity, max = Infinity, fallback = null, integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const clamped = Math.min(max, Math.max(min, number));
  return integer ? Math.round(clamped) : clamped;
}

function validation(message, data = {}) {
  throw new WangzhuanError("validation_error", message, data);
}

function dataUrlByteLength(dataUrl = "") {
  if (typeof dataUrl !== "string" || !dataUrl.includes(",")) return 0;
  try {
    return Buffer.from(dataUrl.split(",").pop() || "", "base64").length;
  } catch {
    return 0;
  }
}

function validateInput(input = {}, jobType = "", limits = DEFAULT_LIMITS) {
  const sourceType = cleanString(input.source_type || input.sourceType);
  if (!sourceType) validation("input.source_type 必填", { field: "input.source_type" });
  const allowed = jobType === "material_analysis" ? new Set(["report_text"]) : VIDEO_INPUT_SOURCE_TYPES;
  if (!allowed.has(sourceType)) {
    validation("input.source_type 不支持当前任务", { field: "input.source_type", jobType, sourceType });
  }
  const source = input.source;
  if (sourceType === "url" && !/^https?:\/\//i.test(cleanString(source))) {
    validation("视频 URL 必须是 http(s) 地址", { field: "input.source" });
  }
  if (sourceType === "base64_data_url") {
    if (!String(source || "").startsWith("data:")) {
      validation("上传文件内容必须是 data URL", { field: "input.source" });
    }
    const sizeBytes = dataUrlByteLength(source);
    if (!sizeBytes) {
      validation("上传素材读取失败，请重新选择素材", { field: "input.source" });
    }
    if (sizeBytes > limits.maxUploadVideoBytes) {
      validation("文件超过大小上限", {
        field: "input.source",
        sizeBytes,
        maxUploadVideoBytes: limits.maxUploadVideoBytes
      });
    }
  }
  if (sourceType === "local_path" && !cleanString(source)) {
    validation("local_path 输入不能为空", { field: "input.source" });
  }
  if (sourceType === "report_text") {
    if (typeof source !== "string" && !(source && typeof source === "object")) {
      validation("material_analysis 需要 report_text 输入", { field: "input.source" });
    }
  }
  return { source_type: sourceType, source };
}

function validatePoint(point = {}, index = 0) {
  const x = Number(point.x);
  const y = Number(point.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    validation("point 坐标必须是数字", { field: `params.interaction_prompt.points[${index}]` });
  }
  return {
    x,
    y,
    label: point.label === "negative" ? "negative" : "positive",
    coordinate_space: point.coordinate_space === "pixel" ? "pixel" : "normalized"
  };
}

function validateBox(box = {}) {
  const x1 = Number(box.x1);
  const y1 = Number(box.y1);
  const x2 = Number(box.x2);
  const y2 = Number(box.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) {
    validation("box 坐标必须满足 x2 > x1 且 y2 > y1", { field: "params.interaction_prompt.box" });
  }
  return {
    x1,
    y1,
    x2,
    y2,
    coordinate_space: box.coordinate_space === "pixel" ? "pixel" : "normalized"
  };
}

function validateInteractionPrompt(raw = null) {
  if (!raw) return null;
  const promptType = raw.prompt_type || raw.promptType;
  const frameIndex = numberInRange(raw.frame_index ?? raw.frameIndex, { min: 0, fallback: 0, integer: true });
  if (promptType === "point") {
    const points = Array.isArray(raw.points) ? raw.points.map(validatePoint) : [];
    if (!points.length) validation("Point Prompt 至少需要一个点", { field: "params.interaction_prompt.points" });
    return { prompt_type: "point", frame_index: frameIndex, points };
  }
  if (promptType === "box") {
    return { prompt_type: "box", frame_index: frameIndex, box: validateBox(raw.box || {}) };
  }
  validation("interaction_prompt.prompt_type 只支持 point 或 box", { field: "params.interaction_prompt.prompt_type" });
}

function validateTimeRanges(ranges = []) {
  if (!Array.isArray(ranges) || !ranges.length) {
    validation("ai_remove manual 需要 time_ranges", { field: "params.time_ranges" });
  }
  return ranges.map((range, index) => {
    const startMs = numberInRange(range.start_ms ?? range.startMs, { min: 0, fallback: null, integer: true });
    const endMs = numberInRange(range.end_ms ?? range.endMs, { min: 1, fallback: null, integer: true });
    if (startMs === null || endMs === null || endMs <= startMs) {
      validation("time_ranges 必须满足 end_ms > start_ms", { field: `params.time_ranges[${index}]` });
    }
    return { start_ms: startMs, end_ms: endMs };
  });
}

function validateRegionSpec(raw = null) {
  if (!raw || typeof raw !== "object") {
    validation("mask_edit 需要 region_spec", { field: "params.region_spec" });
  }
  return { type: "box", ...validateBox(raw) };
}

function validateSubtitleRoi(value) {
  if (value === undefined || value === null || value === "") return undefined;
  if (!Array.isArray(value) || value.length !== 4) {
    validation("subtitle_roi 必须是 [x1,y1,x2,y2]", { field: "params.subtitle_roi" });
  }
  const roi = value.map(Number);
  if (!roi.every((item) => Number.isFinite(item) && item >= 0 && item <= 1) || roi[2] <= roi[0] || roi[3] <= roi[1]) {
    validation("subtitle_roi 必须是 0-1 归一化坐标且 x2>x1,y2>y1", { field: "params.subtitle_roi" });
  }
  return roi;
}

function validateCommonMaskParams(params = {}) {
  const out = {};
  if (params.region_spec !== undefined) out.region_spec = params.region_spec;
  if (params.blur_sigma !== undefined) out.blur_sigma = numberInRange(params.blur_sigma, { min: 0, max: 200, fallback: 40 });
  if (params.mask_threshold !== undefined) out.mask_threshold = numberInRange(params.mask_threshold, { min: 0, max: 255, fallback: 1, integer: true });
  if (params.fill_color) out.fill_color = String(params.fill_color);
  if (params.fill_opacity !== undefined) out.fill_opacity = numberInRange(params.fill_opacity, { min: 0, max: 1, fallback: 1 });
  return out;
}

function validateParams(jobType, params = {}) {
  switch (jobType) {
    case "seedance_ai_remove":
      return {
        prompt: cleanString(params.prompt, "Remove visible app icon, logo, watermark, and overlay brand marks. Keep the original scene, timing, motion, and camera movement."),
        ratio: cleanString(params.ratio, "auto"),
        resolution: cleanString(params.resolution, "720p"),
        segment_seconds: numberInRange(params.segment_seconds, { min: 1, max: 30, fallback: 15, integer: true })
      };
    case "auto_ai_remove": {
      const interaction = validateInteractionPrompt(params.interaction_prompt || params.interactionPrompt || null);
      if (!interaction) {
        validation("auto_ai_remove 需要 interaction_prompt", { field: "params.interaction_prompt" });
      }
      return {
        prompts: Array.isArray(params.prompts) ? params.prompts.map((item) => String(item).trim()).filter(Boolean) : [],
        sample_fps: numberInRange(params.sample_fps, { min: 0, max: 10, fallback: 1 }),
        max_frames: numberInRange(params.max_frames, { min: 1, max: 1000, fallback: 20, integer: true }),
        removal_engine: ["configured", "lama", "fallback_blur"].includes(params.removal_engine) ? params.removal_engine : "configured",
        mask_threshold: numberInRange(params.mask_threshold, { min: 0, max: 255, fallback: 1, integer: true }),
        interaction_prompt: interaction
      };
    }
    case "ai_remove": {
      const mode = params.mode === "auto" ? "auto" : "manual";
      if (mode === "auto") {
        return { mode, mask_threshold: numberInRange(params.mask_threshold, { min: 0, max: 255, fallback: 1, integer: true }) };
      }
      const maskSource = cleanString(params.mask_source || params.maskSource);
      if (!maskSource) validation("ai_remove manual 需要 mask_source", { field: "params.mask_source" });
      return {
        mode,
        mask_source: maskSource,
        time_ranges: validateTimeRanges(params.time_ranges || params.timeRanges),
        mask_threshold: numberInRange(params.mask_threshold, { min: 0, max: 255, fallback: 1, integer: true })
      };
    }
    case "mask_edit":
    case "sticker_blur": {
      const out = validateCommonMaskParams(params);
      out.region_spec = validateRegionSpec(params.region_spec);
      return out;
    }
    case "end_trim_detection":
      return {
        tail_detect_seconds: numberInRange(params.tail_detect_seconds, { min: 1, max: 30, fallback: 15, integer: true }),
        competitor_keywords: Array.isArray(params.competitor_keywords) ? params.competitor_keywords.map(String).filter(Boolean) : [],
        review_threshold: numberInRange(params.review_threshold, { min: 0, max: 1, fallback: 0.55 }),
        trim_mode: params.trim_mode === "precise" ? "precise" : "fast",
        allow_reencode: Boolean(params.allow_reencode),
        safe_trim_margin_ms: numberInRange(params.safe_trim_margin_ms, { min: 0, max: 5000, fallback: 300, integer: true })
      };
    case "video_copy_translate": {
      const roi = validateSubtitleRoi(params.subtitle_roi);
      return {
        target_language: cleanString(params.target_language, "en"),
        source_mode: cleanString(params.source_mode, "auto"),
        render_mode: cleanString(params.render_mode, "subtitle_band"),
        subtitle_roi_mode: cleanString(params.subtitle_roi_mode, "auto"),
        subtitle_removal_mode: cleanString(params.subtitle_removal_mode, "band"),
        ...(params.timeline_alignment ? { timeline_alignment: String(params.timeline_alignment) } : {}),
        ...(params.asr_engine ? { asr_engine: String(params.asr_engine) } : {}),
        ...(params.asr_model ? { asr_model: String(params.asr_model) } : {}),
        ...(roi ? { subtitle_roi: roi } : {})
      };
    }
    case "language_rewrite":
      return { target_language: cleanString(params.target_language, "en") };
    case "material_analysis":
      return { use_llm: params.use_llm !== false };
    default:
      validation("job_type 不在白名单内", { field: "job_type", jobType });
  }
}

export function validateVideoOpsJobRequest(request = {}, options = {}) {
  const limits = options.limits || DEFAULT_LIMITS;
  const jobType = cleanString(request.job_type || request.jobType);
  if (!VIDEO_OPS_JOB_TYPE_SET.has(jobType)) {
    validation("job_type 不在 video-content-ops 白名单内", { field: "job_type", jobType });
  }
  return {
    job_type: jobType,
    input: validateInput(request.input || {}, jobType, limits),
    callback_url: request.callback_url || null,
    options: {
      priority: numberInRange(request.options?.priority, { min: 0, max: 10, fallback: 0, integer: true })
    },
    params: validateParams(jobType, request.params || {})
  };
}

function videoOpsClient(context) {
  const videoOpsConfig = context.config?.wangzhuan?.videoOpsProvider && typeof context.config.wangzhuan.videoOpsProvider === "object"
    ? context.config.wangzhuan.videoOpsProvider
    : {};
  const videoOpsEndpoint = cleanString(videoOpsConfig.endpoint, cleanString(process.env.WANGZHUAN_VIDEO_OPS_ENDPOINT));
  const client = context.videoOpsProviderClient || (videoOpsEndpoint
    ? createRemixProviderClient({ ...context, remixProviderClient: null }, {
      ...videoOpsConfig,
      endpoint: videoOpsEndpoint,
      apiKeyEnv: videoOpsConfig.apiKeyEnv || process.env.WANGZHUAN_VIDEO_OPS_API_KEY_ENV || "VIDEO_AIGC_API_KEY"
    })
    : (context.remixProviderClient || createRemixProviderClient(context, {})));
  if (!client) {
    throw new WangzhuanError("unsupported_capability", "video-content-ops 接口未配置", {
      unsupportedReason: "missing video processing endpoint"
    });
  }
  return client;
}

function providerJobId(job) {
  return String(job?.job_id || job?.jobId || job?.id || "");
}

export async function createVideoOpsJob(context, request = {}) {
  const limits = effectiveLimits(context.config || {});
  const payload = validateVideoOpsJobRequest(request, { limits });
  const job = await videoOpsClient(context).createJob(payload);
  return {
    jobId: providerJobId(job),
    jobType: job?.job_type || job?.jobType || payload.job_type,
    status: job?.status || "queued",
    providerJob: job,
    request: {
      job_type: payload.job_type,
      input: { source_type: payload.input.source_type },
      params: payload.params
    }
  };
}

export async function getVideoOpsJob(context, jobId, query = {}) {
  const safeJobId = cleanString(jobId);
  if (!safeJobId) validation("job_id 必填", { field: "job_id" });
  const includeModelCalls = query.include_model_calls === "true" || query.includeModelCalls === true;
  return videoOpsClient(context).getJob(safeJobId, includeModelCalls ? "include_model_calls=true" : "");
}

export async function getVideoOpsJobResult(context, jobId, query = {}) {
  const safeJobId = cleanString(jobId);
  if (!safeJobId) validation("job_id 必填", { field: "job_id" });
  const includeModelCalls = query.include_model_calls === "true" || query.includeModelCalls === true;
  return videoOpsClient(context).getJobResult(safeJobId, includeModelCalls ? "include_model_calls=true" : "");
}

export async function cancelVideoOpsJob(context, jobId) {
  const safeJobId = cleanString(jobId);
  if (!safeJobId) validation("job_id 必填", { field: "job_id" });
  return videoOpsClient(context).cancelJob(safeJobId);
}

export async function retryVideoOpsJob(context, jobId) {
  const safeJobId = cleanString(jobId);
  if (!safeJobId) validation("job_id 必填", { field: "job_id" });
  return videoOpsClient(context).retryJob(safeJobId);
}

export async function downloadVideoOpsJob(context, jobId) {
  const safeJobId = cleanString(jobId);
  if (!safeJobId) validation("job_id 必填", { field: "job_id" });
  return videoOpsClient(context).downloadJob(safeJobId);
}
