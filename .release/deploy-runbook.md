# AIGC Platform JumpServer 发布流程

适用：本地 Windows 打包上传，经 JumpServer 登录 **8.219.102.128** 后在 root shell 发布。

## 0. 固定连接信息

PowerShell / Git Bash 通用变量：

```bash
export JMS_HOST="jump.corp.touka.plus"
export JMS_PORT="2222"
export JMS_KEY="$HOME/.ssh/jumpserver_rsa"
export JMS_LOGIN="huting@dev@8.219.102.128"
```

验证 JumpServer 登录：

```bash
ssh -p "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY" -l "$JMS_LOGIN" "$JMS_HOST" 'whoami && hostname && pwd'
```

进入线上机器 root：

```bash
ssh -p "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY" -l "$JMS_LOGIN" "$JMS_HOST"
sudo su -
```

## 1. 本地打包

### 方式 A：PowerShell（推荐）

```powershell
cd C:\Users\hutin\Desktop\project\ai-gc\Aigc-platform

# 仅打包
powershell -ExecutionPolicy Bypass -File .release\pack-and-upload.ps1

# 打包并上传
powershell -ExecutionPolicy Bypass -File .release\pack-and-upload.ps1 -Upload

# 首次部署同时上传 prod env（勿提交 git）
powershell -ExecutionPolicy Bypass -File .release\pack-and-upload.ps1 -Upload -ProdEnvPath .release\aigc-platform.prod.env
```

### 方式 B：Git Bash

```bash
cd /c/Users/hutin/Desktop/project/ai-gc/Aigc-platform
bash .release/pack-release.sh
bash .release/upload-release.sh
```

产物：

- `.release/aigc-platform-release.tar.gz`（上传用）
- `.release/aigc-platform-YYYYMMDD-HHMM-release.tar.gz`（带时间戳备份）

## 2. 本地 SFTP 上传

与 skylink_oms 相同写法：

```bash
printf 'put .release/aigc-platform-release.tar.gz /tmp/aigc-platform-release.tar.gz\nput .release/deploy-remote.sh /tmp/deploy-aigc-platform.sh\nbye\n' | \
sftp -P "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY" -o User="$JMS_LOGIN" "$JMS_HOST"
```

可选上传生产环境变量（首次或变更密钥时）：

```bash
printf 'put .release/aigc-platform.prod.env /tmp/aigc-platform.prod.env\nbye\n' | \
sftp -P "$JMS_PORT" -o IdentitiesOnly=yes -i "$JMS_KEY" -o User="$JMS_LOGIN" "$JMS_HOST"
```

上传后远端验证：

```bash
ls -lh /tmp/aigc-platform-release.tar.gz /tmp/deploy-aigc-platform.sh
tar -tzf /tmp/aigc-platform-release.tar.gz | head -20
```

## 3. 远端首次初始化（仅第一次）

```bash
mkdir -p /root/aigc-platform /opt/ad-picture-web /opt/ad-picture-web-data
cp /path/to/aigc-platform.prod.env /root/aigc-platform/.env   # 或依赖 /tmp/aigc-platform.prod.env 随包上传
chmod 600 /root/aigc-platform/.env
```

`.env` 可参考 `.release/aigc-platform.prod.env.example`，必填：

- `AIGC_MYSQL_*`
- `WANGZHUAN_LLM_API_KEY`
- S3 相关（若启用对象存储）

## 4. 远端发布

```bash
chmod +x /tmp/deploy-aigc-platform.sh
bash /tmp/deploy-aigc-platform.sh
```

脚本会：

1. 备份当前 Docker 镜像 tag
2. 解压 `/tmp/aigc-platform-release.tar.gz` 到 `/root/aigc-platform`
3. 使用 `.release/docker-compose.prod.yml` 作为生产 compose
4. **不覆盖** 已有 `/root/aigc-platform/.env`
5. 保留 `/opt/ad-picture-web-data` 与 `mysql-data` 数据
6. `docker compose build --no-cache app` 后启动 mysql + app

## 5. 发布后验证

```bash
docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}' | grep aigc
curl -fsS http://127.0.0.1:5182/
curl -fsS http://127.0.0.1:5182/api/auth
```

浏览器访问（若已配 nginx 反代则走域名；否则需 SSH 隧道）：

```bash
# 本地开隧道示例
ssh -p 2222 -o IdentitiesOnly=yes -i ~/.ssh/jumpserver_rsa -L 5182:127.0.0.1:5182 -l "huting@dev@8.219.102.128" jump.corp.touka.plus
# 然后打开 http://localhost:5182/
```

## 6. 目录与端口

| 项 | 路径/端口 |
|---|---|
| 应用目录 | `/root/aigc-platform` |
| 运行配置 | `/opt/ad-picture-web/config.json` |
| 用户兼容层 | `/opt/ad-picture-web/users.json` |
| 项目数据 | `/opt/ad-picture-web-data` |
| MySQL 数据 | `/root/aigc-platform/mysql-data` |
| 应用端口 | `127.0.0.1:5182` |
| MySQL 端口 | `127.0.0.1:3307` |

容器名：`aigc-app`、`aigc-mysql`

## 7. 回滚

```bash
cd /root/aigc-platform
ROLLBACK_TAG="$(cat .last-rollback-tag)"
docker tag "$ROLLBACK_TAG" ad-picture-web-codex-app:latest
docker compose up -d app
curl -fsS http://127.0.0.1:5182/
```

## 8. 注意事项

1. 发布包**不要**包含 `.env`、`users.json`、`config.json`（线上各自维护）。
2. `docker compose build` 必须带 `--no-cache`，脚本已内置。
3. 已有 MySQL volume 时，新 migration 需手动执行 `database/migrations/*.sql`。
4. 不要删除 `/opt/ad-picture-web-data`，其中是素材与生成结果。
