import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL("../../database/migrations/0015_generation_script_duration_5_30.sql", import.meta.url);
const verify = new URL("../../database/migrations/0015_generation_script_duration_5_30.verify.sql", import.meta.url);
const down = new URL("../../database/migrations/0015_generation_script_duration_5_30.down.sql", import.meta.url);

test("generation script duration migration widens the constraint to 5-30 seconds", async () => {
  const [upSql, verifySql, downSql] = await Promise.all([
    readFile(migration, "utf8"),
    readFile(verify, "utf8"),
    readFile(down, "utf8")
  ]);

  assert.match(upSql, /DROP CHECK ck_generation_scripts_duration/i);
  assert.match(upSql, /duration_sec BETWEEN 5 AND 30/i);
  assert.match(upSql, /0015_generation_script_duration_5_30/);
  assert.match(verifySql, /between 5 and 30/i);
  assert.match(verifySql, /0015_generation_script_duration_5_30/);
  assert.match(downSql, /duration_sec BETWEEN 8 AND 30/i);
});
