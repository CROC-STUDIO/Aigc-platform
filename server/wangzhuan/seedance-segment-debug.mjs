import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

import { loadRuntimeConfig } from "../runtime-config.mjs";
import { resolveLlmConfig } from "./llm-config.mjs";
import {
  buildSceneAwareFrameTimestamps,
  callOpenAiCompatibleLlm,
  detectReferenceVideoScenes,
  extractReferenceFrames,
  parseLlmJsonContent
} from "./reference-videos.mjs";

const execFileAsync = promisify(execFile);

const SEVEN_DIMENSIONS = Object.freeze([
  "scene",
  "subject",
  "action",
  "camera",
  "lighting",
  "style",
  "quality"
]);

const CONVERSION_SIGNAL_KEYS = Object.freeze([
  "withdrawalSuccess",
  "earningsNumber",
  "emotionalVoiceover",
  "cashCoinFeedback",
  "fastRewardCue"
]);

const EXACT_MONEY_CLAIM_REGEX = /(?:R\$|[$€£¥]|\b(?:USD|BRL|MXN)\b)\s*\d(?:[\d.,]*\d)?|\d(?:[\d.,]*\d)?\s*(?:R\$|[$€£¥]|\b(?:USD|BRL|MXN)\b)/iu;

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrFallback(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function roundSec(value) {
  return Math.round(numberOrFallback(value, 0) * 100) / 100;
}

function requireValue(value, message) {
  const text = cleanString(value);
  if (!text) throw new Error(message);
  return text;
}

function resolvePathUnderCwd(cwd, value, label, { allowOutsideWorkspace = false } = {}) {
  const resolvedPath = resolve(cwd, value);
  if (allowOutsideWorkspace) return resolvedPath;

  const realCwd = realpathSync(cwd);
  const targetRealPath = label === "--out"
    ? realpathSync(nearestExistingParent(resolvedPath))
    : realpathSync(resolvedPath);

  if (isPathInside(targetRealPath, realCwd)) {
    return resolvedPath;
  }

  throw new Error(`${label} 必须位于当前工作目录内`);
}

function nearestExistingParent(targetPath) {
  let currentPath = targetPath;
  while (!existsSync(currentPath)) {
    const parentPath = dirname(currentPath);
    if (parentPath === currentPath) return currentPath;
    currentPath = parentPath;
  }
  return currentPath;
}

function isPathInside(targetPath, rootPath) {
  const relativePath = relative(rootPath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
}

export function parseDebugCliArgs(
  argv = process.argv.slice(2),
  { cwd = process.cwd(), now = new Date(), allowOutsideWorkspace = false } = {}
) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) throw new Error(`未知参数：${token}`);
    const key = token.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`参数 --${key} 缺少值`);
    values[key] = next;
    index += 1;
  }

  const video = requireValue(values.video, "--video 必填");
  const output = cleanString(values.out) || `tmp/seedance-segment-debug/${now.toISOString().replace(/[:.]/g, "-")}`;
  const truthRulesJson = cleanString(values["truth-rules-json"]);
  return {
    videoPath: resolve(cwd, video),
    outputDir: resolvePathUnderCwd(cwd, output, "--out", { allowOutsideWorkspace }),
    language: cleanString(values.language) || "pt-BR",
    region: cleanString(values.region) || "BR",
    productName: cleanString(values["product-name"]) || "Product",
    currencySymbol: cleanString(values["currency-symbol"]),
    truthRulesPath: truthRulesJson
      ? resolvePathUnderCwd(cwd, truthRulesJson, "--truth-rules-json", { allowOutsideWorkspace })
      : "",
    minSliceSec: Math.max(1, Math.round(numberOrFallback(values["min-slice-sec"], 8))),
    maxSliceSec: Math.max(1, Math.round(numberOrFallback(values["max-slice-sec"], 15)))
  };
}

