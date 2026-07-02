# Video Ops Single Capability Batch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a batch runner for single existing `video-ops` capabilities so users can upload multiple videos, submit once, and receive per-item output links incrementally without one failed item blocking the rest.

**Architecture:** Add a backend-owned batch parent plus child item model, then build a bounded-concurrency runner that creates and tracks one real `video-ops` job per child. Extend `competitor-remix` to create and monitor batches, and extend task management to reopen the same batch later from shared backend state.

**Tech Stack:** Node.js ESM, existing `server/wangzhuan/*` modules, existing browser JS in `public/*`, Node test runner (`node --test`)

---

## File Structure

### Existing files to modify

- `server/wangzhuan/router.mjs`
  - Add batch create/list/detail/cancel endpoints.
- `server/wangzhuan/background-jobs.mjs`
  - Add a batch runner background job type and polling-safe lifecycle helpers if needed.
- `server/wangzhuan/video-ops-archive.mjs`
  - Reuse or lightly extend output archival helpers so batch child items can write output URLs consistently.
- `public/competitor-remix.html`
  - Add a batch mode entry point and monitoring layout.
- `public/competitor-remix.js`
  - Split single-job UI logic from new batch mode UI logic.
- `public/wangzhuan-tasks.js`
  - Add `video_ops_batch` rendering and detail handling.
- `public/wangzhuan-tasks.html`
  - Add any batch detail container hooks needed by `wangzhuan-tasks.js`.
- `tests/wangzhuan/v2-router-jobs.test.mjs`
  - Extend router coverage for batch endpoints if this file is already the closest router coverage surface.
- `tests/wangzhuan/v2-frontend-static.test.mjs`
  - Extend static frontend assertions for batch UI.

### New files to create

- `server/wangzhuan/video-ops-batch.mjs`
  - Batch parent + child item create/read/list/cancel/status aggregation.
- `server/wangzhuan/video-ops-batch-runner.mjs`
  - Bounded-concurrency child orchestration over existing single `video-ops` functions.
- `tests/wangzhuan/video-ops-batch.test.mjs`
  - Unit tests for parent/child aggregation and idempotency.
- `tests/wangzhuan/video-ops-batch-runner.test.mjs`
  - Unit/integration-style tests for incremental child completion and failure isolation.
- `tests/wangzhuan/competitor-remix-batch-static.test.mjs`
  - Static assertions focused on the new batch UI if the current shared frontend static file becomes too crowded.

### Responsibility boundaries

- `video-ops.mjs` remains the single upstream job adapter. Do not turn it into a batch orchestrator.
- `video-ops-batch.mjs` owns batch facts and status transitions.
- `video-ops-batch-runner.mjs` owns execution flow and concurrency.
- `competitor-remix.js` should only create/poll/render batches; it should not submit N upstream jobs directly.

---

### Task 1: Add failing backend tests for batch model and runner behavior

**Files:**
- Create: `tests/wangzhuan/video-ops-batch.test.mjs`
- Create: `tests/wangzhuan/video-ops-batch-runner.test.mjs`

- [ ] **Step 1: Write the failing batch aggregation tests**

```js
import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveBatchStatus,
  summarizeBatchItems,
  makeBatchCreateFingerprint
} from "../../server/wangzhuan/video-ops-batch.mjs";

test("summarizeBatchItems aggregates child counts and partial failure correctly", () => {
  const summary = summarizeBatchItems([
    { itemStatus: "queued" },
    { itemStatus: "running" },
    { itemStatus: "succeeded" },
    { itemStatus: "failed" }
  ]);

  assert.deepEqual(summary, {
    totalCount: 4,
    queuedCount: 1,
    runningCount: 1,
    succeededCount: 1,
    failedCount: 1,
    canceledCount: 0
  });
  assert.equal(deriveBatchStatus(summary), "partial_failed");
});

test("makeBatchCreateFingerprint is stable for same job type and item inputs", () => {
  const first = makeBatchCreateFingerprint({
    jobType: "seedance_ai_remove",
    items: [
      { sourceName: "a.mp4", input: { source_type: "url", source: "https://x/a.mp4" } },
      { sourceName: "b.mp4", input: { source_type: "url", source: "https://x/b.mp4" } }
    ]
  });
  const second = makeBatchCreateFingerprint({
    jobType: "seedance_ai_remove",
    items: [
      { sourceName: "a.mp4", input: { source_type: "url", source: "https://x/a.mp4" } },
      { sourceName: "b.mp4", input: { source_type: "url", source: "https://x/b.mp4" } }
    ]
  });

  assert.equal(first, second);
});
```

