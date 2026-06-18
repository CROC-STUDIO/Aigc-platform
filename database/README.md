# MySQL 数据库设计

本文档说明 MySQL 迁移的设计边界。当前代码已经把账号、登录会话、基础角色、模板、渠道规则、参考视频、拆解、估算、批次、任务、产物、QC、拼接、下载包、幂等、审计和埋点接入 MySQL；JSON/JSONL 文件仍保留为本地文件兼容层和大文件旁路索引。

## 设计原则

- MySQL 保存业务事实、索引、状态和审计；图片、视频、prompt、QC JSON、下载包等大文件继续存磁盘或对象存储，只在 `asset_files` 保存安全相对路径。
- 所有时间字段按 UTC `DATETIME(3)` 写入，前端展示再转换时区。
- 用户密码只保存哈希，session 只保存 token 的 SHA-256，幂等键也只保存哈希。
- 权限不再只依赖 `role = admin/user`，而是 `rbac_roles`、`rbac_permissions`、`user_roles`。
- 状态流转必须同时更新业务表并写 `state_transition_events`，非法流转按 `state_transition_rules` 拒绝。
- 重复提交、上游回调、重试任务都必须落 `idempotency_keys` 或 `task_attempts`，不能只靠内存。

## 业务能力映射

| 现在缺口 | MySQL 事实源 | 应用行为 |
|---|---|---|
| 登录账号曾在 `users.json`，密码明文 | `app_users`, `auth_sessions`, `auth_login_attempts` | 已接入：MySQL 配置存在时密码哈希、会话持久化、失败/成功登录落审计；无 DB 配置时保留旧 JSON 模式 |
| 权限只有 `admin/user` 判断 | RBAC 四张表 + `project_members` | 已接入基础角色：账号管理使用 `user_roles`；细粒度权限和项目成员待后续替换 |
| 用户操作不可审计 | `audit_events`, `state_transition_events` | 管理员改账号/模板、启动/停止/下载都有审计链 |
| 批次状态靠 JSON 和内存 | `workflow_runs`, `workflow_tasks`, `workflow_outputs` | 服务重启后可恢复状态，图库不靠扫目录猜测 |
| 上游 task_id 分散在文件里 | `workflow_tasks`, `task_attempts` | 可按 task_id 对账、排障、重试 |
| 定时任务和重试没有事实源 | `scheduler_jobs`, `resource_locks` | 支持失败重试、上游轮询、运行互斥和过期释放 |
| 重复提交可能重复扣费 | `idempotency_keys` | 同一用户/项目/接口/幂等键只提交一次 |
| QC 和下载包不可追溯 | `qc_reports`, `download_packages`, `download_package_items` | 每个交付包知道包含哪些产物、缺了哪些文件 |

## 表分组

| 分组 | 表 | 解决的问题 |
|---|---|---|
| 迁移 | `app_schema_migrations` | 记录 schema 版本 |
| 身份认证 | `app_users`, `auth_sessions`, `auth_login_attempts` | 已替代 MySQL 模式下的 `users.json` 明文密码和内存 session |
| RBAC | `rbac_roles`, `rbac_permissions`, `rbac_role_permissions`, `user_roles` | 已用于 admin/user 角色；细粒度权限、管理员审计待后续接入 |
| 项目与成员 | `projects`, `project_members` | 支持多项目、用户隔离、项目级权限 |
| 文件索引 | `asset_files` | 保存素材、产物、prompt、QC、包文件的相对路径和探测元数据 |
| 模板与渠道 | `product_templates`, `product_template_versions`, `project_default_template_versions`, `channel_rules` | 替代共享 `templates.json`、`channel-rules.json` |
| 估算与运行 | `reference_videos`, `video_decompositions`, `work_estimates`, `workflow_runs` | 保存估算、参考视频、拆解、批次/remix 主状态 |
| 任务与调度 | `generation_scripts`, `workflow_tasks`, `task_attempts`, `scheduler_jobs`, `resource_locks` | 支持任务状态、上游 task_id、重试、定时轮询、运行互斥 |
| 产物与交付 | `workflow_outputs`, `qc_reports`, `stitch_reports`, `remix_regions`, `download_packages`, `download_package_items` | 支持图库、QC、30s 拼接、预览确认和下载包追溯 |
| 幂等与审计 | `idempotency_keys`, `state_transition_rules`, `state_transition_events`, `audit_events`, `telemetry_events` | 防重复扣费、状态审计、运营指标 |

