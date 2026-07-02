# TAI Agent 竞品素材自动改造接入设计

## 背景

当前 `Aigc-platform` 已有竞品素材改造页面和后端 remix 任务体系。现有后端通过 `server/wangzhuan/remix-provider.mjs` 抽象外部视频处理 provider，`server/wangzhuan/remix.mjs` 负责创建 remix 任务、写入任务状态、保存输出、生成 QC 报告、进入预览确认和下载链路。

这次接入目标是让 TAI Agent 直接生成改造后视频或文件，而不是只做分析、提示词生成或方案建议。用户第一版不需要画区域或上传 mask，只上传待改造广告素材和改造目标；如果用户上传自己的 icon/logo，系统要求 TAI Agent 尽量把原素材中的 app icon、logo、brand mark 或 product logo 原地替换成用户资产。

## 目标

- 让竞品素材修改支持通过 TAI Agent 直接生成最终视频或文件。
- 第一版采用无区域自动识别模式：用户不需要画框、不需要 mask。
- 用户可上传自己的 icon/logo；有目标 icon/logo 时，优先把原 app/brand/product logo 原地替换为用户资产。
- 保留现有 remix 任务闭环：上传、任务状态、结果输出、QC、预览确认、下载、权限和运行锁。
- 后端持有 TAI Agent API key，浏览器不直接调用 Skylink Gateway。
- TAI Agent prompt 中不使用“竞品”作为模型执行概念，而是翻译成 app、brand、logo、watermark、CTA、subtitle、UI text、product name、store badge、voiceover/text copy 等可识别对象。

## 非目标

- 不在第一版支持手动画区或 mask 精修。
- 不在第一版展示 TAI Agent 的 thinking/code/output 过程面板。
- 不在第一版做多轮追问式生成。
- 不让前端直接持有或发送 TAI Agent API key。
- 不重做现有 remix 页面、QC、图库和下载体系。
- 不把 TAI Agent 接成只返回分析报告的能力；没有生成文件不能算任务成功。

## 接入方式

推荐把 TAI Agent 接成新的 remix provider：`tai_agent`。

现有 `remix.mjs` 继续调用统一 provider 接口：

- `client.createJob(payload)`
- `client.getJob(jobId)`
- `client.downloadJob(jobId)` 或等价的内部下载步骤

当 `wangzhuan.remixProvider.provider` 配置为 `tai_agent` 时，`remix-provider.mjs` 不再走现有 `/jobs` JSON API，而是走 Skylink Gateway 的 TAI Agent 原生接口：

- `POST /api/v1/aigc/agent/upload`
- `POST /api/v1/aigc/agent/stream`
- `GET /api/v1/aigc/agent/sandbox-download`

第一版可以把一次 TAI Agent stream 调用视为同步长任务：stream 结束时如果拿到可下载生成文件，就标记 provider job `succeeded`；如果没有生成文件，就标记 `failed` 或 `manual_required`。

后续如果生成耗时过长，再把 provider 调用迁到后台 worker，但 provider 合同不变。

## 配置

新增或复用 `wangzhuan.remixProvider` 配置：

```json
{
  "wangzhuan": {
    "remixProvider": {
      "provider": "tai_agent",
      "endpoint": "https://skylink-gateway.com/api/v1",
      "apiKeyEnv": "TAI_AGENT_API_KEY",
      "model": "tai-agent",
      "thinkingEffort": "extended",
      "timeoutMs": 600000
    }
  }
}
```

环境变量：

- `TAI_AGENT_API_KEY`：Skylink Gateway project API key。

兼容策略：

- 未配置 `tai_agent` 时，保持现有 provider 行为。
- `provider` 为 `video_aigc` 或其他值时，不改变现有 `/jobs` 调用。
- `endpoint` 统一保存到 `/api/v1` 根路径，provider 内部拼接 `/aigc/agent/*`。

## 用户流程

第一版用户流程：

1. 用户上传待改造广告素材。
2. 用户填写改造目标。
3. 用户可选上传自己的 icon/logo。
4. 用户可选填写目标 app name、brand name、product name、目标语言。
5. 用户点击“自动改造素材”。
6. 后端创建 remix 任务并调用 TAI Agent。
7. TAI Agent 自动识别原素材中的 app、brand、logo、watermark、subtitle、CTA、UI text、product name、store badge、voiceover/text copy 等元素。
8. 有用户 icon/logo 时，TAI Agent 尽量原地替换原 logo/icon；没有目标资产时，按目标名称替换或去品牌化。
9. TAI Agent 生成最终视频或文件。
10. 后端下载输出，写入 remix outputs。
11. 进入现有 QC、预览确认和下载流程。