- [ ] **Step 2: Write the failing batch runner behavior test**

```js
import test from "node:test";
import assert from "node:assert/strict";

import { runVideoOpsBatchPass } from "../../server/wangzhuan/video-ops-batch-runner.mjs";

test("runVideoOpsBatchPass keeps processing later items after one failure", async () => {
  const events = [];
  const items = [
    { itemId: "i1", itemStatus: "queued", input: { source_type: "url", source: "https://x/1.mp4" } },
    { itemId: "i2", itemStatus: "queued", input: { source_type: "url", source: "https://x/2.mp4" } },
    { itemId: "i3", itemStatus: "queued", input: { source_type: "url", source: "https://x/3.mp4" } }
  ];

  await runVideoOpsBatchPass({
    batch: { batchId: "b1", jobType: "ai_remove" },
    items,
    maxConcurrentItems: 2,
    createJob: async ({ input }) => {
      if (input.source.endsWith("2.mp4")) throw new Error("submit failed");
      return { jobId: `job-${input.source.slice(-5)}` };
    },
    pollJob: async (jobId) => ({ status: "succeeded", jobId }),
    syncResult: async (item, job) => ({ outputUrl: `https://cdn/${item.itemId}.mp4`, providerJobId: job.jobId }),
    updateItem: async (itemId, patch) => events.push({ itemId, patch })
  });

  assert.equal(events.some((event) => event.itemId === "i2" && event.patch.itemStatus === "failed"), true);
  assert.equal(events.some((event) => event.itemId === "i3" && event.patch.itemStatus === "succeeded"), true);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
node --test tests/wangzhuan/video-ops-batch.test.mjs tests/wangzhuan/video-ops-batch-runner.test.mjs
```

Expected:

- FAIL with module not found or missing export errors for `video-ops-batch.mjs` and `video-ops-batch-runner.mjs`

- [ ] **Step 4: Commit the failing tests**

```bash
git add tests/wangzhuan/video-ops-batch.test.mjs tests/wangzhuan/video-ops-batch-runner.test.mjs
git commit -m "test: add failing video-ops batch model coverage"
```

---

### Task 2: Implement batch model and status aggregation

**Files:**
- Create: `server/wangzhuan/video-ops-batch.mjs`
- Test: `tests/wangzhuan/video-ops-batch.test.mjs`

- [ ] **Step 1: Write the minimal batch model helpers**

```js
import crypto from "node:crypto";

import { WangzhuanError } from "./http.mjs";
import { validateVideoOpsJobRequest } from "./video-ops.mjs";

const SUPPORTED_BATCH_JOB_TYPES = new Set([
  "seedance_ai_remove",
  "ai_remove",
  "end_trim_detection"
]);

export function summarizeBatchItems(items = []) {
  const summary = {
    totalCount: items.length,
    queuedCount: 0,
    runningCount: 0,
    succeededCount: 0,
    failedCount: 0,
    canceledCount: 0
  };
  for (const item of items) {
    const status = item.itemStatus || "queued";
    if (status === "queued" || status === "submitting") summary.queuedCount += 1;
    else if (status === "running") summary.runningCount += 1;
    else if (status === "succeeded") summary.succeededCount += 1;
    else if (status === "failed") summary.failedCount += 1;
    else if (status === "canceled") summary.canceledCount += 1;
  }
  return summary;
}

export function deriveBatchStatus(summary = {}) {
  const total = Number(summary.totalCount || 0);
  if (!total) return "queued";
  if (summary.runningCount > 0 || summary.queuedCount > 0) return "running";
  if (summary.succeededCount === total) return "succeeded";
  if (summary.failedCount === total) return "failed";
  if (summary.canceledCount === total) return "canceled";
  if (summary.succeededCount > 0 && summary.failedCount > 0) return "partial_failed";
  if (summary.succeededCount > 0 && summary.canceledCount > 0) return "partial_failed";
  if (summary.failedCount > 0 && summary.canceledCount > 0) return "partial_failed";
  return "partial_failed";
}

