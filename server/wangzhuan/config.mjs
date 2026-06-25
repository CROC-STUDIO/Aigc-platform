import { DEFAULT_LIMITS } from "./constants.mjs";

export function effectiveLimits(config = {}) {
  return {
    ...DEFAULT_LIMITS,
    ...(config?.wangzhuan?.limits && typeof config.wangzhuan.limits === "object" ? config.wangzhuan.limits : {})
  };
}
