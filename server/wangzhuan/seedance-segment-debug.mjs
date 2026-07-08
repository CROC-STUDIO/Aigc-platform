import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, relative, resolve } from "node:path";

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

function segmentRoleFor(globalIndex, total) {
  if (globalIndex === 1) return "hook_slice";
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

export const seedanceSegmentDebugInternals = {
  SEVEN_DIMENSIONS,
  basename
};
