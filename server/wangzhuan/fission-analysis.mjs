const SEVEN_DIMENSION_FIELDS = [
  "scene",
  "subject",
  "action",
  "camera",
  "lighting",
  "style",
  "quality"
];

export const FISSION_ANALYSIS_PROMPT_REQUIREMENTS = Object.freeze([
  "Analyze the whole video first before splitting into story segments.",
  "Split by real narrative story beats only; avoid no-oversegmentation drift.",
  "Do not create a new story segment only because the video cuts to app UI, reward animation, cash/coin effect, subtitle card, title card, withdrawal visual, or CTA overlay.",
  "Keep app UI, subtitle overlays, withdrawal screens, reward effects, cash/coin feedback, sound cues, and CTA overlays inside timelineItems unless they change the narrative beat.",
  "Every storySegment must include numeric startSec, endSec, and durationSec in source-video seconds; never omit timing and never default every segment to 0-15s.",
  "Every story segment must include scene, subject, action, camera, lighting, style, quality, coreHook, explosivePoint, segmentPurpose, segmentConversionStyle, segmentRhythm, segmentStructureSkeleton, timelineItems, conversionSignals, conversionEffectOpportunities, voiceoverObserved, variableLayers, and sliceSplitHints.",
  "Output seedanceSlices as executable generation slices in source-video order; each seedanceSlice must include numeric startSec, endSec, durationSec, and sliceDurationSec. Keep every generated slice between 5 and 15 seconds, splitting longer story beats by narrative turning points.",
  "Observed conversionSignals must distinguish withdrawalSuccess, earningsNumber, emotionalVoiceover, cashCoinFeedback, and fastRewardCue.",
  "conversionEffectOpportunities are allowed fission placements; keep them separate from observed conversionSignals.",
  "Classify sourceAssemblyMode as continuous_story, independent_segments, or mixed; scene cuts alone do not prove independence.",
  "Output continuityPlan.groups independently from storySegments. Each group must list continuityGroupId, storySegmentIndexes, and globalAnchors for identity, wardrobe, scene, product/UI, camera, voice, and audio continuity.",
  "Each continuous story segment or Seedance slice must preserve continuityGroupId, continuityMode, boundaryType, startFrameState, endFrameState, continuityReferenceNeeded, and globalContinuityAnchors.",
  "Seedance prompts must use no burned subtitles, no captions, and no dense text blocks; subtitle text belongs in subtitleWorkflow.subtitleScript."
]);

function cleanString(value, fallback = "") {
  if (typeof value === "string") {
    return value.trim();
  }
  if (value == null) {
    return fallback;
  }
  return String(value).trim();
}

function numberOrFallback(value, fallback = 0) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function roundSec(value) {
  return Math.round(numberOrFallback(value) * 1000) / 1000;
}

function normalizeStructuredList(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === "object") {
          return item;
        }
        return cleanString(item);
      })
      .filter(Boolean);
  }
  if (value && typeof value === "object") {
    return value;
  }
  const cleaned = cleanString(value);
  return cleaned ? [cleaned] : [];
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => cleanString(item)).filter(Boolean);
  }
  const cleaned = cleanString(value);
  return cleaned ? [cleaned] : [];
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeStructuredValue(value) {
  if (value && typeof value === "object") return value;
  return cleanString(value);
}

function normalizeContinuityFields(value = {}) {
  const fields = {};
  for (const field of [
    "continuityGroupId",
    "continuitySliceId",
    "previousSliceId",
    "continuityMode",
    "boundaryType"
  ]) {
    if (Object.hasOwn(value || {}, field)) fields[field] = cleanString(value[field]);
  }
  if (Object.hasOwn(value || {}, "continuitySequence")) {
    fields.continuitySequence = numberOrFallback(value.continuitySequence, 0);
  }
  for (const field of ["startFrameState", "endFrameState", "globalContinuityAnchors"]) {
    if (Object.hasOwn(value || {}, field)) fields[field] = normalizeStructuredValue(value[field]);
  }
  if (Object.hasOwn(value || {}, "continuityReferenceNeeded")) {
    fields.continuityReferenceNeeded = normalizeBooleanLike(value.continuityReferenceNeeded, false);
  }
  return fields;
}

