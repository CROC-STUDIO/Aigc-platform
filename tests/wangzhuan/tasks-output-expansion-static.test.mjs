import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

test("task detail presents expanded outputs without creation controls", async () => {
  const js = await readFile(new URL("public/wangzhuan-tasks.js", root), "utf8");

  assert.match(js, /"expanded_video"/);
  assert.match(js, /parentOutputId/);
  assert.match(js, /sizeKey/);
  assert.match(js, /output\.displayFileName \|\| output\.fileName \|\| output\.outputId/);
  assert.match(js, /postProcessFailures/);
  assert.match(js, /data-project-key/);
  assert.match(js, /state\.activeProjectKey !== state\.selectedProjectKey/);
  assert.match(js, /switchProjectScope\(state\.selectedProjectKey\)/);
  assert.match(js, /segmentCount > 1/);
  assert.match(js, /batchStatus === "stitching"/);
  assert.doesNotMatch(js, /\/api\/wangzhuan\/outputs\/\$\{encodeURIComponent\(outputId\)\}\/expand/);
  assert.doesNotMatch(js, /wz-output-expand-submit|wz-output-expand-presets|wz-output-expand-custom/);
  assert.doesNotMatch(js, /开始扩展|选择一个目标尺寸后开始扩展/);
});
