import { getMode } from "./capability-catalog.js";

function clampNumber(value, min, max, fallback, { integer = false } = {}) {
  const number = Number(value);
  const safe = Number.isFinite(number) ? number : fallback;
  const clamped = Math.min(max, Math.max(min, safe));
  return integer ? Math.round(clamped) : clamped;
}

function cleanString(value, fallback = "") {
  const cleaned = String(value ?? "").trim();
  return cleaned || fallback;
}

function normalizedBox(box) {
  if (!box || typeof box !== "object") return null;
  const x1 = Number(box.x1);
  const y1 = Number(box.y1);
  const x2 = Number(box.x2);
  const y2 = Number(box.y2);
  if (![x1, y1, x2, y2].every(Number.isFinite) || x2 <= x1 || y2 <= y1) return null;
  return {
    x1: clampNumber(x1, 0, 1, 0),
    y1: clampNumber(y1, 0, 1, 0),
    x2: clampNumber(x2, 0, 1, 1),
    y2: clampNumber(y2, 0, 1, 1)
  };
}

function resolveMode(capabilityId, modeId) {
  const selected = getMode(capabilityId, modeId);
  if (!selected) throw new Error("不支持的处理功能或模式");
  return selected;
}

function withDefaults(selected, draft = {}) {
  return { ...selected.createDraft(), ...(draft || {}) };
}

function sourceError(capabilityId, source = {}) {
  if (capabilityId === "analysis") {
    return cleanString(source.reportText) ? "" : "请填写需要分析的报告文本";
  }
  if (source.mode === "url") {
    return /^https?:\/\//i.test(cleanString(source.url)) ? "" : "请填写 http(s) 视频 URL";
  }
  if (source.mode === "file") {
    return source.file || cleanString(source.dataUrl) ? "" : "请选择视频文件";
  }
  return "请选择视频 URL 或上传文件";
}

export function validateDraft({ capabilityId, modeId, source = {}, draft = {} } = {}) {
  const selected = getMode(capabilityId, modeId);
  if (!selected) return { ok: false, errors: { mode: "不支持的处理功能或模式" }, requirements: [] };
  const values = withDefaults(selected, draft);
  const errors = {};
  const sourceMessage = sourceError(capabilityId, source);
  if (sourceMessage) errors.source = sourceMessage;

  if (selected.editor === "kframe") {
    if (values.promptType === "point" && !values.points?.length) errors.interaction = "请至少点选一个对象位置";
    if (values.promptType !== "point" && !normalizedBox(values.box)) errors.interaction = "请在 K 帧画面中框选对象";
  }
  if (selected.editor === "region" && !normalizedBox(values.box)) {
    errors.interaction = capabilityId === "mask" ? "请在视频画面中框选处理区域" : "请在视频画面中框选需要去除的区域";
  }
  if (capabilityId === "remove" && modeId === "fixed_region") {
    const startMs = Number(values.startMs);
    const endMs = Number(values.endMs);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) {
      errors.timeRange = "结束时间必须大于开始时间";
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    requirements: [
      { id: "source", ready: !errors.source, label: errors.source || (capabilityId === "analysis" ? "报告文本已填写" : "输入素材已就绪") },
      ...(selected.editor === "none" || selected.editor === "report"
        ? []
        : [{ id: "interaction", ready: !errors.interaction, label: errors.interaction || "画面选择已完成" }]),
      { id: "params", ready: !errors.timeRange, label: errors.timeRange || "任务参数有效" }
    ]
  };
}

function buildInput(capabilityId, source) {
  if (capabilityId === "analysis") {
    return { source_type: "report_text", source: cleanString(source.reportText) };
  }
  if (source.mode === "file") {
    const dataUrl = cleanString(source.dataUrl);
    if (!dataUrl.startsWith("data:")) throw new Error("视频文件尚未准备完成");
    return { source_type: "base64_data_url", source: dataUrl };
  }
  return { source_type: "url", source: cleanString(source.url) };
}

function interactionPrompt(values) {
  const frameIndex = clampNumber(values.frameIndex, 0, Number.MAX_SAFE_INTEGER, 0, { integer: true });
  if (values.promptType === "point") {
    return {
      prompt_type: "point",
      frame_index: frameIndex,
      points: (values.points || []).map((point) => ({
        x: clampNumber(point.x, 0, 1, 0),
        y: clampNumber(point.y, 0, 1, 0),
        label: point.label === "negative" ? "negative" : "positive",
        coordinate_space: "normalized"
      }))
    };
  }
  return { prompt_type: "box", frame_index: frameIndex, box: { ...normalizedBox(values.box), coordinate_space: "normalized" } };
}

