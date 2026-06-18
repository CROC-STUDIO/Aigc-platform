-- Touka AI素材中台 MySQL foundation schema.
-- Assumptions:
--   MySQL 8.0.30+ / InnoDB / utf8mb4.
--   Application stores large binaries on disk/object storage and persists only safe relative paths in MySQL.
--   Datetime values are UTC DATETIME(3); the application owns timezone conversion.

CREATE TABLE IF NOT EXISTS app_schema_migrations (
    version VARCHAR(64) NOT NULL COMMENT '迁移版本号，按文件名前缀记录',
    description VARCHAR(255) NOT NULL COMMENT '迁移说明',
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '迁移应用时间，UTC',
    PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='数据库迁移记录表，防止重复执行同一迁移';

CREATE TABLE IF NOT EXISTS app_users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    user_uid VARCHAR(64) NOT NULL COMMENT '应用内稳定用户ID，可由旧 username 迁移生成',
    username VARCHAR(80) NOT NULL COMMENT '登录账号，创建后不建议修改',
    display_name VARCHAR(120) NOT NULL COMMENT '前端展示昵称',
    password_hash VARCHAR(255) NOT NULL COMMENT '密码哈希，禁止保存明文密码',
    password_algo VARCHAR(40) NOT NULL DEFAULT 'argon2id' COMMENT '密码哈希算法，如 argon2id/bcrypt/pbkdf2',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '用户状态：active/disabled/deleted',
    last_login_at DATETIME(3) NULL COMMENT '最近登录时间，UTC',
    password_updated_at DATETIME(3) NULL COMMENT '最近修改密码时间，UTC',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    deleted_at DATETIME(3) NULL COMMENT '软删除时间，用户事实不物理删除',
    PRIMARY KEY (id),
    UNIQUE KEY uq_app_users_user_uid (user_uid),
    UNIQUE KEY uq_app_users_username (username),
    KEY idx_app_users_status_updated (status, updated_at),
    CONSTRAINT ck_app_users_status CHECK (status IN ('active', 'disabled', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='用户账号事实表，替代 users.json，密码只保存哈希';

CREATE TABLE IF NOT EXISTS auth_sessions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    session_uid VARCHAR(64) NOT NULL COMMENT '会话公开ID，用于审计关联，不等于 cookie token',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '所属用户',
    session_token_hash BINARY(32) NOT NULL COMMENT 'cookie token 的 SHA-256 哈希，禁止保存原 token',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '会话状态：active/revoked/expired',
    ip_hash BINARY(32) NULL COMMENT '客户端 IP 哈希，用于安全审计',
    user_agent_hash BINARY(32) NULL COMMENT 'User-Agent 哈希，用于安全审计',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    last_seen_at DATETIME(3) NULL COMMENT '最近访问时间，UTC',
    expires_at DATETIME(3) NOT NULL COMMENT '过期时间，UTC',
    revoked_at DATETIME(3) NULL COMMENT '主动失效时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_auth_sessions_session_uid (session_uid),
    UNIQUE KEY uq_auth_sessions_token_hash (session_token_hash),
    KEY idx_auth_sessions_user_status_expires (user_id, status, expires_at),
    CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT ck_auth_sessions_status CHECK (status IN ('active', 'revoked', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='登录会话表，替代进程内 authSessions Map，支持重启后会话仍可校验';

CREATE TABLE IF NOT EXISTS auth_login_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    username VARCHAR(80) NOT NULL COMMENT '尝试登录账号，可能不存在',
    user_id BIGINT UNSIGNED NULL COMMENT '匹配到的用户，未匹配时为空',
    result VARCHAR(24) NOT NULL COMMENT '结果：succeeded/failed/blocked',
    failure_code VARCHAR(64) NULL COMMENT '失败原因，如 bad_password/disabled/rate_limited',
    ip_hash BINARY(32) NULL COMMENT '客户端 IP 哈希',
    user_agent_hash BINARY(32) NULL COMMENT 'User-Agent 哈希',
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间，UTC',
    PRIMARY KEY (id),
    KEY idx_auth_login_attempts_username_time (username, occurred_at),
    KEY idx_auth_login_attempts_user_time (user_id, occurred_at),
    CONSTRAINT fk_auth_login_attempts_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_auth_login_attempts_result CHECK (result IN ('succeeded', 'failed', 'blocked'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='登录尝试审计表，用于限流、锁定和排查暴力破解';

CREATE TABLE IF NOT EXISTS rbac_roles (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    role_key VARCHAR(64) NOT NULL COMMENT '角色编码，如 user/admin',
    display_name VARCHAR(120) NOT NULL COMMENT '角色名称',
    description VARCHAR(255) NULL COMMENT '角色说明',
    is_system TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否系统内置角色',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_rbac_roles_role_key (role_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='RBAC 角色表，替代单一 role 字段的硬编码权限';

CREATE TABLE IF NOT EXISTS rbac_permissions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    permission_key VARCHAR(96) NOT NULL COMMENT '权限编码，如 batch:create',
    display_name VARCHAR(120) NOT NULL COMMENT '权限名称',
    description VARCHAR(255) NULL COMMENT '权限说明',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_rbac_permissions_permission_key (permission_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='RBAC 权限字典表，权限判断以数据库事实为准';

CREATE TABLE IF NOT EXISTS rbac_role_permissions (
    role_id BIGINT UNSIGNED NOT NULL COMMENT '角色ID',
    permission_id BIGINT UNSIGNED NOT NULL COMMENT '权限ID',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '授权时间，UTC',
    PRIMARY KEY (role_id, permission_id),
    KEY idx_rbac_role_permissions_permission (permission_id),
    CONSTRAINT fk_rbac_role_permissions_role FOREIGN KEY (role_id) REFERENCES rbac_roles (id) ON DELETE RESTRICT,
    CONSTRAINT fk_rbac_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES rbac_permissions (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='角色权限关系表';

CREATE TABLE IF NOT EXISTS user_roles (
    user_id BIGINT UNSIGNED NOT NULL COMMENT '用户ID',
    role_id BIGINT UNSIGNED NOT NULL COMMENT '角色ID',
    granted_by BIGINT UNSIGNED NULL COMMENT '授权操作人',
    granted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '授权时间，UTC',
    PRIMARY KEY (user_id, role_id),
    KEY idx_user_roles_role (role_id),
    KEY idx_user_roles_granted_by (granted_by),
    CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES rbac_roles (id) ON DELETE RESTRICT,
    CONSTRAINT fk_user_roles_granted_by FOREIGN KEY (granted_by) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='用户角色关系表，管理员调整权限写入此表并记录审计';

CREATE TABLE IF NOT EXISTS projects (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    project_uid VARCHAR(64) NOT NULL COMMENT '应用内稳定项目ID',
    project_key VARCHAR(128) NOT NULL COMMENT '项目业务键，建议由项目根目录名或导入时生成',
    display_name VARCHAR(160) NOT NULL COMMENT '项目展示名',
    storage_root_hash CHAR(71) NOT NULL COMMENT '项目共享根路径 SHA-256 摘要，格式 sha256:<hex>',
    storage_root_hint VARCHAR(255) NULL COMMENT '脱敏后的路径提示，不能作为访问授权依据',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '项目状态：active/archived/deleted',
    created_by BIGINT UNSIGNED NULL COMMENT '创建用户',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    deleted_at DATETIME(3) NULL COMMENT '软删除时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_projects_project_uid (project_uid),
    UNIQUE KEY uq_projects_project_key (project_key),
    KEY idx_projects_status_updated (status, updated_at),
    KEY idx_projects_created_by (created_by),
    CONSTRAINT fk_projects_created_by FOREIGN KEY (created_by) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_projects_status CHECK (status IN ('active', 'archived', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='项目事实表，承接当前多项目切换和共享/用户隔离根目录';

CREATE TABLE IF NOT EXISTS project_members (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '项目ID',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '用户ID',
    member_role VARCHAR(32) NOT NULL DEFAULT 'member' COMMENT '项目内角色：owner/admin/member/viewer',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '成员状态：active/disabled/removed',
    user_storage_root_hash CHAR(71) NULL COMMENT '该用户在项目下用户根目录 SHA-256 摘要',
    joined_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '加入时间，UTC',
    removed_at DATETIME(3) NULL COMMENT '移除时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_project_members_project_user (project_id, user_id),
    KEY idx_project_members_user_status (user_id, status),
    CONSTRAINT fk_project_members_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_project_members_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT ck_project_members_role CHECK (member_role IN ('owner', 'admin', 'member', 'viewer')),
    CONSTRAINT ck_project_members_status CHECK (status IN ('active', 'disabled', 'removed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='项目成员表，用于项目级权限和用户数据隔离';

CREATE TABLE IF NOT EXISTS asset_files (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    asset_uid VARCHAR(80) NOT NULL COMMENT '素材或文件公开ID',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '所属项目',
    owner_user_id BIGINT UNSIGNED NULL COMMENT '所属用户，共享素材为空',
    storage_scope VARCHAR(24) NOT NULL COMMENT '存储范围：shared/user/package',
    asset_kind VARCHAR(48) NOT NULL COMMENT '文件类型：role_image/monster_image/product_logo/reference_video/remix_source/output_video/prompt/qc_report/package 等',
    file_name VARCHAR(255) NOT NULL COMMENT '原始或安全文件名',
    mime_type VARCHAR(120) NULL COMMENT 'MIME 类型',
    size_bytes BIGINT UNSIGNED NULL COMMENT '文件大小，字节',
    checksum_sha256 CHAR(64) NULL COMMENT '文件 SHA-256 摘要，用于去重和完整性检查',
    storage_relative_path VARCHAR(1024) NOT NULL COMMENT '相对项目根或用户项目根的安全路径，禁止绝对路径',
    width INT UNSIGNED NULL COMMENT '图片或视频宽度，像素',
    height INT UNSIGNED NULL COMMENT '图片或视频高度，像素',
    duration_sec DECIMAL(10,3) NULL COMMENT '视频时长，秒',
    probe_json JSON NULL COMMENT '媒体探测摘要，不保存凭据或签名 URL',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '文件状态：active/deleted/quarantined',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    deleted_at DATETIME(3) NULL COMMENT '软删除时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_asset_files_project_uid (project_id, asset_uid),
    KEY idx_asset_files_project_kind_created (project_id, asset_kind, created_at),
    KEY idx_asset_files_owner_kind_created (owner_user_id, asset_kind, created_at),
    KEY idx_asset_files_checksum (checksum_sha256),
    CONSTRAINT fk_asset_files_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_asset_files_owner FOREIGN KEY (owner_user_id) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_asset_files_scope CHECK (storage_scope IN ('shared', 'user', 'package')),
    CONSTRAINT ck_asset_files_status CHECK (status IN ('active', 'deleted', 'quarantined')),
    CONSTRAINT ck_asset_files_relative_path CHECK (storage_relative_path NOT LIKE '/%' AND storage_relative_path NOT REGEXP '^[A-Za-z]:[\\\\/]')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='素材与产物文件索引表，MySQL 只保存安全相对路径和元数据，不保存大二进制';

CREATE TABLE IF NOT EXISTS product_templates (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    template_uid VARCHAR(80) NOT NULL COMMENT '模板逻辑ID，如 tpl_cash_001',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '所属项目',
    display_name VARCHAR(160) NOT NULL COMMENT '模板展示名',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '模板状态：active/archived/deleted',
    created_by BIGINT UNSIGNED NULL COMMENT '创建用户',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    deleted_at DATETIME(3) NULL COMMENT '软删除时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_product_templates_project_uid (project_id, template_uid),
    KEY idx_product_templates_project_status (project_id, status, updated_at),
    KEY idx_product_templates_created_by (created_by),
    CONSTRAINT fk_product_templates_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_product_templates_created_by FOREIGN KEY (created_by) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_product_templates_status CHECK (status IN ('active', 'archived', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='产品模板逻辑表，模板版本不可变，批次引用版本快照';

CREATE TABLE IF NOT EXISTS product_template_versions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    template_version_uid VARCHAR(96) NOT NULL COMMENT '模板版本ID，如 tplv_cash_001_0003',
    template_id BIGINT UNSIGNED NOT NULL COMMENT '所属模板',
    version_number INT UNSIGNED NOT NULL COMMENT '模板内递增版本号',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '版本状态：active/archived/deleted',
    product_name VARCHAR(160) NOT NULL COMMENT '产品名，脚本和提示词事实来源',
    cta VARCHAR(255) NOT NULL COMMENT 'CTA 文案',
    ending VARCHAR(255) NOT NULL COMMENT 'ending 文案',
    currency_symbol VARCHAR(16) NOT NULL COMMENT '货币符号',
    language_code VARCHAR(32) NOT NULL COMMENT '语言代码',
    default_output_ratio VARCHAR(16) NOT NULL DEFAULT '9:16' COMMENT '默认输出比例，首期 9:16',
    default_duration_sec SMALLINT UNSIGNED NOT NULL COMMENT '默认时长，15 或 30',
    promise_level VARCHAR(32) NOT NULL COMMENT '承诺级别：stable/strong_conversion/strong_commitment',
    target_channels_json JSON NOT NULL COMMENT '目标渠道数组',
    regions_json JSON NOT NULL COMMENT '目标地区数组',
    truth_rules_json JSON NULL COMMENT '强承诺真实规则字段，禁止保存凭据',
    draft_json JSON NOT NULL COMMENT '完整模板草稿快照，批次启动时复制到 run',
    created_by BIGINT UNSIGNED NULL COMMENT '创建用户',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_template_versions_template_uid (template_id, template_version_uid),
    UNIQUE KEY uq_template_versions_template_number (template_id, version_number),
    KEY idx_template_versions_template_status (template_id, status, created_at),
    KEY idx_template_versions_promise (promise_level, created_at),
    CONSTRAINT fk_template_versions_template FOREIGN KEY (template_id) REFERENCES product_templates (id) ON DELETE RESTRICT,
    CONSTRAINT fk_template_versions_created_by FOREIGN KEY (created_by) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_template_versions_status CHECK (status IN ('active', 'archived', 'deleted')),
    CONSTRAINT ck_template_versions_duration CHECK (default_duration_sec IN (15, 30)),
    CONSTRAINT ck_template_versions_promise CHECK (promise_level IN ('stable', 'strong_conversion', 'strong_commitment'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='产品模板不可变版本表，所有批次保存版本ID和快照';

CREATE TABLE IF NOT EXISTS project_default_template_versions (
    project_id BIGINT UNSIGNED NOT NULL COMMENT '项目ID，每个项目最多一个默认模板版本',
    template_id BIGINT UNSIGNED NOT NULL COMMENT '默认模板',
    template_version_id BIGINT UNSIGNED NOT NULL COMMENT '默认模板版本',
    updated_by BIGINT UNSIGNED NULL COMMENT '最近设置默认版本的用户',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (project_id),
    KEY idx_project_default_template_versions_template (template_id),
    KEY idx_project_default_template_versions_version (template_version_id),
    CONSTRAINT fk_project_default_template_versions_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_project_default_template_versions_template FOREIGN KEY (template_id) REFERENCES product_templates (id) ON DELETE RESTRICT,
    CONSTRAINT fk_project_default_template_versions_version FOREIGN KEY (template_version_id) REFERENCES product_template_versions (id) ON DELETE RESTRICT,
    CONSTRAINT fk_project_default_template_versions_updated_by FOREIGN KEY (updated_by) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='项目默认模板版本表，避免模板表和版本表循环外键';

CREATE TABLE IF NOT EXISTS channel_rules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    project_id BIGINT UNSIGNED NULL COMMENT '项目ID，空表示系统默认规则',
    rule_uid VARCHAR(128) NOT NULL COMMENT '渠道规则ID',
    channel VARCHAR(40) NOT NULL COMMENT '目标渠道',
    promise_level VARCHAR(32) NOT NULL COMMENT '规则适用承诺级别',
    rule_version VARCHAR(40) NOT NULL COMMENT '规则版本，如日期或语义版本',
    cta_strength VARCHAR(16) NOT NULL COMMENT 'CTA 强度：low/medium/high',
    forbidden_terms_json JSON NOT NULL COMMENT '禁用词数组',
    required_disclaimers_json JSON NULL COMMENT '必需免责声明数组',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '规则状态：active/archived',
    fallback_to_rule_id BIGINT UNSIGNED NULL COMMENT 'fallback 规则ID',
    created_by BIGINT UNSIGNED NULL COMMENT '创建用户',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_channel_rules_rule_uid (rule_uid),
    KEY idx_channel_rules_lookup (project_id, channel, promise_level, status, rule_version),
    KEY idx_channel_rules_fallback (fallback_to_rule_id),
    CONSTRAINT fk_channel_rules_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_channel_rules_fallback FOREIGN KEY (fallback_to_rule_id) REFERENCES channel_rules (id) ON DELETE SET NULL,
    CONSTRAINT fk_channel_rules_created_by FOREIGN KEY (created_by) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_channel_rules_channel CHECK (channel IN ('generic', 'meta_ads', 'tiktok_ads', 'google_ads', 'unity_ads', 'iron_source')),
    CONSTRAINT ck_channel_rules_promise CHECK (promise_level IN ('stable', 'strong_conversion')),
    CONSTRAINT ck_channel_rules_cta CHECK (cta_strength IN ('low', 'medium', 'high')),
    CONSTRAINT ck_channel_rules_status CHECK (status IN ('active', 'archived'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='渠道规则表，强转化/稳健默认规则从数据库读取并可审计';

CREATE TABLE IF NOT EXISTS reference_videos (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    reference_video_uid VARCHAR(80) NOT NULL COMMENT '参考视频ID，如 ref_20260617_001',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '所属项目',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '上传用户',
    asset_file_id BIGINT UNSIGNED NOT NULL COMMENT '原视频文件资产',
    status VARCHAR(24) NOT NULL DEFAULT 'pass' COMMENT '检查状态：pass/warn/fail/deleted',
    duration_sec DECIMAL(10,3) NULL COMMENT '视频时长，秒',
    width INT UNSIGNED NULL COMMENT '视频宽度，像素',
    height INT UNSIGNED NULL COMMENT '视频高度，像素',
    ratio VARCHAR(32) NULL COMMENT '宽高比，如 9:16',
    can_extract_frame TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否可抽帧',
    issues_json JSON NULL COMMENT '检查问题列表',
    probe_json JSON NULL COMMENT '媒体探测摘要',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_reference_videos_project_uid (project_id, reference_video_uid),
    KEY idx_reference_videos_project_user_created (project_id, user_id, created_at),
    KEY idx_reference_videos_status_created (status, created_at),
    CONSTRAINT fk_reference_videos_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reference_videos_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_reference_videos_asset FOREIGN KEY (asset_file_id) REFERENCES asset_files (id) ON DELETE RESTRICT,
    CONSTRAINT ck_reference_videos_status CHECK (status IN ('pass', 'warn', 'fail', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='参考视频检查结果表，替代 reference-videos/<id>/probe.json';

CREATE TABLE IF NOT EXISTS video_decompositions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    reference_video_id BIGINT UNSIGNED NOT NULL COMMENT '参考视频ID',
    schema_version VARCHAR(40) NOT NULL COMMENT '拆解 schema 版本',
    status VARCHAR(24) NOT NULL DEFAULT 'succeeded' COMMENT '拆解状态：succeeded/failed/manual_required',
    decomposition_json JSON NOT NULL COMMENT '结构化拆解结果，不保存密钥或签名 URL',
    missing_fields_json JSON NULL COMMENT '缺失字段数组',
    created_by BIGINT UNSIGNED NULL COMMENT '创建用户',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_video_decompositions_reference_schema (reference_video_id, schema_version),
    KEY idx_video_decompositions_status_created (status, created_at),
    CONSTRAINT fk_video_decompositions_reference FOREIGN KEY (reference_video_id) REFERENCES reference_videos (id) ON DELETE RESTRICT,
    CONSTRAINT fk_video_decompositions_created_by FOREIGN KEY (created_by) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_video_decompositions_status CHECK (status IN ('succeeded', 'failed', 'manual_required'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='参考视频拆解事实表，替代 decomposition.json';

CREATE TABLE IF NOT EXISTS work_estimates (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    estimate_uid VARCHAR(80) NOT NULL COMMENT '估算ID，如 est_20260617_001 或 rme_20260617_001',
    estimate_type VARCHAR(24) NOT NULL COMMENT '估算类型：pipeline/remix',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '所属项目',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '创建用户',
    template_version_id BIGINT UNSIGNED NULL COMMENT '模板版本ID',
    reference_video_id BIGINT UNSIGNED NULL COMMENT 'pipeline 参考视频ID',
    source_asset_file_id BIGINT UNSIGNED NULL COMMENT 'remix 源素材资产',
    request_hash CHAR(64) NOT NULL COMMENT '规范化请求 JSON 的 SHA-256，用于 start 阶段防篡改',
    request_json JSON NOT NULL COMMENT '规范化估算请求',
    estimate_json JSON NOT NULL COMMENT '估算结果快照，含模型、任务数、阈值、确认信息',
    confirmation_token_hash BINARY(32) NULL COMMENT '确认 token 哈希，禁止保存原 token',
    confirmation_expires_at DATETIME(3) NULL COMMENT '确认 token 过期时间，UTC',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '估算状态：active/used/expired/canceled',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    used_at DATETIME(3) NULL COMMENT '被 start 消费时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_work_estimates_project_uid (project_id, estimate_uid),
    KEY idx_work_estimates_project_user_created (project_id, user_id, created_at),
    KEY idx_work_estimates_status_expires (status, confirmation_expires_at),
    CONSTRAINT fk_work_estimates_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_work_estimates_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_work_estimates_template_version FOREIGN KEY (template_version_id) REFERENCES product_template_versions (id) ON DELETE RESTRICT,
    CONSTRAINT fk_work_estimates_reference_video FOREIGN KEY (reference_video_id) REFERENCES reference_videos (id) ON DELETE RESTRICT,
    CONSTRAINT fk_work_estimates_source_asset FOREIGN KEY (source_asset_file_id) REFERENCES asset_files (id) ON DELETE RESTRICT,
    CONSTRAINT ck_work_estimates_type CHECK (estimate_type IN ('pipeline', 'remix')),
    CONSTRAINT ck_work_estimates_status CHECK (status IN ('active', 'used', 'expired', 'canceled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='生成/改造估算表，承接 estimate.json 和确认 token';

CREATE TABLE IF NOT EXISTS workflow_runs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    run_uid VARCHAR(80) NOT NULL COMMENT '批次或改造任务ID，如 wzb_... / rmx_...',
    run_type VARCHAR(24) NOT NULL COMMENT '运行类型：pipeline/remix/legacy_ad',
    status VARCHAR(32) NOT NULL DEFAULT 'queued' COMMENT '运行状态，受 state_transition_rules 约束',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '所属项目',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '所有者用户',
    estimate_id BIGINT UNSIGNED NULL COMMENT '来源估算',
    template_version_id BIGINT UNSIGNED NULL COMMENT '模板版本',
    reference_video_id BIGINT UNSIGNED NULL COMMENT 'pipeline 参考视频',
    source_asset_file_id BIGINT UNSIGNED NULL COMMENT 'remix 源素材',
    operation_type VARCHAR(48) NULL COMMENT 'remix 操作类型',
    target_channel VARCHAR(40) NULL COMMENT '目标渠道',
    template_snapshot_json JSON NULL COMMENT '运行时模板快照，历史事实不回读可变模板',
    request_json JSON NULL COMMENT '启动请求快照',
    capability_json JSON NULL COMMENT '能力探测快照',
    qc_summary_json JSON NULL COMMENT 'QC 汇总',
    stop_reason VARCHAR(128) NULL COMMENT '停止原因',
    started_at DATETIME(3) NULL COMMENT '开始时间，UTC',
    finished_at DATETIME(3) NULL COMMENT '结束时间，UTC',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflow_runs_project_uid (project_id, run_uid),
    KEY idx_workflow_runs_project_user_status (project_id, user_id, status, created_at),
    KEY idx_workflow_runs_status_updated (status, updated_at),
    KEY idx_workflow_runs_estimate (estimate_id),
    CONSTRAINT fk_workflow_runs_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_runs_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_runs_estimate FOREIGN KEY (estimate_id) REFERENCES work_estimates (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_runs_template_version FOREIGN KEY (template_version_id) REFERENCES product_template_versions (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_runs_reference_video FOREIGN KEY (reference_video_id) REFERENCES reference_videos (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_runs_source_asset FOREIGN KEY (source_asset_file_id) REFERENCES asset_files (id) ON DELETE RESTRICT,
    CONSTRAINT ck_workflow_runs_type CHECK (run_type IN ('pipeline', 'remix', 'legacy_ad')),
    CONSTRAINT ck_workflow_runs_status CHECK (status IN ('draft', 'checking', 'queued', 'running', 'stitching', 'qc', 'preview_required', 'succeeded', 'partial_failed', 'failed', 'skipped', 'stopped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='工作流运行事实表，替代 batch.json/remix.json 的核心状态';

CREATE TABLE IF NOT EXISTS generation_scripts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    script_uid VARCHAR(80) NOT NULL COMMENT '脚本ID，如 scr_a1b2_001',
    run_id BIGINT UNSIGNED NOT NULL COMMENT '所属运行',
    variant_index INT UNSIGNED NOT NULL COMMENT '变体序号，1-based',
    segment_index INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '分段序号，15s 为 1，30s 为 1 或 2',
    duration_sec SMALLINT UNSIGNED NOT NULL DEFAULT 15 COMMENT '脚本分段时长，首期固定 15',
    hook_text TEXT NOT NULL COMMENT '前 3 秒钩子文案',
    body_text TEXT NOT NULL COMMENT '主体脚本文案',
    cta_text VARCHAR(255) NOT NULL COMMENT 'CTA 文案',
    ending_text VARCHAR(255) NOT NULL COMMENT 'ending 文案',
    reward_expression VARCHAR(255) NULL COMMENT '收益表达，来自 truth rules，不得编造',
    script_asset_file_id BIGINT UNSIGNED NULL COMMENT '脚本 JSON 文件资产',
    prompt_asset_file_id BIGINT UNSIGNED NULL COMMENT 'Seedance prompt 文件资产',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_generation_scripts_run_uid (run_id, script_uid),
    UNIQUE KEY uq_generation_scripts_run_segment (run_id, variant_index, segment_index),
    KEY idx_generation_scripts_run (run_id),
    CONSTRAINT fk_generation_scripts_run FOREIGN KEY (run_id) REFERENCES workflow_runs (id) ON DELETE RESTRICT,
    CONSTRAINT fk_generation_scripts_script_asset FOREIGN KEY (script_asset_file_id) REFERENCES asset_files (id) ON DELETE SET NULL,
    CONSTRAINT fk_generation_scripts_prompt_asset FOREIGN KEY (prompt_asset_file_id) REFERENCES asset_files (id) ON DELETE SET NULL,
    CONSTRAINT ck_generation_scripts_duration CHECK (duration_sec IN (15))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='生成脚本表，替代 scripts/*.json 的可查询索引';

CREATE TABLE IF NOT EXISTS workflow_tasks (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    task_uid VARCHAR(80) NOT NULL COMMENT '内部任务ID，如 gen_a1b2_001',
    run_id BIGINT UNSIGNED NOT NULL COMMENT '所属运行',
    script_id BIGINT UNSIGNED NULL COMMENT '关联脚本',
    task_kind VARCHAR(40) NOT NULL COMMENT '任务类型：image_generation/seedance_video/stitch/remix_provider/qc/package',
    status VARCHAR(32) NOT NULL DEFAULT 'pending' COMMENT '任务状态',
    priority INT NOT NULL DEFAULT 0 COMMENT '调度优先级，数值越小越优先',
    model_image VARCHAR(80) NULL COMMENT '图片模型，如 gpt-image-2',
    model_video VARCHAR(120) NULL COMMENT '视频模型，如 dreamina-seedance-2-0-260128',
    provider VARCHAR(80) NULL COMMENT '上游或本地能力提供方',
    image_task_id VARCHAR(160) NULL COMMENT '上游图片 task_id',
    seedance_task_id VARCHAR(160) NULL COMMENT '上游视频 task_id',
    provider_job_id VARCHAR(160) NULL COMMENT '其他 provider job_id',
    prompt_asset_file_id BIGINT UNSIGNED NULL COMMENT 'prompt 文件资产',
    output_asset_file_id BIGINT UNSIGNED NULL COMMENT '输出文件资产',
    attempts INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已尝试次数',
    max_attempts INT UNSIGNED NOT NULL DEFAULT 2 COMMENT '最大尝试次数，首期失败自动重试一次',
    next_attempt_at DATETIME(3) NULL COMMENT '下次可执行时间，UTC',
    lease_owner VARCHAR(128) NULL COMMENT ' worker 租约持有者',
    lease_expires_at DATETIME(3) NULL COMMENT 'worker 租约过期时间，UTC',
    started_at DATETIME(3) NULL COMMENT '开始时间，UTC',
    finished_at DATETIME(3) NULL COMMENT '结束时间，UTC',
    error_code VARCHAR(80) NULL COMMENT '脱敏错误码',
    error_message VARCHAR(512) NULL COMMENT '脱敏错误信息',
    request_summary_json JSON NULL COMMENT '请求摘要，禁止保存密钥、Authorization、签名 URL',
    response_summary_json JSON NULL COMMENT '响应摘要，禁止保存签名 URL',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflow_tasks_run_uid (run_id, task_uid),
    KEY idx_workflow_tasks_run_status (run_id, status, task_kind),
    KEY idx_workflow_tasks_claim (status, next_attempt_at, priority, id),
    KEY idx_workflow_tasks_upstream (provider, provider_job_id),
    CONSTRAINT fk_workflow_tasks_run FOREIGN KEY (run_id) REFERENCES workflow_runs (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_tasks_script FOREIGN KEY (script_id) REFERENCES generation_scripts (id) ON DELETE SET NULL,
    CONSTRAINT fk_workflow_tasks_prompt_asset FOREIGN KEY (prompt_asset_file_id) REFERENCES asset_files (id) ON DELETE SET NULL,
    CONSTRAINT fk_workflow_tasks_output_asset FOREIGN KEY (output_asset_file_id) REFERENCES asset_files (id) ON DELETE SET NULL,
    CONSTRAINT ck_workflow_tasks_kind CHECK (task_kind IN ('image_generation', 'seedance_video', 'stitch', 'remix_provider', 'qc', 'package')),
    CONSTRAINT ck_workflow_tasks_status CHECK (status IN ('pending', 'queued', 'running', 'waiting_upstream', 'downloaded', 'stitching', 'qc', 'succeeded', 'failed', 'skipped', 'stopped'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='任务事实表，替代 tasks.jsonl 中的当前任务状态，支持 worker claim 和重试';

CREATE TABLE IF NOT EXISTS task_attempts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    task_id BIGINT UNSIGNED NOT NULL COMMENT '所属任务',
    attempt_no INT UNSIGNED NOT NULL COMMENT '第几次尝试，从 1 开始',
    status VARCHAR(24) NOT NULL COMMENT '尝试状态：running/succeeded/failed/canceled',
    provider VARCHAR(80) NULL COMMENT '上游或本地能力提供方',
    upstream_task_id VARCHAR(160) NULL COMMENT '上游 task_id/job_id',
    started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '尝试开始时间，UTC',
    finished_at DATETIME(3) NULL COMMENT '尝试结束时间，UTC',
    latency_ms INT UNSIGNED NULL COMMENT '耗时毫秒',
    error_code VARCHAR(80) NULL COMMENT '脱敏错误码',
    error_message VARCHAR(512) NULL COMMENT '脱敏错误信息',
    retryable TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否可重试',
    request_summary_json JSON NULL COMMENT '请求摘要，禁止保存密钥',
    response_summary_json JSON NULL COMMENT '响应摘要，禁止保存签名 URL',
    PRIMARY KEY (id),
    UNIQUE KEY uq_task_attempts_task_attempt (task_id, attempt_no),
    KEY idx_task_attempts_status_started (status, started_at),
    CONSTRAINT fk_task_attempts_task FOREIGN KEY (task_id) REFERENCES workflow_tasks (id) ON DELETE RESTRICT,
    CONSTRAINT ck_task_attempts_status CHECK (status IN ('running', 'succeeded', 'failed', 'canceled'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='任务尝试流水表，记录每次提交、失败、重试和上游 task_id';

CREATE TABLE IF NOT EXISTS scheduler_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    job_uid VARCHAR(80) NOT NULL COMMENT '调度任务ID',
    job_type VARCHAR(48) NOT NULL COMMENT '调度类型：task_retry/upstream_poll/stitch_retry/session_expire/cleanup',
    status VARCHAR(24) NOT NULL DEFAULT 'pending' COMMENT '调度状态：pending/running/succeeded/failed/canceled',
    run_id BIGINT UNSIGNED NULL COMMENT '关联运行',
    task_id BIGINT UNSIGNED NULL COMMENT '关联任务',
    payload_json JSON NULL COMMENT '调度参数，禁止保存密钥',
    priority INT NOT NULL DEFAULT 0 COMMENT '优先级，数值越小越优先',
    run_after DATETIME(3) NOT NULL COMMENT '最早执行时间，UTC',
    attempts INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '已执行次数',
    max_attempts INT UNSIGNED NOT NULL DEFAULT 3 COMMENT '最大执行次数',
    backoff_strategy VARCHAR(32) NOT NULL DEFAULT 'exponential' COMMENT '退避策略：fixed/exponential/manual',
    locked_by VARCHAR(128) NULL COMMENT 'worker 标识',
    locked_at DATETIME(3) NULL COMMENT '锁定时间，UTC',
    lock_expires_at DATETIME(3) NULL COMMENT '锁过期时间，UTC',
    last_error_code VARCHAR(80) NULL COMMENT '最近错误码',
    last_error_message VARCHAR(512) NULL COMMENT '最近脱敏错误信息',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_scheduler_jobs_uid (job_uid),
    KEY idx_scheduler_jobs_claim (status, run_after, priority, id),
    KEY idx_scheduler_jobs_task_status (task_id, status),
    KEY idx_scheduler_jobs_run_status (run_id, status),
    CONSTRAINT fk_scheduler_jobs_run FOREIGN KEY (run_id) REFERENCES workflow_runs (id) ON DELETE SET NULL,
    CONSTRAINT fk_scheduler_jobs_task FOREIGN KEY (task_id) REFERENCES workflow_tasks (id) ON DELETE SET NULL,
    CONSTRAINT ck_scheduler_jobs_type CHECK (job_type IN ('task_retry', 'upstream_poll', 'stitch_retry', 'session_expire', 'cleanup')),
    CONSTRAINT ck_scheduler_jobs_status CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'canceled')),
    CONSTRAINT ck_scheduler_jobs_backoff CHECK (backoff_strategy IN ('fixed', 'exponential', 'manual'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='定时任务和重试调度表，worker 使用 status/run_after 索引 claim 待执行任务';

CREATE TABLE IF NOT EXISTS workflow_outputs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    output_uid VARCHAR(80) NOT NULL COMMENT '输出ID，如 out_a1b2_001',
    run_id BIGINT UNSIGNED NOT NULL COMMENT '所属运行',
    script_id BIGINT UNSIGNED NULL COMMENT '关联脚本',
    asset_file_id BIGINT UNSIGNED NOT NULL COMMENT '输出文件资产',
    source_type VARCHAR(24) NOT NULL COMMENT '来源：pipeline/remix',
    output_kind VARCHAR(32) NOT NULL COMMENT '输出类型：segment_video/stitched_video/remix_video/image',
    duration_sec SMALLINT UNSIGNED NULL COMMENT '输出时长，秒',
    qc_status VARCHAR(32) NOT NULL DEFAULT 'not_started' COMMENT 'QC 状态',
    download_eligible TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否进入默认下载集',
    visual_preview_required TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否需要人工预览确认',
    preview_confirmed TINYINT(1) NOT NULL DEFAULT 0 COMMENT '人工预览是否确认',
    preview_confirmed_by BIGINT UNSIGNED NULL COMMENT '预览确认用户',
    preview_confirmed_at DATETIME(3) NULL COMMENT '预览确认时间，UTC',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_workflow_outputs_run_uid (run_id, output_uid),
    KEY idx_workflow_outputs_run_qc (run_id, qc_status, download_eligible),
    KEY idx_workflow_outputs_asset (asset_file_id),
    CONSTRAINT fk_workflow_outputs_run FOREIGN KEY (run_id) REFERENCES workflow_runs (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_outputs_script FOREIGN KEY (script_id) REFERENCES generation_scripts (id) ON DELETE SET NULL,
    CONSTRAINT fk_workflow_outputs_asset FOREIGN KEY (asset_file_id) REFERENCES asset_files (id) ON DELETE RESTRICT,
    CONSTRAINT fk_workflow_outputs_preview_user FOREIGN KEY (preview_confirmed_by) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_workflow_outputs_source CHECK (source_type IN ('pipeline', 'remix')),
    CONSTRAINT ck_workflow_outputs_kind CHECK (output_kind IN ('segment_video', 'stitched_video', 'remix_video', 'image')),
    CONSTRAINT ck_workflow_outputs_qc CHECK (qc_status IN ('not_started', 'pass', 'warn', 'fail', 'manual_required'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='输出产物索引表，图库和下载包以此表为事实源';

CREATE TABLE IF NOT EXISTS qc_reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    output_id BIGINT UNSIGNED NOT NULL COMMENT '所属输出',
    report_asset_file_id BIGINT UNSIGNED NULL COMMENT 'QC 报告 JSON 文件资产',
    qc_status VARCHAR(32) NOT NULL COMMENT 'QC 状态',
    checks_json JSON NOT NULL COMMENT 'QC 检查项数组',
    summary VARCHAR(255) NULL COMMENT 'QC 摘要',
    created_by BIGINT UNSIGNED NULL COMMENT '创建用户或系统用户',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_qc_reports_output (output_id),
    KEY idx_qc_reports_status_created (qc_status, created_at),
    CONSTRAINT fk_qc_reports_output FOREIGN KEY (output_id) REFERENCES workflow_outputs (id) ON DELETE RESTRICT,
    CONSTRAINT fk_qc_reports_asset FOREIGN KEY (report_asset_file_id) REFERENCES asset_files (id) ON DELETE SET NULL,
    CONSTRAINT fk_qc_reports_created_by FOREIGN KEY (created_by) REFERENCES app_users (id) ON DELETE SET NULL,
    CONSTRAINT ck_qc_reports_status CHECK (qc_status IN ('not_started', 'pass', 'warn', 'fail', 'manual_required'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='QC 报告事实表，替代 qc/*.json 的查询索引';

CREATE TABLE IF NOT EXISTS stitch_reports (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    output_id BIGINT UNSIGNED NOT NULL COMMENT '30s 拼接输出',
    report_asset_file_id BIGINT UNSIGNED NULL COMMENT '拼接报告 JSON 文件资产',
    status VARCHAR(24) NOT NULL COMMENT '拼接状态：succeeded/failed',
    stitch_tool VARCHAR(80) NULL COMMENT '拼接工具，如 ffmpeg',
    segment_output_ids_json JSON NOT NULL COMMENT '参与拼接的分段 output_uid 数组',
    command_summary VARCHAR(512) NULL COMMENT '脱敏命令摘要，不记录绝对路径和凭据',
    error_code VARCHAR(80) NULL COMMENT '失败错误码',
    error_message VARCHAR(512) NULL COMMENT '脱敏失败信息',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_stitch_reports_output (output_id),
    KEY idx_stitch_reports_status_created (status, created_at),
    CONSTRAINT fk_stitch_reports_output FOREIGN KEY (output_id) REFERENCES workflow_outputs (id) ON DELETE RESTRICT,
    CONSTRAINT fk_stitch_reports_asset FOREIGN KEY (report_asset_file_id) REFERENCES asset_files (id) ON DELETE SET NULL,
    CONSTRAINT ck_stitch_reports_status CHECK (status IN ('succeeded', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='30s 拼接报告表，拼接失败可重试且历史可审计';

CREATE TABLE IF NOT EXISTS remix_regions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    run_id BIGINT UNSIGNED NOT NULL COMMENT '所属 remix 运行',
    region_uid VARCHAR(80) NOT NULL COMMENT '区域ID',
    region_type VARCHAR(24) NOT NULL COMMENT '区域类型：bbox/description',
    label VARCHAR(80) NOT NULL COMMENT '区域标签，如 watermark/logo/cta',
    bbox_x DECIMAL(8,7) NULL COMMENT '归一化 bbox x，0-1',
    bbox_y DECIMAL(8,7) NULL COMMENT '归一化 bbox y，0-1',
    bbox_width DECIMAL(8,7) NULL COMMENT '归一化 bbox width，0-1',
    bbox_height DECIMAL(8,7) NULL COMMENT '归一化 bbox height，0-1',
    description_text TEXT NULL COMMENT '文字描述区域',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_remix_regions_run_uid (run_id, region_uid),
    KEY idx_remix_regions_run_label (run_id, label),
    CONSTRAINT fk_remix_regions_run FOREIGN KEY (run_id) REFERENCES workflow_runs (id) ON DELETE RESTRICT,
    CONSTRAINT ck_remix_regions_type CHECK (region_type IN ('bbox', 'description')),
    CONSTRAINT ck_remix_regions_bbox CHECK (
        (region_type = 'description')
        OR (
            bbox_x BETWEEN 0 AND 1
            AND bbox_y BETWEEN 0 AND 1
            AND bbox_width BETWEEN 0 AND 1
            AND bbox_height BETWEEN 0 AND 1
        )
    )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='竞品改造圈选/描述区域表，替代 regions.json';

CREATE TABLE IF NOT EXISTS download_packages (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    package_uid VARCHAR(80) NOT NULL COMMENT '下载包ID，如 pkg_...',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '所属项目',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '创建用户',
    package_asset_file_id BIGINT UNSIGNED NULL COMMENT 'zip 文件资产，可按需生成后保存',
    status VARCHAR(24) NOT NULL DEFAULT 'succeeded' COMMENT '包状态：succeeded/failed/deleted',
    filters_json JSON NOT NULL COMMENT '下载筛选参数',
    manifest_json JSON NOT NULL COMMENT '下载包 manifest，禁止 remote URL',
    item_count INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '包内产物数量',
    missing_files_json JSON NULL COMMENT '缺失文件列表，成功时应为空',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_download_packages_project_uid (project_id, package_uid),
    KEY idx_download_packages_project_user_created (project_id, user_id, created_at),
    CONSTRAINT fk_download_packages_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_download_packages_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_download_packages_asset FOREIGN KEY (package_asset_file_id) REFERENCES asset_files (id) ON DELETE SET NULL,
    CONSTRAINT ck_download_packages_status CHECK (status IN ('succeeded', 'failed', 'deleted'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='下载包 manifest 表，包完整性和审计以此表为事实源';

CREATE TABLE IF NOT EXISTS download_package_items (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    package_id BIGINT UNSIGNED NOT NULL COMMENT '下载包ID',
    output_id BIGINT UNSIGNED NULL COMMENT '关联输出',
    package_path VARCHAR(512) NOT NULL COMMENT 'zip 内路径',
    diagnostic TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否诊断文件或失败输出',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_download_package_items_path (package_id, package_path),
    KEY idx_download_package_items_output (output_id),
    CONSTRAINT fk_download_package_items_package FOREIGN KEY (package_id) REFERENCES download_packages (id) ON DELETE RESTRICT,
    CONSTRAINT fk_download_package_items_output FOREIGN KEY (output_id) REFERENCES workflow_outputs (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='下载包明细表，用于追溯每个输出在 zip 中的位置';

CREATE TABLE IF NOT EXISTS idempotency_keys (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '用户ID',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '项目ID',
    endpoint VARCHAR(160) NOT NULL COMMENT '接口作用域',
    idempotency_hash BINARY(32) NOT NULL COMMENT '幂等键 SHA-256 哈希，禁止保存原 key',
    request_hash CHAR(64) NOT NULL COMMENT '请求摘要，用于检测同 key 不同请求',
    resource_type VARCHAR(40) NULL COMMENT '结果资源类型，如 batch/remix/package',
    resource_id BIGINT UNSIGNED NULL COMMENT '结果资源内部ID',
    response_json JSON NULL COMMENT '可安全重放的响应摘要，不保存敏感字段',
    status VARCHAR(24) NOT NULL DEFAULT 'succeeded' COMMENT '幂等记录状态：processing/succeeded/failed',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    expires_at DATETIME(3) NOT NULL COMMENT '过期时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_idempotency_scope (user_id, project_id, endpoint, idempotency_hash),
    KEY idx_idempotency_expires (expires_at),
    CONSTRAINT fk_idempotency_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_idempotency_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT ck_idempotency_status CHECK (status IN ('processing', 'succeeded', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='幂等键表，替代 idempotency/*.json，防止重复扣费和重复提交';

CREATE TABLE IF NOT EXISTS state_transition_rules (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    entity_type VARCHAR(40) NOT NULL COMMENT '实体类型：workflow_run/workflow_task/output/scheduler_job',
    from_status VARCHAR(40) NOT NULL COMMENT '来源状态',
    to_status VARCHAR(40) NOT NULL COMMENT '目标状态',
    trigger_name VARCHAR(80) NOT NULL COMMENT '触发事件名称',
    requires_permission VARCHAR(96) NULL COMMENT '所需权限，系统流转可为空',
    is_terminal TINYINT(1) NOT NULL DEFAULT 0 COMMENT '目标状态是否终态',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_state_transition_rules (entity_type, from_status, to_status, trigger_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='状态机允许流转规则表，非法流转必须拒绝并写审计';

CREATE TABLE IF NOT EXISTS state_transition_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    event_uid VARCHAR(80) NOT NULL COMMENT '状态事件ID',
    entity_type VARCHAR(40) NOT NULL COMMENT '实体类型',
    entity_uid VARCHAR(80) NOT NULL COMMENT '实体公开ID，如 run_uid/task_uid/output_uid',
    from_status VARCHAR(40) NULL COMMENT '来源状态，新建时可为空',
    to_status VARCHAR(40) NOT NULL COMMENT '目标状态',
    trigger_name VARCHAR(80) NOT NULL COMMENT '触发事件名称',
    actor_user_id BIGINT UNSIGNED NULL COMMENT '操作用户，系统流转为空',
    reason VARCHAR(255) NULL COMMENT '流转原因',
    request_id VARCHAR(80) NULL COMMENT '请求追踪ID',
    metadata_json JSON NULL COMMENT '脱敏元数据',
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_state_transition_events_uid (event_uid),
    KEY idx_state_transition_events_entity_time (entity_type, entity_uid, occurred_at),
    KEY idx_state_transition_events_actor_time (actor_user_id, occurred_at),
    CONSTRAINT fk_state_transition_events_actor FOREIGN KEY (actor_user_id) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='状态流转事件表，用于审计每一次 batch/task/output 状态变化';

CREATE TABLE IF NOT EXISTS resource_locks (
    lock_key VARCHAR(160) NOT NULL COMMENT '锁键，如 project:<id>:user:<id>:upstream_generation',
    project_id BIGINT UNSIGNED NOT NULL COMMENT '项目ID',
    user_id BIGINT UNSIGNED NOT NULL COMMENT '用户ID',
    lock_type VARCHAR(48) NOT NULL COMMENT '锁类型：upstream_generation/project_write/package_build',
    owner_run_id BIGINT UNSIGNED NULL COMMENT '持有锁的运行',
    status VARCHAR(24) NOT NULL DEFAULT 'active' COMMENT '锁状态：active/released/expired',
    acquired_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '获取时间，UTC',
    expires_at DATETIME(3) NOT NULL COMMENT '锁过期时间，UTC',
    released_at DATETIME(3) NULL COMMENT '释放时间，UTC',
    PRIMARY KEY (lock_key),
    KEY idx_resource_locks_owner (owner_run_id),
    KEY idx_resource_locks_project_user (project_id, user_id, lock_type, status),
    KEY idx_resource_locks_expires (status, expires_at),
    CONSTRAINT fk_resource_locks_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE RESTRICT,
    CONSTRAINT fk_resource_locks_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE RESTRICT,
    CONSTRAINT fk_resource_locks_owner_run FOREIGN KEY (owner_run_id) REFERENCES workflow_runs (id) ON DELETE SET NULL,
    CONSTRAINT ck_resource_locks_type CHECK (lock_type IN ('upstream_generation', 'project_write', 'package_build')),
    CONSTRAINT ck_resource_locks_status CHECK (status IN ('active', 'released', 'expired'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='资源运行锁表，保证同一用户项目同一时间只有一个上游生成类任务';

CREATE TABLE IF NOT EXISTS audit_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    audit_uid VARCHAR(80) NOT NULL COMMENT '审计事件ID',
    project_id BIGINT UNSIGNED NULL COMMENT '关联项目',
    actor_user_id BIGINT UNSIGNED NULL COMMENT '操作用户，系统事件为空',
    actor_role VARCHAR(64) NULL COMMENT '操作时角色快照',
    action VARCHAR(96) NOT NULL COMMENT '动作，如 product_template_admin_changed',
    target_type VARCHAR(64) NOT NULL COMMENT '目标类型，如 user/template/batch/remix',
    target_uid VARCHAR(96) NULL COMMENT '目标公开ID',
    request_id VARCHAR(80) NULL COMMENT '请求追踪ID',
    source_type VARCHAR(64) NULL COMMENT '来源类型',
    source_uid VARCHAR(96) NULL COMMENT '来源公开ID',
    before_json JSON NULL COMMENT '变更前摘要，敏感字段必须脱敏',
    after_json JSON NULL COMMENT '变更后摘要，敏感字段必须脱敏',
    reason VARCHAR(255) NULL COMMENT '操作原因',
    metadata_json JSON NULL COMMENT '脱敏元数据',
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_audit_events_uid (audit_uid),
    KEY idx_audit_events_project_action_time (project_id, action, occurred_at),
    KEY idx_audit_events_actor_time (actor_user_id, occurred_at),
    KEY idx_audit_events_target (target_type, target_uid, occurred_at),
    CONSTRAINT fk_audit_events_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
    CONSTRAINT fk_audit_events_actor FOREIGN KEY (actor_user_id) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='审计事件表，记录用户、权限、模板、批次、下载等关键操作';

CREATE TABLE IF NOT EXISTS telemetry_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    event_uid VARCHAR(80) NOT NULL COMMENT '埋点事件ID',
    event_name VARCHAR(96) NOT NULL COMMENT '事件名',
    project_id BIGINT UNSIGNED NULL COMMENT '关联项目',
    user_id BIGINT UNSIGNED NULL COMMENT '关联用户',
    role_snapshot VARCHAR(64) NULL COMMENT '触发时角色快照',
    request_id VARCHAR(80) NULL COMMENT '请求追踪ID',
    payload_json JSON NOT NULL COMMENT '脱敏 payload，不保存 prompt 原文、密钥、remote URL',
    occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '发生时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_telemetry_events_uid (event_uid),
    KEY idx_telemetry_events_name_time (event_name, occurred_at),
    KEY idx_telemetry_events_project_time (project_id, occurred_at),
    KEY idx_telemetry_events_user_time (user_id, occurred_at),
    CONSTRAINT fk_telemetry_events_project FOREIGN KEY (project_id) REFERENCES projects (id) ON DELETE SET NULL,
    CONSTRAINT fk_telemetry_events_user FOREIGN KEY (user_id) REFERENCES app_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='埋点事件表，替代 telemetry.jsonl，用于完成率、失败率和成本守卫统计';

INSERT INTO rbac_roles (role_key, display_name, description, is_system)
VALUES
    ('user', '普通用户', '可创建自己的批次、改造任务和模板版本', 1),
    ('admin', '管理员', '拥有账号、模板、审计和项目管理权限', 1)
ON DUPLICATE KEY UPDATE
    display_name = VALUES(display_name),
    description = VALUES(description);

INSERT INTO rbac_permissions (permission_key, display_name, description)
VALUES
    ('wangzhuan:view', '查看网赚素材管线', '查看入口、模板、图库'),
    ('template:create_version', '创建模板版本', '新建、复制、编辑模板为新版本'),
    ('template:admin', '管理模板', '删除、改名、设默认、回滚模板'),
    ('batch:create', '创建批次', '创建自己的 pipeline 批次'),
    ('batch:own', '管理自己的批次', '查看、停止、下载自己的批次'),
    ('batch:admin', '管理项目批次', '管理员管理项目内批次'),
    ('remix:create', '创建竞品改造', '创建自己的竞品改造任务'),
    ('remix:own', '管理自己的竞品改造', '查看、确认、下载自己的改造任务'),
    ('remix:admin', '管理项目改造任务', '管理员管理项目内改造任务'),
    ('audit:view', '查看审计', '管理员查看审计事件')
ON DUPLICATE KEY UPDATE
    display_name = VALUES(display_name),
    description = VALUES(description);

INSERT IGNORE INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
CROSS JOIN rbac_permissions p
WHERE r.role_key = 'user'
  AND p.permission_key IN (
    'wangzhuan:view',
    'template:create_version',
    'batch:create',
    'batch:own',
    'remix:create',
    'remix:own'
  );

INSERT IGNORE INTO rbac_role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM rbac_roles r
CROSS JOIN rbac_permissions p
WHERE r.role_key = 'admin';

INSERT INTO channel_rules (
    project_id,
    rule_uid,
    channel,
    promise_level,
    rule_version,
    cta_strength,
    forbidden_terms_json,
    required_disclaimers_json,
    status
)
VALUES
    (NULL, 'rule_generic_stable_v1', 'generic', 'stable', '2026-06-17', 'medium', JSON_ARRAY('guaranteed income', 'instant rich'), JSON_ARRAY('Rewards vary by user'), 'active'),
    (NULL, 'rule_generic_strong_conversion_v1', 'generic', 'strong_conversion', '2026-06-17', 'high', JSON_ARRAY('guaranteed income', 'no risk'), JSON_ARRAY('Rewards are not guaranteed'), 'active'),
    (NULL, 'rule_meta_ads_stable_v1', 'meta_ads', 'stable', '2026-06-17', 'medium', JSON_ARRAY('guaranteed income', 'free money'), JSON_ARRAY('Results vary by user'), 'active'),
    (NULL, 'rule_meta_ads_strong_conversion_v1', 'meta_ads', 'strong_conversion', '2026-06-17', 'high', JSON_ARRAY('guaranteed income', 'instant payout'), JSON_ARRAY('Rewards vary by eligibility'), 'active'),
    (NULL, 'rule_tiktok_ads_stable_v1', 'tiktok_ads', 'stable', '2026-06-17', 'medium', JSON_ARRAY('guaranteed income', 'get rich'), JSON_ARRAY('Rewards vary by user'), 'active'),
    (NULL, 'rule_tiktok_ads_strong_conversion_v1', 'tiktok_ads', 'strong_conversion', '2026-06-17', 'high', JSON_ARRAY('guaranteed income', 'cash guaranteed'), JSON_ARRAY('Actual rewards may vary'), 'active'),
    (NULL, 'rule_google_ads_stable_v1', 'google_ads', 'stable', '2026-06-17', 'low', JSON_ARRAY('guaranteed income', 'misleading rewards'), JSON_ARRAY('Eligibility required'), 'active'),
    (NULL, 'rule_google_ads_strong_conversion_v1', 'google_ads', 'strong_conversion', '2026-06-17', 'medium', JSON_ARRAY('guaranteed income', 'instant wealth'), JSON_ARRAY('Terms apply'), 'active'),
    (NULL, 'rule_unity_ads_stable_v1', 'unity_ads', 'stable', '2026-06-17', 'medium', JSON_ARRAY('guaranteed income', 'free cash'), JSON_ARRAY('Rewards vary'), 'active'),
    (NULL, 'rule_unity_ads_strong_conversion_v1', 'unity_ads', 'strong_conversion', '2026-06-17', 'high', JSON_ARRAY('guaranteed income', 'easy money'), JSON_ARRAY('Rewards vary'), 'active'),
    (NULL, 'rule_iron_source_stable_v1', 'iron_source', 'stable', '2026-06-17', 'medium', JSON_ARRAY('guaranteed income', 'free cash'), JSON_ARRAY('Rewards vary'), 'active'),
    (NULL, 'rule_iron_source_strong_conversion_v1', 'iron_source', 'strong_conversion', '2026-06-17', 'high', JSON_ARRAY('guaranteed income', 'easy money'), JSON_ARRAY('Rewards vary'), 'active')
ON DUPLICATE KEY UPDATE
    rule_version = VALUES(rule_version),
    cta_strength = VALUES(cta_strength),
    forbidden_terms_json = VALUES(forbidden_terms_json),
    required_disclaimers_json = VALUES(required_disclaimers_json),
    status = VALUES(status);

INSERT IGNORE INTO state_transition_rules (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
VALUES
    ('workflow_run', 'draft', 'checking', 'validate_inputs', NULL, 0),
    ('workflow_run', 'checking', 'queued', 'estimate_accepted', NULL, 0),
    ('workflow_run', 'queued', 'running', 'worker_started', NULL, 0),
    ('workflow_run', 'running', 'stitching', 'segments_completed', NULL, 0),
    ('workflow_run', 'running', 'qc', 'generation_completed', NULL, 0),
    ('workflow_run', 'stitching', 'qc', 'stitch_completed', NULL, 0),
    ('workflow_run', 'qc', 'preview_required', 'manual_preview_needed', NULL, 0),
    ('workflow_run', 'qc', 'succeeded', 'qc_passed', NULL, 1),
    ('workflow_run', 'qc', 'partial_failed', 'qc_partial_failed', NULL, 1),
    ('workflow_run', 'qc', 'failed', 'qc_failed', NULL, 1),
    ('workflow_run', 'running', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_run', 'stitching', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_run', 'preview_required', 'succeeded', 'preview_confirm', 'remix:own', 1),
    ('workflow_task', 'pending', 'queued', 'enqueue', NULL, 0),
    ('workflow_task', 'queued', 'running', 'worker_started', NULL, 0),
    ('workflow_task', 'running', 'waiting_upstream', 'submitted_upstream', NULL, 0),
    ('workflow_task', 'waiting_upstream', 'downloaded', 'downloaded_output', NULL, 0),
    ('workflow_task', 'downloaded', 'qc', 'qc_started', NULL, 0),
    ('workflow_task', 'qc', 'succeeded', 'qc_passed', NULL, 1),
    ('workflow_task', 'running', 'failed', 'attempt_exhausted', NULL, 1),
    ('workflow_task', 'waiting_upstream', 'failed', 'upstream_failed', NULL, 1),
    ('workflow_task', 'queued', 'stopped', 'user_stop', 'batch:own', 1),
    ('workflow_task', 'running', 'stopped', 'user_stop', 'batch:own', 1),
    ('output', 'not_started', 'pass', 'qc_passed', NULL, 1),
    ('output', 'not_started', 'warn', 'qc_warned', NULL, 1),
    ('output', 'not_started', 'fail', 'qc_failed', NULL, 1),
    ('output', 'manual_required', 'pass', 'preview_confirm', 'remix:own', 1),
    ('scheduler_job', 'pending', 'running', 'claim', NULL, 0),
    ('scheduler_job', 'running', 'succeeded', 'finish', NULL, 1),
    ('scheduler_job', 'running', 'failed', 'attempt_exhausted', NULL, 1),
    ('scheduler_job', 'pending', 'canceled', 'cancel', NULL, 1);

INSERT INTO app_schema_migrations (version, description)
VALUES ('0001_mysql_foundation', 'Create MySQL foundation schema for auth, RBAC, projects, assets, workflow runs, tasks, retry scheduler, idempotency, audit, telemetry')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
