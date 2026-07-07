import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

test("task detail output cards include size expansion controls and polling hooks", async () => {
  const js = await readText("public/wangzhuan-tasks.js");
  assert.match(js, /wz-output-expand-toggle/);
  assert.match(js, /\/api\/wangzhuan\/outputs\/\$\{encodeURIComponent\(outputId\)\}\/expand/);
  assert.match(js, /\/api\/wangzhuan\/outputs\/\$\{encodeURIComponent\(outputId\)\}\/expand-jobs/);
  assert.match(js, /wz-output-expand-submit-presets/);
  assert.match(js, /开始扩展已选尺寸/);
  assert.match(js, /正在生成 .* 版本/);
  assert.match(js, /wz-output-expand-panel/);
  assert.match(js, /wz-output-expand-region/);
  assert.match(js, /wz-output-expand-presets/);
  assert.match(js, /wz-output-expand-custom/);
  assert.match(js, /wz-output-expand-results/);
  assert.match(js, /ui\.status = "succeeded"/);
  assert.match(js, /ui\.expanded = true/);
  assert.match(js, /if \(!widthRaw \|\| !heightRaw\) return null;/);
  assert.match(js, /function syncOutputExpansionPanel\(outputId\)/);
  assert.match(js, /function syncOutputExpansionStateView\(outputId\)/);
  assert.match(js, /function hasSelectableOutputs\(outputs = \[\]\)/);
  assert.match(js, /function captureExpansionFocusSnapshot\(root = document\)/);
  assert.match(js, /function restoreExpansionFocusSnapshot\(snapshot\)/);
  assert.match(js, /download rel="noreferrer">下载<\/a>/);
  assert.match(js, /syncOutputExpansionStateView\(event\.target\.dataset\.outputId\)/);
  assert.match(js, /\$\{canDownloadSelected \? `<button id="wzTasksDownloadBtn" type="button">下载选中视频<\/button>` : ""\}/);

  const expansion = await readText("server/wangzhuan/output-expansion.mjs");
  assert.match(expansion, /&download=1/);
  assert.match(expansion, /const info = await stat\(outputPath\)/);

  const router = await readText("server/wangzhuan/router.mjs");
  assert.match(router, /const latestBySize = new Map\(\)/);
});
