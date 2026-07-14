import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);
const ARABIC_DISCLAIMER = "تخضع المكافآت لقواعد التطبيق، والأهلية، وإكمال المهام، والتوافر حسب المنطقة. النتائج غير مضمونة.";
const COMMON_PRESETS = Object.freeze({
  es: "西班牙语",
  fr: "法语",
  de: "德语",
  id: "印尼语",
  th: "泰语",
  vi: "越南语"
});

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

test("current wangzhuan page exposes and auto-selects the Arabic disclaimer overlay", async () => {
  const [html, js] = await Promise.all([
    readText("public/wangzhuan-v2.html"),
    readText("public/wangzhuan-v2.js")
  ]);

  assert.match(html, /<option value="ar">阿拉伯语<\/option>/);
  assert.match(js, /if \(normalized\.startsWith\("ar"\)\) return "ar";/);
});

test("legacy wangzhuan page exposes and auto-selects the approved Arabic disclaimer", async () => {
  const [html, js] = await Promise.all([
    readText("public/wangzhuan.html"),
    readText("public/wangzhuan.js")
  ]);

  assert.match(html, /<option value="ar">阿拉伯语<\/option>/);
  assert.match(js, /ar:\s*"([^"]+)"/);
  assert.equal(js.match(/ar:\s*"([^"]+)"/)?.[1], ARABIC_DISCLAIMER);
  assert.match(js, /if \(value\.startsWith\("ar"\)\) return "ar";/);
});

test("both wangzhuan pages expose and auto-select all common disclaimer presets", async () => {
  const [currentHtml, currentJs, legacyHtml, legacyJs] = await Promise.all([
    readText("public/wangzhuan-v2.html"),
    readText("public/wangzhuan-v2.js"),
    readText("public/wangzhuan.html"),
    readText("public/wangzhuan.js")
  ]);

  for (const [preset, label] of Object.entries(COMMON_PRESETS)) {
    for (const html of [currentHtml, legacyHtml]) {
      assert.match(html, new RegExp(`<option value="${preset}">${label}<\\/option>`));
    }
    assert.match(currentJs, new RegExp(`startsWith\\("${preset}"\\)`));
    assert.match(legacyJs, new RegExp(`startsWith\\("${preset}"\\)`));
  }
  assert.match(currentJs, /\["en", "pt", "zh", "ar", "es", "fr", "de", "id", "th", "vi"\]\.includes\(key\)/);
});

test("current wangzhuan page refreshes the disclaimer preview when language changes", async () => {
  const js = await readText("public/wangzhuan-v2.js");

  assert.match(
    js,
    /els\.language\?\.addEventListener\("change", \(\) => \{\s*renderDisclaimerOverlayPreview\(\);\s*renderTasks\(\);\s*markPlanMaybeStale\(\);\s*\}\);/
  );
});
