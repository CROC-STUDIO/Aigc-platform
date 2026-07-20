import assert from "node:assert/strict";
import test from "node:test";

import {
  FISSION_ANALYSIS_PROMPT_REQUIREMENTS,
  buildSeedanceSlicesFromAnalysis,
  deriveSeedanceSlicesForGeneration,
  normalizeFissionAnalysis,
  splitStorySegmentIntoSeedanceSlices
} from "../../server/wangzhuan/fission-analysis.mjs";
import { buildCompactDecompositionUserPrompt, buildDecompositionUserPrompt } from "../../server/wangzhuan/decomposition-prompt.mjs";
import { validateVideoDecomposition } from "../../server/wangzhuan/reference-videos.mjs";

const sevenDimensions = {
  scene: "factory break room",
  subject: "night-shift worker holding a phone",
  action: "checks reward feedback and reacts with relief",
  camera: "handheld phone close-up to reaction shot",
  lighting: "fluorescent practical light",
  style: "realistic UGC reward-app ad",
  quality: "clean mobile video with natural motion"
};

test("normalizeFissionAnalysis wraps legacy seven-dimension decomposition into one story segment", () => {
  const normalized = normalizeFissionAnalysis(sevenDimensions, { durationSec: 15 });

  assert.deepEqual(normalized.seedanceSlices, []);
  assert.equal(normalized.storySegments.length, 1);
  assert.deepEqual(normalized.storySegments[0], {
    storySegmentIndex: 1,
    startSec: 0,
    endSec: 15,
    durationSec: 15,
    ...sevenDimensions,
    coreHook: "",
    explosivePoint: "",
    segmentPurpose: "",
    segmentConversionStyle: "",
    segmentRhythm: "",
    segmentStructureSkeleton: "",
    timelineItems: [],
    conversionSignals: [],
    conversionEffectOpportunities: [],
    voiceoverObserved: [],
    variableLayers: [],
    sliceSplitHints: []
  });
});

test("splitStorySegmentIntoSeedanceSlices uses narrative split hints and preserves contract fields", () => {
  const segment = {
    storySegmentIndex: 3,
    startSec: 14,
    endSec: 40,
    durationSec: 26,
    segmentRole: "body_payoff",
    ...sevenDimensions,
    coreHook: "worker sees a reward proof",
    explosivePoint: "coin burst lands after task completion",
    subtitles: "I just finished one task and the reward appeared.",
    conversionSignals: [{ type: "earningsNumber", value: "$3.20" }, "fastRewardCue"],
    conversionEffectOpportunities: ["magnify coin feedback"],
    voiceoverObserved: ["excited payoff line"],
    variableLayers: ["worker identity"],
    timelineItems: [{ startSec: 14, endSec: 26, type: "story", description: "opens app" }],
    sliceSplitHints: [{ splitSec: 26, reason: "reward reveal turns into payoff reaction" }]
  };

  const slices = splitStorySegmentIntoSeedanceSlices(segment);

  assert.equal(slices.length, 2);
  assert.equal(slices[0].startSec, 14);
  assert.equal(slices[0].endSec, 26);
  assert.equal(slices[0].durationSec, 12);
  assert.equal(slices[0].sliceDurationSec, 12);
  assert.equal(slices[0].sliceSplitReason, "reward reveal turns into payoff reaction");
  assert.equal(slices[1].startSec, 26);
  assert.equal(slices[1].endSec, 40);
  assert.equal(slices[1].durationSec, 14);
  assert.equal(slices[1].sliceDurationSec, 14);
  assert.equal(slices[1].sliceSplitReason, "reward reveal turns into payoff reaction");
  for (const slice of slices) {
    assert.equal(slice.storySegmentIndex, 3);
    assert.equal(slice.segmentRole, "body_payoff");
    assert.equal(slice.subtitles, "I just finished one task and the reward appeared.");
    assert.deepEqual(slice.subtitleWorkflow, {
      burnedInSubtitles: false,
      postSubtitleRequired: true,
      provider: "pixel_tech",
      subtitleScript: ["I just finished one task and the reward appeared."]
    });
    assert.deepEqual(
      {
        scene: slice.scene,
        subject: slice.subject,
        action: slice.action,
        camera: slice.camera,
        lighting: slice.lighting,
        style: slice.style,
        quality: slice.quality
      },
      sevenDimensions
    );
    assert.deepEqual(slice.conversionSignals, [{ type: "earningsNumber", value: "$3.20" }, "fastRewardCue"]);
    assert.deepEqual(slice.conversionEffectOpportunities, ["magnify coin feedback"]);
  }
});

