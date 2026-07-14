# Wangzhuan Batch Post-processing Design

## Capability

网赚素材操作员在确认生成批次前，可以配置一个独立的可选后处理 Ending，并选择零个或多个扩展尺寸。Seedance 的 CTA 图和 Ending 图仍然只服务于最后一个 Seedance 分片的提示词与参考素材，不再由 Stitch 转成固定尾片。生成完成后，系统保留原始尺寸成片，并自动生成用户选择的额外尺寸版本。

本设计覆盖 `docs/superpowers/specs/2026-07-06-task-output-video-size-expansion-design.md` 中“尺寸扩展仅属于任务管理页派生动作”的边界。任务管理继续展示历史扩展结果，但新批次的尺寸选择和自动执行入口迁移到生成批次。

## Fixed Product Rules

- `ctaAsset` 和 `endingAsset` 是分支级 Seedance 图片参考素材。
- CTA/Ending 图片只提交给同一分支、同一变体的最后一个 Seedance 分片。
- 最后一个分片的提示词必须明确 CTA/Ending 位于该视频分片末尾。
- Stitch 不得再把 `ctaAsset` 或 `endingAsset` 转成固定 2 秒尾片。
- 后处理 Ending 是独立的批次级素材，不进入 Seedance 提示词、参考素材审核或媒体槽位。
- 后处理 Ending 可不上传；支持 PNG/JPEG/WebP 图片和 MP4/WebM/MOV 视频。
- 后处理 Ending 为图片时，默认展示 1 秒。
- 后处理 Ending 为视频时，保留源视频有效时长，并规范化为主成片可拼接的音视频规格。
- 免责声明必须覆盖 Seedance 主体视频和追加的后处理 Ending。
- 原始拼接尺寸成片必须始终保留。
- 扩展尺寸为空时，不运行尺寸扩展。
- 扩展尺寸支持预设多选和自定义尺寸；自定义尺寸加入选择列表后可以继续添加其他尺寸。
- 尺寸扩展固定使用 `blur_pad`：前景等比缩放，空白区域使用高斯模糊背景填充。

## User Surface

### Seedance reference assets

第 2 步素材区域保留 CTA 图和 Ending 图，但文案改为：

- `CTA 图（仅用于最后一个 Seedance 分片）`
- `Ending 图（仅用于最后一个 Seedance 分片）`

这两个控件继续只接受图片，不显示“拼接到末尾”描述。

### Generation batch post-processing

在 v2 页面“生成批次”区域、确认生成按钮之前增加一个不嵌套卡片的后处理区，包含：

1. `后处理 Ending`
   - 文件选择按钮
   - 图片/视频预览
   - 文件名、素材类型和视频时长或图片 `1s` 标识
   - 删除按钮
   - 上传、校验、失败和完成状态
2. `扩展尺寸`
   - 预设复选框：`800x800`、`1280x720`、`720x1280`
   - 自定义宽、高输入，范围均为 `256-4096`
   - `添加尺寸`命令，将合法尺寸加入已选列表
   - 已选尺寸列表，每项可删除
   - 空列表表示仅生成原始尺寸

后处理配置变化不影响 Seedance 提示词内容，因此不使已生成的 Seedance 预案 stale；但确认生成后，这些控件与其他批次参数一起锁定。

任务管理页不再提供新建尺寸扩展的操作入口，只展示原始成片、自动生成的扩展成片，以及历史批次已存在的扩展任务结果。

## Request Contract

批次估算、预案和确认请求保存以下结构：

```json
{
  "postProcess": {
    "ending": {
      "enabled": true,
      "fileName": "brand-ending.mp4",
      "mimeType": "video/mp4",
      "storedPath": "postprocess-assets/ending/brand-ending.mp4",
      "storageKey": "...",
      "storageUrl": "...",
      "imageDurationSec": 1
    },
    "expansionSizes": [
      { "targetWidth": 800, "targetHeight": 800, "mode": "blur_pad" },
      { "targetWidth": 1080, "targetHeight": 1920, "mode": "blur_pad" }
    ]
  }
}
```

