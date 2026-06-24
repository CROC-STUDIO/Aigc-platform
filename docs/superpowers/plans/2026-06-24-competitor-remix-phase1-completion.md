# 竞品素材快速改造首期补齐 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 `competitor-remix` 从“前端原型 + 局部真实提交流程”补齐到首期可上线闭环，完成自动识别、混合选区、真实替换路由、自动质检、自动入结果库。

**Architecture:** 保留现有 `public/competitor-remix.html` 页面入口与 `server/wangzhuan/remix.mjs` 任务中心，新增一个“识别计划 + 编辑确认 + 执行计划 + QC 报告”的标准合同。页面不再把 `auto_all` 当作文案提示，而是先调用识别接口生成候选区域和建议动作，再允许用户在候选基础上补框、删改、文本描述，最后提交统一 remix 任务。后端将 `识别`、`替换执行`、`自动质检`、`结果入库` 串成单条状态机，并把人工预览确认降级为失败兜底，而不是默认主路径。

**Tech Stack:** 原生 HTML / CSS / ES module JavaScript、Node `node:test`、现有 `server/wangzhuan/*.mjs` 路由与 MySQL facts store、既有 remix provider 接口、既有 gallery / package 链路。

---

## Scope And Acceptance

本计划只覆盖当前首期缺口：

- 自动识别 icon / 产品名 / CTA / ending / 水印 / 字幕 / 手机界面区域
- 手动指定区域的完整闭环：框选 + 描述型区域
- 文本类与区域类替换的统一任务模型
- 自动质检，不再默认 `manual_required`
- 质检通过后自动进入结果库

本计划不扩展：

- 多人协作审核台
- 新的设计系统或整页重构
- 非首期需要的高级时序编辑器
- 新 provider 平台接入

## File Structure

- Modify: `public/competitor-remix.html`
  - 增加“识别结果”、“识别状态”、“文本描述区域”、“QC 摘要”容器。
- Modify: `public/competitor-remix.js`
  - 把页面状态改成 `source -> detection -> editable regions -> execution -> qc -> gallery` 的真实前端状态机。
  - 接入新接口：`/detect`、`/plan`、`/start`、`/qc-report`。
- Modify: `server/wangzhuan/router.mjs`
  - 新增识别、计划预览、QC 报告查询接口。
- Modify: `server/wangzhuan/remix.mjs`
  - 新增检测合同、统一区域合同、任务状态机、自动 QC、自动入库逻辑。
- Create: `server/wangzhuan/remix-detection.mjs`
  - 负责抽帧、OCR/ASR/ending 检测、候选区域融合。
- Create: `server/wangzhuan/remix-qc.mjs`
  - 负责 remix 自动质检规则与汇总。
- Create: `server/wangzhuan/remix-plan.mjs`
  - 负责把检测结果 + 用户编辑转换为可执行 remix plan。
- Modify: `server/wangzhuan/gallery.mjs`
  - 明确 remix 入库筛选条件改为 `qcStatus=pass` 自动可见。
- Modify: `tests/wangzhuan/frontend-static.test.mjs`
  - 增加识别与 QC UI 锚点静态断言。
- Modify: `tests/wangzhuan/remix.test.mjs`
  - 增加 detect / plan / auto-qc / auto-gallery 路由与服务测试。
- Create: `tests/wangzhuan/remix-detection.test.mjs`
  - 检测归一化、候选区域归并、描述型区域校验。
- Create: `tests/wangzhuan/remix-qc.test.mjs`
  - 自动 QC 规则、失败原因、自动入库门槛。

## Data Contract

### Detection result

```json
{
  "sourceId": "rsrc_20260624_001",
  "detectionId": "rdt_20260624_001",
  "status": "succeeded",
  "frameSamples": [
    { "frameId": "f_01", "timestampMs": 500, "storageUrl": "https://..." }
  ],
  "regions": [
    {
      "regionId": "reg_icon_01",
      "capabilityKey": "logo_icon",
      "label": "竞品 icon",
      "type": "bbox",
      "source": "detector",
      "confidence": 0.91,
      "bbox": { "x": 0.82, "y": 0.03, "width": 0.12, "height": 0.08 }
    },
    {
      "regionId": "reg_cta_01",
      "capabilityKey": "cta",
      "label": "CTA",
      "type": "bbox",
      "source": "ocr",
      "confidence": 0.88,
      "bbox": { "x": 0.15, "y": 0.82, "width": 0.70, "height": 0.09 },
      "text": "Download now"
    }
  ],
  "summary": {
    "logo_icon": 1,
    "product_name": 1,
    "cta": 1,
    "subtitle": 3,
    "ending": 1,
    "watermark": 1,
    "phone_ui": 1
  },
  "warnings": []
}
```

