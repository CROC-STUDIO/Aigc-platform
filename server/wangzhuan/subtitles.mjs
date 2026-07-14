import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WangzhuanError } from "./http.mjs";

const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff]/u;
const CUE_BREAK = /[.!?。！？]/u;

export function normalizeSubtitlePostProcess(value) {
  const source = value && typeof value === "object" ? value : {};
  const fontSize = source.fontSize === undefined ? 30 : Number(source.fontSize);
  const centerY = source.centerY === undefined ? 1140 : Number(source.centerY);
  if (!Number.isInteger(fontSize) || fontSize < 12 || fontSize > 96) {
    throw new WangzhuanError("validation_error", "字幕字号需为 12-96 的整数", {
      field: "postProcess.subtitles.fontSize",
      fontSize: source.fontSize
    });
  }
  if (!Number.isInteger(centerY) || centerY < 0 || centerY > 1280) {
    throw new WangzhuanError("validation_error", "字幕中心 Y 坐标需为 0-1280 的整数", {
      field: "postProcess.subtitles.centerY",
      centerY: source.centerY
    });
  }
  return { enabled: source.enabled !== false, fontSize, centerY };
}

function cleanWord(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function displayUnits(text) {
  return [...String(text || "")].reduce((total, character) => total + (CJK_CHAR.test(character) ? 2 : 1), 0);
}

function cueText(words) {
  const text = words.map((word) => cleanWord(word.word)).filter(Boolean).join(" ");
  return text.replace(/([\u3400-\u9fff\uf900-\ufaff])\s+(?=[\u3400-\u9fff\uf900-\ufaff])/gu, "$1").trim();
}

export function buildTimedCueGroups(words = []) {
  const normalized = words
    .map((word) => ({
      word: cleanWord(word?.word),
      startSec: Number(word?.start),
      endSec: Number(word?.end)
    }))
    .filter((word) => word.word && Number.isFinite(word.startSec) && Number.isFinite(word.endSec));
  const cues = [];
  let group = [];
  for (const word of normalized) {
    const next = [...group, word];
    const text = cueText(next);
    const overLimit = next.length > 7 || displayUnits(text) > 34;
    if (group.length && overLimit) {
      cues.push({ startSec: group[0].startSec, endSec: group.at(-1).endSec, text: cueText(group) });
      group = [word];
      continue;
    }
    group = next;
    if (group.length >= 3 && CUE_BREAK.test(word.word)) {
      cues.push({ startSec: group[0].startSec, endSec: group.at(-1).endSec, text: cueText(group) });
      group = [];
    }
  }
  if (group.length) cues.push({ startSec: group[0].startSec, endSec: group.at(-1).endSec, text: cueText(group) });
  return cues.filter((cue) => cue.text && cue.endSec > cue.startSec);
}

function pad(value, length = 2) {
  return String(Math.max(0, Math.trunc(value))).padStart(length, "0");
}

function srtTimestamp(seconds) {
  const milliseconds = Math.round(Math.max(0, Number(seconds) || 0) * 1000);
  return `${pad(milliseconds / 3_600_000)}:${pad((milliseconds / 60_000) % 60)}:${pad((milliseconds / 1000) % 60)},${pad(milliseconds % 1000, 3)}`;
}

function assTimestamp(seconds) {
  const centiseconds = Math.round(Math.max(0, Number(seconds) || 0) * 100);
  return `${Math.trunc(centiseconds / 360000)}:${pad((centiseconds / 6000) % 60)}:${pad((centiseconds / 100) % 60)}.${pad(centiseconds % 100, 2)}`;
}

export function renderSrtSubtitles(cues = []) {
  return cues.map((cue, index) => `${index + 1}\n${srtTimestamp(cue.startSec)} --> ${srtTimestamp(cue.endSec)}\n${cue.text}\n`).join("\n");
}

function escapeAss(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
}

export function renderAssSubtitles(cues = [], canvas = {}) {
  const width = Number(canvas.width) > 0 ? Math.trunc(Number(canvas.width)) : 720;
  const height = Number(canvas.height) > 0 ? Math.trunc(Number(canvas.height)) : 1280;
  const referenceFontSize = Number(canvas.fontSize) > 0 ? Number(canvas.fontSize) : 30;
  const referenceCenterY = Number.isFinite(Number(canvas.centerY)) ? Number(canvas.centerY) : 1140;
  const scale = Math.min(width / 720, height / 1280);
  const fontSize = Math.max(1, Math.round(referenceFontSize * scale));
  const outline = Math.max(1, Math.round(3 * scale));
  const lineStep = Math.max(1, Math.round((referenceFontSize + 10) * scale));
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height * (referenceCenterY / 1280));
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,DejaVu Sans,${fontSize},&H00FFFFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const events = cues.flatMap((cue) => {
    const lines = String(cue.text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const firstY = centerY - ((lines.length - 1) * lineStep) / 2;
    return lines.map((line, index) => `Dialogue: 0,${assTimestamp(cue.startSec)},${assTimestamp(cue.endSec)},Default,,0,0,0,,{\\an5\\pos(${centerX},${Math.round(firstY + index * lineStep)})}${escapeAss(line)}`);
  });
  return header + events.join("\n") + "\n";
}

function extractVolcengineWords(result = {}) {
  return (Array.isArray(result?.result?.utterances) ? result.result.utterances : []).flatMap((utterance) => {
    if (Array.isArray(utterance?.words) && utterance.words.length) {
      return utterance.words.map((word) => ({ word: word.text, start: Number(word.start_time) / 1000, end: Number(word.end_time) / 1000 }));
    }
    return [{ word: utterance?.text, start: Number(utterance?.start_time) / 1000, end: Number(utterance?.end_time) / 1000 }];
  });
}

export async function writeVolcengineSubtitleArtifacts(result, outputDir, canvas = {}) {
  await mkdir(outputDir, { recursive: true });
  const cues = buildTimedCueGroups(extractVolcengineWords(result));
  if (!cues.length) throw new Error("火山语音未识别到可用口播字幕");
  const transcriptPath = join(outputDir, "transcript.json");
  const srtPath = join(outputDir, "captions.srt");
  const assPath = join(outputDir, "captions.ass");
  await Promise.all([writeFile(transcriptPath, JSON.stringify(result, null, 2), "utf8"), writeFile(srtPath, renderSrtSubtitles(cues), "utf8"), writeFile(assPath, renderAssSubtitles(cues, canvas), "utf8")]);
  return { transcriptPath, srtPath, assPath, cueCount: cues.length };
}
