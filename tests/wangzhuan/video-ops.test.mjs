import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";

import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
import { validateVideoOpsJobRequest } from "../../server/wangzhuan/video-ops.mjs";

function jsonReq(method, body = {}) {
  const stream = Readable.from([JSON.stringify(body)]);
  stream.method = method;
  stream.headers = {};
  return stream;
}

function captureRes() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writeHead(status, headers) {
      this.statusCode = status;
      this.headers = headers;
    },
    end(body = "") {
      this.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    }
  };
}

function context(overrides = {}) {
  return {
    readJson: async (req) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    },
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false },
    userId: "alice",
    userProjectRoot: "/tmp/aigc-user",
    sharedProjectRoot: "/tmp/aigc-shared",
    ...overrides
  };
}

test("video-ops validates auto_ai_remove box prompt payload", () => {
  const payload = validateVideoOpsJobRequest({
    job_type: "auto_ai_remove",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: {
      sample_fps: 1,
      max_frames: 20,
      interaction_prompt: {
        prompt_type: "box",
        frame_index: 12,
        box: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5, coordinate_space: "normalized" }
      }
    }
  });
  assert.equal(payload.job_type, "auto_ai_remove");
  assert.equal(payload.params.interaction_prompt.prompt_type, "box");
  assert.equal(payload.params.interaction_prompt.frame_index, 12);
  assert.equal(payload.params.interaction_prompt.box.coordinate_space, "normalized");
});

test("video-ops rejects oversized base64 uploads", () => {
  const oversized = `data:video/mp4;base64,${Buffer.alloc(8).toString("base64")}`;
  assert.throws(() => validateVideoOpsJobRequest({
    job_type: "seedance_ai_remove",
    input: { source_type: "base64_data_url", source: oversized },
    params: {}
  }, { limits: { maxUploadVideoBytes: 4 } }), /大小上限/);
});

test("video-ops rejects unsupported job type and invalid manual removal", () => {
  assert.throws(() => validateVideoOpsJobRequest({
    job_type: "product_name_replace",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: {}
  }), /job_type/);
  assert.throws(() => validateVideoOpsJobRequest({
    job_type: "ai_remove",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: { mode: "manual", time_ranges: [{ start_ms: 0, end_ms: 1000 }] }
  }), /mask_source/);
  assert.throws(() => validateVideoOpsJobRequest({
    job_type: "auto_ai_remove",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: { sample_fps: 1, max_frames: 20 }
  }), /interaction_prompt/);
  assert.throws(() => validateVideoOpsJobRequest({
    job_type: "mask_edit",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: { blur_sigma: 40 }
  }), /region_spec/);
  assert.throws(() => validateVideoOpsJobRequest({
    job_type: "sticker_blur",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: {}
  }), /region_spec/);
});