test("splitStorySegmentIntoSeedanceSlices falls back to efficient multi-slice split for 44s segment", () => {
  const slices = splitStorySegmentIntoSeedanceSlices({
    storySegmentIndex: 1,
    startSec: 0,
    endSec: 44,
    durationSec: 44,
    ...sevenDimensions,
    coreHook: "long-form opening beat"
  });

  assert.equal(slices.length, 3);
  assert.equal(slices[0].startSec, 0);
  assert.equal(slices.at(-1).endSec, 44);
  assert.equal(
    Math.round(slices.reduce((total, slice) => total + slice.durationSec, 0) * 1000) / 1000,
    44
  );
  for (const [index, slice] of slices.entries()) {
    assert.equal(slice.storySegmentIndex, 1);
    assert.equal(slice.seedanceSliceIndex, index + 1);
    assert.ok(slice.durationSec >= 5);
    assert.ok(slice.durationSec <= 15);
    assert.equal(slice.sliceSplitReason, "even duration fallback split");
  }
});

test("splitStorySegmentIntoSeedanceSlices combines hint-guided and fallback multi-slice boundaries", () => {
  const slices = splitStorySegmentIntoSeedanceSlices({
    storySegmentIndex: 2,
    startSec: 0,
    endSec: 31,
    durationSec: 31,
    ...sevenDimensions,
    sliceSplitHints: [{ splitSec: 12, reason: "claim turns into proof UI" }]
  });

  assert.equal(slices.length, 3);
  assert.equal(slices[0].endSec, 12);
  assert.equal(slices[1].startSec, 12);
  assert.equal(slices.at(-1).endSec, 31);
  for (const slice of slices) {
    assert.ok(slice.durationSec >= 5);
    assert.ok(slice.durationSec <= 15);
    assert.match(slice.sliceSplitReason, /hint-guided multi-slice split/);
  }
});

test("buildSeedanceSlicesFromAnalysis prefers explicit seedanceSlices over storySegments", () => {
  const slices = buildSeedanceSlicesFromAnalysis({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 26,
        durationSec: 26,
        ...sevenDimensions
      }
    ],
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        segmentRole: "hook",
        startSec: 0,
        endSec: 11,
        durationSec: 11,
        ...sevenDimensions,
        coreHook: "instant cash proof hook",
        subtitles: "Watch the reward land after the task.",
        conversionSignals: { withdrawalSuccess: true, earningsNumber: "$2.40" }
      }
    ]
  });

  assert.equal(slices.length, 1);
  assert.equal(slices[0].segmentRole, "hook");
  assert.equal(slices[0].startSec, 0);
  assert.equal(slices[0].endSec, 11);
  assert.equal(slices[0].durationSec, 11);
  assert.equal(slices[0].sliceDurationSec, 11);
  assert.equal(slices[0].coreHook, "instant cash proof hook");
  assert.deepEqual(slices[0].conversionSignals, { withdrawalSuccess: true, earningsNumber: "$2.40" });
  assert.deepEqual(slices[0].subtitleWorkflow, {
    burnedInSubtitles: false,
    postSubtitleRequired: true,
    provider: "pixel_tech",
    subtitleScript: ["Watch the reward land after the task."]
  });
});

test("splitStorySegmentIntoSeedanceSlices preserves segment subtitleWorkflow off mode and provider", () => {
  const slices = splitStorySegmentIntoSeedanceSlices({
    storySegmentIndex: 4,
    startSec: 0,
    endSec: 12,
    durationSec: 12,
    ...sevenDimensions,
    subtitles: "Do not render this subtitle.",
    subtitleWorkflow: {
      postSubtitleRequired: false,
      provider: "manual_no_subtitle",
      subtitleScript: ["Do not keep when disabled"]
    }
  });

  assert.equal(slices.length, 1);
  assert.deepEqual(slices[0].subtitleWorkflow, {
    burnedInSubtitles: false,
    postSubtitleRequired: false,
    provider: "manual_no_subtitle",
    subtitleScript: []
  });
});

