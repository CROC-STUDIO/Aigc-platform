import assert from "node:assert/strict";
import test from "node:test";

import {
  CAPABILITIES,
  getMode,
  listExecutionPaths
} from "../../public/competitor-remix/capability-catalog.js";
import {
  buildPayload,
  redactPayload,
  validateDraft
} from "../../public/competitor-remix/payloads.js";

const urlSource = { mode: "url", url: "https://example.com/source.mp4" };

test("competitor remix exposes five capabilities backed by ten existing execution paths", () => {
  assert.deepEqual(CAPABILITIES.map((item) => item.id), ["remove", "mask", "ending", "language", "analysis"]);
  assert.deepEqual(
    listExecutionPaths().map(({ capabilityId, modeId, jobType }) => [capabilityId, modeId, jobType]),
    [
      ["remove", "seedance", "seedance_ai_remove"],
      ["remove", "automatic", "ai_remove"],
      ["remove", "kframe", "auto_ai_remove"],
      ["remove", "fixed_region", "ai_remove"],
      ["mask", "region", "mask_edit"],
      ["mask", "sticker", "sticker_blur"],
      ["ending", "detect_trim", "end_trim_detection"],
      ["language", "subtitle_translate", "video_copy_translate"],
      ["language", "rewrite", "language_rewrite"],
      ["analysis", "report", "material_analysis"]
    ]
  );
});

test("catalog returns isolated default drafts", () => {
  const first = getMode("remove", "kframe").createDraft();
  first.points.push({ x: 0.2, y: 0.3, label: "positive" });
  const second = getMode("remove", "kframe").createDraft();
  assert.deepEqual(second.points, []);
  assert.equal(second.sampleFps, 1);
});

test("payload builder preserves every video-ops execution contract", () => {
  const seedance = buildPayload({
    capabilityId: "remove",
    modeId: "seedance",
    source: urlSource,
    draft: { prompt: "Remove logo", ratio: "9:16", resolution: "1080p", segmentSeconds: 30, priority: 3 }
  });
  assert.deepEqual(seedance, {
    job_type: "seedance_ai_remove",
    input: { source_type: "url", source: urlSource.url },
    options: { priority: 3 },
    params: { prompt: "Remove logo", ratio: "9:16", resolution: "1080p", segment_seconds: 30 }
  });

  const automatic = buildPayload({
    capabilityId: "remove",
    modeId: "automatic",
    source: urlSource,
    draft: { maskThreshold: 2 }
  });
  assert.deepEqual(automatic.params, { mode: "auto", mask_threshold: 2 });

  const kframe = buildPayload({
    capabilityId: "remove",
    modeId: "kframe",
    source: urlSource,
    draft: {
      promptType: "point",
      frameIndex: 24,
      points: [{ x: 0.25, y: 0.5, label: "negative" }],
      sampleFps: 1.5,
      maxFrames: 32,
      removalEngine: "lama",
      maskThreshold: 3
    }
  });
  assert.deepEqual(kframe.params, {
    sample_fps: 1.5,
    max_frames: 32,
    removal_engine: "lama",
    mask_threshold: 3,
    interaction_prompt: {
      prompt_type: "point",
      frame_index: 24,
      points: [{ x: 0.25, y: 0.5, label: "negative", coordinate_space: "normalized" }]
    }
  });

  const manual = buildPayload({
    capabilityId: "remove",
    modeId: "fixed_region",
    source: urlSource,
    draft: { box: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.6 }, startMs: 100, endMs: 2200, maskThreshold: 4 },
    maskSource: "data:image/png;base64,AAAA"
  });
  assert.deepEqual(manual.params, {
    mode: "manual",
    mask_source: "data:image/png;base64,AAAA",
    time_ranges: [{ start_ms: 100, end_ms: 2200 }],
    mask_threshold: 4
  });

  const region = buildPayload({
    capabilityId: "mask",
    modeId: "region",
    source: urlSource,
    draft: { box: { x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.9 }, blurSigma: 44, maskThreshold: 1, fillColor: "#112233", fillOpacity: 0.7 }
  });
  assert.equal(region.job_type, "mask_edit");
  assert.deepEqual(region.params.region_spec, [{ type: "box", x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.9, coordinate_space: "normalized" }]);

  const sticker = buildPayload({
    capabilityId: "mask",
    modeId: "sticker",
    source: urlSource,
    draft: { box: { x1: 0.05, y1: 0.05, x2: 0.3, y2: 0.2 } }
  });
  assert.equal(sticker.job_type, "sticker_blur");

  const ending = buildPayload({
    capabilityId: "ending",
    modeId: "detect_trim",
    source: urlSource,
    draft: { tailDetectSeconds: 20, competitorKeywords: "下载\n立即安装", reviewThreshold: 0.6, trimMode: "precise", allowReencode: true, safeTrimMarginMs: 500 }
  });
  assert.deepEqual(ending.params, {
    tail_detect_seconds: 20,
    competitor_keywords: ["下载", "立即安装"],
    review_threshold: 0.6,
    trim_mode: "precise",
    allow_reencode: true,
    safe_trim_margin_ms: 500
  });

  const translate = buildPayload({
    capabilityId: "language",
    modeId: "subtitle_translate",
    source: urlSource,
    draft: { targetLanguage: "ja", sourceMode: "auto", renderMode: "subtitle_band", subtitleRoiMode: "auto", subtitleRemovalMode: "band" }
  });
  assert.equal(translate.job_type, "video_copy_translate");
  assert.deepEqual(translate.params, {
    target_language: "ja",
    source_mode: "auto",
    render_mode: "subtitle_band",
    subtitle_roi_mode: "auto",
    subtitle_removal_mode: "band"
  });

  const rewrite = buildPayload({
    capabilityId: "language",
    modeId: "rewrite",
    source: urlSource,
    draft: { targetLanguage: "fr" }
  });
  assert.deepEqual(rewrite.params, { target_language: "fr" });

  const analysis = buildPayload({
    capabilityId: "analysis",
    modeId: "report",
    source: { mode: "report", reportText: "CTR 下降，转化成本上升" },
    draft: { useLlm: false }
  });
  assert.deepEqual(analysis, {
    job_type: "material_analysis",
    input: { source_type: "report_text", source: "CTR 下降，转化成本上升" },
    options: { priority: 0 },
    params: { use_llm: false }
  });
});

test("payload validation reports missing visual interactions without throwing", () => {
  const point = validateDraft({
    capabilityId: "remove",
    modeId: "kframe",
    source: urlSource,
    draft: { promptType: "point", points: [] }
  });
  assert.equal(point.ok, false);
  assert.equal(point.errors.interaction, "请至少点选一个对象位置");

  const box = validateDraft({
    capabilityId: "mask",
    modeId: "region",
    source: urlSource,
    draft: { box: null }
  });
  assert.equal(box.ok, false);
  assert.equal(box.errors.interaction, "请在视频画面中框选处理区域");
});

test("payload clamps shared priority and redacts source and mask content", () => {
  const payload = buildPayload({
    capabilityId: "remove",
    modeId: "fixed_region",
    source: { mode: "file", dataUrl: "data:video/mp4;base64,SECRET" },
    draft: { box: { x1: 0.1, y1: 0.1, x2: 0.2, y2: 0.2 }, startMs: 0, endMs: 1000, priority: 99 },
    maskSource: "data:image/png;base64,MASKSECRET"
  });
  assert.equal(payload.options.priority, 10);
  assert.deepEqual(redactPayload(payload), {
    ...payload,
    input: { ...payload.input, source: "<redacted>" },
    params: { ...payload.params, mask_source: "<redacted>" }
  });
});
