-- Add object-storage metadata to existing asset file facts.
-- Large binaries still live on local disk and/or S3-compatible object storage.

ALTER TABLE asset_files
    ADD COLUMN storage_provider VARCHAR(32) NULL COMMENT '对象存储提供方：s3/minio/oss/cos 等',
    ADD COLUMN storage_bucket VARCHAR(255) NULL COMMENT '对象存储 bucket，不保存凭据',
    ADD COLUMN storage_key VARCHAR(1024) NULL COMMENT '对象存储 key，例如 uploads/project/users/alice/out.png',
    ADD COLUMN storage_url TEXT NULL COMMENT '业务访问 URL，可能是 CDN 或后端代理 URL',
    ADD COLUMN storage_synced_at DATETIME(3) NULL COMMENT '最近一次同步到对象存储的时间，UTC',
    ADD COLUMN storage_deleted_at DATETIME(3) NULL COMMENT '对象存储删除时间，UTC';

CREATE INDEX idx_asset_files_storage_key ON asset_files (storage_key(255));

INSERT INTO app_schema_migrations (version, description)
VALUES ('0002_asset_object_storage', 'Add S3-compatible object storage key and URL metadata to asset_files')
ON DUPLICATE KEY UPDATE applied_at = applied_at;