export function splitStorySegmentIntoSlices(segment = {}, options = {}) {
  const minSliceSec = Math.max(1, Math.round(numberOrFallback(options.minSliceSec, 8)));
  const maxSliceSec = Math.max(minSliceSec, Math.round(numberOrFallback(options.maxSliceSec, 15)));
  const startSec = roundSec(segment.startSec);
  const durationSec = roundSec(segment.durationSec || (numberOrFallback(segment.endSec, 0) - startSec));
  const endSec = roundSec(segment.endSec || (startSec + durationSec));
  const storySegmentIndex = Math.max(1, Math.round(numberOrFallback(segment.storySegmentIndex, 1)));

  if (durationSec > maxSliceSec * 2) {
    throw new Error(`storySegmentIndex=${storySegmentIndex} 时长超过两段 Seedance slice 上限`);
  }

  if (durationSec <= maxSliceSec) {
    return [{
      storySegmentIndex,
      seedanceSliceIndex: 1,
      startSec,
      endSec,
      durationSec: roundSec(endSec - startSec)
    }];
  }

  const [splitHint] = validSliceSplitHints({ ...segment, startSec, endSec }, minSliceSec, maxSliceSec);
  const firstEndSec = splitHint?.splitSec
    || roundSec(startSec + Math.max(minSliceSec, Math.min(maxSliceSec, Math.round(durationSec / 2))));
  return [
    {
      storySegmentIndex,
      seedanceSliceIndex: 1,
      startSec,
      endSec: firstEndSec,
      durationSec: roundSec(firstEndSec - startSec),
      ...(splitHint?.reason ? { sliceSplitReason: splitHint.reason } : {})
    },
    {
      storySegmentIndex,
      seedanceSliceIndex: 2,
      startSec: firstEndSec,
      endSec,
      durationSec: roundSec(endSec - firstEndSec),
      ...(splitHint?.reason ? { sliceSplitReason: splitHint.reason } : {})
    }
  ];
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => cleanString(item)).filter(Boolean);
  const text = cleanString(value);
  return text ? [text] : [];
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function normalizeConversionSignals(value) {
  const source = value && typeof value === "object" ? value : {};
  const result = {};
  for (const key of CONVERSION_SIGNAL_KEYS) {
    const signal = source[key] && typeof source[key] === "object" ? source[key] : {};
    result[key] = {
      present: normalizeBoolean(signal.present),
      timestampSec: Number.isFinite(Number(signal.timestampSec)) ? roundSec(signal.timestampSec) : null,
      evidence: cleanString(signal.evidence),
      roleInVideo: cleanString(signal.roleInVideo),
      shouldReplicate: normalizeBoolean(signal.shouldReplicate)
    };
  }
  return result;
}

function signalMoneyEffects(conversionSignals = {}) {
  const effects = [];
  if (conversionSignals.earningsNumber?.present && conversionSignals.earningsNumber?.shouldReplicate) {
    effects.push("reward_number_growth");
  }
  if (conversionSignals.cashCoinFeedback?.present && conversionSignals.cashCoinFeedback?.shouldReplicate) {
    effects.push("coin_burst", "cash_rain");
  }
  if (conversionSignals.withdrawalSuccess?.present && conversionSignals.withdrawalSuccess?.shouldReplicate) {
    effects.push("withdrawal_success");
  }
  if (conversionSignals.fastRewardCue?.present && conversionSignals.fastRewardCue?.shouldReplicate) {
    effects.push("fast_reward_cue");
  }
  return [...new Set(effects)];
}

function normalizeVoiceoverObserved(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    present: normalizeBoolean(source.present),
    emotion: cleanString(source.emotion),
    pace: cleanString(source.pace),
    energy: cleanString(source.energy),
    evidence: cleanString(source.evidence),
    transcript: normalizeStringList(source.transcript)
  };
}

function normalizeVariableLayers(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    lockedElements: normalizeStringList(source.lockedElements),
    primaryVariables: normalizeStringList(source.primaryVariables),
    secondaryVariables: normalizeStringList(source.secondaryVariables),
    weakVariables: normalizeStringList(source.weakVariables)
  };
}

function normalizeTimelineItems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    startSec: Number.isFinite(Number(item?.startSec)) ? roundSec(item.startSec) : null,
    endSec: Number.isFinite(Number(item?.endSec)) ? roundSec(item.endSec) : null,
    type: cleanString(item?.type),
    content: cleanString(item?.content),
    conversionSignal: cleanString(item?.conversionSignal)
  })).filter((item) => item.type || item.content || item.conversionSignal);
}

function normalizeConversionEffectOpportunities(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => ({
    effect: cleanString(item?.effect || item),
    placement: cleanString(item?.placement),
    reason: cleanString(item?.reason),
    observedInSource: normalizeBoolean(item?.observedInSource),
    targetLanguageRequired: normalizeBoolean(item?.targetLanguageRequired ?? true),
    useExactAmount: normalizeBoolean(item?.useExactAmount)
  })).filter((item) => item.effect || item.placement || item.reason);
}

function normalizeSliceSplitHints(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((hint) => {
      const splitSec = roundSec(typeof hint === "number" ? hint : hint?.splitSec);
      return {
        splitSec,
        reason: cleanString(hint?.reason)
      };
    })
    .filter((hint) => hint.splitSec > 0);
}

function validSliceSplitHints(segment = {}, minSliceSec, maxSliceSec) {
  const startSec = roundSec(segment.startSec);
  const endSec = roundSec(segment.endSec || (startSec + numberOrFallback(segment.durationSec, 0)));
  return normalizeSliceSplitHints(segment.sliceSplitHints)
    .filter((hint) => {
      const firstDuration = roundSec(hint.splitSec - startSec);
      const secondDuration = roundSec(endSec - hint.splitSec);
      return firstDuration >= minSliceSec
        && firstDuration <= maxSliceSec
        && secondDuration >= minSliceSec
        && secondDuration <= maxSliceSec;
    })
    .sort((left, right) => left.splitSec - right.splitSec);
}

