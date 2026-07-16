import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeBatchPostProcess,
  normalizeExpansionSizes,
  resolveBatchPostProcess
} from "../../server/wangzhuan/postprocess.mjs";

test("batch post-process defaults to subtitle generation with no Ending or expansion sizes", () => {
  assert.deepEqual(normalizeBatchPostProcess(), {
    ending: null,
    subtitles: { enabled: true, fontSize: 36, centerY: 960, textColor: "white" },
    expansionSizes: []
  });
});

test("batch post-process lets the user disable default subtitle generation", () => {
  assert.deepEqual(normalizeBatchPostProcess({ subtitles: { enabled: false } }).subtitles, {
    enabled: false,
    fontSize: 36,
    centerY: 960,
    textColor: "white"
  });
});

test("batch post-process validates user subtitle font size and center Y", () => {
  assert.deepEqual(normalizeBatchPostProcess({ subtitles: { fontSize: 48, centerY: 960, textColor: "yellow" } }).subtitles, {
    enabled: true,
    fontSize: 48,
    centerY: 960,
    textColor: "yellow"
  });
  for (const subtitles of [
    { fontSize: 11 },
    { fontSize: 97 },
    { fontSize: 30.5 },
    { centerY: -1 },
    { centerY: 1281 },
    { centerY: 100.5 },
    { textColor: "blue" }
  ]) {
    assert.throws(
      () => normalizeBatchPostProcess({ subtitles }),
      (error) => error?.code === "validation_error"
    );
  }
});

test("batch post-process deduplicates preset and custom expansion sizes", () => {
  const expansionSizes = normalizeExpansionSizes([
    { targetWidth: 800, targetHeight: 800 },
    { targetWidth: 800, targetHeight: 800, mode: "blur_pad" },
    { targetWidth: 1080, targetHeight: 1920 }
  ]);

  assert.deepEqual(expansionSizes, [
    { targetWidth: 800, targetHeight: 800, mode: "blur_pad", presetKey: "800x800", sizeKey: "800x800" },
    { targetWidth: 1080, targetHeight: 1920, mode: "blur_pad", presetKey: "", sizeKey: "1080x1920" }
  ]);
});

test("batch post-process rejects invalid expansion dimensions and modes", () => {
  for (const value of [
    { targetWidth: 255, targetHeight: 800 },
    { targetWidth: 800, targetHeight: 4097 },
    { targetWidth: 800, targetHeight: 800, mode: "crop" }
  ]) {
    assert.throws(
      () => normalizeExpansionSizes([value]),
      (error) => error?.code === "validation_error"
    );
  }
});

test("batch post-process normalizes uploaded image Ending to one second", () => {
  const normalized = normalizeBatchPostProcess({
    ending: {
      enabled: true,
      fileName: "ending.png",
      mimeType: "image/png",
      storedPath: "postprocess-assets/ending/ending.png",
      storageUrl: "https://assets.test/ending.png"
    }
  });

  assert.deepEqual(normalized.ending, {
    enabled: true,
    fileName: "ending.png",
    mimeType: "image/png",
    storedPath: "postprocess-assets/ending/ending.png",
    storageKey: "",
    storageUrl: "https://assets.test/ending.png",
    previewUrl: "https://assets.test/ending.png",
    mediaType: "image",
    imageDurationSec: 1
  });
});

test("batch post-process resolves request before estimate and template fallbacks", () => {
  const template = { expansionSizes: [{ targetWidth: 720, targetHeight: 1280 }] };
  const estimate = { expansionSizes: [{ targetWidth: 800, targetHeight: 800 }] };
  const request = { expansionSizes: [{ targetWidth: 1280, targetHeight: 720 }] };
  const batch = {
    request: { postProcess: request },
    estimate: { request: { postProcess: estimate } },
    templateSnapshot: { draft: { postProcess: template } }
  };

  assert.deepEqual(resolveBatchPostProcess(batch).expansionSizes.map((item) => item.sizeKey), ["1280x720"]);
});
