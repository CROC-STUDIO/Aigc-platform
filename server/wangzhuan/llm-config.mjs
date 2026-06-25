export const DEFAULT_LLM_CONFIG = Object.freeze({
  provider: "skylink",
  endpoint: "https://skylink-gateway.com/api/v1",
  model: "gemini-3.5-flash",
  temperature: 0.2,
  timeoutMs: 180000
});

export const DEFAULT_QC_LLM_CONFIG = Object.freeze({
  ...DEFAULT_LLM_CONFIG,
  model: "doubao-seed-2-0-lite-260428",
  preferVideoUrl: true
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

function cleanTimeoutMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 30000 && number <= 600000
    ? Math.trunc(number)
    : DEFAULT_LLM_CONFIG.timeoutMs;
}

function normalizeModel(provider, model) {
  const cleanModel = cleanString(model, DEFAULT_LLM_CONFIG.model);
  const cleanProvider = cleanString(provider).toLowerCase();
  if (cleanProvider === "skylink" && /^GPT-5\.4(?:-(?:mini|nano))?$/i.test(cleanModel)) {
    return cleanModel.toLowerCase();
  }
  return cleanModel;
}

export function llmUsesGeminiCompat(llmConfig = {}) {
  const provider = cleanString(llmConfig.provider).toLowerCase();
  const model = cleanString(llmConfig.model).toLowerCase();
  return provider === "gemini"
    || provider === "google"
    || model.startsWith("gemini-");
}

export function configuredApiKey(llm = {}) {
  const envName = configuredApiKeyEnv(llm);
  return cleanString(llm.apiKey)
    || cleanString(process.env[envName])
    || cleanString(process.env.WANGZHUAN_LLM_API_KEY)
    || cleanString(process.env.VIDEO_AIGC_API_KEY)
    || cleanString(process.env.OPENAI_API_KEY)
    || cleanString(process.env.OPENAI_KEY)
    || cleanString(process.env.REVERSE_PROMPT_API_KEY);
}

export function configuredApiKeyEnv(llm = {}) {
  return cleanString(llm.apiKeyEnv, "WANGZHUAN_LLM_API_KEY");
}

function mergeLlmSection(config = {}, sectionKey, defaults, overrides = {}) {
  const base = config?.wangzhuan?.[sectionKey] && typeof config.wangzhuan[sectionKey] === "object"
    ? config.wangzhuan[sectionKey]
    : {};
  const merged = {
    ...defaults,
    ...base,
    ...(overrides && typeof overrides === "object" ? overrides : {})
  };
  const provider = cleanString(merged.provider, defaults.provider);
  return {
    provider,
    endpoint: cleanString(merged.endpoint, defaults.endpoint).replace(/\/+$/, ""),
    model: normalizeModel(provider, merged.model || defaults.model),
    temperature: cleanTemperature(merged.temperature ?? defaults.temperature),
    timeoutMs: cleanTimeoutMs(merged.timeoutMs ?? defaults.timeoutMs),
    apiKeyEnv: configuredApiKeyEnv(merged),
    apiKey: configuredApiKey(merged),
    preferVideoUrl: merged.preferVideoUrl !== false && (
      merged.preferVideoUrl === true || /^doubao-seed/i.test(normalizeModel(provider, merged.model || defaults.model))
    )
  };
}

export function llmSupportsVideoUrl(llmConfig = {}) {
  if (llmUsesGeminiCompat(llmConfig)) return false;
  return llmConfig.preferVideoUrl === true;
}

export function llmUsesChatCompletionsForVideo(llmConfig = {}) {
  return llmSupportsVideoUrl(llmConfig);
}

export function resolveLlmConfig(config = {}, overrides = {}) {
  return mergeLlmSection(config, "llm", DEFAULT_LLM_CONFIG, overrides);
}

export function resolveQcLlmConfig(config = {}, overrides = {}) {
  const llm = config?.wangzhuan?.llm && typeof config.wangzhuan.llm === "object"
    ? config.wangzhuan.llm
    : {};
  const qc = config?.wangzhuan?.qcLlm && typeof config.wangzhuan.qcLlm === "object"
    ? config.wangzhuan.qcLlm
    : {};
  return mergeLlmSection(config, "qcLlm", {
    ...DEFAULT_QC_LLM_CONFIG,
    provider: llm.provider ?? DEFAULT_QC_LLM_CONFIG.provider,
    endpoint: llm.endpoint ?? DEFAULT_QC_LLM_CONFIG.endpoint,
    apiKeyEnv: llm.apiKeyEnv ?? DEFAULT_QC_LLM_CONFIG.apiKeyEnv,
    temperature: llm.temperature ?? DEFAULT_QC_LLM_CONFIG.temperature,
    timeoutMs: llm.timeoutMs ?? DEFAULT_QC_LLM_CONFIG.timeoutMs
  }, {
    ...qc,
    ...(overrides && typeof overrides === "object" ? overrides : {})
  });
}

function publicLlmConfigShape(llmConfig = {}) {
  return {
    provider: llmConfig.provider,
    endpoint: llmConfig.endpoint,
    model: llmConfig.model,
    temperature: llmConfig.temperature,
    timeoutMs: llmConfig.timeoutMs,
    apiKeyEnv: llmConfig.apiKeyEnv,
    hasApiKey: Boolean(llmConfig.apiKey),
    preferVideoUrl: llmSupportsVideoUrl(llmConfig)
  };
}

export function publicLlmConfig(config = {}) {
  const llmConfig = resolveLlmConfig(config);
  return {
    llmConfig: publicLlmConfigShape(llmConfig)
  };
}

export function publicQcLlmConfig(config = {}) {
  const llmConfig = resolveQcLlmConfig(config);
  return {
    qcLlmConfig: publicLlmConfigShape(llmConfig)
  };
}
