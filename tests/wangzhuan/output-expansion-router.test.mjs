import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resetBackgroundJobsForTest } from "../../server/wangzhuan/background-jobs.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.headers = {};
    this.body = "";
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = "") {
    this.body += body;
    this.emit("finish");
  }
}

async function contextFor(body) {
  const root = await mkdtemp(join(tmpdir(), "wz-expand-router-"));
  return {
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    userId: "tester",
    userProjectRoot: root,
    sharedProjectRoot: root,
    config: {},
    readJson: async () => body,
    currentUser: () => ({ username: "tester", permissions: { "wangzhuan:view": true } }),
    currentUserId: () => "tester",
    currentProjectRoot: () => root,
    currentBaseProjectRoot: () => root,
    loadOutputDetailFromMysql: async () => ({
      outputId: "out_001",
      fileName: "out_001.mp4",
      filePath: "批处理记录/网赚管线/batches/wzb_1/out_001.mp4",
      previewUrl: "/file?path=abc.mp4",
      downloadEligible: true,
      batchId: "wzb_20260706000000_abcd"
    }),
    runOutputExpansion: async (_scoped, output, request) => ({
      jobId: "",
      outputId: output.outputId,
      status: "succeeded",
      targetWidth: request.targetWidth,
      targetHeight: request.targetHeight,
      sizeKey: `${request.targetWidth}x${request.targetHeight}`,
      fileName: `out_001__${request.targetWidth}x${request.targetHeight}.mp4`,
      storedPath: `批处理记录/网赚管线/expanded-outputs/out_001/out_001__${request.targetWidth}x${request.targetHeight}.mp4`,
      previewUrl: `/file?path=expanded-${request.targetWidth}x${request.targetHeight}.mp4`,
      downloadUrl: `/file?path=expanded-${request.targetWidth}x${request.targetHeight}.mp4`,
      requestId: "",
      updatedAt: new Date().toISOString()
    })
  };
}

async function call(method, pathname, body, providedContext = null) {
  const req = { method, headers: {} };
  const res = new TestResponse();
  const context = providedContext || await contextFor(body);
  await handleWangzhuanRequest(
    req,
    res,
    new URL(`http://127.0.0.1${pathname}`),
    context
  );
  return { statusCode: res.statusCode, payload: JSON.parse(res.body), context };
}

async function waitForStatus(pathname, status, context) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1500) {
    const polled = await call("GET", pathname, {}, context);
    if (polled.payload.data.items?.[0]?.status === status) return polled;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${status}`);
}

test.beforeEach(() => {
  resetBackgroundJobsForTest();
});

test("POST /api/wangzhuan/outputs/:outputId/expand returns queued expansion job", async () => {
  const context = await contextFor({
    targetWidth: 800,
    targetHeight: 800,
    mode: "blur_pad"
  });
  const response = await call("POST", "/api/wangzhuan/outputs/out_001/expand", {
    targetWidth: 800,
    targetHeight: 800,
    mode: "blur_pad"
  }, context);

  assert.equal(response.statusCode, 200);
  assert.equal(response.payload.code, "ok");
  assert.equal(response.payload.data.status, "queued");
  assert.match(response.payload.data.jobId, /^decompjob_|^planjob_/);
  assert.equal(response.payload.data.outputId, "out_001");
  assert.equal(response.payload.data.sizeKey, "800x800");
});

test("GET /api/wangzhuan/outputs/:outputId/expand-jobs returns persisted items ordered by update time", async () => {
  const context = await contextFor({
    targetWidth: 800,
    targetHeight: 800,
    mode: "blur_pad"
  });
  await call("POST", "/api/wangzhuan/outputs/out_001/expand", {
    targetWidth: 800,
    targetHeight: 800,
    mode: "blur_pad"
  }, context);
  const polled = await waitForStatus("/api/wangzhuan/outputs/out_001/expand-jobs", "succeeded", context);

  assert.equal(polled.statusCode, 200);
  assert.ok(Array.isArray(polled.payload.data.items));
  assert.equal(polled.payload.data.items[0].outputId, "out_001");
  assert.equal(polled.payload.data.items[0].sizeKey, "800x800");
});

test("expansion submit returns backend validation message for unsupported mode", async () => {
  const context = await contextFor({
    targetWidth: 800,
    targetHeight: 800,
    mode: "unsupported"
  });
  const response = await call("POST", "/api/wangzhuan/outputs/out_001/expand", {
    targetWidth: 800,
    targetHeight: 800,
    mode: "unsupported"
  }, context);

  assert.equal(response.statusCode, 400);
  assert.equal(response.payload.message, "当前仅支持 blur_pad 扩展模式");
});

test("GET expand-jobs dedupes same size and keeps latest job", async () => {
  const context = await contextFor({
    targetWidth: 800,
    targetHeight: 800,
    mode: "blur_pad"
  });
  context.runOutputExpansion = async (_scoped, output, request) => ({
    jobId: "",
    outputId: output.outputId,
    status: "succeeded",
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    sizeKey: `${request.targetWidth}x${request.targetHeight}`,
    fileName: `out_001__${request.targetWidth}x${request.targetHeight}.mp4`,
    storedPath: `批处理记录/网赚管线/expanded-outputs/out_001/out_001__${request.targetWidth}x${request.targetHeight}.mp4`,
    previewUrl: `/file?path=expanded-${request.targetWidth}x${request.targetHeight}.mp4`,
    downloadUrl: `/file?path=expanded-${request.targetWidth}x${request.targetHeight}.mp4&download=1`,
    requestId: "",
    updatedAt: new Date().toISOString()
  });

  await call("POST", "/api/wangzhuan/outputs/out_001/expand", {
    targetWidth: 800,
    targetHeight: 800,
    mode: "blur_pad"
  }, context);
  await waitForStatus("/api/wangzhuan/outputs/out_001/expand-jobs", "succeeded", context);

  context.runOutputExpansion = async () => {
    const error = new Error("old failed record");
    error.code = "job_failed";
    error.data = { targetWidth: 800, targetHeight: 800, sizeKey: "800x800" };
    throw error;
  };
  await call("POST", "/api/wangzhuan/outputs/out_001/expand", {
    targetWidth: 800,
    targetHeight: 800,
    mode: "blur_pad"
  }, context);
  await waitForStatus("/api/wangzhuan/outputs/out_001/expand-jobs", "failed", context);

  const polled = await call("GET", "/api/wangzhuan/outputs/out_001/expand-jobs", {}, context);
  const sameSizeItems = polled.payload.data.items.filter((item) => item.sizeKey === "800x800");
  assert.equal(sameSizeItems.length, 1);
  assert.equal(sameSizeItems[0].status, "failed");
});
