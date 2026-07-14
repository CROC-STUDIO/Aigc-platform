import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { wangzhuanPaths, writeAtomicJson } from "./storage.mjs";

const PLAN_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_PROMPT_VERSION = "seedance_plan_v1";

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sha256(value) {
  return createHash("sha256").update(String(value || "")).digest("hex");
}

export function planCacheKey(input = {}) {
  const key = sha256(stableJson({
    decompositionHash: input.decompositionHash || sha256(stableJson(input.decomposition || {})),
    branchDraftSignature: input.branchDraftSignature || sha256(stableJson(input.branch || {})),
    sliceParams: input.sliceParams || {
      segmentIndex: input.segmentIndex,
      branchVariantIndex: input.branchVariantIndex,
      sliceDurationSec: input.sliceDurationSec,
      segmentRole: input.segmentRole,
      currentSlice: input.currentSlice || null
    },
    model: input.model || "",
    compact: Boolean(input.compact),
    planPromptVersion: input.planPromptVersion || PLAN_PROMPT_VERSION
  }));
  return key ? `plancache_${key}` : "";
}

function planCachePath(context, key) {
  if (!key) return "";
  return join(wangzhuanPaths(context).batchesDir, "_plan-cache", `${key}.json`);
}

export async function loadCachedPlan(context, key) {
  const target = planCachePath(context, key);
  if (!target) return null;
  try {
    const info = await stat(target);
    if (Date.now() - info.mtimeMs > PLAN_CACHE_TTL_MS) {
      await rm(target, { force: true });
      return null;
    }
    const parsed = JSON.parse(await readFile(target, "utf8"));
    return parsed?.plan || null;
  } catch {
    return null;
  }
}

export async function writeCachedPlan(context, key, plan) {
  const target = planCachePath(context, key);
  if (!target || !plan) return;
  await mkdir(join(wangzhuanPaths(context).batchesDir, "_plan-cache"), { recursive: true });
  await writeAtomicJson(target, {
    cacheKey: key,
    plan,
    updatedAt: new Date().toISOString()
  });
}
