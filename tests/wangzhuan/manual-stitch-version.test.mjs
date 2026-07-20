import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { handleWangzhuanRequest } from "../../server/wangzhuan/router.mjs";
import {
  createManualStitchVersion,
  deleteManualStitchVersion,
  renameManualStitchVersion
} from "../../server/wangzhuan/stitch.mjs";

const BATCH_ID = "wzb_20260717051112_be06";

function buildBatch() {
  const tasks = [];
  const outputs = [];
  for (let variant = 1; variant <= 2; variant += 1) {
    for (let segment = 1; segment <= 3; segment += 1) {
      const ordinal = ((variant - 1) * 3) + segment;
      const taskId = `gen_be06_${String(ordinal).padStart(3, "0")}`;
      tasks.push({
        generationTaskId: taskId,
        scriptId: `scr_be06_${String(ordinal).padStart(3, "0")}`,
        branchId: "branch_1",
        branchLabel: "默认分支",
        branchVariantIndex: variant,
        segmentIndex: segment,
        status: "downloaded"
      });
      outputs.push({
        outputId: `out_be06_${String(ordinal).padStart(3, "0")}`,
        sourceType: "pipeline",
        batchId: BATCH_ID,
        kind: "segment_video",
        generationTaskIds: [taskId],
        durationSec: 10,
        filePath: `segments/out_be06_${String(ordinal).padStart(3, "0")}.mp4`
      });
    }
  }
  return {
    batchId: BATCH_ID,
    userId: "tester",
    status: "partial_failed",
    tasks,
    scripts: tasks.map((task) => ({
      scriptId: task.scriptId,
      branchId: task.branchId,
      branchLabel: task.branchLabel,
      branchVariantIndex: task.branchVariantIndex,
      segmentIndex: task.segmentIndex,
      durationSec: 10
    })),
    outputs,
    stitchReports: []
  };
}

async function testContext() {
  const root = await mkdtemp(join(tmpdir(), "wz-manual-stitch-"));
  let batch = buildBatch();
  const idempotency = new Map();
  const writes = [];
  const context = {
    root,
    userId: "tester",
    user: { username: "tester", permissions: { "wangzhuan:view": true } },
    userProjectRoot: root,
    sharedProjectRoot: root,
    readBatchForTest: async () => batch,
    writeBatchForTest: async (next, triggerName) => {
      batch = next;
      writes.push({ batch: structuredClone(next), triggerName });
      return next;
    },
    runIdempotentOperation: async (_context, endpoint, key, hash, operation) => {
      const cacheKey = `${endpoint}:${key}:${hash}`;
      if (idempotency.has(cacheKey)) return idempotency.get(cacheKey);
      const result = await operation();
      idempotency.set(cacheKey, result);
      return result;
    },
    loadOutputDetailFromMysql: async (_scoped, outputId) => {
      const output = batch.outputs.find((item) => item.outputId === outputId);
      return output ? { ...output, batchId: batch.batchId } : null;
    },
    createManualStitchOutputForTest: async ({ outputId, segmentOutputs }) => {
      const outputPath = join(root, "批处理记录", "网赚管线", "batches", BATCH_ID, "stitched", `${outputId}.mp4`);
      const reportPath = join(root, "批处理记录", "网赚管线", "batches", BATCH_ID, "stitch", `${outputId}_stitch-report.json`);
      await mkdir(join(outputPath, ".."), { recursive: true });
      await mkdir(join(reportPath, ".."), { recursive: true });
      await writeFile(outputPath, Buffer.from("manual-stitch-video"));
      await writeFile(reportPath, JSON.stringify({ outputId }));
      return {
        output: {
          outputId,
          sourceType: "pipeline",
          batchId: BATCH_ID,
          kind: "stitched_video",
          generationTaskIds: segmentOutputs.flatMap((output) => output.generationTaskIds || []),
          durationSec: segmentOutputs.reduce((sum, output) => sum + output.durationSec, 0),
          filePath: outputPath.slice(root.length + 1),
          storageKey: `stitched/${outputId}.mp4`,
          storageUrl: `https://cdn.example.test/${outputId}.mp4`,
          previewUrl: `https://cdn.example.test/${outputId}.mp4`,
          downloadEligible: true
        },
        report: {
          outputId,
          status: "succeeded",
          segmentOutputIds: segmentOutputs.map((output) => output.outputId),
          reportPath: reportPath.slice(root.length + 1)
        },
        postProcessFailures: []
      };
    },
    get batch() {
      return batch;
    },
    set batch(next) {
      batch = next;
    },
    get writes() {
      return writes;
    }
  };
  return context;
}