## 核心状态机

`workflow_runs.status` 覆盖现有合同：

```text
draft -> checking -> queued -> running -> qc -> succeeded
running -> stitching -> qc -> succeeded
qc -> partial_failed / failed
running|stitching -> stopped
qc -> preview_required -> succeeded
```

`workflow_tasks.status` 覆盖单任务：

```text
pending -> queued -> running -> waiting_upstream -> downloaded -> qc -> succeeded
running|waiting_upstream -> failed
queued|running -> stopped
```

应用层建议封装统一函数：

```sql
-- 伪代码：先校验 state_transition_rules，再更新事实表，最后写事件。
UPDATE workflow_runs
SET status = ?, updated_at = CURRENT_TIMESTAMP(3)
WHERE id = ? AND status = ?;

INSERT INTO state_transition_events (...);
```

## 关键查询路径

当前用户项目下运行中的任务：

```sql
SELECT id, run_uid, run_type, status, updated_at
FROM workflow_runs
WHERE project_id = ?
  AND user_id = ?
  AND status IN ('checking', 'queued', 'running', 'stitching', 'qc', 'preview_required')
ORDER BY updated_at DESC
LIMIT 20;
```

图库默认可下载产物：

```sql
SELECT o.output_uid, o.output_kind, o.qc_status, a.storage_relative_path, r.run_uid
FROM workflow_outputs o
JOIN workflow_runs r ON r.id = o.run_id
JOIN asset_files a ON a.id = o.asset_file_id
WHERE r.project_id = ?
  AND r.user_id = ?
  AND o.download_eligible = 1
ORDER BY o.created_at DESC, o.id DESC
LIMIT 50;
```

Worker 认领到期任务：

```sql
START TRANSACTION;

SELECT id
FROM scheduler_jobs
WHERE status = 'pending'
  AND run_after <= UTC_TIMESTAMP(3)
ORDER BY priority ASC, run_after ASC, id ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

UPDATE scheduler_jobs
SET status = 'running',
    locked_by = ?,
    locked_at = UTC_TIMESTAMP(3),
    lock_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 60 SECOND),
    attempts = attempts + 1
WHERE id = ?;

COMMIT;
```

同用户项目运行互斥：

```sql
INSERT INTO resource_locks (
    lock_key, project_id, user_id, lock_type, owner_run_id, status, expires_at
)
VALUES (?, ?, ?, 'upstream_generation', ?, 'active', DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 2 HOUR));
```

释放时只允许持有者释放：

```sql
UPDATE resource_locks
SET status = 'released', released_at = UTC_TIMESTAMP(3)
WHERE lock_key = ?
  AND owner_run_id = ?
  AND status = 'active';
```

## 从现有 JSON 迁移

建议分阶段，不要一次切换所有路径。

1. 新建 MySQL，依次应用 `0001_mysql_foundation.sql`、`0002_scope_runtime_unique_keys.sql`、`0003_scheduler_state_machine_rules.sql`。
2. 已完成：`server/auth-store.mjs` 会在 MySQL 用户为空时读取 `AIGC_USERS_PATH` 的 `users.json`，导入 `app_users`，把明文密码转换为 scrypt 哈希，同时写 `user_roles`。
3. 导入 `config.json` / 项目列表到 `projects`，为已有用户创建 `project_members`。
4. 导入共享 `templates.json`、`channel-rules.json` 到模板和渠道规则表。
5. 导入 `reference-videos`、`estimates`、`batches`、`remix` 目录，只迁移 manifest 和相对路径，文件本体不移动。
6. 已完成核心 facts 层：配置 MySQL 时优先读写 MySQL；未配置 MySQL 时 fallback 读 JSON。后续可以逐步移除 JSON 作为状态事实源，只保留大文件内容。
7. 最后停写 JSON 索引文件，只保留 prompt/QC/package 文件作为资产文件。