export function makeBatchCreateFingerprint(payload = {}) {
  return crypto.createHash("sha256").update(JSON.stringify({
    jobType: payload.jobType,
    items: (payload.items || []).map((item) => ({
      sourceName: item.sourceName,
      input: item.input
    }))
  })).digest("hex");
}

export function validateBatchCreateRequest(body = {}, options = {}) {
  const jobType = String(body.jobType || "").trim();
  if (!SUPPORTED_BATCH_JOB_TYPES.has(jobType)) {
    throw new WangzhuanError("validation_error", "jobType 不在首期批量白名单内", { jobType });
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (!items.length) {
    throw new WangzhuanError("validation_error", "items 至少需要一个视频", { field: "items" });
  }
  const validatedItems = items.map((item, index) => {
    const input = validateVideoOpsJobRequest({
      job_type: jobType,
      input: item.input,
      params: jobType === "ai_remove" ? { mode: "auto", mask_threshold: 1 } : {}
    }, options).input;
    return {
      itemId: `vobi_${index + 1}`,
      sourceName: String(item.sourceName || `video-${index + 1}.mp4`),
      input,
      itemStatus: "queued",
      providerJobId: "",
      outputUrl: "",
      errorMessage: "",
      startedAt: null,
      finishedAt: null
    };
  });
  return {
    jobType,
    idempotencyKey: String(body.idempotencyKey || "").trim(),
    items: validatedItems
  };
}
```

- [ ] **Step 2: Run the batch model tests**

Run:

```bash
node --test tests/wangzhuan/video-ops-batch.test.mjs
```

Expected:

- PASS for aggregation and fingerprint tests

- [ ] **Step 3: Commit the batch model**

```bash
git add server/wangzhuan/video-ops-batch.mjs tests/wangzhuan/video-ops-batch.test.mjs
git commit -m "feat: add video-ops batch model helpers"
```

---

### Task 3: Implement backend batch runner with failure isolation

**Files:**
- Create: `server/wangzhuan/video-ops-batch-runner.mjs`
- Test: `tests/wangzhuan/video-ops-batch-runner.test.mjs`

- [ ] **Step 1: Implement a single bounded-concurrency runner pass**

```js
export async function runVideoOpsBatchPass({
  batch,
  items,
  maxConcurrentItems = 2,
  createJob,
  pollJob,
  syncResult,
  updateItem
}) {
  const queue = [...items.filter((item) => item.itemStatus === "queued")];
  const workers = Array.from({ length: Math.max(1, maxConcurrentItems) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (!item) return;
      try {
        await updateItem(item.itemId, { itemStatus: "submitting", startedAt: new Date().toISOString() });
        const created = await createJob({ batch, item, input: item.input });
        await updateItem(item.itemId, { itemStatus: "running", providerJobId: created.jobId });
        const job = await pollJob(created.jobId, item);
        if (job.status !== "succeeded" && job.status !== "review_required") {
          throw new Error(`upstream status ${job.status}`);
        }
        const synced = await syncResult(item, job);
        await updateItem(item.itemId, {
          itemStatus: "succeeded",
          providerJobId: synced.providerJobId || created.jobId,
          outputUrl: synced.outputUrl || "",
          finishedAt: new Date().toISOString(),
          errorMessage: ""
        });
      } catch (error) {
        await updateItem(item.itemId, {
          itemStatus: "failed",
          finishedAt: new Date().toISOString(),
          errorMessage: error.message || "batch item failed"
        });
      }
    }
  });
  await Promise.all(workers);
}
```

- [ ] **Step 2: Run the runner test**

Run:

```bash
node --test tests/wangzhuan/video-ops-batch-runner.test.mjs
```

Expected:

- PASS with one failed item and a later succeeded item in the same run

- [ ] **Step 3: Commit the runner**

```bash
git add server/wangzhuan/video-ops-batch-runner.mjs tests/wangzhuan/video-ops-batch-runner.test.mjs
git commit -m "feat: add video-ops batch runner"
```

---

### Task 4: Wire batch endpoints into router and background execution

**Files:**
- Modify: `server/wangzhuan/router.mjs`
- Modify: `server/wangzhuan/background-jobs.mjs`
- Modify: `server/wangzhuan/video-ops-archive.mjs`
- Test: `tests/wangzhuan/v2-router-jobs.test.mjs`

- [ ] **Step 1: Add failing router tests for batch endpoints**

```js
import test from "node:test";
import assert from "node:assert/strict";

