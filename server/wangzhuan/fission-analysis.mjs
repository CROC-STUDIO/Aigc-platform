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
  "Every story segment must include scene, subject, action, camera, lighting, style, quality, coreHook, explosivePoint, segmentPurpose, segmentConversionStyle, segmentRhythm, segmentStructureSkeleton, timelineItems, conversionSignals, conversionEffectOpportunities, voiceoverObserved, variableLayers, and sliceSplitHints.",
  "Observed conversionSignals must distinguish withdrawalSuccess, earningsNumber, emotionalVoiceover, cashCoinFeedback, and fastRewardCue.",
  "conversionEffectOpportunities are allowed fission placements; keep them separate from observed conversionSignals.",
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

export function normalizeFissionAnalysis(input = {}, options = {}) {
  const storySegments = Array.isArray(input?.storySegments)
    ? input.storySegments.map((segment, index) => normalizeStorySegment(segment, index))
    : [];
  const fallbackStorySegments = storySegments.length === 0 && hasSevenDimensions(input)
    ? [buildFallbackStorySegment(input, options)]
    : storySegments;
  let seedanceSlices = [];
  if (Array.isArray(input?.seedanceSlices)) {
    try {
      seedanceSlices = input.seedanceSlices.map((slice, index) => normalizeSeedanceSlice(slice, index));
    } catch (error) {
      if (fallbackStorySegments.length === 0) {
        throw error;
      }
      seedanceSlices = [];
    }
  }

  return {
    sourceVideoProfile: normalizeSourceVideoProfile(input?.sourceVideoProfile),
    wholeVideoConversion: normalizeWholeVideoConversion(input?.wholeVideoConversion),
    wholeVideoSummary: cleanString(input?.wholeVideoSummary),
    storySegments: fallbackStorySegments,
    seedanceSlices
  };
}

export function splitStorySegmentIntoSeedanceSlices(segment, { minSliceSec = 8, maxSliceSec = 15 } = {}) {
  const normalized = normalizeStorySegment(segment);
  if (normalized.durationSec <= maxSliceSec) {
    return [buildGeneratedSlice(normalized, normalized.startSec, normalized.endSec, 1)];
  }

  const hintedSplit = normalized.sliceSplitHints
    .map((hint) => ({
      splitSec: hintSplitSec(hint, normalized),
      reason: cleanString(hint?.reason || hint?.sliceSplitReason)
    }))
    .find((hint) => validSplit(hint.splitSec, normalized, minSliceSec, maxSliceSec));
  const splitSec = hintedSplit?.splitSec ?? fallbackSplitSec(normalized, minSliceSec, maxSliceSec);
  if (!Number.isFinite(splitSec) || !validSplit(splitSec, normalized, minSliceSec, maxSliceSec)) {
    throw new Error(`storySegmentIndex=${normalized.storySegmentIndex} duration exceeds supported Seedance slice split`);
  }

  const sliceSplitReason = hintedSplit?.reason || "even duration fallback split";
  return [
    buildGeneratedSlice(normalized, normalized.startSec, splitSec, 1, sliceSplitReason),
    buildGeneratedSlice(normalized, splitSec, normalized.endSec, 2, sliceSplitReason)
  ];
}

export function buildSeedanceSlicesFromAnalysis(analysis, options = {}) {
  const normalized = normalizeFissionAnalysis(analysis, options);
  if (normalized.seedanceSlices.length > 0) {
    return normalized.seedanceSlices;
  }

  return normalized.storySegments.flatMap((segment) => splitStorySegmentIntoSeedanceSlices(segment, options));
}
