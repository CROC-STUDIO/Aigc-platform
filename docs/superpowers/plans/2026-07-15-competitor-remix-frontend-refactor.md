# Competitor Remix Frontend Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the competitor-remix node canvas with a five-capability, three-column workbench while preserving every existing video-ops request path.

**Architecture:** Keep the page build-free and split it into browser-native ES modules. Pure catalog, payload, store, geometry, and job modules are tested in Node; the DOM view composes those modules and preserves the existing authentication and API helpers.

**Tech Stack:** Node.js 22 test runner, browser ES Modules, vanilla HTML/CSS/JavaScript, existing `wangzhuan-common.js` helpers.

---

## File Map

- Create `public/competitor-remix/capability-catalog.js`: five user capabilities and ten execution-path mappings.
- Create `public/competitor-remix/payloads.js`: pure validation and request construction.
- Create `public/competitor-remix/store.js`: source, per-mode drafts, and concurrent run state.
- Create `public/competitor-remix/media-workspace.js`: immediate Object URL preview and lazy data-URL preparation.
- Create `public/competitor-remix/editors.js`: visible-media geometry and pointer interaction controllers.
- Create `public/competitor-remix/job-runner.js`: submit, polling, cancel, retry, result, and restoration.
- Create `public/competitor-remix/view.js`: three-column rendering and event routing.
- Create `public/competitor-remix.css`: page-scoped layout and responsive states.
- Replace `public/competitor-remix.js`: thin application bootstrap.
- Replace the workbench portion of `public/competitor-remix.html`: semantic three-column shell.
- Create `tests/wangzhuan/competitor-remix-modules.test.mjs`: pure module behavior.
- Update `tests/wangzhuan/competitor-remix-static.test.mjs`: DOM and module-boundary regression.

### Task 1: Capability Catalog and Payload Contract

**Files:**
- Create: `public/competitor-remix/capability-catalog.js`
- Create: `public/competitor-remix/payloads.js`
- Create: `tests/wangzhuan/competitor-remix-modules.test.mjs`

- [ ] **Step 1: Write failing mapping and payload tests**

Test that the catalog exposes exactly five capabilities and these mode mappings:

```js
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
```

Test representative payloads for all ten paths, including `ai_remove` auto/manual, K-frame point/box, region spec, language fields, report text, priority clamping, and redacted previews.

- [ ] **Step 2: Run tests and verify RED**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: FAIL because catalog and payload modules do not exist.

- [ ] **Step 3: Implement the catalog and pure payload builder**

Expose stable interfaces:

```js
export const CAPABILITIES = Object.freeze([...]);
export function getCapability(capabilityId) {}
export function getMode(capabilityId, modeId) {}
export function listExecutionPaths() {}

export function validateDraft({ capabilityId, modeId, source, draft }) {
  return { ok, errors, requirements };
}
export function buildPayload({ capabilityId, modeId, source, draft, maskSource }) {
  return { job_type, input, options, params };
}
export function redactPayload(payload) {}
```

Use the defaults and ranges already enforced by `server/wangzhuan/video-ops.mjs`. Do not introduce a new request field.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: all catalog and payload tests pass.

### Task 2: Store and Draft Isolation

**Files:**
- Create: `public/competitor-remix/store.js`
- Modify: `tests/wangzhuan/competitor-remix-modules.test.mjs`

- [ ] **Step 1: Write failing store tests**

Cover these transitions:

```js
const store = createRemixStore({ storage: memoryStorage });
store.updateDraft("remove", "kframe", { frameIndex: 42 });
store.selectMode("remove", "automatic");
assert.equal(store.getDraft("remove", "kframe").frameIndex, 42);

store.replaceSource({ mode: "file", file: fakeFile, objectUrl: "blob:test" });
assert.equal(store.getDraft("remove", "kframe").frameIndex, 0);
assert.equal(store.getDraft("remove", "automatic").maskThreshold, 1);

store.upsertRun({ runId: "run-1", status: "running" });
store.upsertRun({ runId: "run-2", status: "queued" });
assert.equal(store.getState().runs.length, 2);
```

Also verify persisted state excludes File, Object URL, Base64, and authentication data.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: FAIL because `createRemixStore` is missing.

- [ ] **Step 3: Implement the observable store**

Expose:

