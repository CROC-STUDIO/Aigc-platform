import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("idempotency owner migration adds a fenced claim token with verify and rollback", async () => {
  const [migration, verify, down] = await Promise.all([
    readFile(new URL("database/migrations/0017_idempotency_owner_token.sql", root), "utf8").catch(() => ""),
    readFile(new URL("database/migrations/0017_idempotency_owner_token.verify.sql", root), "utf8").catch(() => ""),
    readFile(new URL("database/migrations/0017_idempotency_owner_token.down.sql", root), "utf8").catch(() => "")
  ]);

  assert.match(migration, /ALTER TABLE idempotency_keys[\s\S]*ADD COLUMN owner_token VARCHAR\(80\)/i);
  assert.match(migration, /0017_idempotency_owner_token/);
  assert.match(verify, /information_schema\.columns/i);
  assert.match(verify, /owner_token/i);
  assert.match(down, /DROP COLUMN owner_token/i);
  assert.match(down, /DELETE FROM app_schema_migrations/i);
});
