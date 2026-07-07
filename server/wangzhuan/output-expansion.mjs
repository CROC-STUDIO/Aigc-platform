import { execFile, execFileSync } from "node:child_process";
import { access, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

import { WangzhuanError } from "./http.mjs";
import { toProjectRelative, wangzhuanPaths } from "./storage.mjs";

const execFileAsync = promisify(execFile);
const PRESET_SIZES = new Set(["800x800", "1280x720", "720x1280"]);

function ffmpegAvailableSync() {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore", timeout: 5000, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export function normalizeExpansionRequest(body = {}) {
  const targetWidth = Number(body.targetWidth);
  const targetHeight = Number(body.targetHeight);
  const mode = String(body.mode || "blur_pad").trim() || "blur_pad";
  if (!Number.isInteger(targetWidth) || !Number.isInteger(targetHeight)) {
    throw new WangzhuanError("validation_error", "请输入合法的宽高", {
      field: "targetWidth,targetHeight"
    });
  }
  if (targetWidth < 256 || targetWidth > 4096 || targetHeight < 256 || targetHeight > 4096) {
    throw new WangzhuanError("validation_error", "宽高需在 256-4096 像素之间", {
      targetWidth,
      targetHeight
    });
  }
  if (mode !== "blur_pad") {
    throw new WangzhuanError("validation_error", "当前仅支持 blur_pad 扩展模式", { mode });
  }
  const presetKey = PRESET_SIZES.has(`${targetWidth}x${targetHeight}`) ? `${targetWidth}x${targetHeight}` : "";
  return { targetWidth, targetHeight, mode, presetKey };
}

export function buildExpandedOutputName(fileName = "output.mp4", width, height) {
  const safe = String(fileName || "output.mp4");
  return safe.replace(/(\.[^.]+)?$/, `__${width}x${height}$1`);
}

export function expansionModeLabel(mode) {
  return mode === "blur_pad" ? "原视频等比缩放，空白区域自动补高斯模糊背景" : mode;
}

export function buildBlurPadFilter(width, height) {
  return [
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},gblur=sigma=28[bg]`,
    `[0:v]scale=${width}:${height}:force_original_aspect_ratio=decrease[fg]`,
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[v]`
  ].join(";");
}

export function buildExpansionResultShape({
  jobId,
  outputId,
  targetWidth,
  targetHeight,
  fileName,
  storedPath,
  previewUrl = "",
  downloadUrl = "",
  requestId = "",
  updatedAt = new Date().toISOString()
}) {
  return {
    jobId,
    outputId,
    status: "succeeded",
    targetWidth,
    targetHeight,
    sizeKey: `${targetWidth}x${targetHeight}`,
    fileName,
    storedPath,
    previewUrl,
    downloadUrl,
    requestId,
    updatedAt
  };
}

export async function renderExpandedVideo({ inputPath, targetWidth, targetHeight, outputDir, outputFileName = "" }) {
  const fileName = outputFileName || buildExpandedOutputName(basename(inputPath), targetWidth, targetHeight);
  const outputPath = join(outputDir, fileName);
  const filter = buildBlurPadFilter(targetWidth, targetHeight);
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i", inputPath,
      "-filter_complex", filter,
      "-map", "[v]",
      "-map", "0:a?",
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "18",
      "-c:a", "copy",
      outputPath
    ], {
      timeout: 120000,
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (error) {
    try {
      const info = await stat(outputPath);
      if (info.isFile() && info.size > 0) {
        return { outputPath, fileName };
      }
    } catch {}
    throw error;
  }
  return { outputPath, fileName };
}

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function remoteSourceExtension(output = {}, sourcePath = "") {
  const safeFileName = String(output.fileName || "").trim();
  const fileNameExt = extname(safeFileName);
  if (fileNameExt) return fileNameExt;
  const sourceExt = extname(sourcePath);
  if (sourceExt) return sourceExt;
  return ".mp4";
}

