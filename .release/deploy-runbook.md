# AIGC Platform 生产发布 Runbook

`.release` 目录职责说明见 [`README.md`](./README.md)。

正式环境唯一事实来源。排查 SOP 见 [`docs/prod-release-and-triage-sop.md`](../docs/prod-release-and-triage-sop.md)。

## 环境一览

| 项 | 值 |
|---|---|
| 正式机 | `8.219.102.128` |
| JumpServer | `jump.corp.touka.plus:2222` |
| 默认登录 | `liuxuan@dev@8.219.102.128` |
| 应用目录 | `/opt/ad-picture-web-codex` |
| 运行配置 | `/opt/ad-picture-web-codex/config.json` |
| 用户文件 | `/opt/ad-picture-web/users.json` |
| 项目数据 | `/opt/ad-picture-web-data` |
| MySQL 数据 | `/opt/ad-picture-web-codex/mysql-data` |
| 应用端口 | `5177`（`0.0.0.0:5177 -> app:8000`） |
| MySQL 端口 | `127.0.0.1:3307` |
| 容器名 | `aigc-app`、`aigc-mysql` |
| 编排文件 | 线上使用 `.release/docker-compose.prod.yml` 复制为 `docker-compose.yml` |

## 发布原则

- **不要**在正式目录 `git pull`
- **不要**覆盖 `.env`、`config.json`、`users.json`、`mysql-data/`
- **不要**无故重建 `mysql` 容器
- 默认流程：**本地打 tar 包 → SFTP 上传 → 正式机解包 → 只重建 `app`**

## 连接

```bash
# 可选：复制并覆盖本地连接变量
cp .release/env.defaults.sh .release/env.local.sh

bash scripts/jms-ops.sh ssh
```

进入后：

```bash
cd /opt/ad-picture-web-codex
sudo docker-compose ps
curl -I http://127.0.0.1:5177/
```

---

## 方案 A：日常 code-only 发布（推荐，最快）

适用：只改业务代码，**不动** `Dockerfile` / `docker-compose.yml`。

### 本地一条命令

```bash
cd /Users/lucy/Desktop/project/Aigc-platform
bash .release/deploy-local.sh --production code-only
```

等价步骤：

```bash
bash scripts/jms-ops.sh check
bash scripts/package-code-only.sh
bash .release/upload-code-only.sh
```

产物：`.release/ad-picture-web-codex-code-only-YYYYMMDD-HHMMSS.tar.gz`

默认只打运行时白名单：`public/`、`server/`、`database/`、`product_info/`、`scripts/`、`server.mjs`、`package.json`、`package-lock.json`、`config.default.json`、`README.md`。

**不会**打进包：`.env`、`config.json`、`users.json`、`mysql-data/`、`Dockerfile`、`docker-compose.yml`、`node_modules/`、`.git/`、`.release/*.tar.gz`、`.tmp/`、`output/`、`docs/`、`批处理记录/`、`project-data/`

### 包体异常 / 上传卡住处理

2026-06-30 的一次发布中，旧版 code-only 打包逻辑使用“根目录整包 + 排除项”，把非运行时目录带入包内，包体约 `39MB`，SFTP 上传在 JumpServer 上长时间卡住。改为运行时白名单后，包体约 `466KB`，同一套上传和远端部署脚本正常完成。

发布前或上传卡住时先检查：

```bash
ls -lh .release/ad-picture-web-codex-code-only-*.tar.gz | tail
tar -tzf .release/ad-picture-web-codex-code-only-YYYYMMDD-HHMMSS.tar.gz | head
tar -tzf .release/ad-picture-web-codex-code-only-YYYYMMDD-HHMMSS.tar.gz \
  | rg '^(\.superpowers|\.tmp|output|docs|批处理记录|project-data|\.release)/' || true
```

macOS `tar` 可能打印 `LIBARCHIVE.xattr...` 扩展属性提示；只要包内路径正确，这类提示不影响发布。

如果需要手工生成精简包，可使用同一白名单：

```bash
TS=$(date +%Y%m%d-%H%M%S)
PKG=".release/ad-picture-web-codex-code-only-slim-${TS}.tar.gz"
tar -czf "$PKG" public server database product_info scripts server.mjs package.json package-lock.json config.default.json README.md
bash .release/upload-code-only.sh "$PKG"

set -a
source .release/env.defaults.sh
[ -f .release/env.local.sh ] && source .release/env.local.sh
set +a

bash scripts/jms-ops.sh sudo-exec -- \
  "chmod +x /tmp/deploy-code-only-aigc-platform.sh && bash /tmp/deploy-code-only-aigc-platform.sh /tmp/$(basename "$PKG")"
```

### 正式机执行

```bash
sudo su -
chmod +x /tmp/deploy-code-only-aigc-platform.sh
bash /tmp/deploy-code-only-aigc-platform.sh /tmp/ad-picture-web-codex-code-only-YYYYMMDD-HHMMSS.tar.gz
```

脚本会：备份代码目录 → 备份 Docker 镜像 tag → 解包 → `docker-compose build app` → `up -d app` → curl 验收。

可选强制无缓存构建（较慢，排查 Dockerfile 问题时用）：

```bash
DEPLOY_NO_CACHE=1 bash /tmp/deploy-code-only-aigc-platform.sh /tmp/你的包名.tar.gz
```

### 本地尝试全自动（需 JumpServer 允许 sudo 远程命令）

```bash
bash .release/deploy-local.sh code-only --remote
```

