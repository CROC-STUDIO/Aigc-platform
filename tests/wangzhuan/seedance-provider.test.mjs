import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeedanceGenerationPayload,
  collectSeedanceMedia,
  createSeedanceProviderClient,
  extractSeedanceVideoUrl,
  parseSeedancePollResponse,
  parseSeedanceSubmitResponse,
  resolveSeedanceModel,
  seedanceSubmitUrl,
  seedanceTaskUrl
} from "../../server/wangzhuan/seedance-provider.mjs";
import { reviewSeedanceAsset } from "../../server/wangzhuan/asset-review.mjs";
import { WangzhuanError } from "../../server/wangzhuan/http.mjs";

test("builds Skylink Seedance payload with prompt and content", () => {
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
  assert.deepEqual(payload.content, [
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

test("builds Skylink Seedance payload with asset_id slot metadata from assetKey", () => {
  const payload = buildSeedanceGenerationPayload({
    model: "dreamina-seedance-2-0-260128",
    prompt: "Product ad with icon and screenshot",
    mode: "omni_reference",
    media: [
      {
        type: "image_asset",
        assetId: "asset_icon_001",
        assetKey: "productIcon",
        assetRole: "reference"
      },
      {
        type: "image_asset",
        assetId: "asset_screen_002",
        assetKey: "productScreenshot",
        assetRole: "reference"
      },
      {
        type: "video_asset",
        assetId: "asset_rec_003",
        assetKey: "productRecording",
        assetRole: "reference"
      }
    ],
    ratio: "9:16",
    duration: 15,
    resolution: "720p",
    generateAudio: false,
    watermark: false
  });

  assert.deepEqual(payload.content, [
    {
      type: "image_asset",
      asset_id: "asset_icon_001",
      asset_role: "reference",
      metadata: { slot_key: "product_icon", slot_index: 1 }
    },
    {
      type: "image_asset",
      asset_id: "asset_screen_002",
      asset_role: "reference",
      metadata: { slot_key: "product_screenshot", slot_index: 2 }
    },
    {
      type: "video_asset",
      asset_id: "asset_rec_003",
      asset_role: "reference",
      metadata: { slot_key: "product_recording", slot_index: 1 }
    }
  ]);
});

test("defaults Seedance generation payload to audio enabled for quality visibility", () => {
  const payload = buildSeedanceGenerationPayload({
    prompt: "Generate a reward app ad",
    media: [{ type: "image_url", url: "https://cdn.example.com/app.png", role: "reference_image" }]
  });

  assert.equal(payload.generate_audio, true);
  assert.equal(payload.mode, "omni_reference");
  assert.equal(payload.content.length, 1);
});

test("collectSeedanceMedia prefers latest batch branchDrafts with approved assetReviews", () => {
  const batch = {
    branchDrafts: [{
      branchId: "branch_1",
      assetUrls: {
        productIcon: "https://cdn.example.com/icon.png",
        productScreenshot: "https://cdn.example.com/screen.png"
      },
      assetReviews: {
        productIcon: { assetId: "asset_icon_latest", status: "approved" },
        productScreenshot: { assetId: "asset_screen_latest", status: "approved" }
      }
    }],
    scripts: [{
      scriptId: "script_1",
      branchId: "branch_1",
      branchDraft: {
        branchId: "branch_1",
        productName: "Lucky Cash",
        assetUrls: {}
      }
    }]
  };
  const task = { scriptId: "script_1", branchId: "branch_1" };
  const media = collectSeedanceMedia(batch, task);
  assert.equal(media.length, 2);
  assert.deepEqual(media.map((item) => item.assetId), [
    "asset_icon_latest",
    "asset_screen_latest"
  ]);
});

test("collectSeedanceMedia rejects S3 or CDN URLs without approved assetId", () => {
  const batch = {
    branchDrafts: [{
      branchId: "branch_1",
      assetUrls: {
        productIcon: "https://harpoons3.example.com/productIcon/400x400bb-75.webp"
      }
    }]
  };
  const task = { branchId: "branch_1" };
  assert.throws(
    () => collectSeedanceMedia(batch, task),
    (error) => error instanceof WangzhuanError && error.code === "asset_review_pending"
  );
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
      preview_url: "https://cdn.example.com/preview.jpg",
      result: "https://cdn.example.com/output.mp4"
    }
  });
  assert.equal(polled.taskId, "task_123");
  assert.equal(polled.status, "succeeded");
  assert.equal(polled.videoUrl, "https://cdn.example.com/output.mp4");
  assert.equal(extractSeedanceVideoUrl({
    status: "succeeded",
    content: { video_url: "https://cdn.example.com/seedance2-output.mp4?X-Tos-Expires=86400" }
  }), "https://cdn.example.com/seedance2-output.mp4?X-Tos-Expires=86400");
  assert.equal(extractSeedanceVideoUrl({
    status: "succeeded",
    content: { file_url: "https://cdn.example.com/output-from-file-url.mp4" }
  }), "https://cdn.example.com/output-from-file-url.mp4");
  assert.equal(extractSeedanceVideoUrl({
    status: "succeeded",
    data: { content: { video_url: "https://cdn.example.com/nested-task.mp4" } }
  }), "https://cdn.example.com/nested-task.mp4");
  assert.equal(extractSeedanceVideoUrl({ result: "https://cdn.example.com/result.mp4" }), "https://cdn.example.com/result.mp4");
  assert.equal(extractSeedanceVideoUrl({ preview_url: "https://cdn.example.com/output.mp4" }), "https://cdn.example.com/output.mp4");
  assert.equal(extractSeedanceVideoUrl({ preview_url: "https://cdn.example.com/preview.jpg" }), "");
  assert.equal(extractSeedanceVideoUrl({
    status: "succeeded",
    preview_url: "https://cdn.example.com/preview.jpg",
    output_assets: [{
      type: "video",
      url: "https://static.skylink-gateway.com/seedance/generated/seedance/aigc_demo/00-video.mp4",
      mime_type: "video/mp4"
    }]
  }), "https://static.skylink-gateway.com/seedance/generated/seedance/aigc_demo/00-video.mp4");
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

test("configured provider passes generateAudio from wangzhuan config", () => {
  const client = createSeedanceProviderClient({
    config: {
      wangzhuan: {
        seedanceProvider: {
          endpoint: "https://skylink-gateway.com/api/v1",
          apiKey: "test-key",
          generateAudio: true
        }
      }
    }
  });
  assert.equal(client.config.generateAudio, true);
  const payload = buildSeedanceGenerationPayload({
    prompt: "Ad with voiceover",
    generateAudio: client.config.generateAudio
  });
  assert.equal(payload.generate_audio, true);
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

test("asset review reuses Seedance provider apiKeyEnv when review key is not configured", async () => {
  const previousProviderKey = process.env.WANGZHUAN_LLM_API_KEY;
  const previousSeedanceKey = process.env.WANGZHUAN_SEEDANCE_API_KEY;
  const previousSharedKey = process.env.VIDEO_AIGC_API_KEY;
  delete process.env.WANGZHUAN_SEEDANCE_API_KEY;
  delete process.env.VIDEO_AIGC_API_KEY;
  process.env.WANGZHUAN_LLM_API_KEY = "provider-env-key";
  const requests = [];
  try {
    const review = await reviewSeedanceAsset({
      config: {
        wangzhuan: {
          seedanceProvider: {
            endpoint: "https://skylink-gateway.com/api/v1",
            apiKeyEnv: "WANGZHUAN_LLM_API_KEY"
          }
        }
      },
      fetch: async (url, init) => {
        requests.push({ url, authorization: init.headers.Authorization });
        return new Response(JSON.stringify({
          data: {
            asset_id: "asset_icon_001",
            status: "approved"
          }
        }), { status: 200 });
      }
    }, {
      assetKey: "productIcon",
      fileName: "icon.png",
      mimeType: "image/png",
      buffer: Buffer.from("png"),
      storageUrl: "https://cdn.example.com/icon.png"
    });

    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://skylink-gateway.com/api/v1/seedance/assets/upload");
    assert.equal(requests[0].authorization, "Bearer provider-env-key");
    assert.equal(review.assetId, "asset_icon_001");
    assert.equal(review.status, "approved");
  } finally {
    if (previousProviderKey === undefined) delete process.env.WANGZHUAN_LLM_API_KEY;
    else process.env.WANGZHUAN_LLM_API_KEY = previousProviderKey;
    if (previousSeedanceKey === undefined) delete process.env.WANGZHUAN_SEEDANCE_API_KEY;
    else process.env.WANGZHUAN_SEEDANCE_API_KEY = previousSeedanceKey;
    if (previousSharedKey === undefined) delete process.env.VIDEO_AIGC_API_KEY;
    else process.env.VIDEO_AIGC_API_KEY = previousSharedKey;
  }
});
