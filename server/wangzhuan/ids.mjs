import { randomBytes } from "node:crypto";

function pad(value, width) {
  return String(value).padStart(width, "0");
}

export function compactTimestamp(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1, 2),
    pad(date.getDate(), 2),
    pad(date.getHours(), 2),
    pad(date.getMinutes(), 2),
    pad(date.getSeconds(), 2)
  ].join("");
}

export function dateStamp(date = new Date()) {
  return compactTimestamp(date).slice(0, 8);
}

export function shortHex(bytes = 2) {
  return randomBytes(bytes).toString("hex");
}

export function normalizeSlug(value, fallback = "template") {
  const slug = String(value ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
    .slice(0, 48);
  return slug || fallback;
}

export function makeRequestId(date = new Date()) {
  return `req_${compactTimestamp(date)}_${shortHex()}`;
}

export function makeTimestampId(prefix, date = new Date()) {
  return `${prefix}_${compactTimestamp(date)}_${shortHex()}`;
}

export function makeDatedSequenceId(prefix, seq, date = new Date()) {
  return `${prefix}_${dateStamp(date)}_${pad(seq, 3)}`;
}

export function makeReferenceVideoId(seq, date = new Date()) {
  return makeDatedSequenceId("ref", seq, date);
}

export function makeRemixSourceId(seq, date = new Date()) {
  return makeDatedSequenceId("rsrc", seq, date);
}

export function makeEstimateId(seq, date = new Date()) {
  return makeDatedSequenceId("est", seq, date);
}

export function makeRemixEstimateId(seq, date = new Date()) {
  return makeDatedSequenceId("rme", seq, date);
}

export function makeBatchId(date = new Date()) {
  return makeTimestampId("wzb", date);
}

export function makeRemixId(date = new Date()) {
  return makeTimestampId("rmx", date);
}

export function batchShortId(batchId) {
  const short = String(batchId || "").split("_").pop();
  return /^[a-f0-9]{4}$/.test(short) ? short : shortHex();
}

export function makeScriptId(batchId, seq) {
  return `scr_${batchShortId(batchId)}_${pad(seq, 3)}`;
}

export function makeGenerationTaskId(batchId, seq) {
  return `gen_${batchShortId(batchId)}_${pad(seq, 3)}`;
}

export function makePlanId(batchId, seq) {
  return `plan_${batchShortId(batchId)}_${pad(seq, 3)}`;
}

export function makeOutputId(batchId, seq) {
  return `out_${batchShortId(batchId)}_${pad(seq, 3)}`;
}

export function makeTemplateId(displayName, seq) {
  return `tpl_${normalizeSlug(displayName)}_${pad(seq, 3)}`;
}

export function makeTemplateVersionId(templateId, versionNumber) {
  const slug = String(templateId ?? "").replace(/^tpl_/, "");
  return `tplv_${slug}_${pad(versionNumber, 4)}`;
}

export function makeAuditEventId(date = new Date()) {
  return `audit_${compactTimestamp(date)}_${shortHex()}`;
}

export function makePackageId(date = new Date()) {
  return `pkg_${compactTimestamp(date)}_${shortHex()}`;
}
