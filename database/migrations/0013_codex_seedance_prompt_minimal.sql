CREATE TABLE IF NOT EXISTS codex_prompt_drafts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    prompt_draft_uid VARCHAR(64) NOT NULL COMMENT 'Codex prompt 草稿公开ID，如 cpd_20260709_xxxx',
    batch_uid VARCHAR(64) NOT NULL COMMENT '所属批次公开ID，如 wzb_20260709_xxxx',
    draft_type VARCHAR(24) NOT NULL COMMENT '草稿类型：base/refine',
    version INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '同一草稿版本号，首期固定从 1 开始',
    status VARCHAR(24) NOT NULL COMMENT '状态：drafting/ready/failed/confirmed',
    uses_approved_assets TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否使用了审核通过素材',
    prompt_text MEDIUMTEXT NOT NULL COMMENT '可直接给 Seedance 使用的主 prompt',
    negative_prompt_text MEDIUMTEXT NULL COMMENT '负向提示词',
    reasoning_summary TEXT NULL COMMENT '对前端可见的简短生成说明',
    compliance_checks_json JSON NULL COMMENT '合规检查结果摘要，不保存敏感原始模型输出',
    warnings_json JSON NULL COMMENT '警告信息数组',
    approved_asset_keys_used_json JSON NULL COMMENT '本次实际引用的审核通过素材 key',
    context_json JSON NOT NULL COMMENT '喂给 Codex 的业务上下文快照，禁止保存密钥和原始 CLI 日志',
    context_path VARCHAR(1024) NULL COMMENT '上下文 JSON 文件相对路径，便于排查',
    result_path VARCHAR(1024) NULL COMMENT '结果 JSON 文件相对路径，便于排查',
    request_id VARCHAR(64) NULL COMMENT '触发本次生成的请求ID',
    created_by_user VARCHAR(128) NULL COMMENT '触发生成的用户名或用户ID',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    confirmed_at DATETIME(3) NULL COMMENT '被用户确认用于正式提交的时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_codex_prompt_drafts_uid (prompt_draft_uid),
    KEY idx_codex_prompt_drafts_batch_status (batch_uid, status, updated_at),
    CONSTRAINT ck_codex_prompt_drafts_type CHECK (draft_type IN ('base', 'refine')),
    CONSTRAINT ck_codex_prompt_drafts_status CHECK (status IN ('drafting', 'ready', 'failed', 'confirmed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Codex 生成的 Seedance prompt 草稿表，仅保存结构化结果和上下文快照';

CREATE TABLE IF NOT EXISTS codex_exec_jobs (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '内部自增主键',
    job_uid VARCHAR(64) NOT NULL COMMENT 'Codex 执行任务公开ID，如 cdxjob_20260709_xxxx',
    batch_uid VARCHAR(64) NOT NULL COMMENT '所属批次公开ID',
    prompt_draft_uid VARCHAR(64) NULL COMMENT '关联的 prompt 草稿ID，生成成功后回填',
    job_type VARCHAR(48) NOT NULL COMMENT '任务类型：seedance_prompt_base/seedance_prompt_refine',
    status VARCHAR(24) NOT NULL COMMENT '状态：queued/running/succeeded/failed',
    model_name VARCHAR(64) NOT NULL COMMENT '执行时使用的 Codex 模型名',
    cwd_path VARCHAR(1024) NOT NULL COMMENT '执行工作目录，仅保存安全路径字符串',
    request_id VARCHAR(64) NULL COMMENT '关联请求ID',
    context_path VARCHAR(1024) NULL COMMENT '上下文 JSON 文件相对路径',
    result_path VARCHAR(1024) NULL COMMENT '结构化结果 JSON 文件相对路径',
    stdout_path VARCHAR(1024) NULL COMMENT 'stdout 调试文件相对路径',
    stderr_path VARCHAR(1024) NULL COMMENT 'stderr 调试文件相对路径',
    exit_code INT NULL COMMENT 'Codex 进程退出码',
    duration_ms INT UNSIGNED NULL COMMENT '执行耗时，毫秒',
    error_code VARCHAR(64) NULL COMMENT '失败码，如 model_failed/schema_invalid',
    error_message TEXT NULL COMMENT '失败摘要，不保存完整敏感日志',
    started_at DATETIME(3) NULL COMMENT '开始执行时间，UTC',
    finished_at DATETIME(3) NULL COMMENT '结束执行时间，UTC',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) COMMENT '创建时间，UTC',
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3) COMMENT '更新时间，UTC',
    PRIMARY KEY (id),
    UNIQUE KEY uq_codex_exec_jobs_uid (job_uid),
    KEY idx_codex_exec_jobs_batch_status (batch_uid, status, updated_at),
    KEY idx_codex_exec_jobs_prompt_uid (prompt_draft_uid),
    CONSTRAINT ck_codex_exec_jobs_type CHECK (job_type IN ('seedance_prompt_base', 'seedance_prompt_refine')),
    CONSTRAINT ck_codex_exec_jobs_status CHECK (status IN ('queued', 'running', 'succeeded', 'failed'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
COMMENT='Codex CLI 执行任务记录表，只保存元数据和结果文件路径';

INSERT INTO app_schema_migrations (version, description)
VALUES ('0013_codex_seedance_prompt_minimal', 'Create minimal Codex Seedance prompt draft and exec job tables')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
