import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  buildTimedCueGroups,
  markSimilarShortPhraseHighlights,
  normalizeSubtitlePostProcess,
  renderAssSubtitles,
  renderSrtSubtitles,
  writeVolcengineSubtitleArtifacts
} from "../../server/wangzhuan/subtitles.mjs";

test("subtitle post-process defaults to enabled and accepts an explicit opt-out", () => {
  assert.deepEqual(normalizeSubtitlePostProcess(), { enabled: true, fontSize: 40, centerY: 960, textColor: "white" });
  assert.deepEqual(normalizeSubtitlePostProcess({ enabled: false }), { enabled: false, fontSize: 40, centerY: 960, textColor: "white" });
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
  assert.match(ass, /DejaVu Sans,40,/);
  assert.match(ass, /&H00000000/);
  assert.match(ass, /,1,3,0,5,/);
  assert.match(ass, /\\pos\(360,960\)/);
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

test("ASR cue grouping keeps ad-style captions short with no more than 7 words", () => {
  const words = Array.from({ length: 8 }, (_, index) => ({
    word: String.fromCharCode(97 + index),
    start: index * 0.2,
    end: index * 0.2 + 0.15
  }));
  const cues = buildTimedCueGroups(words);
  assert.equal(cues[0].text.split(" ").length, 7);
  assert.equal(cues[1].text, "h");

  const exact24 = [{ word: "123456789012345678901234", start: 0, end: 1 }];
  assert.equal(buildTimedCueGroups(exact24)[0].text.length, 24);
});

test("ASR cue grouping breaks on obvious speech pauses", () => {
  const cues = buildTimedCueGroups([
    { word: "First", start: 0, end: 0.2 },
    { word: "part", start: 0.2, end: 0.42 },
    { word: "Second", start: 1.05, end: 1.3 },
    { word: "part", start: 1.3, end: 1.55 }
  ]);

  assert.deepEqual(cues.map((cue) => cue.text), ["First part", "Second part"]);
  assert.equal(cues[0].endSec, 0.42);
  assert.equal(cues[1].startSec, 1.05);
});

test("similar short subtitle phrases can be highlighted as white text on yellow background", () => {
  const cues = markSimilarShortPhraseHighlights([
    { startSec: 0, endSec: 1, text: "Tap and earn" },
    { startSec: 2, endSec: 3, text: "Tap and earn now" },
    { startSec: 4, endSec: 5, text: "Cash out your rewards" }
  ]);

  assert.equal(cues[0].highlight, true);
  assert.equal(cues[1].highlight, true);
  assert.equal(cues[2].highlight, undefined);

  const ass = renderAssSubtitles(cues, { width: 720, height: 1280 });
  assert.match(ass, /Style: Highlight,DejaVu Sans,40,&H00FFFFFF,&H000000FF,&H0000D7FF/);
  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:01.00,Highlight,.*Tap and earn/);
  assert.match(ass, /Dialogue: 0,0:00:04.00,0:00:05.00,Default,.*Cash out your rewards/);
});

test("ASS rendering can auto-highlight repeated similar short phrases", () => {
  const ass = renderAssSubtitles([
    { startSec: 0, endSec: 1, text: "Look at this" },
    { startSec: 2, endSec: 3, text: "Look at this now" }
  ], { width: 720, height: 1280, highlightSimilarShortPhrases: true });

  assert.match(ass, /Dialogue: 0,0:00:00.00,0:00:01.00,Highlight,.*Look at this/);
  assert.match(ass, /Dialogue: 0,0:00:02.00,0:00:03.00,Highlight,.*Look at this now/);
});

test("Volcengine utterance boundaries are kept as subtitle boundaries", async () => {
  const outputDir = await mkdtemp(join(tmpdir(), "wz-subtitles-"));
  try {
    await writeVolcengineSubtitleArtifacts({
      result: {
        utterances: [
          {
            start_time: 0,
            end_time: 500,
            words: [
              { text: "First", start_time: 0, end_time: 200 },
              { text: "sentence", start_time: 200, end_time: 500 }
            ]
          },
          {
            start_time: 520,
            end_time: 900,
            words: [
              { text: "Second", start_time: 520, end_time: 700 },
              { text: "sentence", start_time: 700, end_time: 900 }
            ]
          }
        ]
      }
    }, outputDir);

    const srt = await readFile(join(outputDir, "captions.srt"), "utf8");
    assert.match(srt, /First sentence/);
    assert.match(srt, /Second sentence/);
    assert.doesNotMatch(srt, /First sentence Second sentence/);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test("two-line ASS subtitles use 10px line spacing and stay centered around y 960", () => {
  const ass = renderAssSubtitles([
    { startSec: 0, endSec: 1, text: "first line\nsecond line" }
  ], { width: 720, height: 1280 });
  assert.match(ass, /\\pos\(360,935\).*first line/);
  assert.match(ass, /\\pos\(360,985\).*second line/);
});

test("ASS subtitles can render yellow text for viral ad style", () => {
  const ass = renderAssSubtitles([
    { startSec: 0, endSec: 1, text: "Tap and earn!" }
  ], { width: 720, height: 1280, textColor: "yellow" });
  assert.match(ass, /DejaVu Sans,40,&H002ED9FF/);
});

test("production image does not retain the local Whisper runtime after moving transcription to an API", async () => {
  const dockerfile = await readFile(new URL("../../Dockerfile", import.meta.url), "utf8");
  assert.doesNotMatch(dockerfile, /python3-pip/);
  assert.doesNotMatch(dockerfile, /openai-whisper==/);
});
