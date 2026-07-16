import assert from "node:assert/strict";
import test from "node:test";

import { __remixTestHooks } from "../../server/wangzhuan/remix.mjs";
import { __videoOpsArchiveTestHooks } from "../../server/wangzhuan/video-ops-archive.mjs";
import { validateVideoOpsJobRequest } from "../../server/wangzhuan/video-ops.mjs";

test("manual ai-remove preserves a base64 mask source type", () => {
  const payload = validateVideoOpsJobRequest({
    job_type: "ai_remove",
    input: { source_type: "url", source: "https://example.com/source.mp4" },
    params: {
      mode: "manual",
      mask_source_type: "base64_data_url",
      mask_source: "data:image/png;base64,AAAA",
      time_ranges: [{ start_ms: 0, end_ms: 1000 }]
    }
  });

  assert.equal(payload.params.mask_source_type, "base64_data_url");
});

test("dead-letter video-ops jobs become failed remix tasks", () => {
  assert.equal(__remixTestHooks.remixStatusFromProvider("dead_letter"), "failed");
  assert.equal(__videoOpsArchiveTestHooks.remixStatusFromProvider("dead_letter"), "failed");
  assert.equal(__videoOpsArchiveTestHooks.terminalStatus("dead_letter"), true);
});

test("video-ops remix detail uses the dedicated video-ops provider", async () => {
  const calls = [];
  const context = {
    videoOpsProviderClient: {
      async getJob(jobId) {
        calls.push(["video-ops", jobId]);
        return { job_id: jobId, status: "running" };
      }
    },
    remixProviderClient: {
      async getJob(jobId) {
        calls.push(["remix", jobId]);
        throw new Error("ordinary remix provider must not receive video-ops jobs");
      }
    }
  };
  const remix = {
    request: { videoOpsPayload: { job_type: "ai_remove" } },
    providerJob: { jobId: "video-ops-job", provider: "video_ops" }
  };

  const provider = __remixTestHooks.providerAccessForRemix(context, remix);
  const job = await provider.getJob(remix.providerJob.jobId);

  assert.equal(job.status, "running");
  assert.deepEqual(calls, [["video-ops", "video-ops-job"]]);
});

test("local ffmpeg remix detail reads the local background job", async () => {
  const calls = [];
  const context = {
    async getBackgroundJob(_context, jobId) {
      calls.push(jobId);
      return { id: jobId, type: "local_sticker_overlay", status: "running" };
    },
    videoOpsProviderClient: {
      async getJob() {
        throw new Error("local jobs must not be sent to video-ops");
      }
    }
  };
  const provider = __remixTestHooks.providerAccessForRemix(context, {
    request: { videoOpsPayload: { job_type: "local_sticker_overlay" } },
    providerJob: { jobId: "local-job", provider: "local_ffmpeg" }
  });
  const job = await provider.getJob("local-job");

  assert.equal(job.provider, "local_ffmpeg");
  assert.equal(job.status, "running");
  assert.deepEqual(calls, ["local-job"]);
});

test("ordinary remix detail keeps using the configured remix provider", async () => {
  const calls = [];
  const context = {
    videoOpsProviderClient: {
      async getJob(jobId) {
        calls.push(["video-ops", jobId]);
        throw new Error("video-ops provider must not receive ordinary remix jobs");
      }
    },
    remixProviderClient: {
      async getJob(jobId) {
        calls.push(["remix", jobId]);
        return { job_id: jobId, status: "running" };
      }
    }
  };
  const remix = {
    capability: { provider: "video_aigc" },
    providerJob: { jobId: "remix-job", provider: "video_aigc" }
  };

  const provider = __remixTestHooks.providerAccessForRemix(context, remix);
  const job = await provider.getJob(remix.providerJob.jobId);

  assert.equal(job.status, "running");
  assert.deepEqual(calls, [["remix", "remix-job"]]);
});