## 前端最小变化

第一版不重做页面，只把默认任务路径从“区域驱动”弱化为“目标驱动”。

需要的 UI 调整：

- 页面默认展示“自动识别改造”模式。
- 不强制用户画区域。
- 不强制用户提供 mask。
- 提交前只要求：
  - 已上传待改造素材。
  - 已填写改造目标，或至少选择默认改造目标。
- 可选字段：
  - 目标 app name。
  - 目标 brand name。
  - 目标 product name。
  - 目标语言。
  - 用户自己的 icon/logo。
- 提交按钮文案建议为“自动改造素材”。
- 结果预览和下载继续复用现有 remix 结果区域。

第一版可以隐藏或降级现有区域编辑模块：

- 默认不展示 mask 画布。
- 只有后续进入“局部精修”模式时再启用区域 UI。
- 现有依赖 `regions.length` 的前端校验需要为 `tai_agent` 自动模式放行。

## 输入合同

后端向 TAI Agent 构造结构化上下文，而不是直接转发用户原话。

内部 request 建议形态：

```json
{
  "mode": "auto_detect_no_mask",
  "source_material": {
    "sourceId": "src_0001",
    "fileName": "input.mp4",
    "mimeType": "video/mp4",
    "durationSec": 15.2,
    "width": 1080,
    "height": 1920
  },
  "target_assets": {
    "icon_or_logo": {
      "enabled": true,
      "fileName": "my-app-icon.png",
      "mimeType": "image/png"
    }
  },
  "target_identity": {
    "app_name": "",
    "brand_name": "",
    "product_name": "",
    "language": "zh-CN"
  },
  "user_goal": "把素材改成我方 app 广告，替换原 logo 和文字"
}
```

TAI Agent `uploaded_files` 顺序：

1. 待改造广告素材。
2. 用户自己的 icon/logo，如果有。

后端 prompt 必须明确附件角色，避免模型混淆：

- 附件 1 是需要改造的广告素材。
- 附件 2 是用户自己的 app icon/logo，仅在存在时说明。

## Prompt 契约

TAI Agent prompt 使用广告素材和品牌元素语言，不使用“竞品”作为执行概念。

模板：

```text
你是广告素材改造 Agent。请读取上传的视频或图片素材，自动识别其中的 app、brand、logo、watermark、subtitle、CTA、UI text、store badge、product name、voiceover/text copy 等品牌或应用相关元素，并直接生成改造后的最终视频/文件。

附件说明：
- 附件 1 是待改造广告素材。
- 如果存在附件 2，附件 2 是用户自己的 app icon/logo，请用于替换原素材中的 app icon/logo/brand mark/product logo。

用户改造目标：
{userGoal}

目标信息：
- target_app_name: {targetAppName}
- target_brand_name: {targetBrandName}
- target_product_name: {targetProductName}
- target_language: {targetLanguage}

请自动处理：
1. 自动识别原素材中的 app name、brand name、logo、watermark、store badge、product name、subtitle、CTA、button text、UI text、voiceover/text copy。
2. 如果用户上传了自己的 app icon/logo，请将原素材中出现的 app icon、logo、brand mark、product logo 尽量在原位置替换成用户上传的 icon/logo。替换时保持原素材的画面比例、透视、光照、边缘融合、遮挡关系和动画节奏。不要把新 logo 随机放到其他位置。
3. 如果用户没有上传 icon/logo，但提供了目标 app/brand/product name，请移除原 logo/icon，并把相关品牌名、产品名、CTA、字幕或 UI 文案替换为目标信息。
4. 如果用户没有提供任何目标品牌资产或名称，请做去品牌化处理：移除或模糊原 app/brand/logo/product name，用中性 CTA 和通用表达替代，不保留原素材品牌信息。
5. 保留广告节奏、镜头顺序、转化结构、画面比例和可用构图。
6. 自动判断哪些区域需要处理，不要求用户提供 mask 或坐标。
7. 直接输出改造后的最终视频/文件，不要只输出分析报告。

输出要求：
- 必须生成最终视频或文件。
- 如果生成多个文件，主结果命名为 remixed_output。
- 优先保持原始素材格式和比例。
- 如果无法生成文件，必须明确说明失败原因。
```

