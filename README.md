# Touka AI素材中台

用于批量生成图片广告效果图。生图模型固定使用 `gpt-image-2`，不要在没有明确批准的情况下切换模型。
当前网页标题和登录页标题均为 `Touka AI素材中台`，界面采用深色科技风、玻璃面板和紫色高亮。

## 启动

需要 Node.js 18 或更高版本，并安装配置 Tai CLI：

```powershell
npm install -g tai-ai
```

启动方式：

```powershell
.\start-windows.ps1
```

也可以双击：

```text
start-windows.bat
```

启动后打开：

```text
http://localhost:5182/
```

## 本地 Docker 部署

也可以直接用本地 Docker 启动服务。镜像会安装 `ffmpeg`，容器内自带 `ffprobe`，用于网赚素材管线检查参考视频的格式、时长、压缩率、编码格式、FPS、宽高、颜色空间和音频流。

```powershell
docker compose up --build
```

如果本机 `5182` 端口已被占用，可以换一个宿主端口：

```powershell
$env:AIGC_HOST_PORT=5178
docker compose up --build
```

启动后打开：

```text
http://localhost:5182/
```

默认 compose 会同时启动 `mysql:8.4.6`，首次创建 `aigc_mysql_data` volume 时会自动执行 `database/migrations/` 下的迁移。应用通过 `AIGC_DB_HOST`、`AIGC_DB_NAME`、`AIGC_DB_USER`、`AIGC_DB_PASSWORD` 连接 MySQL，把账号、登录会话、角色权限、模板、渠道规则、参考视频、拆解、估算、批次、任务、调度重试、产物、QC、下载包、幂等、审计和埋点写入数据库；JSON 文件只作为本地兼容层和大文件旁路索引。

如果已有 Docker volume，需要手动应用后续迁移，例如：

```powershell
Get-Content -Raw -Encoding UTF8 database/migrations/0002_scope_runtime_unique_keys.sql | docker compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
Get-Content -Raw -Encoding UTF8 database/migrations/0002_scope_runtime_unique_keys.verify.sql | docker compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
Get-Content -Raw -Encoding UTF8 database/migrations/0003_scheduler_state_machine_rules.sql | docker compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
Get-Content -Raw -Encoding UTF8 database/migrations/0003_scheduler_state_machine_rules.verify.sql | docker compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

默认 compose 会把仓库根目录的 `project-data` 挂载到容器 `/data/project-data`，并把运行态 `config.json`、兼容导入用 `users.json` 保存到 Docker volume `aigc_state`，不会写进镜像层。默认项目根目录是：

```text
/data/project-data/PROJECT_ROOT_P
```

## S3 兼容对象存储

服务支持把上传素材、参考视频、竞品素材和生成产物同步到 S3 兼容对象存储。未配置对象存储时仍按原来的本地目录工作；同时配置 `S3_BUCKET` 和 `AWS_REGION` 后启用对象存储。

```powershell
$env:AWS_ACCESS_KEY_ID=""
$env:AWS_SECRET_ACCESS_KEY=""
$env:AWS_REGION=""
$env:S3_BUCKET=""
$env:S3_ENDPOINT=""
$env:S3_PREFIX="uploads"
$env:S3_ACL=""
$env:S3_PUBLIC_BASE_URL=""
$env:PUBLIC_BASE_URL=""
$env:API_PREFIX="/api"
```

- `S3_PUBLIC_BASE_URL` 存在时，素材 URL 直接使用 CDN/桶公网域名。
- 未配置 `S3_PUBLIC_BASE_URL` 时，素材 URL 使用后端代理：`{PUBLIC_BASE_URL}{API_PREFIX}/public/assets/{storage_key}`。
- AK/SK 只从环境变量读取，不会写进接口返回、前端代码或对象存储索引。
- 对象存储索引保存在项目目录的 `批处理记录/object-storage-assets.json`，记录 `storageKey` 和 `storageUrl`。
- 对象存储字段会作为 `asset_files.probe_json` 和本地对象存储索引的一部分同步，不需要额外的 `asset_files` 迁移文件；如后续要把 `storageKey/storageUrl` 变成独立列，应新增后续迁移。

如果不使用 Docker，本机需要能执行 `ffprobe`。Windows 可以安装 FFmpeg 后把 `bin` 目录加入 `PATH`，或用包管理器安装：

```powershell
winget install Gyan.FFmpeg
```

## AI API Key 配置

网页工具的 AI 调用走 Tai CLI，需要在 Tai 配置里修改 API Key。

```powershell
tai config set --api-key 你的API_KEY
```

如果需要修改接口地址：

```powershell
tai config set --endpoint 你的接口地址
```

查看当前配置：

```powershell
tai config show
```

如果 PowerShell 提示 `tai.ps1 cannot be loaded`，改用 CMD，或在 PowerShell 里加 `cmd /c`：

```powershell
cmd /c tai config show
cmd /c tai config set --api-key 你的API_KEY
```

修改后请重启网页工具，再重新打开 `http://localhost:5182/`。