function normalizeContinuityPlan(value) {
  const input = normalizeObject(value);
  const groups = normalizeArray(input.groups).map((group) => ({
    continuityGroupId: cleanString(group?.continuityGroupId),
    storySegmentIndexes: normalizeArray(group?.storySegmentIndexes)
      .map((index) => numberOrFallback(index, 0))
      .filter((index) => index > 0),
    globalAnchors: normalizeStructuredValue(group?.globalAnchors)
  })).filter((group) => group.continuityGroupId);
  return { groups };
}

function continuityGroupForStorySegment(continuityPlan, storySegmentIndex) {
  return continuityPlan.groups.find((group) => group.storySegmentIndexes.includes(storySegmentIndex));
}

function applyContinuityPlanToStorySegments(storySegments, continuityPlan) {
  return storySegments.map((segment) => {
    const group = continuityGroupForStorySegment(continuityPlan, segment.storySegmentIndex);
    if (!group) return segment;
    return {
      ...segment,
      continuityGroupId: segment.continuityGroupId || group.continuityGroupId,
      globalContinuityAnchors: Object.hasOwn(segment, "globalContinuityAnchors")
        ? segment.globalContinuityAnchors
        : group.globalAnchors
    };
  });
}

function inheritStoryContinuity(slice, storySegments) {
  const segment = storySegments.find((item) => item.storySegmentIndex === slice.storySegmentIndex);
  if (!segment) return slice;
  const inherited = normalizeContinuityFields(segment);
  return {
    ...inherited,
    ...slice,
    ...(Object.hasOwn(slice, "globalContinuityAnchors")
      ? {}
      : Object.hasOwn(inherited, "globalContinuityAnchors")
        ? { globalContinuityAnchors: inherited.globalContinuityAnchors }
        : {})
  };
}

function linkContinuitySlices(slices, storySegments, continuityPlan, enabled) {
  if (!enabled) return slices;
  const linked = slices.map((slice, index) => ({
    ...inheritStoryContinuity(slice, storySegments),
    seedanceSliceIndex: index + 1
  }));
  const groupSequences = new Map();

  for (const slice of linked) {
    const groupId = cleanString(slice.continuityGroupId);
    if (!groupId) continue;
    const group = continuityPlan.groups.find((item) => item.continuityGroupId === groupId);
    const sequence = (groupSequences.get(groupId)?.length || 0) + 1;
    const continuitySliceId = cleanString(slice.continuitySliceId) || `${groupId}_slice_${sequence}`;
    const prior = groupSequences.get(groupId)?.at(-1);
    slice.continuityGroupId = groupId;
    slice.continuitySliceId = continuitySliceId;
    slice.continuitySequence = sequence;
    slice.previousSliceId = prior?.continuitySliceId || "";
    slice.continuityMode = prior ? "continuous_from_previous" : "independent_slice";
    slice.boundaryType = prior
      ? "continuity_handoff"
      : cleanString(slice.boundaryType) || "continuity_group_start";
    slice.continuityReferenceNeeded = Boolean(prior);
    if (!Object.hasOwn(slice, "globalContinuityAnchors") && group) {
      slice.globalContinuityAnchors = group.globalAnchors;
    }
    const existing = groupSequences.get(groupId) || [];
    existing.push(slice);
    groupSequences.set(groupId, existing);
  }
  return linked;
}

function hasSevenDimensions(input) {
  return input && SEVEN_DIMENSION_FIELDS.every((field) => Object.hasOwn(input, field));
}

function copySevenDimensions(input) {
  return Object.fromEntries(SEVEN_DIMENSION_FIELDS.map((field) => [field, cleanString(input?.[field])]));
}

function normalizeBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  const normalized = cleanString(value).toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (["false", "0", "no", "n", "off", "否", "不", "不是"].includes(normalized)) {
    return false;
  }
  if (["true", "1", "yes", "y", "on", "是", "对", "好的"].includes(normalized)) {
    return true;
  }
  return fallback;
}

function normalizeSubtitleWorkflow(slice) {
  const mode = cleanString(slice?.subtitleWorkflow).toLowerCase();
  const supplied = normalizeObject(slice?.subtitleWorkflow);
  const hasSubtitles = Object.hasOwn(slice || {}, "subtitles");
  const isDisabledMode = ["none", "no_post_process", "off"].includes(mode);
  const postSubtitleRequired = isDisabledMode
    ? false
    : Object.hasOwn(supplied, "postSubtitleRequired")
      ? normalizeBooleanLike(supplied.postSubtitleRequired, true)
      : true;
  const subtitleScript = postSubtitleRequired
    ? normalizeStringList(Object.hasOwn(supplied, "subtitleScript")
        ? supplied.subtitleScript
        : hasSubtitles ? slice.subtitles : [])
    : [];

  return {
    burnedInSubtitles: Object.hasOwn(supplied, "burnedInSubtitles")
      ? normalizeBooleanLike(supplied.burnedInSubtitles, false)
      : false,
    postSubtitleRequired,
    provider: cleanString(supplied.provider, "pixel_tech") || "pixel_tech",
    subtitleScript
  };
}

function assertValidTimeRange({ startSec, endSec, durationSec, label }) {
  if (endSec <= startSec || durationSec <= 0) {
    throw new Error(`${label} time range is invalid`);
  }
}

function normalizeStorySegment(segment, index = 0, options = {}) {
  if (options.strictTiming) {
    for (const field of ["startSec", "endSec", "durationSec"]) {
      if (segment?.[field] === undefined || segment?.[field] === null || segment?.[field] === "") {
        const storySegmentIndex = numberOrFallback(segment?.storySegmentIndex, index + 1);
        throw new Error(`storySegmentIndex=${storySegmentIndex} ${field} is required`);
      }
    }
  }
  const startSec = roundSec(numberOrFallback(segment?.startSec, 0));
  const fallbackDuration = numberOrFallback(options.durationSec, numberOrFallback(segment?.durationSec, 15));
  const endSec = roundSec(numberOrFallback(segment?.endSec, startSec + fallbackDuration));
  const durationSec = roundSec(numberOrFallback(segment?.durationSec, endSec - startSec));
  const storySegmentIndex = numberOrFallback(segment?.storySegmentIndex, index + 1);

  assertValidTimeRange({
    startSec,
    endSec,
    durationSec,
    label: `storySegmentIndex=${storySegmentIndex}`
  });

  return {
    storySegmentIndex,
    startSec,
    endSec,
    durationSec,
    ...(segment?.segmentRole ? { segmentRole: cleanString(segment.segmentRole) } : {}),
    ...copySevenDimensions(segment),
    coreHook: cleanString(segment?.coreHook),
    explosivePoint: cleanString(segment?.explosivePoint),
    segmentPurpose: cleanString(segment?.segmentPurpose),
    segmentConversionStyle: cleanString(segment?.segmentConversionStyle),
    segmentRhythm: cleanString(segment?.segmentRhythm),
    segmentStructureSkeleton: cleanString(segment?.segmentStructureSkeleton),
    ...normalizeContinuityFields(segment),
    timelineItems: normalizeArray(segment?.timelineItems),
    conversionSignals: normalizeStructuredList(segment?.conversionSignals),
    conversionEffectOpportunities: normalizeStructuredList(segment?.conversionEffectOpportunities),
    voiceoverObserved: normalizeStructuredList(segment?.voiceoverObserved),
    variableLayers: normalizeStructuredList(segment?.variableLayers),
    sliceSplitHints: normalizeArray(segment?.sliceSplitHints),
    ...(Object.hasOwn(segment || {}, "subtitles") ? { subtitles: segment.subtitles } : {}),
    ...(Object.hasOwn(segment || {}, "subtitleWorkflow") ? { subtitleWorkflow: normalizeSubtitleWorkflow(segment) } : {})
  };
}

