import { createHash, randomBytes } from "node:crypto";

let poolPromise = null;

function mysqlConfigFromEnv(env = process.env) {
  if (env.AIGC_DATABASE_URL) {
    const url = new URL(env.AIGC_DATABASE_URL);
    if (!["mysql:", "mysql2:"].includes(url.protocol)) return null;
    return {
      host: url.hostname,
      port: Number(url.port || 3306),
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: url.pathname.replace(/^\//, ""),
      connectionLimit: Number(env.AIGC_DB_CONNECTION_LIMIT || 10)
    };
  }
  const host = env.AIGC_DB_HOST || env.MYSQL_HOST;
  const database = env.AIGC_DB_NAME || env.MYSQL_DATABASE;
  const user = env.AIGC_DB_USER || env.MYSQL_USER;
  if (!host && !database && !user) return null;
  if (!host || !database || !user) return null;
  return {
    host,
    port: Number(env.AIGC_DB_PORT || env.MYSQL_PORT || 3306),
    user,
    password: env.AIGC_DB_PASSWORD || env.MYSQL_PASSWORD || "",
    database,
    connectionLimit: Number(env.AIGC_DB_CONNECTION_LIMIT || 10)
  };
}

async function getPool() {
  if (poolPromise) return poolPromise;
  const config = mysqlConfigFromEnv();
  if (!config) return null;
  poolPromise = import("mysql2/promise").then((mysql) => mysql.createPool({
    ...config,
    waitForConnections: true,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 30000,
    timezone: "Z"
  }));
  return poolPromise;
}

export async function closeWangzhuanFactsPool() {
  const pool = poolPromise ? await poolPromise : null;
  poolPromise = null;
  await pool?.end?.();
}

export function setWangzhuanFactsPoolForTest(pool) {
  poolPromise = pool ? Promise.resolve(pool) : null;
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function sha256Buffer(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function uid(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function json(value, fallback = {}) {
  return JSON.stringify(value ?? fallback);
}

function parseJsonValue(value, fallback = null) {
  if (value === undefined || value === null || value === "") return structuredClone(fallback);
  if (Buffer.isBuffer(value)) return parseJsonValue(value.toString("utf8"), fallback);
  if (typeof value === "object") return structuredClone(value);
  try {
    return JSON.parse(String(value));
  } catch {
    return structuredClone(fallback);
  }
}

function mysqlDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function isoDate(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  const text = String(value);
  const normalized = /^\d{4}-\d{2}-\d{2} /.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? text : date.toISOString();
}

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function currentRole(context) {
  const user = context.user ?? context.currentUser?.() ?? null;
  return user?.isAdmin || user?.role === "admin" ? "admin" : "user";
}

function projectRoot(context) {
  return context.userProjectRoot ?? context.currentProjectRoot?.() ?? "";
}

function baseProjectRoot(context) {
  return context.sharedProjectRoot ?? context.currentBaseProjectRoot?.() ?? projectRoot(context);
}

function displayNameForProject(context) {
  return context.projectName || "current_project";
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "skipped", "stopped"]);

const SAME_STATUS_TRIGGERS = Object.freeze([
  "batch_write",
  "batch_created",
  "qc_completed",
  "stitch_progress",
  "remix_write"
]);

const RUN_STATUSES = Object.freeze([
  "draft",
  "checking",
  "queued",
  "running",
  "stitching",
  "qc",
  "preview_required",
  "succeeded",
  "partial_failed",
  "failed",
  "skipped",
  "stopped"
]);

const TASK_STATUSES = Object.freeze([
  "pending",
  "queued",
  "running",
  "waiting_upstream",
  "downloaded",
  "stitching",
  "qc",
  "succeeded",
  "failed",
  "skipped",
  "stopped"
]);

const STATE_TRANSITION_RULES = Object.freeze([
  ["workflow_run", "__new__", "queued", "batch_created", null, 0],
  ["workflow_run", "__new__", "queued", "remix_write", null, 0],
  ["workflow_run", "__new__", "running", "remix_write", null, 0],
  ["workflow_run", "__new__", "preview_required", "remix_write", null, 0],
  ["workflow_run", "__new__", "failed", "remix_write", null, 1],
  ["workflow_run", "draft", "checking", "validate_inputs", null, 0],
  ["workflow_run", "checking", "queued", "estimate_accepted", null, 0],
  ["workflow_run", "queued", "running", "worker_started", null, 0],
  ["workflow_run", "queued", "running", "batch_write", null, 0],
  ["workflow_run", "queued", "stitching", "stitch_progress", null, 0],
  ["workflow_run", "running", "stitching", "stitch_progress", null, 0],
  ["workflow_run", "running", "stitching", "segments_completed", null, 0],
  ["workflow_run", "running", "qc", "generation_completed", null, 0],
  ["workflow_run", "running", "qc", "stitch_progress", null, 0],
  ["workflow_run", "stitching", "partial_failed", "stitch_progress", null, 1],
  ["workflow_run", "partial_failed", "stitching", "stitch_progress", null, 0],
  ["workflow_run", "partial_failed", "qc", "stitch_progress", null, 0],
  ["workflow_run", "stitching", "qc", "stitch_completed", null, 0],
  ["workflow_run", "running", "succeeded", "qc_completed", null, 1],
  ["workflow_run", "running", "partial_failed", "qc_completed", null, 1],
  ["workflow_run", "running", "failed", "qc_completed", null, 1],
  ["workflow_run", "qc", "succeeded", "qc_completed", null, 1],
  ["workflow_run", "qc", "partial_failed", "qc_completed", null, 1],
  ["workflow_run", "qc", "failed", "qc_completed", null, 1],
  ["workflow_run", "queued", "preview_required", "remix_write", null, 0],
  ["workflow_run", "running", "preview_required", "remix_write", null, 0],
  ["workflow_run", "qc", "preview_required", "remix_write", null, 0],
  ["workflow_run", "queued", "failed", "remix_write", null, 1],
  ["workflow_run", "running", "failed", "remix_write", null, 1],
  ["workflow_run", "preview_required", "failed", "remix_write", null, 1],
  ["workflow_run", "queued", "stopped", "user_stop", "batch:own", 1],
  ["workflow_run", "qc", "preview_required", "manual_preview_needed", null, 0],
  ["workflow_run", "qc", "succeeded", "qc_passed", null, 1],
  ["workflow_run", "qc", "partial_failed", "qc_partial_failed", null, 1],
  ["workflow_run", "qc", "failed", "qc_failed", null, 1],
  ["workflow_run", "running", "stopped", "user_stop", "batch:own", 1],
  ["workflow_run", "stitching", "stopped", "user_stop", "batch:own", 1],
  ["workflow_run", "qc", "stopped", "user_stop", "batch:own", 1],
  ["workflow_run", "preview_required", "stopped", "user_stop", "remix:own", 1],
  ["workflow_run", "preview_required", "succeeded", "preview_confirm", "remix:own", 1],
  ["workflow_run", "preview_required", "succeeded", "remix_write", "remix:own", 1],
  ["workflow_task", "__new__", "pending", "batch_created", null, 0],
  ["workflow_task", "__new__", "pending", "batch_write", null, 0],
  ["workflow_task", "__new__", "queued", "remix_write", null, 0],
  ["workflow_task", "__new__", "running", "remix_write", null, 0],
  ["workflow_task", "__new__", "qc", "remix_write", null, 0],
  ["workflow_task", "__new__", "succeeded", "remix_write", null, 1],
  ["workflow_task", "__new__", "failed", "remix_write", null, 1],
  ["workflow_task", "pending", "queued", "enqueue", null, 0],
  ["workflow_task", "queued", "running", "worker_started", null, 0],
  ["workflow_task", "running", "waiting_upstream", "submitted_upstream", null, 0],
  ["workflow_task", "pending", "waiting_upstream", "batch_write", null, 0],
  ["workflow_task", "waiting_upstream", "pending", "scheduler_retry", null, 0],
  ["workflow_task", "failed", "pending", "scheduler_retry", null, 0],
  ["workflow_task", "failed", "waiting_upstream", "scheduler_retry", null, 0],
  ["workflow_task", "waiting_upstream", "downloaded", "downloaded_output", null, 0],
  ["workflow_task", "waiting_upstream", "downloaded", "stitch_progress", null, 0],
  ["workflow_task", "waiting_upstream", "qc", "stitch_progress", null, 0],
  ["workflow_task", "downloaded", "qc", "stitch_progress", null, 0],
  ["workflow_task", "downloaded", "qc", "qc_started", null, 0],
  ["workflow_task", "qc", "succeeded", "qc_passed", null, 1],
  ["workflow_task", "running", "failed", "attempt_exhausted", null, 1],
  ["workflow_task", "waiting_upstream", "failed", "upstream_failed", null, 1],
  ["workflow_task", "pending", "failed", "batch_write", null, 1],
  ["workflow_task", "waiting_upstream", "failed", "batch_write", null, 1],
  ["workflow_task", "qc", "failed", "batch_write", null, 1],
  ["workflow_task", "queued", "stopped", "user_stop", "batch:own", 1],
  ["workflow_task", "pending", "stopped", "user_stop", "batch:own", 1],
  ["workflow_task", "waiting_upstream", "stopped", "user_stop", "batch:own", 1],
  ["workflow_task", "downloaded", "stopped", "user_stop", "batch:own", 1],
  ["workflow_task", "qc", "stopped", "user_stop", "batch:own", 1],
  ["workflow_task", "running", "stopped", "user_stop", "batch:own", 1],
  ["output", "not_started", "pass", "qc_passed", null, 1],
  ["output", "not_started", "warn", "qc_warned", null, 1],
  ["output", "not_started", "fail", "qc_failed", null, 1],
  ["output", "manual_required", "pass", "preview_confirm", "remix:own", 1],
  ["scheduler_job", "pending", "running", "claim", null, 0],
  ["scheduler_job", "running", "succeeded", "finish", null, 1],
  ["scheduler_job", "running", "failed", "attempt_exhausted", null, 1],
  ["scheduler_job", "running", "pending", "retry", null, 0],
  ["scheduler_job", "pending", "canceled", "cancel", null, 1],
  ...RUN_STATUSES.flatMap((status) => SAME_STATUS_TRIGGERS.map((trigger) => ["workflow_run", status, status, trigger, null, TERMINAL_STATUSES.has(status) ? 1 : 0])),
  ...TASK_STATUSES.flatMap((status) => SAME_STATUS_TRIGGERS.map((trigger) => ["workflow_task", status, status, trigger, null, TERMINAL_STATUSES.has(status) ? 1 : 0]))
]);

async function ensureStateTransitionRules(conn) {
  for (const rule of STATE_TRANSITION_RULES) {
    await conn.execute(
      `INSERT IGNORE INTO state_transition_rules
        (entity_type, from_status, to_status, trigger_name, requires_permission, is_terminal)
      VALUES (?, ?, ?, ?, ?, ?)`,
      rule
    );
  }
}

async function ensureUser(conn, context) {
  const username = currentUserId(context);
  const [rows] = await conn.execute(
    "SELECT id FROM app_users WHERE username = ? AND deleted_at IS NULL LIMIT 1",
    [username]
  );
  if (rows.length) return rows[0].id;

  await conn.execute(
    `INSERT INTO app_users
      (user_uid, username, display_name, password_hash, password_algo, status, password_updated_at)
    VALUES (?, ?, ?, ?, 'external', 'active', UTC_TIMESTAMP(3))`,
    [uid("usr"), username, context.user?.displayName || username, `external:${sha256Hex(username)}`]
  );
  const [created] = await conn.execute(
    "SELECT id FROM app_users WHERE username = ? AND deleted_at IS NULL LIMIT 1",
    [username]
  );
  const [roleRows] = await conn.execute(
    "SELECT id FROM rbac_roles WHERE role_key = ? LIMIT 1",
    [currentRole(context)]
  );
  if (roleRows.length) {
    await conn.execute(
      "INSERT IGNORE INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, NULL)",
      [created[0].id, roleRows[0].id]
    );
  }
  return created[0].id;
}

async function ensureProject(conn, context, userId) {
  const root = baseProjectRoot(context);
  const projectKey = `root:${sha256Hex(root)}`;
  const [rows] = await conn.execute(
    "SELECT id FROM projects WHERE project_key = ? AND deleted_at IS NULL LIMIT 1",
    [projectKey]
  );
  if (rows.length) return rows[0].id;

  await conn.execute(
    `INSERT INTO projects
      (project_uid, project_key, display_name, storage_root_hash, storage_root_hint, status, created_by)
    VALUES (?, ?, ?, ?, ?, 'active', ?)`,
    [uid("prj"), projectKey, displayNameForProject(context), `sha256:${sha256Hex(root)}`, displayNameForProject(context), userId]
  );
  const [created] = await conn.execute(
    "SELECT id FROM projects WHERE project_key = ? AND deleted_at IS NULL LIMIT 1",
    [projectKey]
  );
  return created[0].id;
}

async function ensureProjectMember(conn, context, projectId, userId) {
  await conn.execute(
    `INSERT INTO project_members
      (project_id, user_id, member_role, status, user_storage_root_hash)
    VALUES (?, ?, ?, 'active', ?)
    ON DUPLICATE KEY UPDATE status = 'active', user_storage_root_hash = VALUES(user_storage_root_hash)`,
    [projectId, userId, currentRole(context) === "admin" ? "admin" : "member", `sha256:${sha256Hex(projectRoot(context))}`]
  );
}

async function ensureContextFacts(conn, context) {
  const userId = await ensureUser(conn, context);
  const projectId = await ensureProject(conn, context, userId);
  await ensureProjectMember(conn, context, projectId, userId);
  return { userId, projectId };
}

async function findTemplateId(conn, projectId, templateUid) {
  const [rows] = await conn.execute(
    "SELECT id FROM product_templates WHERE project_id = ? AND template_uid = ? LIMIT 1",
    [projectId, templateUid]
  );
  return rows[0]?.id ?? null;
}

async function findTemplateVersionId(conn, templateId, versionUid) {
  const [rows] = await conn.execute(
    "SELECT id FROM product_template_versions WHERE template_id = ? AND template_version_uid = ? LIMIT 1",
    [templateId, versionUid]
  );
  return rows[0]?.id ?? null;
}

function templateDisplayName(template) {
  return String(template?.draft?.displayName || template?.displayName || template?.templateId || "Untitled template").slice(0, 160);
}

function templateVersionStatus(template) {
  return ["active", "archived", "deleted"].includes(template?.status) ? template.status : "active";
}

async function upsertTemplateFact(conn, facts, template) {
  await conn.execute(
    `INSERT INTO product_templates
      (template_uid, project_id, display_name, status, created_by, created_at, updated_at, deleted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      display_name = VALUES(display_name),
      status = VALUES(status),
      updated_at = VALUES(updated_at),
      deleted_at = VALUES(deleted_at)`,
    [
      template.templateId,
      facts.projectId,
      templateDisplayName(template),
      templateVersionStatus(template),
      facts.userId,
      mysqlDate(template.createdAt) || mysqlDate(new Date()),
      mysqlDate(template.updatedAt) || mysqlDate(new Date()),
      template.status === "deleted" ? (mysqlDate(template.updatedAt) || mysqlDate(new Date())) : null
    ]
  );
  return findTemplateId(conn, facts.projectId, template.templateId);
}

async function upsertTemplateVersionFact(conn, facts, templateId, template) {
  const draft = template.draft || {};
  await conn.execute(
    `INSERT INTO product_template_versions
      (template_version_uid, template_id, version_number, status, product_name, cta, ending, currency_symbol,
       language_code, default_output_ratio, default_duration_sec, promise_level, target_channels_json, regions_json,
       truth_rules_json, draft_json, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      status = VALUES(status),
      product_name = VALUES(product_name),
      cta = VALUES(cta),
      ending = VALUES(ending),
      currency_symbol = VALUES(currency_symbol),
      language_code = VALUES(language_code),
      default_output_ratio = VALUES(default_output_ratio),
      default_duration_sec = VALUES(default_duration_sec),
      promise_level = VALUES(promise_level),
      target_channels_json = VALUES(target_channels_json),
      regions_json = VALUES(regions_json),
      truth_rules_json = VALUES(truth_rules_json),
      draft_json = VALUES(draft_json)`,
    [
      template.versionId,
      templateId,
      Number(template.versionNumber || 1),
      templateVersionStatus(template),
      String(draft.productName || draft.displayName || template.templateId || "Product").slice(0, 160),
      String(draft.cta || "").slice(0, 255),
      String(draft.ending || "").slice(0, 255),
      String(draft.currencySymbol || "").slice(0, 16),
      String(draft.language || "").slice(0, 32),
      String(draft.defaultOutputRatio || "9:16").slice(0, 16),
      Number(draft.defaultDurationSec || 15),
      String(draft.promiseLevel || "stable").slice(0, 32),
      json(Array.isArray(draft.targetChannels) ? draft.targetChannels : []),
      json(Array.isArray(draft.regions) ? draft.regions : []),
      draft.truthRules ? json(draft.truthRules) : null,
      json(draft),
      facts.userId,
      mysqlDate(template.createdAt) || mysqlDate(new Date())
    ]
  );
  return findTemplateVersionId(conn, templateId, template.versionId);
}

function nextTemplateSeqFromStore(templates) {
  let max = 0;
  for (const template of templates) {
    const match = String(template.templateId || "").match(/_(\d+)$/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1 || 1;
}

function rowIsDefault(row) {
  return row?.is_default === 1 || row?.is_default === true || row?.is_default === "1";
}

function templateRowToStoreItem(row) {
  const draft = parseJsonValue(row.draft_json, {});
  return {
    templateId: row.template_uid,
    versionId: row.template_version_uid,
    versionNumber: Number(row.version_number || 1),
    status: row.version_status || row.template_status || "active",
    isDefault: rowIsDefault(row),
    draft: {
      displayName: row.display_name,
      ...draft
    },
    createdBy: row.created_by_username || "mysql",
    createdAt: isoDate(row.version_created_at || row.template_created_at),
    updatedAt: isoDate(row.template_updated_at || row.version_created_at || row.template_created_at)
  };
}

export async function syncTemplateStoreFacts(context, store) {
  const pool = await getPool();
  if (!pool || !Array.isArray(store?.templates)) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    let defaultTemplateVersionDbId = null;
    let defaultTemplateDbId = null;
    for (const template of store.templates) {
      if (!template?.templateId || !template?.versionId) continue;
      const templateDbId = await upsertTemplateFact(conn, facts, template);
      const versionDbId = await upsertTemplateVersionFact(conn, facts, templateDbId, template);
      if ((store.defaultTemplateId && template.templateId === store.defaultTemplateId) || template.isDefault) {
        defaultTemplateDbId = templateDbId;
        defaultTemplateVersionDbId = versionDbId;
      }
    }
    if (defaultTemplateDbId && defaultTemplateVersionDbId) {
      await conn.execute(
        `INSERT INTO project_default_template_versions
          (project_id, template_id, template_version_id, updated_by, updated_at)
        VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          template_id = VALUES(template_id),
          template_version_id = VALUES(template_version_id),
          updated_by = VALUES(updated_by),
          updated_at = VALUES(updated_at)`,
        [facts.projectId, defaultTemplateDbId, defaultTemplateVersionDbId, facts.userId]
      );
    }
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to sync templates: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

export async function loadTemplateStoreFromMysql(context) {
  const pool = await getPool();
  if (!pool) return null;
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const [rows] = await conn.execute(
      `SELECT
        pt.template_uid,
        pt.display_name,
        pt.status AS template_status,
        pt.created_at AS template_created_at,
        pt.updated_at AS template_updated_at,
        pv.template_version_uid,
        pv.version_number,
        pv.status AS version_status,
        pv.draft_json,
        au.username AS created_by_username,
        pv.created_at AS version_created_at,
        CASE WHEN pdtv.template_version_id = pv.id THEN 1 ELSE 0 END AS is_default
      FROM product_templates pt
      JOIN product_template_versions pv ON pv.template_id = pt.id
      LEFT JOIN project_default_template_versions pdtv
        ON pdtv.project_id = pt.project_id AND pdtv.template_version_id = pv.id
      LEFT JOIN app_users au ON au.id = pv.created_by
      WHERE pt.project_id = ?
        AND pt.deleted_at IS NULL
      ORDER BY pt.template_uid ASC, pv.version_number ASC`,
      [facts.projectId]
    );
    if (!rows.length) return null;
    const templates = rows.map(templateRowToStoreItem);
    const defaultTemplateId = templates.find((template) => template.isDefault)?.templateId || "";
    return {
      schemaVersion: "templates.v1",
      defaultTemplateId,
      nextTemplateSeq: nextTemplateSeqFromStore(templates),
      templates
    };
  } catch (error) {
    console.warn(`[mysql-facts] failed to load templates: ${error.message}`);
    return null;
  } finally {
    conn.release();
  }
}

function channelRuleStatus(rule) {
  return ["active", "archived"].includes(rule?.status) ? rule.status : "active";
}

function channelRuleRowToRule(row) {
  return {
    ruleId: row.rule_uid,
    channel: row.channel,
    promiseLevel: row.promise_level,
    version: row.rule_version,
    forbiddenTerms: parseJsonValue(row.forbidden_terms_json, []),
    requiredDisclaimers: parseJsonValue(row.required_disclaimers_json, []),
    ctaStrength: row.cta_strength,
    fallbackUsed: false
  };
}

export async function syncChannelRuleStoreFacts(context, store) {
  const pool = await getPool();
  if (!pool || !Array.isArray(store?.rules)) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    for (const rule of store.rules) {
      if (!rule?.ruleId || !rule?.channel || !rule?.promiseLevel) continue;
      await conn.execute(
        `INSERT INTO channel_rules
          (project_id, rule_uid, channel, promise_level, rule_version, cta_strength,
           forbidden_terms_json, required_disclaimers_json, status, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          rule_version = VALUES(rule_version),
          cta_strength = VALUES(cta_strength),
          forbidden_terms_json = VALUES(forbidden_terms_json),
          required_disclaimers_json = VALUES(required_disclaimers_json),
          status = VALUES(status),
          updated_at = UTC_TIMESTAMP(3)`,
        [
          facts.projectId,
          rule.ruleId,
          rule.channel,
          rule.promiseLevel,
          rule.version || "local",
          rule.ctaStrength || "medium",
          json(Array.isArray(rule.forbiddenTerms) ? rule.forbiddenTerms : []),
          json(Array.isArray(rule.requiredDisclaimers) ? rule.requiredDisclaimers : []),
          channelRuleStatus(rule),
          facts.userId
        ]
      );
    }
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to sync channel rules: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

export async function loadChannelRuleStoreFromMysql(context) {
  const pool = await getPool();
  if (!pool) return null;
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const [rows] = await conn.execute(
      `SELECT
        rule_uid,
        channel,
        promise_level,
        rule_version,
        cta_strength,
        forbidden_terms_json,
        required_disclaimers_json,
        status
      FROM channel_rules
      WHERE status = 'active'
        AND (project_id = ? OR project_id IS NULL)
      ORDER BY
        CASE WHEN project_id = ? THEN 0 ELSE 1 END,
        channel ASC,
        promise_level ASC,
        rule_version DESC`,
      [facts.projectId, facts.projectId]
    );
    if (!rows.length) return null;
    const byKey = new Map();
    for (const row of rows) {
      const key = `${row.channel}:${row.promise_level}`;
      if (!byKey.has(key)) byKey.set(key, channelRuleRowToRule(row));
    }
    return {
      schemaVersion: "channel-rules.v1",
      rules: [...byKey.values()]
    };
  } catch (error) {
    console.warn(`[mysql-facts] failed to load channel rules: ${error.message}`);
    return null;
  } finally {
    conn.release();
  }
}

async function findAssetId(conn, projectId, assetUid) {
  const [rows] = await conn.execute(
    "SELECT id FROM asset_files WHERE project_id = ? AND asset_uid = ? LIMIT 1",
    [projectId, assetUid]
  );
  return rows[0]?.id ?? null;
}

async function findReferenceVideoId(conn, projectId, referenceVideoUid) {
  const [rows] = await conn.execute(
    "SELECT id FROM reference_videos WHERE project_id = ? AND reference_video_uid = ? LIMIT 1",
    [projectId, referenceVideoUid]
  );
  return rows[0]?.id ?? null;
}

function relativePath(value) {
  const text = String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!text || text.includes("..") || /^[A-Za-z]:[\\/]/.test(text)) return "";
  return text;
}

async function upsertAssetFile(conn, facts, asset) {
  const assetUid = asset.assetUid || `asset_${sha256Hex(`${asset.kind || "file"}:${asset.relativePath || asset.fileName}`).slice(0, 24)}`;
  const storageRelativePath = relativePath(asset.relativePath || asset.storedPath || asset.fileName);
  if (!storageRelativePath) return null;
  await conn.execute(
    `INSERT INTO asset_files
      (asset_uid, project_id, owner_user_id, storage_scope, asset_kind, file_name, mime_type, size_bytes,
       storage_relative_path, width, height, duration_sec, probe_json, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      file_name = VALUES(file_name),
      mime_type = VALUES(mime_type),
      size_bytes = VALUES(size_bytes),
      storage_relative_path = VALUES(storage_relative_path),
      width = VALUES(width),
      height = VALUES(height),
      duration_sec = VALUES(duration_sec),
      probe_json = VALUES(probe_json),
      status = VALUES(status),
      updated_at = UTC_TIMESTAMP(3)`,
    [
      assetUid,
      facts.projectId,
      asset.ownerUserId === null ? null : facts.userId,
      asset.storageScope || "user",
      asset.kind || "reference_video",
      String(asset.fileName || "file").slice(0, 255),
      asset.mimeType || null,
      asset.sizeBytes ?? null,
      storageRelativePath,
      asset.width ?? null,
      asset.height ?? null,
      asset.durationSec ?? null,
      asset.probe ? json(asset.probe) : null,
      asset.status || "active"
    ]
  );
  return findAssetId(conn, facts.projectId, assetUid);
}

async function upsertReferenceVideoFact(conn, facts, referenceVideo) {
  const assetId = await upsertAssetFile(conn, facts, {
    assetUid: `asset_${referenceVideo.referenceVideoId}`,
    storageScope: "user",
    kind: "reference_video",
    fileName: referenceVideo.fileName || `${referenceVideo.referenceVideoId}.mp4`,
    mimeType: referenceVideo.mimeType,
    sizeBytes: referenceVideo.sizeBytes,
    relativePath: referenceVideo.storedPath,
    width: referenceVideo.width,
    height: referenceVideo.height,
    durationSec: referenceVideo.durationSec,
    probe: referenceVideo,
    status: referenceVideo.status === "deleted" ? "deleted" : "active"
  });
  if (!assetId) return null;
  await conn.execute(
    `INSERT INTO reference_videos
      (reference_video_uid, project_id, user_id, asset_file_id, status, duration_sec, width, height,
       ratio, can_extract_frame, issues_json, probe_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
    ON DUPLICATE KEY UPDATE
      asset_file_id = VALUES(asset_file_id),
      status = VALUES(status),
      duration_sec = VALUES(duration_sec),
      width = VALUES(width),
      height = VALUES(height),
      ratio = VALUES(ratio),
      can_extract_frame = VALUES(can_extract_frame),
      issues_json = VALUES(issues_json),
      probe_json = VALUES(probe_json),
      updated_at = UTC_TIMESTAMP(3)`,
    [
      referenceVideo.referenceVideoId,
      facts.projectId,
      facts.userId,
      assetId,
      referenceVideo.status || "pass",
      referenceVideo.durationSec ?? null,
      referenceVideo.width ?? null,
      referenceVideo.height ?? null,
      referenceVideo.ratio || null,
      referenceVideo.canExtractFrame ? 1 : 0,
      json(Array.isArray(referenceVideo.issues) ? referenceVideo.issues : []),
      json(referenceVideo)
    ]
  );
  return findReferenceVideoId(conn, facts.projectId, referenceVideo.referenceVideoId);
}

export async function syncReferenceVideoFact(context, referenceVideo) {
  const pool = await getPool();
  if (!pool || !referenceVideo?.referenceVideoId) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    const referenceVideoId = await upsertReferenceVideoFact(conn, facts, referenceVideo);
    await conn.commit();
    return { skipped: false, referenceVideoId };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to sync reference video ${referenceVideo.referenceVideoId}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

function referenceVideoRowToProbe(row) {
  const probe = parseJsonValue(row.probe_json, {});
  return {
    ...probe,
    referenceVideoId: row.reference_video_uid,
    fileName: row.file_name || probe.fileName,
    mimeType: row.mime_type || probe.mimeType,
    sizeBytes: row.size_bytes ?? probe.sizeBytes,
    durationSec: row.duration_sec === null || row.duration_sec === undefined ? probe.durationSec : Number(row.duration_sec),
    width: row.width ?? probe.width,
    height: row.height ?? probe.height,
    ratio: row.ratio || probe.ratio,
    canExtractFrame: row.can_extract_frame === 1 || row.can_extract_frame === true || probe.canExtractFrame === true,
    status: row.status || probe.status,
    issues: parseJsonValue(row.issues_json, probe.issues || []),
    storedPath: relativePath(row.storage_relative_path || probe.storedPath)
  };
}

export async function loadReferenceVideoProbeFromMysql(context, referenceVideoId) {
  const pool = await getPool();
  if (!pool || !referenceVideoId) return null;
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const [rows] = await conn.execute(
      `SELECT
        rv.reference_video_uid,
        rv.status,
        rv.duration_sec,
        rv.width,
        rv.height,
        rv.ratio,
        rv.can_extract_frame,
        rv.issues_json,
        rv.probe_json,
        af.file_name,
        af.mime_type,
        af.size_bytes,
        af.storage_relative_path
      FROM reference_videos rv
      JOIN asset_files af ON af.id = rv.asset_file_id
      WHERE rv.reference_video_uid = ?
        AND rv.project_id = ?
      LIMIT 1`,
      [referenceVideoId, facts.projectId]
    );
    return rows[0] ? referenceVideoRowToProbe(rows[0]) : null;
  } catch (error) {
    console.warn(`[mysql-facts] failed to load reference video ${referenceVideoId}: ${error.message}`);
    return null;
  } finally {
    conn.release();
  }
}

export async function syncVideoDecompositionFact(context, decomposition) {
  const pool = await getPool();
  if (!pool || !decomposition?.referenceVideoId) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    const referenceVideoDbId = await findReferenceVideoId(conn, facts.projectId, decomposition.referenceVideoId);
    if (!referenceVideoDbId) {
      await conn.rollback();
      return { skipped: true, error: new Error("reference video fact missing") };
    }
    const missingFields = Array.isArray(decomposition.missingFields) ? decomposition.missingFields : [];
    const status = decomposition.status || (missingFields.length ? "manual_required" : "succeeded");
    await conn.execute(
      `INSERT INTO video_decompositions
        (reference_video_id, schema_version, status, decomposition_json, missing_fields_json, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        decomposition_json = VALUES(decomposition_json),
        missing_fields_json = VALUES(missing_fields_json)`,
      [
        referenceVideoDbId,
        decomposition.schemaVersion || "video_decomposition.v1",
        status,
        json(decomposition),
        json(missingFields),
        facts.userId
      ]
    );
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to sync video decomposition ${decomposition.referenceVideoId}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

export async function loadVideoDecompositionFromMysql(context, referenceVideoId) {
  const pool = await getPool();
  if (!pool || !referenceVideoId) return null;
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const [rows] = await conn.execute(
      `SELECT
        vd.schema_version,
        vd.status,
        vd.decomposition_json,
        vd.missing_fields_json
      FROM video_decompositions vd
      JOIN reference_videos rv ON rv.id = vd.reference_video_id
      WHERE rv.reference_video_uid = ?
        AND rv.project_id = ?
      ORDER BY vd.created_at DESC
      LIMIT 1`,
      [referenceVideoId, facts.projectId]
    );
    if (!rows[0]) return null;
    const decomposition = parseJsonValue(rows[0].decomposition_json, {});
    return {
      ...decomposition,
      referenceVideoId,
      schemaVersion: rows[0].schema_version || decomposition.schemaVersion || "video_decomposition.v1",
      missingFields: parseJsonValue(rows[0].missing_fields_json, decomposition.missingFields || [])
    };
  } catch (error) {
    console.warn(`[mysql-facts] failed to load video decomposition ${referenceVideoId}: ${error.message}`);
    return null;
  } finally {
    conn.release();
  }
}

function estimateType(record) {
  return record?.estimate?.estimateId?.startsWith("rme_") ? "remix" : "pipeline";
}

function sanitizedEstimateRecord(record) {
  const estimate = { ...(record?.estimate || {}) };
  delete estimate.confirmationToken;
  return estimate;
}

function sanitizedConfirmation(record) {
  if (!record?.confirmation) return null;
  const confirmation = { ...record.confirmation };
  delete confirmation.confirmationToken;
  if (record.confirmation.confirmationToken) confirmation.tokenHashAvailable = true;
  return confirmation;
}

export async function syncEstimateFact(context, record, confirmationToken = null) {
  const pool = await getPool();
  if (!pool || !record?.estimate?.estimateId) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    let templateVersionId = null;
    if (record.templateSnapshot?.templateId && record.templateSnapshot?.versionId) {
      const templateId = await upsertTemplateFact(conn, facts, record.templateSnapshot);
      templateVersionId = await upsertTemplateVersionFact(conn, facts, templateId, record.templateSnapshot);
    }
    let referenceVideoId = null;
    if (record.referenceVideo?.referenceVideoId) {
      referenceVideoId = await upsertReferenceVideoFact(conn, facts, record.referenceVideo);
    }
    if (record.decomposition?.referenceVideoId) {
      const referenceVideoDbId = referenceVideoId ?? await findReferenceVideoId(conn, facts.projectId, record.decomposition.referenceVideoId);
      if (referenceVideoDbId) {
        const missingFields = Array.isArray(record.decomposition.missingFields) ? record.decomposition.missingFields : [];
        await conn.execute(
          `INSERT INTO video_decompositions
            (reference_video_id, schema_version, status, decomposition_json, missing_fields_json, created_by, created_at)
          VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE
            status = VALUES(status),
            decomposition_json = VALUES(decomposition_json),
            missing_fields_json = VALUES(missing_fields_json)`,
          [
            referenceVideoDbId,
            record.decomposition.schemaVersion || "video_decomposition.v1",
            missingFields.length ? "manual_required" : "succeeded",
            json(record.decomposition),
            json(missingFields),
            facts.userId
          ]
        );
      }
    }
    const token = confirmationToken || record.confirmation?.confirmationToken || record.estimate?.confirmationToken || null;
    const estimatePayload = {
      ...sanitizedEstimateRecord(record),
      confirmation: sanitizedConfirmation(record)
    };
    await conn.execute(
      `INSERT INTO work_estimates
        (estimate_uid, estimate_type, project_id, user_id, template_version_id, reference_video_id,
         source_asset_file_id, request_hash, request_json, estimate_json, confirmation_token_hash,
         confirmation_expires_at, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        request_hash = VALUES(request_hash),
        request_json = VALUES(request_json),
        estimate_json = VALUES(estimate_json),
        confirmation_token_hash = VALUES(confirmation_token_hash),
        confirmation_expires_at = VALUES(confirmation_expires_at),
        status = VALUES(status)`,
      [
        record.estimate.estimateId,
        estimateType(record),
        facts.projectId,
        facts.userId,
        templateVersionId,
        referenceVideoId,
        record.estimateHash || sha256Hex(json(record.request || {})),
        json(record.request || {}),
        json(estimatePayload),
        token ? sha256Buffer(token) : null,
        mysqlDate(record.confirmation?.expiresAt),
        record.status || "active",
        mysqlDate(record.createdAt) || mysqlDate(new Date())
      ]
    );
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to sync estimate ${record.estimate.estimateId}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

function templateSnapshotFromEstimateRow(row) {
  if (!row.template_uid || !row.template_version_uid) return null;
  return {
    templateId: row.template_uid,
    versionId: row.template_version_uid,
    versionNumber: Number(row.template_version_number || 1),
    status: row.template_status || "active",
    isDefault: false,
    draft: parseJsonValue(row.template_draft_json, {}),
    createdBy: row.template_created_by || "mysql",
    createdAt: isoDate(row.template_created_at),
    updatedAt: isoDate(row.template_created_at)
  };
}

function referenceSnapshotFromEstimateRow(row) {
  if (!row.reference_video_uid) return null;
  const probe = parseJsonValue(row.reference_probe_json, {});
  return {
    ...probe,
    referenceVideoId: row.reference_video_uid,
    status: row.reference_status || probe.status
  };
}

export async function loadEstimateFromMysql(context, estimateId) {
  const pool = await getPool();
  if (!pool || !estimateId) return null;
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const [rows] = await conn.execute(
      `SELECT
        we.estimate_uid,
        we.estimate_type,
        we.request_hash,
        we.request_json,
        we.estimate_json,
        we.confirmation_expires_at,
        we.confirmation_token_hash IS NOT NULL AS token_hash_available,
        we.status,
        we.created_at,
        pt.template_uid,
        pv.template_version_uid,
        pv.version_number AS template_version_number,
        pv.status AS template_status,
        pv.draft_json AS template_draft_json,
        au.username AS template_created_by,
        pv.created_at AS template_created_at,
        rv.reference_video_uid,
        rv.status AS reference_status,
        rv.probe_json AS reference_probe_json,
        vd.decomposition_json
      FROM work_estimates we
      LEFT JOIN product_template_versions pv ON pv.id = we.template_version_id
      LEFT JOIN product_templates pt ON pt.id = pv.template_id
      LEFT JOIN app_users au ON au.id = pv.created_by
      LEFT JOIN reference_videos rv ON rv.id = we.reference_video_id
      LEFT JOIN video_decompositions vd ON vd.reference_video_id = rv.id
      WHERE we.estimate_uid = ?
        AND we.project_id = ?
      LIMIT 1`,
      [estimateId, facts.projectId]
    );
    const row = rows[0];
    if (!row) return null;
    const estimatePayload = parseJsonValue(row.estimate_json, {});
    const estimate = {
      ...(estimatePayload.estimate || estimatePayload),
      estimateId: row.estimate_uid
    };
    delete estimate.confirmationToken;
    const confirmationFromPayload = estimatePayload.confirmation || {};
    const confirmation = row.confirmation_expires_at || row.token_hash_available
      ? {
          ...confirmationFromPayload,
          expiresAt: isoDate(row.confirmation_expires_at) || confirmationFromPayload.expiresAt,
          tokenHashAvailable: Boolean(row.token_hash_available)
        }
      : null;
    if (confirmation) delete confirmation.confirmationToken;
    return {
      schemaVersion: row.estimate_type === "remix" ? "remix-estimate.v1" : "batch-estimate.v1",
      estimate,
      request: parseJsonValue(row.request_json, {}),
      estimateHash: row.request_hash,
      confirmation,
      templateSnapshot: templateSnapshotFromEstimateRow(row),
      referenceVideo: referenceSnapshotFromEstimateRow(row),
      decomposition: parseJsonValue(row.decomposition_json, null),
      userId: currentUserId(context),
      projectRoot: projectRoot(context),
      createdAt: isoDate(row.created_at),
      status: row.status
    };
  } catch (error) {
    console.warn(`[mysql-facts] failed to load estimate ${estimateId}: ${error.message}`);
    return null;
  } finally {
    conn.release();
  }
}

export async function verifyEstimateConfirmationTokenFromMysql(context, estimateId, confirmationToken) {
  const pool = await getPool();
  if (!pool || !estimateId || !confirmationToken) return false;
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const [rows] = await conn.execute(
      `SELECT id
      FROM work_estimates
      WHERE estimate_uid = ?
        AND project_id = ?
        AND confirmation_token_hash = ?
        AND (confirmation_expires_at IS NULL OR confirmation_expires_at > UTC_TIMESTAMP(3))
      LIMIT 1`,
      [estimateId, facts.projectId, sha256Buffer(confirmationToken)]
    );
    return rows.length > 0;
  } catch (error) {
    console.warn(`[mysql-facts] failed to verify estimate confirmation ${estimateId}: ${error.message}`);
    return false;
  } finally {
    conn.release();
  }
}

export async function syncRemixFacts(context, remix, triggerName = "remix_write") {
  if (!remix?.remixId) return { skipped: true };
  const batchLike = {
    batchId: remix.remixId,
    type: "remix",
    status: remix.status || "queued",
    estimate: remix.estimate || {},
    capabilities: remix.capability ? { remixProvider: remix.capability } : remix.capabilities,
    templateSnapshot: remix.templateSnapshot,
    tasks: Array.isArray(remix.tasks) ? remix.tasks : [],
    outputs: Array.isArray(remix.outputs) ? remix.outputs.map((output) => ({
      ...output,
      sourceType: "remix",
      kind: output.kind || "remix_video",
      batchId: undefined
    })) : [],
    qcSummary: remix.qcSummary || {},
    stopReason: remix.stopReason,
    startedAt: remix.startedAt || remix.createdAt,
    finishedAt: remix.finishedAt || remix.stoppedAt,
    createdAt: remix.createdAt,
    updatedAt: remix.updatedAt
  };
  const synced = await syncBatchFacts(context, batchLike, triggerName);
  if (synced.skipped) return synced;
  const pool = await getPool();
  if (!pool) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const runId = await findRunId(conn, facts.projectId, remix.remixId);
    if (!runId) return synced;
    for (const region of Array.isArray(remix.regions) ? remix.regions : []) {
      const regionUid = region.regionId || region.regionUid || `region_${sha256Hex(json(region)).slice(0, 16)}`;
      const bbox = region.bbox || region;
      const regionType = region.description ? "description" : "bbox";
      await conn.execute(
        `INSERT INTO remix_regions
          (run_id, region_uid, region_type, label, bbox_x, bbox_y, bbox_width, bbox_height, description_text)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          region_type = VALUES(region_type),
          label = VALUES(label),
          bbox_x = VALUES(bbox_x),
          bbox_y = VALUES(bbox_y),
          bbox_width = VALUES(bbox_width),
          bbox_height = VALUES(bbox_height),
          description_text = VALUES(description_text)`,
        [
          runId,
          regionUid,
          regionType,
          String(region.label || region.type || "region").slice(0, 80),
          regionType === "bbox" ? Number(bbox.x ?? bbox.left ?? 0) : null,
          regionType === "bbox" ? Number(bbox.y ?? bbox.top ?? 0) : null,
          regionType === "bbox" ? Number(bbox.width ?? bbox.w ?? 0) : null,
          regionType === "bbox" ? Number(bbox.height ?? bbox.h ?? 0) : null,
          region.description || null
        ]
      );
    }
    return { skipped: false };
  } catch (error) {
    console.warn(`[mysql-facts] failed to sync remix facts ${remix.remixId}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

export async function syncDownloadPackageFact(context, manifest) {
  const pool = await getPool();
  if (!pool || !manifest?.packageId) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    await conn.execute(
      `INSERT INTO download_packages
        (package_uid, project_id, user_id, package_asset_file_id, status, filters_json, manifest_json,
         item_count, missing_files_json, created_at)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        filters_json = VALUES(filters_json),
        manifest_json = VALUES(manifest_json),
        item_count = VALUES(item_count),
        missing_files_json = VALUES(missing_files_json)`,
      [
        manifest.packageId,
        facts.projectId,
        facts.userId,
        manifest.missingFiles?.length ? "failed" : "succeeded",
        json(manifest.filters || {}),
        json(manifest),
        Array.isArray(manifest.items) ? manifest.items.length : 0,
        json(manifest.missingFiles || []),
        mysqlDate(manifest.createdAt) || mysqlDate(new Date())
      ]
    );
    const [packageRows] = await conn.execute(
      "SELECT id FROM download_packages WHERE project_id = ? AND package_uid = ? LIMIT 1",
      [facts.projectId, manifest.packageId]
    );
    const packageId = packageRows[0]?.id;
    for (const item of Array.isArray(manifest.items) ? manifest.items : []) {
      const outputDbId = item.outputId ? await findOutputIdInProject(conn, facts.projectId, item.outputId) : null;
      await conn.execute(
        `INSERT INTO download_package_items
          (package_id, output_id, package_path, diagnostic, created_at)
        VALUES (?, ?, ?, ?, UTC_TIMESTAMP(3))
        ON DUPLICATE KEY UPDATE
          output_id = VALUES(output_id),
          diagnostic = VALUES(diagnostic)`,
        [
          packageId,
          outputDbId,
          relativePath(item.packagePath || item.outputId || "item"),
          item.diagnostic ? 1 : 0
        ]
      );
    }
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to sync download package ${manifest.packageId}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

async function findRunId(conn, projectId, runUid) {
  const [rows] = await conn.execute(
    "SELECT id FROM workflow_runs WHERE project_id = ? AND run_uid = ? LIMIT 1",
    [projectId, runUid]
  );
  return rows[0]?.id ?? null;
}

const ACTIVE_LOCK_RUN_STATUSES = new Set(["checking", "queued", "running", "stitching", "qc", "preview_required"]);

function invalidStateTransitionError(entityType, fromStatus, toStatus, triggerName) {
  const error = new Error(`invalid_state_transition: ${entityType} ${fromStatus || "__new__"} -> ${toStatus} by ${triggerName}`);
  error.code = "invalid_state_transition";
  error.details = { entityType, fromStatus: fromStatus || null, toStatus, triggerName };
  return error;
}

async function assertAllowedStateTransition(conn, entityType, fromStatus, toStatus, triggerName) {
  if (!toStatus) return;
  if (fromStatus === toStatus) return;
  const fromValue = fromStatus || "__new__";
  const [rows] = await conn.execute(
    `SELECT id
    FROM state_transition_rules
    WHERE entity_type = ?
      AND from_status = ?
      AND to_status = ?
      AND trigger_name = ?
    LIMIT 1`,
    [entityType, fromValue, toStatus, triggerName]
  );
  if (rows.length) return;
  throw invalidStateTransitionError(entityType, fromStatus, toStatus, triggerName);
}

async function insertStateEvent(conn, facts, entityType, entityUid, fromStatus, toStatus, triggerName, reason = null) {
  await assertAllowedStateTransition(conn, entityType, fromStatus, toStatus, triggerName);
  await conn.execute(
    `INSERT INTO state_transition_events
      (event_uid, entity_type, entity_uid, from_status, to_status, trigger_name, actor_user_id, reason, occurred_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
    [uid("ste"), entityType, entityUid, fromStatus, toStatus, triggerName, facts.userId, reason]
  );
}

function lockKeyForFacts(facts) {
  return `project:${facts.projectId}:user:${facts.userId}:upstream_generation`;
}

async function syncResourceLock(conn, facts, runId, runUid, status) {
  const lockKey = lockKeyForFacts(facts);
  if (ACTIVE_LOCK_RUN_STATUSES.has(status)) {
    await conn.execute(
      `INSERT INTO resource_locks
        (lock_key, project_id, user_id, lock_type, owner_run_id, status, acquired_at, expires_at, released_at)
      VALUES (?, ?, ?, 'upstream_generation', ?, 'active', UTC_TIMESTAMP(3), DATE_ADD(UTC_TIMESTAMP(3), INTERVAL 2 HOUR), NULL)
      ON DUPLICATE KEY UPDATE
        owner_run_id = VALUES(owner_run_id),
        status = 'active',
        expires_at = VALUES(expires_at),
        released_at = NULL`,
      [lockKey, facts.projectId, facts.userId, runId]
    );
    return;
  }
  await conn.execute(
    `UPDATE resource_locks
    SET status = 'released',
        released_at = COALESCE(released_at, UTC_TIMESTAMP(3))
    WHERE lock_key = ?
      AND lock_type = 'upstream_generation'
      AND status = 'active'
      AND (owner_run_id = ? OR owner_run_id IS NULL)`,
    [lockKey, runId]
  );
}

export async function findActiveResourceLock(context) {
  const pool = await getPool();
  if (!pool) return null;
  const conn = await pool.getConnection();
  try {
    const facts = await ensureContextFacts(conn, context);
    const [rows] = await conn.execute(
      `SELECT
        rl.lock_key,
        rl.lock_type,
        rl.status,
        rl.expires_at,
        wr.run_uid,
        wr.run_type,
        wr.status AS run_status
      FROM resource_locks rl
      LEFT JOIN workflow_runs wr ON wr.id = rl.owner_run_id
      WHERE rl.project_id = ?
        AND rl.user_id = ?
        AND rl.lock_type = 'upstream_generation'
        AND rl.status = 'active'
        AND rl.expires_at > UTC_TIMESTAMP(3)
      ORDER BY rl.acquired_at DESC
      LIMIT 1`,
      [facts.projectId, facts.userId]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      lockKey: row.lock_key,
      lockType: row.lock_type,
      status: row.status,
      expiresAt: isoDate(row.expires_at),
      runId: row.run_uid || "",
      runType: row.run_type || "",
      runStatus: row.run_status || ""
    };
  } catch (error) {
    console.warn(`[mysql-facts] failed to read resource lock: ${error.message}`);
    return null;
  } finally {
    conn.release();
  }
}

function runType(batch) {
  return batch.type === "remix" ? "remix" : "pipeline";
}

function requestSnapshot(batch) {
  return {
    estimateId: batch.estimate?.estimateId,
    durationSec: batch.estimate?.durationSec,
    variantCount: batch.estimate?.variantCount,
    scriptCount: batch.estimate?.scriptCount,
    seedanceSegmentCount: batch.estimate?.seedanceSegmentCount,
    targetChannel: batch.estimate?.request?.targetChannel,
    outputRatio: batch.estimate?.outputRatio
  };
}

function taskKind(task) {
  if (task.kind) return task.kind;
  if (task.generationTaskId || task.seedanceTaskId || task.imageTaskId) return "seedance_video";
  return "image_generation";
}

function taskUid(task) {
  return task.generationTaskId || task.taskId || task.id;
}

async function findScriptId(conn, runId, scriptUid) {
  const [rows] = await conn.execute(
    "SELECT id FROM generation_scripts WHERE run_id = ? AND script_uid = ? LIMIT 1",
    [runId, scriptUid]
  );
  return rows[0]?.id ?? null;
}

async function findTaskDbId(conn, runId, taskUidValue) {
  const [rows] = await conn.execute(
    "SELECT id FROM workflow_tasks WHERE run_id = ? AND task_uid = ? LIMIT 1",
    [runId, taskUidValue]
  );
  return rows[0]?.id ?? null;
}

async function findOutputId(conn, runId, outputUid) {
  const [rows] = await conn.execute(
    "SELECT id FROM workflow_outputs WHERE run_id = ? AND output_uid = ? LIMIT 1",
    [runId, outputUid]
  );
  return rows[0]?.id ?? null;
}

async function findOutputIdInProject(conn, projectId, outputUid) {
  const [rows] = await conn.execute(
    `SELECT wo.id
    FROM workflow_outputs wo
    JOIN workflow_runs wr ON wr.id = wo.run_id
    WHERE wr.project_id = ?
      AND wo.output_uid = ?
    ORDER BY wo.id DESC
    LIMIT 1`,
    [projectId, outputUid]
  );
  return rows[0]?.id ?? null;
}

async function syncGenerationScripts(conn, facts, batch, runId) {
  for (const script of Array.isArray(batch.scripts) ? batch.scripts : []) {
    if (!script?.scriptId) continue;
    const promptAssetId = script.promptPath ? await upsertAssetFile(conn, facts, {
      assetUid: `asset_prompt_${script.scriptId}`,
      storageScope: "user",
      kind: "prompt",
      fileName: `${script.scriptId}.txt`,
      relativePath: script.promptPath,
      status: "active"
    }) : null;
    await conn.execute(
      `INSERT INTO generation_scripts
        (script_uid, run_id, variant_index, segment_index, duration_sec, hook_text, body_text,
         cta_text, ending_text, reward_expression, prompt_asset_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        hook_text = VALUES(hook_text),
        body_text = VALUES(body_text),
        cta_text = VALUES(cta_text),
        ending_text = VALUES(ending_text),
        reward_expression = VALUES(reward_expression),
        prompt_asset_file_id = VALUES(prompt_asset_file_id)`,
      [
        script.scriptId,
        runId,
        Number(script.variantIndex || 1),
        Number(script.segmentIndex || 1),
        Number(script.durationSec || 15),
        String(script.hook || "").slice(0, 65535),
        String(script.body || "").slice(0, 65535),
        String(script.cta || "").slice(0, 255),
        String(script.ending || "").slice(0, 255),
        script.rewardExpression || null,
        promptAssetId
      ]
    );
  }
}

function outputKind(output) {
  if (output.kind) return output.kind;
  return runType({ type: output.sourceType }) === "remix" ? "remix_video" : "segment_video";
}

async function syncWorkflowOutputs(conn, facts, batch, runId) {
  for (const output of Array.isArray(batch.outputs) ? batch.outputs : []) {
    if (!output?.outputId || !output?.filePath) continue;
    const assetId = await upsertAssetFile(conn, facts, {
      assetUid: `asset_${output.outputId}`,
      storageScope: "user",
      kind: outputKind(output),
      fileName: `${output.outputId}${String(output.filePath).match(/\.[a-z0-9]+$/i)?.[0] || ".mp4"}`,
      relativePath: output.filePath,
      durationSec: output.durationSec,
      status: "active"
    });
    if (!assetId) continue;
    const scriptId = output.scriptId ? await findScriptId(conn, runId, output.scriptId) : null;
    await conn.execute(
      `INSERT INTO workflow_outputs
        (output_uid, run_id, script_id, asset_file_id, source_type, output_kind, duration_sec,
         qc_status, download_eligible, visual_preview_required, preview_confirmed, preview_confirmed_by,
         preview_confirmed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        asset_file_id = VALUES(asset_file_id),
        qc_status = VALUES(qc_status),
        download_eligible = VALUES(download_eligible),
        visual_preview_required = VALUES(visual_preview_required),
        preview_confirmed = VALUES(preview_confirmed),
        preview_confirmed_by = VALUES(preview_confirmed_by),
        preview_confirmed_at = VALUES(preview_confirmed_at),
        updated_at = UTC_TIMESTAMP(3)`,
      [
        output.outputId,
        runId,
        scriptId,
        assetId,
        output.sourceType === "remix" || batch.type === "remix" ? "remix" : "pipeline",
        outputKind(output),
        output.durationSec ?? null,
        output.qcStatus || "not_started",
        output.downloadEligible ? 1 : 0,
        output.visualPreviewRequired ? 1 : 0,
        output.previewConfirmed ? 1 : 0,
        output.previewConfirmed ? facts.userId : null,
        mysqlDate(output.previewConfirmedAt)
      ]
    );
  }
}

async function syncQcReports(conn, facts, batch, runId) {
  for (const output of Array.isArray(batch.outputs) ? batch.outputs : []) {
    if (!output?.outputId || !output.qcReportPath) continue;
    const outputDbId = await findOutputId(conn, runId, output.outputId);
    if (!outputDbId) continue;
    const reportAssetId = await upsertAssetFile(conn, facts, {
      assetUid: `asset_qc_${output.outputId}`,
      storageScope: "user",
      kind: "qc_report",
      fileName: `${output.outputId}.json`,
      relativePath: output.qcReportPath,
      status: "active"
    });
    await conn.execute(
      `INSERT INTO qc_reports
        (output_id, report_asset_file_id, qc_status, checks_json, summary, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        report_asset_file_id = VALUES(report_asset_file_id),
        qc_status = VALUES(qc_status),
        checks_json = VALUES(checks_json),
        summary = VALUES(summary)`,
      [
        outputDbId,
        reportAssetId,
        output.qcStatus || "not_started",
        json(output.qcChecks || []),
        output.qcSummary || null,
        facts.userId
      ]
    );
  }
}

async function syncStitchReports(conn, facts, batch, runId) {
  for (const report of Array.isArray(batch.stitchReports) ? batch.stitchReports : []) {
    if (!report?.outputId) continue;
    const outputDbId = await findOutputId(conn, runId, report.outputId);
    if (!outputDbId) continue;
    const reportAssetId = report.reportPath ? await upsertAssetFile(conn, facts, {
      assetUid: `asset_stitch_${report.outputId}`,
      storageScope: "user",
      kind: "stitch_report",
      fileName: `${report.outputId}_stitch-report.json`,
      relativePath: report.reportPath,
      status: "active"
    }) : null;
    await conn.execute(
      `INSERT INTO stitch_reports
        (output_id, report_asset_file_id, status, stitch_tool, segment_output_ids_json, command_summary,
         error_code, error_message, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        report_asset_file_id = VALUES(report_asset_file_id),
        status = VALUES(status),
        stitch_tool = VALUES(stitch_tool),
        segment_output_ids_json = VALUES(segment_output_ids_json),
        command_summary = VALUES(command_summary),
        error_code = VALUES(error_code),
        error_message = VALUES(error_message)`,
      [
        outputDbId,
        reportAssetId,
        report.status || "succeeded",
        report.tool?.provider || report.stitchTool || null,
        json(report.segmentOutputIds || []),
        report.commandSummary || null,
        report.errorCode || null,
        report.errorMessage || null,
        mysqlDate(report.createdAt) || mysqlDate(new Date())
      ]
    );
  }
}

async function syncSchedulerJobs(conn, batch, runId) {
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    const uidValue = taskUid(task);
    if (!uidValue || task.status !== "failed" || Number(task.attempts || 0) >= Number(task.maxAttempts || 2)) continue;
    const taskDbId = await findTaskDbId(conn, runId, uidValue);
    await conn.execute(
      `INSERT INTO scheduler_jobs
        (job_uid, job_type, status, run_id, task_id, payload_json, priority, run_after, attempts, max_attempts, backoff_strategy, created_at, updated_at)
      VALUES (?, 'task_retry', 'pending', ?, ?, ?, 0, ?, 0, 3, 'exponential', UTC_TIMESTAMP(3), UTC_TIMESTAMP(3))
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        payload_json = VALUES(payload_json),
        run_after = VALUES(run_after),
        updated_at = UTC_TIMESTAMP(3)`,
      [
        `job_retry_${uidValue}`,
        runId,
        taskDbId,
        json({ batchId: batch.batchId, taskUid: uidValue, errorCode: task.errorCode || null }),
        mysqlDate(task.nextAttemptAt) || mysqlDate(new Date(Date.now() + 60_000))
      ]
    );
  }
}

function schedulerWorkerId(workerId = "") {
  return String(workerId || `worker_${process.pid || "local"}`).slice(0, 80);
}

function parseSchedulerJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobUid: row.job_uid,
    jobType: row.job_type,
    status: row.status,
    attempts: Number(row.attempts || 0),
    maxAttempts: Number(row.max_attempts || 0),
    payload: parseJsonValue(row.payload_json, {}),
    runUid: row.run_uid || null,
    taskUid: row.task_uid || null,
    username: row.username || null,
    projectKey: row.project_key || null
  };
}

export async function claimSchedulerJob(options = {}) {
  const pool = await getPool();
  if (!pool) return null;
  const workerId = schedulerWorkerId(options.workerId);
  const lockSeconds = Math.max(5, Math.min(Number(options.lockSeconds || 60), 3600));
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.execute(
      `SELECT
        sj.id,
        sj.job_uid,
        sj.job_type,
        sj.status,
        sj.attempts,
        sj.max_attempts,
        sj.payload_json,
        wr.run_uid,
        wt.task_uid,
        au.username,
        p.project_key
      FROM scheduler_jobs sj
      LEFT JOIN workflow_runs wr ON wr.id = sj.run_id
      LEFT JOIN workflow_tasks wt ON wt.id = sj.task_id
      LEFT JOIN app_users au ON au.id = wr.user_id
      LEFT JOIN projects p ON p.id = wr.project_id
      WHERE (
          sj.status = 'pending'
          AND sj.run_after <= UTC_TIMESTAMP(3)
        )
        OR (
          sj.status = 'running'
          AND sj.locked_by = ?
          AND sj.lock_expires_at <= UTC_TIMESTAMP(3)
        )
      ORDER BY sj.priority ASC, sj.run_after ASC, sj.id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED`,
      [workerId]
    );
    const row = rows[0];
    if (!row) {
      await conn.commit();
      return null;
    }
    await assertAllowedStateTransition(conn, "scheduler_job", row.status, "running", "claim");
    await conn.execute(
      `UPDATE scheduler_jobs
      SET status = 'running',
          locked_by = ?,
          locked_at = UTC_TIMESTAMP(3),
          lock_expires_at = DATE_ADD(UTC_TIMESTAMP(3), INTERVAL ? SECOND),
          attempts = attempts + 1,
          updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?
        AND (status = 'pending' OR (status = 'running' AND locked_by = ?))`,
      [workerId, lockSeconds, row.id, workerId]
    );
    await conn.commit();
    return { ...parseSchedulerJob(row), status: "running", workerId, attempts: Number(row.attempts || 0) + 1 };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function completeSchedulerJob(job, options = {}) {
  const pool = await getPool();
  if (!pool || !job?.id) return { skipped: true };
  const workerId = schedulerWorkerId(options.workerId || job.workerId);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await assertAllowedStateTransition(conn, "scheduler_job", "running", "succeeded", "finish");
    await conn.execute(
      `UPDATE scheduler_jobs
      SET status = 'succeeded',
          locked_by = NULL,
          locked_at = NULL,
          lock_expires_at = NULL,
          last_error_code = NULL,
          last_error_message = NULL,
          updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?
        AND status = 'running'
        AND locked_by = ?`,
      [job.id, workerId]
    );
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export async function failSchedulerJob(job, error, options = {}) {
  const pool = await getPool();
  if (!pool || !job?.id) return { skipped: true };
  const workerId = schedulerWorkerId(options.workerId || job.workerId);
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs ?? 60_000));
  const attempts = Number(job.attempts || 0);
  const maxAttempts = Number(job.maxAttempts || 1);
  const nextStatus = attempts >= maxAttempts ? "failed" : "pending";
  const trigger = nextStatus === "failed" ? "attempt_exhausted" : "retry";
  const errorCode = String(error?.code || "scheduler_job_failed").slice(0, 80);
  const message = String(error?.message || "scheduler job failed").slice(0, 500);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await assertAllowedStateTransition(conn, "scheduler_job", "running", nextStatus, trigger);
    await conn.execute(
      `UPDATE scheduler_jobs
      SET status = ?,
          run_after = CASE WHEN ? = 'pending' THEN ? ELSE run_after END,
          locked_by = NULL,
          locked_at = NULL,
          lock_expires_at = NULL,
          last_error_code = ?,
          last_error_message = ?,
          updated_at = UTC_TIMESTAMP(3)
      WHERE id = ?
        AND status = 'running'
        AND locked_by = ?`,
      [
        nextStatus,
        nextStatus,
        mysqlDate(new Date(Date.now() + retryDelayMs)),
        errorCode,
        message,
        job.id,
        workerId
      ]
    );
    await conn.commit();
    return { skipped: false, status: nextStatus };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

export async function syncBatchFacts(context, batch, triggerName = "batch_write") {
  const pool = await getPool();
  if (!pool || !batch?.batchId) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    await ensureStateTransitionRules(conn);
    const existingRunId = await findRunId(conn, facts.projectId, batch.batchId);
    let previousStatus = null;
    if (existingRunId) {
      const [previousRows] = await conn.execute(
        "SELECT status FROM workflow_runs WHERE id = ? LIMIT 1",
        [existingRunId]
      );
      previousStatus = previousRows[0]?.status ?? null;
    }

    await conn.execute(
    `INSERT INTO workflow_runs
        (run_uid, run_type, status, project_id, user_id, request_json, capability_json, qc_summary_json, stop_reason, started_at, finished_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        status = VALUES(status),
        request_json = VALUES(request_json),
        capability_json = VALUES(capability_json),
        qc_summary_json = VALUES(qc_summary_json),
        stop_reason = VALUES(stop_reason),
        started_at = COALESCE(workflow_runs.started_at, VALUES(started_at)),
        finished_at = VALUES(finished_at),
        updated_at = VALUES(updated_at)`,
      [
        batch.batchId,
        runType(batch),
        batch.status || "queued",
        facts.projectId,
        facts.userId,
        json(requestSnapshot(batch)),
        json(batch.capabilities || batch.estimate?.capabilities || {}),
        json(batch.qcSummary || {}),
        batch.stopReason || null,
        mysqlDate(batch.startedAt),
        mysqlDate(batch.finishedAt || batch.stoppedAt),
        mysqlDate(batch.createdAt) || mysqlDate(new Date()),
        mysqlDate(batch.updatedAt) || mysqlDate(new Date())
      ]
    );
    const runId = existingRunId || await findRunId(conn, facts.projectId, batch.batchId);
    await syncResourceLock(conn, facts, runId, batch.batchId, batch.status || "queued");
    if (previousStatus !== (batch.status || "queued")) {
      await insertStateEvent(conn, facts, "workflow_run", batch.batchId, previousStatus, batch.status || "queued", triggerName);
    }

    await syncGenerationScripts(conn, facts, batch, runId);
    for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
      const uidValue = taskUid(task);
      if (!uidValue) continue;
      const [taskRows] = await conn.execute(
        "SELECT id, status, attempts FROM workflow_tasks WHERE run_id = ? AND task_uid = ? LIMIT 1",
        [runId, uidValue]
      );
      const previousTask = taskRows[0] ?? null;
      await conn.execute(
        `INSERT INTO workflow_tasks
          (task_uid, run_id, task_kind, status, model_image, model_video, image_task_id, seedance_task_id, provider_job_id, attempts, max_attempts, started_at, finished_at, error_code, error_message, request_summary_json, response_summary_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          status = VALUES(status),
          model_image = VALUES(model_image),
          model_video = VALUES(model_video),
          image_task_id = VALUES(image_task_id),
          seedance_task_id = VALUES(seedance_task_id),
          provider_job_id = VALUES(provider_job_id),
          attempts = VALUES(attempts),
          started_at = COALESCE(workflow_tasks.started_at, VALUES(started_at)),
          finished_at = VALUES(finished_at),
          error_code = VALUES(error_code),
          error_message = VALUES(error_message),
          request_summary_json = VALUES(request_summary_json),
          response_summary_json = VALUES(response_summary_json)`,
        [
          uidValue,
          runId,
          taskKind(task),
          task.status || "pending",
          task.modelImage || null,
          task.modelVideo || null,
          task.imageTaskId || null,
          task.seedanceTaskId || null,
          task.providerJobId || null,
          Number(task.attempts || 0),
          Number(task.maxAttempts || 2),
          mysqlDate(task.startedAt),
          mysqlDate(task.finishedAt),
          task.errorCode || null,
          task.errorMessage || null,
          json({ batchId: batch.batchId, scriptId: task.scriptId, promptPath: task.promptPath }),
          json({ outputPath: task.outputPath || null })
        ]
      );

      const [nextTaskRows] = await conn.execute(
        "SELECT id FROM workflow_tasks WHERE run_id = ? AND task_uid = ? LIMIT 1",
        [runId, uidValue]
      );
      const taskId = nextTaskRows[0]?.id;
      if (previousTask?.status !== (task.status || "pending")) {
        await insertStateEvent(conn, facts, "workflow_task", uidValue, previousTask?.status ?? null, task.status || "pending", triggerName, task.errorCode || null);
      }
      if (taskId && Number(task.attempts || 0) > Number(previousTask?.attempts || 0)) {
        await conn.execute(
          `INSERT IGNORE INTO task_attempts
        (task_id, attempt_no, status, provider, upstream_task_id, started_at, finished_at, error_code, error_message, retryable, request_summary_json, response_summary_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            taskId,
            Number(task.attempts),
            TERMINAL_STATUSES.has(task.status) ? task.status === "succeeded" ? "succeeded" : "failed" : "running",
            task.provider || "mock",
            task.seedanceTaskId || task.imageTaskId || null,
            mysqlDate(task.startedAt) || mysqlDate(new Date()),
            mysqlDate(task.finishedAt),
            task.errorCode || null,
            task.errorMessage || null,
            task.status === "failed" ? 1 : 0,
            json({ scriptId: task.scriptId }),
            json({ outputPath: task.outputPath || null })
          ]
        );
      }
    }

    await syncWorkflowOutputs(conn, facts, batch, runId);
    await syncQcReports(conn, facts, batch, runId);
    await syncStitchReports(conn, facts, batch, runId);
    await syncSchedulerJobs(conn, batch, runId);

    await conn.commit();
    return { skipped: false, runId };
  } catch (error) {
    await conn.rollback();
    if (error?.code === "invalid_state_transition") {
      throw error;
    }
    console.warn(`[mysql-facts] failed to sync batch ${batch.batchId}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

export async function recordMysqlTelemetryEvent(context, telemetry, audit = null) {
  const pool = await getPool();
  if (!pool || !telemetry?.eventId) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    await conn.execute(
      `INSERT INTO telemetry_events
        (event_uid, event_name, project_id, user_id, role_snapshot, request_id, payload_json, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE payload_json = VALUES(payload_json)`,
      [
        telemetry.eventId,
        telemetry.event,
        facts.projectId,
        facts.userId,
        telemetry.role || currentRole(context),
        telemetry.requestId || null,
        json(telemetry.payload || {}),
        mysqlDate(telemetry.occurredAt) || mysqlDate(new Date())
      ]
    );
    if (audit) {
      await conn.execute(
        `INSERT INTO audit_events
          (audit_uid, project_id, actor_user_id, actor_role, action, target_type, target_uid, request_id, metadata_json, occurred_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE metadata_json = VALUES(metadata_json)`,
        [
          audit.eventId,
          facts.projectId,
          facts.userId,
          audit.role || currentRole(context),
          audit.event,
          audit.payload?.targetType || audit.payload?.resourceType || "wangzhuan",
          audit.payload?.batchId || audit.payload?.remixId || audit.payload?.templateId || audit.payload?.packageId || null,
          audit.requestId || null,
          json(audit.payload || {}),
          mysqlDate(audit.occurredAt) || mysqlDate(new Date())
        ]
      );
    }
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to record telemetry ${telemetry.eventId}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}

export async function recordIdempotencyFact(context, endpoint, idempotencyKey, requestHash, resource = {}) {
  const pool = await getPool();
  if (!pool || !idempotencyKey) return { skipped: true };
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const facts = await ensureContextFacts(conn, context);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await conn.execute(
      `INSERT INTO idempotency_keys
        (user_id, project_id, endpoint, idempotency_hash, request_hash, resource_type, resource_id, response_json, status, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'succeeded', ?)
      ON DUPLICATE KEY UPDATE
        resource_type = VALUES(resource_type),
        response_json = VALUES(response_json),
        status = VALUES(status),
        expires_at = VALUES(expires_at)`,
      [
        facts.userId,
        facts.projectId,
        endpoint,
        sha256Buffer(idempotencyKey),
        requestHash,
        resource.type || null,
        json(resource.response || {}),
        mysqlDate(expiresAt)
      ]
    );
    await conn.commit();
    return { skipped: false };
  } catch (error) {
    await conn.rollback();
    console.warn(`[mysql-facts] failed to record idempotency ${endpoint}: ${error.message}`);
    return { skipped: true, error };
  } finally {
    conn.release();
  }
}
