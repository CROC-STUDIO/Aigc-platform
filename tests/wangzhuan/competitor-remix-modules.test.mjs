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
import { createRemixStore } from "../../public/competitor-remix/store.js";
import { createMediaWorkspace } from "../../public/competitor-remix/media-workspace.js";
import {
  createRegionEditor,
  normalizedBox,
  normalizedPoint,
  selectionForPrompt,
  visibleMediaRect
} from "../../public/competitor-remix/editors.js";
import { createJobRunner } from "../../public/competitor-remix/job-runner.js";

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

test("Seedance redraw remains adapted but is hidden from the user workflow", () => {
  const remove = CAPABILITIES.find((item) => item.id === "remove");
  assert.equal(getMode("remove", "seedance").hidden, true);
  assert.deepEqual(remove.modes.filter((item) => !item.hidden).map((item) => item.id), [
    "automatic",
    "kframe",
    "fixed_region"
  ]);

  const store = createRemixStore({ storage: createMemoryStorage() });
  assert.equal(store.getState().selectedModes.remove, "automatic");
  store.selectMode("remove", "seedance");
  assert.equal(store.getState().selectedModes.remove, "automatic");
});

test("restored drafts migrate away from the hidden Seedance redraw mode", () => {
  const persisted = createMemoryStorage();
  persisted.setItem("competitor-remix:v2", JSON.stringify({ selectedModes: { remove: "seedance" } }));
  assert.equal(createRemixStore({ storage: persisted }).getState().selectedModes.remove, "automatic");
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
  assert.deepEqual(region.params.region_spec, [{
    shape: "rectangle",
    x: 0.2,
    y: 0.3,
    width: 0.6,
    height: 0.6,
    coordinate_space: "normalized",
    time_ranges: []
  }]);

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

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    }
  };
}

test("store keeps drafts isolated while capability and mode selections change", () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  store.updateDraft("remove", "kframe", { frameIndex: 42, points: [{ x: 0.2, y: 0.3, label: "positive" }] });
  store.selectMode("remove", "automatic");
  store.updateDraft("remove", "automatic", { maskThreshold: 8 });
  store.selectCapability("mask");

  assert.equal(store.getDraft("remove", "kframe").frameIndex, 42);
  assert.equal(store.getDraft("remove", "automatic").maskThreshold, 8);
  assert.equal(store.getDraft("mask", "region").maskThreshold, 1);
  assert.equal(store.getState().selectedCapabilityId, "mask");
});

test("replacing shared media clears visual coordinates but preserves ordinary parameters", () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  store.updateDraft("remove", "kframe", {
    frameIndex: 42,
    frameTime: 1.4,
    box: { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 },
    points: [{ x: 0.2, y: 0.3, label: "positive" }],
    sampleFps: 2
  });
  store.updateDraft("mask", "region", {
    box: { x1: 0.2, y1: 0.2, x2: 0.8, y2: 0.8 },
    blurSigma: 55
  });

  store.replaceSource({ mode: "file", file: { name: "next.mp4" }, objectUrl: "blob:next", identity: "next.mp4:1" });

  assert.deepEqual(store.getDraft("remove", "kframe").points, []);
  assert.equal(store.getDraft("remove", "kframe").box, null);
  assert.equal(store.getDraft("remove", "kframe").frameIndex, 0);
  assert.equal(store.getDraft("remove", "kframe").sampleFps, 2);
  assert.equal(store.getDraft("mask", "region").box, null);
  assert.equal(store.getDraft("mask", "region").blurSigma, 55);
});

test("store tracks concurrent runs and persists only serializable non-secret state", () => {
  const storage = createMemoryStorage();
  const store = createRemixStore({ storage });
  store.setUser({ username: "lucy", token: "secret" });
  store.replaceSource({
    mode: "file",
    file: { name: "source.mp4" },
    fileName: "source.mp4",
    objectUrl: "blob:source",
    dataUrl: "data:video/mp4;base64,SECRET",
    identity: "source.mp4:100"
  });
  store.upsertRun({ runId: "run-1", providerJobId: "job-1", status: "running", requestSnapshot: { input: { source: "<redacted>" } } });
  store.upsertRun({ runId: "run-2", providerJobId: "job-2", status: "queued" });
  store.setActiveRun("run-2");

  assert.equal(store.getState().runs.length, 2);
  assert.equal(store.getState().activeRunId, "run-2");

  const persisted = storage.getItem("competitor-remix:v2");
  assert.doesNotMatch(persisted, /SECRET|blob:source|token|lucy/);
  assert.match(persisted, /source\.mp4/);
  assert.match(persisted, /job-1/);

  const restored = createRemixStore({ storage });
  assert.equal(restored.getState().runs.length, 2);
  assert.equal(restored.getState().source.needsFile, true);
  assert.equal(restored.getState().source.file, null);
});