test("router exposes video-ops batch endpoints", async () => {
  const router = await import("../../server/wangzhuan/router.mjs");
  const source = await import("node:fs/promises").then((fs) => fs.readFile(new URL("../../server/wangzhuan/router.mjs", import.meta.url), "utf8"));

  assert.match(source, /\/api\/wangzhuan\/video-ops\/batches/);
  assert.match(source, /videoOpsBatchRoute/);
});
```

- [ ] **Step 2: Add route parser and endpoint handlers**

```js
function videoOpsBatchRoute(pathname) {
  const match = pathname.match(/^\/api\/wangzhuan\/video-ops\/batches(?:\/([^/]+)(?:\/(cancel))?)?$/);
  if (!match) return null;
  return { batchId: match[1] ? decodeURIComponent(match[1]) : "", action: match[2] || (match[1] ? "detail" : "collection") };
}

// inside handleWangzhuanRequest
const videoOpsBatch = videoOpsBatchRoute(url.pathname);
if (videoOpsBatch && req.method === "POST" && videoOpsBatch.action === "collection") {
  return sendOk(res, await createVideoOpsBatch(scoped, await context.readJson(req)), requestId);
}
if (videoOpsBatch && req.method === "GET" && videoOpsBatch.action === "collection") {
  return sendOk(res, await listVideoOpsBatches(scoped, queryObject(url)), requestId);
}
if (videoOpsBatch && req.method === "GET" && videoOpsBatch.action === "detail") {
  return sendOk(res, await getVideoOpsBatchDetail(scoped, videoOpsBatch.batchId), requestId);
}
if (videoOpsBatch && req.method === "POST" && videoOpsBatch.action === "cancel") {
  return sendOk(res, await cancelVideoOpsBatch(scoped, videoOpsBatch.batchId), requestId);
}
```

- [ ] **Step 3: Hook background execution and archive writeback**

```js
const job = createBackgroundJob("video_ops_batch", async ({ log, progress }) => {
  log("video-ops 批量任务已开始");
  progress(10, "正在创建子任务");
  await runPersistedVideoOpsBatch(scoped, batchId, {
    log,
    progress,
    createJob: createVideoOpsJob,
    pollJob: async (jobId) => getVideoOpsJob(scoped, jobId),
    syncResult: async (item, job) => {
      const archive = await syncVideoOpsJobArchive(scoped, { jobId: job.jobId || jobId });
      return {
        providerJobId: archive.jobId || job.jobId,
        outputUrl: archive.primaryOutputUrl || ""
      };
    }
  });
  progress(100, "批量任务已完成");
  return { batchId };
}, {
  context: scoped,
  subjectType: "video_ops_batch",
  subjectId: batchId
});
```

- [ ] **Step 4: Run router tests**

Run:

```bash
node --test tests/wangzhuan/v2-router-jobs.test.mjs
```

Expected:

- PASS with batch route patterns present and router file loading cleanly

- [ ] **Step 5: Commit backend routing**

```bash
git add server/wangzhuan/router.mjs server/wangzhuan/background-jobs.mjs server/wangzhuan/video-ops-archive.mjs tests/wangzhuan/v2-router-jobs.test.mjs
git commit -m "feat: expose video-ops batch endpoints"
```

---

### Task 5: Add batch mode UI to competitor-remix

**Files:**
- Modify: `public/competitor-remix.html`
- Modify: `public/competitor-remix.js`
- Test: `tests/wangzhuan/competitor-remix-batch-static.test.mjs`

- [ ] **Step 1: Add failing static tests for batch UI**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("competitor remix exposes single capability batch mode", async () => {
  const html = await readFile(new URL("../../public/competitor-remix.html", import.meta.url), "utf8");
  const script = await readFile(new URL("../../public/competitor-remix.js", import.meta.url), "utf8");

  assert.match(html, /批量处理/);
  assert.match(html, /id="videoOpsBatchCreateBtn"/);
  assert.match(html, /id="videoOpsBatchItems"/);
  assert.match(script, /createVideoOpsBatch/);
  assert.match(script, /loadVideoOpsBatch/);
});
```

