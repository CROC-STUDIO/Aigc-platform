# 竞品素材改造异步任务原型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `competitor-remix.html` 上实现一版前端原型，支持多源素材列表、单素材可视化区域编辑、区域复制复核、mock 异步任务队列和批次化交付展示。

**Architecture:** 原型保留现有页面入口和真实 remix 代码边界，但新增一个 UI-only prototype mode：页面结构提供批量素材和任务队列容器，`competitor-remix.js` 用本地 mock state 渲染素材、区域、任务和图库，不提交真实 `video-content-ops` 或 `/api/wangzhuan/remix/*` 任务。现有 mask editor 的几何计算和覆盖层可复用，但状态源从单个 `state.source/state.regions` 扩展为 `state.prototype.sources[activeSourceId].regions`。

**Tech Stack:** 原生 HTML、CSS、ES module JavaScript、现有 `wangzhuan-common.js` UI helper、Node `node:test` 静态测试、本地 `node server.mjs` 验证。

---

## File Structure

- Modify: `tests/wangzhuan/frontend-static.test.mjs`
  - Add static assertions for the prototype DOM anchors, mock-only guardrails, task queue controls, review queue labels, and CSS hooks.
- Modify: `public/competitor-remix.html`
  - Add prototype DOM containers inside the existing three-column canvas.
  - Keep existing IDs required by current tests and page bootstrapping.
  - Add upload `multiple` to support multi-source mock intake.
- Modify: `public/competitor-remix.js`
  - Add prototype state and fixtures.
  - Add render functions for source cards, active editor context, capability plan, review queue, mock async tasks, and mock gallery.
  - Redirect prototype buttons to local state transitions instead of real submit APIs.
  - Keep existing real API functions present for later integration, but do not call them from prototype controls.
- Modify: `public/styles.css`
  - Add `.remix-prototype-*` styles for dense source cards, editor toolbar, task queue, status chips, review filter, output cards, and responsive stacking.
- No new backend files.

## Task 1: Add Static Test Coverage For Prototype Anchors

**Files:**
- Modify: `tests/wangzhuan/frontend-static.test.mjs`

- [ ] **Step 1: Add failing static assertions for the prototype UI**

In `tests/wangzhuan/frontend-static.test.mjs`, inside `test("competitor remix page keeps independent video-platform remix flow", async () => { ... })`, add these assertions after the existing `assert.match(html, /id="remixMaskPreviewCanvas"/);` line:

```js
  assert.match(html, /id="remixPrototypeSourceList"/);
  assert.match(html, /id="remixPrototypeReviewOnly"/);
  assert.match(html, /id="remixPrototypeApplyRegionsBtn"/);
  assert.match(html, /id="remixPrototypeConfirmReviewBtn"/);
  assert.match(html, /id="remixPrototypeCapabilityPlan"/);
  assert.match(html, /id="remixPrototypeTaskQueue"/);
  assert.match(html, /id="remixPrototypeGallery"/);
  assert.match(html, /批量素材/);
  assert.match(html, /单素材可视化编辑/);
  assert.match(html, /异步任务队列/);
  assert.match(html, /只看需复核/);
  assert.match(html, /应用当前区域到选中素材/);
  assert.match(html, /生成草稿任务/);
  assert.match(html, /模拟推进/);
```

Still inside the same test, add these assertions near the existing script assertions:

```js
  assert.match(script, /prototype:\s*\{/);
  assert.match(script, /function createMockSourceFromFile/);
  assert.match(script, /function activePrototypeSource/);
  assert.match(script, /function renderPrototypeSources/);
  assert.match(script, /function renderPrototypeCapabilityPlan/);
  assert.match(script, /function renderPrototypeTaskQueue/);
  assert.match(script, /function generatePrototypeDraftTasks/);
  assert.match(script, /function advancePrototypeTask/);
  assert.match(script, /function copyRegionsToSelectedPrototypeSources/);
  assert.match(script, /function confirmPrototypeSourceReview/);
  assert.match(script, /const PROTOTYPE_MODE = true/);
  assert.doesNotMatch(script, /startMaskEdit\(\);\s*\/\/ prototype submit/);
```

Add these assertions near the existing style assertions:

```js
  assert.match(styles, /\.remix-prototype-source-card/);
  assert.match(styles, /\.remix-prototype-source-card\.active/);
  assert.match(styles, /\.remix-prototype-task/);
  assert.match(styles, /\.remix-prototype-task\.failed/);
  assert.match(styles, /\.remix-prototype-capability-grid/);
  assert.match(styles, /\.remix-prototype-toolbar/);
  assert.match(styles, /\.remix-prototype-output-grid/);
```

- [ ] **Step 2: Run the targeted static test and verify it fails**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: FAIL in `competitor remix page keeps independent video-platform remix flow` because `remixPrototypeSourceList` and related prototype anchors do not exist yet.

- [ ] **Step 3: Commit the failing test**

Run:

```bash
git add tests/wangzhuan/frontend-static.test.mjs
git commit -m "test: cover competitor remix async prototype anchors"
```

## Task 2: Add Prototype HTML Structure

**Files:**
- Modify: `public/competitor-remix.html`

- [ ] **Step 1: Enable multi-file source selection**

