import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeedanceGenerationPayload,
  createSeedanceProviderClient,
  extractSeedanceVideoUrl,
  parseSeedancePollResponse,
  parseSeedanceSubmitResponse,
  resolveSeedanceModel,
  seedanceSubmitUrl,
  seedanceTaskUrl
} from "../../server/wangzhuan/seedance-provider.mjs";

test("builds Skylink Seedance payload with prompt and references", () => {
  const payload = buildSeedanceGenerationPayload({
    model: "doubao-seedance-2-0-fast-260128",
    prompt: "Generate a short product video",
    mode: "omni_reference",
    media: [
      { type: "image_url", url: "https://cdn.example.com/news-icon.png", role: "reference_image" },
      { type: "image_url", url: "https://cdn.example.com/news-screen.png", role: "reference_image" }
    ],
    ratio: "9:16",
    duration: 15,
    resolution: "1080p",
    generateAudio: false,
    watermark: false
  });

  assert.equal(payload.model, "doubao-seedance-2-0-fast-260128");
  assert.equal(payload.mode, "omni_reference");
  assert.equal(payload.prompt, "Generate a short product video");
  assert.equal(payload.ratio, "9:16");
  assert.equal(payload.duration, 15);
  assert.equal(payload.resolution, "720p");
  assert.equal(payload.generate_audio, false);
  assert.equal(payload.watermark, false);
  assert.deepEqual(payload.references, [
    {
      type: "image",
      url: "https://cdn.example.com/news-icon.png",
      role: "reference_image"
    },
    {
      type: "image",
      url: "https://cdn.example.com/news-screen.png",
      role: "reference_image"
    }
  ]);
});

test("builds Skylink Seedance 2.0 zone submit and poll URLs", () => {
  assert.equal(
    seedanceSubmitUrl("https://skylink-gateway.com/api/v1", "/seedance/videos/generations"),
    "https://skylink-gateway.com/api/v1/seedance/videos/generations"
  );
  assert.equal(
    seedanceTaskUrl("https://skylink-gateway.com/api/v1", "task_123", "/seedance/tasks"),
    "https://skylink-gateway.com/api/v1/seedance/tasks/task_123"
  );
});

test("parses Skylink submit and poll responses", () => {
  assert.deepEqual(parseSeedanceSubmitResponse({
    data: { task_id: "task_123", status: "queued" }
  }), {
    taskId: "task_123",
    status: "queued",
    responsePayload: { data: { task_id: "task_123", status: "queued" } }
  });

  const polled = parseSeedancePollResponse({
    data: {
      task_id: "task_123",
      status: "succeeded",
      preview_url: "https://cdn.example.com/output.mp4"
    }
  });
  assert.equal(polled.taskId, "task_123");
  assert.equal(polled.status, "succeeded");
  assert.equal(polled.videoUrl, "https://cdn.example.com/output.mp4");
  assert.equal(extractSeedanceVideoUrl({ result: "https://cdn.example.com/result.mp4" }), "https://cdn.example.com/result.mp4");
});

test("resolveSeedanceModel prefers estimate and template overrides", () => {
  assert.equal(resolveSeedanceModel({
    templateSnapshot: { draft: { seedanceModel: "dreamina-seedance-2-0-260128" } },
    estimate: { request: { seedanceModel: "doubao-seedance-1-0-lite-t2v-250428" } }
  }), "doubao-seedance-1-0-lite-t2v-250428");
  assert.equal(resolveSeedanceModel({
    templateSnapshot: { draft: { seedanceModel: "dreamina-seedance-2-0-260128" } }
  }), "dreamina-seedance-2-0-260128");
});

test("reuses LLM Skylink key fallbacks for Seedance provider", () => {
  const previous = process.env.VIDEO_AIGC_API_KEY;
  delete process.env.WANGZHUAN_LLM_API_KEY;
  delete process.env.WANGZHUAN_SEEDANCE_API_KEY;
  process.env.VIDEO_AIGC_API_KEY = "shared-skylink-key";
  try {
    const client = createSeedanceProviderClient({
      config: {
        wangzhuan: {
          seedanceProvider: {
            endpoint: "https://skylink-gateway.com/api/v1"
          }
        }
      }
    });
    assert.ok(client);
    assert.equal(client.config.apiKey, "shared-skylink-key");
  } finally {
    if (previous === undefined) delete process.env.VIDEO_AIGC_API_KEY;
    else process.env.VIDEO_AIGC_API_KEY = previous;
  }
});