function regionParams(values) {
  const box = normalizedBox(values.box);
  return {
    region_spec: [{
      shape: "rectangle",
      x: box.x1,
      y: box.y1,
      width: Number((box.x2 - box.x1).toFixed(6)),
      height: Number((box.y2 - box.y1).toFixed(6)),
      coordinate_space: "normalized",
      time_ranges: []
    }],
    blur_sigma: clampNumber(values.blurSigma, 0, 200, 40, { integer: true }),
    mask_threshold: clampNumber(values.maskThreshold, 0, 255, 1, { integer: true }),
    fill_color: cleanString(values.fillColor, "#000000"),
    fill_opacity: clampNumber(values.fillOpacity, 0, 1, 1)
  };
}

function buildParams(capabilityId, modeId, values, maskSource) {
  if (capabilityId === "remove" && modeId === "seedance") {
    return {
      prompt: cleanString(values.prompt),
      ratio: cleanString(values.ratio, "auto"),
      resolution: cleanString(values.resolution, "720p"),
      segment_seconds: clampNumber(values.segmentSeconds, 1, 30, 15, { integer: true })
    };
  }
  if (capabilityId === "remove" && modeId === "automatic") {
    return { mode: "auto", mask_threshold: clampNumber(values.maskThreshold, 0, 255, 1, { integer: true }) };
  }
  if (capabilityId === "remove" && modeId === "kframe") {
    return {
      sample_fps: clampNumber(values.sampleFps, 0, 10, 1),
      max_frames: clampNumber(values.maxFrames, 1, 1000, 20, { integer: true }),
      removal_engine: ["configured", "lama", "fallback_blur"].includes(values.removalEngine) ? values.removalEngine : "configured",
      mask_threshold: clampNumber(values.maskThreshold, 0, 255, 1, { integer: true }),
      interaction_prompt: interactionPrompt(values)
    };
  }
  if (capabilityId === "remove" && modeId === "fixed_region") {
    if (!cleanString(maskSource).startsWith("data:image/png")) throw new Error("框选区域尚未生成 mask");
    return {
      mode: "manual",
      mask_source: maskSource,
      time_ranges: [{
        start_ms: clampNumber(values.startMs, 0, Number.MAX_SAFE_INTEGER, 0, { integer: true }),
        end_ms: clampNumber(values.endMs, 1, Number.MAX_SAFE_INTEGER, 15000, { integer: true })
      }],
      mask_threshold: clampNumber(values.maskThreshold, 0, 255, 1, { integer: true })
    };
  }
  if (capabilityId === "mask") return regionParams(values);
  if (capabilityId === "ending") {
    return {
      tail_detect_seconds: clampNumber(values.tailDetectSeconds, 1, 30, 15, { integer: true }),
      competitor_keywords: cleanString(values.competitorKeywords).split(/\n+/).map((item) => item.trim()).filter(Boolean),
      review_threshold: clampNumber(values.reviewThreshold, 0, 1, 0.55),
      trim_mode: values.trimMode === "precise" ? "precise" : "fast",
      allow_reencode: Boolean(values.allowReencode),
      safe_trim_margin_ms: clampNumber(values.safeTrimMarginMs, 0, 5000, 300, { integer: true })
    };
  }
  if (capabilityId === "language" && modeId === "subtitle_translate") {
    return {
      target_language: cleanString(values.targetLanguage, "en"),
      source_mode: cleanString(values.sourceMode, "auto"),
      render_mode: cleanString(values.renderMode, "subtitle_band"),
      subtitle_roi_mode: cleanString(values.subtitleRoiMode, "auto"),
      subtitle_removal_mode: cleanString(values.subtitleRemovalMode, "band")
    };
  }
  if (capabilityId === "language" && modeId === "rewrite") {
    return { target_language: cleanString(values.targetLanguage, "en") };
  }
  if (capabilityId === "analysis") return { use_llm: values.useLlm !== false };
  return {};
}

export function buildPayload({ capabilityId, modeId, source = {}, draft = {}, maskSource = "" } = {}) {
  const selected = resolveMode(capabilityId, modeId);
  const values = withDefaults(selected, draft);
  const validation = validateDraft({ capabilityId, modeId, source, draft: values });
  if (!validation.ok) throw new Error(Object.values(validation.errors)[0]);
  return {
    job_type: selected.jobType,
    input: buildInput(capabilityId, source),
    options: { priority: clampNumber(values.priority, 0, 10, 0, { integer: true }) },
    params: buildParams(capabilityId, modeId, values, maskSource)
  };
}

export function redactPayload(payload = {}) {
  const copy = JSON.parse(JSON.stringify(payload));
  if (copy.input?.source) copy.input.source = "<redacted>";
  if (copy.params?.mask_source) copy.params.mask_source = "<redacted>";
  return copy;
}