function normalizeSeedanceSlice(slice, index = 0) {
  const startSec = roundSec(numberOrFallback(slice?.startSec, 0));
  const endSec = roundSec(numberOrFallback(slice?.endSec, startSec + numberOrFallback(slice?.durationSec, 0)));
  const durationSec = roundSec(numberOrFallback(slice?.durationSec, endSec - startSec));
  const sliceDurationSec = roundSec(numberOrFallback(slice?.sliceDurationSec, durationSec));
  const seedanceSliceIndex = numberOrFallback(slice?.seedanceSliceIndex, index + 1);

  assertValidTimeRange({
    startSec,
    endSec,
    durationSec,
    label: `seedanceSliceIndex=${seedanceSliceIndex}`
  });

  return {
    storySegmentIndex: numberOrFallback(slice?.storySegmentIndex, 1),
    seedanceSliceIndex,
    startSec,
    endSec,
    durationSec,
    sliceDurationSec,
    ...(slice?.segmentRole ? { segmentRole: cleanString(slice.segmentRole) } : {}),
    ...copySevenDimensions(slice),
    coreHook: cleanString(slice?.coreHook),
    explosivePoint: cleanString(slice?.explosivePoint),
    ...normalizeContinuityFields(slice),
    conversionSignals: normalizeStructuredList(slice?.conversionSignals),
    conversionEffectOpportunities: normalizeStructuredList(slice?.conversionEffectOpportunities),
    voiceoverObserved: normalizeStructuredList(slice?.voiceoverObserved),
    variableLayers: normalizeStructuredList(slice?.variableLayers),
    timelineItems: normalizeArray(slice?.timelineItems),
    ...(Object.hasOwn(slice || {}, "subtitles") ? { subtitles: slice.subtitles } : {}),
    subtitleWorkflow: normalizeSubtitleWorkflow(slice),
    ...(slice?.sliceSplitReason ? { sliceSplitReason: cleanString(slice.sliceSplitReason) } : {})
  };
}

function assertSupportedSeedanceSliceDuration(slice, { minSliceSec = 5, maxSliceSec = 15 } = {}) {
  const sliceDurationSec = numberOrFallback(slice?.sliceDurationSec || slice?.durationSec, 0);
  if (sliceDurationSec < minSliceSec || sliceDurationSec > maxSliceSec) {
    throw new Error(`seedanceSliceIndex=${slice?.seedanceSliceIndex || ""} duration must be ${minSliceSec}-${maxSliceSec}s`);
  }
}

function assertChronologicalStorySegments(storySegments = []) {
  let previousEndSec = -1;
  for (const segment of storySegments) {
    const startSec = numberOrFallback(segment?.startSec, 0);
    if (startSec < previousEndSec) {
      throw new Error("storySegments time ranges must be chronological and non-overlapping");
    }
    previousEndSec = numberOrFallback(segment?.endSec, previousEndSec);
  }
}

function buildFallbackStorySegment(input, options = {}) {
  const durationSec = roundSec(numberOrFallback(options.durationSec, numberOrFallback(input?.durationSec, 15)));
  return normalizeStorySegment({
    storySegmentIndex: 1,
    startSec: 0,
    endSec: durationSec,
    durationSec,
    ...copySevenDimensions(input),
    timelineItems: [],
    conversionSignals: [],
    conversionEffectOpportunities: [],
    voiceoverObserved: [],
    variableLayers: [],
    sliceSplitHints: []
  }, 0, { durationSec });
}

function normalizeSourceVideoProfile(value) {
  return normalizeObject(value);
}

function normalizeWholeVideoConversion(value) {
  return normalizeObject(value);
}

