import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("scheduler synchronization preserves every running lease", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const taskStart = source.indexOf("async function syncSchedulerJobs");
  const upstreamStart = source.indexOf("async function syncUpstreamPollJob");
  const end = source.indexOf("function schedulerWorkerId", upstreamStart);
  const taskBody = source.slice(taskStart, upstreamStart);
  const upstreamBody = source.slice(upstreamStart, end);

  assert.ok(taskStart >= 0);
  assert.ok(upstreamStart > taskStart);
  assert.ok(end > upstreamStart);
  for (const body of [taskBody, upstreamBody]) {
    assert.match(body, /run_after\s*=\s*IF\(status = 'running', run_after, VALUES\(run_after\)\)/);
    assert.match(body, /status\s*=\s*IF\(status = 'running', status, VALUES\(status\)\)/);
    assert.ok(body.indexOf("run_after = IF") < body.indexOf("status = IF"));
  }
});

test("scheduler claim can atomically recover an expired lease from another worker", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function claimSchedulerJob");
  const end = source.indexOf("export async function completeSchedulerJob", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(body, /sj\.status = 'running'\s+AND sj\.lock_expires_at <= UTC_TIMESTAMP\(3\)/s);
  assert.match(body, /status = 'running' AND lock_expires_at <= UTC_TIMESTAMP\(3\)/);
  assert.doesNotMatch(body, /sj\.locked_by = \?/);
});

test("production scheduler worker id includes the container hostname", async () => {
  const source = await readFile(new URL("../../server.mjs", import.meta.url), "utf8");

  assert.match(source, /workerId: `aigc-platform:\$\{hostname\(\)\}:\$\{process\.pid\}`/);
});

test("server ignores broken stdout pipes before logging uncaught exceptions", async () => {
  const source = await readFile(new URL("../../server.mjs", import.meta.url), "utf8");
  assert.match(
    source,
    /process\.on\("uncaughtException", \(error\) => \{\s*if \(error\?\.code === "EPIPE"\) return;/
  );
});

test("15s multi-slice or post-process batches keep upstream polling until stitched outputs exist", async () => {
  const source = await readFile(new URL("../../server/wangzhuan/mysql-facts.mjs", import.meta.url), "utf8");
  const start = source.indexOf("function shouldScheduleUpstreamPoll");
  const end = source.indexOf("async function syncUpstreamPollJob", start);
  const body = source.slice(start, end);

  assert.ok(start >= 0);
  assert.ok(end > start);
  assert.match(body, /schedulerBatchNeedsStitch\(batch\)/);
  assert.match(body, /!outputs\.some\(\(output\) => output\.kind === "stitched_video"\)/);
  assert.match(body, /schedulerRequiresPostProcess/);
  assert.match(body, /schedulerBatchHasMultiSliceGroups/);
});
