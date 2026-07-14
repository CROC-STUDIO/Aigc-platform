import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function source(path) {
  return readFile(new URL(path, root), "utf8");
}

test("generation batch exposes optional Ending and multi-size post-process controls", async () => {
  const html = await source("public/wangzhuan-v2.html");
  const batchStart = html.indexOf('id="wzNodeBatch"');
  const batchEnd = html.indexOf("</section>", batchStart);
  const batch = html.slice(batchStart, batchEnd);

  assert.ok(batchStart >= 0);
  for (const id of [
    "wzPostProcessSubtitles",
    "wzSubtitleFontSizeRange",
    "wzSubtitleFontSizeNumber",
    "wzSubtitleCenterYRange",
    "wzSubtitleCenterYNumber",
    "wzPostProcessEndingFile",
    "wzPostProcessEndingRemove",
    "wzPostProcessEndingPreview",
    "wzExpansionCustomWidth",
    "wzExpansionCustomHeight",
    "wzExpansionAddCustom",
    "wzExpansionSelectedSizes"
  ]) {
    assert.match(batch, new RegExp(`id="${id}"`), id);
  }
  for (const size of ["800x800", "1280x720", "720x1280"]) {
    assert.match(batch, new RegExp(`data-expansion-preset="${size}"`), size);
  }
  assert.match(batch, /accept="image\/png,image\/jpeg,image\/webp,video\/mp4,video\/webm,video\/quicktime"/);
});

test("CTA and Ending product images are labelled as final Seedance slice references only", async () => {
  const html = await source("public/wangzhuan-v2.html");

  assert.match(html, /CTA 图（仅图片，仅用于最后一个 Seedance 分片）/);
  assert.match(html, /Ending 图（仅图片，仅用于最后一个 Seedance 分片）/);
  assert.doesNotMatch(html, /CTA 图[^<]*拼接到末尾/);
  assert.doesNotMatch(html, /Ending 图[^<]*拼接到末尾/);
});

test("v2 serializes post-process choices without adding them to the Seedance plan signature", async () => {
  const js = await source("public/wangzhuan-v2.js");
  const signatureSource = js.slice(js.indexOf("const signatureFields"), js.indexOf("];", js.indexOf("const signatureFields")) + 2);

  assert.match(js, /state\.postProcessEndingAsset = data\.asset \|\| null/);
  assert.match(js, /state\.expansionSizes/);
  assert.match(js, /function postProcessRequestFields\(\)/);
  assert.match(js, /fontSize:\s*Number\(els\.subtitleFontSizeNumber\?\.value \|\| 30\)/);
  assert.match(js, /centerY:\s*Number\(els\.subtitleCenterYNumber\?\.value \|\| 1140\)/);
  assert.match(js, /function syncSubtitleStyleControls\(/);
  assert.match(js, /postProcess\.subtitles\?\.fontSize \?\? 30/);
  assert.match(js, /postProcess\.subtitles\?\.centerY \?\? 1140/);
  assert.match(js, /syncSubtitleStyleControls\(\{ fontSize: 30, centerY: 1140 \}\)/);
  assert.match(js, /postProcess:\s*postProcessRequestFields\(\)/);
  assert.match(js, /confirm-plan[\s\S]*postProcess:\s*postProcessRequestFields\(\)/);
  assert.doesNotMatch(signatureSource, /postProcess|expansionSizes|postProcessEnding/);
});

test("v2 supports adding and removing preset and custom expansion sizes", async () => {
  const js = await source("public/wangzhuan-v2.js");

  assert.match(js, /function addExpansionSize\(/);
  assert.match(js, /function removeExpansionSize\(/);
  assert.match(js, /\[data-expansion-preset\]/);
  assert.match(js, /wzExpansionAddCustom/);
  assert.match(js, /data-remove-expansion-size/);
});