Change the current source input:

```html
<input id="remixSourceFile" class="wz-upload-input" type="file" accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg" />
```

to:

```html
<input id="remixSourceFile" class="wz-upload-input" type="file" accept="video/mp4,video/webm,video/quicktime,image/png,image/jpeg" multiple />
```

- [ ] **Step 2: Add source list and review controls**

In `public/competitor-remix.html`, inside `#remixNodeSource .wz-node-body`, replace:

```html
<div id="remixSourceBox" class="wz-list empty-line">未上传源素材</div>
```

with:

```html
<div class="remix-prototype-toolbar">
  <label class="wz-check"><input id="remixPrototypeReviewOnly" type="checkbox" /> 只看需复核</label>
  <button id="remixPrototypeSeedBtn" class="mini ghost" type="button">载入示例素材</button>
</div>
<div id="remixSourceBox" class="wz-list empty-line">未上传源素材</div>
<div id="remixPrototypeSourceList" class="remix-prototype-source-list" aria-label="批量素材列表"></div>
```

- [ ] **Step 3: Update editor heading and add capability plan panel**

Change the `#remixNodeMask` heading:

```html
<h2>Mask 编辑窗口</h2>
```

to:

```html
<h2>单素材可视化编辑</h2>
```

Inside `#remixNodeMask .wz-node-body`, after the `remixOperationType` label, add:

```html
<div class="remix-prototype-toolbar">
  <button id="remixPrototypeApplyRegionsBtn" class="ghost" type="button" disabled>应用当前区域到选中素材</button>
  <button id="remixPrototypeConfirmReviewBtn" class="ghost" type="button" disabled>确认当前素材复核</button>
  <button id="remixPrototypeGenerateTasksBtn" type="button" disabled>生成草稿任务</button>
</div>
<div id="remixPrototypeCapabilityPlan" class="remix-prototype-capability-grid" aria-label="能力映射预览"></div>
```

- [ ] **Step 4: Add async task queue and prototype gallery containers**

In `#remixNodeDelivery .wz-node-body`, after `#remixDetailBox`, add:

```html
<div class="remix-prototype-toolbar">
  <button id="remixPrototypeSubmitTasksBtn" type="button" disabled>模拟提交队列</button>
  <button id="remixPrototypeAdvanceTasksBtn" class="ghost" type="button" disabled>模拟推进</button>
</div>
<div id="remixPrototypeTaskQueue" class="remix-prototype-task-list" aria-label="异步任务队列"></div>
```

In `#remixNodeGallery .wz-node-body`, after `#remixGalleryBox`, add:

```html
<div id="remixPrototypeGallery" class="remix-prototype-output-grid" aria-label="批次输出预览"></div>
```

- [ ] **Step 5: Run the targeted static test and verify HTML assertions now pass far enough to fail on JS/CSS**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: FAIL remains, but failures should now point to missing JS functions or CSS classes rather than missing HTML anchors.

- [ ] **Step 6: Commit HTML structure**

Run:

```bash
git add public/competitor-remix.html
git commit -m "feat: add competitor remix async prototype structure"
```

## Task 3: Add Prototype State Model And Source Rendering

**Files:**
- Modify: `public/competitor-remix.js`

- [ ] **Step 1: Add prototype element refs**

In the `els` object in `public/competitor-remix.js`, after `galleryBox: $("#remixGalleryBox")`, add:

```js
  ,
  prototypeReviewOnly: $("#remixPrototypeReviewOnly"),
  prototypeSeedBtn: $("#remixPrototypeSeedBtn"),
  prototypeSourceList: $("#remixPrototypeSourceList"),
  prototypeApplyRegionsBtn: $("#remixPrototypeApplyRegionsBtn"),
  prototypeConfirmReviewBtn: $("#remixPrototypeConfirmReviewBtn"),
  prototypeGenerateTasksBtn: $("#remixPrototypeGenerateTasksBtn"),
  prototypeCapabilityPlan: $("#remixPrototypeCapabilityPlan"),
  prototypeSubmitTasksBtn: $("#remixPrototypeSubmitTasksBtn"),
  prototypeAdvanceTasksBtn: $("#remixPrototypeAdvanceTasksBtn"),
  prototypeTaskQueue: $("#remixPrototypeTaskQueue"),
  prototypeGallery: $("#remixPrototypeGallery")
```

If the preceding property already has a trailing comma after implementation edits, keep exactly one comma between properties.

- [ ] **Step 2: Add prototype constants and state**

After `const PROVIDER_RUNNING_STATUSES = new Set(["submitting", "pending", "running"]);`, add:

```js
const PROTOTYPE_MODE = true;
const PROTOTYPE_CAPABILITIES = {
  logo_icon: { label: "Logo/Icon 去除", jobType: "auto_ai_remove", detail: "框选或点选后传播 mask" },
  watermark: { label: "水印遮挡", jobType: "mask_edit", detail: "区域遮挡或模糊" },
  product_name: { label: "产品名替换", jobType: "language_rewrite", detail: "OCR 后生成覆盖计划" },
  cta: { label: "CTA 文案替换", jobType: "video_copy_translate", detail: "字幕/画面文字回写" },
  subtitle: { label: "字幕处理", jobType: "video_copy_translate", detail: "OCR/ASR 时间轴处理" },
  phone_ui: { label: "手机界面区域", jobType: "mask_edit", detail: "标记需人工确认" },
  ending: { label: "Ending 检测", jobType: "end_trim_detection", detail: "尾部导流检测/裁切" }
};
const PROTOTYPE_STATUS_LABELS = {
  draft: "草稿",
  queued: "排队中",
  running: "处理中",
  review_required: "待确认",
  succeeded: "成功",
  failed: "失败",
  stopped: "已停止"
};
```

