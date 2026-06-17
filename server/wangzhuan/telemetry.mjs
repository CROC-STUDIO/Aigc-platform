import { createHash } from "node:crypto";

import { compactTimestamp, shortHex } from "./ids.mjs";
import { appendJsonl, wangzhuanPaths } from "./storage.mjs";

function currentUser(context) {
  return context.user ?? context.currentUser?.() ?? null;
}

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? currentUser(context)?.userId ?? currentUser(context)?.username ?? "local";
}

function currentRole(context) {
  const user = currentUser(context);
  return user?.isAdmin || user?.role === "admin" ? "admin" : "user";
}

function projectRoot(context) {
  return context.userProjectRoot ?? context.currentProjectRoot?.() ?? "";
}

function projectRootHash(context) {
  return `sha256:${createHash("sha256").update(String(projectRoot(context))).digest("hex")}`;
}

function makeEventId(date = new Date()) {
  return `evt_${compactTimestamp(date)}_${shortHex()}`;
}

function isSensitiveKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  if (normalized === "confirmationtoken") return false;
  if (normalized.includes("remoteurl") || normalized.includes("signedurl")) return true;
  if (normalized.includes("prompt") && !normalized.includes("path")) return true;
  if (normalized.includes("apikey") || normalized.includes("secret") || normalized.includes("password")) return true;
  if (normalized.includes("credential") || normalized.includes("bearer") || normalized.includes("authorization")) return true;
  return normalized.endsWith("token");
}

function shouldOmitKey(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized.includes("remoteurl") || normalized.includes("signedurl");
}

function sensitiveReplacement(key) {
  const normalized = String(key || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
  return normalized.includes("url") ? "[redacted_url]" : "[redacted]";
}

function redactString(value) {
  let next = String(value);
  next = next.replace(/https?:\/\/[^\s"',}]+/gi, "[redacted_url]");
  next = next.replace(/[a-z]:[\\/][^\s"',}]+/gi, "[redacted_path]");
  if (/^\/(users|home|var|tmp|mnt|opt|root|data|srv)\b/i.test(next)) {
    next = "[redacted_path]";
  }
  if (/bearer\s+/i.test(next) || /^sk-[a-z0-9_-]+/i.test(next)) {
    next = "[redacted]";
  }
  return next;
}

export function sanitizeTelemetryPayload(value, key = "") {
  if (value === null || value === undefined) return value;
  if (isSensitiveKey(key)) return sensitiveReplacement(key);
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeTelemetryPayload(item, key));
  }
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([entryKey]) => !shouldOmitKey(entryKey))
        .map(([entryKey, entryValue]) => [
          entryKey,
          sanitizeTelemetryPayload(entryValue, entryKey)
        ])
    );
  }
  return value;
}

export async function recordTelemetryEvent(context, event, payload = {}, options = {}) {
  const now = new Date();
  const telemetry = {
    event,
    eventId: makeEventId(now),
    ...(options.requestId ? { requestId: options.requestId } : {}),
    userId: currentUserId(context),
    projectRootHash: projectRootHash(context),
    role: currentRole(context),
    occurredAt: now.toISOString(),
    payload: sanitizeTelemetryPayload(payload)
  };

  const paths = wangzhuanPaths(context);
  await appendJsonl(paths.telemetryPath, telemetry);

  let audit;
  if (options.audit) {
    audit = { ...telemetry };
    await appendJsonl(paths.auditPath, audit);
  }

  return { telemetry, audit };
}