async function prepareExpansionSourceFile(output, sourcePath, derivedDir) {
  if (await fileExists(sourcePath)) {
    return { inputPath: sourcePath, cleanupPath: "" };
  }
  const remoteUrl = String(output.storageUrl || output.previewUrl || "").trim();
  if (!/^https?:\/\//i.test(remoteUrl)) {
    throw new WangzhuanError("validation_error", "输出源文件不存在，且没有可用的远端视频地址", {
      outputId: output.outputId
    });
  }
  const response = await fetch(remoteUrl);
  if (!response.ok) {
    throw new WangzhuanError("validation_error", `输出源文件下载失败：HTTP ${response.status}`, {
      outputId: output.outputId,
      status: response.status
    });
  }
  const tempPath = join(derivedDir, `source${remoteSourceExtension(output, sourcePath)}`);
  const arrayBuffer = await response.arrayBuffer();
  await writeFile(tempPath, Buffer.from(arrayBuffer));
  return { inputPath: tempPath, cleanupPath: tempPath };
}

export function ensureExpandableOutput(output = {}) {
  if (!output?.outputId) {
    throw new WangzhuanError("output_not_found", "输出不存在", {});
  }
  const previewUrl = String(output.previewUrl || output.storageUrl || "").trim();
  if (!previewUrl || !/\.(mp4|webm|mov|m4v)(\?|$)/i.test(previewUrl)) {
    throw new WangzhuanError("validation_error", "当前仅支持视频输出扩展尺寸", {
      outputId: output.outputId
    });
  }
  if (!output.filePath) {
    throw new WangzhuanError("validation_error", "输出文件路径缺失，无法扩展尺寸", {
      outputId: output.outputId
    });
  }
  return output;
}

export function expansionJobMeta(output, request) {
  return {
    outputId: output.outputId,
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    sizeKey: `${request.targetWidth}x${request.targetHeight}`,
    mode: request.mode,
    batchId: output.batchId || "",
    remixId: output.remixId || ""
  };
}

export async function runOutputExpansion(context, output, request, options = {}) {
  const safeOutput = ensureExpandableOutput(output);
  if (!ffmpegAvailableSync()) {
    throw new WangzhuanError("output_expansion_unavailable", "ffmpeg 不可用，无法扩展视频尺寸", {});
  }
  const paths = wangzhuanPaths(context);
  const derivedDir = join(paths.userRoot, "expanded-outputs", safeOutput.outputId);
  await mkdir(derivedDir, { recursive: true });
  const sourcePath = join(context.userProjectRoot, safeOutput.filePath);
  const prepared = await prepareExpansionSourceFile(safeOutput, sourcePath, derivedDir);
  let rendered;
  try {
    rendered = await renderExpandedVideo({
      inputPath: prepared.inputPath,
      targetWidth: request.targetWidth,
      targetHeight: request.targetHeight,
      outputDir: derivedDir,
      outputFileName: buildExpandedOutputName(safeOutput.fileName || basename(sourcePath), request.targetWidth, request.targetHeight)
    });
  } finally {
    if (prepared.cleanupPath) {
      await rm(prepared.cleanupPath, { force: true }).catch(() => {});
    }
  }
  const storedPath = toProjectRelative(context.userProjectRoot, rendered.outputPath);
  const fileUrl = `/file?path=${encodeURIComponent(storedPath)}`;
  const downloadUrl = `/file?path=${encodeURIComponent(storedPath)}&download=1`;
  return buildExpansionResultShape({
    jobId: options.jobId || "",
    outputId: safeOutput.outputId,
    targetWidth: request.targetWidth,
    targetHeight: request.targetHeight,
    fileName: rendered.fileName,
    storedPath,
    previewUrl: fileUrl,
    downloadUrl,
    requestId: options.requestId || "",
    updatedAt: new Date().toISOString()
  });
}
