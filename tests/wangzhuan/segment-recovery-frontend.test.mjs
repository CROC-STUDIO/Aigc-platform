import assert from "node:assert/strict";
import test from "node:test";

import {
  buildRecoveryViewModel,
  buildStitchRequest,
  createSegmentRecoveryController,
  hasPendingSegmentRecovery,
  moveQueueItem,
  queueStorageKey,
  reconcileQueue,
  validateReplacementFile
} from "../../public/wangzhuan-segment-recovery.js";

function buildBatch() {
  const tasks = [];
  const outputs = [];
  for (let variant = 1; variant <= 3; variant += 1) {
    for (let segment = 1; segment <= 3; segment += 1) {
      const ordinal = ((variant - 1) * 3) + segment;
      const taskId = `gen_be06_${String(ordinal).padStart(3, "0")}`;
      const outputId = `out_be06_${String(ordinal).padStart(3, "0")}`;
      const output = {
        outputId,
        kind: "segment_video",
        generationTaskIds: [taskId],
        durationSec: 10,
        previewUrl: `https://cdn.example.test/${outputId}.mp4`
      };
      outputs.push(output);
      tasks.push({
        generationTaskId: taskId,
        branchId: "branch_1",
        branchLabel: "默认分支",
        branchVariantIndex: variant,
        segmentIndex: segment,
        status: "downloaded",
        availability: "ready",
        retryEligibility: { status: "ready", canRetry: false, reason: outputId },
        currentOutput: output,
        currentOutputId: outputId,
        attemptHistory: [{ attemptNo: 1, status: "succeeded" }]
      });
    }
  }
  tasks[1] = {
    ...tasks[1],
    status: "failed",
    availability: "repair_required",
    retryEligibility: { status: "repair_required", canRetry: false, reason: "asset_review_pending" },
    currentOutput: null,
    currentOutputId: ""
  };
  outputs.splice(1, 1);
  return {
    batchId: "wzb_20260717051112_be06",
    status: "partial_failed",
    userId: "tester",
    tasks,
    outputs: [
      ...outputs,
      {
        outputId: "out_be06_010",
        kind: "stitched_video",
        manualStitch: true,
        stitchVersion: 1,
        stitchKind: "partial",
        segmentOutputIds: ["out_be06_001"],
        displayFileName: "manual-stitch-v1.mp4"
      }
    ]
  };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    removeItem(key) {
      values.delete(key);
    },
    value(key) {
      return values.get(key);
    }
  };
}

