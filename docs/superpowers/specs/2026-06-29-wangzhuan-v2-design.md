# 网赚素材管线 v2 设计与实施 Spec

## 背景

当前 `public/wangzhuan.html` 是可用的网赚素材管线页面，但 AI 拆解视频和生成 Seedance 预案这两个耗时操作会占住用户注意力。v2 的目标是在不影响旧页面的前提下，新增一个独立页面，让这两个长任务后台运行，用户等待时可以继续填写产品改写与投放信息。

## 目标

- 新增独立页面“网赚素材管线 v2”，不替换、不删除、不破坏旧版页面。
- 保持高密度、强状态反馈、少打断的工作台体验。
- 左侧只承载系统模块导航；右侧集中展示后台任务队列、关键提醒、日志、运行与结果。
- 中间工作区严格复用当前 `wangzhuan.html` 的字段、选项和业务规则，仅调整布局和交互形态。
- AI 拆解视频和 Seedance 预案生成后台化，用户等待期间可以继续填写第 3 步。

## 非目标

- 不在首版切换旧版入口到 v2。
- 不重做商店页读取功能；按钮保留但禁用。
- 不新增地区、语言、渠道、承诺等级、素材方向等业务枚举。
- 不把目标地区和语言做成多选下拉组件；首版使用单选原生 `<select>`。
- 不重构 Seedance 生成、QC、图库和下载主链路，除非为了接入 v2 必须做最小适配。

## 页面结构

新增页面建议：

- `public/wangzhuan-v2.html`
- `public/wangzhuan-v2.js`

旧页面保留：

- `public/wangzhuan.html`
- `public/wangzhuan.js`

导航策略：

- 左侧模块导航新增“网赚素材管线 v2”入口。
- 旧“网赚素材管线”入口继续指向旧页面。
- v2 完整闭环验证前，不把默认入口切到 v2。

布局结构：

- 顶部：品牌、页面名、批次名、当前长任务状态、保存草稿/开始新任务/任务管理。
- 左侧：系统模块导航。
- 中间：流程步骤和主要表单。
- 右侧：后台任务队列、关键提醒、查看日志、运行与结果。

## 字段规则

v2 首版严格复用旧页字段和选项。

参考视频输入：

- 参考视频上传：`video/mp4, video/webm, video/quicktime`
- 当前项目
- 批次名
- 视频预览组件，复用现有 `referencePreviewUrl` / `renderReferenceVideoPreview` 思路。

AI 拆解脚本：

- 素材经验补充
- 模型服务商
- 模型名称
- 接口地址
- 创意随机度
- 拆解字段：`scene`, `subject`, `action`, `camera`, `lighting`, `style`, `quality`, `hook`
- 可选拆解字段继续沿用现有表单能力。

模板与产品信息：

- 选择模板
- 模板名
- 产品名
- 产品链接
- 读取商店页按钮：禁用，展示“暂未开放”
- 保存模板

我方产品素材资产：

- 产品图标
- 产品截图
- 产品录屏
- 人物
- 奖励元素
- CTA 素材
- Ending 素材
- Seedance 素材上传并审核
- 确认审核结果

本次投放：

- 目标渠道：`Meta Ads`, `TikTok Ads`, `Google Ads`, `Unity Ads`, `ironSource`, `通用`
- 目标地区：单选原生 `<select>`，选项沿用旧页：`US`, `BR`, `MX`, `GB`, `CA`, `AU`, `PH`, `ID`, `TH`, `VN`
- 语言：单选原生 `<select>`，选项沿用旧页：`English (US)`, `Portuguese (Brazil)`, `Spanish (Mexico)`, `English (UK)`, `French`, `German`, `Indonesian`, `Thai`, `Vietnamese`, `Chinese (Simplified)`
- 素材方向：沿用旧页选项
- 其他素材方向
- 口播风格
- 承诺等级：`稳健版`, `强转化版`, `强承诺版`
- 币种：原生 `<select>`，首版只提供当前默认值 `$`
- CTA
- Ending

免责声明：

- 免责声明贴片模板：`按语言自动选择`, `英文`, `葡语`, `中文`, `其他`
- 启用免责声明贴片
- 免责声明文案
- 贴片位置：`底部居中`, `左下`
- 字号
- 贴片高度
- 底部距离
- 左右距离

提示词规则：

- “脚本裂变规则”文案改为“脚本裂变规则补充”
- 补充提示词
- 限定提示词

生成批次：

- 模型：Seedance 2.0
- 输出时长：`15s`, `30s`
- 尺寸：`9:16 竖版`, `1:1 方版`, `16:9 横版`
- 变体数
- 同时生成数量
- Seedance 模型
- 估算结果
- 预计时间：`变体数 * 同时生成数量 * 3min`
- Seedance 预案编辑区：Hook、口播、Seedance Prompt、Negative Prompt
- 已确认本批次数量、时长和可能消耗
- 确认预案并生成视频
- 停止批次

单选地区/语言提交规则：

- 前端 UI 使用单选 `<select>`。
- 提交给现有后端时包装为数组，保持后端合同兼容：
  - `targetRegion = selectedRegion`
  - `targetRegions = [selectedRegion]`
  - `language = selectedLanguage`
  - `languages = [selectedLanguage]`

## 后台任务设计

### AI 拆解后台化

现状：

- `POST /api/wangzhuan/reference-videos/draft-decomposition` 同步等待模型结果。

v2 目标：

- 点击“开始解析”后立即进入后台任务状态。
- 右侧后台任务队列显示 AI 拆解视频运行中。
- 用户可以继续填写第 3 步。
- 任务完成后回填第 2 步拆解表单。
- 如果用户在等待期间手动填写了拆解字段，回填时不覆盖用户值；需要标记“AI 结果可用”或“字段存在差异”。

