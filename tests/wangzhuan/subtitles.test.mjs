import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  buildTimedCueGroups,
  normalizeSubtitlePostProcess,
  renderAssSubtitles,
  renderSrtSubtitles
} from "../../server/wangzhuan/subtitles.mjs";

test("subtitle post-process defaults to enabled and accepts an explicit opt-out", () => {
  assert.deepEqual(normalizeSubtitlePostProcess(), { enabled: true, fontSize: 30, centerY: 1140 });
  assert.deepEqual(normalizeSubtitlePostProcess({ enabled: false }), { enabled: false, fontSize: 30, centerY: 1140 });
});

test("ASR word timestamps are split into short subtitle cues", () => {
  const cues = buildTimedCueGroups([
    { word: "这是", start: 0, end: 0.2 },
    { word: "一段", start: 0.2, end: 0.4 },
    { word: "很长", start: 0.4, end: 0.6 },
    { word: "的口播", start: 0.6, end: 0.9 },
    { word: "字幕", start: 0.9, end: 1.1 },
    { word: "内容", start: 1.1, end: 1.3 },
    { word: "需要", start: 1.3, end: 1.5 },
    { word: "拆分", start: 1.5, end: 1.7 },
    { word: "避免", start: 1.7, end: 1.9 },
    { word: "文字", start: 1.9, end: 2.1 },
    { word: "过多。", start: 2.1, end: 2.4 }
  ]);

  assert.ok(cues.length > 1);
  assert.equal(cues[0].startSec, 0);
  assert.equal(cues.at(-1).endSec, 2.4);
  assert.ok(cues.every((cue) => cue.text.length <= 20));
  assert.ok(cues.every((cue, index) => index === 0 || cue.startSec >= cues[index - 1].endSec));
});

test("SRT and ASS render timestamped cues with the lower-third subtitle position", () => {
  const cues = [{ startSec: 1.2, endSec: 2.8, text: "字幕测试" }];
  assert.match(renderSrtSubtitles(cues), /00:00:01,200 --> 00:00:02,800/);
  const ass = renderAssSubtitles(cues, { width: 720, height: 1280 });
  assert.match(ass, /PlayResX: 720/);
  assert.match(ass, /PlayResY: 1280/);
  assert.match(ass, /DejaVu Sans,30,/);
  assert.match(ass, /&H00000000/);
  assert.match(ass, /,1,3,0,5,/);
  assert.match(ass, /\\pos\(360,1140\)/);
  assert.match(ass, /字幕测试/);
});

test("ASS subtitles scale a selected reference font size and center Y to the actual canvas", () => {
  const ass = renderAssSubtitles([
    { startSec: 0, endSec: 1, text: "custom style" }
  ], { width: 1080, height: 1920, fontSize: 36, centerY: 1000 });
  assert.match(ass, /PlayResX: 1080/);
  assert.match(ass, /DejaVu Sans,54,/);
  assert.match(ass, /\\pos\(540,1500\)/);
});

test("ASR cue grouping permits up to 34 display characters but no more than 7 words", () => {
  const words = Array.from({ length: 8 }, (_, index) => ({
    word: String.fromCharCode(97 + index),
    start: index,
    end: index + 0.5
  }));
  const cues = buildTimedCueGroups(words);
  assert.equal(cues[0].text.split(" ").length, 7);
  assert.equal(cues[1].text, "h");

  const exact34 = [{ word: "1234567890123456789012345678901234", start: 0, end: 1 }];
  assert.equal(buildTimedCueGroups(exact34)[0].text.length, 34);
});

test("two-line ASS subtitles use 10px line spacing and stay centered around y 1140", () => {
  const ass = renderAssSubtitles([
    { startSec: 0, endSec: 1, text: "first line\nsecond line" }
  ], { width: 720, height: 1280 });
  assert.match(ass, /\\pos\(360,1120\).*first line/);
  assert.match(ass, /\\pos\(360,1160\).*second line/);
});

test("production image does not retain the local Whisper runtime after moving transcription to an API", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.doesNotMatch(dockerfile, /python3-pip/);
  assert.doesNotMatch(dockerfile, /openai-whisper==/);
});
