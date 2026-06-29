import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { qcPathHelpers } from "../../server/wangzhuan/qc.mjs";

const { tryResolveUserPath, videoSpecCheck, templateSnapshotCheck } = qcPathHelpers;

async function withTempRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "wz-qc-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await withTempRoot(async (root) => {
  const context = { userProjectRoot: root };
  assert.equal(tryResolveUserPath(context, ""), null);
  assert.equal(tryResolveUserPath(context, "C:\\abs\\bad.mp4"), null);

  const rel = "wangzhuan/batches/wzb_20260626090000_abcd/outputs/out_abcd_001.mp4";
  const abs = join(root, rel);
  await mkdir(join(root, "wangzhuan/batches/wzb_20260626090000_abcd/outputs"), { recursive: true });
  await writeFile(abs, "fake-video", "utf8");

  assert.equal(tryResolveUserPath(context, rel), abs);

  const missingSpec = videoSpecCheck(context, {
    durationSec: 15,
    kind: "segment_video",
    filePath: ""
  });
  assert.equal(missingSpec.status, "fail");

  const remoteSpec = videoSpecCheck(context, {
    durationSec: 15,
    kind: "segment_video",
    filePath: "",
    storageUrl: "https://example.com/video.mp4"
  });
  assert.equal(remoteSpec.status, "pass");

  const localSpec = videoSpecCheck(context, {
    durationSec: 15,
    kind: "segment_video",
    filePath: rel
  });
  assert.equal(localSpec.status, "pass");

  const branchTemplate = templateSnapshotCheck({
    templateSnapshot: {
      draft: {
        branches: [{ productName: "Branch Product" }]
      }
    }
  });
  assert.equal(branchTemplate.status, "pass");
});

console.log("qc-path-resilience.test.mjs passed");