function hasTruthRules(truthRules = {}) {
  return !!truthRules && typeof truthRules === "object" && Object.keys(truthRules).length > 0;
}

function collectStringFields(value, path = "") {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectStringFields(item, `${path}[${index}]`));
  }
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([key, item]) => collectStringFields(item, path ? `${path}.${key}` : key));
  }
  return [];
}

export function enforceNoExactMoneyClaimsWithoutTruthRules(storySegments = [], truthRules = {}) {
  if (hasTruthRules(truthRules)) return;
  const fields = collectStringFields(storySegments, "storySegments");
  const violation = fields.find((field) => EXACT_MONEY_CLAIM_REGEX.test(field.value));
  if (violation) {
    throw new Error(`exact money claim requires truthRules: ${violation.path}`);
  }
}

function segmentRoleFor(globalIndex, total) {
  if (globalIndex === 1) return "hook_slice";
  if (total === 2) return "proof_slice";
  if (globalIndex === total) return "withdrawal_slice";
  return "proof_slice";
}

function copySevenDimensions(source = {}) {
  const result = {};
  for (const key of SEVEN_DIMENSIONS) result[key] = cleanString(source[key]);
  return result;
}

export function buildSeedanceSlices(storySegments = [], options = {}) {
  const rawSlices = [];
  for (const segment of storySegments) {
    const timingSlices = splitStorySegmentIntoSlices(segment, options);
    const conversionSignals = normalizeConversionSignals(segment.conversionSignals || segment.observedConversionSignals);
    const moneyEffects = normalizeStringList(segment.moneyEffects).length
      ? normalizeStringList(segment.moneyEffects)
      : signalMoneyEffects(conversionSignals);
    for (const timing of timingSlices) {
      rawSlices.push({
        ...timing,
        ...copySevenDimensions(segment),
        coreHook: cleanString(segment.coreHook),
        explosivePoint: cleanString(segment.explosivePoint),
        segmentPurpose: cleanString(segment.segmentPurpose),
        segmentConversionStyle: cleanString(segment.segmentConversionStyle),
        segmentRhythm: cleanString(segment.segmentRhythm),
        segmentStructureSkeleton: cleanString(segment.segmentStructureSkeleton),
        conversionSignals,
        timelineItems: normalizeTimelineItems(segment.timelineItems),
        conversionEffectOpportunities: normalizeConversionEffectOpportunities(segment.conversionEffectOpportunities),
        voiceoverObserved: normalizeVoiceoverObserved(segment.voiceoverObserved),
        variableLayers: normalizeVariableLayers(segment.variableLayers),
        replicatedSellingPoints: normalizeStringList(segment.replicatedSellingPoints),
        optionalEnhancementSuggestions: normalizeStringList(segment.optionalEnhancementSuggestions),
        moneyEffects,
        imagePrompt: cleanString(segment.imagePrompt),
        seedancePrompt: cleanString(segment.seedancePrompt),
        negativePrompt: cleanString(segment.negativePrompt) || "No competitor logo, no watermark, no burned subtitles, no invented exact payout amount.",
        subtitleWorkflow: {
          burnedInSubtitles: false,
          postSubtitleRequired: true,
          provider: "pixel_tech",
          subtitleScript: normalizeStringList(segment.subtitleScript || segment.subtitles)
        }
      });
    }
  }
  return rawSlices.map((slice, index) => ({
    ...slice,
    segmentRole: slice.segmentRole || segmentRoleFor(index + 1, rawSlices.length)
  }));
}

export function renderSeedancePromptsMarkdown(plan = {}) {
  const slices = Array.isArray(plan.slices) ? plan.slices : [];
  const lines = ["# Seedance Segment Debug Prompts", ""];
  for (const slice of slices) {
    lines.push(`## Story ${slice.storySegmentIndex} / Slice ${slice.seedanceSliceIndex}`);
    lines.push("");
    lines.push(`- Timing: ${slice.startSec}s-${slice.endSec}s`);
    lines.push(`- durationSec: ${slice.durationSec}`);
    lines.push(`- segmentRole: ${slice.segmentRole || ""}`);
    lines.push("- Seven dimensions:");
    for (const key of SEVEN_DIMENSIONS) lines.push(`  - ${key}: ${slice[key] || ""}`);
    lines.push(`- Core hook: ${slice.coreHook || ""}`);
    lines.push(`- Explosive point: ${slice.explosivePoint || ""}`);
    lines.push(`- Money effects: ${(slice.moneyEffects || []).join(", ")}`);
    lines.push("");
    lines.push("### imagePrompt");
    lines.push(slice.imagePrompt || "");
    lines.push("");
    lines.push("### seedancePrompt");
    lines.push(slice.seedancePrompt || "");
    lines.push("");
    lines.push("### negativePrompt");
    lines.push(slice.negativePrompt || "");
    lines.push("");
    lines.push("### subtitleScript");
    for (const line of slice.subtitleWorkflow?.subtitleScript || []) lines.push(`- ${line}`);
    lines.push("");
  }
  return `${lines.join("\n").trim()}\n`;
}

