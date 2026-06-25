import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function unquoteEnvValue(value) {
  if (value.length < 2) return value;
  const quote = value[0];
  if ((quote !== "\"" && quote !== "'") || value[value.length - 1] !== quote) return value;
  const inner = value.slice(1, -1);
  if (quote === "'") return inner;
  return inner
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, "\"")
    .replace(/\\\\/g, "\\");
}

export function parseEnvFileContent(content) {
  const values = {};
  const text = String(content || "").replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (!ENV_KEY_RE.test(key)) continue;
    values[key] = unquoteEnvValue(line.slice(separator + 1).trim());
  }
  return values;
}

export function loadEnvFile({ envPath, env = process.env, override = false } = {}) {
  if (!envPath || !existsSync(envPath)) return false;
  const values = parseEnvFileContent(readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(values)) {
    if (override || env[key] === undefined) env[key] = value;
  }
  return true;
}

export function parseJsonFileContent(content, fileLabel) {
  const text = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  try {
    return JSON.parse(text);
  } catch (error) {
    const position = Number(error.message.match(/position (\d+)/)?.[1]);
    let location = "";
    let nearby = "";
    if (Number.isFinite(position)) {
      const before = text.slice(0, position);
      const line = before.split("\n").length;
      const column = before.length - before.lastIndexOf("\n");
      location = ` at line ${line}, column ${column}`;
      nearby = ` Nearby content: ${JSON.stringify(text.slice(Math.max(0, position - 40), position + 80))}`;
    }
    throw new Error(`${fileLabel} is not valid JSON${location}: ${error.message}.${nearby}`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeConfigDefaults(defaultConfig = {}, runtimeConfig = {}) {
  if (!isPlainObject(defaultConfig)) return isPlainObject(runtimeConfig) ? runtimeConfig : {};
  if (!isPlainObject(runtimeConfig)) return defaultConfig;
  const merged = { ...defaultConfig };
  for (const [key, value] of Object.entries(runtimeConfig)) {
    merged[key] = isPlainObject(value) && isPlainObject(merged[key])
      ? mergeConfigDefaults(merged[key], value)
      : value;
  }
  return merged;
}

async function readJsonObject(path, label) {
  const data = parseJsonFileContent(await readFile(path, "utf8"), label);
  return data && typeof data === "object" && !Array.isArray(data) ? data : {};
}

export async function loadRuntimeConfig({ runtimePath, defaultPath }) {
  const defaultConfig = defaultPath && existsSync(defaultPath)
    ? await readJsonObject(defaultPath, "config.default.json")
    : {};
  if (!runtimePath || !existsSync(runtimePath)) {
    return {
      config: defaultConfig,
      runtimeConfigExists: false,
      defaultConfigLoaded: Boolean(defaultPath && existsSync(defaultPath))
    };
  }
  const runtimeConfig = await readJsonObject(runtimePath, "config.json");
  return {
    config: mergeConfigDefaults(defaultConfig, runtimeConfig),
    runtimeConfigExists: true,
    defaultConfigLoaded: Boolean(defaultPath && existsSync(defaultPath))
  };
}