function buildGeneratedSlice(segment, startSec, endSec, seedanceSliceIndex, sliceSplitReason = "") {
  const durationSec = roundSec(endSec - startSec);
  return normalizeSeedanceSlice({
    storySegmentIndex: segment.storySegmentIndex,
    seedanceSliceIndex,
    startSec,
    endSec,
    durationSec,
    sliceDurationSec: durationSec,
    ...(segment.segmentRole ? { segmentRole: segment.segmentRole } : {}),
    ...copySevenDimensions(segment),
    coreHook: segment.coreHook,
    explosivePoint: segment.explosivePoint,
    ...normalizeContinuityFields(segment),
    conversionSignals: segment.conversionSignals,
    conversionEffectOpportunities: segment.conversionEffectOpportunities,
    voiceoverObserved: segment.voiceoverObserved,
    variableLayers: segment.variableLayers,
    timelineItems: segment.timelineItems,
    ...(Object.hasOwn(segment, "subtitles") ? { subtitles: segment.subtitles } : {}),
    ...(Object.hasOwn(segment, "subtitleWorkflow") ? { subtitleWorkflow: segment.subtitleWorkflow } : {}),
    ...(sliceSplitReason ? { sliceSplitReason } : {})
  }, seedanceSliceIndex - 1);
}

function validSplit(splitSec, segment, minSliceSec, maxSliceSec) {
  const leftDuration = roundSec(splitSec - segment.startSec);
  const rightDuration = roundSec(segment.endSec - splitSec);
  return leftDuration >= minSliceSec
    && leftDuration <= maxSliceSec
    && rightDuration >= minSliceSec
    && rightDuration <= maxSliceSec;
}

function hintSplitSec(hint, segment) {
  const rawSplitSec = numberOrFallback(hint?.splitSec, Number.NaN);
  if (!Number.isFinite(rawSplitSec)) {
    return Number.NaN;
  }
  if (rawSplitSec > segment.startSec && rawSplitSec < segment.endSec) {
    return roundSec(rawSplitSec);
  }
  const relativeSplitSec = roundSec(segment.startSec + rawSplitSec);
  return relativeSplitSec > segment.startSec && relativeSplitSec < segment.endSec ? relativeSplitSec : Number.NaN;
}

function fallbackSplitSec(segment, minSliceSec, maxSliceSec) {
  const midpoint = roundSec(segment.startSec + segment.durationSec / 2);
  const minSplit = roundSec(segment.startSec + minSliceSec);
  const maxSplit = roundSec(segment.endSec - minSliceSec);
  const clamped = Math.min(Math.max(midpoint, minSplit), maxSplit);
  if (validSplit(clamped, segment, minSliceSec, maxSliceSec)) {
    return roundSec(clamped);
  }
  return Number.NaN;
}

function chooseSliceCount(durationSec, minSliceSec, maxSliceSec) {
  const minCount = Math.max(2, Math.ceil(durationSec / maxSliceSec));
  const maxCount = Math.max(minCount, Math.floor(durationSec / minSliceSec));
  for (let count = minCount; count <= maxCount; count += 1) {
    const average = durationSec / count;
    if (average >= minSliceSec && average <= maxSliceSec) {
      return count;
    }
  }
  return 0;
}

function normalizeSplitHints(segment) {
  return normalizedArray(segment.sliceSplitHints)
    .map((hint) => ({
      splitSec: hintSplitSec(hint, segment),
      reason: cleanString(hint?.reason || hint?.sliceSplitReason)
    }))
    .filter((hint) => Number.isFinite(hint.splitSec))
    .sort((left, right) => left.splitSec - right.splitSec);
}

function normalizedArray(value) {
  return Array.isArray(value) ? value : [];
}

