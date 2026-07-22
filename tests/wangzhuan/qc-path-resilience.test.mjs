import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { qcPathHelpers } from "../../server/wangzhuan/qc.mjs";

const { tryResolveUserPath, videoSpecCheck, templateSnapshotCheck, deterministicVideoChecks } = qcPathHelpers;

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

  const remoteOnlyChecks = await deterministicVideoChecks(
    context,
    { estimate: { durationSec: 15, request: { outputRatio: "9:16" } } },
    {
      outputId: "out_remote_001",
      durationSec: 15,
      kind: "segment_video",
      filePath: "wangzhuan/batches/wzb_20260626090000_abcd/outputs/missing.mp4",
      storageKey: "seedance/generated/out_remote_001.mp4",
      storageUrl: "https://static.example.com/seedance/generated/out_remote_001.mp4"
    }
  );
  const remoteOnlyById = new Map(remoteOnlyChecks.map((item) => [item.checkId, item]));
  assert.equal(remoteOnlyById.get("ffprobe_readable").status, "pass");
  assert.equal(remoteOnlyById.get("resolution_spec").status, "pass");
  assert.equal(remoteOnlyById.get("duration_tolerance").status, "pass");
  assert.equal(remoteOnlyById.get("download_status").status, "pass");
  assert.match(remoteOnlyById.get("download_status").message, /对象存储/);

  const durationOnlyChecks = await deterministicVideoChecks(
    { userProjectRoot: root, probeGeneratedVideo: async () => ({ durationSec: 34.321, width: 720, height: 1280, formatName: "mp4" }) },
    { estimate: { durationSec: 32, request: { outputRatio: "9:16" } } },
    { outputId: "out_duration_001", durationSec: 32, kind: "stitched_video", filePath: rel }
  );
  const durationOnly = new Map(durationOnlyChecks.map((item) => [item.checkId, item]));
  assert.equal(durationOnly.get("duration_tolerance").status, "pass");
  assert.match(durationOnly.get("duration_tolerance").message, /仅记录不参与 QC 判定/);

  const missingLocalChecks = await deterministicVideoChecks(
    context,
    { estimate: { durationSec: 15, request: { outputRatio: "9:16" } } },
    {
      outputId: "out_missing_001",
      durationSec: 15,
      kind: "segment_video",
      filePath: "wangzhuan/batches/wzb_20260626090000_abcd/outputs/missing-without-remote.mp4"
    }
  );
  assert.equal(missingLocalChecks.at(-1).checkId, "download_status");
  assert.equal(missingLocalChecks.at(-1).status, "fail");
  assert.match(missingLocalChecks.at(-1).message, /未落盘/);

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
