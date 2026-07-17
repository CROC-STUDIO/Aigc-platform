import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import * as mysqlFacts from "../../server/wangzhuan/mysql-facts.mjs";

function context() {
  return {
    userId: "admin",
    user: { username: "admin", role: "admin", isAdmin: true },
    currentUserId: () => "admin",
    currentProjectRoot: () => "/data/project-a",
    currentBaseProjectRoot: () => "/data/project-a"
  };
}

function sha256Buffer(value) {
  return createHash("sha256").update(String(value)).digest();
}

function keyFromParts(userId, projectId, endpoint, hash) {
  return `${userId}:${projectId}:${endpoint}:${Buffer.from(hash).toString("hex")}`;
}

function keyFromSqlParams(params) {
  const hashIndex = params.findIndex((value) => Buffer.isBuffer(value) && value.length === 32);
  assert.ok(hashIndex >= 3, "idempotency SQL must bind the scoped key hash");
  return keyFromParts(params[hashIndex - 3], params[hashIndex - 2], params[hashIndex - 1], params[hashIndex]);
}

function placeholderParamAt(sql, params, position) {
  if (position < 0) return undefined;
  const index = (sql.slice(0, position).match(/\?/g) || []).length;
  return params[index];
}

function assignmentParam(sql, params, column) {
  const position = sql.indexOf(`${column} = ?`);
  return placeholderParamAt(sql, params, position);
}

function ownerGuardParam(sql, params) {
  const ownerColumns = ["owner_token", "claim_token"];
  for (const column of ownerColumns) {
    const position = sql.lastIndexOf(`${column} = ?`);
    if (position >= 0) return placeholderParamAt(sql, params, position);
  }
  return undefined;
}

function hasOwnerGuard(sql) {
  return /\b(?:owner_token|claim_token)\s*=\s*\?/.test(sql);
}

function requestHashParam(params) {
  return params.find((value) => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value));
}

function idempotencyFactsPool(initialNowMs = Date.now()) {
  const rows = new Map();
  let nowMs = initialNowMs;

  const connection = {
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    release() {},
    async execute(sql, params = []) {
      const text = String(sql);
      if (text.includes("SELECT id FROM app_users")) return [[{ id: 11 }]];
      if (text.includes("SELECT id FROM projects WHERE project_key")) return [[{ id: 22 }]];
      if (text.includes("INSERT INTO project_members")) return [{ affectedRows: 1 }];

      if (text.includes("DELETE FROM idempotency_keys")) {
        const key = keyFromParts(params[0], params[1], params[2], params[3]);
        const row = rows.get(key);
        const preservesProcessing = /status\s*<>\s*'processing'/i.test(text);
        if (row
          && Date.parse(row.expiresAt) <= nowMs
          && (!preservesProcessing || row.status !== "processing")) rows.delete(key);
        return [{ affectedRows: row && !rows.has(key) ? 1 : 0 }];
      }

      if (text.includes("INSERT IGNORE INTO idempotency_keys")) {
        const key = keyFromParts(params[0], params[1], params[2], params[3]);
        if (rows.has(key)) return [{ affectedRows: 0 }];
        const explicitOwner = params.find((value) => typeof value === "string" && value.startsWith("idem-owner-"));
        rows.set(key, {
          id: rows.size + 1,
          requestHash: params[4],
          status: "processing",
          response: null,
          resourceType: null,
          resourceId: null,
          ownerToken: explicitOwner || null,
          expiresAt: params.at(-1)
        });
        return [{ affectedRows: 1 }];
      }

      if (text.includes("FROM idempotency_keys") && text.includes("FOR UPDATE")) {
        const row = rows.get(keyFromSqlParams(params));
        return [[row ? {
          id: row.id,
          request_hash: row.requestHash,
          status: row.status,
          response_json: row.response == null ? null : JSON.stringify(row.response),
          owner_token: row.ownerToken,
          claim_token: row.ownerToken,
          expires_at: row.expiresAt
        } : undefined].filter(Boolean)];
      }

      if (text.includes("UPDATE idempotency_keys") && text.includes("SET status = 'processing'")) {
        const row = [...rows.values()].find((candidate) => params.includes(candidate.id));
        const requestHash = requestHashParam(params);
        const expired = row && Date.parse(row.expiresAt) <= nowMs;
        if (!row || row.requestHash !== requestHash || (row.status !== "failed" && !(row.status === "processing" && expired))) {
          return [{ affectedRows: 0 }];
        }
        row.status = "processing";
        row.response = null;
        row.expiresAt = assignmentParam(text, params, "expires_at") || row.expiresAt;
        row.ownerToken = assignmentParam(text, params, "owner_token")
          || assignmentParam(text, params, "claim_token")
          || row.ownerToken;
        return [{ affectedRows: 1 }];
      }

      if (text.includes("UPDATE idempotency_keys") && text.includes("status = 'succeeded'")) {
        const row = rows.get(keyFromSqlParams(params));
        const requestHash = requestHashParam(params);
        const suppliedOwner = ownerGuardParam(text, params);
        if (!row
          || row.requestHash !== requestHash
          || row.status !== "processing"
          || (hasOwnerGuard(text) && row.ownerToken && suppliedOwner !== row.ownerToken)) {
          return [{ affectedRows: 0 }];
        }
        row.status = "succeeded";
        row.resourceType = assignmentParam(text, params, "resource_type") ?? null;
        row.resourceId = assignmentParam(text, params, "resource_id") ?? null;
        row.response = JSON.parse(assignmentParam(text, params, "response_json") || "{}");
        row.expiresAt = assignmentParam(text, params, "expires_at") || row.expiresAt;
        return [{ affectedRows: 1 }];
      }

      if (text.includes("UPDATE idempotency_keys") && text.includes("SET status = 'failed'")) {
        const row = rows.get(keyFromSqlParams(params));
        const requestHash = requestHashParam(params);
        const suppliedOwner = ownerGuardParam(text, params);
        if (!row
          || row.requestHash !== requestHash
          || row.status !== "processing"
          || (hasOwnerGuard(text) && row.ownerToken && suppliedOwner !== row.ownerToken)) {
          return [{ affectedRows: 0 }];
        }
        row.status = "failed";
        row.response = JSON.parse(assignmentParam(text, params, "response_json") || "{}");
        return [{ affectedRows: 1 }];
      }

      if (text.includes("UPDATE idempotency_keys") && text.includes("SET expires_at = ?")) {
        const row = rows.get(keyFromSqlParams(params));
        const requestHash = requestHashParam(params);
        const suppliedOwner = ownerGuardParam(text, params);
        if (!row
          || row.requestHash !== requestHash
          || row.status !== "processing"
          || suppliedOwner !== row.ownerToken) {
          return [{ affectedRows: 0 }];
        }
        row.expiresAt = assignmentParam(text, params, "expires_at") || row.expiresAt;
        return [{ affectedRows: 1 }];
      }

      throw new Error(`unexpected SQL: ${text}`);
    }
  };

  function rowFor(endpoint, idempotencyKey) {
    return rows.get(keyFromParts(11, 22, endpoint, sha256Buffer(idempotencyKey)));
  }

  return {
    pool: { async getConnection() { return connection; } },
    rowFor,
    advanceTo(timestampMs) { nowMs = timestampMs; },
    seed({ endpoint, idempotencyKey, requestHash, ownerToken, status = "processing" }) {
      rows.set(keyFromParts(11, 22, endpoint, sha256Buffer(idempotencyKey)), {
        id: rows.size + 1,
        requestHash,
        status,
        response: null,
        resourceType: null,
        resourceId: null,
        ownerToken,
        expiresAt: new Date(nowMs + 60_000).toISOString().slice(0, 23).replace("T", " ")
      });
    }
  };
}