test("reset current draft leaves shared source, other drafts, and runs intact", () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  store.replaceSource({ mode: "url", url: "https://example.com/a.mp4", identity: "url:a" });
  store.updateDraft("remove", "automatic", { maskThreshold: 9 });
  store.updateDraft("remove", "kframe", { maxFrames: 99 });
  store.upsertRun({ runId: "run-1", status: "running" });
  store.resetCurrentDraft();

  assert.equal(store.getDraft("remove", "automatic").maskThreshold, 1);
  assert.equal(store.getDraft("remove", "kframe").maxFrames, 99);
  assert.equal(store.getState().source.url, "https://example.com/a.mp4");
  assert.equal(store.getState().runs.length, 1);
});

test("media workspace previews a file immediately and reads base64 only on submit", async () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  let objectUrlCalls = 0;
  let readCalls = 0;
  const media = createMediaWorkspace({
    store,
    createObjectURL(file) {
      objectUrlCalls += 1;
      return `blob:${file.name}`;
    },
    revokeObjectURL() {},
    async readAsDataURL() {
      readCalls += 1;
      return "data:video/mp4;base64,AAAA";
    }
  });
  const file = { name: "creative.mp4", type: "video/mp4", size: 1024, lastModified: 7 };

  media.selectFile(file);
  assert.equal(objectUrlCalls, 1);
  assert.equal(readCalls, 0);
  assert.equal(store.getState().source.objectUrl, "blob:creative.mp4");
  assert.equal(store.getState().source.status, "ready");

  const first = await media.prepareInput();
  const second = await media.prepareInput();
  assert.equal(readCalls, 1);
  assert.equal(first.dataUrl, "data:video/mp4;base64,AAAA");
  assert.equal(second.dataUrl, first.dataUrl);
  assert.equal(store.getState().source.status, "ready");
});

test("media workspace validates type and size before replacing the current preview", () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  let revoked = "";
  const media = createMediaWorkspace({
    store,
    createObjectURL: (file) => `blob:${file.name}`,
    revokeObjectURL: (url) => { revoked = url; },
    readAsDataURL: async () => "data:video/mp4;base64,AAAA"
  });
  media.selectFile({ name: "first.mp4", type: "video/mp4", size: 10, lastModified: 1 });

  assert.throws(
    () => media.selectFile({ name: "notes.txt", type: "text/plain", size: 10, lastModified: 2 }),
    /只支持视频文件/
  );
  assert.equal(store.getState().source.fileName, "first.mp4");
  assert.throws(
    () => media.selectFile({ name: "huge.mp4", type: "video/mp4", size: 314572801, lastModified: 3 }),
    /超过 300 MB/
  );

  media.selectFile({ name: "second.webm", type: "video/webm", size: 20, lastModified: 4 });
  assert.equal(revoked, "blob:first.mp4");
  assert.equal(store.getState().source.fileName, "second.webm");
});

test("media workspace keeps preview available when lazy file reading fails", async () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  const media = createMediaWorkspace({
    store,
    createObjectURL: () => "blob:broken",
    revokeObjectURL() {},
    readAsDataURL: async () => { throw new Error("读取中断"); }
  });
  media.selectFile({ name: "broken.mp4", type: "video/mp4", size: 20, lastModified: 1 });

  await assert.rejects(media.prepareInput(), /读取中断/);
  assert.equal(store.getState().source.objectUrl, "blob:broken");
  assert.equal(store.getState().source.status, "error");
  assert.equal(store.getState().source.error, "读取中断");
});

test("editor geometry excludes object-fit contain letterboxing", () => {
  const portrait = visibleMediaRect(
    { left: 0, top: 0, width: 400, height: 300 },
    { width: 100, height: 200 }
  );
  assert.deepEqual(portrait, { left: 125, top: 0, width: 150, height: 300 });
  assert.deepEqual(normalizedPoint({ clientX: 200, clientY: 150 }, portrait), { x: 0.5, y: 0.5 });
  assert.equal(normalizedPoint({ clientX: 20, clientY: 150 }, portrait), null);

  const landscape = visibleMediaRect(
    { left: 10, top: 20, width: 300, height: 400 },
    { width: 300, height: 100 }
  );
  assert.deepEqual(landscape, { left: 10, top: 170, width: 300, height: 100 });
});

test("editor geometry normalizes reverse drags and rejects tiny boxes", () => {
  assert.deepEqual(normalizedBox({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 }), {
    x1: 0.2,
    y1: 0.1,
    x2: 0.8,
    y2: 0.7
  });
  assert.equal(normalizedBox({ x: 0.1, y: 0.1 }, { x: 0.105, y: 0.5 }), null);
  assert.equal(normalizedBox(null, { x: 0.4, y: 0.5 }), null);
});

test("editor displays only the selection used by the active prompt type", () => {
  const draft = {
    promptType: "point",
    box: { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.4 },
    points: [{ x: 0.5, y: 0.6, label: "positive" }]
  };
  assert.deepEqual(selectionForPrompt(draft), { box: null, points: draft.points });
  assert.deepEqual(selectionForPrompt({ ...draft, promptType: "box" }), { box: draft.box, points: [] });
});