- [ ] **Step 2: Add batch entry and monitoring containers to HTML**

```html
<div class="video-ops-mode-switch" role="tablist" aria-label="任务模式">
  <button id="videoOpsSingleModeBtn" type="button" class="mini">单任务</button>
  <button id="videoOpsBatchModeBtn" type="button" class="mini">批量处理</button>
</div>

<section id="videoOpsBatchPanel" class="video-ops-panel" hidden>
  <div class="video-ops-section-head">
    <strong>批量视频</strong>
    <span>仅支持 seedance_ai_remove、ai_remove_auto、end_trim_detection</span>
  </div>
  <label>上传一批视频
    <input id="videoOpsBatchSourceFiles" type="file" accept="video/mp4,video/webm,video/quicktime" multiple />
  </label>
  <div id="videoOpsBatchItems" class="wz-list empty-line">尚未添加视频</div>
  <div class="video-ops-actions">
    <button id="videoOpsBatchCreateBtn" type="button">确认创建批次</button>
  </div>
</section>

<section id="videoOpsBatchMonitor" class="video-ops-panel" hidden>
  <div id="videoOpsBatchSummary" class="wz-list empty-line">批次创建后显示进度</div>
  <div id="videoOpsBatchResults" class="wz-list empty-line">子任务结果会逐条回写</div>
</section>
```

- [ ] **Step 3: Add minimal batch create/load/poll logic to JS**

```js
state.batchMode = false;
state.batch = null;
state.batchItems = [];
state.batchPollTimer = 0;

async function createVideoOpsBatch() {
  const payload = {
    jobType: selectedTask().jobType,
    idempotencyKey: crypto.randomUUID(),
    items: state.batchItems.map((item) => ({
      sourceName: item.name,
      input: item.input
    }))
  };
  state.batch = await apiEnvelope("/api/wangzhuan/video-ops/batches", {
    method: "POST",
    body: JSON.stringify(payload)
  });
  await loadVideoOpsBatch(state.batch.batchId);
}

async function loadVideoOpsBatch(batchId) {
  state.batch = await apiEnvelope(`/api/wangzhuan/video-ops/batches/${encodeURIComponent(batchId)}`);
  renderVideoOpsBatch();
}

function scheduleVideoOpsBatchPoll(batchId) {
  window.clearTimeout(state.batchPollTimer);
  const tick = async () => {
    await loadVideoOpsBatch(batchId);
    if (["succeeded", "failed", "partial_failed", "canceled"].includes(state.batch?.batch?.batchStatus)) return;
    state.batchPollTimer = window.setTimeout(tick, 3000);
  };
  state.batchPollTimer = window.setTimeout(tick, 3000);
}
```

- [ ] **Step 4: Run the static UI test**

Run:

```bash
node --test tests/wangzhuan/competitor-remix-batch-static.test.mjs
```

Expected:

- PASS with batch controls and polling function names present

- [ ] **Step 5: Commit the competitor-remix batch UI**

```bash
git add public/competitor-remix.html public/competitor-remix.js tests/wangzhuan/competitor-remix-batch-static.test.mjs
git commit -m "feat: add competitor remix video-ops batch mode"
```

---

### Task 6: Extend task management page for video-ops batch resume

**Files:**
- Modify: `public/wangzhuan-tasks.js`
- Modify: `public/wangzhuan-tasks.html`
- Modify: `tests/wangzhuan/v2-frontend-static.test.mjs`

- [ ] **Step 1: Add failing static assertions for batch task management**

```js
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("task management supports video-ops batch detail", async () => {
  const script = await readFile(new URL("../../public/wangzhuan-tasks.js", import.meta.url), "utf8");
  assert.match(script, /video_ops_batch/);
  assert.match(script, /loadVideoOpsBatchDetail/);
  assert.match(script, /outputUrl/);
});
```

- [ ] **Step 2: Add batch detail rendering branch**

