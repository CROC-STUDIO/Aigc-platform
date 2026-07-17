# .release 目录说明

这个目录只保留两类内容：

1. 正式发布入口脚本
2. 正式环境相关的模板、说明和辅助检查脚本

不保留：

- 历史发布包 `*.tar.gz`
- 本地私有覆盖配置 `.release/env.local.sh`

## 推荐入口

正式环境业务代码发布（必须显式确认）：

```bash
bash .release/deploy-local.sh --production code-only
```

发布链路现在统一走 JumpServer 标准封装：

- `bash scripts/jms-ops.sh check`
- `bash scripts/jms-ops.sh put ...`
- `bash scripts/jms-ops.sh sudo-exec -- '...'`

`.release` 目录不再各自手写 SSH/SFTP 细节。

默认 code-only 包只包含运行时白名单：

- `public/`
- `server/`
- `database/`
- `scripts/`
- `server.mjs`
- `package.json`
- `package-lock.json`
- `config.default.json`
- `README.md`

这样可以避免把 `.tmp/`、`output/`、`docs/`、`批处理记录/`、`project-data/`、`.release/*.tar.gz` 等非运行时内容带上正式机。

仅当改了 Docker / compose / 容器运行依赖时，才走 full：

```bash
bash .release/deploy-local.sh --production full
```

## 主要文件

- `deploy-local.sh`
  - 本地总入口。负责打包并上传。
- `../scripts/jms-ops.sh`
  - JumpServer 连接、上传、hash 校验、远端执行统一封装。
- `upload-code-only.sh`
  - 上传 code-only 包和远端部署脚本。
- `deploy-code-only-remote.sh`
  - 在正式机解包并只重建 `app`。
- `pack-release.sh`
  - 打 full 发布包。
- `upload-release.sh`
  - 上传 full 发布包。
- `deploy-remote.sh`
  - 在正式机执行 full 发布。
- `deploy-runbook.md`
  - 正式发布 Runbook。
- `env.defaults.sh`
  - 默认连接参数。复制为 `env.local.sh` 做本地覆盖。
- `aigc-platform.prod.env.example`
  - 生产 `.env` 模板。

## 本地私有配置

如需自定义 JumpServer 登录参数：

```bash
cp .release/env.defaults.sh .release/env.local.sh
```

推荐按拆分字段覆盖，而不是只改整条登录串：

```bash
JMS_USER=liuxuan
ASSET_USER=dev
ASSET=8.219.102.128
JMS_KEY=$HOME/.ssh/jumpserver_rsa
```

`env.local.sh` 不提交到 Git。

## 历史包处理

`.release/*.tar.gz` 都视为临时产物，不进版本库。

如果需要清理：

```bash
rm -f .release/*.tar.gz
```

## code-only 包体检查

正常 code-only 包应明显小于全仓库快照。发布前可快速检查：

```bash
ls -lh .release/ad-picture-web-codex-code-only-*.tar.gz | tail
tar -tzf .release/ad-picture-web-codex-code-only-YYYYMMDD-HHMMSS.tar.gz | head
```

如果 SFTP 上传长时间无进度，先看包体大小和包内目录。code-only 包不应该出现 `.superpowers/`、`.tmp/`、`output/`、`docs/`、`批处理记录/`、`project-data/` 或 `.release/`。
