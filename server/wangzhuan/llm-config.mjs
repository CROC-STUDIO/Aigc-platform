export const DEFAULT_LLM_CONFIG = Object.freeze({
  provider: "skylink",
  endpoint: "https://skylink-gateway.com/api/v1",
  model: "gpt-5.4",
  temperature: 0.2
});

function cleanString(value, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function cleanTemperature(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 2
    ? number
    : DEFAULT_LLM_CONFIG.temperature;
}

function normalizeModel(provider, model) {
  const cleanModel = cleanString(model, DEFAULT_LLM_CONFIG.model);
  const cleanProvider = cleanString(provider).toLowerCase();
  if (cleanProvider === "skylink" && /^GPT-5\.4(?:-(?:mini|nano))?$/i.test(cleanModel)) {
    return cleanModel.toLowerCase();
  }
  return cleanModel;
}

export function configuredApiKey(llm = {}) {
  const envName = cleanString(llm.apiKeyEnv, "WANGZHUAN_LLM_API_KEY");
  return cleanString(llm.apiKey)
    || cleanString(process.env[envName])
    || cleanString(process.env.WANGZHUAN_LLM_API_KEY)
    || cleanString(process.env.VIDEO_AIGC_API_KEY)
    || cleanString(process.env.OPENAI_API_KEY)
    || cleanString(process.env.OPENAI_KEY)
    || cleanString(process.env.REVERSE_PROMPT_API_KEY);
}

export function resolveLlmConfig(config = {}, overrides = {}) {
  const llm = config?.wangzhuan?.llm && typeof config.wangzhuan.llm === "object"
    ? config.wangzhuan.llm
    : {};
  const merged = {
    ...llm,
    ...(overrides && typeof overrides === "object" ? overrides : {})
  };
  const provider = cleanString(merged.provider, DEFAULT_LLM_CONFIG.provider);
  return {
    provider,
    endpoint: cleanString(merged.endpoint, DEFAULT_LLM_CONFIG.endpoint).replace(/\/+$/, ""),
    model: normalizeModel(provider, merged.model),
    temperature: cleanTemperature(merged.temperature),
    apiKey: configuredApiKey(merged)
  };
}

export function publicLlmConfig(config = {}) {
  const llmConfig = resolveLlmConfig(config);
  return {
    llmConfig: {
      provider: llmConfig.provider,
      endpoint: llmConfig.endpoint,
      model: llmConfig.model,
      temperature: llmConfig.temperature,
      hasApiKey: Boolean(llmConfig.apiKey)
    }
  };
}
