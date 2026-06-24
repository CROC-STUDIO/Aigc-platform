import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeDetectionRegions,
  summarizeDetection
} from "../../server/wangzhuan/remix-detection.mjs";

test("normalizeDetectionRegions preserves all seven capability keys", () => {
  const regions = normalizeDetectionRegions([
    { capabilityKey: "logo_icon", bbox: { x: 0.1, y: 0.1, width: 0.1, height: 0.1 } },
    { capabilityKey: "product_name", bbox: { x: 0.2, y: 0.2, width: 0.2, height: 0.1 } },
    { capabilityKey: "cta", bbox: { x: 0.3, y: 0.8, width: 0.4, height: 0.1 } },
    { capabilityKey: "ending", bbox: { x: 0.1, y: 0.7, width: 0.8, height: 0.2 } },
    { capabilityKey: "watermark", bbox: { x: 0.8, y: 0.05, width: 0.1, height: 0.05 } },
    { capabilityKey: "subtitle", bbox: { x: 0.1, y: 0.88, width: 0.8, height: 0.08 } },
    { capabilityKey: "phone_ui", bbox: { x: 0.15, y: 0.25, width: 0.7, height: 0.45 } }
  ]);
  assert.equal(regions.length, 7);
  assert.deepEqual(Object.keys(summarizeDetection(regions)).sort(), [
    "cta",
    "ending",
    "logo_icon",
    "phone_ui",
    "product_name",
    "subtitle",
    "watermark"
  ]);
});
