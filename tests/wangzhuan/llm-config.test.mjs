import assert from "node:assert/strict";
import test from "node:test";

import { publicLlmConfig, resolveLlmConfig } from "../../server/wangzhuan/llm-config.mjs";

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
  assert.equal(resolveLlmConfig(config, { model: "GPT-5.4-mini" }).model, "gpt-5.4-mini");
  assert.equal(publicLlmConfig(config).llmConfig.model, "gpt-5.4");
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
