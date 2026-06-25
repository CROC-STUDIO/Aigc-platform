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

## 8. 候选发布模式验证结论

本项目已经验证过两类服务器，结论不要混用：

- 目录型部署：例如直接运行 `/opt/ad-picture-web/server.mjs`，配置和运行态文件就在宿主机目录里。
- 容器型部署：例如 `docker compose` 运行 `aigc-platform` 和 `mysql`，应用实际工作目录在容器 `/app`，运行态文件在 volume。

### 8.1 目录型部署的候选发布

适用条件：

- 现网服务直接从宿主机目录启动。
- `config.json`、`users.json`、`.env`、项目根目录都由宿主机文件管理。

可行做法：

1. 备份现网目录。
2. 新建候选目录，例如 `/opt/ad-picture-web-release-candidate`。
3. 把要发布的代码复制到候选目录。
4. 保留现网 `config.json`、`users.json`，必要时保留 `.env`。
5. 新起独立 service 和独立端口。
6. 先验候选服务，再决定是否切换现网。

关键经验：

- 目录型部署必须优先确认代码版本和当前运行契约一致。
- 如果新代码依赖 MySQL、S3 或额外环境变量，只复制前端文件或 `server.mjs` 不够。
- 候选服务必须和现网隔离 cookie、端口和写入目录，避免互相污染。

### 8.2 容器型部署的候选发布

适用条件：

- 现网由 Docker / Docker Compose 运行。
- 现网应用和 MySQL 已经在独立容器里。

可行做法：

1. 基于当前服务器真实部署方式创建候选镜像，不直接改正在运行的容器。
2. 新起独立候选容器，例如映射 `5183 -> 5182`。
3. 需要时新起独立候选 MySQL，而不是默认复用现有 MySQL。
4. 候选容器只复用必要的只读挂载或显式声明的状态文件。
5. 候选容器通过独立端口完成验收，再决定是否替换现网容器。

关键经验：

- 容器型部署优先验证镜像能否构建，再验证运行契约是否兼容。
- 不要把目录型发布步骤直接套到容器型服务器上。
- `8000`、`5182` 这类端口必须先确认归属，避免误碰其他项目。

推荐模板：

1. 复制候选代码到独立目录，例如 `/home/dev/Aigc-platform-rc`。
2. 在候选目录内构建独立镜像，例如：

```bash
docker build -t touka-aigc-platform:rc .
```

3. 新起独立候选 MySQL，避免直接复用现网 MySQL：

```bash
docker run -d --name aigc-platform-rc-mysql \
  --network aigc-platform_default \
  -e MYSQL_ROOT_PASSWORD=***
  -e MYSQL_DATABASE=aigc_platform
  -e MYSQL_USER=aigc_app
  -e MYSQL_PASSWORD=***
  -v aigc_platform_rc_mysql_data:/var/lib/mysql \
  -v /home/dev/Aigc-platform-rc/database/migrations:/docker-entrypoint-initdb.d:ro \
  mysql:8.4.6
```

4. 新起独立候选应用容器，例如映射 `5183 -> 5182`：

```bash
docker run -d --name aigc-platform-rc \
  --network aigc-platform_default \
  -p 5183:5182 \
  -e HOST=0.0.0.0 \
  -e PORT=5182 \
  -e AIGC_DB_HOST=aigc-platform-rc-mysql \
  -e AIGC_DB_PORT=3306 \
  -e AIGC_DB_NAME=aigc_platform \
  -e AIGC_DB_USER=aigc_app \
  -e AIGC_DB_PASSWORD=*** \
  -e AIGC_PROJECT_ROOT=/data/project-data/PROJECT_ROOT_P \
  -e AIGC_CONFIG_PATH=/data/state/config.json \
  -e AIGC_USERS_PATH=/data/state/users.json \
  --volumes-from aigc-platform-aigc-platform-1 \
  touka-aigc-platform:rc
```

5. 验收候选容器：

```bash
docker ps
docker logs --tail 120 aigc-platform-rc
curl -I http://127.0.0.1:5183/
```

注意：

- `--volumes-from` 只适合复用明确的只读状态目录或项目数据目录，不能默认当成完整兼容方案。
- 如果候选代码明显老于现网运行契约，应先补兼容层，再谈候选验收。

### 8.3 `origin/main` 兼容性验证结果

已验证结论：

- `origin/main` 可以被单独归档为候选目录。
- 如果补齐 `package.json`、`package-lock.json`、`Dockerfile`、`.dockerignore`，可以构建候选镜像。
- 但 `origin/main` 不能直接在当前新版容器环境里稳定运行，原因不是 Docker、端口或网络，而是代码运行契约过旧。

实际暴露出的兼容性问题：

- `origin/main` 没有当前新版的环境变量约定。
- 老版 `server.mjs` 把 `users.json` 固定写到 `/app/users.json`。
- 当前容器运行用户无权写镜像内 `/app/users.json`，会直接报：

```text
EACCES: permission denied, open '/app/users.json'
```

结论：

- “独立候选实例”这个模式本身可行。
- “直接拿过老的 main 代码塞进当前正式容器环境”不可行。
- 正式环境要安全合并功能，前提是候选代码必须和当前部署模型兼容。

### 8.4 正式环境推荐路径

