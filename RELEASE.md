# 发布步骤

本文档用于 `Touka AI素材中台` 的准上线发布。当前项目支持两种交付方式：

- Docker 部署：推荐用于服务器或长期运行环境。
- ZIP 交付包：用于 Windows 本机交付、内网拷贝或临时演示。

## 1. 发布前检查

在仓库根目录执行：

```powershell
git status --short
node --check server.mjs
node --check public\app.js
node --check public\wangzhuan.js
node --check public\competitor-remix.js
node --check public\wangzhuan-tasks.js
cmd /c npm test
```

验收重点：

- 测试必须全部通过。
- `git status --short` 中只保留本次发布确认过的改动。
- 不提交 `.env`、`env.export.txt`、`users.json`、`config.json`、日志、`project-data`、`node_modules`。
- 网赚素材管线和竞品素材改造至少完成一次浏览器冒烟：页面可打开、可登录、任务管理入口可用、刷新后未提交表单不残留。

## 2. 环境变量准备

生产或演示环境通过 `.env` 或部署平台环境变量注入配置。不要把真实密钥写入 Git 或镜像。

常用变量：

```text
AIGC_HOST_PORT=5182
AIGC_MYSQL_ROOT_PASSWORD=
AIGC_MYSQL_DATABASE=aigc_platform
AIGC_MYSQL_USER=aigc_app
AIGC_MYSQL_PASSWORD=
VIDEO_AIGC_API_KEY=
WANGZHUAN_SEEDANCE_ENDPOINT=https://skylink-gateway.com/api/v1
WANGZHUAN_SEEDANCE_MODEL=dreamina-seedance-2-0-260128
WANGZHUAN_LLM_API_KEY=
AWS_ACCESS_KEY_ID=
AWS_SECRET_ACCESS_KEY=
AWS_REGION=ap-southeast-1
S3_BUCKET=
S3_ENDPOINT=https://s3.ap-southeast-1.amazonaws.com
S3_PREFIX=uploads
S3_PUBLIC_BASE_URL=
PUBLIC_BASE_URL=
API_PREFIX=/api
```

对象存储不是必填项。未配置 `S3_BUCKET` 和 `AWS_REGION` 时，系统仍使用本地项目目录保存素材和产物。

## 3. Docker 发布

### 3.1 构建并启动

```powershell
docker compose up -d --build aigc-platform
docker compose ps
```

预期：

- `mysql` 状态为 `healthy`。
- `aigc-platform` 状态为 `healthy`。
- 默认访问地址为 `http://localhost:5182/`。

如果宿主机 `5182` 被占用：

```powershell
$env:AIGC_HOST_PORT=5178
docker compose up -d --build aigc-platform
```

访问 `http://localhost:5178/`。

### 3.2 已有数据库的迁移

首次创建 `aigc_mysql_data` volume 时，MySQL 会自动执行 `database/migrations/`。如果是已有 volume，需要按缺失版本顺序手动执行新迁移和验证脚本：

```powershell
Get-Content -Raw -Encoding UTF8 database/migrations/0010_workflow_task_pending_preview.sql | docker compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
Get-Content -Raw -Encoding UTF8 database/migrations/0010_workflow_task_pending_preview.verify.sql | docker compose exec -T mysql sh -lc 'mysql -u"$MYSQL_USER" -p"$MYSQL_PASSWORD" "$MYSQL_DATABASE"'
```

发布时只执行当前环境尚未执行过的迁移，不重复执行已成功执行过的文件。

### 3.3 Docker 冒烟

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:5182/ | Select-Object StatusCode
Invoke-WebRequest -UseBasicParsing http://localhost:5182/wangzhuan.html | Select-Object StatusCode
Invoke-WebRequest -UseBasicParsing http://localhost:5182/competitor-remix.html | Select-Object StatusCode
```

预期三个请求均返回 `200`。

浏览器检查：

1. 打开 `http://localhost:5182/`。
2. 使用管理员账号登录。
3. 打开 `网赚素材管线`，确认页面初始化无错误。
4. 打开 `竞品素材改造`，确认页面初始化无错误。
5. 打开 `任务管理`，确认列表和详情区域可见。

## 4. ZIP 交付包

用于把当前代码打包到桌面：

```powershell
.\package-release.ps1 -Version v1.2.3
```

脚本会生成：

```text
%USERPROFILE%\Desktop\seedance-ad-picture-web-package.zip
%USERPROFILE%\Desktop\seedance-ad-picture-web-package-v1.2.3.zip
%USERPROFILE%\Desktop\seedance-ad-picture-web-package\ad-picture-web\
```

交付包内会包含 `users.example.json` 和默认 `users.json`，但不会包含 `env.export.txt`、运行日志和本机运行态文件。

接收方解压后，在目录内执行：

```powershell
npm ci --omit=dev
.\start-windows.ps1
```

然后打开：

```text
http://localhost:5182/
```

本机非 Docker 运行需要系统可执行 `ffprobe`。Windows 可安装 FFmpeg 并把 `bin` 目录加入 `PATH`。

## 5. 上线后检查

上线后保留以下信息：

- 发布版本号。
- Git commit 或打包时间。
- 发布人。
- 是否执行数据库迁移。
- Docker 镜像重建时间。
- 冒烟结果。

建议记录模板：

```text
版本：
Commit：
发布时间：
发布人：
部署方式：Docker / ZIP
数据库迁移：无 / 已执行 00xx_xxx.sql
冒烟结果：首页 200；网赚页 200；竞品页 200；登录通过；任务管理通过
备注：
```

## 6. 回滚

### Docker 回滚

如果发布后发现阻塞问题：

```powershell
git checkout <上一稳定版本>
docker compose up -d --build aigc-platform
docker compose ps
```

如果已经执行了数据库迁移，先确认对应 `*.down.sql` 的影响范围，再决定是否回滚。不要在不了解数据影响时直接执行 down 脚本。

### ZIP 回滚

保留上一版 `seedance-ad-picture-web-package-vx.y.z.zip`。需要回滚时：

1. 停止当前 `node server.mjs` 进程。
2. 解压上一稳定 ZIP 到新的目录。
3. 复制必要的 `.env`、`config.json`、`users.json` 或运行态数据。
4. 执行 `npm ci --omit=dev`。
5. 执行 `.\start-windows.ps1`。

## 7. 常见问题

### 端口被占用

Docker 模式设置：

```powershell
$env:AIGC_HOST_PORT=5178
docker compose up -d --build aigc-platform
```

非 Docker 模式设置：

```powershell
$env:PORT=5178
node server.mjs
```

### 首次登录账号

MySQL 为空时，服务会从 `AIGC_USERS_PATH` 指向的 `users.json` 导入账号；没有文件时会创建默认管理员：

```text
admin / admin123
```

上线后应立即在页面右上角 `账号管理` 中修改密码或创建正式管理员。

### 页面初始化失败

优先检查：

```powershell
docker compose ps
docker compose logs --tail=120 aigc-platform
docker compose logs --tail=120 mysql
```

常见原因：

- MySQL 账号或密码不正确。
- 迁移未执行。
- 对象存储配置不完整。
- 上游模型 API Key 未配置。

### 网赚或竞品任务无法提交

检查：

- 是否有正在运行的批次或改造任务锁。
- `VIDEO_AIGC_API_KEY` 是否配置。
- `WANGZHUAN_LLM_API_KEY` 或模型网关配置是否可用。
- S3/CDN 是否能从服务端访问。