test("normalize subtitleWorkflow parses string false and keeps script arrays only when post subtitles are enabled", () => {
  const offSlices = buildSeedanceSlicesFromAnalysis({
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 9,
        durationSec: 9,
        ...sevenDimensions,
        subtitles: "Should be dropped because post process is off.",
        subtitleWorkflow: {
          postSubtitleRequired: "false",
          provider: "pixel_tech",
          subtitleScript: "Should also be dropped."
        }
      }
    ]
  });

  assert.deepEqual(offSlices[0].subtitleWorkflow, {
    burnedInSubtitles: false,
    postSubtitleRequired: false,
    provider: "pixel_tech",
    subtitleScript: []
  });

  const onSlices = buildSeedanceSlicesFromAnalysis({
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 9,
        durationSec: 9,
        ...sevenDimensions,
        subtitleWorkflow: {
          postSubtitleRequired: "是",
          provider: "custom_provider",
          subtitleScript: "Keep this subtitle line."
        }
      }
    ]
  });

  assert.deepEqual(onSlices[0].subtitleWorkflow, {
    burnedInSubtitles: false,
    postSubtitleRequired: true,
    provider: "custom_provider",
    subtitleScript: ["Keep this subtitle line."]
  });
});

test("normalizeFissionAnalysis rejects invalid story segment timing", () => {
  assert.throws(
    () => normalizeFissionAnalysis({
      storySegments: [
        {
          storySegmentIndex: 7,
          startSec: 10,
          endSec: 10,
          durationSec: 0,
          ...sevenDimensions
        }
      ]
    }),
    /storySegmentIndex=7 time range is invalid/
  );
});

test("normalizeFissionAnalysis strict mode rejects story segments without explicit timing", () => {
  assert.throws(
    () => normalizeFissionAnalysis({
      storySegments: [
        {
          storySegmentIndex: 1,
          ...sevenDimensions
        }
      ]
    }, { strictStorySegmentTiming: true }),
    /storySegmentIndex=1 startSec is required/
  );
});

test("normalizeFissionAnalysis strict mode rejects overlapping story segment timing", () => {
  assert.throws(
    () => normalizeFissionAnalysis({
      storySegments: [
        {
          storySegmentIndex: 1,
          startSec: 0,
          endSec: 12,
          durationSec: 12,
          ...sevenDimensions
        },
        {
          storySegmentIndex: 2,
          startSec: 6,
          endSec: 14,
          durationSec: 8,
          ...sevenDimensions
        }
      ]
    }, { strictStorySegmentTiming: true }),
    /chronological and non-overlapping/
  );
});

test("buildSeedanceSlicesFromAnalysis rejects invalid seedance slice timing without story segments", () => {
  assert.throws(
    () => buildSeedanceSlicesFromAnalysis({
      seedanceSlices: [
        {
          storySegmentIndex: 1,
          seedanceSliceIndex: 2,
          startSec: 8,
          endSec: 7,
          durationSec: -1,
          ...sevenDimensions
        }
      ]
    }),
    /seedanceSliceIndex=2 time range is invalid/
  );
});

test("buildSeedanceSlicesFromAnalysis ignores invalid suggested seedance slices when story segments are valid", () => {
  const slices = buildSeedanceSlicesFromAnalysis({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 12,
        durationSec: 12,
        ...sevenDimensions,
        coreHook: "valid story hook"
      }
    ],
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 8,
        endSec: 7,
        durationSec: -1,
        ...sevenDimensions,
        coreHook: "bad suggested slice"
      }
    ]
  });

  assert.equal(slices.length, 1);
  assert.equal(slices[0].storySegmentIndex, 1);
  assert.equal(slices[0].seedanceSliceIndex, 1);
  assert.equal(slices[0].startSec, 0);
  assert.equal(slices[0].endSec, 12);
  assert.equal(slices[0].durationSec, 12);
  assert.equal(slices[0].coreHook, "valid story hook");
});