```js
export function createRemixStore({ storage = globalThis.sessionStorage } = {}) {
  return {
    getState,
    subscribe,
    setUser,
    selectCapability,
    selectMode,
    updateDraft,
    getDraft,
    replaceSource,
    patchSource,
    resetCurrentDraft,
    upsertRun,
    patchRun,
    setActiveRun,
    destroy
  };
}
```

Clone public snapshots before notifying subscribers. Clear only frame and region fields when the source identity changes.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: store and prior tests pass.

### Task 3: Immediate Media Feedback and Lazy Base64

**Files:**
- Create: `public/competitor-remix/media-workspace.js`
- Modify: `tests/wangzhuan/competitor-remix-modules.test.mjs`

- [ ] **Step 1: Write failing media tests**

Inject URL and reader functions, then verify Object URL creation occurs during `selectFile`, while data-URL reading occurs only during `prepareInput`:

```js
const media = createMediaWorkspace({ store, createObjectURL, revokeObjectURL, readAsDataURL });
media.selectFile(videoFile);
assert.equal(createObjectURL.calls, 1);
assert.equal(readAsDataURL.calls, 0);
await media.prepareInput();
assert.equal(readAsDataURL.calls, 1);
await media.prepareInput();
assert.equal(readAsDataURL.calls, 1);
```

Cover invalid MIME, 300 MB limit, URL input, reader failure, and revoking the previous Object URL.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: FAIL because the media workspace is missing.

- [ ] **Step 3: Implement media workspace**

Expose:

```js
export function createMediaWorkspace({ store, maxBytes = 314572800, createObjectURL, revokeObjectURL, readAsDataURL }) {
  return { selectFile, clearFile, setUrl, updateMetadata, prepareInput, destroy };
}
```

`selectFile` performs synchronous MIME/size checks, creates a preview URL, and updates status to `ready`. `prepareInput` sets `preparing`, caches one data URL per selected File, and restores `ready` or records a field error.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: all media, store, and payload tests pass.

### Task 4: Unified Editor Geometry

**Files:**
- Create: `public/competitor-remix/editors.js`
- Modify: `tests/wangzhuan/competitor-remix-modules.test.mjs`

- [ ] **Step 1: Write failing geometry tests**

Test portrait video inside a landscape container and ensure black bars are excluded:

```js
const rect = visibleMediaRect({ left: 0, top: 0, width: 400, height: 300 }, { width: 100, height: 200 });
assert.deepEqual(rect, { left: 125, top: 0, width: 150, height: 300 });
assert.deepEqual(normalizedPoint({ clientX: 200, clientY: 150 }, rect), { x: 0.5, y: 0.5 });
assert.equal(normalizedPoint({ clientX: 20, clientY: 150 }, rect), null);
assert.deepEqual(normalizedBox({ x: 0.8, y: 0.7 }, { x: 0.2, y: 0.1 }), {
  x1: 0.2, y1: 0.1, x2: 0.8, y2: 0.7
});
```

Cover minimum box size and point labels.

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: FAIL because editor geometry functions are missing.

- [ ] **Step 3: Implement pure geometry and pointer binding**

Expose:

```js
export function visibleMediaRect(containerRect, mediaSize) {}
export function normalizedPoint(pointer, visibleRect) {}
export function normalizedBox(start, end, minSize = 0.01) {}
export function createRegionEditor({ surface, getMediaSize, onChange }) {
  return { setMode, setValue, clear, destroy };
}
```

Use Pointer Events and Pointer Capture. Render overlays in the view; editor controllers emit normalized values only.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: geometry and all prior module tests pass.

### Task 5: Concurrent Job Runner

**Files:**
- Create: `public/competitor-remix/job-runner.js`
- Modify: `tests/wangzhuan/competitor-remix-modules.test.mjs`

- [ ] **Step 1: Write failing runner tests**

Inject `request`, timers, and visibility state. Verify two submitted jobs retain separate timers and results; a transient GET error patches only connection state; terminal status stops only that run; retry calls `/retry` for the original job ID.

```js
const runner = createJobRunner({ store, request, setTimer, clearTimer, pollMs: 3000 });
await runner.submit(contextA);
await runner.submit(contextB);
assert.equal(store.getState().runs.filter((run) => run.status === "queued").length, 2);
await runner.retry("run-a");
assert.equal(request.lastUrl, "/api/wangzhuan/video-ops/jobs/job-a/retry");
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: FAIL because the job runner is missing.

- [ ] **Step 3: Implement job runner**

Expose:

```js
export function createJobRunner({ store, request, pollMs = 3000, setTimer, clearTimer, isVisible }) {
  return { submit, refresh, loadResult, cancel, retry, resume, destroy };
}
```

Maintain a timer map keyed by run ID. Terminal statuses are `succeeded`, `review_required`, `failed`, and `canceled`. Redact request snapshots before persistence.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `node --test tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: all module tests pass.