export function normalizeStorySegments(value, context = {}) {
  const source = Array.isArray(value?.storySegments) ? value.storySegments : (Array.isArray(value) ? value : []);
  const durationSec = roundSec(context.durationSec);
  const normalizedSegments = [];
  for (const [index, segment] of source.entries()) {
    const startSec = roundSec(segment.startSec ?? (index === 0 ? 0 : normalizedSegments[index - 1]?.endSec));
    const fallbackEnd = index === source.length - 1 && durationSec > 0
      ? durationSec
      : startSec + numberOrFallback(segment.durationSec, 0);
    const endSec = roundSec(segment.endSec ?? fallbackEnd);
    const normalized = {
      storySegmentIndex: Math.max(1, Math.round(numberOrFallback(segment.storySegmentIndex, index + 1))),
      startSec,
      endSec,
      durationSec: roundSec(segment.durationSec || (endSec - startSec)),
      ...copySevenDimensions(segment),
      coreHook: cleanString(segment.coreHook || segment.hook),
      explosivePoint: cleanString(segment.explosivePoint || segment.burstPoint || segment.baoDian),
      segmentPurpose: cleanString(segment.segmentPurpose),
      segmentConversionStyle: cleanString(segment.segmentConversionStyle),
      segmentRhythm: cleanString(segment.segmentRhythm),
      segmentStructureSkeleton: cleanString(segment.segmentStructureSkeleton),
      conversionSignals: normalizeConversionSignals(segment.conversionSignals || segment.observedConversionSignals),
      timelineItems: normalizeTimelineItems(segment.timelineItems),
      conversionEffectOpportunities: normalizeConversionEffectOpportunities(segment.conversionEffectOpportunities),
      voiceoverObserved: normalizeVoiceoverObserved(segment.voiceoverObserved),
      variableLayers: normalizeVariableLayers(segment.variableLayers),
      replicatedSellingPoints: normalizeStringList(segment.replicatedSellingPoints),
      optionalEnhancementSuggestions: normalizeStringList(segment.optionalEnhancementSuggestions),
      moneyEffects: normalizeStringList(segment.moneyEffects),
      sliceSplitHints: normalizeSliceSplitHints(segment.sliceSplitHints),
      imagePrompt: cleanString(segment.imagePrompt),
      seedancePrompt: cleanString(segment.seedancePrompt),
      negativePrompt: cleanString(segment.negativePrompt),
      subtitles: normalizeStringList(segment.subtitles || segment.subtitleScript)
    };
    for (const key of SEVEN_DIMENSIONS) {
      if (!normalized[key]) throw new Error(`storySegments[${index}].${key} 缺失`);
    }
    if (normalized.endSec <= normalized.startSec) throw new Error(`storySegments[${index}] 时间范围无效`);
    normalizedSegments.push(normalized);
  }
  return normalizedSegments;
}

