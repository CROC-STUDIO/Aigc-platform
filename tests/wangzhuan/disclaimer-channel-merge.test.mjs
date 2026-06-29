import test from "node:test";
import assert from "node:assert/strict";

import {
  mergeDisclaimerWithChannelRequirements,
  requiredDisclaimersForChannel,
  resolveEffectiveDisclaimer
} from "../../server/wangzhuan/disclaimers.mjs";

test("requiredDisclaimersForChannel returns meta strong_conversion disclaimer", () => {
  assert.deepEqual(
    requiredDisclaimersForChannel("meta_ads", "strong_conversion"),
    ["Rewards vary by eligibility"]
  );
});

test("mergeDisclaimerWithChannelRequirements appends missing channel disclaimer", () => {
  const base = "Rewards are subject to in-app rules, eligibility, task completion, and regional availability. Results are not guaranteed.";
  const merged = mergeDisclaimerWithChannelRequirements(base, "meta_ads", "strong_conversion");
  assert.match(merged, /Rewards vary by eligibility/);
  assert.match(merged, /Results are not guaranteed/);
});

test("mergeDisclaimerWithChannelRequirements is idempotent", () => {
  const once = mergeDisclaimerWithChannelRequirements("Rewards vary by eligibility", "meta_ads", "strong_conversion");
  const twice = mergeDisclaimerWithChannelRequirements(once, "meta_ads", "strong_conversion");
  assert.equal(once, twice);
});

test("resolveEffectiveDisclaimer merges channel requirements for auto preset", () => {
  const text = resolveEffectiveDisclaimer({
    language: "en-US",
    preset: "auto",
    targetChannel: "meta_ads",
    promiseLevel: "strong_conversion"
  });
  assert.match(text, /Rewards vary by eligibility/);
  assert.match(text, /Results are not guaranteed/);
});