In the `state` object, after `activeLock: null`, add:

```js
  ,
  prototype: {
    activeSourceId: "",
    selectedSourceIds: new Set(),
    reviewOnly: false,
    sources: [],
    tasks: [],
    outputs: []
  }
```

- [ ] **Step 3: Add source model helpers**

After `function selectedOperationType() { ... }`, add:

```js
function prototypeSourceStatus(source) {
  if (source.rejected) return "rejected";
  if (source.reviewRequired) return "review";
  if (source.regions?.length) return "configured";
  return "empty";
}

function prototypeSourceStatusLabel(source) {
  const status = prototypeSourceStatus(source);
  return {
    rejected: "已拒绝",
    review: "需复核",
    configured: "已配置",
    empty: "未配置"
  }[status] || "未配置";
}

function createMockSourceFromFile(file, index = state.prototype.sources.length) {
  const isVideo = String(file?.type || "").startsWith("video/");
  const safeName = file?.name || `competitor-${index + 1}.mp4`;
  return {
    sourceId: `mock_src_${Date.now()}_${index + 1}`,
    fileName: safeName,
    kind: isVideo ? "video" : "image",
    durationSec: isVideo ? 42 + index * 3 : 0,
    ratio: index % 2 ? "1:1" : "9:16",
    sizeMb: file?.size ? Math.max(1, Math.round(file.size / 1024 / 1024)) : 18 + index,
    previewUrl: file ? URL.createObjectURL(file) : "",
    regions: [],
    reviewRequired: false,
    rejected: !file ? false : !String(file.type || "").match(/^(video\/|image\/)/),
    createdAt: new Date().toISOString()
  };
}

function seedPrototypeSources() {
  state.prototype.sources = [
    {
      sourceId: "mock_src_001",
      fileName: "competitor_logo_watermark.mp4",
      kind: "video",
      durationSec: 38,
      ratio: "9:16",
      sizeMb: 24,
      previewUrl: "",
      regions: [
        { regionId: "mask_1", type: "bbox", label: "logo_icon", bbox: { x: 0.06, y: 0.08, width: 0.18, height: 0.08 } },
        { regionId: "mask_2", type: "bbox", label: "watermark", bbox: { x: 0.68, y: 0.9, width: 0.24, height: 0.06 } }
      ],
      reviewRequired: false,
      rejected: false,
      createdAt: new Date().toISOString()
    },
    {
      sourceId: "mock_src_002",
      fileName: "competitor_subtitle_cta.mp4",
      kind: "video",
      durationSec: 51,
      ratio: "9:16",
      sizeMb: 31,
      previewUrl: "",
      regions: [],
      reviewRequired: true,
      rejected: false,
      createdAt: new Date().toISOString()
    },
    {
      sourceId: "mock_src_003",
      fileName: "competitor_ending_scene.mp4",
      kind: "video",
      durationSec: 44,
      ratio: "1:1",
      sizeMb: 27,
      previewUrl: "",
      regions: [],
      reviewRequired: false,
      rejected: false,
      createdAt: new Date().toISOString()
    }
  ];
  state.prototype.activeSourceId = state.prototype.sources[0].sourceId;
  state.prototype.selectedSourceIds = new Set(state.prototype.sources.map((source) => source.sourceId));
}

function activePrototypeSource() {
  return state.prototype.sources.find((source) => source.sourceId === state.prototype.activeSourceId) || null;
}

function syncPrototypeActiveSourceToLegacyState() {
  const source = activePrototypeSource();
  if (!source) {
    state.source = null;
    state.regions = [];
    return;
  }
  state.source = {
    sourceId: source.sourceId,
    previewUrl: source.previewUrl,
    probe: {
      sourceId: source.sourceId,
      fileName: source.fileName,
      kind: source.kind,
      durationSec: source.durationSec,
      ratio: source.ratio,
      width: source.ratio === "1:1" ? 1024 : 720,
      height: source.ratio === "1:1" ? 1024 : 1280,
      mimeType: source.kind === "video" ? "video/mp4" : "image/png",
      status: source.rejected ? "fail" : "pass"
    }
  };
  state.regions = (source.regions || []).map((region) => ({ ...region, bbox: { ...region.bbox } }));
  state.selectedRegionId = state.regions[0]?.regionId || "";
}
```

- [ ] **Step 4: Add source rendering**

After `function renderSource() { ... }`, add:

```js
function renderPrototypeSources() {
  if (!els.prototypeSourceList) return;
  const sources = state.prototype.reviewOnly
    ? state.prototype.sources.filter((source) => source.reviewRequired)
    : state.prototype.sources;
  if (!sources.length) {
    els.prototypeSourceList.innerHTML = `<div class="empty-line">暂无批量素材</div>`;
    return;
  }
  els.prototypeSourceList.innerHTML = sources.map((source) => {
    const active = source.sourceId === state.prototype.activeSourceId ? " active" : "";
    const checked = state.prototype.selectedSourceIds.has(source.sourceId) ? "checked" : "";
    const taskCounts = prototypeTaskCountsForSource(source.sourceId);
    return `
      <article class="remix-prototype-source-card${active}" data-source-id="${escapeHtml(source.sourceId)}">
        <label class="wz-check">
          <input type="checkbox" data-prototype-source-check="${escapeHtml(source.sourceId)}" ${checked} />
          <span>${escapeHtml(source.fileName)}</span>
        </label>
        <button type="button" class="ghost" data-prototype-source-open="${escapeHtml(source.sourceId)}">编辑</button>
        <small>${escapeHtml(source.durationSec || "-")}s · ${escapeHtml(source.ratio || "-")} · ${escapeHtml(source.sizeMb || "-")}MB</small>
        <div class="remix-prototype-source-meta">
          ${badge(prototypeSourceStatus(source), { empty: "未配置", configured: "已配置", review: "需复核", rejected: "已拒绝" })}
          <span>${escapeHtml(source.regions?.length || 0)} 个区域</span>
          <span>${escapeHtml(taskCounts.running)} 进行中</span>
          <span>${escapeHtml(taskCounts.failed)} 失败</span>
        </div>
      </article>
    `;
  }).join("");
}
```

Add this helper before `renderPrototypeSources()` or immediately after it:

```js
function prototypeTaskCountsForSource(sourceId) {
  const tasks = state.prototype.tasks.filter((task) => task.sourceId === sourceId);
  return {
    running: tasks.filter((task) => task.status === "queued" || task.status === "running").length,
    failed: tasks.filter((task) => task.status === "failed").length,
    succeeded: tasks.filter((task) => task.status === "succeeded").length
  };
}
```

- [ ] **Step 5: Wire initial prototype render into reset flow**

In `resetWorkshopState()`, after `renderSource();`, add:

```js
  if (PROTOTYPE_MODE && !state.prototype.sources.length) seedPrototypeSources();
  syncPrototypeActiveSourceToLegacyState();
  renderPrototypeSources();
```

Then keep the existing `renderDetail();` and `syncMetrics();`.

- [ ] **Step 6: Run targeted test**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: FAIL remains on missing later functions/CSS, but syntax errors must not occur.

- [ ] **Step 7: Commit prototype state/source rendering**

Run:

```bash
git add public/competitor-remix.js
git commit -m "feat: add competitor remix prototype source state"
```

## Task 4: Add Prototype Capability Plan, Region Copy, And Review Actions

**Files:**
- Modify: `public/competitor-remix.js`

- [ ] **Step 1: Persist editor regions back to the active source**

In `commitMaskEdit(regionId, bbox)`, after updating `state.selectedRegionId = regionId;`, add:

```js
  const activeSource = activePrototypeSource();
  if (PROTOTYPE_MODE && activeSource) {
    activeSource.regions = state.regions.map((region) => ({ ...region, bbox: { ...normalizeBbox(region.bbox) } }));
    activeSource.reviewRequired = false;
  }
```

In the Delete/Backspace branch inside `bindMaskEditor()`, after filtering `state.regions`, add:

```js
      const activeSource = activePrototypeSource();
      if (PROTOTYPE_MODE && activeSource) {
        activeSource.regions = state.regions.map((item) => ({ ...item, bbox: { ...normalizeBbox(item.bbox) } }));
      }
```

- [ ] **Step 2: Add capability-plan rendering**

After `renderPrototypeSources()`, add:

```js
function capabilityKeysForRegions(regions = []) {
  const labels = new Set(regions.map((region) => String(region.label || "").toLowerCase()));
  const keys = [];
  if ([...labels].some((label) => label.includes("logo") || label.includes("icon"))) keys.push("logo_icon");
  if ([...labels].some((label) => label.includes("watermark") || label.includes("mask"))) keys.push("watermark");
  if ([...labels].some((label) => label.includes("product"))) keys.push("product_name");
  if ([...labels].some((label) => label.includes("cta"))) keys.push("cta");
  if ([...labels].some((label) => label.includes("subtitle"))) keys.push("subtitle");
  if ([...labels].some((label) => label.includes("phone"))) keys.push("phone_ui");
  if ([...labels].some((label) => label.includes("ending"))) keys.push("ending");
  return keys.length ? [...new Set(keys)] : ["logo_icon", "watermark"];
}

function renderPrototypeCapabilityPlan() {
  if (!els.prototypeCapabilityPlan) return;
  const source = activePrototypeSource();
  if (!source) {
    els.prototypeCapabilityPlan.innerHTML = `<div class="empty-line">请选择素材后配置能力</div>`;
    return;
  }
  const keys = capabilityKeysForRegions(source.regions || []);
  els.prototypeCapabilityPlan.innerHTML = keys.map((key) => {
    const capability = PROTOTYPE_CAPABILITIES[key];
    return `
      <article class="remix-prototype-capability">
        <strong>${escapeHtml(capability.label)}</strong>
        <small>${escapeHtml(capability.jobType)} · ${escapeHtml(capability.detail)}</small>
      </article>
    `;
  }).join("");
}
```

