import { DEFAULT_CHANNEL_RULES } from "./constants.mjs";

export const DISCLAIMER_PRESETS = Object.freeze({
  en: "Rewards are subject to in-app rules, eligibility, task completion, and regional availability. Results are not guaranteed.",
  pt: "As recompensas dependem das regras do app, elegibilidade, conclusão das tarefas e disponibilidade regional. Os resultados não são garantidos",
  zh: "奖励结果受 App 内活动规则、用户资格、任务完成情况、地区限制和活动时间影响，不保证每位用户都能获得相同奖励"
});

export function resolveDisclaimerPreset(language = "", preset = "auto") {
  const selected = String(preset || "auto").trim();
  if (selected && selected !== "auto" && DISCLAIMER_PRESETS[selected]) return selected;
  const value = String(language || "").trim().toLowerCase();
  if (value.startsWith("pt")) return "pt";
  if (value.startsWith("zh") || value.includes("chinese")) return "zh";
  return "en";
}

export function resolveDisclaimerText(language = "", preset = "auto") {
  return DISCLAIMER_PRESETS[resolveDisclaimerPreset(language, preset)] || DISCLAIMER_PRESETS.en;
}

export function requiredDisclaimersForChannel(channel = "generic", promiseLevel = "stable") {
  const normalizedChannel = String(channel || "generic").trim() || "generic";
  const normalizedPromiseLevel = String(promiseLevel || "stable").trim() || "stable";
  return [...new Set(
    DEFAULT_CHANNEL_RULES
      .filter((rule) => rule.channel === normalizedChannel && rule.promiseLevel === normalizedPromiseLevel)
      .flatMap((rule) => rule.requiredDisclaimers || [])
  )];
}

export function mergeDisclaimerWithChannelRequirements(
  baseText = "",
  channel = "generic",
  promiseLevel = "stable",
  extraRequired = []
) {
  let text = String(baseText || "").trim();
  const required = [
    ...requiredDisclaimersForChannel(channel, promiseLevel),
    ...(Array.isArray(extraRequired) ? extraRequired : [])
  ];
  for (const item of required) {
    const needle = String(item || "").trim();
    if (!needle) continue;
    if (text.toLowerCase().includes(needle.toLowerCase())) continue;
    text = text ? `${text} ${needle}` : needle;
  }
  return text;
}

export function buildDisclaimerByLanguage(languages = [], preset = "auto") {
  const source = Array.isArray(languages) ? languages : String(languages || "").split(",");
  const normalized = source.map((item) => String(item || "").trim()).filter(Boolean);
  const entries = normalized.length ? normalized : ["en-US"];
  return Object.fromEntries(entries.map((language) => [
    language,
    resolveDisclaimerText(language, preset)
  ]));
}

export function resolveEffectiveDisclaimer({
  language = "",
  preset = "auto",
  customText = "",
  targetChannel = "generic",
  promiseLevel = "stable"
} = {}) {
  const manual = String(customText || "").trim();
  const base = manual || resolveDisclaimerText(language, preset);
  return mergeDisclaimerWithChannelRequirements(base, targetChannel, promiseLevel);
}

export function buildEffectiveDisclaimerByLanguage(
  languages = [],
  {
    preset = "auto",
    customByLanguage = null,
    customText = "",
    targetChannel = "generic",
    promiseLevel = "stable"
  } = {}
) {
  const source = Array.isArray(languages) ? languages : String(languages || "").split(",");
  const normalized = source.map((item) => String(item || "").trim()).filter(Boolean);
  const entries = normalized.length ? normalized : ["en-US"];
  const customMap = customByLanguage && typeof customByLanguage === "object" ? customByLanguage : {};
  return Object.fromEntries(entries.map((language) => {
    const customValue = String(customMap[language] || "").trim();
    return [language, resolveEffectiveDisclaimer({
      language,
      preset,
      customText: customValue || customText,
      targetChannel,
      promiseLevel
    })];
  }));
}