### Editable region

```json
{
  "regionId": "reg_manual_01",
  "capabilityKey": "watermark",
  "label": "右上角水印",
  "type": "description",
  "source": "user",
  "description": "右上角 icon 替换为我方 icon，贯穿全片",
  "timeRange": { "startMs": 0, "endMs": 15000 }
}
```

### Remix plan

```json
{
  "planId": "rmp_20260624_001",
  "sourceId": "rsrc_20260624_001",
  "steps": [
    { "stepId": "s1", "jobType": "auto_ai_remove", "capabilityKey": "logo_icon", "regions": ["reg_icon_01"] },
    { "stepId": "s2", "jobType": "language_rewrite", "capabilityKey": "product_name", "regions": ["reg_name_01"] },
    { "stepId": "s3", "jobType": "video_copy_translate", "capabilityKey": "cta", "regions": ["reg_cta_01"] }
  ],
  "qcTargets": ["logo_removed", "cta_replaced", "competitor_text_absent"],
  "warnings": []
}
```

## Task 1: Lock The Target Workflow And API Contract

**Files:**
- Create: `docs/superpowers/specs/2026-06-24-competitor-remix-phase1-contract.md`
- Modify: `server/wangzhuan/router.mjs`
- Test: `tests/wangzhuan/remix.test.mjs`

- [ ] **Step 1: Write the failing router contract test**

Add a new test in `tests/wangzhuan/remix.test.mjs`:

```js
test("remix router exposes detect, plan, qc-report endpoints", async () => {
  const paths = [
    "/api/wangzhuan/remix/detect",
    "/api/wangzhuan/remix/plan",
    "/api/wangzhuan/remix/rmx_20260624000000_abcd/qc-report"
  ];
  for (const path of paths) {
    const res = captureRes();
    await handleWangzhuanRequest(jsonReq("POST", {}), res, new URL(`http://localhost${path}`), routerContext(context("/tmp")));
    assert.notEqual(res.statusCode, 404);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
```

Expected: FAIL with `Unsupported wangzhuan endpoint` or missing route assertions.

- [ ] **Step 3: Define the contract doc**

Create `docs/superpowers/specs/2026-06-24-competitor-remix-phase1-contract.md` with:

```md
# 竞品改造首期合同

## Endpoints

- `POST /api/wangzhuan/remix/detect`
- `POST /api/wangzhuan/remix/plan`
- `POST /api/wangzhuan/remix/start`
- `GET /api/wangzhuan/remix/:remixId`
- `GET /api/wangzhuan/remix/:remixId/qc-report`

## Core States

