import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { schedulePoll } from "../../public/wangzhuan-common.js";

const root = new URL("../../", import.meta.url);

function createFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    window: {
      setTimeout(callback) {
        const id = nextId;
        nextId += 1;
        pending.set(id, callback);
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      }
    },
    pendingCount() {
      return pending.size;
    },
    takeNext() {
      const entry = pending.entries().next().value;
      assert.ok(entry, "expected a pending poll timer");
      const [id, callback] = entry;
      pending.delete(id);
      return callback;
    }
  };
}

async function withFakeWindow(run) {
  const originalWindow = globalThis.window;
  const timers = createFakeTimers();
  globalThis.window = timers.window;
  try {
    await run(timers);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
}

test("schedulePoll schedules one next tick after a transient load failure", async () => {
  await withFakeWindow(async (timers) => {
    let attempts = 0;
    const reportedErrors = [];
    const stop = schedulePoll({
      load: async () => {
        attempts += 1;
        throw new Error("temporary network failure");
      },
      onError: (error) => reportedErrors.push(error.message),
      shouldStop: () => false,
      interval: 4000
    });

    assert.equal(timers.pendingCount(), 1);
    await timers.takeNext()();

    assert.equal(attempts, 1);
    assert.deepEqual(reportedErrors, ["temporary network failure"]);
    assert.equal(timers.pendingCount(), 1);
    stop();
    assert.equal(timers.pendingCount(), 0);
  });
});

test("schedulePoll cannot revive after stop during an in-flight load", async () => {
  await withFakeWindow(async (timers) => {
    let resolveLoad;
    const loadResult = new Promise((resolve) => {
      resolveLoad = resolve;
    });
    const stop = schedulePoll({
      load: () => loadResult,
      shouldStop: () => false,
      interval: 4000
    });

    const inFlightTick = timers.takeNext()();
    stop();
    resolveLoad({ status: "running" });
    await inFlightTick;

    assert.equal(timers.pendingCount(), 0);
  });
});

test("selected detail loading does not recreate its polling owner", async () => {
  const source = await readFile(new URL("public/wangzhuan-tasks.js", root), "utf8");
  const start = source.indexOf("async function loadSelectedDetail");
  const end = source.indexOf("async function selectTask", start);
  assert.ok(start >= 0 && end > start, "expected loadSelectedDetail function");
  const body = source.slice(start, end);

  assert.doesNotMatch(body, /updatePagePolling\(\)/);
});

test("task manager shows a non-blocking poll error and clears it after recovery", async () => {
  const source = await readFile(new URL("public/wangzhuan-tasks.js", root), "utf8");
  const updateStart = source.indexOf("function updatePagePolling");
  const updateEnd = source.indexOf("function assetPreviewUrl", updateStart);
  const renderStart = source.indexOf("function renderDetailPanel");
  const renderEnd = source.indexOf("async function loadTasks", renderStart);
  const loadStart = source.indexOf("async function loadSelectedDetail");
  const loadEnd = source.indexOf("async function selectTask", loadStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart, "expected updatePagePolling function");
  assert.ok(renderStart >= 0 && renderEnd > renderStart, "expected renderDetailPanel function");
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "expected loadSelectedDetail function");

  assert.match(source, /pollError:\s*""/);
  assert.match(source.slice(updateStart, updateEnd), /onError:\s*\(error\)\s*=>/);
  assert.match(source.slice(renderStart, renderEnd), /刷新失败，正在重试/);
  assert.match(source.slice(loadStart, loadEnd), /state\.pollError = ""/);
});

test("segment retries reuse the workbench polling owner after a terminal partial batch", async () => {
  const source = await readFile(new URL("public/wangzhuan-v2.js", root), "utf8");
  const pollingStart = source.indexOf("function startBatchPolling");
  const pollingEnd = source.indexOf("async function restoreWorkbenchFromUrl", pollingStart);
  const loadStart = source.indexOf("async function loadBatchDetail");
  const loadEnd = source.indexOf("function startBatchPolling", loadStart);
  const recentStart = source.indexOf("async function openRecentResult");
  const recentEnd = source.indexOf("function failBackgroundJob", recentStart);
  const controllerStart = source.indexOf("const segmentRecoveryController");
  const controllerEnd = source.indexOf("function fileToDataUrl", controllerStart);
  const restoreStart = source.indexOf("async function restoreWorkbenchFromUrl");
  const restoreEnd = source.indexOf("async function confirmPlanAndGenerate", restoreStart);
  assert.ok(pollingStart >= 0 && pollingEnd > pollingStart, "expected workbench batch polling owner");
  assert.ok(loadStart >= 0 && loadEnd > loadStart, "expected batch detail loader");
  assert.ok(recentStart >= 0 && recentEnd > recentStart, "expected recent result loader");
  assert.ok(controllerStart >= 0 && controllerEnd > controllerStart, "expected recovery controller mount");
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, "expected workbench restore flow");

  assert.match(source, /let batchPollOwner = 0/);
  assert.match(source, /let batchDetailLoadOwner = 0/);
  assert.match(source.slice(loadStart, loadEnd), /const loadOwner = options\.apply === false \? 0 : \+\+batchDetailLoadOwner/);
  assert.match(source.slice(loadStart, loadEnd), /if \(options\.apply !== false && loadOwner !== batchDetailLoadOwner\) return null/);
  assert.match(source.slice(loadStart, loadEnd), /loadOwner === batchDetailLoadOwner/);
  assert.match(source.slice(pollingStart, pollingEnd), /followSegmentRecovery/);
  assert.match(source.slice(pollingStart, pollingEnd), /hasPendingSegmentRecovery\(detail\)/);
  assert.match(source.slice(pollingStart, pollingEnd), /const pollOwner = \+\+batchPollOwner/);
  assert.match(source.slice(pollingStart, pollingEnd), /pollOwner !== batchPollOwner/);
  assert.match(source.slice(controllerStart, controllerEnd), /onRetrySubmitted/);
  assert.match(source.slice(controllerStart, controllerEnd), /loadBatchDetail\(batchId\)/);
  assert.match(source.slice(controllerStart, controllerEnd), /startBatchPolling\(batchId, \{ followSegmentRecovery: true \}\)/);
  assert.match(source.slice(restoreStart, restoreEnd), /hasPendingSegmentRecovery\(detail\)/);
  assert.match(source.slice(recentStart, recentEnd), /stopBatchPolling\(\)/);
  assert.match(source.slice(recentStart, recentEnd), /if \(!detail\) return/);
  assert.match(source.slice(recentStart, recentEnd), /hasPendingSegmentRecovery\(detail\)/);
});