- [ ] **Step 3: Add region copy and review actions**

After `renderPrototypeCapabilityPlan()`, add:

```js
function copyRegionsToSelectedPrototypeSources() {
  const source = activePrototypeSource();
  if (!source || !source.regions?.length) return;
  const selectedIds = [...state.prototype.selectedSourceIds].filter((sourceId) => sourceId !== source.sourceId);
  for (const sourceId of selectedIds) {
    const target = state.prototype.sources.find((item) => item.sourceId === sourceId);
    if (!target || target.rejected) continue;
    target.regions = source.regions.map((region, index) => ({
      ...region,
      regionId: `mask_${index + 1}`,
      bbox: { ...normalizeBbox(region.bbox) }
    }));
    target.reviewRequired = true;
  }
  renderPrototypeAll();
  showToast("当前区域已复制到选中素材，请逐条复核", { type: "success" });
}

function confirmPrototypeSourceReview() {
  const source = activePrototypeSource();
  if (!source) return;
  source.reviewRequired = false;
  renderPrototypeAll();
  showToast("当前素材复核已确认", { type: "success" });
}

function renderPrototypeAll() {
  syncPrototypeActiveSourceToLegacyState();
  renderSource();
  renderMaskEditor(true);
  renderPrototypeSources();
  renderPrototypeCapabilityPlan();
  renderPrototypeTaskQueue();
  renderPrototypeGallery();
  syncMetrics();
}
```

- [ ] **Step 4: Update `syncMetrics()` for prototype buttons**

At the end of `syncMetrics()`, before `syncFlowHints();`, add:

```js
  const activePrototype = activePrototypeSource();
  const hasPrototypeRegions = Boolean(activePrototype?.regions?.length);
  if (els.prototypeApplyRegionsBtn) {
    els.prototypeApplyRegionsBtn.disabled = unavailable || !hasPrototypeRegions || state.prototype.selectedSourceIds.size <= 1;
  }
  if (els.prototypeConfirmReviewBtn) {
    els.prototypeConfirmReviewBtn.disabled = unavailable || !activePrototype?.reviewRequired;
  }
  if (els.prototypeGenerateTasksBtn) {
    els.prototypeGenerateTasksBtn.disabled = unavailable || !hasPrototypeRegions || activePrototype?.reviewRequired || activePrototype?.rejected;
  }
```

- [ ] **Step 5: Run targeted test**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: FAIL remains on missing task functions/CSS only; no runtime syntax failures.

- [ ] **Step 6: Commit capability and review behavior**

Run:

```bash
git add public/competitor-remix.js
git commit -m "feat: add competitor remix prototype review actions"
```

## Task 5: Add Mock Async Task Queue And Prototype Gallery

**Files:**
- Modify: `public/competitor-remix.js`

- [ ] **Step 1: Add draft task generation**

After `confirmPrototypeSourceReview()`, add:

```js
function generatePrototypeDraftTasks() {
  const source = activePrototypeSource();
  if (!source || source.rejected || source.reviewRequired || !source.regions?.length) return;
  const keys = capabilityKeysForRegions(source.regions);
  const existingKeys = new Set(state.prototype.tasks.filter((task) => task.sourceId === source.sourceId).map((task) => task.capabilityKey));
  for (const key of keys) {
    if (existingKeys.has(key)) continue;
    const capability = PROTOTYPE_CAPABILITIES[key];
    state.prototype.tasks.push({
      taskId: `mock_task_${state.prototype.tasks.length + 1}`.padEnd(13, "0"),
      sourceId: source.sourceId,
      sourceName: source.fileName,
      capabilityKey: key,
      jobType: capability.jobType,
      status: "draft",
      failureReason: "",
      log: [`已生成 ${capability.label} 草稿任务`]
    });
  }
  renderPrototypeAll();
}
```

- [ ] **Step 2: Add task status transitions**

After `generatePrototypeDraftTasks()`, add:

```js
function nextPrototypeTaskStatus(task) {
  if (task.status === "draft") return "queued";
  if (task.status === "queued") return "running";
  if (task.status === "running") return task.capabilityKey === "phone_ui" ? "failed" : "review_required";
  if (task.status === "review_required") return "succeeded";
  return task.status;
}

function advancePrototypeTask(taskId = "") {
  const tasks = taskId
    ? state.prototype.tasks.filter((task) => task.taskId === taskId)
    : state.prototype.tasks.filter((task) => !["succeeded", "failed", "stopped"].includes(task.status));
  for (const task of tasks) {
    const nextStatus = nextPrototypeTaskStatus(task);
    task.status = nextStatus;
    if (nextStatus === "failed") {
      task.failureReason = "mock_upstream_capacity_or_region_mismatch";
      task.log.push("上游返回失败：区域疑似覆盖手机界面，需人工重新框选");
    } else {
      task.log.push(`任务状态推进为 ${PROTOTYPE_STATUS_LABELS[nextStatus] || nextStatus}`);
    }
    if (nextStatus === "succeeded" && !state.prototype.outputs.some((output) => output.taskId === task.taskId)) {
      state.prototype.outputs.push({
        outputId: `mock_output_${state.prototype.outputs.length + 1}`,
        taskId: task.taskId,
        sourceId: task.sourceId,
        sourceName: task.sourceName,
        kind: task.jobType,
        qcStatus: "pass",
        previewUrl: ""
      });
    }
  }
  renderPrototypeAll();
}

function stopPrototypeTask(taskId) {
  const task = state.prototype.tasks.find((item) => item.taskId === taskId);
  if (!task || ["succeeded", "failed", "stopped"].includes(task.status)) return;
  task.status = "stopped";
  task.log.push("用户在原型中停止任务");
  renderPrototypeAll();
}

function retryPrototypeTask(taskId) {
  const task = state.prototype.tasks.find((item) => item.taskId === taskId);
  if (!task || task.status !== "failed") return;
  task.status = "queued";
  task.failureReason = "";
  task.log.push("失败任务已重新排队");
  renderPrototypeAll();
}
```

