import { mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_LOCK_DIR = join(tmpdir(), "aigc-platform-ffmpeg.lock");
const DEFAULT_STALE_MS = 120000;
let active = 0;
const waiters = [];

function maxConcurrency() {
  const value = Number(process.env.AIGC_FFMPEG_MAX_CONCURRENCY || 1);
  return Number.isInteger(value) && value > 0 ? value : 1;
}

function lockDir() {
  return String(process.env.AIGC_FFMPEG_LOCK_DIR || DEFAULT_LOCK_DIR);
}

function staleAfterMs() {
  const value = Number(process.env.AIGC_FFMPEG_LOCK_STALE_MS || DEFAULT_STALE_MS);
  return Number.isFinite(value) && value >= 30000 ? value : DEFAULT_STALE_MS;
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireSharedLock() {
  const target = lockDir();
  while (true) {
    try {
      await mkdir(target);
      await writeFile(join(target, "owner"), `${process.pid}\n`, "utf8");
      let stopped = false;
      const heartbeat = setInterval(() => {
        if (!stopped) void utimes(target, new Date(), new Date()).catch(() => {});
      }, Math.max(10000, Math.floor(staleAfterMs() / 3)));
      heartbeat.unref?.();
      return async () => {
        stopped = true;
        clearInterval(heartbeat);
        await rm(target, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const info = await stat(target);
        if (Date.now() - info.mtimeMs > staleAfterMs()) {
          await rm(target, { recursive: true, force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code !== "ENOENT") throw statError;
      }
      await sleep(250);
    }
  }
}

async function acquire() {
  if (active >= maxConcurrency()) {
    await new Promise((resolve) => waiters.push(resolve));
  }
  active += 1;
  const releaseShared = await acquireSharedLock();
  return async () => {
    await releaseShared();
    active -= 1;
    waiters.shift()?.();
  };
}

export async function runFfmpeg(args, options = {}) {
  const release = await acquire();
  try {
    return await execFileAsync("ffmpeg", args, options);
  } finally {
    await release();
  }
}

export function ffmpegRuntimeConfig() {
  return {
    maxConcurrency: maxConcurrency(),
    lockDir: lockDir(),
    videoEncoder: String(process.env.AIGC_FFMPEG_VIDEO_ENCODER || "libx264").trim() || "libx264",
    hardwareAcceleration: String(process.env.AIGC_FFMPEG_HWACCEL || "none").trim() || "none"
  };
}
