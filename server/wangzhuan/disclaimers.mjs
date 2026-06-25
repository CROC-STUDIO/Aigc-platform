export const DISCLAIMER_PRESETS = Object.freeze({
  en: "Rewards are subject to in-app rules, eligibility, task completion, and regional availability. Results are not guaranteed.",
  pt: "As recompensas dependem das regras do app, elegibilidade, conclusão das tarefas e disponibilidade regional. Os resultados não são garantidos",
  zh: "奖励结果受 App 内活动规则、用户资格、任务完成情况、地区限制和活动时间影响，不保证每位用户都能获得相同奖励。"
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

export function buildDisclaimerByLanguage(languages = [], preset = "auto") {
  const source = Array.isArray(languages) ? languages : String(languages || "").split(",");
  const normalized = source.map((item) => String(item || "").trim()).filter(Boolean);
  const entries = normalized.length ? normalized : ["en-US"];
  return Object.fromEntries(entries.map((language) => [
    language,
    resolveDisclaimerText(language, preset)
  ]));
}
