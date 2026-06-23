import assert from "node:assert/strict";
import test from "node:test";

import { publicLlmConfig, publicQcLlmConfig, resolveLlmConfig, resolveQcLlmConfig } from "../../server/wangzhuan/llm-config.mjs";

test("normalizes Skylink GPT model ids to the lowercase ids returned by /models", () => {
  const config = {
    wangzhuan: {
      llm: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "GPT-5.4"
      }
    }
  };

  assert.equal(resolveLlmConfig(config).model, "gpt-5.4");
  assert.equal(resolveLlmConfig(config).apiKeyEnv, "WANGZHUAN_LLM_API_KEY");
  assert.equal(resolveLlmConfig(config, { model: "GPT-5.4-mini" }).model, "gpt-5.4-mini");
  assert.equal(publicLlmConfig(config).llmConfig.model, "gpt-5.4");
  assert.equal(publicLlmConfig(config).llmConfig.apiKeyEnv, "WANGZHUAN_LLM_API_KEY");
});

test("keeps non-Skylink model ids case-sensitive", () => {
  const config = {
    wangzhuan: {
      llm: {
        provider: "openai",
        endpoint: "https://api.openai.com/v1",
        model: "GPT-5.4"
      }
    }
  };

  assert.equal(resolveLlmConfig(config).model, "GPT-5.4");
});

test("resolves QC llm defaults to doubao seed with video URL preference", () => {
  const config = {
    wangzhuan: {
      llm: {
        provider: "skylink",
        endpoint: "https://skylink-gateway.com/api/v1",
        model: "gpt-5.4"
      }
    }
  };

  const qc = resolveQcLlmConfig(config);
  assert.equal(qc.model, "doubao-seed-2-0-lite-260428");
  assert.equal(qc.preferVideoUrl, true);
  assert.equal(publicQcLlmConfig(config).qcLlmConfig.model, "doubao-seed-2-0-lite-260428");
  assert.equal(publicQcLlmConfig(config).qcLlmConfig.preferVideoUrl, true);
});
