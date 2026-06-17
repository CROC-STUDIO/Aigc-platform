import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const publicDir = fileURLToPath(new URL("../../public/", import.meta.url));

async function readPublic(name) {
  return readFile(join(publicDir, name), "utf8");
}

test("legacy navigation exposes wangzhuan and competitor remix entries", async () => {
  const index = await readPublic("index.html");
  const comic = await readPublic("comic.html");
  for (const html of [index, comic]) {
    assert.match(html, /href="\/wangzhuan\.html"/);
    assert.match(html, /href="\/competitor-remix\.html"/);
    assert.match(html, /网赚素材管线/);
    assert.match(html, /竞品素材改造/);
  }
});

test("wangzhuan page wires required API flows and states", async () => {
  const html = await readPublic("wangzhuan.html");
  const script = await readPublic("wangzhuan.js");
  const common = await readPublic("wangzhuan-common.js");

  assert.match(html, /id="wzTemplateSelect"/);
  assert.match(html, /id="wzReferenceFile"/);
  assert.match(html, /id="wzEstimateBtn"/);
  assert.match(html, /id="wzDownloadBtn"/);
  assert.match(script, /\/api\/wangzhuan\/templates/);
  assert.match(script, /\/api\/wangzhuan\/reference-videos\/check/);
  assert.match(script, /\/api\/wangzhuan\/reference-videos\/decompose/);
  assert.match(script, /\/api\/wangzhuan\/batches\/estimate/);
  assert.match(script, /\/api\/wangzhuan\/batches\/start/);
  assert.match(common, /payload\.code !== "ok"/);
  assert.match(common, /requestId/);
});

test("competitor remix page wires region, preview, and download gate flows", async () => {
  const html = await readPublic("competitor-remix.html");
  const script = await readPublic("competitor-remix.js");

  assert.match(html, /id="remixRegionsBox"/);
  assert.match(html, /id="remixConfirmBtn"/);
  assert.match(html, /id="remixDownloadBtn"/);
  assert.match(script, /\/api\/wangzhuan\/remix\/upload/);
  assert.match(script, /\/api\/wangzhuan\/remix\/estimate/);
  assert.match(script, /\/api\/wangzhuan\/remix\/start/);
  assert.match(script, /preview-confirm/);
  assert.match(script, /unsupported_capability/);
  assert.match(script, /downloadZip/);
});