建议接口形态：

- `POST /api/wangzhuan/reference-videos/decomposition-jobs`
  - 输入：`referenceVideoId`, `knowledgeNotes`, `llmConfig`
  - 输出：`decompositionJobId`, `status`
- `GET /api/wangzhuan/reference-videos/decomposition-jobs/:jobId`
  - 输出：`status`, `progress`, `decomposition`, `error`, `events`

如果后端短期不做新表，可先用现有 batch draft 记录任务摘要；但接口语义仍建议独立，便于前端和测试。

### Seedance 预案后台化

现状：

- `POST /api/wangzhuan/batches/plan` 同步等待预案生成。

v2 目标：

- 点击“生成 Seedance 预案”后立即进入后台任务状态。
- 右侧后台任务队列显示预案生成进度。
- 用户可继续查看和补充第 3 步。
- 任务完成后回填预案编辑区。
- 生成预案时记录第 3 步关键字段签名。
- 如果用户在预案生成期间或生成后修改关键字段，显示“预案已失效，请重新生成”，不能静默沿用旧预案。

建议接口形态：

- `POST /api/wangzhuan/batches/plan-jobs`
  - 输入：`batchId`, `estimateId`, `llmConfig`, `knowledgeNotes`, `confirmationToken`
  - 输出：`planJobId`, `batchId`, `status`, `draftSignature`
- `GET /api/wangzhuan/batches/plan-jobs/:jobId`
  - 输出：`status`, `progress`, `batch`, `plans`, `error`, `events`, `draftSignature`

签名规则：

- 预案签名基于影响预案内容的第 3 步字段。
- 包括产品名、产品链接、产品素材引用、目标渠道、目标地区、语言、素材方向、口播风格、承诺等级、币种、CTA、Ending、免责声明、提示词规则。
- 不包括 UI 展开/折叠状态、日志滚动位置等纯展示状态。

## 前端状态模型

v2 前端需要维护这些主要状态：

- `referenceVideo`
- `decompositionDraft`
- `decompositionJob`
- `branchDrafts`
- `rewriteConfirmed`
- `estimate`
- `planJob`
- `batchDetail`
- `activeTaskQueue`
- `draftSignature`
- `stalePlanPreview`

右侧任务队列从 `decompositionJob`、`planJob`、`batchDetail` 汇总：

- AI 拆解视频：idle / running / succeeded / failed
- Seedance 预案：idle / running / succeeded / failed / stale
- Seedance 素材审核：idle / running / passed / failed
- 视频生成和质检：沿用现有 batch 状态

## 错误与边界

- 拆解失败：右侧显示失败原因，中间保留用户已填内容，允许重试。
- 预案失败：保留估算结果和第 3 步草稿，允许重试。
- 用户修改关键字段：预案显示 stale，不允许确认旧预案生成视频。
- 商店页读取：按钮 disabled，不能触发请求。
- 旧页面仍可使用：v2 的新增 JS/CSS 不应修改旧页面 DOM 选择器行为。
- 数据库或任务状态不可用：显示明确错误，不把按钮卡在 loading 状态。

## 测试与验收

前端静态验收：

- `/wangzhuan-v2.html` 可打开，旧 `/wangzhuan.html` 不受影响。
- 左侧只有系统模块导航。
- 右侧显示后台任务队列、关键提醒、日志、运行与结果。
- 目标地区、语言、币种为原生单选 `<select>`。
- 商店页读取按钮 disabled。
- 免责声明贴片参数拆成独立字段。
- 估算结果显示预计时间公式。

功能验收：

- 参考视频上传后能显示视频预览。
- AI 拆解后台运行时，第 3 步可继续编辑。
- 拆解完成后能回填拆解字段。
- 估算请求提交的 `targetRegions` / `languages` 仍为数组。
- Seedance 预案后台运行时，第 3 步可继续编辑。
- 第 3 步关键字段变更后，已有预案会显示失效并阻止确认。
- 确认预案后沿用现有生成、停止、质检、归档、下载链路。

建议测试：

- 新增 v2 前端静态测试，覆盖关键 DOM 和控件状态。
- 新增后端任务接口单元测试，覆盖任务提交、状态查询、失败状态。
- 新增 plan stale 签名测试。
- 新增浏览器手测或 Playwright 冒烟测试：打开 v2、上传参考视频、模拟后台任务完成、确认第 3 步仍可编辑。

## 分阶段实施

### 阶段 1：独立 v2 页面壳

- 新增 `public/wangzhuan-v2.html`
- 新增 `public/wangzhuan-v2.js`
- 加入 v2 导航入口
- 静态落地当前布局和全部字段
- 不接管旧页面

### 阶段 2：接入现有前端能力

- 接登录状态、模板列表、参考视频上传、保存草稿、产品素材上传、确认信息、估算、素材审核。
- 单选地区/语言包装成现有后端需要的数组。
- 商店页读取保持禁用。

### 阶段 3：AI 拆解后台化

- 新增拆解任务提交和查询能力。
- v2 右侧任务队列展示拆解进度。
- 完成后回填拆解表单，不覆盖用户手填内容。

### 阶段 4：Seedance 预案后台化

- 新增预案任务提交和查询能力。
- v2 右侧任务队列展示预案进度。
- 完成后回填预案编辑区。
- 加入关键字段签名和 stale 阻断。

### 阶段 5：完整闭环与切换评估

- 接确认预案、生成视频、停止批次、质检、归档、下载。
- 对比旧版和 v2 的真实生产流程。
- v2 验证通过后再决定是否把默认入口切换到 v2。