竞品素材上传后的图片/视频反推提示词走视觉模型。默认会自动读取 Codex/Tai 配置里的 `base_url` 和 `experimental_bearer_token`，并使用 `gemini-3-flash-preview` 做反推。

也可以用环境变量覆盖：

```powershell
$env:REVERSE_PROMPT_API_KEY="你的API_KEY"
$env:REVERSE_PROMPT_ENDPOINT="https://skylink-gateway.com/api/v1"
$env:REVERSE_PROMPT_MODEL="gemini-3-flash-preview"
```

如果没有可用 Key，上传仍可成功，但特殊提示词会退回到本地尺寸/色彩/构图统计，无法真正识别图片或视频封面的主体、表情和场景细节。

## 项目目录

网页顶部可以切换或修改服务器项目根目录。为了支持多人同时使用，角色/怪物/产品 Logo 图库按项目共享，其余竞品素材、结果和记录按访问用户隔离存放：

```text
项目根目录/用户数据/<用户ID>/<项目名>/
```

每个项目共享存放：

- `角色图`
- `怪物图`
- `产品logo`

每个用户、每个项目会分别隔离存放：

- `竞品素材1`
- `竞品素材2`
- `竞品素材3`
- `效果图`
- `批处理记录`

同一个项目下，所有登录用户共享角色图、怪物图和产品 Logo 图库。不同用户看到的竞品名称、竞品素材栏位、结果图库和运行状态仍然互相独立。

## 提示词

- 网页顶部只有一个全局 `通用提示词` 输入框，对应磁盘文件 `批处理记录/通用提示词.txt`，框体较小，用于所有竞品共用的构图、风格、防串图和版权安全规则。
- 默认通用提示词包含 Logo 规则：如果竞品图中有游戏 logo，把竞品 logo 替换成上传的产品 logo；如果竞品图中没有游戏 logo，则把上传的产品 logo 放到合适的广告角落、标题区或结尾展示区；不要复制竞品 logo。
- 网页里的 `特殊提示词` 对应磁盘文件 `用户特殊要求.txt`，框体较大，用于当前参考图的表情、动作、文字替换、特殊场景关系等可编辑要求。
- 上传或更换竞品素材后，工具会反推当前上传图片的尺寸、横竖版、主体重心、明暗、饱和度、主色和细节密度，生成该竞品独有的特殊提示词，不会覆盖全局通用提示词。
- 生成尺寸会锁定当前竞品图比例：方图生成方图，横图生成横图，竖图生成竖图。组合图也不能因为选择了多个角色或怪物就自动变成横版阵容。
- 默认提示词不能按 `竞品素材1/2/3` 文件夹编号套模板。
- 默认提示词不带 `【中文出图要求】` 或 `【自动分析-用户特殊要求】` 这类标题行。
- 特殊提示词只能描述当前竞品参考图真实可见或用户明确写出的内容，不能串用其他竞品图、历史生成图里的姿态、道具、危险状态或场景。

## 视频生成

- 顶部 `生成模式` 选择 `图片` 时，只用 `gpt-image-2` 生成效果图。
- 顶部 `生成模式` 选择 `图片+视频` 时，每个任务会先用 `gpt-image-2` 生成效果图，再用该效果图作为 Seedance 2.0 `image_to_video` 参考生成 15 秒竖屏 9:16 视频。
- 视频阶段使用 `dreamina-seedance-2-0-260128`、`720p`、`15s`，并会等待 Seedance 任务完成后下载 MP4 到 `效果图`。
- 该模式会同时消耗图片生成额度和 Seedance 视频额度，运行时间会明显长于只生成图片。
- 导入或上传视频素材时，页面会保留视频预览，并保存一张封面/参考帧作为 `gpt-image-2` 的竞品参考图。
- 视频素材会先反推视频节奏、镜头关系和玩法提示，再用于图片首帧和 Seedance 视频提示词，不能直接照搬竞品角色、UI、地图装饰或品牌元素。
- 广大大抓取到的视频会通过本地网页服务代理预览，并提供 `播放` 按钮；如果远程视频源限制内嵌播放，会尝试新窗口打开预览，不会影响导入素材。

## 自动保存和运行保护

- 左侧素材区包含 `角色图`、`怪物图`、`产品 Logo` 三个图库。这三类图库按项目共享保存，不按登录用户隔离；任意用户上传或替换后，同项目其他用户刷新即可看到。
- 每个竞品素材卡片都有 `Logo` 勾选项；勾选后，本次生成会把选中的产品 Logo 一起作为参考图传给 `gpt-image-2`，用于替换或新增广告 logo。
- 底部悬浮运行栏包含批次名、生成次数、生成模式、开始和停止。并发数默认固定为 `3`，不在页面上显示；如需改并发，需要由维护者调整前端隐藏值或服务端逻辑。
- `生成次数` 默认是 `1`，表示每一组角色图和竞品素材生成几次。大于 `1` 时，预估任务数会相应增加，输出文件名会带 `_第1次`、`_第2次` 等后缀，避免覆盖。
- 如果预估任务数是 `0`，页面会提示缺少角色、怪物或竞品选择，不会出现“闪一下就结束”的空跑。
- 修改每个竞品素材的 `角色数量`、`怪物数量`、`特殊提示词` 会自动保存，不需要再点额外保存按钮。
- 生成运行中会锁定素材导入和替换，避免中途换素材导致任务串图。
- 如果预估任务数大于 10，开始前会弹出二次确认，提醒运行时间和额度消耗会增加。
- 运行日志会显示每个图的进度、状态、耗时、重试、失败和跳过原因。
- 结果图库会在生成过程中自动刷新，并支持分批次勾选；所有批次都不勾选时不显示结果。
- 结果图库的 `下载选中批次` 会把当前勾选批次中的图片和视频打包成 zip，下载到访问网页用户自己的电脑。
- 任务显示 `已跳过` 通常表示同名输出文件已存在，程序为节省额度自动跳过。换批次名、删除旧结果，或使用 `生成次数` 生成唯一文件名即可重新出图。

