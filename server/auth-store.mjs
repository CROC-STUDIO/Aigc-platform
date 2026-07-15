import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

import { parseJsonFileContent } from "./runtime-config.mjs";

const scryptAsync = promisify(scryptCallback);
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_LENGTH = 64;

export function sanitizeSegment(value, fallback = "default") {
  const clean = String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return clean || fallback;
}

export function publicUser(user) {
  if (!user) return null;
  const permissions = user.permissions && typeof user.permissions === "object" ? user.permissions : {};
  const role = normalizeRole(user.role);
  return {
    username: user.username,
    displayName: user.displayName,
    userId: user.username,
    role,
    isAdmin: role === "admin",
    isTrial: role === "trial",
    permissions
  };
}

export function normalizeUsers(items = []) {
  const seen = new Set();
  const normalized = [];
  for (const item of items ?? []) {
    const username = sanitizeSegment(item.username, "");
    const password = String(item.password ?? "");
    const role = normalizeRole(item.role ?? (username === "admin" ? "admin" : "user"));
    if (!username || !password || seen.has(username)) continue;
    seen.add(username);
    normalized.push({
      username,
      password,
      displayName: String(item.displayName ?? username).trim() || username,
      role
    });
  }
  return normalized;
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(String(password ?? ""), salt, SCRYPT_KEY_LENGTH, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("base64url")}$${Buffer.from(key).toString("base64url")}`;
}

export async function verifyPassword(password, storedHash) {
  const parts = String(storedHash ?? "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, n, r, p, saltValue, hashValue] = parts;
  const expected = Buffer.from(hashValue, "base64url");
  const actual = await scryptAsync(String(password ?? ""), Buffer.from(saltValue, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024
  });
  const actualBuffer = Buffer.from(actual);
  return actualBuffer.length === expected.length && timingSafeEqual(actualBuffer, expected);
}

function safeCompare(a, b) {
  const left = Buffer.from(String(a ?? ""), "utf8");
  const right = Buffer.from(String(b ?? ""), "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function sha256Buffer(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest();
}

function nullableSha256Buffer(value) {
  return value ? sha256Buffer(value) : null;
}

function uid(prefix) {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

function formatMysqlDate(date) {
  return date.toISOString().slice(0, 23).replace("T", " ");
}

function normalizeRole(role) {
  const clean = String(role || "").trim();
  if (clean === "admin") return "admin";
  if (clean === "trial") return "trial";
  return "user";
}

function userFromDbRow(row) {
  if (!row) return null;
  const roles = String(row.roles ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const permissions = Object.fromEntries(String(row.permissions ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => [item, true]));
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: roles.includes("admin") ? "admin" : roles.includes("trial") ? "trial" : "user",
    roles,
    permissions,
    passwordHash: row.password_hash,
    passwordAlgo: row.password_algo
  };
}

function parseMysqlConfigFromEnv(env = process.env) {
  if (env.AIGC_DATABASE_URL) {
    const url = new URL(env.AIGC_DATABASE_URL);
    if (!["mysql:", "mysql2:"].includes(url.protocol)) {
      throw new Error("AIGC_DATABASE_URL must use mysql://");
    }
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
  if (!host || !database || !user) {
    throw new Error("MySQL is partially configured; set AIGC_DB_HOST, AIGC_DB_NAME, AIGC_DB_USER, and AIGC_DB_PASSWORD");
  }
  return {
    host,
    port: Number(env.AIGC_DB_PORT || env.MYSQL_PORT || 3306),
    user,
    password: env.AIGC_DB_PASSWORD || env.MYSQL_PASSWORD || "",
    database,
    connectionLimit: Number(env.AIGC_DB_CONNECTION_LIMIT || 10)
  };
}

export function createAuthStore(options = {}) {
  const mysqlConfig = options.mysqlConfig === undefined ? parseMysqlConfigFromEnv(options.env ?? process.env) : options.mysqlConfig;
  if (mysqlConfig) return new MysqlAuthStore({ ...options, mysqlConfig });
  return new JsonAuthStore(options);
}

class JsonAuthStore {
  constructor({ usersPath }) {
    if (!usersPath) throw new Error("usersPath is required");
    this.usersPath = usersPath;
    this.users = [];
    this.sessions = new Map();
  }

  async init() {
    if (!existsSync(this.usersPath)) {
      this.users = normalizeUsers([{ username: "admin", password: "admin123", displayName: "管理员", role: "admin" }]);
      await this.save();
      return;
    }
    const data = parseJsonFileContent(await readFile(this.usersPath, "utf8"), "users.json");
    this.users = normalizeUsers(Array.isArray(data) ? data : data.users);
    if (!this.users.length) throw new Error("users.json 中没有可用账号，请在服务器上添加 username/password");
  }

  async save() {
    await writeFile(this.usersPath, `${JSON.stringify({ users: this.users }, null, 2)}\n`, "utf8");
  }

  async login(username, password) {
    const cleanUsername = sanitizeSegment(username, "");
    const user = this.users.find((item) => item.username === cleanUsername);
    if (!user || !safeCompare(user.password, password)) return { authenticated: false };
    const token = randomBytes(32).toString("hex");
    this.sessions.set(token, { username: user.username, createdAt: Date.now() });
    return { authenticated: true, token, user: publicUser(user) };
  }

  async logout(token) {
    if (token) this.sessions.delete(token);
  }

  async userFromSessionToken(token) {
    const session = this.sessions.get(token);
    if (!session) return null;
    const user = this.users.find((item) => item.username === session.username);
    if (!user) {
      this.sessions.delete(token);
      return null;
    }
    return user;
  }

  async listUsers() {
    return this.users.map((user) => ({
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      isAdmin: user.role === "admin",
      isTrial: user.role === "trial"
    }));
  }

  async createUser(body = {}) {
    const username = sanitizeSegment(body.username, "");
    const password = String(body.password ?? "");
    const displayName = String(body.displayName ?? username).trim() || username;
    const role = normalizeRole(body.role);
    if (!username) throw new Error("请输入账号");
    if (!password) throw new Error("请输入密码");
    if (this.users.some((item) => item.username === username)) throw new Error("账号已存在");
    this.users.push({ username, password, displayName, role });
    await this.save();
    return { ok: true, users: await this.listUsers() };
  }

  async updateUser(body = {}, actor = {}) {
    const username = sanitizeSegment(body.username, "");
    const user = this.users.find((item) => item.username === username);
    if (!user) throw new Error("账号不存在");
    const nextDisplayName = String(body.displayName ?? user.displayName).trim();
    const nextPassword = body.password == null ? "" : String(body.password);
    const nextRole = normalizeRole(body.role);
    if (nextDisplayName) user.displayName = nextDisplayName;
    if (nextPassword) user.password = nextPassword;
    if (user.username !== actor.username) {
      user.role = nextRole;
    }
    if (!this.users.some((item) => item.role === "admin")) user.role = "admin";
    await this.save();
    return { ok: true, users: await this.listUsers() };
  }

  async deleteUser(username, actor = {}) {
    const cleanUsername = sanitizeSegment(username, "");
    if (!cleanUsername) throw new Error("请选择要删除的账号");
    if (cleanUsername === actor.username) throw new Error("不能删除当前登录的管理员账号");
    const target = this.users.find((item) => item.username === cleanUsername);
    if (!target) throw new Error("账号不存在");
    if (target.role === "admin" && this.users.filter((item) => item.role === "admin").length <= 1) {
      throw new Error("至少保留一个管理员账号");
    }
    this.users = this.users.filter((item) => item.username !== cleanUsername);
    for (const [token, session] of this.sessions) {
      if (session.username === cleanUsername) this.sessions.delete(token);
    }
    await this.save();
    return { ok: true, users: await this.listUsers() };
  }
}

class MysqlAuthStore {
  constructor({ usersPath, mysqlConfig, pool }) {
    this.usersPath = usersPath;
    this.mysqlConfig = mysqlConfig;
    this.pool = pool ?? null;
  }

  async init() {
    if (!this.pool) {
      const mysql = await import("mysql2/promise");
      this.pool = mysql.createPool({
        ...this.mysqlConfig,
        waitForConnections: true,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 30000,
        timezone: "Z"
      });
    }
    await this.assertSchema();
    await this.seedRoles();
    await this.importInitialUsers();
  }

  async close() {
    await this.pool?.end?.();
  }

  async assertSchema() {
    const [rows] = await this.pool.execute(
      "SELECT version FROM app_schema_migrations WHERE version = ? LIMIT 1",
      ["0001_mysql_foundation"]
    );
    if (!rows.length) {
      throw new Error("MySQL schema is missing migration 0001_mysql_foundation; run database/migrations/0001_mysql_foundation.sql first");
    }
  }

  async seedRoles() {
    await this.pool.execute(
      "INSERT INTO rbac_roles (role_key, display_name, description, is_system) VALUES (?, ?, ?, ?), (?, ?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), description = VALUES(description)",
      ["user", "普通用户", "可创建自己的批次、改造任务和模板版本", 1, "admin", "管理员", "拥有账号、模板、审计和项目管理权限", 1]
    );
    await this.pool.execute(
      "INSERT INTO rbac_roles (role_key, display_name, description, is_system) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), description = VALUES(description)",
      ["trial", "试用用户", "使用管理员配置的试用 API Key，并受每日图片/视频额度限制", 1]
    );
    const permissions = [
      ["wangzhuan:view", "查看网赚素材管线", "查看入口、模板、图库"],
      ["template:create_version", "创建模板版本", "新建、复制、编辑模板为新版本"],
      ["template:admin", "管理模板", "删除、改名、设默认、回滚模板"],
      ["batch:create", "创建批次", "创建自己的 pipeline 批次"],
      ["batch:own", "管理自己的批次", "查看、停止、下载自己的批次"],
      ["batch:admin", "管理项目批次", "管理员管理项目内批次"],
      ["remix:create", "创建竞品改造", "创建自己的竞品改造任务"],
      ["remix:own", "管理自己的竞品改造", "查看、确认、下载自己的改造任务"],
      ["remix:admin", "管理项目改造任务", "管理员管理项目内改造任务"],
      ["audit:view", "查看审计", "管理员查看审计事件"]
    ];
    for (const [key, displayName, description] of permissions) {
      await this.pool.execute(
        "INSERT INTO rbac_permissions (permission_key, display_name, description) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE display_name = VALUES(display_name), description = VALUES(description)",
        [key, displayName, description]
      );
    }
    await this.pool.execute(
      `INSERT IGNORE INTO rbac_role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM rbac_roles r
      CROSS JOIN rbac_permissions p
      WHERE r.role_key = 'user'
        AND p.permission_key IN ('wangzhuan:view', 'template:create_version', 'batch:create', 'batch:own', 'remix:create', 'remix:own')`
    );
    await this.pool.execute(
      `INSERT IGNORE INTO rbac_role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM rbac_roles r
      CROSS JOIN rbac_permissions p
      WHERE r.role_key = 'trial'
        AND p.permission_key IN ('wangzhuan:view', 'template:create_version', 'batch:create', 'batch:own', 'remix:create', 'remix:own')`
    );
    await this.pool.execute(
      `INSERT IGNORE INTO rbac_role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM rbac_roles r
      CROSS JOIN rbac_permissions p
      WHERE r.role_key = 'admin'`
    );
  }

  async importInitialUsers() {
    const [rows] = await this.pool.execute(
      "SELECT COUNT(*) AS total FROM app_users WHERE deleted_at IS NULL"
    );
    if (Number(rows[0]?.total ?? 0) > 0) return;

    let sourceUsers = [];
    if (this.usersPath && existsSync(this.usersPath)) {
      const data = parseJsonFileContent(await readFile(this.usersPath, "utf8"), "users.json");
      sourceUsers = normalizeUsers(Array.isArray(data) ? data : data.users);
    }
    if (!sourceUsers.length) {
      sourceUsers = normalizeUsers([{ username: "admin", password: "admin123", displayName: "管理员", role: "admin" }]);
    }

    for (const user of sourceUsers) {
      await this.insertUser(user, null);
    }
  }

  async insertUser(user, actor = null) {
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      const passwordHash = await hashPassword(user.password);
      const [result] = await conn.execute(
        "INSERT INTO app_users (user_uid, username, display_name, password_hash, password_algo, status, password_updated_at) VALUES (?, ?, ?, ?, ?, 'active', UTC_TIMESTAMP(3))",
        [uid("usr"), user.username, user.displayName, passwordHash, "scrypt"]
      );
      const userId = result.insertId;
      const [roleRows] = await conn.execute(
        "SELECT id FROM rbac_roles WHERE role_key = ? LIMIT 1",
        [normalizeRole(user.role)]
      );
      if (!roleRows.length) throw new Error("角色不存在，请先执行 RBAC 初始化");
      const actorId = actor?.id ?? null;
      await conn.execute(
        "INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)",
        [userId, roleRows[0].id, actorId]
      );
      await conn.commit();
      return userId;
    } catch (error) {
      await conn.rollback();
      if (error?.code === "ER_DUP_ENTRY") throw new Error("账号已存在");
      throw error;
    } finally {
      conn.release();
    }
  }

  async findUserByUsername(username, conn = this.pool) {
    const [rows] = await conn.execute(
      `SELECT
        u.id,
        u.username,
        u.display_name,
        u.password_hash,
        u.password_algo,
        GROUP_CONCAT(DISTINCT r.role_key ORDER BY r.role_key SEPARATOR ',') AS roles,
        GROUP_CONCAT(DISTINCT p.permission_key ORDER BY p.permission_key SEPARATOR ',') AS permissions
      FROM app_users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN rbac_roles r ON r.id = ur.role_id
      LEFT JOIN rbac_role_permissions rp ON rp.role_id = r.id
      LEFT JOIN rbac_permissions p ON p.id = rp.permission_id
      WHERE u.username = ? AND u.status = 'active' AND u.deleted_at IS NULL
      GROUP BY u.id, u.username, u.display_name, u.password_hash, u.password_algo
      LIMIT 1`,
      [sanitizeSegment(username, "")]
    );
    return userFromDbRow(rows[0]);
  }

  async findUserBySessionToken(token) {
    const tokenHash = sha256Buffer(token);
    const [rows] = await this.pool.execute(
      `SELECT
        u.id,
        u.username,
        u.display_name,
        u.password_hash,
        u.password_algo,
        GROUP_CONCAT(DISTINCT r.role_key ORDER BY r.role_key SEPARATOR ',') AS roles,
        GROUP_CONCAT(DISTINCT p.permission_key ORDER BY p.permission_key SEPARATOR ',') AS permissions
      FROM auth_sessions s
      INNER JOIN app_users u ON u.id = s.user_id
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN rbac_roles r ON r.id = ur.role_id
      LEFT JOIN rbac_role_permissions rp ON rp.role_id = r.id
      LEFT JOIN rbac_permissions p ON p.id = rp.permission_id
      WHERE s.session_token_hash = ?
        AND s.status = 'active'
        AND s.expires_at > UTC_TIMESTAMP(3)
        AND u.status = 'active'
        AND u.deleted_at IS NULL
      GROUP BY u.id, u.username, u.display_name, u.password_hash, u.password_algo
      LIMIT 1`,
      [tokenHash]
    );
    return userFromDbRow(rows[0]);
  }

  async userFromSessionToken(token) {
    if (!token) return null;
    const user = await this.findUserBySessionToken(token);
    if (!user) return null;
    await this.pool.execute(
      "UPDATE auth_sessions SET last_seen_at = UTC_TIMESTAMP(3) WHERE session_token_hash = ? AND status = 'active'",
      [sha256Buffer(token)]
    );
    return user;
  }

  async login(username, password, metadata = {}) {
    const cleanUsername = sanitizeSegment(username, "");
    const user = await this.findUserByUsername(cleanUsername);
    const ok = user && user.passwordAlgo === "scrypt" && await verifyPassword(password, user.passwordHash);
    await this.recordLoginAttempt({
      username: cleanUsername,
      userId: user?.id ?? null,
      result: ok ? "succeeded" : "failed",
      failureCode: ok ? null : "bad_credentials",
      ip: metadata.ip,
      userAgent: metadata.userAgent
    });
    if (!ok) return { authenticated: false };

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000);
    await this.pool.execute(
      `INSERT INTO auth_sessions
        (session_uid, user_id, session_token_hash, status, ip_hash, user_agent_hash, created_at, last_seen_at, expires_at)
      VALUES (?, ?, ?, 'active', ?, ?, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), ?)`,
      [
        uid("ses"),
        user.id,
        sha256Buffer(token),
        nullableSha256Buffer(metadata.ip),
        nullableSha256Buffer(metadata.userAgent),
        formatMysqlDate(expiresAt)
      ]
    );
    await this.pool.execute(
      "UPDATE app_users SET last_login_at = UTC_TIMESTAMP(3) WHERE id = ?",
      [user.id]
    );
    return { authenticated: true, token, user: publicUser(user) };
  }

  async recordLoginAttempt({ username, userId, result, failureCode, ip, userAgent }) {
    await this.pool.execute(
      `INSERT INTO auth_login_attempts
        (username, user_id, result, failure_code, ip_hash, user_agent_hash, occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3))`,
      [username, userId, result, failureCode, nullableSha256Buffer(ip), nullableSha256Buffer(userAgent)]
    );
  }

  async logout(token) {
    if (!token) return;
    await this.pool.execute(
      "UPDATE auth_sessions SET status = 'revoked', revoked_at = UTC_TIMESTAMP(3) WHERE session_token_hash = ? AND status = 'active'",
      [sha256Buffer(token)]
    );
  }

  async listUsers() {
    const [rows] = await this.pool.execute(
      `SELECT
        u.id,
        u.username,
        u.display_name,
        u.password_hash,
        u.password_algo,
        GROUP_CONCAT(DISTINCT r.role_key ORDER BY r.role_key SEPARATOR ',') AS roles,
        GROUP_CONCAT(DISTINCT p.permission_key ORDER BY p.permission_key SEPARATOR ',') AS permissions
      FROM app_users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN rbac_roles r ON r.id = ur.role_id
      LEFT JOIN rbac_role_permissions rp ON rp.role_id = r.id
      LEFT JOIN rbac_permissions p ON p.id = rp.permission_id
      WHERE u.status = 'active' AND u.deleted_at IS NULL
      GROUP BY u.id, u.username, u.display_name, u.password_hash, u.password_algo
      ORDER BY u.created_at ASC, u.id ASC`
    );
    return rows.map((row) => {
      const user = userFromDbRow(row);
      return {
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        isAdmin: user.role === "admin",
        isTrial: user.role === "trial"
      };
    });
  }

  async createUser(body = {}, actor = {}) {
    const username = sanitizeSegment(body.username, "");
    const password = String(body.password ?? "");
    const displayName = String(body.displayName ?? username).trim() || username;
    const role = normalizeRole(body.role);
    if (!username) throw new Error("请输入账号");
    if (!password) throw new Error("请输入密码");
    const actorUser = actor?.username ? await this.findUserByUsername(actor.username) : null;
    await this.insertUser({ username, password, displayName, role }, actorUser);
    return { ok: true, users: await this.listUsers() };
  }

  async updateUser(body = {}, actor = {}) {
    const username = sanitizeSegment(body.username, "");
    const user = await this.findUserByUsername(username);
    if (!user) throw new Error("账号不存在");
    const nextDisplayName = String(body.displayName ?? user.displayName).trim();
    const nextPassword = body.password == null ? "" : String(body.password);
    const nextRole = normalizeRole(body.role);
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      if (nextDisplayName) {
        await conn.execute(
          "UPDATE app_users SET display_name = ? WHERE id = ? AND status = 'active'",
          [nextDisplayName, user.id]
        );
      }
      if (nextPassword) {
        await conn.execute(
          "UPDATE app_users SET password_hash = ?, password_algo = 'scrypt', password_updated_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'active'",
          [await hashPassword(nextPassword), user.id]
        );
      }
      if (user.username !== actor.username) {
        await this.setUserRole(conn, user.id, nextRole, actor.username);
      }
      const [adminRows] = await conn.execute(
        `SELECT COUNT(*) AS total
        FROM app_users u
        INNER JOIN user_roles ur ON ur.user_id = u.id
        INNER JOIN rbac_roles r ON r.id = ur.role_id AND r.role_key = 'admin'
        WHERE u.status = 'active' AND u.deleted_at IS NULL`
      );
      if (Number(adminRows[0]?.total ?? 0) < 1) {
        await this.setUserRole(conn, user.id, "admin", actor.username);
      }
      await conn.commit();
      return { ok: true, users: await this.listUsers() };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async setUserRole(conn, userId, role, actorUsername) {
    const [roleRows] = await conn.execute(
      "SELECT id FROM rbac_roles WHERE role_key = ? LIMIT 1",
      [normalizeRole(role)]
    );
    if (!roleRows.length) throw new Error("角色不存在，请先执行 RBAC 初始化");
    let actorId = null;
    if (actorUsername) {
      const actor = await this.findUserByUsername(actorUsername, conn);
      actorId = actor?.id ?? null;
    }
    await conn.execute("DELETE FROM user_roles WHERE user_id = ?", [userId]);
    await conn.execute(
      "INSERT INTO user_roles (user_id, role_id, granted_by) VALUES (?, ?, ?)",
      [userId, roleRows[0].id, actorId]
    );
  }

  async deleteUser(username, actor = {}) {
    const cleanUsername = sanitizeSegment(username, "");
    if (!cleanUsername) throw new Error("请选择要删除的账号");
    if (cleanUsername === actor.username) throw new Error("不能删除当前登录的管理员账号");
    const target = await this.findUserByUsername(cleanUsername);
    if (!target) throw new Error("账号不存在");
    if (target.role === "admin" && await this.countAdmins() <= 1) {
      throw new Error("至少保留一个管理员账号");
    }
    const conn = await this.pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        "UPDATE app_users SET status = 'deleted', deleted_at = UTC_TIMESTAMP(3) WHERE id = ? AND status = 'active'",
        [target.id]
      );
      await conn.execute(
        "UPDATE auth_sessions SET status = 'revoked', revoked_at = UTC_TIMESTAMP(3) WHERE user_id = ? AND status = 'active'",
        [target.id]
      );
      await conn.commit();
      return { ok: true, users: await this.listUsers() };
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      conn.release();
    }
  }

  async countAdmins() {
    const [rows] = await this.pool.execute(
      `SELECT COUNT(*) AS total
      FROM app_users u
      INNER JOIN user_roles ur ON ur.user_id = u.id
      INNER JOIN rbac_roles r ON r.id = ur.role_id AND r.role_key = 'admin'
      WHERE u.status = 'active' AND u.deleted_at IS NULL`
    );
    return Number(rows[0]?.total ?? 0);
  }
}
