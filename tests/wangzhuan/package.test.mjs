import assert from "node:assert/strict";
import test from "node:test";

import { packagePathHelpers } from "../../server/wangzhuan/package.mjs";

test("expanded video packages below its parent output while original keeps stitched path", () => {
  assert.equal(
    packagePathHelpers.outputPackagePath("batch", {
      outputId: "out_abcd_001",
      kind: "stitched_video",
      displayFileName: "original.mp4",
      filePath: "stitched/original.mp4"
    }),
    "batch/stitched/original.mp4"
  );
  assert.equal(
    packagePathHelpers.outputPackagePath("batch", {
      outputId: "out_abcd_002",
      parentOutputId: "out_abcd_001",
      kind: "expanded_video",
      sizeKey: "800x800",
      displayFileName: "original__800x800.mp4",
      filePath: "expanded/original__800x800.mp4"
    }),
    "batch/expanded/out_abcd_001/original__800x800.mp4"
  );
});