## TAI Agent HTTP 调用

上传源素材：

```http
POST https://skylink-gateway.com/api/v1/aigc/agent/upload
Authorization: Bearer <project_api_key>
Content-Type: multipart/form-data

model=tai-agent
file=@source.mp4
```

上传用户 icon/logo，如果存在：

```http
POST https://skylink-gateway.com/api/v1/aigc/agent/upload
Authorization: Bearer <project_api_key>
Content-Type: multipart/form-data

model=tai-agent
file=@target-logo.png
```

调用 stream：

```http
POST https://skylink-gateway.com/api/v1/aigc/agent/stream
Authorization: Bearer <project_api_key>
Content-Type: multipart/form-data

model=tai-agent
prompt=<rendered prompt>
thinking_effort=extended
uploaded_files=[{"upload_id":"upload_source","file_id":"file_source","file_name":"source.mp4"},{"upload_id":"upload_logo","file_id":"file_logo","file_name":"target-logo.png"}]
```

首轮不要传 `conversation_id`。后端从 SSE `meta` 事件保存真实 `conversation_id`，从 `done` 事件保存 `message_id`。

下载生成文件：

```http
GET https://skylink-gateway.com/api/v1/aigc/agent/sandbox-download?conversation_id=<conversation_id>&sandbox_path=<sandbox_path>
Authorization: Bearer <project_api_key>
```

## SSE 解析规则

TAI Agent provider 必须解析这些事件：

- `meta`：保存 `conversation_id`。
- `delta` 且 `channel=answer`：拼接主回复，保存为 provider 摘要。
- `delta` 且 `channel=thinking|code|output`：第一版可忽略，也可只保存调试摘要。
- `files`：生成文件列表，是成功判定的核心依据。
- `error`：转成 `upstream_failed`。
- `done`：保存 `message_id`，标记 stream 结束。

成功条件：

- HTTP 状态为 2xx。
- SSE 没有 `error`。
- 能拿到 `conversation_id`。
- 能拿到 `message_id`。
- 能拿到至少一个可下载文件。
- 至少一个下载文件符合预期输出类型。用户上传视频时，优先要求视频输出。

失败条件：

- HTTP 非 2xx。
- SSE 出现 `error`。
- stream 结束但没有 `message_id`。
- stream 有回答但没有 `files`。
- `files` 中没有可下载 `sandbox_path`。
- `sandbox-download` 失败。
- 下载结果不是预期媒体类型，且无法进入人工确认。

`answer` 可以保存到 `providerJob.agent.answer`，但不能替代生成文件。

## Provider Job 映射

TAI Agent 没有传统 job id。provider 需要把 `conversation_id` 和 `message_id` 映射成现有 remix 可识别的 job。

建议返回：

```json
{
  "job_id": "tai_<conversation_id>_<message_id>",
  "status": "succeeded",
  "conversation_id": "<conversation_id>",
  "message_id": "<message_id>",
  "answer": "<agent answer>",
  "generated_files": [
    {
      "sandbox_path": "/mnt/data/remixed_output.mp4",
      "file_name": "remixed_output.mp4",
      "mime_type": "video/mp4",
      "size_bytes": 1234567
    }
  ],
  "downloaded_outputs": [
    {
      "storedPath": "批处理记录/remix/.../outputs/...",
      "mimeType": "video/mp4"
    }
  ]
}
```

`providerJobSnapshot()` 需要兼容：

- `job_id`
- `id`
- `conversation_id + message_id`
- `status`
- `generated_files`

状态映射：

- `succeeded`：有生成文件并下载成功。
- `failed`：调用失败、SSE error、无文件、下载失败。
- `running`：后续异步 worker 版本使用；第一版同步 stream 可不暴露。
- `queued`：后续异步 worker 版本使用。

## 输出保存

第一版只把主输出写入现有 remix outputs。

主输出选择规则：

1. 优先选择视频文件：`.mp4`, `.mov`, `.webm`。
2. 如果源素材是图片，优先选择图片文件：`.png`, `.jpg`, `.jpeg`, `.webp`。
3. 如果多个文件都符合，优先文件名包含 `remixed_output` 的文件。
4. 其余生成文件记录到 `providerJob.agent.generatedFiles`，暂不进入图库主输出。