Normalization rules:

- No Ending is represented as `ending: null` or `enabled: false`.
- Empty expansion selection is represented as `expansionSizes: []`.
- Duplicate dimensions are removed using `width x height` as the key.
- A requested size equal to the probed original canvas is not rendered again; the original output satisfies that selection.
- Preset and custom dimensions use the same server-side validation.
- Unknown modes, unsupported file types and out-of-range dimensions are rejected before batch confirmation.
- Stored paths must resolve inside the current user's project root.

## Upload Contract

Add a dedicated batch post-processing asset upload route rather than reusing product assets:

```text
POST /api/wangzhuan/postprocess-assets/ending
```

The route accepts a base64 file payload using the existing upload envelope pattern and returns file metadata, local stored path and object-storage metadata. It must:

- allow only PNG/JPEG/WebP and MP4/WebM/MOV;
- enforce the existing product-asset size ceiling unless a stricter configured limit exists;
- store the file under a user-scoped `postprocess-assets/ending` directory;
- require object-storage synchronization using the existing storage adapter;
- never add the file to Seedance asset review or `collectSeedanceMedia`.

## Processing Pipeline

For each branch/variant output group, the final pipeline is:

```text
downloaded Seedance slices
-> materialize intermediate segment outputs without disclaimer
-> concat Seedance slices into the requested/probed original canvas
-> optionally normalize and append the independent post-process Ending
-> validate the combined video
-> apply one disclaimer overlay pass to the full combined duration
-> validate and atomically publish the original-size stitched video
-> upload the original-size stitched video
-> generate each selected blur-pad expansion from that original-size video
-> validate dimensions and full decoding for every expanded video
-> upload expanded videos
-> write stitch/post-process reports
-> enter QC
```

The independent Ending must be appended before disclaimer overlay so the disclaimer covers the Ending. Expansion must run after overlay so every derived size has identical content and disclaimer timing.

The Stitch stream-copy fallback must not hardcode `720x1280`. It must probe the first valid segment or resolve the confirmed output ratio, then scale/pad every re-encoded segment to that original canvas.

### Ending normalization

- Probe the original stitched video's width, height and audio characteristics.
- Image Ending: create a 1-second H.264/AAC segment at the original video's canvas size and frame rate.
- Video Ending: scale and pad to the original video's canvas size, encode H.264 `yuv420p`, normalize audio to AAC stereo, and preserve source duration.
- Add a silent AAC track when the Ending has no audio.
- Use unique per-operation temporary directories and atomically replace only after validation.

### Expansion generation

- Reuse `normalizeExpansionRequest`, `buildBlurPadFilter` and `renderExpandedVideo` behavior from `output-expansion.mjs`.
- Generate selected sizes with bounded concurrency; default concurrency is two and is capped by configuration.
- Every expanded output records `parentOutputId`, `targetWidth`, `targetHeight`, `sizeKey`, `mode`, storage metadata and local file path.
- Expanded outputs use `kind: "expanded_video"`; the original remains `kind: "stitched_video"` or the existing final single-segment kind.
- Expanded filenames retain the current `__WIDTHxHEIGHT` suffix.

## Single-segment Behavior

A single Seedance segment without a post-process Ending and without expansion sizes keeps the existing fast path: materialize the segment, apply the optional disclaimer, upload and enter QC without concat.

A single segment with a post-process Ending must enter the Stitch path so the Ending can be appended before overlay.

A single segment with expansion sizes but no Ending may retain the single-segment path, then expand from its final overlaid original-size output.

## Output and QC Contract

- The original-size output is always retained and displayed first.
- Expanded outputs are displayed under their original parent output.
- Original and expanded videos are downloadable only after their applicable checks pass.
- Full content/model QC runs on the original output.
- Expanded outputs inherit the parent's content QC result but must independently pass file existence, expected dimensions, duration tolerance and full decode checks.
- A failed expansion does not delete or invalidate the original output.
- If the original output fails, its expansions are not attempted.

