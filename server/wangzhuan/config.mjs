import { DEFAULT_LIMITS } from "./constants.mjs";

export function effectiveLimits(config = {}) {
  const configured = config?.wangzhuan?.limits;
  const merged = configured && typeof configured === "object"
    ? { ...DEFAULT_LIMITS, ...configured }
    : { ...DEFAULT_LIMITS };
  const configuredMax = Number(merged.maxConcurrency);
  return {
    ...merged,
    maxConcurrency: Number.isInteger(configuredMax)
      ? Math.min(DEFAULT_LIMITS.maxConcurrency, Math.max(1, configuredMax))
      : DEFAULT_LIMITS.maxConcurrency
  };
}