保存流程：

- 调 `sandbox-download` 下载主文件。
- 写入当前 `remixDir/outputs`。
- 调用或复用现有 output materialization 逻辑，生成 `outputs[0]`。
- 写入 `qcSummary`。
- 进入预览确认。

如果只生成了非媒体文件，例如 `.txt` 或 `.json`，任务不能标记为成片成功；应返回清晰错误：“TAI Agent 未返回视频或图片输出”。

## Error Handling

错误对用户展示要保留业务可理解信息，对日志保留排查字段。

用户可见错误：

- `TAI Agent 调用失败，请稍后重试`
- `TAI Agent 未返回可下载生成文件`
- `生成文件下载失败，请重试`
- `生成结果不是可预览的视频或图片`
- `上传的目标 logo/icon 无法被 TAI Agent 读取，请重新上传 PNG 或 JPG`

日志和 providerJob 保留：

- HTTP status。
- upstream code/message。
- `conversation_id`。
- `message_id`。
- `sandbox_path`。
- SSE error payload。
- request id。

超时策略：

- 第一版 `timeoutMs` 建议 10 分钟。
- 超时标记 `failed`，错误原因写“TAI Agent 生成超时”。
- 不自动重试，避免重复扣费或重复生成。

附件过期：

- 如果 upload 或 sandbox-download 返回 410，提示用户重新上传素材。

## Security

- API key 只从后端环境变量读取。
- 前端不传 API key。
- 不把 Skylink Gateway 内部下载地址直接暴露给用户。
- `uploaded_files` 只包含当前用户本次任务允许访问的素材。
- 生成结果落到现有用户项目目录和对象存储权限模型中。
- provider 日志不打印完整 bearer token。

## Testing

单元测试：

- `tai_agent` provider 配置选择。
- `/api/v1` endpoint 拼接 `/aigc/agent/upload`、`/aigc/agent/stream`、`/aigc/agent/sandbox-download`。
- multipart upload 请求字段包含 `model` 和文件。
- stream 请求首轮不带 `conversation_id`。
- SSE parser 能解析 `meta`、`delta answer`、`files`、`done`、`error`。
- 无 `files` 时标记失败。
- 有用户 logo 时 prompt 明确附件 2 是目标 icon/logo。
- 无用户 logo 但有目标名称时 prompt 走名称替换。
- 无目标资产和名称时 prompt 走去品牌化。

集成测试：

- mock TAI Agent upload + stream + sandbox-download，验证 remix start 后能写入 output。
- mock stream 返回 answer 但没有 files，验证任务失败且错误可读。
- mock sandbox-download 失败，验证保留 conversation_id 和 sandbox_path。
- mock 多文件输出，验证主视频选择规则。

手工验收：

- 上传视频，不提供 logo，只填写“改成中性 app 广告”，结果不保留原 app/brand/logo/product name。
- 上传视频和用户 icon/logo，结果中原 logo/icon 位置被替换为用户 icon/logo。
- 上传视频和目标 app/product name，无 logo，结果文案替换成目标信息。
- 生成完成后仍可走现有预览确认和下载。

## 发布顺序

1. 增加 `tai_agent` provider 客户端和测试。
2. 增加 prompt 构造和 SSE/files 解析测试。
3. 接入 remix start 流程，保持 provider 接口不变。
4. 前端放行无区域自动改造模式，增加目标 app/brand/product 和 icon/logo 输入。
5. 做一次真实 TAI Agent smoke test，确认能生成并下载媒体文件。
6. 再打开生产配置。

## First-Version Decisions

- 第一版在竞品改造页面新增独立的目标 icon/logo 上传入口。这样用户不需要先进入其它产品素材库，也避免把网赚管线的产品 Logo 资产合同强行复用到 remix 页面。
- 第一版不引入后台 worker。TAI Agent provider 先按同步长任务跑通，超时时间为 10 分钟；如果真实生成耗时超过这个边界，再升级为后台 worker。
- 第一版如果 TAI Agent 返回多个视频，只保留主结果进入 remix outputs、QC、预览确认和下载。其它生成文件记录在 `providerJob.agent.generatedFiles` 中，后续再决定是否进入结果图库。
