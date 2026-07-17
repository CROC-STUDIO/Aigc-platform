# Wangzhuan Segment Recovery And Manual Stitching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a post-batch workbench module that exposes segment results, safe retry and replacement paths, selected downloads, draggable manual stitching, and preserved stitch versions.

**Architecture:** Keep recovery classification and branch/variant grouping in a pure Node/browser-compatible model. Reuse the existing batch persistence, idempotency, FFmpeg probing, output storage, and ZIP packaging paths; add additive batch routes for recovery operations and keep the workbench integration in a scoped ES module.

**Tech Stack:** Node.js 22 ES modules, Node test runner, vanilla HTML/CSS/JavaScript, MySQL fact store with existing JSON metadata, FFmpeg/ffprobe, browser `localStorage`.

---

## File Map

- Create `server/wangzhuan/segment-recovery.mjs`: retry eligibility, group keys, segment/output association, stitch-kind classification.
- Modify `server/wangzhuan/mysql-facts.mjs`: load `task_attempts` into task detail and preserve manual stitch metadata through output probe JSON.
- Modify `server/wangzhuan/pipeline.mjs`: enrich batch detail, user-triggered single/bulk retry, replacement upload persistence.
- Modify `server/wangzhuan/stitch.mjs`: public media probe, manual stitch versions, rename/delete operations.
- Modify `server/wangzhuan/router.mjs`: additive recovery, replacement, stitch-version, and version-management routes.
- Modify `server.mjs`: bounded multipart body parsing.
- Create `public/wangzhuan-segment-recovery.js`: pure queue helpers plus scoped DOM controller.
- Modify `public/wangzhuan-v2.html`: recovery module host after “生成批次”.
- Modify `public/wangzhuan-v2.js`: mount controller and pass restored/polled batch detail.
- Modify `public/styles.css`: desktop/mobile recovery module styles.
- Create `tests/wangzhuan/segment-recovery.test.mjs`: pure recovery and grouping behavior.
- Create `tests/wangzhuan/segment-recovery-router.test.mjs`: additive route contracts and permissions.
- Create `tests/wangzhuan/manual-stitch-version.test.mjs`: stitch classification, ordering, idempotency, metadata, rename/delete.
- Create `tests/wangzhuan/segment-recovery-frontend.test.mjs`: queue persistence and static integration.
- Modify `tests/wangzhuan/mysql-facts.test.mjs`: attempt-history and probe-metadata hydration.

### Task 1: Recovery Classification And Variant Grouping

**Files:**
- Create: `server/wangzhuan/segment-recovery.mjs`
- Create: `tests/wangzhuan/segment-recovery.test.mjs`

- [ ] **Step 1: Write failing pure-model tests**

Cover `asset_review_pending -> repair_required`, retryable timeout, exhausted attempts, ready/replacement outputs, three `be06` variant groups, and mixed stitch classification:

```js
assert.equal(classifyRetryEligibility({
  status: "failed",
  attempts: 1,
  maxAttempts: 2,
  errorCode: "asset_review_pending"
}).status, "repair_required");

assert.equal(classifyRetryEligibility({
  status: "failed",
  attempts: 1,
  maxAttempts: 2,
  errorCode: "upstream_failed",
  responseSummary: { retryable: true }
}).status, "retryable");

assert.deepEqual(
  groupRecoveryTasks(batch).map((group) => [group.key, group.tasks.length]),
  [["branch_1:1", 3], ["branch_1:2", 3], ["branch_1:3", 3]]
);

assert.equal(classifyStitchSelection(batch, ["out_001", "out_004"]).kind, "mixed");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/wangzhuan/segment-recovery.test.mjs`

Expected: FAIL because `server/wangzhuan/segment-recovery.mjs` does not exist.

- [ ] **Step 3: Implement the pure recovery model**

Export these stable functions without I/O:

```js
export function recoveryGroupKey(value = {}) {
  return `${String(value.branchId || "default")}:${Number(value.branchVariantIndex || value.variantIndex || 1)}`;
}

export function classifyRetryEligibility(task = {}) {}
export function groupRecoveryTasks(batch = {}) {}
export function currentSegmentOutput(batch, task) {}
export function enrichSegmentRecovery(batch = {}, attemptsByTask = new Map()) {}
export function classifyStitchSelection(batch = {}, outputIds = []) {}
```

Eligibility must be explicit: `ready`, `replacement_ready`, `running`, `retryable`, `repair_required`, `retry_exhausted`, or `unavailable`. `classifyStitchSelection` returns `{ kind, sourceGroups, outputs }` where kind is `complete`, `partial`, or `mixed`.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `node --test tests/wangzhuan/segment-recovery.test.mjs`