## 构图和替换规则

- 局内玩法图必须锁定竞品参考的镜头远近、完整画面、网格密度、道路宽度、UI 留白和单位比例。
- 角色或怪物要替换到原竞品单位所在的格子中心、路线、层级和画面深度，不能站出格子，也不能把原角色留下后再额外加一个新角色。
- 竖版塔防或局内战斗参考如果是下方英雄、上方怪物，就必须保留这种上下关系，不能改成左右对战、海报阵容或角色展示图。
- 可以保留抽象布局、玩法节奏和广告机制，但具体场景皮肤、建筑、道具、UI 文案、logo、角色、怪物、地图装饰和色块细节要重新设计，降低侵权风险。

## 使用建议

1. 每次更换竞品图后，先看特殊提示词是否准确描述了当前图的表情、动作和场景关系。
2. 如果参考图有文字替换需求，直接写在特殊提示词里，例如：`图片中 capy bara 文字换成 oopsie croc`。
3. 如果参考图只是生活、喝茶、搞笑、萌系场景，不要在提示词里加入战斗属性、技能图标或英雄展示，除非当前图真的有这些元素。
4. 最终图只借鉴竞品图的构图逻辑和广告节奏，具体场景、道具、背景、logo 区域、装饰元素都要改成我方角色或怪物的原创风格。
5. 广大大素材库里，抓取结果的每张素材卡片都可以单独选择导入到 `竞品素材1/2/3`；页面顶部不再放全局 `导入到竞品` 选择框。
6. 广大大素材库是独立模块，默认 `类型=图片`、`最近时间=最近3天`，并会自动填好最近 3 天的开始/结束日期。
7. 广大大选择 `图片` 时会排除视频素材封面；人气值按广大大页面更接近的曝光人气口径筛选和显示，不再用播放量/展示量冒充人气。
8. 广大大重复素材会优先按图片哈希去重，同一素材跨平台出现时保留人气最高的一条，并按人气从高到低显示。
9. 广大大长时间范围会按 30 天分段抓取并合并去重，低人气阈值会自动加深扫描，所以 `最近1年` 不应比 `最近30天` 少，`人气大于100` 也会比 `人气大于10000` 更宽。

## 登录账号

网页不支持自行注册，账号由管理员在右上角 `账号管理` 中创建。Docker 模式下账号、密码哈希、登录会话和角色权限保存在 MySQL：

```text
app_users / auth_sessions / rbac_roles / user_roles
```

首次启动时，如果 MySQL 里还没有账号，服务会读取 `AIGC_USERS_PATH` 指向的 `users.json` 并导入数据库，同时把明文密码转换为哈希。没有 `users.json` 时会创建本地默认管理员：

```json
{
  "users": [
    { "username": "admin", "password": "admin123", "displayName": "管理员" }
  ]
}
```

非 Docker 或未配置 `AIGC_DB_*` / `AIGC_DATABASE_URL` 时，服务仍会回退到旧的 `users.json` 模式，方便本机调试。新增账号建议通过网页 `账号管理` 完成；旧模式下也可以在 `users` 数组里继续添加，例如：

```json
{ "username": "user01", "password": "pass123", "displayName": "用户01" }
```

如果已经启用 MySQL，后续修改 `users.json` 不会覆盖数据库账号；请用网页账号管理或后续数据库迁移处理账号。`username` 会作为服务器存储目录名，请保持简单稳定；同一个账号在不同电脑登录也会看到自己的同一份项目素材和结果。清理 Cookie 后不会丢失服务器上的素材和结果，只要重新登录同一个账号，就会回到同一个 `项目根目录/用户数据/<登录账号>/<项目名>/` 目录。

管理员登录后，右上角会出现 `账号管理` 按钮，可以在网页里直接创建账号、修改昵称、修改密码、调整普通用户/管理员权限、删除账号。普通用户不会看到该入口，也不能调用账号管理接口。

账号字段说明：

- `username`：登录账号，也是服务器用户目录名，创建后不要频繁改名。
- `password`：登录密码。
- `displayName`：网页右上角显示的昵称。
- `role`：`admin` 表示管理员，`user` 表示普通用户。
