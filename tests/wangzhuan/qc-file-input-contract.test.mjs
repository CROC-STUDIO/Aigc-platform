import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const qcSource = await readFile(new URL("../../server/wangzhuan/qc.mjs", import.meta.url), "utf8");

test("generated video QC file_url input does not include filename", () => {
  const match = qcSource.match(/if \(visionInputs\.fileUrl\) \{([\s\S]*?)\} else if \(visionInputs\.fileDataUrl\)/);
  assert.ok(match, "file_url branch exists");
  assert.doesNotMatch(match[1], /filename:/, "file_url/file_id inputs must not include filename");
  assert.match(match[1], /file_url:\s*visionInputs\.fileUrl/);
});

test("generated video QC file_data input keeps filename", () => {
  assert.match(
    qcSource,
    /else if \(visionInputs\.fileDataUrl\) \{[\s\S]*?file:\s*\{[\s\S]*?filename:[\s\S]*?file_data:/,
    "file_data inputs must include filename"
  );
});