test("buildSeedanceSlicesFromAnalysis rejects overlong explicit slices and falls back to storySegments", () => {
  const slices = buildSeedanceSlicesFromAnalysis({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 40,
        endSec: 56,
        durationSec: 16,
        ...sevenDimensions,
        coreHook: "final payoff"
      }
    ],
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 40,
        endSec: 56,
        durationSec: 16,
        sliceDurationSec: 16,
        ...sevenDimensions,
        coreHook: "bad overlong slice"
      }
    ]
  });

  assert.equal(slices.length, 2);
  assert.ok(slices.every((slice) => slice.durationSec <= 15));
  assert.equal(slices[0].startSec, 40);
  assert.equal(slices[1].endSec, 56);
  assert.equal(slices[0].coreHook, "final payoff");
});

test("buildSeedanceSlicesFromAnalysis derives multi-slice output from long story segment", () => {
  const slices = buildSeedanceSlicesFromAnalysis({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 44,
        durationSec: 44,
        ...sevenDimensions,
        coreHook: "full long beat"
      }
    ]
  });

  assert.equal(slices.length, 3);
  assert.equal(slices[0].startSec, 0);
  assert.equal(slices.at(-1).endSec, 44);
  assert.equal(slices[0].coreHook, "full long beat");
  assert.ok(slices.every((slice) => slice.durationSec >= 5 && slice.durationSec <= 15));
});

test("deriveSeedanceSlicesForGeneration prefers explicit seedanceSlices when present", () => {
  const slices = deriveSeedanceSlicesForGeneration({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 24,
        durationSec: 24,
        ...sevenDimensions,
        coreHook: "story fallback"
      }
    ],
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 9,
        durationSec: 9,
        segmentRole: "hook_slice",
        ...sevenDimensions,
        coreHook: "explicit generation slice"
      }
    ]
  });

  assert.equal(slices.length, 1);
  assert.equal(slices[0].coreHook, "explicit generation slice");
  assert.equal(slices[0].durationSec, 9);
});

test("deriveSeedanceSlicesForGeneration derives slices from storySegments when seedanceSlices are absent", () => {
  const slices = deriveSeedanceSlicesForGeneration({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 26,
        durationSec: 26,
        ...sevenDimensions,
        coreHook: "story-driven split",
        sliceSplitHints: [{ splitSec: 12, reason: "claim changes into app proof" }]
      }
    ]
  });

  assert.deepEqual(
    slices.map((slice) => ({ startSec: slice.startSec, endSec: slice.endSec, durationSec: slice.durationSec })),
    [
      { startSec: 0, endSec: 12, durationSec: 12 },
      { startSec: 12, endSec: 26, durationSec: 14 }
    ]
  );
  assert.equal(slices[0].sliceSplitReason, "claim changes into app proof");
});

test("deriveSeedanceSlicesForGeneration links an ordered continuity chain across story segments", () => {
  const slices = deriveSeedanceSlicesForGeneration({
    sourceAssemblyMode: "continuous_story",
    continuityPlan: {
      groups: [{
        continuityGroupId: "cg_1",
        storySegmentIndexes: [1, 2],
        globalAnchors: {
          protagonist: "same delivery worker",
          wardrobe: "blue rain jacket",
          voice: "same Mandarin speaker"
        }
      }]
    },
    storySegments: [
      {
        storySegmentIndex: 1,
        continuityGroupId: "cg_1",
        startSec: 0,
        endSec: 16,
        durationSec: 16,
        ...sevenDimensions,
        startFrameState: { pose: "standing beside the scooter" },
        endFrameState: { pose: "raises the phone", phoneUi: "reward popup open" }
      },
      {
        storySegmentIndex: 2,
        continuityGroupId: "cg_1",
        startSec: 16,
        endSec: 26,
        durationSec: 10,
        ...sevenDimensions,
        startFrameState: { pose: "phone remains raised", phoneUi: "reward popup open" },
        endFrameState: { pose: "taps withdraw" }
      }
    ]
  });

  assert.equal(slices.length, 3);
  assert.deepEqual(slices.map((slice) => slice.seedanceSliceIndex), [1, 2, 3]);
  assert.deepEqual(slices.map((slice) => slice.storySegmentIndex), [1, 1, 2]);
  assert.deepEqual(slices.map((slice) => slice.continuityGroupId), ["cg_1", "cg_1", "cg_1"]);
  assert.deepEqual(slices.map((slice) => slice.continuitySliceId), [
    "cg_1_slice_1",
    "cg_1_slice_2",
    "cg_1_slice_3"
  ]);
  assert.deepEqual(slices.map((slice) => slice.continuitySequence), [1, 2, 3]);
  assert.deepEqual(slices.map((slice) => slice.previousSliceId), ["", "cg_1_slice_1", "cg_1_slice_2"]);
  assert.deepEqual(slices.map((slice) => slice.continuityMode), [
    "independent_slice",
    "continuous_from_previous",
    "continuous_from_previous"
  ]);
  assert.equal(slices[2].continuityReferenceNeeded, true);
  assert.deepEqual(slices[2].globalContinuityAnchors, {
    protagonist: "same delivery worker",
    wardrobe: "blue rain jacket",
    voice: "same Mandarin speaker"
  });
  assert.deepEqual(slices[2].startFrameState, {
    pose: "phone remains raised",
    phoneUi: "reward popup open"
  });
});