function controllerHarness(options = {}) {
  const listeners = new Map();
  const body = {
    innerHTML: "",
    querySelectorAll() {
      return [];
    }
  };
  const root = {
    hidden: true,
    querySelector(selector) {
      return selector === "[data-segment-recovery-body]" ? body : null;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };
  const controller = createSegmentRecoveryController({
    root,
    storage: memoryStorage(),
    getScope: () => ({ userId: "tester", projectKey: "project-a" }),
    request: async () => ({}),
    downloadZip: async () => {},
    showToast: () => {},
    confirm: () => true,
    prompt: () => "renamed.mp4",
    ...options
  });
  return {
    body,
    controller,
    root,
    async dispatch(type, dataset, extra = {}) {
      const target = {
        dataset,
        closest(selector) {
          return selector === "button" || selector === "[data-select-output]" ? this : null;
        },
        ...extra
      };
      return listeners.get(type)?.({ target, preventDefault() {}, dataTransfer: null });
    }
  };
}

test("recovery view model groups variants and indexes only current selectable outputs", () => {
  const model = buildRecoveryViewModel(buildBatch());

  assert.deepEqual(model.groups.map((group) => [group.key, group.tasks.length]), [
    ["branch_1:1", 3],
    ["branch_1:2", 3],
    ["branch_1:3", 3]
  ]);
  assert.equal(model.summary.total, 9);
  assert.equal(model.summary.ready, 8);
  assert.equal(model.summary.failed, 1);
  assert.equal(model.outputsById.size, 8);
  assert.equal(model.outputsById.has("out_be06_002"), false);
  assert.equal(model.outputsById.has("out_be06_010"), false);
  assert.equal(model.stitchVersions[0].stitchVersion, 1);
});

test("recovery UI shows predecessor wait, stale lineage, and parent attempt details", () => {
  const batch = buildBatch();
  batch.tasks[0] = {
    ...batch.tasks[0],
    availability: "waiting_predecessor",
    continuityState: { parentTaskId: "gen_parent", parentAttemptNo: 2 }
  };
  batch.tasks[2] = {
    ...batch.tasks[2],
    availability: "continuity_stale",
    retryEligibility: { status: "continuity_stale", canRetry: true },
    continuityState: {
      parentTaskId: "gen_parent",
      parentAttemptNo: 2,
      recordedParentAttemptNo: 1
    },
    attemptHistory: [{
      attemptNo: 1,
      status: "succeeded",
      continuityParent: { generationTaskId: "gen_parent", attemptNo: 1 }
    }]
  };
  const harness = controllerHarness();
  harness.controller.update({ batch });

  assert.match(harness.body.innerHTML, /等待前序片段/);
  assert.match(harness.body.innerHTML, /连续性版本已失效/);
  assert.match(harness.body.innerHTML, /父尝试 1/);
  assert.match(harness.body.innerHTML, /当前父尝试 2/);
});

test("queue reconciliation removes stale ids and deduplicates without changing order", () => {
  const model = buildRecoveryViewModel(buildBatch());

  assert.deepEqual(
    reconcileQueue(["out_be06_004", "out_missing", "out_be06_001", "out_be06_004"], model.outputsById),
    ["out_be06_004", "out_be06_001"]
  );
});

test("queue move is immutable and clamps target position", () => {
  const source = ["out_001", "out_002", "out_003"];

  assert.deepEqual(moveQueueItem(source, 0, 2), ["out_002", "out_003", "out_001"]);
  assert.deepEqual(moveQueueItem(source, 2, -10), ["out_003", "out_001", "out_002"]);
  assert.deepEqual(source, ["out_001", "out_002", "out_003"]);
});

test("queue storage key is scoped by user project and batch", () => {
  const first = queueStorageKey({ userId: "tester", projectKey: "project-a", batchId: "wzb_a" });
  const second = queueStorageKey({ userId: "tester", projectKey: "project-b", batchId: "wzb_a" });

  assert.match(first, /tester/);
  assert.match(first, /project-a/);
  assert.match(first, /wzb_a/);
  assert.notEqual(first, second);
});

test("stitch request preserves queue order and confirms cross-variant selection", () => {
  const model = buildRecoveryViewModel(buildBatch());

  assert.deepEqual(buildStitchRequest(["out_be06_004", "out_be06_001"], model, "key-1"), {
    idempotencyKey: "key-1",
    segmentOutputIds: ["out_be06_004", "out_be06_001"],
    confirmMixed: true
  });
  assert.deepEqual(buildStitchRequest(["out_be06_003", "out_be06_001"], model, "key-2"), {
    idempotencyKey: "key-2",
    segmentOutputIds: ["out_be06_003", "out_be06_001"],
    confirmMixed: false
  });
});

test("replacement file validation rejects unsupported and oversized videos", async () => {
  await assert.rejects(
    validateReplacementFile({ name: "clip.avi", type: "video/x-msvideo", size: 10 }),
    /MP4、MOV 或 WEBM/
  );
  await assert.rejects(
    validateReplacementFile({ name: "clip.mp4", type: "video/mp4", size: (100 * 1024 * 1024) + 1 }),
    /100 MB/
  );
});

test("terminal batch polling continues only while segment recovery is active", () => {
  const batch = buildBatch();
  batch.status = "partial_failed";
  batch.tasks[0] = { ...batch.tasks[0], status: "waiting_upstream", availability: "running" };

  assert.equal(hasPendingSegmentRecovery({ batch }), true);
  batch.tasks[0] = { ...batch.tasks[0], status: "failed", availability: "repair_required" };
  assert.equal(hasPendingSegmentRecovery({ batch }), false);
});

test("controller restores a scoped queue and has no global DOM dependency", () => {
  const batch = buildBatch();
  const scope = { userId: "tester", projectKey: "project-a", batchId: batch.batchId };
  const key = queueStorageKey(scope);
  const storage = memoryStorage({
    [key]: JSON.stringify({ outputIds: ["out_missing", "out_be06_004", "out_be06_001"], updatedAt: "2026-07-18T00:00:00.000Z" })
  });
  const listeners = new Map();
  const body = { innerHTML: "" };
  const root = {
    hidden: true,
    querySelector(selector) {
      return selector === "[data-segment-recovery-body]" ? body : null;
    },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type) {
      listeners.delete(type);
    }
  };
  const controller = createSegmentRecoveryController({
    root,
    storage,
    getScope: () => scope,
    request: async () => ({}),
    downloadZip: async () => {},
    showToast: () => {}
  });

  controller.update({ batch });

  assert.equal(root.hidden, false);
  assert.match(body.innerHTML, /片段状态/);
  assert.match(body.innerHTML, /拼接队列/);
  assert.match(body.innerHTML, /拼接版本/);
  assert.match(body.innerHTML, /已移除 1 个失效片段/);
  assert.match(body.innerHTML, /自动保存/);
  assert.deepEqual(JSON.parse(storage.value(key)).outputIds, ["out_be06_004", "out_be06_001"]);
  controller.destroy();
  assert.equal(listeners.size, 0);
});

