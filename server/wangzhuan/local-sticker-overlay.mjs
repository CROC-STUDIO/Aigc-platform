import { execFile } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { WangzhuanError } from "./http.mjs";

const execFileAsync = promisify(execFile);
const VIDEO_DATA_PATTERN = /^data:(?:video\/(mp4|quicktime|webm|x-m4v)|application\/octet-stream);base64,([a-z0-9+/=\s]+)$/i;
const STICKER_DATA_PATTERN = /^data:image\/(png|jpeg|jpg|webp);base64,([a-z0-9+/=\s]+)$/i;
const MAX_VIDEO_BYTES = 300 * 1024 * 1024;
const MAX_STICKER_BYTES = 10 * 1024 * 1024;

function validation(message, data = {}) {
  return new WangzhuanError("validation_error", message, data, 400);
}

function finite(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : NaN;
}

function normalizeRegion(value = {}) {
  if (value.coordinate_space && value.coordinate_space !== "normalized") {
    throw validation("框选区域必须使用 normalized 坐标", { field: "params.region_spec" });
  }
  const region = {
    x: finite(value.x),
    y: finite(value.y),
    width: finite(value.width),
    height: finite(value.height)
  };
  if (!Object.values(region).every(Number.isFinite)
    || region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0
    || region.x + region.width > 1 || region.y + region.height > 1) {
    throw validation("框选区域坐标无效", { field: "params.region_spec" });
  }
  return region;
}

function validateDataUrl(value, pattern, maxBytes, message) {
  const match = String(value || "").match(pattern);
  if (!match) throw validation(message);
  const buffer = Buffer.from(match.at(-1).replace(/\s+/g, ""), "base64");
  if (!buffer.length || buffer.length > maxBytes) {
    throw validation(buffer.length ? `文件不能超过 ${Math.round(maxBytes / 1024 / 1024)} MB` : "文件内容为空");
  }
  return { subtype: match[1].toLowerCase(), buffer };
}

export function normalizeLocalStickerRequest(body = {}) {
  if (body.job_type !== "local_sticker_overlay") throw validation("仅支持 local_sticker_overlay 任务");
  const sourceType = String(body.input?.source_type || "");
  const source = String(body.input?.source || "");
  if (sourceType === "url") {
    let parsed;
    try { parsed = new URL(source); } catch { throw validation("请输入合法的视频 URL"); }
    if (!["http:", "https:"].includes(parsed.protocol)) throw validation("视频 URL 仅支持 http(s)");
  } else if (sourceType === "base64_data_url") {
    validateDataUrl(source, VIDEO_DATA_PATTERN, MAX_VIDEO_BYTES, "视频文件格式无效");
  } else {
    throw validation("视频来源仅支持 url 或 base64_data_url", { field: "input.source_type" });
  }

  const region = normalizeRegion(body.params?.region_spec?.[0]);
  const stickerSource = String(body.params?.sticker_source || "");
  if (stickerSource && body.params?.sticker_source_type !== "base64_data_url") {
    throw validation("贴纸来源仅支持 base64_data_url");
  }
  if (stickerSource) validateDataUrl(stickerSource, STICKER_DATA_PATTERN, MAX_STICKER_BYTES, "贴纸仅支持 PNG、JPG 或 WebP 图片");
  return {
    sourceType,
    source,
    region,
    stickerScaleMode: body.params?.sticker_scale_mode === "long_side" ? "long_side" : "short_side",
    stickerSource,
    hasSticker: Boolean(stickerSource)
  };
}

function evenFloor(value) {
  return Math.floor(value / 2) * 2;
}

function evenCeil(value) {
  return Math.ceil((value - 1e-8) / 2) * 2;
}

export function normalizedRegionToPixels(region, videoWidth, videoHeight) {
  const width = Math.max(2, evenFloor(Number(videoWidth)));
  const height = Math.max(2, evenFloor(Number(videoHeight)));
  const x = Math.min(width - 2, Math.max(0, evenFloor(region.x * width)));
  const y = Math.min(height - 2, Math.max(0, evenFloor(region.y * height)));
  const right = Math.min(width, Math.max(x + 2, evenCeil((region.x + region.width) * width)));
  const bottom = Math.min(height, Math.max(y + 2, evenCeil((region.y + region.height) * height)));
  return { x, y, width: right - x, height: bottom - y };
}

export function scaledStickerSize(sticker, region, mode = "short_side") {
  const stickerWidth = Number(sticker.width);
  const stickerHeight = Number(sticker.height);
  if (!(stickerWidth > 0) || !(stickerHeight > 0)) throw validation("贴纸尺寸无效");
  const factor = mode === "long_side"
    ? Math.max(region.width, region.height) / Math.max(stickerWidth, stickerHeight)
    : Math.min(region.width, region.height) / Math.min(stickerWidth, stickerHeight);
  return {
    width: Math.max(2, evenCeil(stickerWidth * factor)),
    height: Math.max(2, evenCeil(stickerHeight * factor))
  };
}

export function buildStickerFilter({ region, sticker = null }) {
  const delogo = `delogo=x=${region.x}:y=${region.y}:w=${region.width}:h=${region.height}:show=0`;
  if (!sticker) return `[0:v]${delogo},format=yuv420p[v]`;
  const x = Math.round(region.x + (region.width - sticker.width) / 2);
  const y = Math.round(region.y + (region.height - sticker.height) / 2);
  return `[0:v]${delogo}[clean];[1:v]scale=${sticker.width}:${sticker.height}[sticker];[clean][sticker]overlay=${x}:${y}:shortest=1:eof_action=pass,format=yuv420p[v]`;
}

