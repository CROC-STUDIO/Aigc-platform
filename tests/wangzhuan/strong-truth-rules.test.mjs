import assert from "node:assert/strict";
import test from "node:test";

import { hasAnyStrongTruthRule } from "../../server/wangzhuan/constants.mjs";

test("strong commitment truth rules only require one non-empty configured field", () => {
  assert.equal(hasAnyStrongTruthRule({}), false);
  assert.equal(hasAnyStrongTruthRule({ rewardAmountRange: "" }), false);
  assert.equal(hasAnyStrongTruthRule({ rewardCondition: "eligible completed tasks only" }), true);
});