test("legacy range continuity groups are normalized into an ordered multi-slice chain", () => {
  const normalized = normalizeFissionAnalysis({
    sourceAssemblyMode: "hybrid_overlay_montage",
    continuityPlan: {
      continuousGroups: [
        {
          groupIndex: 1,
          startSec: 0,
          endSec: 24,
          basis: "same indoor drama ensemble, fixed wardrobe, shared room and reward HUD",
          reuseGoal: "drama hook and reward proof"
        },
        {
          groupIndex: 2,
          startSec: 24,
          endSec: 34,
          basis: "focus switches to the woman, but it remains the same indoor drama space, shared HUD and unchanged audio logic",
          reuseGoal: "emotional continuation of the same indoor story"
        },
        {
          groupIndex: 3,
          startSec: 34,
          endSec: 42,
          basis: "hard reset to full-screen content library UI; live-action cast disappears",
          reuseGoal: "content library proof"
        },
        {
          groupIndex: 4,
          startSec: 42,
          endSec: 48.576,
          basis: "brand and product proof close",
          reuseGoal: "product proof"
        }
      ]
    },
    storySegments: [
      { storySegmentIndex: 1, startSec: 0, endSec: 6, durationSec: 6, ...sevenDimensions },
      {
        storySegmentIndex: 2,
        startSec: 6,
        endSec: 24,
        durationSec: 18,
        sliceSplitHints: [{ splitSec: 14, reason: "dialogue moves into reward proof" }],
        ...sevenDimensions
      },
      { storySegmentIndex: 3, startSec: 24, endSec: 34, durationSec: 10, ...sevenDimensions },
      { storySegmentIndex: 4, startSec: 34, endSec: 42, durationSec: 8, ...sevenDimensions },
      { storySegmentIndex: 5, startSec: 42, endSec: 48.576, durationSec: 6.576, ...sevenDimensions }
    ]
  }, { deriveSeedanceSlices: true });

  assert.equal(normalized.sourceAssemblyMode, "mixed");
  assert.deepEqual(normalized.continuityPlan.groups.map((group) => ({
    continuityGroupId: group.continuityGroupId,
    storySegmentIndexes: group.storySegmentIndexes
  })), [
    { continuityGroupId: "cg_1", storySegmentIndexes: [1, 2, 3] },
    { continuityGroupId: "cg_2", storySegmentIndexes: [4] },
    { continuityGroupId: "cg_3", storySegmentIndexes: [5] }
  ]);
  assert.deepEqual(normalized.seedanceSlices.slice(0, 4).map((slice) => ({
    group: slice.continuityGroupId,
    mode: slice.continuityMode,
    previous: slice.previousSliceId
  })), [
    { group: "cg_1", mode: "independent_slice", previous: "" },
    { group: "cg_1", mode: "continuous_from_previous", previous: "cg_1_slice_1" },
    { group: "cg_1", mode: "continuous_from_previous", previous: "cg_1_slice_2" },
    { group: "cg_1", mode: "continuous_from_previous", previous: "cg_1_slice_3" }
  ]);
  assert.match(normalized.seedanceSlices[1].globalContinuityAnchors.continuityBasis, /fixed wardrobe/);
});

