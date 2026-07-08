import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { applyConfirmedPlanEdits } from "../../server/wangzhuan/pipeline.mjs";

test("confirmed plan edits persist output-template fields to plans and scripts", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-confirm-plan-output-template-"));
  try {
    const batch = {
      batchId: "wzb_20260708000000_abcd",
      branchDrafts: [
        {
          branchId: "branch_1",
          outputTemplateMode: "three_slice_net_earning",
          subtitleWorkflow: "none"
        }
      ],
      scripts: [
        {
          scriptId: "script_1",
          planId: "plan_1",
          branchId: "branch_1",
          scriptPath: "scripts/script_1.json",
          promptPath: "prompts/script_1.txt"
        }
      ],
      tasks: [
        {
          scriptId: "script_1",
          generationTaskId: "task_1"
        }
      ]
    };
    const plans = [
      {
        planId: "plan_1",
        branchId: "branch_1",
        hook: "Original hook",
        body: "Original body",
        voiceover: "Original voiceover",
        subtitles: ["Old subtitle"],
        cta: "",
        ending: "",
        imagePrompt: "Original image prompt",
        seedancePrompt: "Original Seedance prompt",
        negativePrompt: "Original negative prompt",
        mediaRefs: {},
        complianceNotes: [],
        segmentRole: "proof_slice",
        sliceDurationSec: 15,
        outputTemplateMode: "three_slice_net_earning",
        moneyVisuals: ["coin_burst"],
        withdrawalVisual: "Pix option",
        subtitleWorkflow: "none",
        sliceDiversity: {
          personChangedFromPrevious: false,
          sceneChangedFromPrevious: false,
          clothingChangedFromPrevious: false,
          voiceChangedFromPrevious: false
        }
      }
    ];
    const request = {
      plans: [
        {
          ...plans[0],
          subtitles: [],
          segmentRole: "withdrawal_slice",
          sliceDurationSec: 12,
          outputTemplateMode: "short_drama_earning_highlight",
          moneyVisuals: ["cash_rain", "withdrawal_success"],
          withdrawalVisual: "Nubank withdrawal screen without exact amount",
          subtitleWorkflow: {
            burnedInSubtitles: false,
            postSubtitleRequired: false,
            provider: "pixel_tech",
            subtitleScript: []
          },
          sliceDiversity: {
            personChangedFromPrevious: true,
            sceneChangedFromPrevious: true,
            clothingChangedFromPrevious: true,
            voiceChangedFromPrevious: true
          }
        }
      ]
    };

    const { nextPlans, nextScripts } = await applyConfirmedPlanEdits(
      { userProjectRoot: root },
      batch,
      plans,
      new Set(["plan_1"]),
      request
    );

    assert.equal(nextPlans[0].status, "confirmed");
    assert.equal(nextPlans[0].segmentRole, "withdrawal_slice");
    assert.equal(nextPlans[0].sliceDurationSec, 12);
    assert.equal(nextPlans[0].outputTemplateMode, "short_drama_earning_highlight");
    assert.deepEqual(nextPlans[0].moneyVisuals, ["cash_rain", "withdrawal_success"]);
    assert.equal(nextPlans[0].withdrawalVisual, "Nubank withdrawal screen without exact amount");
    assert.deepEqual(nextPlans[0].subtitles, []);
    assert.equal(nextPlans[0].subtitleWorkflow.postSubtitleRequired, false);
    assert.deepEqual(nextPlans[0].subtitleWorkflow.subtitleScript, []);
    assert.equal(nextPlans[0].sliceDiversity.personChangedFromPrevious, true);

    assert.equal(nextScripts[0].segmentRole, "withdrawal_slice");
    assert.equal(nextScripts[0].sliceDurationSec, 12);
    assert.equal(nextScripts[0].outputTemplateMode, "short_drama_earning_highlight");
    assert.deepEqual(nextScripts[0].moneyVisuals, ["cash_rain", "withdrawal_success"]);
    assert.equal(nextScripts[0].subtitleWorkflow.postSubtitleRequired, false);
    assert.deepEqual(nextScripts[0].subtitleWorkflow.subtitleScript, []);
    assert.equal(nextScripts[0].sliceDiversity.voiceChangedFromPrevious, true);

    const persistedScript = JSON.parse(await readFile(join(root, "scripts/script_1.json"), "utf8"));
    assert.equal(persistedScript.outputTemplateMode, "short_drama_earning_highlight");
    assert.equal(persistedScript.subtitleWorkflow.postSubtitleRequired, false);
    assert.deepEqual(persistedScript.subtitleWorkflow.subtitleScript, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
