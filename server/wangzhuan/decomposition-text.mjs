const DECOMPOSITION_NESTED_LABELS = Object.freeze({
  main: "主体",
  appearance: "外观",
  role: "角色",
  props: "道具",
  core: "核心",
  mainAction: "主要动作",
  shotType: "景别",
  framing: "构图",
  movement: "运镜",
  setup: "布光",
  mood: "氛围",
  environment: "环境",
  durationSec: "时长",
  format: "形式",
  resolution: "清晰度",
  firstSeconds: "开头"
});

function humanizeDecompositionKey(key) {
  return DECOMPOSITION_NESTED_LABELS[key]
    || String(key)
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .trim();
}

export function flattenDecompositionFieldValue(value, depth = 0) {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return "";
    if (depth === 0 && /^[\[{]/.test(trimmed)) {
      try {
        return flattenDecompositionFieldValue(JSON.parse(trimmed), depth + 1);
      } catch {
        return trimmed;
      }
    }
    return trimmed;
  }
  if (Array.isArray(value)) {
    return value
      .map((item) => flattenDecompositionFieldValue(item, depth + 1))
      .filter(Boolean)
      .join("、");
  }
  if (typeof value === "object") {
    const parts = [];
    for (const [key, nested] of Object.entries(value)) {
      const text = flattenDecompositionFieldValue(nested, depth + 1);
      if (!text) continue;
      const label = humanizeDecompositionKey(key);
      const known = Boolean(DECOMPOSITION_NESTED_LABELS[key]);
      const nestedIsObject = nested && typeof nested === "object" && !Array.isArray(nested);
      if (known || nestedIsObject) {
        parts.push(`${label}：${text}`);
      } else {
        parts.push(text);
      }
    }
    return parts.join("；");
  }
  return String(value).trim();
}