test("deriveSeedanceSlicesForGeneration falls back to storySegments when explicit seedanceSlices are invalid", () => {
  const slices = deriveSeedanceSlicesForGeneration({
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 16,
        durationSec: 16,
        ...sevenDimensions,
        coreHook: "valid fallback segment"
      }
    ],
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 31,
        durationSec: 31,
        sliceDurationSec: 31,
        ...sevenDimensions,
        coreHook: "invalid explicit slice"
      }
    ]
  });

  assert.equal(slices.length, 2);
  assert.equal(slices[0].coreHook, "valid fallback segment");
  assert.deepEqual(slices.map((slice) => slice.durationSec), [8, 8]);
});

test("Seedance generation slices accept the full 5-15 second range", () => {
  const slices = deriveSeedanceSlicesForGeneration({
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 5,
        durationSec: 5,
        sliceDurationSec: 5,
        ...sevenDimensions
      },
      {
        storySegmentIndex: 2,
        seedanceSliceIndex: 2,
        startSec: 5,
        endSec: 20,
        durationSec: 15,
        sliceDurationSec: 15,
        ...sevenDimensions
      }
    ]
  });

  assert.deepEqual(slices.map((slice) => slice.durationSec), [5, 15]);
  assert.throws(
    () => deriveSeedanceSlicesForGeneration({
      seedanceSlices: [{
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 4.9,
        durationSec: 4.9,
        sliceDurationSec: 4.9,
        ...sevenDimensions
      }]
    }),
    /duration must be 5-15s/
  );
  assert.throws(
    () => deriveSeedanceSlicesForGeneration({
      seedanceSlices: [{
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 17,
        durationSec: 17,
        sliceDurationSec: 17,
        ...sevenDimensions
      }]
    }),
    /duration must be 5-15s/
  );
});

test("story segments can opt into a 30 second maximum for non-Seedance planning", () => {
  const slices = splitStorySegmentIntoSeedanceSlices({
    storySegmentIndex: 1,
    startSec: 0,
    endSec: 30,
    durationSec: 30,
    ...sevenDimensions
  }, { minSliceSec: 5, maxSliceSec: 30 });

  assert.deepEqual(slices.map((slice) => slice.durationSec), [30]);
});

test("FISSION_ANALYSIS_PROMPT_REQUIREMENTS covers production fission analysis rules", () => {
  const text = FISSION_ANALYSIS_PROMPT_REQUIREMENTS.join("\n");

  assert.match(text, /whole video/i);
  assert.match(text, /Do not create a new story segment only because/i);
  assert.match(text, /timelineItems unless they change the narrative beat/i);
  assert.match(text, /scene, subject, action, camera, lighting, style, quality, coreHook, explosivePoint, segmentPurpose, segmentConversionStyle, segmentRhythm, segmentStructureSkeleton, timelineItems, conversionSignals, conversionEffectOpportunities, voiceoverObserved, variableLayers, and sliceSplitHints/);
  assert.match(text, /conversionSignals/);
  assert.match(text, /withdrawalSuccess/);
  assert.match(text, /earningsNumber/);
  assert.match(text, /emotionalVoiceover/);
  assert.match(text, /cashCoinFeedback/);
  assert.match(text, /fastRewardCue/);
  assert.match(text, /conversionEffectOpportunities/);
  assert.match(text, /shot\/reverse-shot/i);
  assert.match(text, /focal-subject cut alone does not start a new group/i);
  assert.match(text, /no burned subtitles/i);
  assert.match(text, /no captions/i);
  assert.match(text, /subtitleWorkflow\.subtitleScript/);
});

