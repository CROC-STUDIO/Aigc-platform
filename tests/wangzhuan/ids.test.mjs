import assert from "node:assert/strict";
import test from "node:test";

import {
  makeRequestId,
  makeTemplateId,
  makeTemplateVersionId,
  makeTimestampId,
  normalizeSlug
} from "../../server/wangzhuan/ids.mjs";

test("normalizes human names into stable ASCII slugs", () => {
  assert.equal(normalizeSlug("Cash Reward US EN"), "cash_reward_us_en");
  assert.equal(normalizeSlug("  $$$  "), "template");
});

test("generates contract-shaped request and timestamp IDs", () => {
  assert.match(makeRequestId(), /^req_\d{14}_[a-f0-9]{4}$/);
  assert.match(makeTimestampId("wzb"), /^wzb_\d{14}_[a-f0-9]{4}$/);
});

test("generates template IDs and immutable version IDs", () => {
  assert.equal(makeTemplateId("Cash Reward US EN", 3), "tpl_cash_reward_us_en_003");
  assert.equal(makeTemplateVersionId("tpl_cash_reward_us_en_003", 12), "tplv_cash_reward_us_en_003_0012");
});
