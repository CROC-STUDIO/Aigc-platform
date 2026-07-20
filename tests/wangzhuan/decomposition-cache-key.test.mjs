import assert from "node:assert/strict";
import test from "node:test";

import {
  DECOMPOSITION_PROMPT_VERSION,
  decompositionCacheKey
} from "../../server/wangzhuan/reference-videos.mjs";

test("decomposition cache version includes continuity and narrative pacing contracts", () => {
  assert.equal(DECOMPOSITION_PROMPT_VERSION, "fission_decomposition_v5_narrative_pacing");
});

test("decomposition cache key differs when knowledgeNotes changes", () => {
  const probe = { fileHash: "abc" };
  const llmConfig = { provider: "skylink", model: "gemini-3.5-flash" };
  const key1 = decompositionCacheKey(probe, { knowledgeNotes: "老规则" }, llmConfig);
  const key2 = decompositionCacheKey(probe, { knowledgeNotes: "新规则" }, llmConfig);
  assert.notEqual(key1, key2);
});

test("decomposition cache key ignores knowledgeNotes whitespace-only changes", () => {
  const probe = { fileHash: "abc" };
  const llmConfig = { provider: "skylink", model: "gemini-3.5-flash" };
  const key1 = decompositionCacheKey(probe, { knowledgeNotes: "规则A\n\n规则B" }, llmConfig);
  const key2 = decompositionCacheKey(probe, { knowledgeNotes: "规则A 规则B" }, llmConfig);
  assert.equal(key1, key2);
});

test("decomposition cache key treats empty knowledgeNotes consistently", () => {
  const probe = { fileHash: "abc" };
  const llmConfig = { provider: "skylink", model: "gemini-3.5-flash" };
  const key1 = decompositionCacheKey(probe, {}, llmConfig);
  const key2 = decompositionCacheKey(probe, { knowledgeNotes: "" }, llmConfig);
  assert.equal(key1, key2);
});