export function buildSegmentAnalysisMessages(input = {}) {
  const frames = Array.isArray(input.frames) ? input.frames : [];
  const frameLines = frames.map((frame) => `- frame ${frame.index ?? ""} at ${frame.timestampSec}s`).join("\n") || "- no frames";
  const sceneCuts = (input.sceneCutsSec || []).join(", ") || "none";
  const truthRules = input.truthRules && Object.keys(input.truthRules).length ? JSON.stringify(input.truthRules) : "{}";
  const userText = [
    "Analyze the reference video for Seedance ad generation in two passes: first understand the whole video end-to-end, then split it into narrative story segments.",
    `Source video: ${input.videoPath || ""}`,
    `Duration: ${input.durationSec || 0}s`,
    `Language: ${input.language || "pt-BR"}`,
    `Region: ${input.region || "BR"}`,
    `Currency: ${input.currencySymbol || ""}`,
    `Hard target-language/region/currency rule: all voiceover, CTA, subtitle scripts, and any minimal visible UI text for generated outputs must use ${input.language || "pt-BR"} for region ${input.region || "BR"}. If a page, overlay, balance, withdrawal screen, reward counter, payout UI, or cash/coin visual can imply money, it must use the target currency symbol ${input.currencySymbol || "provided by the target region"} only. Do not mix languages or currencies.`,
    `Local identity rule: people, faces, clothing, scenes, camera behavior, phone UI habits, and voice identity should be locally plausible for ${input.region || "BR"} and ${input.language || "pt-BR"}.`,
    `Product: ${input.productName || "Product"}`,
    `Scene cut hints, for reference only: ${sceneCuts}`,
    "Extracted frames:",
    frameLines,
    "First pass requirement: produce sourceVideoProfile and wholeVideoConversion before segmenting. Explain the complete story arc, core conversion tone, main persuasion path, global rhythm, product role, product/app inserts, money/effect inserts, emotional voiceover, and ending CTA.",
    "Second pass requirement: split by real narrative story beats only. Do not create a new story segment only because the video cuts to app UI, reward animation, coin/cash effects, withdrawal visual, title card, subtitle card, or CTA overlay.",
    "App screens, UI inserts, reward animations, sound cues, cash/coin effects, and CTA overlays must be recorded as elements inside the surrounding story segment unless they change the underlying narrative beat.",
    "For each story segment, include second-level timelineItems that cover the segment from startSec to endSec with concrete visible content and labels such as drama_action, app_ui, withdrawal_success, earnings_number, cash_coin_feedback, fast_reward_cue, emotional_voiceover, sound_cue, subtitle_overlay, cta.",
    "For each story segment, include segmentPurpose, segmentConversionStyle, segmentRhythm, segmentStructureSkeleton, and variableLayers. variableLayers must include lockedElements, primaryVariables, secondaryVariables, weakVariables.",
    "If a story segment is longer than the maximum Seedance slice duration, include sliceSplitHints with exact splitSec values at natural internal story transitions, such as host claim -> UI proof, UI proof -> CTA, or setup -> payoff. Do not split long story segments by equal duration unless no narrative transition exists.",
    "Required for every story segment: scene, subject, action, camera, lighting, style, quality, coreHook, explosivePoint, segmentPurpose, segmentConversionStyle, segmentRhythm, segmentStructureSkeleton, conversionSignals, conversionEffectOpportunities, voiceoverObserved, variableLayers, timelineItems.",
    "The LLM chooses the story segment count from the full story arc. Scene cuts are technical hints only, not authoritative boundaries, and should not over-segment app/effect inserts.",
    "Observed conversion signal rule: identify whether the reference video truly contains withdrawalSuccess, earningsNumber, emotionalVoiceover, cashCoinFeedback, and fastRewardCue. Do not mark a signal present just because it would be useful for ads.",
    "For every conversion signal, output present, timestampSec, evidence, roleInVideo, and shouldReplicate. shouldReplicate=true only when the signal is visible/audible or strongly implied in the reference video and is structurally important.",
    "For wangzhuan effects, record observed visual motifs such as top_balance_growth, reward_number_growth, continuous_earnings_rise, coin_burst, cash_rain, withdrawal_success, arrival_animation, withdrawal_record, real_cash_sound_cue when observed in the reference video.",
    "Also output conversionEffectOpportunities for later fission enhancement. These are allowed placement suggestions for top withdrawal/balance growth, real-cash sound cue, full-screen coin/cash rain, or continuous reward number increase. Keep this separate from observed conversionSignals so source analysis is not polluted.",
    "Opening hook rule: identify whether the first segment can support a stronger fission opening. If yes, mark conversionEffectOpportunities for the first 1-2 seconds: strong drama conflict/twist hook, top withdrawal/reward balance rapidly growing, cash/coin rain, real-cash sound cue, and continuous earnings growth.",
    "Slice diversity rule: output variableLayers so later Seedance slices can vary person, scene, clothing, camera setup, and voice identity. Adjacent slices should not look like the same person in the same location unless the source story explicitly requires continuity.",
    "voiceoverObserved must describe whether the reference has voiceover/talking, its emotion, pace, energy, evidence, and transcript snippets. Do not invent missing voiceover.",
    "Fission rule: this analysis is for fission, not one-to-one imitation. Preserve the whole-video core conversion tone and segment skeleton, but expose controlled variables for later product replacement and Seedance prompt generation.",
    "Seedance prompt generation rule inside this analysis: seedancePrompt should preserve the reference segment's conversion style, rhythm, structure skeleton, observed conversion signals, and product/app proof structure. Do not force withdrawal, earnings, cash/coin, or emotional voiceover into a segment where the reference segment does not contain or strongly imply it; put enhancement ideas in conversionEffectOpportunities.",
    "Subtitle rule: output subtitleScript/subtitles as short post-process subtitle lines in the target language. Seedance prompt must say no burned subtitles, no dense captions, no large text blocks; any visible text must be minimal UI microcopy only.",
    "Do not invent or copy exact payout amounts, thresholds, arrival speeds, or guaranteed earnings unless truthRules explicitly allow them. Even when the source frame visibly contains a concrete amount, describe it generically as 'a visible earnings/withdrawal amount' and do not output the exact number.",
    `truthRules: ${truthRules}`,
    "Return strict JSON only: {\"sourceVideoProfile\":{\"durationSec\":0,\"language\":\"...\",\"region\":\"...\",\"currencySymbol\":\"...\",\"productType\":\"...\",\"personaSummary\":\"...\",\"sceneCount\":3,\"ctaType\":\"...\"},\"wholeVideoConversion\":{\"coreConversionTone\":\"...\",\"mainPersuasionPath\":\"...\",\"globalRhythm\":\"...\",\"mainSellingLogic\":\"...\",\"productRoleInVideo\":\"...\",\"referenceVideoStructureSummary\":\"...\"},\"wholeVideoSummary\":{\"storyArc\":\"...\",\"mainCharacters\":[\"...\"],\"productAppInserts\":[\"...\"],\"moneyEffectInserts\":[\"...\"],\"voiceoverSummary\":\"...\",\"endingCta\":\"...\",\"suggestedNarrativeSegmentCount\":3},\"storySegments\":[{\"storySegmentIndex\":1,\"startSec\":0,\"endSec\":12,\"durationSec\":12,\"segmentPurpose\":\"...\",\"segmentConversionStyle\":\"...\",\"segmentRhythm\":\"...\",\"segmentStructureSkeleton\":\"...\",\"scene\":\"...\",\"subject\":\"...\",\"action\":\"...\",\"camera\":\"...\",\"lighting\":\"...\",\"style\":\"...\",\"quality\":\"...\",\"coreHook\":\"...\",\"explosivePoint\":\"...\",\"conversionSignals\":{\"withdrawalSuccess\":{\"present\":false,\"timestampSec\":null,\"evidence\":\"\",\"roleInVideo\":\"\",\"shouldReplicate\":false},\"earningsNumber\":{\"present\":true,\"timestampSec\":2.5,\"evidence\":\"reward counter grows on screen\",\"roleInVideo\":\"opens with result feeling\",\"shouldReplicate\":true},\"emotionalVoiceover\":{\"present\":true,\"timestampSec\":1,\"evidence\":\"host speaks fast and excited\",\"roleInVideo\":\"creates urgency\",\"shouldReplicate\":true},\"cashCoinFeedback\":{\"present\":false,\"timestampSec\":null,\"evidence\":\"\",\"roleInVideo\":\"\",\"shouldReplicate\":false},\"fastRewardCue\":{\"present\":true,\"timestampSec\":4,\"evidence\":\"quick reward feedback after app action\",\"roleInVideo\":\"low barrier proof\",\"shouldReplicate\":true}},\"conversionEffectOpportunities\":[{\"effect\":\"top_balance_growth\",\"placement\":\"top overlay during app proof\",\"reason\":\"source shows reward proof beat\",\"observedInSource\":true,\"targetLanguageRequired\":true,\"useExactAmount\":false}],\"voiceoverObserved\":{\"present\":true,\"emotion\":\"excited\",\"pace\":\"fast\",\"energy\":\"high\",\"evidence\":\"host speaks directly to camera\",\"transcript\":[\"...\"]},\"variableLayers\":{\"lockedElements\":[\"proof timing\"],\"primaryVariables\":[\"persona\"],\"secondaryVariables\":[\"scene\"],\"weakVariables\":[\"button color\"]},\"replicatedSellingPoints\":[\"earnings feedback because observed\"],\"optionalEnhancementSuggestions\":[\"withdrawal success UI could be tested, but not observed here\"],\"moneyEffects\":[\"reward_number_growth\"],\"timelineItems\":[{\"startSec\":0,\"endSec\":3,\"type\":\"emotional_voiceover\",\"content\":\"...\",\"conversionSignal\":\"emotionalVoiceover\"}],\"sliceSplitHints\":[{\"splitSec\":20,\"reason\":\"host claim changes into app UI proof\"}],\"imagePrompt\":\"...\",\"seedancePrompt\":\"... no burned subtitles, no dense captions ...\",\"negativePrompt\":\"...\",\"subtitles\":[\"...\"]}]}"
  ].join("\n");

  const userContent = [
    { type: "text", text: userText },
    ...frames
      .filter((frame) => cleanString(frame?.dataUrl))
      .map((frame) => ({
        type: "image_url",
        image_url: { url: cleanString(frame.dataUrl) }
      }))
  ];

  return [
    {
      role: "system",
      content: "You are a Seedance wangzhuan reference-video fission analyst. First understand the complete source video story and conversion tone, then segment only by narrative story beats. Faithfully identify observed conversion signals, segment rhythm, segment skeleton, and variable layers before generating prompts. Preserve the source video's conversion baseline while preparing controlled fission variants."
    },
    {
      role: "user",
      content: userContent
    }
  ];
}