test.afterEach(async () => {
  await mysqlFacts.closeWangzhuanFactsPool();
});

test("processing idempotency ownership uses a short lease and returns its owner token", async () => {
  const startedAt = Date.now();
  const fake = idempotencyFactsPool(startedAt);
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const endpoint = "remix_start";
  const idempotencyKey = "lease-key";
  const requestHash = "a".repeat(64);

  const first = await mysqlFacts.claimIdempotencyFact(
    context(),
    endpoint,
    idempotencyKey,
    requestHash,
    { leaseSeconds: 60, ownerToken: "idem-owner-a" }
  );
  const firstRow = fake.rowFor(endpoint, idempotencyKey);
  const leaseMs = Date.parse(`${firstRow.expiresAt.replace(" ", "T")}Z`) - startedAt;
  assert.ok(leaseMs >= 30_000 && leaseMs <= 90_000, `processing lease must be short; received ${leaseMs}ms`);
  assert.equal(first.ownerToken, "idem-owner-a");
});

test("an expired processing claim can be taken over by a new owner", async () => {
  const startedAt = Date.now();
  const fake = idempotencyFactsPool(startedAt);
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const endpoint = "remix_start";
  const idempotencyKey = "takeover-key";
  const requestHash = "e".repeat(64);

  const first = await mysqlFacts.claimIdempotencyFact(
    context(),
    endpoint,
    idempotencyKey,
    requestHash,
    { leaseSeconds: 60, ownerToken: "idem-owner-a" }
  );

  fake.advanceTo(startedAt + 120_000);
  const second = await mysqlFacts.claimIdempotencyFact(
    context(),
    endpoint,
    idempotencyKey,
    requestHash,
    { leaseSeconds: 60, ownerToken: "idem-owner-b" }
  );
  assert.equal(second.owner, true);
  assert.equal(second.ownerToken, "idem-owner-b");
  assert.notEqual(second.ownerToken, first.ownerToken);
});