test("box drag survives same-mode state synchronization and releases pointer capture", () => {
  const listeners = new Map();
  const captured = [];
  const released = [];
  const surface = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    },
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 200, height: 100 };
    },
    setPointerCapture(pointerId) {
      captured.push(pointerId);
    },
    releasePointerCapture(pointerId) {
      released.push(pointerId);
    }
  };
  const phases = [];
  let editor;
  editor = createRegionEditor({
    surface,
    getMediaSize: () => ({ width: 200, height: 100 }),
    onChange(value) {
      phases.push(value.phase);
      if (value.phase === "preview") {
        editor.setMode("box", "positive");
        editor.setValue(value);
      }
    }
  });

  const drag = (pointerId, start, end) => {
    listeners.get("pointerdown")({ ...start, pointerId });
    listeners.get("pointermove")({ ...end, pointerId });
    listeners.get("pointerup")({ ...end, pointerId });
  };
  drag(1, { clientX: 20, clientY: 20 }, { clientX: 100, clientY: 60 });
  drag(2, { clientX: 40, clientY: 10 }, { clientX: 160, clientY: 80 });

  assert.deepEqual(captured, [1, 2]);
  assert.deepEqual(released, [1, 2]);
  assert.deepEqual(phases, ["preview", "complete", "preview", "complete"]);
});

test("job runner keeps concurrent submissions and timers independent", async () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  const timers = new Map();
  const requests = [];
  let timerSequence = 0;
  const responses = [
    { jobId: "job-a", status: "queued", remixId: "remix-a" },
    { jobId: "job-b", status: "queued", remixId: "remix-b" }
  ];
  const runner = createJobRunner({
    store,
    request: async (url, options) => {
      requests.push({ url, options });
      return responses.shift();
    },
    createRunId: (() => { let value = 0; return () => `run-${++value}`; })(),
    setTimer(callback, delay) {
      const id = ++timerSequence;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    isVisible: () => true,
    pollMs: 3000
  });

  await runner.submit({ capabilityId: "remove", modeId: "automatic", payload: { job_type: "ai_remove", input: { source: "secret" } } });
  await runner.submit({ capabilityId: "ending", modeId: "detect_trim", payload: { job_type: "end_trim_detection", input: { source: "secret" } } });

  assert.equal(store.getState().runs.length, 2);
  assert.deepEqual(store.getState().runs.map((run) => run.providerJobId).sort(), ["job-a", "job-b"]);
  assert.equal(timers.size, 2);
  assert.equal(requests[0].url, "/api/wangzhuan/video-ops/jobs");
  assert.equal(store.getState().runs[0].requestSnapshot.input.source, "<redacted>");
});

test("job runner isolates transient polling errors and terminal results", async () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  store.upsertRun({ runId: "run-a", providerJobId: "job-a", status: "running", errorCount: 0 });
  store.upsertRun({ runId: "run-b", providerJobId: "job-b", status: "running", errorCount: 0 });
  const scheduled = [];
  const runner = createJobRunner({
    store,
    request: async (url) => {
      if (url.includes("job-a") && !url.endsWith("/result?include_model_calls=true")) throw new Error("network down");
      if (url.endsWith("/result?include_model_calls=true")) return { download_url: "https://example.com/out.mp4" };
      return { job_id: "job-b", status: "succeeded" };
    },
    setTimer(callback, delay) {
      scheduled.push({ callback, delay });
      return scheduled.length;
    },
    clearTimer() {},
    isVisible: () => true,
    pollMs: 3000
  });

  await runner.refresh("run-a");
  assert.equal(store.getState().runs.find((run) => run.runId === "run-a").status, "running");
  assert.equal(store.getState().runs.find((run) => run.runId === "run-a").connectionError, "network down");
  assert.equal(store.getState().runs.find((run) => run.runId === "run-b").connectionError, undefined);
  assert.equal(scheduled.at(-1).delay, 6000);

  await runner.refresh("run-b");
  const completed = store.getState().runs.find((run) => run.runId === "run-b");
  assert.equal(completed.status, "succeeded");
  assert.equal(completed.result.download_url, "https://example.com/out.mp4");
});

test("job runner cancel and retry target the original provider job", async () => {
  const store = createRemixStore({ storage: createMemoryStorage() });
  store.upsertRun({ runId: "run-a", providerJobId: "job-a", status: "failed", requestSnapshot: { job_type: "ai_remove" } });
  const urls = [];
  const runner = createJobRunner({
    store,
    request: async (url) => {
      urls.push(url);
      return { job_id: "job-a", status: url.endsWith("/retry") ? "queued" : "canceled" };
    },
    setTimer: () => 1,
    clearTimer() {},
    isVisible: () => true
  });

  await runner.retry("run-a");
  assert.equal(urls.at(-1), "/api/wangzhuan/video-ops/jobs/job-a/retry");
  assert.equal(store.getState().runs[0].status, "queued");
  await runner.cancel("run-a");
  assert.equal(urls.at(-1), "/api/wangzhuan/video-ops/jobs/job-a/cancel");
  assert.equal(store.getState().runs[0].status, "canceled");
});