## 接入代码顺序

推荐顺序：

1. 已完成：`server/auth-store.mjs` 封装 MySQL 连接池和 JSON fallback，配置来自环境变量，不写死生产账号密码。
2. 已完成：`server/auth-store.mjs` 替换 `loadUsers/saveUsers/authSessions`。
3. 已完成：`server/wangzhuan/mysql-facts.mjs` 承接模板、渠道、参考视频、拆解、估算、workflow run/task/output、QC、拼接、remix 区域、下载包、幂等、审计和埋点。
4. 已完成：`requirePermission` 读取 MySQL 同步出的角色/权限快照，保留 admin 兼容判断。
5. 已完成：`scheduler_jobs` 已接入 worker claim、失败任务重试、完成/失败回写；上游轮询类 job 可继续按同一 worker 扩展。
6. 待后续：读路径全面切到 MySQL 后，停止写 JSON 状态索引，只保留 prompt/QC/package 文件作为 `asset_files` 记录的实体文件。

## 运行配置建议

需要的环境变量示例：

```text
MYSQL_HOST=127.0.0.1
MYSQL_PORT=3306
MYSQL_DATABASE=aigc_platform
MYSQL_USER=aigc_app
MYSQL_PASSWORD=...
MYSQL_CONNECTION_LIMIT=10
```

运行时 MySQL 用户只需要：

```sql
GRANT SELECT, INSERT, UPDATE, DELETE ON aigc_platform.* TO 'aigc_app'@'%';
```

迁移用户单独保留 DDL 权限，应用用户不要授予 `ALL PRIVILEGES` 或 `*.*`。

## 验证

应用迁移前至少执行：

```sql
SELECT VERSION();
SHOW VARIABLES LIKE 'version_comment';

SELECT COUNT(*) AS table_count
FROM information_schema.tables
WHERE table_schema = DATABASE();

SELECT role_key FROM rbac_roles ORDER BY role_key;
SELECT permission_key FROM rbac_permissions ORDER BY permission_key;
SELECT rule_uid FROM channel_rules ORDER BY rule_uid;
```

生产迁移前应在测试库 dry-run，可直接运行 `migrations/0001_mysql_foundation.verify.sql`、`migrations/0002_scope_runtime_unique_keys.verify.sql` 和 `migrations/0003_scheduler_state_machine_rules.verify.sql`，并确认：

- 35 张表创建成功。
- `CHECK` 约束在目标 MySQL 版本生效。建议 MySQL 8.0.30+。
- `channel_rules` 默认 12 条规则存在。
- `state_transition_rules` 覆盖 batch、task、output、scheduler 的主要流转，其中 `scheduler_retry` 和 `scheduler_job running -> pending retry` 已存在。
- 应用日志和审计不出现密码、token、Authorization、Cookie、签名 URL。
- `reference_video_uid`、`estimate_uid`、`run_uid` 等由本地 JSON 序列生成的 ID 已按 project/run 作用域建唯一键，不会因为不同项目都生成 `*_001` 而互相覆盖。

`migrations/0001_mysql_foundation.down.sql` 只用于本地或测试库清理。生产环境已经执行过的迁移不要原地回滚，应该按影响面写新的 forward migration。

## 剩余风险

- 当前仍保留 JSON/JSONL 本地文件兼容层，读路径尚未全面切成只读 MySQL。
- MySQL 5.7 不会满足本设计的 JSON/CHECK 约束预期；不要用 5.7 承载这套 schema。
- 大文件仍在磁盘或对象存储，数据库只能保证相对路径索引存在，不能替代文件备份策略。
- 强承诺收益规则仍需要业务侧校验，不应只依赖 JSON 字段存在。
