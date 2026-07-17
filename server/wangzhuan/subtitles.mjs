import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { WangzhuanError } from "./http.mjs";

const CJK_CHAR = /[\u3400-\u9fff\uf900-\ufaff]/u;
const CUE_BREAK = /[.!?。！？]/u;
const DEFAULT_PAUSE_BREAK_SEC = 0.45;
const SUBTITLE_COLORS = new Set(["white", "yellow"]);
const ASS_COLORS = Object.freeze({
  white: "&H00FFFFFF",
  yellow: "&H002ED9FF"
});
const ASS_HIGHLIGHT_BACKGROUND = "&H0000D7FF";

function normalizeSubtitleColor(value) {
  const color = String(value || "white").trim().toLowerCase();
  if (SUBTITLE_COLORS.has(color)) return color;
  throw new WangzhuanError("validation_error", "字幕颜色仅支持 white 或 yellow", {
    field: "postProcess.subtitles.textColor",
    textColor: value
  });
}

export function normalizeSubtitlePostProcess(value) {
  const source = value && typeof value === "object" ? value : {};
  const fontSize = source.fontSize === undefined ? 40 : Number(source.fontSize);
  const centerY = source.centerY === undefined ? 960 : Number(source.centerY);
  const textColor = normalizeSubtitleColor(source.textColor);
  if (!Number.isInteger(fontSize) || fontSize < 20 || fontSize > 60) {
    throw new WangzhuanError("validation_error", "字幕字号需为 20-60 的整数", {
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
  return { enabled: source.enabled !== false, fontSize, centerY, textColor };
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

export function buildTimedCueGroups(words = [], options = {}) {
  const maxWords = Number(options.maxWords || 7);
  const maxDisplayUnits = Number(options.maxDisplayUnits || 24);
  const pauseBreakSec = Number.isFinite(Number(options.pauseBreakSec)) ? Math.max(0, Number(options.pauseBreakSec)) : DEFAULT_PAUSE_BREAK_SEC;
  const normalized = words
    .map((word) => ({
      word: cleanWord(word?.word),
      startSec: Number(word?.start),
      endSec: Number(word?.end),
      breakBefore: Boolean(word?.breakBefore)
    }))
    .filter((word) => word.word && Number.isFinite(word.startSec) && Number.isFinite(word.endSec));
  const cues = [];
  let group = [];
  for (const word of normalized) {
    const previous = group.at(-1);
    const pauseGapSec = previous ? word.startSec - previous.endSec : 0;
    if (group.length && (word.breakBefore || pauseGapSec >= pauseBreakSec)) {
      cues.push({ startSec: group[0].startSec, endSec: previous.endSec, text: cueText(group) });
      group = [word];
      continue;
    }
    const next = [...group, word];
    const text = cueText(next);
    const overLimit = next.length > maxWords || displayUnits(text) > maxDisplayUnits;
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

function splitTextIntoLines(text, options = {}) {
  const maxLines = Number(options.maxLines || 2);
  const maxWords = Number(options.maxWords || 7);
  const maxDisplayUnits = Number(options.maxDisplayUnits || 24);
  const words = String(text || "").replace(/\s+/g, " ").trim().split(" ").filter(Boolean);
  if (!words.length) return [];
  const lines = [];
  let line = [];
  for (const word of words) {
    const next = [...line, word];
    const nextText = next.join(" ");
    if (line.length && (next.length > maxWords || displayUnits(nextText) > maxDisplayUnits)) {
      lines.push(line.join(" "));
      line = [word];
      if (lines.length >= maxLines) break;
      continue;
    }
    line = next;
  }
  if (line.length && lines.length < maxLines) lines.push(line.join(" "));
  return lines;
}

export function formatSubtitleText(text, options = {}) {
  return splitTextIntoLines(text, options).join("\n");
}

function parseTimeRange(value = "") {
  const match = String(value || "").match(/^\s*(\d+(?:\.\d+)?)\s*s?\s*[-~]\s*(\d+(?:\.\d+)?)\s*s?\s*$/i);
  if (!match) return null;
  return { startSec: Number(match[1]), endSec: Number(match[2]) };
}

function normalizeSubtitleScriptItem(item) {
  if (typeof item === "string") return { text: item };
  if (!item || typeof item !== "object") return { text: "" };
  const parsedRange = parseTimeRange(item.timeRange || item.range || item.time || "");
  return {
    text: item.text || item.subtitle || item.caption || "",
    startSec: Number.isFinite(Number(item.startSec ?? item.start)) ? Number(item.startSec ?? item.start) : parsedRange?.startSec,
    endSec: Number.isFinite(Number(item.endSec ?? item.end)) ? Number(item.endSec ?? item.end) : parsedRange?.endSec
  };
}

export function buildTimedCuesFromSubtitleScript(items = [], durationSec = 0, options = {}) {
  const normalized = (Array.isArray(items) ? items : [])
    .map(normalizeSubtitleScriptItem)
    .filter((item) => String(item.text || "").trim());
  if (!normalized.length) return [];
  const duration = Math.max(0, Number(durationSec) || 0);
  const fallbackStep = duration > 0 ? duration / normalized.length : 2;
  return normalized.map((item, index) => {
    const fallbackStart = fallbackStep * index;
    const fallbackEnd = index === normalized.length - 1 && duration > 0 ? duration : fallbackStart + fallbackStep;
    const startSec = Math.max(0, Number.isFinite(item.startSec) ? Number(item.startSec) : fallbackStart);
    const endSecRaw = Number.isFinite(item.endSec) ? Number(item.endSec) : fallbackEnd;
    const endSec = Math.max(startSec + 0.1, duration > 0 ? Math.min(duration, endSecRaw) : endSecRaw);
    return {
      startSec,
      endSec,
      text: formatSubtitleText(item.text, options)
    };
  }).filter((cue) => cue.text && cue.endSec > cue.startSec);
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

function normalizePhraseForSimilarity(text = "") {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\u3400-\u9fff\uf900-\ufaff]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function phraseTokens(text = "") {
  const normalized = normalizePhraseForSimilarity(text);
  if (!normalized) return [];
  if (CJK_CHAR.test(normalized)) return [...normalized].filter((character) => !/\s/u.test(character));
  return normalized.split(" ").filter(Boolean);
}

function phraseSimilarity(left = "", right = "") {
  const normalizedLeft = normalizePhraseForSimilarity(left);
  const normalizedRight = normalizePhraseForSimilarity(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;
  const leftTokens = phraseTokens(normalizedLeft);
  const rightTokens = phraseTokens(normalizedRight);
  if (!leftTokens.length || !rightTokens.length) return 0;
  const rightRemaining = new Map();
  for (const token of rightTokens) rightRemaining.set(token, (rightRemaining.get(token) || 0) + 1);
  let overlap = 0;
  for (const token of leftTokens) {
    const count = rightRemaining.get(token) || 0;
    if (count <= 0) continue;
    overlap += 1;
    rightRemaining.set(token, count - 1);
  }
  return (2 * overlap) / (leftTokens.length + rightTokens.length);
}

function isShortHighlightCandidate(cue = {}, options = {}) {
  const maxWords = Number(options.maxWords || 7);
  const maxDisplayUnits = Number(options.maxDisplayUnits || 34);
  const text = String(cue.text || "").replace(/\s+/g, " ").trim();
  if (!text) return false;
  const tokens = phraseTokens(text);
  return tokens.length >= 2 && tokens.length <= maxWords && displayUnits(text) <= maxDisplayUnits;
}

export function markSimilarShortPhraseHighlights(cues = [], options = {}) {
  const threshold = Number.isFinite(Number(options.threshold)) ? Number(options.threshold) : 0.74;
  const candidates = cues.map((cue, index) => ({ cue, index })).filter(({ cue }) => isShortHighlightCandidate(cue, options));
  const highlighted = new Set();
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex += 1) {
      if (phraseSimilarity(candidates[leftIndex].cue.text, candidates[rightIndex].cue.text) < threshold) continue;
      highlighted.add(candidates[leftIndex].index);
      highlighted.add(candidates[rightIndex].index);
    }
  }
  return cues.map((cue, index) => highlighted.has(index) ? { ...cue, highlight: true } : { ...cue });
}

function escapeAss(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
}

export function renderAssSubtitles(cues = [], canvas = {}) {
  const width = Number(canvas.width) > 0 ? Math.trunc(Number(canvas.width)) : 720;
  const height = Number(canvas.height) > 0 ? Math.trunc(Number(canvas.height)) : 1280;
  const referenceFontSize = Number(canvas.fontSize) > 0 ? Number(canvas.fontSize) : 40;
  const referenceCenterY = Number.isFinite(Number(canvas.centerY)) ? Number(canvas.centerY) : 960;
  const textColor = ASS_COLORS[normalizeSubtitleColor(canvas.textColor)] || ASS_COLORS.white;
  const scale = Math.min(width / 720, height / 1280);
  const fontSize = Math.max(1, Math.round(referenceFontSize * scale));
  const outline = Math.max(1, Math.round(3 * scale));
  const highlightOutline = Math.max(4, Math.round(8 * scale));
  const lineStep = Math.max(1, Math.round((referenceFontSize + 10) * scale));
  const centerX = Math.round(width / 2);
  const centerY = Math.round(height * (referenceCenterY / 1280));
  const renderCues = canvas.highlightSimilarShortPhrases ? markSimilarShortPhraseHighlights(cues, canvas.highlightSimilarShortPhrases === true ? {} : canvas.highlightSimilarShortPhrases) : cues;
  const header = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Default,DejaVu Sans,${fontSize},${textColor},&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,${outline},0,5,0,0,0,1\nStyle: Highlight,DejaVu Sans,${fontSize},&H00FFFFFF,&H000000FF,${ASS_HIGHLIGHT_BACKGROUND},&H00000000,1,0,0,0,100,100,0,0,3,${highlightOutline},0,5,0,0,0,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n`;
  const events = renderCues.flatMap((cue) => {
    const lines = String(cue.text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, 2);
    const firstY = centerY - ((lines.length - 1) * lineStep) / 2;
    const style = cue.highlight ? "Highlight" : "Default";
    return lines.map((line, index) => `Dialogue: 0,${assTimestamp(cue.startSec)},${assTimestamp(cue.endSec)},${style},,0,0,0,,{\\an5\\pos(${centerX},${Math.round(firstY + index * lineStep)})}${escapeAss(line)}`);
  });
  return header + events.join("\n") + "\n";
}

function extractVolcengineWords(result = {}) {
  return (Array.isArray(result?.result?.utterances) ? result.result.utterances : []).flatMap((utterance, utteranceIndex) => {
    if (Array.isArray(utterance?.words) && utterance.words.length) {
      return utterance.words.map((word, wordIndex) => ({
        word: word.text,
        start: Number(word.start_time) / 1000,
        end: Number(word.end_time) / 1000,
        breakBefore: utteranceIndex > 0 && wordIndex === 0
      }));
    }
    return [{
      word: utterance?.text,
      start: Number(utterance?.start_time) / 1000,
      end: Number(utterance?.end_time) / 1000,
      breakBefore: utteranceIndex > 0
    }];
  });
}

export function buildVolcengineSubtitleCues(result = {}, options = {}) {
  return buildTimedCueGroups(extractVolcengineWords(result), options);
}

export async function writeVolcengineSubtitleArtifacts(result, outputDir, canvas = {}) {
  await mkdir(outputDir, { recursive: true });
  const cues = buildVolcengineSubtitleCues(result);
  return writeSubtitleArtifactsFromCues(result, cues, outputDir, canvas);
}

export async function writeSubtitleArtifactsFromCues(transcript, cues = [], outputDir, canvas = {}) {
  await mkdir(outputDir, { recursive: true });
  if (!cues.length) throw new Error("火山语音未识别到可用口播字幕");
  const transcriptPath = join(outputDir, "transcript.json");
  const srtPath = join(outputDir, "captions.srt");
  const assPath = join(outputDir, "captions.ass");
  await Promise.all([writeFile(transcriptPath, JSON.stringify(transcript, null, 2), "utf8"), writeFile(srtPath, renderSrtSubtitles(cues), "utf8"), writeFile(assPath, renderAssSubtitles(cues, canvas), "utf8")]);
  return { transcriptPath, srtPath, assPath, cueCount: cues.length };
}