function allocateSliceBoundaries(segment, sliceCount, minSliceSec, maxSliceSec, hints = []) {
  const boundaries = [segment.startSec];
  const totalDuration = segment.durationSec;
  const usedHints = [];
  let cursor = segment.startSec;
  let remainingSlices = sliceCount;
  let hintIndex = 0;

  for (let boundaryIndex = 1; boundaryIndex < sliceCount; boundaryIndex += 1) {
    const remainingAfterCurrent = remainingSlices - 1;
    const minBoundary = Math.max(
      roundSec(cursor + minSliceSec),
      roundSec(segment.endSec - remainingAfterCurrent * maxSliceSec)
    );
    const maxBoundary = Math.min(
      roundSec(cursor + maxSliceSec),
      roundSec(segment.endSec - remainingAfterCurrent * minSliceSec)
    );
    if (minBoundary > maxBoundary) {
      return null;
    }

    const targetBoundary = roundSec(segment.startSec + (totalDuration * boundaryIndex) / sliceCount);
    let chosenBoundary = Number.NaN;
    let chosenReason = "";

    while (hintIndex < hints.length && hints[hintIndex].splitSec <= cursor) {
      hintIndex += 1;
    }
    for (let scanIndex = hintIndex; scanIndex < hints.length; scanIndex += 1) {
      const hint = hints[scanIndex];
      if (hint.splitSec < minBoundary) continue;
      if (hint.splitSec > maxBoundary) break;
      if (!Number.isFinite(chosenBoundary)
        || Math.abs(hint.splitSec - targetBoundary) < Math.abs(chosenBoundary - targetBoundary)) {
        chosenBoundary = hint.splitSec;
        chosenReason = hint.reason;
        hintIndex = scanIndex + 1;
      }
    }

    if (!Number.isFinite(chosenBoundary)) {
      chosenBoundary = roundSec(Math.min(Math.max(targetBoundary, minBoundary), maxBoundary));
    }
    boundaries.push(chosenBoundary);
    if (chosenReason) usedHints.push(chosenReason);
    cursor = chosenBoundary;
    remainingSlices -= 1;
  }

  boundaries.push(segment.endSec);
  return { boundaries, usedHints };
}

function summarizeSliceSplitReason(sliceCount, usedHints = []) {
  const reasons = usedHints.filter(Boolean);
  if (reasons.length === 1 && sliceCount === 2) {
    return reasons[0];
  }
  if (reasons.length > 0) {
    return `hint-guided multi-slice split: ${reasons.join(" | ")}`;
  }
  return "even duration fallback split";
}

export function normalizeFissionAnalysis(input = {}, options = {}) {
  const strictStorySegmentTiming = Boolean(options.strictStorySegmentTiming);
  const continuityPlan = normalizeContinuityPlan(input?.continuityPlan);
  const normalizedStorySegments = Array.isArray(input?.storySegments)
    ? input.storySegments.map((segment, index) => normalizeStorySegment(segment, index, {
        strictTiming: strictStorySegmentTiming
      }))
    : [];
  const storySegments = applyContinuityPlanToStorySegments(normalizedStorySegments, continuityPlan);
  if (strictStorySegmentTiming) {
    assertChronologicalStorySegments(storySegments);
  }
  const fallbackStorySegments = storySegments.length === 0 && hasSevenDimensions(input)
    ? [buildFallbackStorySegment(input, options)]
    : storySegments;
  let seedanceSlices = [];
  if (Array.isArray(input?.seedanceSlices)) {
    try {
      seedanceSlices = input.seedanceSlices.map((slice, index) => normalizeSeedanceSlice(slice, index));
      for (const slice of seedanceSlices) {
        assertSupportedSeedanceSliceDuration(slice, options);
      }
    } catch (error) {
      if (fallbackStorySegments.length === 0) {
        throw error;
      }
      seedanceSlices = [];
    }
  }
  if (!seedanceSlices.length && options.deriveSeedanceSlices && fallbackStorySegments.length) {
    seedanceSlices = fallbackStorySegments.flatMap((segment) => splitStorySegmentIntoSeedanceSlices(segment, options));
  }

  const sourceAssemblyMode = cleanString(input?.sourceAssemblyMode);
  const hasContinuityContract = Boolean(sourceAssemblyMode
    || continuityPlan.groups.length
    || fallbackStorySegments.some((segment) => segment.continuityGroupId)
    || seedanceSlices.some((slice) => slice.continuityGroupId));
  seedanceSlices = linkContinuitySlices(
    seedanceSlices,
    fallbackStorySegments,
    continuityPlan,
    hasContinuityContract
  );

  return {
    sourceVideoProfile: normalizeSourceVideoProfile(input?.sourceVideoProfile),
    wholeVideoConversion: normalizeWholeVideoConversion(input?.wholeVideoConversion),
    wholeVideoSummary: cleanString(input?.wholeVideoSummary),
    ...(sourceAssemblyMode ? { sourceAssemblyMode } : {}),
    ...(continuityPlan.groups.length ? { continuityPlan } : {}),
    storySegments: fallbackStorySegments,
    seedanceSlices
  };
}