export async function writeDebugOutputs(outputDir, payload = {}) {
  await mkdir(outputDir, { recursive: true });
  const analysisPath = `${outputDir}/analysis.json`;
  const planPath = `${outputDir}/seedance-plan.json`;
  const promptsPath = `${outputDir}/seedance-prompts.md`;
  await writeFile(analysisPath, `${JSON.stringify(payload.analysis || {}, null, 2)}\n`);
  await writeFile(planPath, `${JSON.stringify(payload.plan || {}, null, 2)}\n`);
  await writeFile(promptsPath, renderSeedancePromptsMarkdown(payload.plan || {}));
  return { analysisPath, planPath, promptsPath };
}

export async function assertLocalVideoFile(videoPath) {
  const info = await stat(videoPath);
  if (!info.isFile()) throw new Error(`视频路径不是文件：${videoPath}`);
  return videoPath;
}

export async function loadTruthRules(truthRulesPath) {
  if (!truthRulesPath) return {};
  return JSON.parse(await readFile(truthRulesPath, "utf8"));
}

async function defaultProbeVideo(videoPath) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    videoPath
  ], {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 2 * 1024 * 1024,
    windowsHide: true
  });
  const parsed = JSON.parse(stdout || "{}");
  const stream = Array.isArray(parsed.streams) ? parsed.streams[0] || {} : {};
  const durationSec = roundSec(parsed.format?.duration || 0);
  const width = Math.round(numberOrFallback(stream.width, 0));
  const height = Math.round(numberOrFallback(stream.height, 0));
  return {
    durationSec,
    width,
    height,
    ratio: width && height ? `${width}:${height}` : ""
  };
}

