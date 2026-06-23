# Competitor Remix Async Prototype Design

Date: 2026-06-23
Branch: feature/20260617_xxdd

## Goal

Build a front-end prototype on the existing `competitor-remix.html` workflow for competitor-material async processing. The prototype must let users review the batch workflow before back-end integration starts.

The prototype is intentionally UI-first:

- Use the current `competitor-remix.html`, `competitor-remix.js`, and `styles.css` surface.
- Add realistic page structure, status states, and mock task progression.
- Do not submit real `video-content-ops` jobs in the prototype.
- Do not change the existing back-end API in this phase.

## Source Requirement

The Lark requirement describes "竞品素材快速改造" as:

1. Upload a competitor video.
2. Identify competitor icon, product name, CTA, ending, watermark, subtitles, and phone UI regions.
3. Allow manual screenshot selection or text description for replacement areas.
4. Replace icon, product name, CTA, ending, remove or cover watermarks, and use K-frame local handling when needed.
5. Output a new video.
6. Run automatic QC.
7. Put passing results into the gallery.

The embedded requirement table adds:

- Support videos within one minute.
- Support daily volume from dozens to hundreds.
- Return a task id for every task.
- Return explicit failure reasons.
- Let users preview, download, and inspect QC results.

## Current System Fit

`video-content-ops` can be integrated later through its async job flow:

- `POST /api/v1/jobs`
- `GET /api/v1/jobs/{job_id}`
- `GET /api/v1/jobs/{job_id}/download`

Relevant job capabilities:

- `auto_ai_remove`: point or box prompt, SAM2 mask propagation, removal through the configured back end.
- `mask_edit`: region-based cover or blur.
- `ai_remove`: automatic or manual mask-based LaMa removal.
- `language_rewrite` and `video_copy_translate`: OCR/ASR subtitle and on-screen text handling.
- `end_trim_detection`: ending or tail guidance detection/cut.

The prototype should expose these capability choices, but only as mock task types.

## Core Interaction Model

Use a split model: batch list plus single-material visual editor.

Multiple source videos can exist in the batch, but point/box selection only happens for one active video at a time. This avoids ambiguous region editing across videos.

### Source Material List

The source column becomes a multi-material list. Each card shows:

- File name.
- Duration and aspect ratio when known or mocked.
- Upload/mock readiness state.
- Region configuration state: not configured, configured, needs review.
- Task summary: pending tasks, running tasks, failed tasks, succeeded tasks.

Clicking a card makes it the active editable material.

### Single-Material Visual Editor

The middle column edits only the active material. It shows:

- Preview frame or video placeholder.
- Region overlay layer.
- Region tools: box select, point select, clear selected, delete region.
- Region type: logo/icon, watermark, product name, CTA, subtitle, phone UI, ending.
- Capability mapping preview:
  - logo/icon/watermark -> `auto_ai_remove`, `ai_remove`, or `mask_edit`
  - subtitle/on-screen text/CTA -> `language_rewrite` or `video_copy_translate`
  - ending -> `end_trim_detection`

Saving regions updates only the active source material.

### Batch Apply And Review Queue

Because many competitor videos share layout, users need a way to reuse region work safely.

Add actions:

- "Apply current regions to selected materials": copies normalized region coordinates from the active material.
- Copied materials become "needs review" rather than "ready", because layout differences may make copied coordinates wrong.
- "Show needs review only": filters the material list to sources that still require manual confirmation.

### Async Task Queue

Add a task queue panel in the delivery column. It shows mock jobs generated from configured regions:

- Local task id.
- Source material.
- Capability type.
- Status: draft, queued, running, review_required, succeeded, failed.
- Failure reason when failed.
- Actions: simulate submit, simulate progress, retry, stop, inspect log.

The prototype should make the future back-end contract visible without relying on the real API.

### Preview And Delivery

Keep the current "processing status and gallery" idea, but make it batch-aware:

- Per-material output cards.
- QC badge: pass, manual required, failed.
- Preview link placeholder.
- Single output download placeholder.
- Batch download placeholder.

## States To Prototype

The prototype must show these user-visible states:

1. Empty batch.
2. Multiple sources uploaded.
3. Active source selected.
4. Region configured.
5. Region copied to another source and marked needs review.
6. Draft tasks generated.
7. Queued/running task.
8. Review-required task.
9. Failed task with explicit reason.
10. Succeeded output in gallery.

## Error Handling

Prototype errors are mock-only but should mirror real integration concerns:

- Unsupported file: source card displays rejected state.
- Missing region: task generation disabled for region-dependent capabilities.
- Needs review: copied regions cannot submit until confirmed.
- Upstream failure: task shows code and user-facing reason.
- Capacity wait: queued task explains that GPU or LLM capacity is busy.

## Testing And Verification

For prototype implementation:

- Run the existing Node test suite if changes touch shared JS helpers.
- Open `/competitor-remix.html` locally.
- Verify desktop layout.
- Verify a mobile/narrow viewport does not overlap text or controls.
- Verify mock task transitions work without a back-end call.

For later real integration:

- Add contract tests for request payload mapping from UI task type to `video-content-ops` job payload.
- Add failure mapping tests for `video-content-ops` errors.
- Add polling tests for queued/running/review_required/succeeded/failed.

## Out Of Scope For Prototype

- Real `video-content-ops` job submission.
- Real file upload changes.
- Real object storage or signed URL changes.
- True multi-batch concurrent execution.
- Full automatic detection of product name, CTA, phone UI, or ending.
- Final QC model implementation.

## Approval Gate

After this design is reviewed, the next step is an implementation plan for the front-end prototype only. Back-end async job integration should be planned after the prototype interaction is accepted.