---

## 方案 B：全量发布（改 Docker / compose 时）

适用：本次包含 `Dockerfile`、`.release/docker-compose.prod.yml` 或其他容器依赖变更。

### macOS / Git Bash

```bash
bash .release/pack-release.sh
bash .release/upload-release.sh
```

### Windows PowerShell

```powershell
powershell -ExecutionPolicy Bypass -File .release/pack-and-upload.ps1 -Upload
```

产物：`.release/aigc-platform-release.tar.gz`（含 Dockerfile 与 prod compose）

### 正式机执行

```bash
sudo su -
chmod +x /tmp/deploy-aigc-platform.sh
bash /tmp/deploy-aigc-platform.sh
```

脚本会：同步文件到 `/opt/ad-picture-web-codex` → 应用 prod compose → 等待 MySQL healthy → 启动 app。

首次缺 `.env` 时，需先上传 prod env：

```bash
# 本地
PROD_ENV=.release/aigc-platform.prod.env bash .release/upload-release.sh
# 或 PowerShell: -ProdEnvPath .release/aigc-platform.prod.env
```

`.env` 模板：`.release/aigc-platform.prod.env.example`

---

## 发布前检查

```bash
cd /opt/ad-picture-web-codex
sudo docker-compose ps
sudo docker-compose logs --tail 100 app
curl -I http://127.0.0.1:5177/
```

当前服务异常时先排障，不要叠加发布。

## 发布后验收

```bash
sudo docker-compose ps
sudo docker-compose logs --tail 100 app
curl -I http://127.0.0.1:5177/

curl -sS -c /tmp/codex.cookie \
  -H 'Content-Type: application/json' \
  -d '{"username":"<admin-user>","password":"<admin-password>"}' \
  http://127.0.0.1:5177/api/login

curl -sS -b /tmp/codex.cookie http://127.0.0.1:5177/api/wangzhuan/templates
```

如果本机访问 `http://8.219.102.128:5177/...` 超时，不要立即判定发布失败。先通过 SSH 在正式机本地验收：

```bash
curl -fsSI http://127.0.0.1:5177/wangzhuan-v2.html | head -1
curl -fsSI http://127.0.0.1:5177/wangzhuan-tasks.html | head -1
curl -fsS http://127.0.0.1:5177/api/auth
docker-compose ps
```

只要远端本地返回 `200 OK` 且 `aigc-app`、`aigc-mysql` healthy，说明应用本身已经起来；公网超时再单独排查安全组、网络或端口访问链路。

---

## 回滚

### code-only / 全量代码回滚

```bash
sudo su -
ls -lt /opt/release-backup/ad-picture-web-codex-code-*.tar.gz | head
tar -xzf /opt/release-backup/ad-picture-web-codex-code-你的备份时间.tar.gz -C /
cd /opt/ad-picture-web-codex
docker-compose build app && docker-compose up -d app
```

### Docker 镜像回滚（更快，仅 app 起不来且镜像 tag 还在时）

```bash
cd /opt/ad-picture-web-codex
ROLLBACK_TAG="$(cat .last-rollback-tag)"
docker tag "$ROLLBACK_TAG" ad-picture-web-codex-app:latest
docker-compose up -d app
curl -I http://127.0.0.1:5177/
```

---

## 脚本索引

| 脚本 | 作用 |
|---|---|
| `.release/env.defaults.sh` | 连接与路径默认值（可复制为 `env.local.sh`） |
| `scripts/jms-ops.sh` | JumpServer 标准连接 / 上传 / 远端执行封装 |
| `.release/deploy-local.sh` | 本地一键打包+上传 |
| `scripts/package-code-only.sh` | 打 code-only 包 |
| `.release/upload-code-only.sh` | 上传 code-only 包 + 远端脚本 |
| `.release/deploy-code-only-remote.sh` | 正式机：解包 + 只重建 app |
| `.release/pack-release.sh` | 打全量发布包 |
| `.release/upload-release.sh` | 上传全量包 + deploy-remote.sh |
| `.release/deploy-remote.sh` | 正式机：全量同步 + compose 发布 |
| `.release/pack-and-upload.ps1` | Windows 打包/上传 |
| `.release/docker-compose.prod.yml` | 生产 compose 模板 |
| `.release/aigc-platform.prod.env.example` | 生产 `.env` 示例 |

### 运维辅助（非发布主路径）

| 脚本 | 作用 |
|---|---|
| `.release/check-mysql-prod.sh` | MySQL 状态检查 |
| `.release/check-mysql-backup.sh` | 备份检查 |
| `.release/check-liuxuan.sh` | 用户批次/MySQL 抽样 |
| `.release/check-liuxuan-projects.sh` | 项目目录检查 |
| `.release/check-old-data.sh` | 旧数据目录检查 |
| `.release/add-prod-user.mjs` | 添加生产用户 |

---

## 禁止事项

- 正式机 `git pull`
- 删除 `mysql-data` 或重建 `mysql`（除非明确 migration 方案）
- 发布包带入 `.env` / `config.json` / `users.json`
- 不看 `docker-compose ps` 就操作容器

## 常见差异说明（历史遗留）

旧文档曾写 `/root/aigc-platform`、端口 `5182`、账号 `huting@dev@...`。**当前以本 Runbook 为准**。`.release/deploy-remote.sh` 与 `docker-compose.prod.yml` 已对齐 `/opt/ad-picture-web-codex` + `5177`。