Batch settlement:

- Original and every requested expansion succeed: enter `qc`, then normal QC settlement.
- Original succeeds but any requested expansion fails: enter `qc` with recorded post-process failures so original content QC still runs; after QC settle as `partial_failed`, retaining the original and successful expansions.
- Ending normalization, main concat, disclaimer overlay, original decode or original upload fails: `partial_failed` for that output group; no expansions run for that group.
- Multiple branch/variant groups settle independently; any mixed result yields `partial_failed`.

## Reports and Observability

Extend the existing stitch report with:

```json
{
  "postProcessEnding": {
    "applied": true,
    "sourceType": "video",
    "durationSec": 3.2,
    "fileName": "brand-ending.mp4"
  },
  "expansionOutputs": [
    {
      "sizeKey": "800x800",
      "status": "succeeded",
      "outputId": "out_xxx",
      "errorCode": ""
    }
  ]
}
```

Telemetry must record:

- Ending normalization started/succeeded/failed;
- original concat and disclaimer overlay outcomes;
- one event per expansion size;
- final requested/succeeded/failed expansion counts.

User-visible failures must identify the stage and, for expansion failures, the exact size.

## Compatibility and Migration

- Existing batches without `postProcess` behave exactly as before except CTA/Ending images are no longer appended as FFmpeg tails.
- Existing task-management expansion records remain queryable and downloadable.
- No database schema change is required; the new request and output metadata use existing JSON payload fields.
- Existing `POST /outputs/:outputId/expand` and `GET /expand-jobs` routes remain available for compatibility, but the task manager removes their creation controls.
- Legacy page behavior is unchanged unless it already passes the new `postProcess` structure.

## Security and Validation

- Validate extensions, MIME types, decoded payload size and user-root path containment server-side.
- Do not trust client duration, dimensions or media type; probe uploaded files with FFprobe.
- Reject files without a decodable video or image stream.
- Do not expose local absolute paths in API responses or error messages.
- Use the existing required object-storage synchronization policy.

## Non-goals

- Editing or trimming the uploaded Ending.
- Multiple Ending files in one batch.
- Per-branch post-process Ending selection.
- Expansion modes other than `blur_pad`.
- Replacing the original-size output with an expanded version.
- Applying different disclaimers per expanded size.
- Deleting historical task-management expansion results.

## Acceptance Criteria

1. CTA/Ending product images appear only in the final Seedance slice prompt and reference payload.
2. CTA/Ending product images are never converted to Stitch tail videos.
3. An optional image Ending produces exactly a 1-second appended tail before disclaimer overlay.
4. An optional video Ending preserves its probed duration within normal encoding tolerance.
5. Disclaimer overlay covers the full main-plus-Ending duration.
6. Empty expansion selection produces only the original-size output.
7. Multiple preset and custom sizes produce multiple derived outputs while retaining the original.
8. Every produced video passes full decode validation; expanded dimensions match the request.
9. Expansion failure retains the original and successful sizes and settles visibly as `partial_failed`.
10. Existing historical expansion results remain accessible in task management.
11. Current unrelated batch, scheduler, QC and download behaviors remain covered by the full test suite.

## Verification Strategy

- Unit tests for post-process request normalization, deduplication and file validation.
- Static frontend tests for control placement, multi-select/custom behavior and removal from task management.
- Prompt/provider tests proving CTA/Ending references exist only on the final Seedance slice.
- Real FFmpeg tests for image Ending, silent/video Ending, concat-before-overlay order and overlay duration.
- Real FFmpeg tests for multiple expansion sizes, exact dimensions and decodability.
- Runtime tests for no-postprocess fast path, original retention, partial expansion failure and single-flight behavior.
- Full `npm test` and `git diff --check` before completion.