- [ ] **Step 3: Add task queue rendering**

After the transition helpers, add:

```js
function renderPrototypeTaskQueue() {
  if (!els.prototypeTaskQueue) return;
  if (!state.prototype.tasks.length) {
    els.prototypeTaskQueue.innerHTML = `<div class="empty-line">暂无异步任务，先配置区域并生成草稿任务</div>`;
    if (els.prototypeSubmitTasksBtn) els.prototypeSubmitTasksBtn.disabled = true;
    if (els.prototypeAdvanceTasksBtn) els.prototypeAdvanceTasksBtn.disabled = true;
    return;
  }
  els.prototypeTaskQueue.innerHTML = state.prototype.tasks.map((task) => `
    <article class="remix-prototype-task ${escapeHtml(task.status)}" data-task-id="${escapeHtml(task.taskId)}">
      <div>
        <strong>${escapeHtml(task.taskId)}</strong>
        <small>${escapeHtml(task.sourceName)} · ${escapeHtml(task.jobType)}</small>
      </div>
      ${badge(task.status, PROTOTYPE_STATUS_LABELS)}
      ${task.failureReason ? `<p>${escapeHtml(task.failureReason)}</p>` : ""}
      <div class="remix-prototype-task-actions">
        <button type="button" class="mini ghost" data-prototype-task-advance="${escapeHtml(task.taskId)}">模拟推进</button>
        <button type="button" class="mini ghost" data-prototype-task-retry="${escapeHtml(task.taskId)}" ${task.status === "failed" ? "" : "disabled"}>重试</button>
        <button type="button" class="mini ghost" data-prototype-task-stop="${escapeHtml(task.taskId)}" ${["succeeded", "failed", "stopped"].includes(task.status) ? "disabled" : ""}>停止</button>
      </div>
    </article>
  `).join("");
  if (els.prototypeSubmitTasksBtn) {
    els.prototypeSubmitTasksBtn.disabled = !state.prototype.tasks.some((task) => task.status === "draft");
  }
  if (els.prototypeAdvanceTasksBtn) {
    els.prototypeAdvanceTasksBtn.disabled = !state.prototype.tasks.some((task) => !["succeeded", "failed", "stopped"].includes(task.status));
  }
}
```

- [ ] **Step 4: Add prototype gallery rendering**

After `renderPrototypeTaskQueue()`, add:

```js
function renderPrototypeGallery() {
  if (!els.prototypeGallery) return;
  if (!state.prototype.outputs.length) {
    els.prototypeGallery.innerHTML = `<div class="empty-line">暂无 mock 输出</div>`;
    return;
  }
  els.prototypeGallery.innerHTML = state.prototype.outputs.map((output) => `
    <article class="remix-prototype-output">
      <div>
        <strong>${escapeHtml(output.outputId)}</strong>
        <small>${escapeHtml(output.sourceName)} · ${escapeHtml(output.kind)}</small>
      </div>
      ${badge(output.qcStatus, { pass: "QC 通过", manual_required: "需人工确认", fail: "QC 失败" })}
      <button type="button" class="mini ghost">预览占位</button>
      <button type="button" class="mini ghost">下载占位</button>
    </article>
  `).join("");
}
```

- [ ] **Step 5: Extend `syncMetrics()` for aggregate counts**

In `syncMetrics()`, replace:

```js
  els.sourceCount.textContent = state.source ? "1" : "0";
  els.regionCount.textContent = state.regions.length;
  els.outputCount.textContent = state.detail?.remix?.outputs?.length || state.gallery?.counts?.total || 0;
  els.downloadCount.textContent = state.detail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
```

with:

```js
  const prototypeSourceCount = state.prototype.sources.length;
  const prototypeRegionCount = state.prototype.sources.reduce((sum, source) => sum + (source.regions?.length || 0), 0);
  const prototypeOutputCount = state.prototype.outputs.length;
  els.sourceCount.textContent = prototypeSourceCount || (state.source ? "1" : "0");
  els.regionCount.textContent = prototypeRegionCount || state.regions.length;
  els.outputCount.textContent = prototypeOutputCount || state.detail?.remix?.outputs?.length || state.gallery?.counts?.total || 0;
  els.downloadCount.textContent = prototypeOutputCount || state.detail?.downloadSummary?.downloadEligibleCount || state.gallery?.counts?.downloadEligible || 0;
```

