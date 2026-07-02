# Video Ops Single Capability Batch — Design Spec

**Date:** 2026-07-02  
**Status:** Approved (brainstorming)  
**Approach:** B — Batch parent task with backend-orchestrated child jobs

---

## Summary

Users choose one existing `video-ops` capability, upload a batch of videos, and submit once. The system creates one batch parent task plus one child task per video. Each child task independently creates and tracks a real `video-ops` job. Results are written back item by item as soon as each upstream job finishes. Failed items are marked failed immediately and do not block later items in the same batch.

This is a **single capability batch runner**, not the multi-step auto-remix pipeline.

---

## Goals

| Goal | Detail |
|------|--------|
| Minimal operator flow | Upload a batch, confirm once, then wait |
| Real incremental feedback | One item finishes, one item writes back immediately |
| Failure isolation | One failed item does not stop the rest of the batch |
| Resume across pages | Current page shows live progress; task management page can reopen the same batch later |
| Reuse existing video-ops integration | Keep real provider execution in existing single-job flow |

## Non-Goals

- Multi-step auto-remix orchestration
- Capability auto-detection or region detection
- Per-video manual interaction (`auto_ai_remove`, `mask_edit`, `ai_remove manual`)
- Per-video custom parameters inside one batch
- Automatic multi-round retry / healing
- First-version ZIP packaging as the main output form

---

## Scope

### Supported job types in v1

- `seedance_ai_remove`
- `ai_remove` with `mode="auto"`
- `end_trim_detection`

### Explicitly excluded from v1

- `auto_ai_remove`
- `mask_edit`
- `sticker_blur`
- `ai_remove` with `mode="manual"`
- `language_rewrite`
- `video_copy_translate`
- `material_analysis`

Reason: v1 is intentionally limited to no-manual-parameter, no-per-item-interaction job types.

---

## Architecture

```text
batch upload
  → create batch parent task
  → create child items[]
  → background batch orchestrator
      → for each queued item:
          createVideoOpsJob
          poll upstream job
          sync/download result
          write outputUrl or failure
      → update parent counters continuously
  → current page polls batch detail
  → task management page reads the same batch detail
```

### Design principle

Do not let the frontend become the orchestrator. The backend owns:

- child job creation
- concurrency control
- polling
- incremental writeback
- parent status aggregation

The frontend only:

- creates the batch
- polls batch detail
- renders per-item progress and results

---

## Data Model

### Parent task: `video_ops_batch`

```json
{
  "batchId": "vob_20260702_001",
  "type": "video_ops_batch",
  "jobType": "seedance_ai_remove",
  "batchStatus": "queued",
  "totalCount": 12,
  "queuedCount": 12,
  "runningCount": 0,
  "succeededCount": 0,
  "failedCount": 0,
  "canceledCount": 0,
  "createdBy": "user_x",
  "createdAt": "2026-07-02T10:00:00Z",
  "updatedAt": "2026-07-02T10:00:00Z"
}
```

### Child item

```json
{
  "itemId": "vobi_20260702_001",
  "batchId": "vob_20260702_001",
  "sourceName": "video-01.mp4",
  "sourceInput": {
    "source_type": "url",
    "source": "https://..."
  },
  "itemStatus": "queued",
  "providerJobId": "",
  "outputUrl": "",
  "errorMessage": "",
  "startedAt": null,
  "finishedAt": null
}
```

### Parent statuses

- `queued`
- `running`
- `partial_failed`
- `succeeded`
- `failed`
- `canceled`

### Child statuses

- `queued`
- `submitting`
- `running`
- `succeeded`
- `failed`
- `canceled`

### Aggregation rules

- Any child entering execution makes parent `running`
- All children succeeded → parent `succeeded`
- Mixed success + failure → parent `partial_failed`
- All children failed → parent `failed`
- Cancel only affects unfinished items; completed items stay terminal

---

## API

### POST `/api/wangzhuan/video-ops/batches`

Create one batch parent task and N child items.

**Request:**

```json
{
  "jobType": "seedance_ai_remove",
  "idempotencyKey": "client-uuid",
  "inputMode": "upload",
  "items": [
    {
      "sourceName": "video-01.mp4",
      "input": {
        "source_type": "url",
        "source": "https://..."
      }
    }
  ]
}
```

**Validation:**

- `jobType` must be one of the v1 whitelist
- `items.length >= 1`
- only video inputs allowed
- all items in one batch share the same `jobType`

**Response:**

```json
{
  "batchId": "vob_20260702_001",
  "type": "video_ops_batch",
  "batchStatus": "queued",
  "totalCount": 12
}
```

### GET `/api/wangzhuan/video-ops/batches/:batchId`

Returns parent status plus child items.

**Response shape:**

```json
{
  "batch": {
    "batchId": "vob_20260702_001",
    "jobType": "seedance_ai_remove",
    "batchStatus": "running",
    "totalCount": 12,
    "queuedCount": 4,
    "runningCount": 2,
    "succeededCount": 5,
    "failedCount": 1
  },
  "items": [
    {
      "itemId": "vobi_1",
      "sourceName": "video-01.mp4",
      "itemStatus": "succeeded",
      "providerJobId": "upstream_job_x",
      "outputUrl": "https://...",
      "errorMessage": ""
    }
  ]
}
```

### GET `/api/wangzhuan/video-ops/batches`

Batch list for task management page.