export function splitStorySegmentIntoSeedanceSlices(segment, { minSliceSec = 5, maxSliceSec = 15 } = {}) {
  const normalized = normalizeStorySegment(segment);
  if (normalized.durationSec < minSliceSec) {
    throw new Error(`storySegmentIndex=${normalized.storySegmentIndex} duration must be ${minSliceSec}-${maxSliceSec}s`);
  }
  if (normalized.durationSec <= maxSliceSec) {
    return [buildGeneratedSlice(normalized, normalized.startSec, normalized.endSec, 1)];
  }

  const sliceCount = chooseSliceCount(normalized.durationSec, minSliceSec, maxSliceSec);
  if (!sliceCount) {
    throw new Error(`storySegmentIndex=${normalized.storySegmentIndex} duration exceeds supported Seedance slice split`);
  }
  const splitPlan = allocateSliceBoundaries(
    normalized,
    sliceCount,
    minSliceSec,
    maxSliceSec,
    normalizeSplitHints(normalized)
  );
  if (!splitPlan) {
    throw new Error(`storySegmentIndex=${normalized.storySegmentIndex} duration exceeds supported Seedance slice split`);
  }

  const sliceSplitReason = summarizeSliceSplitReason(sliceCount, splitPlan.usedHints);
  const slices = [];
  for (let index = 0; index < splitPlan.boundaries.length - 1; index += 1) {
    slices.push(buildGeneratedSlice(
      normalized,
      splitPlan.boundaries[index],
      splitPlan.boundaries[index + 1],
      index + 1,
      sliceSplitReason
    ));
  }
  return slices;
}

export function buildSeedanceSlicesFromAnalysis(analysis, options = {}) {
  const normalized = normalizeFissionAnalysis(analysis, options);
  if (normalized.seedanceSlices.length > 0) {
    return normalized.seedanceSlices;
  }

  return linkContinuitySlices(
    normalized.storySegments.flatMap((segment) => splitStorySegmentIntoSeedanceSlices(segment, options)),
    normalized.storySegments,
    normalized.continuityPlan || { groups: [] },
    Boolean(normalized.sourceAssemblyMode || normalized.continuityPlan
      || normalized.storySegments.some((segment) => segment.continuityGroupId))
  );
}

export function deriveSeedanceSlicesForGeneration(analysis, options = {}) {
  const normalized = normalizeFissionAnalysis(analysis, {
    ...options,
    deriveSeedanceSlices: false
  });
  if (normalized.seedanceSlices.length > 0) {
    return normalized.seedanceSlices;
  }
  return linkContinuitySlices(
    normalized.storySegments.flatMap((segment) => splitStorySegmentIntoSeedanceSlices(segment, options)),
    normalized.storySegments,
    normalized.continuityPlan || { groups: [] },
    Boolean(normalized.sourceAssemblyMode || normalized.continuityPlan
      || normalized.storySegments.some((segment) => segment.continuityGroupId))
  );
}
