import { createHash } from "node:crypto";

export function normalizeProjectKey(value) {
  const key = String(value || "").trim().replace(/^root:/, "").toLowerCase();
  return /^[a-f0-9]{64}$/.test(key) ? key : "";
}

export function normalizeLegacyProjectKeys(values = []) {
  const keys = Array.isArray(values) ? values : [values];
  return [...new Set(keys.map(normalizeProjectKey).filter(Boolean))];
}

export function projectKeyForPath(path) {
  return createHash("sha256").update(String(path || ""), "utf8").digest("hex");
}

export function resolveProjectByKey(projects = [], requestedKey = "") {
  const key = normalizeProjectKey(requestedKey);
  if (!key) return null;
  return projects.find((project) => {
    return projectKeyForPath(project?.path) === key
      || normalizeLegacyProjectKeys(project?.legacyProjectKeys).includes(key);
  }) || null;
}