目标是：不影响现有功能情况下合并功能，并让用户正常使用。

推荐顺序：

1. 先识别正式环境是目录型还是容器型部署。
2. 选择与正式环境部署模型一致的代码基线。
3. 创建独立候选实例：
   - 独立目录或独立镜像
   - 独立端口
   - 独立 cookie / session 命名
   - 独立数据库或独立状态存储
4. 完成候选验收：
   - 首页可访问
   - 登录可用
   - 关键业务页初始化正常
   - 关键接口返回符合预期
5. 验收通过后再切换现网入口或替换现网容器。

不推荐：

- 直接覆盖现网目录。
- 在未确认部署模型前套用别的服务器发布步骤。
- 用明显落后于现网运行契约的老代码直接进正式环境验证。

- 是否有正在运行的批次或改造任务锁。
- `VIDEO_AIGC_API_KEY` 是否配置。
- `WANGZHUAN_LLM_API_KEY` 或模型网关配置是否可用。
- S3/CDN 是否能从服务端访问。

## 9. 8.219.102.128 容器化发布命令

适用范围：

- 当前正式机 `8.219.102.128`
- 代码目录 `/opt/ad-picture-web-codex`
- 现网老服务保留在 `5177`
- 容器候选版先走 `8000`
- 账号基础继续复用 `/opt/ad-picture-web/users.json`
- 项目数据继续复用 `/opt/ad-picture-web-data`

### 9.1 当前文件约定

- compose 文件：`/opt/ad-picture-web-codex/docker-compose.yml`
- 镜像文件：`/opt/ad-picture-web-codex/Dockerfile`
- 运行配置：`/opt/ad-picture-web-codex/.env`
- 容器版配置：`/opt/ad-picture-web-codex/config.json`
- 共享账号：`/opt/ad-picture-web/users.json`
- 共享项目数据：`/opt/ad-picture-web-data`

### 9.2 首次或更新后启动

先修权限并停掉宿主机版候选服务：

```bash
cd /opt/ad-picture-web-codex
sudo chown root:root .env
sudo chmod 644 .env
sudo systemctl stop ad-picture-web-codex.service
sudo systemctl disable ad-picture-web-codex.service
```

启动容器：

```bash
cd /opt/ad-picture-web-codex
sudo docker-compose down
sudo docker-compose up -d --build
sudo docker-compose ps
```

查看状态：

```bash
sudo docker-compose logs --tail 100 mysql
sudo docker-compose logs --tail 100 app
```

### 9.3 首次空库执行迁移

如果 `aigc-mysql` 是新库，执行：

```bash
cd /opt/ad-picture-web-codex
for f in database/migrations/*.sql; do
  case "$f" in
    *.down.sql|*.verify.sql) continue ;;
  esac
  echo "apply $(basename "$f")"
  sudo docker exec -i aigc-mysql sh -lc "mysql -uroot -paigc_root_dev_only aigc_platform" < "$f"
done
```

验表：

```bash
sudo docker exec -it aigc-mysql sh -lc "mysql -uroot -paigc_root_dev_only -e 'USE aigc_platform; SHOW TABLES;'"
```

### 9.4 启动时序问题处理

如果日志里出现过：

```text
connect ECONNREFUSED <mysql_ip>:3306
```

先确认 MySQL ready：

```bash
sudo docker exec aigc-mysql mysqladmin ping -h 127.0.0.1 -uroot -paigc_root_dev_only --silent
```

返回 `mysqld is alive` 后重启 app：

```bash
cd /opt/ad-picture-web-codex
sudo docker-compose restart app
sleep 5
sudo docker-compose logs --since 30s app
```

### 9.5 验收命令

首页：

```bash
curl -I http://127.0.0.1:8000/
```

登录：

```bash
curl -sS -c /tmp/codex.cookie \
  -H 'Content-Type: application/json' \
  -d '{"username":"admin","password":"admin123"}' \
  http://127.0.0.1:8000/api/login
```

模板接口：

```bash
curl -sS -b /tmp/codex.cookie \
  http://127.0.0.1:8000/api/wangzhuan/templates
```

重点功能：

- 参考视频检查
- 项目切换
- 模板列表
- 当前要合并的 4 个关键页面

### 9.6 当前容器版挂载约定

当前最终版 `docker-compose.yml` 约定：

```yaml
    volumes:
      - ./config.json:/data/app/config.json
      - /opt/ad-picture-web/users.json:/data/users/users.json
      - /opt/ad-picture-web-data:/data/project-data
```

含义：

- `config.json` 可写，支持项目切换写回
- `users.json` 继续作为账号基础文件
- 项目数据挂整个 `/opt/ad-picture-web-data`，避免只挂 `cwz` 导致项目变少

### 9.7 切回 5177

容器版在 `8000` 验收通过后，再切现网：

1. 修改 `.env` 或 compose 端口映射，把 `8000` 切成 `5177`
2. 停老的 `ad-picture-web.service`
3. 重新 `sudo docker-compose up -d`
4. 验 `http://127.0.0.1:5177/`

### 9.8 回滚

容器版有问题时：

```bash
cd /opt/ad-picture-web-codex
sudo docker-compose down
sudo systemctl start ad-picture-web.service
```