- [ ] **Step 6: Run targeted static test**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: FAIL remains only on CSS hook assertions if Task 6 is not done yet.

- [ ] **Step 7: Commit mock task queue**

Run:

```bash
git add public/competitor-remix.js
git commit -m "feat: add competitor remix mock async queue"
```

## Task 6: Wire Prototype Events And Prevent Real Submits In Prototype Mode

**Files:**
- Modify: `public/competitor-remix.js`

- [ ] **Step 1: Change source file handler to create mock sources in prototype mode**

In `bindEvents()`, inside `els.sourceFile.addEventListener("change", () => { ... })`, replace:

```js
    const file = els.sourceFile.files?.[0];
    if (!file) {
      clearSourceObjectUrl();
      renderSource();
      return;
    }
    renderSelectedSource(file);
    uploadSource();
```

with:

```js
    const files = [...(els.sourceFile.files || [])];
    if (!files.length) {
      clearSourceObjectUrl();
      renderPrototypeAll();
      return;
    }
    if (PROTOTYPE_MODE) {
      state.prototype.sources.push(...files.map((file, index) => createMockSourceFromFile(file, index)));
      if (!state.prototype.activeSourceId) state.prototype.activeSourceId = state.prototype.sources[0]?.sourceId || "";
      for (const source of state.prototype.sources) state.prototype.selectedSourceIds.add(source.sourceId);
      renderPrototypeAll();
      showToast("已加入 mock 批量素材，原型阶段不会上传真实文件", { type: "success" });
      return;
    }
    const file = files[0];
    renderSelectedSource(file);
    uploadSource();
```

- [ ] **Step 2: Redirect confirm button away from real API in prototype mode**

In `bindEvents()`, replace:

```js
  els.maskConfirmBtn.addEventListener("click", startMaskEdit);
```

with:

```js
  els.maskConfirmBtn.addEventListener("click", () => {
    if (PROTOTYPE_MODE) {
      generatePrototypeDraftTasks();
      showToast("已生成原型草稿任务，未调用真实后端", { type: "success" });
      return;
    }
    startMaskEdit();
  });
```

- [ ] **Step 3: Add prototype control event handlers**

In `bindEvents()`, after the `els.galleryBox.addEventListener("click", ...)` block, add:

```js
  els.prototypeSeedBtn?.addEventListener("click", () => {
    seedPrototypeSources();
    renderPrototypeAll();
  });
  els.prototypeReviewOnly?.addEventListener("change", (event) => {
    state.prototype.reviewOnly = Boolean(event.target.checked);
    renderPrototypeSources();
  });
  els.prototypeSourceList?.addEventListener("click", (event) => {
    const checkbox = event.target.closest?.("[data-prototype-source-check]");
    if (checkbox) {
      const sourceId = checkbox.dataset.prototypeSourceCheck;
      if (checkbox.checked) state.prototype.selectedSourceIds.add(sourceId);
      else state.prototype.selectedSourceIds.delete(sourceId);
      renderPrototypeSources();
      syncMetrics();
      return;
    }
    const opener = event.target.closest?.("[data-prototype-source-open]");
    if (!opener) return;
    state.prototype.activeSourceId = opener.dataset.prototypeSourceOpen;
    renderPrototypeAll();
  });
  els.prototypeApplyRegionsBtn?.addEventListener("click", copyRegionsToSelectedPrototypeSources);
  els.prototypeConfirmReviewBtn?.addEventListener("click", confirmPrototypeSourceReview);
  els.prototypeGenerateTasksBtn?.addEventListener("click", generatePrototypeDraftTasks);
  els.prototypeSubmitTasksBtn?.addEventListener("click", () => {
    for (const task of state.prototype.tasks) {
      if (task.status === "draft") task.status = "queued";
    }
    renderPrototypeAll();
  });
  els.prototypeAdvanceTasksBtn?.addEventListener("click", () => advancePrototypeTask());
  els.prototypeTaskQueue?.addEventListener("click", (event) => {
    const advance = event.target.closest?.("[data-prototype-task-advance]");
    if (advance) return advancePrototypeTask(advance.dataset.prototypeTaskAdvance);
    const retry = event.target.closest?.("[data-prototype-task-retry]");
    if (retry) return retryPrototypeTask(retry.dataset.prototypeTaskRetry);
    const stop = event.target.closest?.("[data-prototype-task-stop]");
    if (stop) return stopPrototypeTask(stop.dataset.prototypeTaskStop);
  });
```

- [ ] **Step 4: Make initialization render prototype panels**

In `init()`, after `renderMaskEditor();`, add:

```js
  if (PROTOTYPE_MODE) {
    seedPrototypeSources();
    renderPrototypeAll();
  }
```

- [ ] **Step 5: Run targeted static test**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: FAIL remains only on CSS hook assertions if styles are not yet added. If it fails on old `state.detail = { remix: { status: "queued"` assertion, keep the existing `startMaskEdit` function unchanged and only redirect event handling as specified.

- [ ] **Step 6: Commit prototype event wiring**

Run:

```bash
git add public/competitor-remix.js
git commit -m "feat: wire competitor remix prototype controls"
```

## Task 7: Add Prototype Styles And Responsive Layout

**Files:**
- Modify: `public/styles.css`

- [ ] **Step 1: Add source card, toolbar, capability, task, and output styles**

Append this block near the existing `.remix-mask-preview` and `.remix-mask-editor` styles in `public/styles.css`:

```css
.remix-prototype-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin: 10px 0;
}

.remix-prototype-source-list,
.remix-prototype-task-list,
.remix-prototype-output-grid,
.remix-prototype-capability-grid {
  display: grid;
  gap: 10px;
}

.remix-prototype-source-card,
.remix-prototype-task,
.remix-prototype-output,
.remix-prototype-capability {
  border: 1px solid rgba(148, 163, 184, 0.24);
  border-radius: 8px;
  background: rgba(15, 23, 42, 0.72);
  padding: 10px;
}

.remix-prototype-source-card {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 6px 8px;
}

.remix-prototype-source-card.active {
  border-color: rgba(96, 165, 250, 0.78);
  box-shadow: 0 0 0 1px rgba(96, 165, 250, 0.22);
}

.remix-prototype-source-card > small,
.remix-prototype-capability small,
.remix-prototype-task small,
.remix-prototype-output small {
  color: #94a3b8;
  font-size: 12px;
}

.remix-prototype-source-meta,
.remix-prototype-task-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  grid-column: 1 / -1;
}

.remix-prototype-capability-grid {
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
}

.remix-prototype-task {
  display: grid;
  gap: 8px;
}

.remix-prototype-task.failed {
  border-color: rgba(248, 113, 113, 0.68);
}

.remix-prototype-task p {
  margin: 0;
  color: #fecaca;
  font-size: 12px;
}

.remix-prototype-output-grid {
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
}

.remix-prototype-output {
  display: grid;
  gap: 8px;
}

@media (max-width: 760px) {
  .remix-prototype-source-card {
    grid-template-columns: minmax(0, 1fr);
  }

  .remix-prototype-toolbar > button,
  .remix-prototype-toolbar > label {
    width: 100%;
  }
}
```

- [ ] **Step 2: Run targeted static test and verify it passes**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: PASS for all tests in `frontend-static.test.mjs`.

- [ ] **Step 3: Commit styles**

Run:

```bash
git add public/styles.css
git commit -m "style: add competitor remix prototype states"
```

## Task 8: Run Full Tests And Browser Verification

**Files:**
- No code files unless failures require fixes.

- [ ] **Step 1: Run full test suite**

Run:

```bash
npm test
```

Expected: PASS. If unrelated environment tests fail, record the failing test names and exact errors in the final handoff.

- [ ] **Step 2: Start local server**

Run:

```bash
node server.mjs
```

Expected: server prints its listening URL. Keep the session running until browser verification is complete.

- [ ] **Step 3: Open desktop viewport**

Use browser automation to open:

```text
http://127.0.0.1:5177/competitor-remix.html
```

If port `5177` is busy or the server prints another port, use that printed URL.

Expected desktop checks:

- Source list shows at least three mock source cards after load or after pressing "载入示例素材".
- Only one active source drives the editor.
- "应用当前区域到选中素材" marks copied sources as "需复核".
- "生成草稿任务" creates task cards.
- "模拟提交队列" changes draft tasks to queued.
- "模拟推进" reaches review_required, succeeded, and one failed mock case.
- Gallery mock output appears after a task succeeds.
- Existing login modal or auth flow does not block static prototype rendering.

- [ ] **Step 4: Open mobile viewport**

Use browser automation with a narrow viewport around `390x844`.

Expected mobile checks:

- Source cards do not overlap.
- Editor controls wrap rather than overflowing.
- Task action buttons stay within their cards.
- Gallery cards stack cleanly.

- [ ] **Step 5: Stop local server**

Stop the `node server.mjs` session with `Ctrl-C`.

Expected: no needed command sessions remain running.

- [ ] **Step 6: Final commit for verification fixes if needed**

If browser or test verification required fixes, commit them:

```bash
git add public/competitor-remix.html public/competitor-remix.js public/styles.css tests/wangzhuan/frontend-static.test.mjs
git commit -m "fix: polish competitor remix prototype verification"
```

If no fixes were needed, do not create an empty commit.

## Self-Review

Spec coverage:

- 多条源素材卡片：Task 2 and Task 3.
- 单素材可视化 UI：Task 2, Task 4, existing mask editor reuse.
- 区域复制和复核队列：Task 4.
- mock 异步任务队列：Task 5 and Task 6.
- 批次交付与图库占位：Task 5.
- 不调用真实后端：Task 6 redirects prototype controls and leaves real APIs unused by prototype actions.
- 响应式验证：Task 7 and Task 8.

Placeholder scan:

- No placeholder markers are used.
- All code-editing steps include exact snippets.
- All verification steps include exact commands and expected results.

Type consistency:

- Prototype state lives under `state.prototype`.
- Source IDs use `sourceId`.
- Task IDs use `taskId`.
- Region arrays use existing `regionId`, `label`, and `bbox` shape so the current mask editor remains compatible.