```js
function taskTypeLabel(type) {
  if (type === "video_ops_batch") return "单功能批量处理";
  return type === "remix" ? "竞品素材改造" : "网赚素材管线";
}

async function loadVideoOpsBatchDetail(batchId) {
  return apiEnvelope(`/api/wangzhuan/video-ops/batches/${encodeURIComponent(batchId)}`);
}

function renderVideoOpsBatchDetail(detail) {
  const batch = detail.batch || {};
  const items = Array.isArray(detail.items) ? detail.items : [];
  return `
    <section class="wz-tasks-detail-block">
      <h3>批次概览</h3>
      ${renderKeyValues([
        ["batch_id", batch.batchId || "-"],
        ["job_type", batch.jobType || "-"],
        ["status", batch.batchStatus || "-"],
        ["counts", `${batch.succeededCount || 0}/${batch.totalCount || 0}`]
      ])}
      <div class="wz-list">
        ${items.map((item) => `
          <article class="wz-row">
            <div>
              <strong>${escapeHtml(item.sourceName || item.itemId || "-")}</strong>
              <small>${escapeHtml(item.itemStatus || "-")}</small>
            </div>
            ${item.outputUrl ? `<a class="mini" href="${escapeHtml(item.outputUrl)}">查看输出</a>` : `<span>${escapeHtml(item.errorMessage || "-")}</span>`}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}
```

- [ ] **Step 3: Run the task management static tests**

Run:

```bash
node --test tests/wangzhuan/v2-frontend-static.test.mjs
```

Expected:

- PASS with `video_ops_batch` strings and output rendering hooks present

- [ ] **Step 4: Commit task management batch support**

```bash
git add public/wangzhuan-tasks.js public/wangzhuan-tasks.html tests/wangzhuan/v2-frontend-static.test.mjs
git commit -m "feat: add video-ops batch task management view"
```

---

### Task 7: Run full verification and clean handoff

**Files:**
- Modify if needed: any files above

- [ ] **Step 1: Run targeted backend tests**

Run:

```bash
node --test \
  tests/wangzhuan/video-ops-batch.test.mjs \
  tests/wangzhuan/video-ops-batch-runner.test.mjs \
  tests/wangzhuan/v2-router-jobs.test.mjs
```

Expected:

- PASS for batch model, runner, and router coverage

- [ ] **Step 2: Run targeted frontend tests**

Run:

```bash
node --test \
  tests/wangzhuan/competitor-remix-batch-static.test.mjs \
  tests/wangzhuan/v2-frontend-static.test.mjs
```

Expected:

- PASS for batch UI and task management static coverage

- [ ] **Step 3: Run repository smoke test**

Run:

```bash
npm test
```

Expected:

- Existing passing suite remains green or only fails in unrelated pre-existing areas that are documented before merge

- [ ] **Step 4: Manual browser verification**

Run:

```bash
node server.mjs
```

Then verify in browser:

- create a batch with 3+ videos using `seedance_ai_remove`
- one item finishing early shows output link before the rest
- inject one mocked failing item in dev/test path and confirm later items still complete
- open the same `batchId` from task management and confirm the same items and output links appear

- [ ] **Step 5: Final commit**

```bash
git add server/wangzhuan/video-ops-batch.mjs server/wangzhuan/video-ops-batch-runner.mjs server/wangzhuan/router.mjs server/wangzhuan/background-jobs.mjs server/wangzhuan/video-ops-archive.mjs public/competitor-remix.html public/competitor-remix.js public/wangzhuan-tasks.html public/wangzhuan-tasks.js tests/wangzhuan/video-ops-batch.test.mjs tests/wangzhuan/video-ops-batch-runner.test.mjs tests/wangzhuan/competitor-remix-batch-static.test.mjs tests/wangzhuan/v2-router-jobs.test.mjs tests/wangzhuan/v2-frontend-static.test.mjs
git commit -m "feat: add single capability video-ops batch processing"
```

---

## Spec Coverage Check

- Batch parent + child model: Task 2
- Backend orchestrator with failure isolation: Task 3
- Router/API exposure: Task 4
- `competitor-remix` batch UI and live polling: Task 5
- Task management resume path: Task 6
- Verification and regression: Task 7

No spec requirement is left without an implementation task.