function createReferenceContext(options = {}) {
  return {
    userProjectRoot: process.cwd(),
    sharedProjectRoot: process.cwd(),
    config: {
      wangzhuan: {
        llm: {
          frameExtractTimeoutMs: Number(process.env.WANGZHUAN_DEBUG_FRAME_TIMEOUT_MS || 20000),
          sceneDetectTimeoutMs: Number(process.env.WANGZHUAN_DEBUG_SCENE_TIMEOUT_MS || 25000),
          sceneDetectThreshold: Number(process.env.WANGZHUAN_DEBUG_SCENE_THRESHOLD || 0.1),
          sceneDetectMinGapSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_MIN_GAP_SEC || 0.8),
          sceneLongThresholdSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_LONG_THRESHOLD_SEC || 8),
          sceneMaxFrames: Number(process.env.WANGZHUAN_DEBUG_SCENE_MAX_FRAMES || 40)
        }
      }
    },
    ...(options.context || {})
  };
}

function defaultFrameTimestamps(durationSec, sceneCutsSec = [], options = {}) {
  const duration = roundSec(durationSec);
  if (duration <= 0) return [];
  const timestamps = buildSceneAwareFrameTimestamps(duration, sceneCutsSec, {
    longSceneThresholdSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_LONG_THRESHOLD_SEC || 8),
    maxFrames: Number(process.env.WANGZHUAN_DEBUG_SCENE_MAX_FRAMES || 40),
    minSceneGapSec: Number(process.env.WANGZHUAN_DEBUG_SCENE_MIN_GAP_SEC || 0.8)
  });
  if (timestamps.length) return timestamps;
  return [0.25, duration * 0.25, duration * 0.5, duration * 0.75, Math.max(0.25, duration - 0.25)]
    .map(roundSec)
    .filter((value, index, list) => list.indexOf(value) === index);
}

async function defaultDetectScenes(videoPath, probe, options = {}) {
  return detectReferenceVideoScenes(createReferenceContext(options), videoPath, probe.durationSec);
}

async function defaultExtractFrames(videoPath, probe, options = {}) {
  const timestampsSec = Array.isArray(probe.timestampsSec) && probe.timestampsSec.length
    ? probe.timestampsSec
    : defaultFrameTimestamps(probe.durationSec, options.sceneCutsSec || [], options);
  return extractReferenceFrames(createReferenceContext(options), videoPath, timestampsSec);
}

async function loadDebugRuntimeConfig(options = {}) {
  if (options.runtimeConfig && typeof options.runtimeConfig === "object") return options.runtimeConfig;
  const cwd = options.cwd || process.cwd();
  const { config } = await loadRuntimeConfig({
    runtimePath: options.configPath || process.env.AIGC_CONFIG_PATH || resolve(cwd, "config.json"),
    defaultPath: options.defaultConfigPath || resolve(cwd, "config.default.json")
  });
  return config;
}

