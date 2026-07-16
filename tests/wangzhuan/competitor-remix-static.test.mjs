import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../../", import.meta.url);

async function readText(path) {
  return readFile(new URL(path, root), "utf8");
}

test("competitor remix uses a semantic three-column workbench", async () => {
  const html = await readText("public/competitor-remix.html");

  assert.match(html, /id="competitorRemixApp"/);
  assert.match(html, /id="remixCapabilityNav"/);
  assert.match(html, /id="remixWorkspace"/);
  assert.match(html, /id="remixRunRail"/);
  assert.match(html, /id="remixDropzone"/);
  assert.match(html, /id="remixEditorSurface"/);
  assert.match(html, /id="remixReadiness"/);
  assert.match(html, /href="\/competitor-remix\.css/);
  assert.doesNotMatch(html, /id="remixCanvas"/);
  assert.doesNotMatch(html, /id="remixStepbar"/);
  assert.doesNotMatch(html, /id="videoOpsTaskGrid"/);
  assert.doesNotMatch(html, /wz-canvas-links/);
});

test("competitor remix bootstrap only composes dedicated modules", async () => {
  const js = await readText("public/competitor-remix.js");

  assert.match(js, /from "\.\/competitor-remix\/store\.js"/);
  assert.match(js, /from "\.\/competitor-remix\/media-workspace\.js"/);
  assert.match(js, /from "\.\/competitor-remix\/job-runner\.js"/);
  assert.match(js, /from "\.\/competitor-remix\/view\.js"/);
  assert.match(js, /createRemixStore/);
  assert.match(js, /createMediaWorkspace/);
  assert.match(js, /createJobRunner/);
  assert.match(js, /createRemixView/);
  assert.doesNotMatch(js, /const TASKS =/);
  assert.doesNotMatch(js, /function buildParams/);
  assert.doesNotMatch(js, /function bindPromptSurface/);
});

test("competitor remix stylesheet owns responsive capability and run rails", async () => {
  const css = await readText("public/competitor-remix.css");

  assert.match(css, /\.remix-shell\s*\{/);
  assert.match(css, /grid-template-columns:\s*minmax\(210px, 250px\) minmax\(0, 1fr\) minmax\(280px, 340px\)/);
  assert.match(css, /\.remix-capabilities/);
  assert.match(css, /\.remix-workspace/);
  assert.match(css, /\.remix-runs/);
  assert.match(css, /@media \(max-width: 760px\)/);
  assert.match(css, /touch-action:\s*none/);
  assert.match(css, /\.remix-file-row\[hidden\][^{]*\{[^}]*display:\s*none/);
  assert.match(css, /\.remix-advanced:not\(\[open\]\)\s*>\s*\.remix-form-grid\s*\{[^}]*display:\s*none/);
});

test("competitor remix view exposes drop, editor, submit, and per-run actions", async () => {
  const js = await readText("public/competitor-remix/view.js");

  assert.match(js, /dragover/);
  assert.match(js, /drop/);
  assert.match(js, /createRegionEditor/);
  assert.match(js, /prepareInput/);
  assert.match(js, /runner\.submit/);
  assert.match(js, /runner\.cancel/);
  assert.match(js, /runner\.retry/);
  assert.match(js, /runner\.loadResult/);
  assert.match(js, /buildManualMaskDataUrl/);
});

test("competitor remix keeps provider and tuning parameters in collapsed advanced settings", async () => {
  const js = await readText("public/competitor-remix/view.js");

  assert.match(js, /function advanced\(content\)[\s\S]*<details class="remix-advanced">/);
  assert.doesNotMatch(js, /<details class="remix-advanced" open/);
  assert.match(js, /modeId === "seedance"\) \{[\s\S]*?return `<div class="remix-form">\$\{advanced\(`/);
  assert.match(js, /if \(capabilityId === "ending"\) \{[\s\S]*?return `<div class="remix-form">\$\{advanced\(`/);
  assert.match(js, /\$\{advanced\(`\$\{field\("模糊强度"/);
});