Expected: all recovery-model tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/wangzhuan/segment-recovery.mjs tests/wangzhuan/segment-recovery.test.mjs
git commit -m "feat: model wangzhuan segment recovery states"
```

### Task 2: Attempt History And Batch Detail Enrichment

**Files:**
- Modify: `server/wangzhuan/mysql-facts.mjs`
- Modify: `server/wangzhuan/pipeline.mjs`
- Modify: `tests/wangzhuan/mysql-facts.test.mjs`
- Modify: `tests/wangzhuan/segment-recovery.test.mjs`

- [ ] **Step 1: Write failing hydration tests**

Add a fake MySQL result for `task_attempts` and assert batch detail exposes ordered attempts and enriched fields:

```js
assert.deepEqual(detail.batch.tasks[0].attemptHistory.map((item) => item.attemptNo), [1, 2]);
assert.equal(detail.batch.tasks[0].branchVariantIndex, 1);
assert.equal(detail.batch.tasks[0].segmentIndex, 1);
assert.equal(detail.batch.tasks[0].retryEligibility.status, "retryable");
assert.equal(detail.batch.tasks[0].availability, "retryable");
```

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/wangzhuan/mysql-facts.test.mjs tests/wangzhuan/segment-recovery.test.mjs`

Expected: FAIL because attempts and recovery fields are absent.

- [ ] **Step 3: Load attempts and enrich detail**

Add one bounded query per batch run:

```sql
SELECT wt.task_uid, ta.attempt_no, ta.status, ta.provider, ta.upstream_task_id,
       ta.started_at, ta.finished_at, ta.error_code, ta.error_message, ta.retryable
FROM task_attempts ta
JOIN workflow_tasks wt ON wt.id = ta.task_id
WHERE wt.run_id = ?
ORDER BY wt.id ASC, ta.attempt_no ASC
```

Attach `attemptHistory` while `loadBatchByRunRow` already has the connection. In `getBatchDetail`, call `enrichSegmentRecovery(detail.batch)` and return a new batch object; keep all existing response fields unchanged.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/wangzhuan/mysql-facts.test.mjs tests/wangzhuan/segment-recovery.test.mjs`

Expected: attempt hydration and prior tests pass.

- [ ] **Step 5: Commit**

```bash
git add server/wangzhuan/mysql-facts.mjs server/wangzhuan/pipeline.mjs tests/wangzhuan/mysql-facts.test.mjs tests/wangzhuan/segment-recovery.test.mjs
git commit -m "feat: expose segment recovery detail"
```

### Task 3: User-Triggered Single And Bulk Retry Routes

**Files:**
- Modify: `server/wangzhuan/pipeline.mjs`
- Modify: `server/wangzhuan/router.mjs`
- Create: `tests/wangzhuan/segment-recovery-router.test.mjs`

- [ ] **Step 1: Write failing router tests**

Test additive endpoints, idempotency, eligibility, partial bulk success, and ownership:

```js
const single = await call("POST", `/api/wangzhuan/batches/${batchId}/tasks/gen_abcd_001/retry`, {
  idempotencyKey: "retry-one-1"
});
assert.equal(single.statusCode, 200);
assert.equal(single.payload.data.retriedCount, 1);
assert.equal(single.payload.data.task.retryInfo.automatic, false);

const bulk = await call("POST", `/api/wangzhuan/batches/${batchId}/tasks/retry-failed`, {
  idempotencyKey: "retry-all-1"
});
assert.deepEqual(bulk.payload.data.summary, {
  submitted: 1,
  repairRequired: 1,
  exhausted: 1,
  inProgress: 1
});
```

- [ ] **Step 2: Run the router test and verify RED**

Run: `node --test tests/wangzhuan/segment-recovery-router.test.mjs`

Expected: FAIL with unsupported endpoint.

- [ ] **Step 3: Add idempotent manual retry services and routes**

Refactor `retryFailedGenerationTask` to accept an options object while preserving scheduler behavior:

```js
export async function retryFailedGenerationTask(context, batchId, generationTaskId, options = {}) {
  const automatic = options.automatic !== false;
  const triggerName = automatic ? "scheduler_retry" : "user_retry";
}