async function resolveDebugLlmConfig(options = {}) {
  const config = await loadDebugRuntimeConfig(options);
  return resolveLlmConfig(config, {
    ...(options.llmConfig && typeof options.llmConfig === "object" ? options.llmConfig : {}),
    ...(cleanString(options.provider) ? { provider: cleanString(options.provider) } : {}),
    ...(cleanString(options.model) ? { model: cleanString(options.model) } : {}),
    ...(cleanString(options.endpoint) ? { endpoint: cleanString(options.endpoint) } : {}),
    ...(cleanString(options.apiKey) ? { apiKey: cleanString(options.apiKey) } : {}),
    ...(cleanString(options.apiKeyEnv) ? { apiKeyEnv: cleanString(options.apiKeyEnv) } : {}),
    ...(Number.isFinite(Number(options.temperature)) ? { temperature: Number(options.temperature) } : {}),
    ...(Number.isFinite(Number(options.timeoutMs)) ? { timeoutMs: Number(options.timeoutMs) } : {})
  });
}

async function defaultCallLlm(messages, options = {}) {
  const llmConfig = await resolveDebugLlmConfig(options);
  return callOpenAiCompatibleLlm(llmConfig, messages);
}

async function writeRawLlmResponse(outputDir, rawContent) {
  await mkdir(outputDir, { recursive: true });
  await writeFile(`${outputDir}/llm-raw-response.txt`, `${String(rawContent || "")}\n`);
}

export async function runSeedanceSegmentDebugCli(options = {}) {
  const videoPath = requireValue(options.videoPath, "--video 必填");
  const outputDir = requireValue(options.outputDir, "--out 必填");
  await assertLocalVideoFile(videoPath);

  const dependencies = options.dependencies || {};
  const probeVideo = dependencies.probeVideo || defaultProbeVideo;
  const detectScenes = dependencies.detectScenes || defaultDetectScenes;
  const extractFrames = dependencies.extractFrames || defaultExtractFrames;
  const callLlm = dependencies.callLlm || defaultCallLlm;

  const truthRules = options.truthRules || await loadTruthRules(options.truthRulesPath);
  const probe = await probeVideo(videoPath, options);
  let sceneCutList = [];
  try {
    const sceneCutsSec = await detectScenes(videoPath, probe, options);
    sceneCutList = Array.isArray(sceneCutsSec) ? sceneCutsSec.map(roundSec) : [];
  } catch {
    sceneCutList = [];
  }

  const frameProbe = {
    ...probe,
    timestampsSec: defaultFrameTimestamps(probe.durationSec, sceneCutList, options)
  };
  let frames = [];
  try {
    const extractedFrames = await extractFrames(videoPath, frameProbe, { ...options, sceneCutsSec: sceneCutList });
    frames = Array.isArray(extractedFrames) ? extractedFrames : [];
  } catch {
    frames = [];
  }
  const messages = buildSegmentAnalysisMessages({
    ...options,
    videoPath,
    durationSec: probe.durationSec,
    sceneCutsSec: sceneCutList,
    frames,
    truthRules
  });
  const rawContent = await callLlm(messages, options);
  let parsed;
  let storySegments;
  try {
    parsed = typeof rawContent === "string" ? parseLlmJsonContent(rawContent) : rawContent;
    storySegments = normalizeStorySegments(parsed, { durationSec: probe.durationSec });
    enforceNoExactMoneyClaimsWithoutTruthRules(storySegments, truthRules);
  } catch (error) {
    await writeRawLlmResponse(outputDir, rawContent);
    throw error;
  }

  const slices = buildSeedanceSlices(storySegments, options);
  const analysis = {
    sourceVideo: {
      path: videoPath,
      fileName: basename(videoPath),
      durationSec: probe.durationSec,
      width: probe.width || 0,
      height: probe.height || 0,
      ratio: probe.ratio || "",
      sceneCutsSec: sceneCutList
    },
    sourceVideoProfile: parsed?.sourceVideoProfile || {},
    wholeVideoConversion: parsed?.wholeVideoConversion || {},
    wholeVideoSummary: parsed?.wholeVideoSummary || {},
    fissionStrategy: parsed?.fissionStrategy || {},
    candidateVariables: parsed?.candidateVariables || {},
    versionGenerationRules: parsed?.versionGenerationRules || [],
    storySegments
  };
  const plan = {
    language: options.language || "pt-BR",
    region: options.region || "BR",
    productName: options.productName || "Product",
    currencySymbol: options.currencySymbol || "",
    minSliceSec: options.minSliceSec || 8,
    maxSliceSec: options.maxSliceSec || 15,
    slices
  };
  const paths = await writeDebugOutputs(outputDir, { analysis, plan });
  return { analysis, plan, paths };
}

export const seedanceSegmentDebugInternals = {
  SEVEN_DIMENSIONS,
  basename
};