test("controller shows group running counts and original segment indexes in the queue", async () => {
  const batch = buildBatch();
  batch.tasks[2] = { ...batch.tasks[2], status: "waiting_upstream", availability: "running" };
  const harness = controllerHarness();
  harness.controller.update({ batch });
  await harness.dispatch("change", { selectOutput: "out_be06_001" }, { checked: true });

  assert.match(harness.body.innerHTML, /处理中 1/);
  assert.match(harness.body.innerHTML, /原片段 1/);
  assert.doesNotMatch(harness.body.innerHTML, /原片段 gen_be06_001/);
});

test("controller does not claim queue autosave when local storage rejects the write", async () => {
  const harness = controllerHarness({
    storage: {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("quota exceeded");
      }
    }
  });
  harness.controller.update({ batch: buildBatch() });
  await harness.dispatch("change", { selectOutput: "out_be06_001" }, { checked: true });

  assert.doesNotMatch(harness.body.innerHTML, /自动保存/);
});

test("controller retries one task and all eligible failures through batch-scoped endpoints", async () => {
  const calls = [];
  const details = [];
  const restartedBatchIds = [];
  const harness = controllerHarness({
    request: async (path, request) => {
      calls.push([path, request]);
      return path.endsWith("/retry-failed")
        ? { batch: buildBatch(), summary: { submitted: 1 } }
        : { batch: buildBatch(), retriedCount: 1 };
    },
    onDetail: (detail) => details.push(detail),
    onRetrySubmitted: (batchId) => restartedBatchIds.push(batchId)
  });
  harness.controller.update({ batch: buildBatch() });

  await harness.dispatch("click", { retryTask: "gen_be06_002" });
  await harness.dispatch("click", { retryFailed: "" });

  assert.match(calls[0][0], /\/tasks\/gen_be06_002\/retry$/);
  assert.match(JSON.parse(calls[0][1].body).idempotencyKey, /^retry-segment-/);
  assert.match(calls[1][0], /\/tasks\/retry-failed$/);
  assert.match(JSON.parse(calls[1][1].body).idempotencyKey, /^retry-failed-segments-/);
  assert.equal(details.length, 2);
  assert.deepEqual(restartedBatchIds, [buildBatch().batchId, buildBatch().batchId]);
});

test("controller blocks duplicate actions without locking unrelated downloads", async () => {
  const batch = buildBatch();
  batch.tasks[1] = {
    ...batch.tasks[1],
    availability: "retryable",
    retryEligibility: { status: "retryable", canRetry: true, reason: "upstream_failed" }
  };
  let resolveRetry;
  const retryResult = new Promise((resolve) => {
    resolveRetry = resolve;
  });
  const calls = [];
  const downloads = [];
  const harness = controllerHarness({
    request: async (path) => {
      calls.push(path);
      return retryResult;
    },
    downloadZip: async (...args) => downloads.push(args)
  });
  harness.controller.update({ batch });

  const firstRetry = harness.dispatch("click", { retryTask: "gen_be06_002" });
  await Promise.resolve();
  await harness.dispatch("click", { retryTask: "gen_be06_002" });
  await harness.dispatch("click", { downloadOutput: "out_be06_001" });

  assert.equal(calls.length, 1);
  assert.equal(downloads.length, 1);
  assert.match(harness.body.innerHTML, /data-retry-task="gen_be06_002" disabled/);
  assert.doesNotMatch(harness.body.innerHTML, /data-download-output="out_be06_001" disabled/);

  resolveRetry({ batch, retriedCount: 1 });
  await firstRetry;
});