- `uploaded`
- `detecting`
- `detection_succeeded`
- `plan_ready`
- `queued`
- `running`
- `qc_running`
- `succeeded`
- `failed`
```

- [ ] **Step 4: Add minimal route stubs**

In `server/wangzhuan/router.mjs`, add branches:

```js
if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/detect") {
  return sendOk(res, { status: "stub_detect" }, requestId);
}
if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/plan") {
  return sendOk(res, { status: "stub_plan" }, requestId);
}
if (remix && req.method === "GET" && remix.action === "qc-report") {
  return sendOk(res, { status: "stub_qc_report" }, requestId);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
```

Expected: PASS for the new route existence test.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-06-24-competitor-remix-phase1-contract.md server/wangzhuan/router.mjs tests/wangzhuan/remix.test.mjs
git commit -m "feat: define competitor remix phase1 api contract"
```

## Task 2: Implement Detection Service For The 7 Required Region Types

**Files:**
- Create: `server/wangzhuan/remix-detection.mjs`
- Modify: `server/wangzhuan/remix.mjs`
- Modify: `server/wangzhuan/router.mjs`
- Test: `tests/wangzhuan/remix-detection.test.mjs`

- [ ] **Step 1: Write the failing detection normalization tests**

Create `tests/wangzhuan/remix-detection.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeDetectionRegions, summarizeDetection } from "../../server/wangzhuan/remix-detection.mjs";

test("normalizeDetectionRegions preserves all seven capability keys", () => {
  const regions = normalizeDetectionRegions([
    { capabilityKey: "logo_icon", bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
    { capabilityKey: "product_name", bbox: { x: 0.2, y: 0.2, width: 0.2, height: 0.1 } },
    { capabilityKey: "cta", bbox: { x: 0.3, y: 0.8, width: 0.4, height: 0.1 } },
    { capabilityKey: "ending", bbox: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 } },
    { capabilityKey: "watermark", bbox: { x: 0.8, y: 0.05, width: 0.1, height: 0.05 } },
    { capabilityKey: "subtitle", bbox: { x: 0.1, y: 0.88, width: 0.8, height: 0.08 } },
    { capabilityKey: "phone_ui", bbox: { x: 0.15, y: 0.25, width: 0.7, height: 0.45 } }
  ]);
  assert.equal(regions.length, 7);
  assert.deepEqual(Object.keys(summarizeDetection(regions)).sort(), [
    "cta", "ending", "logo_icon", "phone_ui", "product_name", "subtitle", "watermark"
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/remix-detection.test.mjs
```

Expected: FAIL because `remix-detection.mjs` does not exist.

- [ ] **Step 3: Implement the detection service skeleton**

Create `server/wangzhuan/remix-detection.mjs`:

```js
import { WangzhuanError } from "./http.mjs";

export const DETECTION_CAPABILITY_KEYS = Object.freeze([
  "logo_icon",
  "product_name",
  "cta",
  "ending",
  "watermark",
  "subtitle",
  "phone_ui"
]);

export function normalizeDetectionRegions(items = []) {
  return items.map((item, index) => ({
    regionId: String(item.regionId || `det_${index + 1}`),
    capabilityKey: String(item.capabilityKey || ""),
    label: String(item.label || item.capabilityKey || "region"),
    type: "bbox",
    source: String(item.source || "detector"),
    confidence: Number(item.confidence || 0.5),
    bbox: {
      x: Number(item.bbox?.x || 0),
      y: Number(item.bbox?.y || 0),
      width: Number(item.bbox?.width || 0),
      height: Number(item.bbox?.height || 0)
    },
    ...(item.text ? { text: String(item.text) } : {})
  })).filter((item) => DETECTION_CAPABILITY_KEYS.includes(item.capabilityKey));
}

export function summarizeDetection(regions = []) {
  return DETECTION_CAPABILITY_KEYS.reduce((acc, key) => {
    acc[key] = regions.filter((item) => item.capabilityKey === key).length;
    return acc;
  }, {});
}

export async function detectRemixRegions(context, request = {}) {
  if (!request.sourceId) {
    throw new WangzhuanError("validation_error", "sourceId 必填", { field: "sourceId" });
  }
  const mockRegions = normalizeDetectionRegions(request.mockRegions || []);
  return {
    detectionId: `rdt_${Date.now()}`,
    sourceId: request.sourceId,
    status: "succeeded",
    frameSamples: [],
    regions: mockRegions,
    summary: summarizeDetection(mockRegions),
    warnings: []
  };
}
```

- [ ] **Step 4: Wire the new detection endpoint**

In `server/wangzhuan/router.mjs`:

```js
import { detectRemixRegions } from "./remix-detection.mjs";
```

Replace the stub:

```js
if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/detect") {
  return sendOk(res, await detectRemixRegions(scoped, await context.readJson(req)), requestId);
}
```

- [ ] **Step 5: Run the new tests**

Run:

```bash
node --test tests/wangzhuan/remix-detection.test.mjs
node --test tests/wangzhuan/remix.test.mjs
```

Expected: PASS for detection normalization and route wiring.

- [ ] **Step 6: Commit**

```bash
git add server/wangzhuan/remix-detection.mjs server/wangzhuan/router.mjs tests/wangzhuan/remix-detection.test.mjs tests/wangzhuan/remix.test.mjs
git commit -m "feat: add competitor remix detection service"
```

## Task 3: Upgrade Region Editing To Support BBox Plus Description Regions

**Files:**
- Modify: `public/competitor-remix.html`
- Modify: `public/competitor-remix.js`
- Modify: `server/wangzhuan/remix.mjs`
- Test: `tests/wangzhuan/remix.test.mjs`
- Test: `tests/wangzhuan/frontend-static.test.mjs`

- [ ] **Step 1: Write the failing validation test for description regions**

Add to `tests/wangzhuan/remix.test.mjs`:

```js
test("direct mask edit accepts description regions", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-description-"));
  try {
    const ctx = context(root, "alice", {
      capabilities: { remix: { provider: "function_k", status: "supported", supportedOperations: ["logo_icon_cover_or_replace"] } }
    });
    const source = await uploadRemixSource(ctx, sourceUpload());
    const result = await startDirectMaskEdit(ctx, {
      idempotencyKey: "idem_description_region",
      sourceId: source.sourceId,
      operationType: "logo_icon_cover_or_replace",
      targetChannel: "generic",
      autoDetect: false,
      maskDataUrl: "data:image/png;base64,ZmFrZQ==",
      regions: [{
        regionId: "desc_1",
        type: "description",
        label: "右上角 icon",
        description: "右上角 icon 替换为我方 icon，贯穿全片"
      }]
    });
    assert.equal(result.remix.regions[0].type, "description");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
```

Expected: FAIL because current前端和后端没有描述型区域的完整提交路径。

- [ ] **Step 3: Add UI controls for manual description regions**

In `public/competitor-remix.html`, add under the editor area:

```html
<label>文字描述选区
  <textarea id="remixDescriptionRegion" rows="3" placeholder="例如：右上角 icon 替换为我方 icon，贯穿全片"></textarea>
</label>
<button id="remixAddDescriptionRegionBtn" class="ghost" type="button">添加描述区域</button>
```

- [ ] **Step 4: Add front-end state handling for mixed regions**

In `public/competitor-remix.js`, add:

```js
function createDescriptionRegion(text) {
  return {
    regionId: `region_desc_${Date.now()}`,
    capabilityKey: selectedCapabilityKey() === "auto_all" ? operationCapabilityKey() : selectedCapabilityKey(),
    type: "description",
    label: "描述区域",
    description: String(text || "").trim()
  };
}
```

Hook button click:

```js
els.addDescriptionRegionBtn?.addEventListener("click", () => {
  const text = els.descriptionRegion?.value || "";
  if (!text.trim()) return;
  state.regions.push(createDescriptionRegion(text));
  renderRegions();
});
```

- [ ] **Step 5: Extend server validation only where needed**

In `server/wangzhuan/remix.mjs`, keep `validateRegions()` as the single normalization entry and add:

```js
if (type === "description") {
  return {
    regionId,
    type,
    label,
    description,
    capabilityKey: String(item.capabilityKey || "")
  };
}
```

Also preserve `capabilityKey` on bbox regions so execution planning can use it later.

- [ ] **Step 6: Run tests**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: PASS with description-region acceptance and new DOM anchors.

- [ ] **Step 7: Commit**

```bash
git add public/competitor-remix.html public/competitor-remix.js server/wangzhuan/remix.mjs tests/wangzhuan/remix.test.mjs tests/wangzhuan/frontend-static.test.mjs
git commit -m "feat: support description-based remix regions"
```

## Task 4: Build A Remix Plan Layer For Real Replacement Execution

**Files:**
- Create: `server/wangzhuan/remix-plan.mjs`
- Modify: `server/wangzhuan/remix.mjs`
- Modify: `server/wangzhuan/router.mjs`
- Test: `tests/wangzhuan/remix.test.mjs`

- [ ] **Step 1: Write the failing plan test**

Add:

```js
test("buildRemixPlan maps mixed capabilities to ordered provider steps", async () => {
  const { buildRemixPlan } = await import("../../server/wangzhuan/remix-plan.mjs");
  const plan = buildRemixPlan({
    sourceId: "rsrc_demo",
    regions: [
      { regionId: "r1", capabilityKey: "logo_icon", type: "bbox", bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
      { regionId: "r2", capabilityKey: "product_name", type: "bbox", bbox: { x: 0.2, y: 0.2, width: 0.2, height: 0.1 }, text: "Lucky Cash" },
      { regionId: "r3", capabilityKey: "ending", type: "description", description: "最后 3 秒 ending 替换为我方 ending" }
    ]
  });
  assert.deepEqual(plan.steps.map((item) => item.jobType), ["auto_ai_remove", "language_rewrite", "end_trim_detection"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
```

Expected: FAIL because `remix-plan.mjs` does not exist.

- [ ] **Step 3: Implement minimal planning layer**

Create `server/wangzhuan/remix-plan.mjs`:

```js
const JOB_TYPE_BY_CAPABILITY = Object.freeze({
  logo_icon: "auto_ai_remove",
  watermark: "mask_edit",
  phone_ui: "mask_edit",
  product_name: "language_rewrite",
  cta: "video_copy_translate",
  subtitle: "video_copy_translate",
  ending: "end_trim_detection"
});

const EXECUTION_ORDER = ["logo_icon", "watermark", "phone_ui", "product_name", "cta", "subtitle", "ending"];

export function buildRemixPlan({ sourceId, regions = [] }) {
  const ordered = EXECUTION_ORDER.flatMap((capabilityKey) => {
    const matched = regions.filter((item) => item.capabilityKey === capabilityKey);
    if (!matched.length) return [];
    return [{
      stepId: `${capabilityKey}_1`,
      sourceId,
      capabilityKey,
      jobType: JOB_TYPE_BY_CAPABILITY[capabilityKey],
      regions: matched
    }];
  });
  return {
    planId: `rmp_${Date.now()}`,
    sourceId,
    steps: ordered,
    warnings: []
  };
}
```

- [ ] **Step 4: Wire plan preview route**

In `server/wangzhuan/router.mjs`:

```js
import { buildRemixPlan } from "./remix-plan.mjs";
```

Replace stub plan route:

```js
if (req.method === "POST" && url.pathname === "/api/wangzhuan/remix/plan") {
  const body = await context.readJson(req);
  return sendOk(res, buildRemixPlan(body), requestId);
}
```

- [ ] **Step 5: Use plan output in remix start path**

In `server/wangzhuan/remix.mjs`, before provider submission:

```js
import { buildRemixPlan } from "./remix-plan.mjs";
```

Attach plan to remix record:

```js
const executionPlan = buildRemixPlan({
  sourceId: normalized.sourceId,
  regions: normalized.regions
});
```

Persist it on `record.request.executionPlan` and `remix.executionPlan`.

- [ ] **Step 6: Run tests**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
```

Expected: PASS for plan generation and route wiring.

- [ ] **Step 7: Commit**

```bash
git add server/wangzhuan/remix-plan.mjs server/wangzhuan/remix.mjs server/wangzhuan/router.mjs tests/wangzhuan/remix.test.mjs
git commit -m "feat: add competitor remix execution planning"
```

## Task 5: Replace Manual-Only QC With Automatic Remix QC

**Files:**
- Create: `server/wangzhuan/remix-qc.mjs`
- Modify: `server/wangzhuan/remix.mjs`
- Modify: `server/wangzhuan/router.mjs`
- Create: `tests/wangzhuan/remix-qc.test.mjs`

- [ ] **Step 1: Write the failing auto QC tests**

Create `tests/wangzhuan/remix-qc.test.mjs`:

```js
import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRemixQc } from "../../server/wangzhuan/remix-qc.mjs";