test("formal decomposition prompt asks for whole-video-first fission analysis", () => {
  const prompt = buildDecompositionUserPrompt(
    { durationSec: 28 },
    { knowledgeNotes: "keep local product rules" },
    { provider: "skylink", model: "gpt-5.4" },
    () => "mock probe prompt"
  );

  assert.match(prompt, /whole video first/i);
  assert.match(prompt, /storySegments/);
  assert.match(prompt, /startSec\/endSec\/durationSec/);
  assert.match(prompt, /seedanceSlices are optional/i);
  assert.match(prompt, /sliceSplitHints are mandatory/i);
  assert.match(prompt, /backend will derive generation slices from storySegments plus sliceSplitHints/i);
  assert.match(prompt, /5-15s slices/i);
  assert.match(prompt, /timelineItems/);
  assert.match(prompt, /conversionSignals/);
  assert.match(prompt, /conversionEffectOpportunities/);
  assert.match(prompt, /Do not create a new story segment only because/i);
  assert.match(prompt, /app UI/i);
  assert.match(prompt, /reward animation/i);
  assert.match(prompt, /cash\/coin/i);
  assert.match(prompt, /subtitle card/i);
  assert.match(prompt, /title card/i);
  assert.match(prompt, /withdrawal visual/i);
  assert.match(prompt, /CTA overlay/i);
  assert.match(prompt, /timelineItems unless they change the narrative beat/i);
  assert.match(prompt, /scene\/subject\/action\/camera\/lighting\/style\/quality\/hook/);
  assert.match(prompt, /subtitleWorkflow\.subtitleScript/);
  assert.match(prompt, /subtitles for post-processing/i);
  assert.match(prompt, /not burned/i);
  assert.match(prompt, /sourceAssemblyMode/);
  assert.match(prompt, /continuityPlan/);
  assert.match(prompt, /continuityGroupId/);
  assert.match(prompt, /Shot\/reverse-shot/i);
  assert.match(prompt, /startFrameState/);
  assert.match(prompt, /endFrameState/);
  assert.doesNotMatch(prompt, /可选的 seedanceSlices 示例/);
  assert.doesNotMatch(prompt, /segmentRole/);
});

test("validateVideoDecomposition preserves continuity analysis fields", () => {
  const normalized = validateVideoDecomposition("ref_continuity", {
    ...sevenDimensions,
    hook: "continuous drama opening",
    sourceAssemblyMode: "mixed",
    continuityPlan: {
      groups: [{
        continuityGroupId: "cg_drama",
        storySegmentIndexes: [1, 2],
        globalAnchors: { protagonist: "same worker", scene: "same apartment" }
      }]
    },
    storySegments: [{
      storySegmentIndex: 1,
      continuityGroupId: "cg_drama",
      continuityMode: "independent_slice",
      boundaryType: "continuity_group_start",
      startFrameState: { pose: "sitting" },
      endFrameState: { pose: "stands up" },
      continuityReferenceNeeded: false,
      globalContinuityAnchors: { protagonist: "same worker" },
      startSec: 0,
      endSec: 10,
      durationSec: 10,
      ...sevenDimensions
    }]
  });

  assert.equal(normalized.sourceAssemblyMode, "mixed");
  assert.deepEqual(normalized.continuityPlan.groups, [{
    continuityGroupId: "cg_drama",
    storySegmentIndexes: [1, 2],
    globalAnchors: { protagonist: "same worker", scene: "same apartment" }
  }]);
  assert.deepEqual(normalized.storySegments[0], {
    ...normalized.storySegments[0],
    continuityGroupId: "cg_drama",
    continuityMode: "independent_slice",
    boundaryType: "continuity_group_start",
    startFrameState: { pose: "sitting" },
    endFrameState: { pose: "stands up" },
    continuityReferenceNeeded: false,
    globalContinuityAnchors: { protagonist: "same worker" }
  });
  assert.equal(normalized.seedanceSlices[0].continuityGroupId, "cg_drama");
  assert.equal(normalized.seedanceSlices[0].continuitySliceId, "cg_drama_slice_1");
});

test("compact decomposition prompt keeps downstream-required story segment contract", () => {
  const prompt = buildCompactDecompositionUserPrompt(
    { durationSec: 62 },
    { knowledgeNotes: "keep story beats" },
    { provider: "skylink", model: "gpt-5.4" },
    () => "mock probe prompt"
  );

  assert.match(prompt, /必须优先保证这 8 个字段/i);
  assert.match(prompt, /必须输出 storySegments/i);
  assert.match(prompt, /startSec、endSec、durationSec/);
  assert.match(prompt, /超过 15 秒时，必须给出 sliceSplitHints/i);
  assert.match(prompt, /seedanceSlices 可选/i);
  assert.match(prompt, /storySegments \+ sliceSplitHints 自动派生/);
  assert.match(prompt, /continuityPlan/);
  assert.match(prompt, /groups/);
  assert.match(prompt, /continuityGroupId/);
  assert.match(prompt, /storySegmentIndexes/);
  assert.match(prompt, /globalAnchors/);
  assert.match(prompt, /正反打|shot\/reverse-shot/i);
});

