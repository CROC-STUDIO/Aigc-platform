import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";
import { promisify } from "node:util";

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

const DEFAULT_MONEY_EFFECTS = Object.freeze([
  "reward_number_growth",
  "coin_burst",
  "cash_rain",
  "withdrawal_success"
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

  const firstDuration = Math.max(minSliceSec, Math.min(maxSliceSec, Math.round(durationSec / 2)));
  const firstEndSec = roundSec(startSec + firstDuration);
  return [
    {
      storySegmentIndex,
      seedanceSliceIndex: 1,
      startSec,
      endSec: firstEndSec,
      durationSec: roundSec(firstEndSec - startSec)
    },
    {
      storySegmentIndex,
      seedanceSliceIndex: 2,
      startSec: firstEndSec,
      endSec,
      durationSec: roundSec(endSec - firstEndSec)
    }
  ];
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => cleanString(item)).filter(Boolean);
  const text = cleanString(value);
  return text ? [text] : [];
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
    for (const timing of timingSlices) {
      rawSlices.push({
        ...timing,
        ...copySevenDimensions(segment),
        coreHook: cleanString(segment.coreHook),
        explosivePoint: cleanString(segment.explosivePoint),
        moneyEffects: normalizeStringList(segment.moneyEffects).length
          ? normalizeStringList(segment.moneyEffects)
          : [...DEFAULT_MONEY_EFFECTS],
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
      moneyEffects: normalizeStringList(segment.moneyEffects),
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
    "Analyze the reference video into narrative story segments for Seedance ad generation.",
    `Source video: ${input.videoPath || ""}`,
    `Duration: ${input.durationSec || 0}s`,
    `Language: ${input.language || "pt-BR"}`,
    `Region: ${input.region || "BR"}`,
    `Product: ${input.productName || "Product"}`,
    `Currency: ${input.currencySymbol || ""}`,
    `Scene cut hints, for reference only: ${sceneCuts}`,
    "Extracted frames:",
    frameLines,
    "Required for every story segment: scene, subject, action, camera, lighting, style, quality, coreHook, explosivePoint, moneyEffects.",
    "The LLM chooses the story segment count. Scene cuts are hints, not authoritative boundaries.",
    "For wangzhuan effects, include visual motifs such as reward_number_growth, coin_burst, cash_rain, withdrawal_success, arrival_animation, withdrawal_record, real_cash_sound_cue when they fit.",
    "Do not invent exact payout amounts, thresholds, arrival speeds, or guaranteed earnings unless truthRules explicitly allow them.",
    `truthRules: ${truthRules}`,
    "Return strict JSON only: {\"storySegments\":[{\"storySegmentIndex\":1,\"startSec\":0,\"endSec\":12,\"durationSec\":12,\"scene\":\"...\",\"subject\":\"...\",\"action\":\"...\",\"camera\":\"...\",\"lighting\":\"...\",\"style\":\"...\",\"quality\":\"...\",\"coreHook\":\"...\",\"explosivePoint\":\"...\",\"moneyEffects\":[\"reward_number_growth\"],\"imagePrompt\":\"...\",\"seedancePrompt\":\"... no burned subtitles ...\",\"negativePrompt\":\"...\",\"subtitles\":[\"...\"]}]}"
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
      content: "You are a Seedance wangzhuan video analyst. Preserve the source video's narrative structure, but redesign people, scene, clothing, props, and money visuals for safe original ad generation."
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

function resolveLlmConfigFromEnv(options = {}) {
  return {
    provider: cleanString(options.provider) || cleanString(process.env.WANGZHUAN_LLM_PROVIDER) || "skylink",
    model: cleanString(options.model) || cleanString(process.env.WANGZHUAN_LLM_MODEL) || "gpt-5.4",
    endpoint: cleanString(options.endpoint) || cleanString(process.env.WANGZHUAN_LLM_ENDPOINT) || cleanString(process.env.OPENAI_BASE_URL) || "https://api.openai.com/v1",
    apiKey: cleanString(options.apiKey) || cleanString(process.env.WANGZHUAN_LLM_API_KEY) || cleanString(process.env.OPENAI_API_KEY),
    apiKeyEnv: cleanString(options.apiKeyEnv) || "WANGZHUAN_LLM_API_KEY",
    temperature: Number.isFinite(Number(options.temperature)) ? Number(options.temperature) : 0.2,
    timeoutMs: Number.isFinite(Number(options.timeoutMs)) ? Number(options.timeoutMs) : 300000
  };
}

async function defaultCallLlm(messages, options = {}) {
  const llmConfig = resolveLlmConfigFromEnv(options.llmConfig || {});
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