test("video-ops router creates, polls, retries, cancels, and downloads jobs", async () => {
  const calls = [];
  const provider = {
    async createJob(payload) {
      calls.push(["create", payload]);
      return { job_id: "job_video_ops_001", job_type: payload.job_type, status: "queued" };
    },
    async getJob(jobId, query) {
      calls.push(["get", jobId, query]);
      return { job_id: jobId, job_type: "seedance_ai_remove", status: "running", queue_stats: { waiting: 1, running: 1 } };
    },
    async getJobResult(jobId) {
      calls.push(["result", jobId]);
      return { output_video_path: "data/outputs/job_video_ops_001.mp4" };
    },
    async retryJob(jobId) {
      calls.push(["retry", jobId]);
      return { job_id: jobId, status: "queued" };
    },
    async cancelJob(jobId) {
      calls.push(["cancel", jobId]);
      return { job_id: jobId, status: "canceled" };
    },
    async downloadJob(jobId) {
      calls.push(["download", jobId]);
      return Buffer.from("video");
    }
  };
  const ctx = context({ videoOpsProviderClient: provider });

  const createRes = captureRes();
  await handleWangzhuanRequest(jsonReq("POST", {
    job_type: "seedance_ai_remove",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: { prompt: "Remove watermark" }
  }), createRes, new URL("http://localhost/api/wangzhuan/video-ops/jobs"), ctx);
  assert.equal(createRes.statusCode, 200);
  const created = JSON.parse(createRes.body);
  assert.equal(created.data.jobId, "job_video_ops_001");
  assert.equal(calls[0][1].job_type, "seedance_ai_remove");

  const detailRes = captureRes();
  await handleWangzhuanRequest(jsonReq("GET"), detailRes, new URL("http://localhost/api/wangzhuan/video-ops/jobs/job_video_ops_001?include_model_calls=true"), ctx);
  assert.equal(JSON.parse(detailRes.body).data.status, "running");
  assert.equal(calls[1][2], "include_model_calls=true");

  const resultRes = captureRes();
  await handleWangzhuanRequest(jsonReq("GET"), resultRes, new URL("http://localhost/api/wangzhuan/video-ops/jobs/job_video_ops_001/result"), ctx);
  assert.match(JSON.parse(resultRes.body).data.output_video_path, /job_video_ops_001/);

  const retryRes = captureRes();
  await handleWangzhuanRequest(jsonReq("POST"), retryRes, new URL("http://localhost/api/wangzhuan/video-ops/jobs/job_video_ops_001/retry"), ctx);
  assert.equal(JSON.parse(retryRes.body).data.status, "queued");

  const cancelRes = captureRes();
  await handleWangzhuanRequest(jsonReq("POST"), cancelRes, new URL("http://localhost/api/wangzhuan/video-ops/jobs/job_video_ops_001/cancel"), ctx);
  assert.equal(JSON.parse(cancelRes.body).data.status, "canceled");

  const downloadRes = captureRes();
  await handleWangzhuanRequest(jsonReq("GET"), downloadRes, new URL("http://localhost/api/wangzhuan/video-ops/jobs/job_video_ops_001/download"), ctx);
  assert.equal(downloadRes.statusCode, 200);
  assert.equal(downloadRes.body, "video");
});

test("video-ops provider config takes precedence over legacy remix provider client", async () => {
  const requests = [];
  const ctx = context({
    config: {
      wangzhuan: {
        videoOpsProvider: {
          endpoint: "https://video-ops.example/api/v1",
          apiKey: "test-token",
          timeoutMs: 1000
        }
      }
    },
    remixProviderClient: {
      async createJob() {
        throw new Error("legacy remix provider should not handle video-ops jobs");
      }
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return new Response(JSON.stringify({
        job_id: "job_video_ops_configured",
        job_type: "seedance_ai_remove",
        status: "queued"
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }
  });

  const res = captureRes();
  await handleWangzhuanRequest(jsonReq("POST", {
    job_type: "seedance_ai_remove",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: {}
  }), res, new URL("http://localhost/api/wangzhuan/video-ops/jobs"), ctx);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).data.jobId, "job_video_ops_configured");
  assert.equal(requests[0].url, "https://video-ops.example/api/v1/jobs");
  assert.equal(requests[0].options.headers.Authorization, "Bearer test-token");
});

test("video-ops falls back to legacy remix provider client when no dedicated config exists", async () => {
  const calls = [];
  const ctx = context({
    remixProviderClient: {
      async createJob(payload) {
        calls.push(payload);
        return {
          job_id: "job_video_ops_legacy",
          job_type: payload.job_type,
          status: "queued"
        };
      }
    }
  });

  const res = captureRes();
  await handleWangzhuanRequest(jsonReq("POST", {
    job_type: "seedance_ai_remove",
    input: { source_type: "url", source: "https://example.com/video.mp4" },
    params: {}
  }), res, new URL("http://localhost/api/wangzhuan/video-ops/jobs"), ctx);

  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).data.jobId, "job_video_ops_legacy");
  assert.equal(calls[0].job_type, "seedance_ai_remove");
});