test("reference video decomposition validation preserves fission fields", () => {
  const normalized = validateVideoDecomposition("ref_test", {
    scene: "room",
    subject: "creator",
    action: "opens app",
    camera: "selfie",
    lighting: "warm",
    style: "UGC",
    quality: "clear",
    hook: "reward proof hook",
    sourceVideoProfile: { videoType: "creator proof demo", durationSec: 12 },
    wholeVideoConversion: { coreConversionTone: "urgent proof" },
    wholeVideoSummary: "Creator proves the reward before asking viewers to try.",
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 12,
        durationSec: 12,
        scene: "room",
        subject: "creator",
        action: "opens app",
        camera: "selfie",
        lighting: "warm",
        style: "UGC",
        quality: "clear",
        conversionEffectOpportunities: [{ effect: "coin_burst", placement: "phone tap" }]
      }
    ],
    seedanceSlices: [
      {
        storySegmentIndex: 1,
        seedanceSliceIndex: 1,
        startSec: 0,
        endSec: 12,
        durationSec: 12,
        scene: "room",
        subject: "creator",
        action: "opens app",
        camera: "selfie",
        lighting: "warm",
        style: "UGC",
        quality: "clear"
      }
    ]
  });

  assert.deepEqual(normalized.sourceVideoProfile, { videoType: "creator proof demo", durationSec: 12 });
  assert.equal(normalized.wholeVideoConversion.coreConversionTone, "urgent proof");
  assert.equal(normalized.wholeVideoSummary, "Creator proves the reward before asking viewers to try.");
  assert.equal(normalized.storySegments[0].conversionEffectOpportunities[0].effect, "coin_burst");
  assert.equal(normalized.seedanceSlices[0].durationSec, 12);
  assert.equal(normalized.seedanceSlices[0].scene, "room");
  assert.equal(normalized.scene, "room");
  assert.deepEqual(normalized.missingFields, []);
});

test("reference video decomposition backfills required fields from storySegments", () => {
  const normalized = validateVideoDecomposition("ref_backfill", {
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 10,
        durationSec: 10,
        scene: "kitchen",
        subject: "delivery rider",
        action: "0-3s: opens app",
        camera: "phone close-up",
        lighting: "indoor warm",
        style: "UGC selfie",
        quality: "clear UI",
        coreHook: "cashout proof in first seconds"
      }
    ]
  });

  assert.equal(normalized.scene, "kitchen");
  assert.equal(normalized.subject, "delivery rider");
  assert.equal(normalized.action, "0-3s: opens app");
  assert.equal(normalized.camera, "phone close-up");
  assert.equal(normalized.lighting, "indoor warm");
  assert.equal(normalized.style, "UGC selfie");
  assert.equal(normalized.quality, "clear UI");
  assert.equal(normalized.hook, "cashout proof in first seconds");
  assert.deepEqual(normalized.missingFields, []);
});

test("reference video decomposition derives seedanceSlices from timed storySegments", () => {
  const normalized = validateVideoDecomposition("ref_derive_slices", {
    storySegments: [
      {
        storySegmentIndex: 1,
        startSec: 0,
        endSec: 12,
        durationSec: 12,
        scene: "kitchen",
        subject: "delivery rider",
        action: "0-12s: opens app and reacts",
        camera: "phone close-up",
        lighting: "indoor warm",
        style: "UGC selfie",
        quality: "clear UI",
        coreHook: "cashout proof in first seconds"
      }
    ]
  });

  assert.equal(normalized.storySegments.length, 1);
  assert.equal(normalized.seedanceSlices.length, 1);
  assert.equal(normalized.seedanceSlices[0].startSec, 0);
  assert.equal(normalized.seedanceSlices[0].endSec, 12);
  assert.equal(normalized.seedanceSlices[0].sliceDurationSec, 12);
  assert.deepEqual(normalized.missingFields, []);
});