### Task 6: Three-Column View Integration

**Files:**
- Modify: `public/competitor-remix.html`
- Replace: `public/competitor-remix.js`
- Create: `public/competitor-remix/view.js`
- Create: `public/competitor-remix.css`
- Modify: `tests/wangzhuan/competitor-remix-static.test.mjs`

- [ ] **Step 1: Replace static tests with failing architecture assertions**

Assert the page contains `remixCapabilityNav`, `remixWorkspace`, `remixRunRail`, `remixDropzone`, `remixEditorSurface`, and `remixReadiness`; imports the page stylesheet and thin bootstrap; does not contain `remixCanvas`, `remixStepbar`, `videoOpsTaskGrid`, or old node-canvas classes. Assert the bootstrap imports the new store, media, runner, and view modules.

- [ ] **Step 2: Run static tests and verify RED**

Run: `node --test tests/wangzhuan/competitor-remix-static.test.mjs`

Expected: FAIL against the old node-canvas HTML and monolithic bootstrap.

- [ ] **Step 3: Implement semantic HTML and scoped CSS**

Use this stable shell:

```html
<main class="remix-shell" id="competitorRemixApp">
  <aside class="remix-capabilities" id="remixCapabilityNav"></aside>
  <section class="remix-workspace" id="remixWorkspace">
    <section class="remix-source" id="remixDropzone"></section>
    <section class="remix-editor" id="remixEditorSurface"></section>
  </section>
  <aside class="remix-runs" id="remixRunRail">
    <section id="remixReadiness"></section>
    <section id="remixRunList"></section>
  </aside>
</main>
```

Desktop uses `grid-template-columns: minmax(210px, 250px) minmax(0, 1fr) minmax(280px, 340px)`. Mobile changes the navigation to a horizontal scroller and the run rail to an expandable section without overlaying the editor.

- [ ] **Step 4: Implement view and thin bootstrap**

The view renders catalog-driven controls, source states, advanced settings, coordinate overlays, readiness, run cards, and results. The bootstrap creates store/media/runner/view, binds login, restores runs, and releases resources on `beforeunload`.

- [ ] **Step 5: Run static and module tests**

Run: `node --test tests/wangzhuan/competitor-remix-static.test.mjs tests/wangzhuan/competitor-remix-modules.test.mjs`

Expected: all tests pass.

### Task 7: Regression and Browser Verification

**Files:**
- Modify only files already listed when a failing regression requires a fix.

- [ ] **Step 1: Run syntax and focused tests**

Run:

```bash
node --check public/competitor-remix.js
node --check public/competitor-remix/view.js
node --test tests/wangzhuan/competitor-remix-static.test.mjs tests/wangzhuan/competitor-remix-modules.test.mjs
git diff --check -- public/competitor-remix.html public/competitor-remix.js public/competitor-remix public/competitor-remix.css tests/wangzhuan/competitor-remix-static.test.mjs tests/wangzhuan/competitor-remix-modules.test.mjs
```

Expected: syntax, focused tests, and whitespace checks pass.

- [ ] **Step 2: Run related server contract tests**

Run: `node --test tests/wangzhuan/video-ops*.test.mjs tests/wangzhuan/remix*.test.mjs`

If no matching files exist for a glob, run the focused video-ops tests discovered with `rg --files tests/wangzhuan | rg 'video-ops|remix'`.

Expected: existing API-contract tests pass unchanged.

- [ ] **Step 3: Browser regression**

Start the local service on an unused port. Verify desktop `1440x900`, tablet `1024x768`, and mobile `390x844`:

- Exactly five capability entries are visible.
- File selection and drag/drop show metadata and preview before Base64 preparation.
- Every mode keeps its draft after switching away and back.
- K-frame point, K-frame box, fixed region, and mask region update visible overlays.
- One running job does not disable editing or another submission.
- Empty, loading, validation, network error, failed, canceled, review-required, and succeeded UI states fit without overlap.
- Browser console has no uncaught errors.

- [ ] **Step 4: Review the scoped diff**

Confirm no server, database, configuration, deployment, or unrelated page files were changed by this refactor. Record any environment-dependent path not exercised locally.