async function inspectMedia(path, { image = false } = {}) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "stream=index,codec_type,width,height", "-show_entries", "format=duration,size", "-of", "json", path
  ], { encoding: "utf8", timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
  const parsed = JSON.parse(String(stdout || "{}"));
  const video = parsed.streams?.find((stream) => stream.codec_type === "video") || {};
  if (!(Number(video.width) > 0) || !(Number(video.height) > 0)) throw validation(image ? "贴纸图片无法读取" : "视频文件无法读取");
  return {
    width: Number(video.width),
    height: Number(video.height),
    durationSec: Number(parsed.format?.duration || 0),
    sizeBytes: Number(parsed.format?.size || 0),
    hasAudio: Boolean(parsed.streams?.some((stream) => stream.codec_type === "audio"))
  };
}

export async function renderLocalStickerVideo({ inputPath, stickerPath = "", outputPath, region, stickerScaleMode = "short_side", timeoutMs = 120000 }) {
  const input = await inspectMedia(inputPath);
  const pixelRegion = region.x <= 1 && region.y <= 1 && region.width <= 1 && region.height <= 1
    ? normalizedRegionToPixels(region, input.width, input.height)
    : region;
  const stickerInfo = stickerPath ? await inspectMedia(stickerPath, { image: true }) : null;
  const sticker = stickerInfo ? scaledStickerSize(stickerInfo, pixelRegion, stickerScaleMode) : null;
  const args = ["-y", "-nostdin", "-i", inputPath];
  if (stickerPath) args.push("-loop", "1", "-i", stickerPath);
  args.push(
    "-filter_complex", buildStickerFilter({ region: pixelRegion, sticker }),
    "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-preset", "veryfast", "-crf", "18",
    "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", "-shortest", outputPath
  );
  await execFileAsync("ffmpeg", args, { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 });
  const output = await inspectMedia(outputPath);
  if (!(output.durationSec > 0) || !(output.sizeBytes > 1024) || output.width !== input.width || output.height !== input.height) {
    throw new WangzhuanError("local_video_edit_failed", "输出视频校验失败", { width: output.width, height: output.height });
  }
  await execFileAsync("ffmpeg", ["-nostdin", "-v", "error", "-i", outputPath, "-f", "null", "-"], {
    timeout: timeoutMs,
    maxBuffer: 10 * 1024 * 1024
  });
  return { outputPath, ...output, region: pixelRegion, stickerSize: sticker };
}

function isPrivateAddress(address) {
  if (address === "::1" || address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) return true;
  const parts = address.split(".").map(Number);
  if (parts.length !== 4) return false;
  return parts[0] === 10 || parts[0] === 127 || parts[0] === 0 || (parts[0] === 169 && parts[1] === 254)
    || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || (parts[0] === 192 && parts[1] === 168);
}

async function assertSafeRemoteUrl(value) {
  const parsed = new URL(value);
  if (parsed.username || parsed.password || parsed.hostname === "localhost") throw validation("视频 URL 地址不可访问");
  const addresses = isIP(parsed.hostname) ? [{ address: parsed.hostname }] : await lookup(parsed.hostname, { all: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) throw validation("视频 URL 地址不可访问");
  return parsed;
}

async function downloadLimited(url, maxBytes, fetchImpl) {
  await assertSafeRemoteUrl(url);
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60000), redirect: "follow" });
  if (!response.ok) throw validation(`视频下载失败：HTTP ${response.status}`);
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) throw validation("视频文件不能超过 300 MB");
  const chunks = [];
  let size = 0;
  const reader = response.body?.getReader();
  if (!reader) throw validation("视频下载响应为空");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel().catch(() => {});
      throw validation("视频文件不能超过 300 MB");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export async function runLocalStickerOverlayJob(body, { jobId = "local", tempRoot = tmpdir(), fetchImpl = fetch } = {}) {
  const request = normalizeLocalStickerRequest(body);
  await mkdir(tempRoot, { recursive: true });
  const safeJobId = String(jobId).replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "local";
  const workDir = await mkdtemp(join(tempRoot, `wangzhuan-${safeJobId}-`));
  const inputPath = join(workDir, request.sourceType === "url" ? "input.mp4" : `input.${request.source.match(VIDEO_DATA_PATTERN)?.[1] === "webm" ? "webm" : "mp4"}`);
  const stickerMatch = request.stickerSource.match(STICKER_DATA_PATTERN);
  const stickerPath = stickerMatch ? join(workDir, `sticker.${stickerMatch[1] === "jpeg" || stickerMatch[1] === "jpg" ? "jpg" : stickerMatch[1]}`) : "";
  const outputPath = join(workDir, "output.mp4");
  try {
    const videoBuffer = request.sourceType === "url"
      ? await downloadLimited(request.source, MAX_VIDEO_BYTES, fetchImpl)
      : validateDataUrl(request.source, VIDEO_DATA_PATTERN, MAX_VIDEO_BYTES, "视频文件格式无效").buffer;
    await writeFile(inputPath, videoBuffer);
    if (stickerPath) await writeFile(stickerPath, validateDataUrl(request.stickerSource, STICKER_DATA_PATTERN, MAX_STICKER_BYTES, "贴纸仅支持 PNG、JPG 或 WebP 图片").buffer);
    const rendered = await renderLocalStickerVideo({ inputPath, stickerPath, outputPath, region: request.region, stickerScaleMode: request.stickerScaleMode });
    return {
      outputBuffer: await readFile(rendered.outputPath),
      result: {
        provider: "local_ffmpeg",
        has_sticker: request.hasSticker,
        sticker_scale_mode: request.stickerScaleMode,
        width: rendered.width,
        height: rendered.height,
        duration_sec: rendered.durationSec,
        region: rendered.region,
        sticker_size: rendered.stickerSize
      }
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