test("controller downloads selected outputs and confirms mixed stitching", async () => {
  const downloads = [];
  const calls = [];
  let confirmations = 0;
  const batch = buildBatch();
  const harness = controllerHarness({
    downloadZip: async (...args) => downloads.push(args),
    confirm: () => {
      confirmations += 1;
      return true;
    },
    request: async (path, request) => {
      calls.push([path, request]);
      return { batch };
    }
  });
  harness.controller.update({ batch });
  await harness.dispatch("change", { selectOutput: "out_be06_001" }, { checked: true });
  await harness.dispatch("change", { selectOutput: "out_be06_004" }, { checked: true });

  await harness.dispatch("click", { downloadSelected: "" });
  await harness.dispatch("click", { startStitch: "" });

  assert.deepEqual(downloads[0][1], {
    batchIds: [batch.batchId],
    outputIds: ["out_be06_001", "out_be06_004"]
  });
  assert.equal(confirmations, 1);
  assert.match(calls[0][0], /\/stitch-versions$/);
  assert.deepEqual(JSON.parse(calls[0][1].body).segmentOutputIds, ["out_be06_001", "out_be06_004"]);
  assert.equal(JSON.parse(calls[0][1].body).confirmMixed, true);
});

test("controller reuses a stitch idempotency key after response loss and rotates it after success", async () => {
  const batch = buildBatch();
  const keys = [];
  let attempt = 0;
  const harness = controllerHarness({
    request: async (_path, request) => {
      keys.push(JSON.parse(request.body).idempotencyKey);
      attempt += 1;
      if (attempt === 1) throw new Error("response lost");
      return { batch };
    }
  });
  harness.controller.update({ batch });
  await harness.dispatch("change", { selectOutput: "out_be06_001" }, { checked: true });

  await harness.dispatch("click", { startStitch: "" });
  await harness.dispatch("click", { startStitch: "" });
  await harness.dispatch("click", { startStitch: "" });

  assert.equal(keys[0], keys[1]);
  assert.notEqual(keys[1], keys[2]);
});

test("controller ignores an old action result after switching batches", async () => {
  const firstBatch = buildBatch();
  firstBatch.tasks[1] = {
    ...firstBatch.tasks[1],
    availability: "retryable",
    retryEligibility: { status: "retryable", canRetry: true, reason: "upstream_failed" }
  };
  const secondBatch = { ...buildBatch(), batchId: "wzb_second" };
  let resolveRetry;
  const pending = new Promise((resolve) => {
    resolveRetry = resolve;
  });
  const details = [];
  const harness = controllerHarness({
    request: () => pending,
    onDetail: (detail) => details.push(detail)
  });
  harness.controller.update({ batch: firstBatch });
  const retry = harness.dispatch("click", { retryTask: "gen_be06_002" });
  await Promise.resolve();

  harness.controller.update({ batch: secondBatch });
  resolveRetry({ batch: firstBatch, retriedCount: 1 });
  await retry;

  assert.equal(details.length, 0);
  assert.equal(harness.root.hidden, false);
});

test("controller restores, renames and deletes manual stitch versions", async () => {
  const calls = [];
  const batch = buildBatch();
  const harness = controllerHarness({
    request: async (path, request) => {
      calls.push([path, request]);
      return { batch };
    }
  });
  harness.controller.update({ batch });

  await harness.dispatch("click", { restoreVersion: "out_be06_010" });
  await harness.dispatch("click", { renameVersion: "out_be06_010" });
  await harness.dispatch("click", { deleteVersion: "out_be06_010" });

  assert.match(harness.body.innerHTML, /out_be06_001/);
  assert.equal(calls[0][1].method, "PATCH");
  assert.equal(JSON.parse(calls[0][1].body).displayFileName, "renamed.mp4");
  assert.equal(calls[1][1].method, "DELETE");
});

test("controller serializes download rename and delete for the same version", async () => {
  const batch = buildBatch();
  let resolveRename;
  const pendingRename = new Promise((resolve) => {
    resolveRename = resolve;
  });
  const calls = [];
  const harness = controllerHarness({
    request: async (path, request) => {
      calls.push([path, request]);
      return pendingRename;
    }
  });
  harness.controller.update({ batch });

  const rename = harness.dispatch("click", { renameVersion: "out_be06_010" });
  await Promise.resolve();
  const deletion = harness.dispatch("click", { deleteVersion: "out_be06_010" });

  assert.equal(calls.length, 1);
  assert.match(harness.body.innerHTML, /data-download-output="out_be06_010" disabled/);
  assert.match(harness.body.innerHTML, /data-delete-version="out_be06_010"[^>]* disabled/);

  resolveRename({ batch });
  await Promise.all([rename, deletion]);
});