export async function retryGenerationTaskForUser(context, batchId, taskId, request = {}) {}
export async function retryFailedGenerationTasksForUser(context, batchId, request = {}) {}
```

Both user operations use `runIdempotentOperation`. The router validates the new task routes before the legacy batch route so `tasks/retry-failed` cannot be parsed as a task ID. Bulk retry classifies first, retries only eligible tasks with bounded sequential execution, and returns a per-task result array.

- [ ] **Step 4: Run focused retry tests and verify GREEN**

Run: `node --test tests/wangzhuan/segment-recovery-router.test.mjs tests/wangzhuan/submission-durability.test.mjs tests/wangzhuan/scheduler-job-lock.test.mjs`

Expected: new routes and existing automatic retry behavior pass.

- [ ] **Step 5: Commit**

```bash
git add server/wangzhuan/pipeline.mjs server/wangzhuan/router.mjs tests/wangzhuan/segment-recovery-router.test.mjs
git commit -m "feat: add user segment retry endpoints"
```

### Task 4: Bounded Replacement Video Upload

**Files:**
- Modify: `server.mjs`
- Modify: `server/wangzhuan/pipeline.mjs`
- Modify: `server/wangzhuan/router.mjs`
- Modify: `server/wangzhuan/stitch.mjs`
- Modify: `tests/wangzhuan/segment-recovery-router.test.mjs`

- [ ] **Step 1: Write failing upload tests**

Cover allowed MP4/MOV/WEBM, 100 MB limit, unsupported MIME/extension, missing task, cross-project output rejection, ffprobe failure, and successful `replacement_ready` detail:

```js
const response = await callMultipart(
  "POST",
  `/api/wangzhuan/batches/${batchId}/tasks/gen_abcd_002/replacement`,
  { fileName: "replacement.mp4", mimeType: "video/mp4", buffer: validVideo }
);
assert.equal(response.statusCode, 200);
assert.equal(response.payload.data.output.kind, "segment_video");
assert.equal(response.payload.data.output.fulfillmentSource, "user_replacement");
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/wangzhuan/segment-recovery-router.test.mjs`

Expected: FAIL because the replacement route is missing.

- [ ] **Step 3: Bound multipart reads**

Change the server helpers compatibly:

```js
async function readRequestBuffer(req, options = {}) {
  const maxBytes = Number(options.maxBytes || 0);
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (maxBytes > 0 && size > maxBytes) throw new WangzhuanError("file_too_large", "上传文件超过大小上限", { maxUploadBytes: maxBytes });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readMultipart(req, options = {}) {
  const body = await readRequestBuffer(req, options);
}
```

Keep existing callers working with no options. The replacement route calls `readMultipart(req, { maxBytes: 100 * 1024 * 1024 + 1024 * 1024 })`.

- [ ] **Step 4: Persist validated replacement output**

Export `probeVideoStreamHealth` from `stitch.mjs`. `uploadSegmentReplacement` writes to a random safe file under the batch `segments/` directory, probes it, syncs storage, creates a new `segment_video` output with `fulfillmentSource: "user_replacement"`, and writes the batch. On any failure, remove the temporary file and do not append an output.

- [ ] **Step 5: Run focused upload tests and verify GREEN**

Run: `node --test tests/wangzhuan/segment-recovery-router.test.mjs tests/wangzhuan/postprocess-assets.test.mjs tests/wangzhuan/v2-router-jobs.test.mjs`

Expected: replacement and legacy upload routes pass.

- [ ] **Step 6: Commit**

```bash
git add server.mjs server/wangzhuan/pipeline.mjs server/wangzhuan/router.mjs server/wangzhuan/stitch.mjs tests/wangzhuan/segment-recovery-router.test.mjs
git commit -m "feat: support replacement segment uploads"
```

### Task 5: Manual Stitch Versions And Management

**Files:**
- Modify: `server/wangzhuan/stitch.mjs`
- Modify: `server/wangzhuan/router.mjs`
- Create: `tests/wangzhuan/manual-stitch-version.test.mjs`

- [ ] **Step 1: Write failing stitch-version tests**

Cover ordered output IDs, same-group complete/partial, cross-group confirmation, single-segment version, incompatible/missing outputs, replayed idempotency, preserved prior versions, rename, and guarded delete:

```js
const result = await createManualStitchVersion(context, batchId, {
  idempotencyKey: "manual-stitch-1",
  segmentOutputIds: ["out_001", "out_004", "out_006"],
  confirmMixed: true
});
assert.equal(result.output.stitchKind, "mixed");
assert.deepEqual(result.output.segmentOutputIds, ["out_001", "out_004", "out_006"]);
assert.equal(result.batch.outputs.filter((output) => output.kind === "stitched_video").length, 3);
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/wangzhuan/manual-stitch-version.test.mjs`

Expected: FAIL because manual stitch APIs are missing.

- [ ] **Step 3: Implement manual version creation in the stitch owner module**

Export:

```js
export async function createManualStitchVersion(context, batchId, request = {}) {}
export async function renameManualStitchVersion(context, outputId, request = {}) {}
export async function deleteManualStitchVersion(context, outputId, request = {}) {}
```

Validate ownership through the batch read path. Resolve only `segment_video` outputs from the current batch, classify on the server, require `confirmMixed` for mixed groups, run authoritative probes, concatenate in request order, and append a new `stitched_video` output with `manualStitch: true`, `stitchVersion`, `stitchKind`, `sourceGroups`, `segmentOutputIds`, and `createdBy`. Do not set `replaceDerivedOutputs` and do not remove prior outputs.

Rename changes only `displayFileName`. Delete accepts only `manualStitch: true`, removes the exact output/report/file after checking active references, then writes the batch and an audit event.

- [ ] **Step 4: Add routes**

Add:

```text
POST   /api/wangzhuan/batches/:batchId/stitch-versions
PATCH  /api/wangzhuan/outputs/:outputId
DELETE /api/wangzhuan/outputs/:outputId
```

Reuse the standard envelope, scoped context, and structured `WangzhuanError` codes.

- [ ] **Step 5: Run focused stitch tests and verify GREEN**

Run: `node --test tests/wangzhuan/manual-stitch-version.test.mjs tests/wangzhuan/stitch-single-encode.test.mjs tests/wangzhuan/non-30-runtime.test.mjs tests/wangzhuan/package.test.mjs`

Expected: manual versions and existing stitching/package behavior pass.

- [ ] **Step 6: Commit**

```bash
git add server/wangzhuan/stitch.mjs server/wangzhuan/router.mjs tests/wangzhuan/manual-stitch-version.test.mjs
git commit -m "feat: preserve manual stitch versions"
```

### Task 6: Frontend Queue Model And Controller

**Files:**
- Create: `public/wangzhuan-segment-recovery.js`
- Create: `tests/wangzhuan/segment-recovery-frontend.test.mjs`

- [ ] **Step 1: Write failing pure frontend tests**

Test variant grouping, output selection, queue add/remove/dedupe/reorder, stale output cleanup, localStorage keys, and stitch request construction:

```js
const model = buildRecoveryViewModel(detail.batch);
assert.deepEqual(model.groups.map((group) => group.key), ["branch_1:1", "branch_1:2", "branch_1:3"]);

const queue = reconcileQueue(["out_004", "out_missing", "out_001"], model.outputsById);
assert.deepEqual(queue, ["out_004", "out_001"]);

assert.deepEqual(buildStitchRequest(queue, model, "key-1"), {
  idempotencyKey: "key-1",
  segmentOutputIds: ["out_004", "out_001"],
  confirmMixed: true
});
```

- [ ] **Step 2: Run test and verify RED**

Run: `node --test tests/wangzhuan/segment-recovery-frontend.test.mjs`

Expected: FAIL because the frontend module does not exist.

- [ ] **Step 3: Implement pure helpers and scoped controller**

Export:

```js
export function buildRecoveryViewModel(batch = {}) {}
export function queueStorageKey({ userId, projectKey, batchId }) {}
export function reconcileQueue(outputIds = [], outputsById = new Map()) {}
export function moveQueueItem(outputIds, fromIndex, toIndex) {}
export function buildStitchRequest(outputIds, model, idempotencyKey) {}
export function createSegmentRecoveryController(options = {}) {}
```

The controller receives `{ root, request, downloadZip, showToast, getScope }`; it has `update(detail)`, `destroy()`, and no top-level DOM side effects. Use event delegation, abortable fetch where available, and one polling owner from the workbench rather than a second global timer.

- [ ] **Step 4: Run frontend model tests and verify GREEN**

Run: `node --test tests/wangzhuan/segment-recovery-frontend.test.mjs`

Expected: all queue/model tests pass.

- [ ] **Step 5: Commit**

```bash
git add public/wangzhuan-segment-recovery.js tests/wangzhuan/segment-recovery-frontend.test.mjs
git commit -m "feat: add segment recovery frontend model"
```

### Task 7: Workbench UI Integration

**Files:**
- Modify: `public/wangzhuan-v2.html`
- Modify: `public/wangzhuan-v2.js`
- Modify: `public/styles.css`
- Modify: `tests/wangzhuan/segment-recovery-frontend.test.mjs`
- Modify: `tests/wangzhuan/v2-frontend-static.test.mjs`

- [ ] **Step 1: Write failing static and controller integration tests**

Assert the new host is immediately after `wzNodeBatch`, hidden before a batch, imports the new module, and exposes the approved commands and states. Assert controller update receives every restored/polled batch detail.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/wangzhuan/segment-recovery-frontend.test.mjs tests/wangzhuan/v2-frontend-static.test.mjs`

Expected: FAIL because the host and controller mounting are absent.

- [ ] **Step 3: Add semantic host and mount the controller**

Use one section:

```html
<section class="wz-v2-band wz-segment-recovery" id="wzSegmentRecovery" hidden aria-labelledby="wzSegmentRecoveryTitle">
  <div class="wz-v2-section-head">
    <span><b>4</b><h2 id="wzSegmentRecoveryTitle">片段恢复与拼接</h2></span>
    <span id="wzSegmentRecoveryState" aria-live="polite"></span>
  </div>
  <div id="wzSegmentRecoveryBody"></div>
</section>
```

Mount once after login/bootstrap. Call `controller.update(detail)` from `renderBatchDetail`, restoration, and polling. Clear/hide it when starting a new task.

- [ ] **Step 4: Implement scoped responsive CSS and interactions**

Match the approved preview: summary metrics, grouped one-line segments, lazy expanded preview/attempts, selected download and retry actions, draggable queue with keyboard move menu, compatibility banner, and independent version rows. Keep card radius at 8px or less and reuse current color variables.

- [ ] **Step 5: Run focused frontend tests and verify GREEN**

Run: `node --test tests/wangzhuan/segment-recovery-frontend.test.mjs tests/wangzhuan/v2-frontend-static.test.mjs tests/wangzhuan/frontend-polling.test.mjs`

Expected: all recovery integration and existing polling tests pass.

- [ ] **Step 6: Commit**

```bash
git add public/wangzhuan-v2.html public/wangzhuan-v2.js public/styles.css public/wangzhuan-segment-recovery.js tests/wangzhuan/segment-recovery-frontend.test.mjs tests/wangzhuan/v2-frontend-static.test.mjs
git commit -m "feat: add segment recovery workbench"
```

### Task 8: Full Regression And Browser Verification

**Files:**
- Verify all files listed above.

- [ ] **Step 1: Run focused backend tests**

Run:

```bash
node --test tests/wangzhuan/segment-recovery.test.mjs tests/wangzhuan/segment-recovery-router.test.mjs tests/wangzhuan/manual-stitch-version.test.mjs tests/wangzhuan/mysql-facts.test.mjs tests/wangzhuan/submission-durability.test.mjs tests/wangzhuan/scheduler-job-lock.test.mjs tests/wangzhuan/stitch-single-encode.test.mjs tests/wangzhuan/non-30-runtime.test.mjs tests/wangzhuan/package.test.mjs
```

Expected: all focused backend tests pass.

- [ ] **Step 2: Run focused frontend tests**

Run:

```bash
node --test tests/wangzhuan/segment-recovery-frontend.test.mjs tests/wangzhuan/v2-frontend-static.test.mjs tests/wangzhuan/frontend-polling.test.mjs
```

Expected: all focused frontend tests pass.

- [ ] **Step 3: Run the full suite and static checks**

Run:

```bash
npm test
git diff --check
npm audit --omit=dev
```

Expected: all tests pass, diff check is clean, and audit reports no unresolved production vulnerability introduced by this change.

- [ ] **Step 4: Start the local app and verify HTTP**

Use the repo’s existing local Docker stack on port 5182. Confirm:

```text
GET /wangzhuan-v2.html -> 200
GET /api/wangzhuan/batches/wzb_20260717051112_be06 -> authenticated structured detail
```

Do not submit paid Seedance jobs during verification. Use test fixtures or the existing failed batch for read-only UI states.

- [ ] **Step 5: Browser-check desktop and mobile**

At 1440x1000 and 430x900 verify no overlap, the module is hidden without a batch, `be06` groups 3x3 and marks all nine tasks `repair_required`, keyboard queue ordering works, selected download count updates, and mixed variants require confirmation. Capture screenshots.

- [ ] **Step 6: Review the final diff and commit**

Stage only feature files, verify no secrets, local absolute paths, diagnostic scripts, or existing untracked files are included, then commit:

```bash
git commit -m "feat: add wangzhuan segment recovery and manual stitching"
```
