import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resetBackgroundJobsForTest } from "../../server/wangzhuan/background-jobs.mjs";
import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";

class TestResponse extends EventEmitter {
  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode;
    this.headers = headers;
  }

  end(body = "") {
    this.body = String(body);
    this.emit("finish");
  }
}

function requestBody() {
  return {
    job_type: "local_sticker_overlay",
    input: { source_type: "base64_data_url", source: "data:video/mp4;base64,AAAA" },
    options: { priority: 0 },
    params: {
      region_spec: [{ x: 0.1, y: 0.2, width: 0.3, height: 0.4, coordinate_space: "normalized", time_ranges: [] }],
      sticker_scale_mode: "short_side",
      sticker_source_type: "base64_data_url",
      sticker_source: "data:image/png;base64,AAAA"
    }
  };
}

async function call(context, method, path, body = {}) {
  context.readJson = async () => body;
  const res = new TestResponse();
  await handleWangzhuanRequest({ method, headers: {} }, res, new URL(`http://127.0.0.1${path}`), context);
  return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
}

test.beforeEach(() => resetBackgroundJobsForTest());

test("local video edit API runs asynchronously and archives only sanitized request data", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-video-edit-router-"));
  const archivedPayloads = [];
  let remix = null;
  const context = {
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    userId: "tester",
    userProjectRoot: root,
    sharedProjectRoot: root,
    currentUser: () => ({ username: "tester", permissions: { "wangzhuan:view": true } }),
    currentUserId: () => "tester",
    currentProjectRoot: () => root,
    currentBaseProjectRoot: () => root,
    archiveVideoOpsSubmission: async (_scoped, payload, job) => {
      archivedPayloads.push(payload);
      return { ...job, remixId: "rmx_20260716000000_abcd", taskManagementUrl: "/wangzhuan-tasks.html?remixId=rmx_20260716000000_abcd" };
    },
    runLocalStickerOverlayJob: async () => ({
      outputBuffer: Buffer.from("rendered-video"),
      result: { provider: "local_ffmpeg", has_sticker: true }
    }),
    syncVideoOpsJobArchive: async (_scoped, job) => {
      remix = {
        remixId: "rmx_20260716000000_abcd",
        outputs: [{ previewUrl: "/file?path=rendered.mp4", downloadEligible: true }]
      };
      return { ...job, remixId: remix.remixId, taskManagementUrl: `/wangzhuan-tasks.html?remixId=${remix.remixId}` };
    },
    resolveVideoOpsArchive: async () => remix
  };

  try {
    const submitted = await call(context, "POST", "/api/wangzhuan/local-video-edits/jobs", requestBody());
    assert.equal(submitted.statusCode, 200);
    assert.equal(submitted.payload.data.status, "queued");
    assert.equal(submitted.payload.data.provider, "local_ffmpeg");
    assert.match(submitted.payload.data.job_id, /^localeditjob_/);
    assert.equal(archivedPayloads.length, 1);
    assert.doesNotMatch(JSON.stringify(archivedPayloads[0]), /data:|AAAA/);
    assert.equal(archivedPayloads[0].input.source, undefined);
    assert.equal(archivedPayloads[0].params.has_sticker, true);

    const jobId = submitted.payload.data.job_id;
    let detail;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      detail = await call(context, "GET", `/api/wangzhuan/local-video-edits/jobs/${jobId}`);
      if (detail.payload.data.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(detail.payload.data.status, "succeeded");
    const result = await call(context, "GET", `/api/wangzhuan/local-video-edits/jobs/${jobId}/result`);
    assert.equal(result.payload.data.download_url, "/file?path=rendered.mp4");
    assert.equal(result.payload.data.remixId, "rmx_20260716000000_abcd");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
