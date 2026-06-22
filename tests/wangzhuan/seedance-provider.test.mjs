import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSeedanceGenerationPayload,
  seedanceSubmitUrl
} from "../../server/wangzhuan/seedance-provider.mjs";

test("builds Seedance payload using reference project content contract", () => {
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
  assert.equal(payload.ratio, "9:16");
  assert.equal(payload.duration, 15);
  assert.equal(payload.resolution, "720p");
  assert.equal(payload.generate_audio, false);
  assert.equal(payload.watermark, false);
  assert.deepEqual(payload.content, [
    { type: "text", text: "Generate a short product video" },
    {
      type: "image_url",
      image_url: { url: "https://cdn.example.com/news-icon.png" },
      role: "reference_image"
    },
    {
      type: "image_url",
      image_url: { url: "https://cdn.example.com/news-screen.png" },
      role: "reference_image"
    }
  ]);
});

test("builds Seedance task submit URL with raw contents path", () => {
  assert.equal(
    seedanceSubmitUrl("http://seedance.local/seedance", "/contents/generations/tasks"),
    "http://seedance.local/seedance/contents/generations/tasks"
  );
});