test("an expired processing claim still rejects the same key with a different request hash", async () => {
  const startedAt = Date.now();
  const fake = idempotencyFactsPool(startedAt);
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const endpoint = "remix_start";
  const idempotencyKey = "expired-conflict-key";
  const originalHash = "1".repeat(64);

  await mysqlFacts.claimIdempotencyFact(
    context(),
    endpoint,
    idempotencyKey,
    originalHash,
    { leaseSeconds: 60, ownerToken: "idem-owner-a" }
  );
  fake.advanceTo(startedAt + 120_000);

  await assert.rejects(
    mysqlFacts.claimIdempotencyFact(
      context(),
      endpoint,
      idempotencyKey,
      "2".repeat(64),
      { leaseSeconds: 60, ownerToken: "idem-owner-b" }
    ),
    (error) => error?.code === "idempotency_conflict"
  );
  assert.equal(fake.rowFor(endpoint, idempotencyKey).requestHash, originalHash);
});

test("a stale owner token cannot complete a claim after another owner takes over", async () => {
  const fake = idempotencyFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const endpoint = "batches_start";
  const idempotencyKey = "stale-complete-key";
  const requestHash = "b".repeat(64);
  fake.seed({ endpoint, idempotencyKey, requestHash, ownerToken: "idem-owner-new" });

  await assert.rejects(
    mysqlFacts.completeIdempotencyFact(
      context(),
      endpoint,
      idempotencyKey,
      requestHash,
      { type: "batch", resourceId: 77, response: { batchId: "wzb_safe" } },
      { ownerToken: "idem-owner-stale" }
    ),
    (error) => error?.code === "idempotency_conflict"
  );
  assert.equal(fake.rowFor(endpoint, idempotencyKey).status, "processing");
});

test("a stale owner token cannot fail a claim after another owner takes over", async () => {
  const fake = idempotencyFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const endpoint = "batches_start";
  const idempotencyKey = "stale-fail-key";
  const requestHash = "c".repeat(64);
  fake.seed({ endpoint, idempotencyKey, requestHash, ownerToken: "idem-owner-new" });

  const result = await mysqlFacts.failIdempotencyFact(
    context(),
    endpoint,
    idempotencyKey,
    requestHash,
    Object.assign(new Error("temporary"), { code: "upstream_failed" }),
    { ownerToken: "idem-owner-stale" }
  );
  assert.equal(result.skipped, true);
  assert.equal(fake.rowFor(endpoint, idempotencyKey).status, "processing");
});

test("only the current owner can renew a processing lease", async () => {
  const fake = idempotencyFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const endpoint = "batches_plan";
  const idempotencyKey = "heartbeat-key";
  const requestHash = "f".repeat(64);
  fake.seed({ endpoint, idempotencyKey, requestHash, ownerToken: "idem-owner-current" });

  assert.equal(typeof mysqlFacts.renewIdempotencyFact, "function");
  const stale = await mysqlFacts.renewIdempotencyFact(
    context(), endpoint, idempotencyKey, requestHash,
    { ownerToken: "idem-owner-stale", leaseSeconds: 60 }
  );
  assert.equal(stale.skipped, true);
  const current = await mysqlFacts.renewIdempotencyFact(
    context(), endpoint, idempotencyKey, requestHash,
    { ownerToken: "idem-owner-current", leaseSeconds: 60 }
  );
  assert.equal(current.skipped, false);
});

test("completed idempotency facts persist stable identifiers without signed asset URLs", async () => {
  const fake = idempotencyFactsPool();
  mysqlFacts.setWangzhuanFactsPoolForTest(fake.pool);
  const endpoint = "batches_start";
  const idempotencyKey = "safe-summary-key";
  const requestHash = "d".repeat(64);

  const response = await mysqlFacts.runIdempotentOperation(
    context(),
    endpoint,
    idempotencyKey,
    requestHash,
    async () => ({
      batchId: "wzb_20260717000000_safe",
      previewUrl: "https://cdn.example/out.mp4?X-Amz-Signature=preview-secret",
      storageUrl: "https://bucket.example/out.mp4?token=storage-secret",
      prompt: "raw paid prompt must not be persisted",
      request: { knowledgeNotes: "private request body" },
      outputs: [{ outputId: "out_safe_001", previewUrl: "https://cdn.example/nested.mp4?token=nested-secret" }]
    }),
    { resourceType: "batch", resourceId: 91 }
  );

  assert.equal(response.batchId, "wzb_20260717000000_safe");
  const row = fake.rowFor(endpoint, idempotencyKey);
  assert.equal(row.resourceType, "batch");
  assert.equal(row.resourceId, 91);
  assert.equal(row.response.batchId, "wzb_20260717000000_safe");
  assert.doesNotMatch(JSON.stringify(row.response), /storageUrl|previewUrl|X-Amz-Signature|(?:^|[?&])token=/i);
  assert.doesNotMatch(JSON.stringify(row.response), /raw paid prompt|private request body|knowledgeNotes|"prompt"/i);
});