test("manual stitch creates ordered partial, complete and confirmed mixed versions", async () => {
  const context = await testContext();
  try {
    const partial = await createManualStitchVersion(context, BATCH_ID, {
      idempotencyKey: "manual-partial-1",
      segmentOutputIds: ["out_be06_003", "out_be06_001"]
    });
    const complete = await createManualStitchVersion(context, BATCH_ID, {
      idempotencyKey: "manual-complete-1",
      segmentOutputIds: ["out_be06_003", "out_be06_001", "out_be06_002"]
    });
    const mixed = await createManualStitchVersion(context, BATCH_ID, {
      idempotencyKey: "manual-mixed-1",
      segmentOutputIds: ["out_be06_001", "out_be06_004"],
      confirmMixed: true
    });

    assert.equal(partial.output.stitchKind, "partial");
    assert.deepEqual(partial.output.segmentOutputIds, ["out_be06_003", "out_be06_001"]);
    assert.equal(partial.output.stitchVersion, 1);
    assert.equal(complete.output.stitchKind, "complete");
    assert.equal(complete.output.stitchVersion, 2);
    assert.equal(mixed.output.stitchKind, "mixed");
    assert.deepEqual(mixed.output.sourceGroups, ["branch_1:1", "branch_1:2"]);
    assert.equal(mixed.output.stitchVersion, 3);
    assert.equal(context.batch.outputs.filter((output) => output.manualStitch).length, 3);
    assert.equal(context.writes.at(-1).triggerName, "manual_stitch");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("manual stitch requires mixed confirmation and current unique segment outputs", async () => {
  const context = await testContext();
  try {
    await assert.rejects(
      createManualStitchVersion(context, BATCH_ID, {
        idempotencyKey: "mixed-no-confirm",
        segmentOutputIds: ["out_be06_001", "out_be06_004"]
      }),
      (error) => error?.code === "mixed_stitch_confirmation_required"
    );
    await assert.rejects(
      createManualStitchVersion(context, BATCH_ID, {
        idempotencyKey: "missing-output",
        segmentOutputIds: ["out_be06_missing"]
      }),
      (error) => error?.code === "invalid_material"
    );
    await assert.rejects(
      createManualStitchVersion(context, BATCH_ID, {
        idempotencyKey: "duplicate-output",
        segmentOutputIds: ["out_be06_001", "out_be06_001"]
      }),
      (error) => error?.code === "validation_error"
    );
    assert.equal(context.batch.outputs.filter((output) => output.manualStitch).length, 0);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("manual stitch rejects stale and reversed continuity lineage", async () => {
  const context = await testContext();
  try {
    const parent = context.batch.tasks[0];
    const child = context.batch.tasks[1];
    parent.continuityGroupId = "cg_story";
    parent.continuitySliceId = "cg_story_slice_1";
    parent.attempts = 2;
    child.continuityGroupId = "cg_story";
    child.continuitySliceId = "cg_story_slice_2";
    child.previousSliceId = "cg_story_slice_1";
    child.requestSummary = {
      continuityParent: {
        generationTaskId: parent.generationTaskId,
        continuitySliceId: parent.continuitySliceId,
        attemptNo: 1,
        outputId: "out_parent_old"
      }
    };

    await assert.rejects(
      createManualStitchVersion(context, BATCH_ID, {
        idempotencyKey: "stale-continuity",
        segmentOutputIds: ["out_be06_001", "out_be06_002"]
      }),
      (error) => error?.code === "continuity_lineage_mismatch"
    );

    child.requestSummary.continuityParent.attemptNo = 2;
    child.requestSummary.continuityParent.outputId = "out_be06_001";
    await assert.rejects(
      createManualStitchVersion(context, BATCH_ID, {
        idempotencyKey: "reversed-continuity",
        segmentOutputIds: ["out_be06_002", "out_be06_001"]
      }),
      (error) => error?.code === "continuity_lineage_mismatch"
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("manual stitch idempotency replay does not append another version", async () => {
  const context = await testContext();
  try {
    const request = {
      idempotencyKey: "manual-replay-1",
      segmentOutputIds: ["out_be06_001"]
    };
    const first = await createManualStitchVersion(context, BATCH_ID, request);
    const replay = await createManualStitchVersion(context, BATCH_ID, request);

    assert.equal(replay.output.outputId, first.output.outputId);
    assert.equal(context.batch.outputs.filter((output) => output.manualStitch).length, 1);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("manual stitch rename and guarded delete preserve unrelated versions", async () => {
  const context = await testContext();
  try {
    const created = await createManualStitchVersion(context, BATCH_ID, {
      idempotencyKey: "manual-manage-1",
      segmentOutputIds: ["out_be06_001"]
    });
    const renamed = await renameManualStitchVersion(context, created.output.outputId, {
      displayFileName: "投放候选版.mp4"
    });
    assert.equal(renamed.output.displayFileName, "投放候选版.mp4");

    context.batch = {
      ...context.batch,
      outputs: [
        ...context.batch.outputs,
        { outputId: "out_be06_099", kind: "expanded_video", parentOutputId: created.output.outputId }
      ]
    };
    await assert.rejects(
      deleteManualStitchVersion(context, created.output.outputId),
      (error) => error?.code === "output_in_use"
    );

    context.batch = {
      ...context.batch,
      outputs: context.batch.outputs.filter((output) => output.outputId !== "out_be06_099")
    };
    const deleted = await deleteManualStitchVersion(context, created.output.outputId);
    assert.equal(deleted.deletedOutputId, created.output.outputId);
    assert.equal(context.batch.outputs.some((output) => output.outputId === created.output.outputId), false);
    assert.equal(context.batch.outputs.filter((output) => output.kind === "segment_video").length, 6);
    await assert.rejects(readFile(join(context.root, created.output.filePath)));
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

class TestResponse extends EventEmitter {
  constructor() {
    super();
    this.statusCode = 0;
    this.body = "";
  }
  writeHead(statusCode) {
    this.statusCode = statusCode;
  }
  end(body = "") {
    this.body += body;
    this.emit("finish");
  }
}

async function routeCall(method, pathname, body, overrides = {}) {
  const req = { method, headers: {} };
  const res = new TestResponse();
  const user = { username: "tester", permissions: { "wangzhuan:view": true } };
  const context = {
    user,
    userId: "tester",
    currentUser: () => user,
    currentUserId: () => "tester",
    currentProjectRoot: () => "/tmp/project-a",
    currentBaseProjectRoot: () => "/tmp/project-a",
    readJson: async () => body,
    ...overrides
  };
  await handleWangzhuanRequest(req, res, new URL(`http://127.0.0.1${pathname}`), context);
  return { statusCode: res.statusCode, payload: JSON.parse(res.body) };
}

test("manual stitch create, rename and delete routes forward standard contracts", async () => {
  const calls = [];
  const overrides = {
    createManualStitchVersion: async (_scoped, batchId, request) => {
      calls.push(["create", batchId, request]);
      return { output: { outputId: "out_be06_010", stitchVersion: 1 } };
    },
    renameManualStitchVersion: async (_scoped, outputId, request) => {
      calls.push(["rename", outputId, request]);
      return { output: { outputId, displayFileName: request.displayFileName } };
    },
    deleteManualStitchVersion: async (_scoped, outputId) => {
      calls.push(["delete", outputId]);
      return { deletedOutputId: outputId };
    }
  };

  const created = await routeCall("POST", `/api/wangzhuan/batches/${BATCH_ID}/stitch-versions`, {
    idempotencyKey: "route-create",
    segmentOutputIds: ["out_be06_001"]
  }, overrides);
  const renamed = await routeCall("PATCH", "/api/wangzhuan/outputs/out_be06_010", {
    displayFileName: "候选版.mp4"
  }, overrides);
  const deleted = await routeCall("DELETE", "/api/wangzhuan/outputs/out_be06_010", {}, overrides);

  assert.equal(created.statusCode, 200);
  assert.equal(created.payload.data.output.stitchVersion, 1);
  assert.equal(renamed.payload.data.output.displayFileName, "候选版.mp4");
  assert.equal(deleted.payload.data.deletedOutputId, "out_be06_010");
  assert.deepEqual(calls.map((call) => call[0]), ["create", "rename", "delete"]);
});