Supports:

- pagination
- scope filter
- status filter
- jobType filter

### POST `/api/wangzhuan/video-ops/batches/:batchId/cancel`

Behavior:

- queued items → direct `canceled`
- running items → best-effort call existing upstream cancel flow
- completed items unchanged

### Optional v1.1

- `POST /api/wangzhuan/video-ops/batches/:batchId/retry-failed`

Not required for v1 launch.

---

## Backend Orchestration

### Core flow

```javascript
runVideoOpsBatch(context, batch):
  for each item in batch where itemStatus === queued:
    submit child upstream job
    record providerJobId
  continuously poll unfinished children
  if child succeeded:
    sync result
    materialize outputUrl
    update itemStatus = succeeded
  if child failed:
    write errorMessage
    update itemStatus = failed
  after each child state change:
    recompute parent counters and batchStatus
```

### Reused existing single-job functions

- `createVideoOpsJob`
- `getVideoOpsJob`
- `getVideoOpsJobResult`
- `downloadVideoOpsJob`
- `cancelVideoOpsJob`
- `archiveVideoOpsSubmission`
- `syncVideoOpsJobArchive`

### New module responsibilities

| Module | Action |
|--------|--------|
| `server/wangzhuan/video-ops-batch.mjs` | batch create / read / aggregate / cancel |
| `server/wangzhuan/video-ops-batch-runner.mjs` | background orchestration loop |
| `server/wangzhuan/background-jobs.mjs` | extend for `video_ops_batch` runtime tracking |
| `server/wangzhuan/router.mjs` | expose batch endpoints |

### Concurrency

Use bounded concurrency per batch.

Recommended default:

- `maxConcurrentItems = 2` or `3`

Reason:

- reduces upstream pressure
- keeps provider failures localized
- simpler first-version scheduling

### Input materialization

Do not keep full file payloads in memory during batch execution.

Each child item should reference a reusable input source:

- storage URL
- or server-side local path if already materialized

Do not pass large base64 payloads repeatedly once the batch is created.

---

## Idempotency

Batch creation must be replay-safe.

### Parent-level idempotency

`POST /batches` requires `idempotencyKey`.

If the same user submits the same batch create request with the same key:

- return existing `batchId`
- do not create a duplicate parent or duplicate child items

### Child-level idempotency

Each child submission to upstream should also use a derived deterministic key, for example:

```text
batch:{batchId}:item:{itemId}:submit
```

This prevents duplicate upstream job creation if the batch runner retries around submission boundaries.

---

## Failure Handling

### Rules

| Event | Behavior |
|-------|----------|
| Child submit fails | mark child `failed`; continue batch |
| Child upstream job fails | mark child `failed`; continue batch |
| Child result sync fails | mark child `failed`; continue batch |
| Poll network error | bounded retry, then child `failed` |
| Parent refresh/page close | no effect on backend execution |

### Important invariant

No single child failure may stop later queued items in the same batch.

### Retry policy

Keep first version conservative:

- submit transient failure: 1 short retry
- poll transient failure: bounded retry
- upstream terminal `failed`: no automatic multi-round replay

User-visible failed item retry can be added later.

---

## Frontend UX

## `competitor-remix` page

Add a new mode for **single capability batch**.

### Step 1 — choose capability

Only three options visible in v1:

- `seedance_ai_remove`
- `ai_remove_auto`
- `end_trim_detection`

### Step 2 — upload batch

User uploads multiple videos.

Each row shows:

- file name
- size
- upload status
- later: child status
- later: output URL or failure reason

### Step 3 — create and monitor batch

After confirm:

- create one batch parent
- switch UI into monitoring mode
- poll batch detail every 3000ms

Display:

- parent summary
- child table
- real-time succeeded / failed counts
- per-item output link as soon as available

### State restore

If URL contains `batchId`, reopen directly into monitoring mode for that batch.

## Task management page

Add a new task type:

- `video_ops_batch`

It should support:

- listing batch parents
- opening child item detail
- viewing output links
- viewing failure reasons

This gives:

- current page = immediate monitoring
- task management page = resume later

---

## Output Writeback

Each child item should write back independently:

- `providerJobId`
- `itemStatus`
- `outputUrl`
- `finishedAt`
- `errorMessage` when failed

Do not wait for whole-batch completion before exposing successful outputs.

This is the core product behavior.

---

## Testing

### Unit tests

- parent status aggregation
- child status transitions
- idempotency hit behavior
- failure-isolated progression

### API tests

- create batch
- get batch detail
- cancel batch
- duplicate create with same idempotency key returns same batch

### Frontend static/state tests

- only three supported batch job types visible
- batch upload area renders
- monitor state renders per-item status and output link columns
- batchId restore path works

### Integration tests

Mock upstream so one batch can contain:

- some succeeded items
- some failed items
- out-of-order completions

Assertions:

- early success is visible before batch end
- failed item does not block later items
- final parent status becomes `partial_failed` when mixed

---

## Phased Delivery

| PR | Scope |
|----|-------|
| PR1 | parent/child batch model, create/list/detail/cancel APIs, batch runner |
| PR2 | `competitor-remix` batch UI and live polling |
| PR3 | task management page integration |

---

## Open Items (post-v1)

- retry failed items from UI
- batch-level ZIP package
- per-item parameter overrides
- broader job type support
- progress event push via SSE/websocket instead of polling

