# 竞品改造首期合同

## Endpoints

- `POST /api/wangzhuan/remix/upload`
- `POST /api/wangzhuan/remix/detect`
- `POST /api/wangzhuan/remix/estimate`
- `POST /api/wangzhuan/remix/plan`
- `POST /api/wangzhuan/remix/start`
- `GET /api/wangzhuan/remix/:remixId`
- `GET /api/wangzhuan/remix/:remixId/qc-report`
- `POST /api/wangzhuan/remix/:remixId/preview-confirm`

## Core States

- `uploaded`
- `detecting`
- `detection_succeeded`
- `plan_ready`
- `queued`
- `running`
- `qc`
- `preview_required`
- `succeeded`
- `failed`

## Core Behaviors

- 检测结果必须覆盖首期 7 类能力：`logo_icon`、`product_name`、`cta`、`ending`、`watermark`、`subtitle`、`phone_ui`
- 区域合同同时支持 `bbox` 和 `description`
- 统一任务模型支持：
  - 自动检测类任务：`autoDetect=true`
  - 区域类任务：`regions + maskDataUrl`
- 自动 QC 通过后：
  - 输出 `qcStatus=pass`
  - 任务自动进入 `succeeded`
  - 自动进入图库
- 自动 QC 失败后：
  - 输出 `qcStatus=fail`
  - 任务停留在 `preview_required`
  - 允许人工确认兜底
