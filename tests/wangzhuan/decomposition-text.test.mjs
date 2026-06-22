import assert from "node:assert/strict";
import test from "node:test";

import { flattenDecompositionFieldValue } from "../../server/wangzhuan/decomposition-text.mjs";

test("flattenDecompositionFieldValue turns nested llm objects into readable prose", () => {
  assert.equal(
    flattenDecompositionFieldValue({
      main: "一位职业化女主播正对镜头口播",
      appearance: "短发、职业装"
    }),
    "主体：一位职业化女主播正对镜头口播；外观：短发、职业装"
  );
  assert.equal(
    flattenDecompositionFieldValue({ core: "全片为单人对镜播报，人物持续口型输出" }),
    "核心：全片为单人对镜播报，人物持续口型输出"
  );
  assert.equal(
    flattenDecompositionFieldValue({ shotType: "中近景到胸像构图，轻微推进" }),
    "景别：中近景到胸像构图，轻微推进"
  );
  assert.equal(
    flattenDecompositionFieldValue({ setup: "演播室标准三点布光风格" }),
    "布光：演播室标准三点布光风格"
  );
});

test("flattenDecompositionFieldValue parses json strings saved by older drafts", () => {
  const flattened = flattenDecompositionFieldValue('{"main":"口播主播","appearance":"短发"}');
  assert.equal(flattened, "主体：口播主播；外观：短发");
  assert.doesNotMatch(flattened, /^[\[{]/);
});

test("flattenDecompositionFieldValue joins arrays with顿号", () => {
  assert.equal(
    flattenDecompositionFieldValue({ props: ["phone", "reward cue"] }),
    "道具：phone、reward cue"
  );
});
