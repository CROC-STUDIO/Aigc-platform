import assert from "node:assert/strict";
import test from "node:test";

import {
  batchRuntimeSummary,
  renderFailureReasons,
  renderOutputPreviewCards,
  summarizeGenerationRequest
} from "../../public/wangzhuan-common.js";

test("batch runtime summary exposes creation time, progress and ETA", () => {
  const summary = batchRuntimeSummary({
    status: "running",
    createdAt: "2026-06-24T08:00:00.000Z",
    startedAt: "2026-06-24T08:00:00.000Z",
    updatedAt: "2026-06-24T08:01:00.000Z"
  }, [
    {
      status: "downloaded",
      startedAt: "2026-06-24T08:00:00.000Z",
      finishedAt: "2026-06-24T08:01:00.000Z"
    },
    {
      status: "waiting_upstream",
      startedAt: "2026-06-24T08:01:00.000Z"
    }
  ], { now: "2026-06-24T08:01:30.000Z" });

  assert.equal(summary.createdAt, "2026-06-24 08:00");
  assert.equal(summary.progressText, "1/2");
  assert.equal(summary.elapsed, "1 分 30 秒");
  assert.equal(summary.eta, "约 1 分钟");
});

test("failure reasons include batch, task, output and provider context", () => {
  const html = renderFailureReasons({
    batch: { errorMessage: "批次目录写入失败" },
    tasks: [{
      generationTaskId: "gen_001",
      errorCode: "upstream_failed",
      errorMessage: "Seedance 上游任务失败"
    }],
    outputs: [{
      outputId: "out_001",
      qcStatus: "fail",
      errorMessage: "音轨缺失"
    }],
    providerJob: {
      jobId: "job_001",
      status: "failed",
      errorMessage: "视频处理平台下载失败"
    }
  });

  assert.match(html, /失败原因/);
  assert.match(html, /批次目录写入失败/);
  assert.match(html, /gen_001/);
  assert.match(html, /Seedance 上游任务失败/);
  assert.match(html, /out_001/);
  assert.match(html, /音轨缺失/);
  assert.match(html, /job_001/);
});

test("output preview cards render every video output without autoplay", () => {
  const html = renderOutputPreviewCards([
    {
      outputId: "out_001",
      kind: "segment_video",
      qcStatus: "manual_required",
      durationSec: 15,
      previewUrl: "https://cdn.example.com/out-001.mp4"
    },
    {
      outputId: "out_002",
      kind: "stitched_video",
      qcStatus: "pass",
      durationSec: 30,
      previewUrl: "https://cdn.example.com/out-002.mp4"
    }
  ]);

  assert.match(html, /out_001/);
  assert.match(html, /out_002/);
  assert.equal((html.match(/<video /g) || []).length, 2);
  assert.equal(/autoplay/.test(html), false);
  assert.match(html, /playsinline/);
  assert.match(html, /preload="metadata"/);
});

test("generation request summary shows audio and reference visibility", () => {
  assert.equal(summarizeGenerationRequest({
    requestSummary: {
      mode: "omni_reference",
      model: "dreamina-seedance-2-0-260128",
      generate_audio: true,
      references: [
        { type: "image", url: "https://cdn.example.com/icon.png" },
        { type: "video", url: "https://cdn.example.com/recording.mp4" }
      ]
    }
  }), "模式 omni_reference · 模型 dreamina-seedance-2-0-260128 · 2 个参考素材（image 1 / video 1） · 含音频");
});