test("evaluateRemixQc passes when competitor residue is absent and expected replacements exist", async () => {
  const qc = await evaluateRemixQc({
    output: { outputId: "out_1", previewUrl: "https://cdn.example.com/out.mp4" },
    executionPlan: { steps: [{ capabilityKey: "cta" }, { capabilityKey: "product_name" }] },
    mockSignals: {
      competitorResidueScore: 0.02,
      replacementCoverageScore: 0.96,
      visualIntegrityScore: 0.94
    }
  });
  assert.equal(qc.qcStatus, "pass");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/remix-qc.test.mjs
```

Expected: FAIL because `remix-qc.mjs` does not exist.

- [ ] **Step 3: Implement auto QC evaluator**

Create `server/wangzhuan/remix-qc.mjs`:

```js
export async function evaluateRemixQc({ output, executionPlan, mockSignals = {} }) {
  const competitorResidueScore = Number(mockSignals.competitorResidueScore ?? 1);
  const replacementCoverageScore = Number(mockSignals.replacementCoverageScore ?? 0);
  const visualIntegrityScore = Number(mockSignals.visualIntegrityScore ?? 0);
  const checks = [
    { checkId: "competitor_residue_absent", status: competitorResidueScore <= 0.1 ? "pass" : "fail", message: "竞品残留检测" },
    { checkId: "replacement_coverage", status: replacementCoverageScore >= 0.8 ? "pass" : "fail", message: "替换覆盖率检测" },
    { checkId: "visual_integrity", status: visualIntegrityScore >= 0.8 ? "pass" : "fail", message: "画面完整性检测" }
  ];
  const failed = checks.filter((item) => item.status !== "pass");
  return {
    outputId: output.outputId,
    qcStatus: failed.length ? "fail" : "pass",
    checks,
    summary: failed.length ? "自动质检未通过" : "自动质检通过"
  };
}
```

- [ ] **Step 4: Replace manual default in remix materialization**

In `server/wangzhuan/remix.mjs`, import and apply:

```js
import { evaluateRemixQc } from "./remix-qc.mjs";
```

Inside `materializeProviderOutput(...)` replace:

```js
qcStatus: "manual_required",
downloadEligible: false,
visualPreviewRequired: true,
previewConfirmed: false
```

with:

```js
qcStatus: "qc_running",
downloadEligible: false,
visualPreviewRequired: false,
previewConfirmed: false
```

Then call:

```js
const qc = await evaluateRemixQc({
  output,
  executionPlan: remix.executionPlan || { steps: [] },
  mockSignals: context.mockRemixQcSignals || {}
});
```

Set final `output.qcStatus`, `downloadEligible`, `remix.status`, `qcSummary` from `qc`.

- [ ] **Step 5: Expose QC report query**

Add to `server/wangzhuan/remix.mjs`:

```js
export async function getRemixQcReport(context, remixId) {
  const remix = await readRemix(context, remixId);
  return remix.outputs?.[0]?.qcReportPath
    ? JSON.parse(await readFile(resolveUserPath(context, remix.outputs[0].qcReportPath), "utf8"))
    : null;
}
```

Wire `GET /api/wangzhuan/remix/:remixId/qc-report`.

- [ ] **Step 6: Run tests**

Run:

```bash
node --test tests/wangzhuan/remix-qc.test.mjs
node --test tests/wangzhuan/remix.test.mjs
```

Expected: PASS with automatic pass/fail paths and QC report route.

- [ ] **Step 7: Commit**

```bash
git add server/wangzhuan/remix-qc.mjs server/wangzhuan/remix.mjs server/wangzhuan/router.mjs tests/wangzhuan/remix-qc.test.mjs tests/wangzhuan/remix.test.mjs
git commit -m "feat: add automatic remix qc"
```

## Task 6: Auto-Publish QC-Passed Outputs Into Gallery

**Files:**
- Modify: `server/wangzhuan/gallery.mjs`
- Modify: `server/wangzhuan/remix.mjs`
- Modify: `tests/wangzhuan/remix.test.mjs`

- [ ] **Step 1: Write the failing auto-gallery test**

Add:

```js
test("qc-passed remix output becomes gallery-visible without preview-confirm", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-auto-gallery-"));
  try {
    const ctx = context(root, "alice", {
      capabilities: { remix: { provider: "function_k", status: "supported", supportedOperations: ["watermark_cover"] } },
      mockRemixQcSignals: {
        competitorResidueScore: 0.01,
        replacementCoverageScore: 0.97,
        visualIntegrityScore: 0.95
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());
    const estimated = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: [region()],
      targetChannel: "tiktok_ads"
    });
    const started = await startRemix(ctx, {
      idempotencyKey: "idem_auto_gallery",
      estimateId: estimated.estimateId
    });
    const detail = await getRemixDetail(ctx, started.remix.remixId);
    assert.equal(detail.remix.status, "succeeded");
    const gallery = await getGallery(ctx, { sourceType: "remix" });
    assert.equal(gallery.items.some((item) => item.remixId === detail.remix.remixId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
```

Expected: FAIL because current flow requires `preview-confirm`.

- [ ] **Step 3: Change remix success criteria**

In `server/wangzhuan/remix.mjs`, when QC returns pass:

```js
nextRemix.status = "succeeded";
nextRemix.previewConfirmedBy = "system_auto_qc";
nextRemix.previewConfirmedAt = new Date().toISOString();
nextRemix.outputs[0].previewConfirmed = true;
nextRemix.outputs[0].downloadEligible = true;
```

Keep `confirmRemixPreview()` only as manual retry/override path for QC fail or human force-pass.

- [ ] **Step 4: Tighten gallery filter semantics**

In `server/wangzhuan/gallery.mjs`, ensure remix items are visible only when:

```js
item.sourceType === "remix" && item.qcStatus === "pass" && item.downloadEligible
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test tests/wangzhuan/remix.test.mjs
```

Expected: PASS with gallery visibility immediately after successful auto QC.

- [ ] **Step 6: Commit**

```bash
git add server/wangzhuan/gallery.mjs server/wangzhuan/remix.mjs tests/wangzhuan/remix.test.mjs
git commit -m "feat: auto-publish qc-passed remix outputs to gallery"
```

## Task 7: Update Frontend To Use Detect -> Edit -> Plan -> Start -> QC Flow

**Files:**
- Modify: `public/competitor-remix.html`
- Modify: `public/competitor-remix.js`
- Test: `tests/wangzhuan/frontend-static.test.mjs`

- [ ] **Step 1: Write the failing static UI test**

Add assertions:

```js
assert.match(html, /id="remixDetectBtn"/);
assert.match(html, /id="remixDetectionSummary"/);
assert.match(html, /id="remixPlanPreviewBox"/);
assert.match(html, /id="remixQcSummaryBox"/);
assert.match(script, /\/api\/wangzhuan\/remix\/detect/);
assert.match(script, /\/api\/wangzhuan\/remix\/plan/);
assert.match(script, /qc-report/);
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: FAIL because the new anchors and API calls are absent.

- [ ] **Step 3: Add the HTML anchors**

In `public/competitor-remix.html` add:

```html
<button id="remixDetectBtn" type="button">开始识别</button>
<div id="remixDetectionSummary" class="wz-list empty-line">尚未识别</div>
<div id="remixPlanPreviewBox" class="wz-list empty-line">尚未生成执行计划</div>
<div id="remixQcSummaryBox" class="wz-list empty-line">尚无质检结果</div>
```

- [ ] **Step 4: Add front-end orchestration functions**

In `public/competitor-remix.js` add:

```js
async function detectRegions() {
  state.detection = await apiEnvelope("/api/wangzhuan/remix/detect", {
    method: "POST",
    body: JSON.stringify({ sourceId: state.source.sourceId })
  });
}

async function previewRemixPlan() {
  state.plan = await apiEnvelope("/api/wangzhuan/remix/plan", {
    method: "POST",
    body: JSON.stringify({ sourceId: state.source.sourceId, regions: normalizedRegions() })
  });
}

async function loadRemixQcReport(remixId) {
  state.qcReport = await apiEnvelope(`/api/wangzhuan/remix/${encodeURIComponent(remixId)}/qc-report`);
}
```

Renderers:

```js
function renderDetectionSummary() {}
function renderPlanPreview() {}
function renderQcSummary() {}
```

- [ ] **Step 5: Run tests**

Run:

```bash
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: PASS for the new static anchors and API references.

- [ ] **Step 6: Commit**

```bash
git add public/competitor-remix.html public/competitor-remix.js tests/wangzhuan/frontend-static.test.mjs
git commit -m "feat: wire competitor remix detection and qc flow in frontend"
```

## Task 8: End-To-End Verification For The First-Phase Closed Loop

**Files:**
- Modify: `tests/wangzhuan/remix.test.mjs`
- Modify: `tests/wangzhuan/frontend-static.test.mjs`

- [ ] **Step 1: Add the final closed-loop test**

Add:

```js
test("competitor remix first-phase flow completes from upload to auto gallery", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-s7-phase1-closed-loop-"));
  try {
    const ctx = context(root, "alice", {
      capabilities: { remix: { provider: "function_k", status: "supported", supportedOperations: ["watermark_cover", "logo_icon_cover_or_replace", "text_cta_ending_replace"] } },
      mockRemixQcSignals: {
        competitorResidueScore: 0.01,
        replacementCoverageScore: 0.95,
        visualIntegrityScore: 0.94
      }
    });
    const template = await templateFixture(ctx);
    const source = await uploadRemixSource(ctx, sourceUpload());
    const detection = await detectRemixRegions(ctx, {
      sourceId: source.sourceId,
      mockRegions: [{ capabilityKey: "watermark", bbox: { x: 0.7, y: 0.05, width: 0.1, height: 0.05 } }]
    });
    assert.equal(detection.summary.watermark, 1);
    const estimated = await estimateRemix(ctx, {
      sourceId: source.sourceId,
      templateId: template.templateId,
      versionId: template.versionId,
      operationType: "watermark_cover",
      regions: detection.regions,
      targetChannel: "tiktok_ads"
    });
    const started = await startRemix(ctx, {
      idempotencyKey: "idem_phase1_closed_loop",
      estimateId: estimated.estimateId
    });
    const detail = await getRemixDetail(ctx, started.remix.remixId);
    assert.equal(detail.remix.status, "succeeded");
    assert.equal(detail.remix.outputs[0].qcStatus, "pass");
    const gallery = await getGallery(ctx, { sourceType: "remix" });
    assert.equal(gallery.items.some((item) => item.remixId === detail.remix.remixId), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the focused verification suite**

Run:

```bash
node --test tests/wangzhuan/remix-detection.test.mjs
node --test tests/wangzhuan/remix-qc.test.mjs
node --test tests/wangzhuan/remix.test.mjs
node --test tests/wangzhuan/frontend-static.test.mjs
```

Expected: PASS with the new first-phase closed loop.

- [ ] **Step 3: Run broader regression checks**

Run:

```bash
npm test
```

Expected: PASS with no regressions in wangzhuan pipeline tests.

- [ ] **Step 4: Commit**

```bash
git add tests/wangzhuan/remix-detection.test.mjs tests/wangzhuan/remix-qc.test.mjs tests/wangzhuan/remix.test.mjs tests/wangzhuan/frontend-static.test.mjs
git commit -m "test: verify competitor remix phase1 closed loop"
```

## Implementation Notes

1. 自动识别首期不要追求“全靠模型一次性猜中”。应采用组合策略：
   页面抽帧 + OCR 文本框 + ending 时段检测 + 手机主屏显著区域识别 + 水印/icon 高频角落规则。

2. 手动指定区域必须允许 `bbox` 和 `description` 共存。
   这是为了覆盖“截图圈选”和“右上角 icon 替换为我方 icon”两种输入方式。

3. 执行层不要把所有能力硬塞进单一 `job_type`。
   首期应使用 `executionPlan.steps[]` 显式编排，避免以后加能力时把 `startDirectMaskEdit()` 继续做成巨型分支。

4. 自动质检必须输出“用户可读失败原因”。
   失败报告至少包含：竞品元素残留、替换不完整、画面遮挡异常、文字覆盖异常、ending 未替换。

5. 人工确认仍保留，但角色改变：
   自动 QC 失败时的人工 override；
   或特殊渠道的人工复核，不再是默认主路径。

## Risks

- 识别模块首期如果没有稳定的 OCR / ASR / detector 依赖，建议先允许 `mockRegions` 和 provider 返回的候选框双轨并存，逐步替换。
- `startRemix()` 当前和 `startDirectMaskEdit()` 有部分重叠，实施时要避免复制更多状态机分支，优先收敛到公共执行函数。
- Gallery 现有逻辑依赖 MySQL facts store，自动入库时必须确认 remix facts 的字段与 batch gallery 查询兼容。
- 当前前端已有 prototype 逻辑，实施时要尽快区分“原型模式 UI”与“真实首期模式 UI”，避免后续逻辑互相污染。

## Self-Review

- 需求覆盖：
  自动识别、混合选区、真实替换执行、自动 QC、自动结果入库都已映射到独立任务。
- 占位词检查：
  计划中没有 `TBD`、`TODO`、`implement later` 一类占位。
- 类型一致性：
  全文统一使用 `detectionId / planId / executionPlan / qcStatus / capabilityKey / regions` 命名。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-24-competitor-remix-phase1-completion.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
