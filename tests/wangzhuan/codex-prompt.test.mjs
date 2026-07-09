import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateBaseSeedancePrompt,
  refineSeedancePromptWithApprovedAssets
} from "../../server/wangzhuan/codex-prompt.mjs";

function makeContext(root) {
  return {
    userProjectRoot: root,
    sharedProjectRoot: root
  };
}

test("generateBaseSeedancePrompt persists context and result files", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-prompt-base-"));
  const result = await generateBaseSeedancePrompt({
    context: makeContext(root),
    batchId: "wzb_20260709000000_abcd",
    decompositionResult: { summary: "开头 3 秒强钩子" },
    productContext: { title: "Demo App" },
    targetRegion: "US",
    language: "en",
    durationSec: 15,
    aspectRatio: "9:16",
    style: "fast hook",
    forbiddenItems: ["medical claims"],
    requestId: "req_test"
  }, {
    async runCodexExec(input) {
      assert.match(input.prompt, /只能够引用 approvedAssets|只能引用 approvedAssets/);
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        finishedAt: new Date().toISOString(),
        durationMs: 1200,
        json: {
          prompt: "main prompt",
          negativePrompt: "no watermark",
          title: "Demo",
          reasoningSummary: "基于拆解和产品信息生成",
          complianceChecks: ["no forbidden claim"],
          warnings: ["No approved product screenshots attached yet."],
          approvedAssetKeysUsed: []
        }
      };
    }
  });

  assert.equal(result.status, "ready");
  assert.equal(result.usesApprovedAssets, false);
  const contextBody = JSON.parse(await readFile(join(root, result.contextPath), "utf8"));
  assert.equal(contextBody.batchId, "wzb_20260709000000_abcd");
  const resultBody = JSON.parse(await readFile(join(root, result.resultPath), "utf8"));
  assert.equal(resultBody.prompt, "main prompt");
});

test("refineSeedancePromptWithApprovedAssets marks approved asset usage", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-prompt-refine-"));
  const result = await refineSeedancePromptWithApprovedAssets({
    context: makeContext(root),
    batchId: "wzb_20260709000000_abcd",
    decompositionResult: { summary: "中段演示产品功能" },
    productContext: { title: "Demo App" },
    approvedAssets: [
      { assetKey: "productScreenshot_1", reviewStatus: "approved" }
    ],
    targetRegion: "US",
    language: "en",
    durationSec: 30,
    aspectRatio: "9:16",
    style: "clean product focus",
    requestId: "req_test_refine"
  }, {
    async runCodexExec() {
      return {
        exitCode: 0,
        stdout: "",
        stderr: "",
        finishedAt: new Date().toISOString(),
        durationMs: 800,
        json: {
          prompt: "refined prompt",
          negativePrompt: "no clutter",
          title: "Demo refined",
          reasoningSummary: "引用审核通过截图补强产品证明",
          complianceChecks: ["approved asset only"],
          warnings: [],
          approvedAssetKeysUsed: ["productScreenshot_1"]
        }
      };
    }
  });

  assert.equal(result.usesApprovedAssets, true);
  assert.deepEqual(result.approvedAssetKeysUsed, ["productScreenshot_1"]);
});

test("generateBaseSeedancePrompt rejects invalid codex payload", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-prompt-invalid-"));
  await assert.rejects(
    generateBaseSeedancePrompt({
      context: makeContext(root),
      batchId: "wzb_20260709000000_abcd",
      decompositionResult: {},
      productContext: {}
    }, {
      async runCodexExec() {
        return {
          exitCode: 0,
          stdout: "",
          stderr: "",
          finishedAt: new Date().toISOString(),
          durationMs: 50,
          json: {
            prompt: "",
            negativePrompt: "no clutter",
            reasoningSummary: "invalid",
            complianceChecks: [],
            warnings: [],
            approvedAssetKeysUsed: []
          }
        };
      }
    }),
    (error) => {
      assert.equal(error.code, "schema_invalid");
      return true;
    }
  );
});
