import { spawn as nodeSpawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WangzhuanError } from "./http.mjs";

export const DEFAULT_CODEX_TIMEOUT_MS = 180000;
export const DEFAULT_CODEX_MODEL = "gpt-5.4";

function nowIso() {
  return new Date().toISOString();
}

function ensureText(value, field) {
  const text = String(value || "").trim();
  if (!text) {
    throw new WangzhuanError("validation_error", `${field} 不能为空`, { field });
  }
  return text;
}

function safeTail(text, limit = 4000) {
  const value = String(text || "");
  return value.length > limit ? value.slice(-limit) : value;
}

export function buildCodexExecArgs({
  cwd,
  model = DEFAULT_CODEX_MODEL,
  sandbox = "workspace-write",
  approval = "never",
  outputSchemaPath = "",
  outputLastMessagePath = "",
  skipGitRepoCheck = false
}) {
  const args = [
    "exec",
    "-C", ensureText(cwd, "cwd"),
    "-m", ensureText(model, "model"),
    "--ephemeral",
    "-s", ensureText(sandbox, "sandbox"),
    "-a", ensureText(approval, "approval")
  ];
  if (skipGitRepoCheck) args.push("--skip-git-repo-check");
  if (outputSchemaPath) args.push("--output-schema", outputSchemaPath);
  if (outputLastMessagePath) args.push("-o", outputLastMessagePath);
  args.push("-");
  return args;
}

function parseStructuredOutput(text) {
  const body = String(text || "").trim();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    throw new WangzhuanError("schema_invalid", "Codex 返回结果不是合法 JSON", {
      provider: "codex"
    }, 422);
  }
}

export async function runCodexExec(options = {}, deps = {}) {
  const prompt = ensureText(options.prompt, "prompt");
  const cwd = ensureText(options.cwd, "cwd");
  const model = String(options.model || DEFAULT_CODEX_MODEL).trim() || DEFAULT_CODEX_MODEL;
  const sandbox = String(options.sandbox || "workspace-write").trim() || "workspace-write";
  const approval = String(options.approval || "never").trim() || "never";
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) ? Math.max(1000, Number(options.timeoutMs)) : DEFAULT_CODEX_TIMEOUT_MS;
  const skipGitRepoCheck = Boolean(options.skipGitRepoCheck);
  const outputSchema = options.outputSchema && typeof options.outputSchema === "object" ? options.outputSchema : null;
  const spawnImpl = deps.spawnImpl || nodeSpawn;
  const tmpRoot = deps.tmpRoot || tmpdir();

  const workDir = await mkdtemp(join(tmpRoot, "codex-exec-"));
  const outputPath = join(workDir, "last-message.json");
  const schemaPath = outputSchema ? join(workDir, "output-schema.json") : "";
  const startedAt = nowIso();
  const startedMs = Date.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;
  let settled = false;
  let child = null;

  try {
    if (schemaPath) {
      await writeFile(schemaPath, `${JSON.stringify(outputSchema, null, 2)}\n`, "utf8");
    }
    const args = buildCodexExecArgs({
      cwd,
      model,
      sandbox,
      approval,
      outputSchemaPath: schemaPath,
      outputLastMessagePath: outputPath,
      skipGitRepoCheck
    });
    child = spawnImpl("codex", args, {
      cwd,
      env: {
        ...process.env,
        ...options.env,
        NO_COLOR: "1"
      },
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout?.on?.("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on?.("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.stdin?.write?.(prompt);
    child.stdin?.end?.();

    const exitCode = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          child?.kill?.("SIGTERM");
        } catch {
          // Best effort only.
        }
      }, timeoutMs);
      child.once("error", (error) => {
        clearTimeout(timer);
        settled = true;
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        settled = true;
        resolve(code ?? 0);
      });
    });

    if (timedOut) {
      throw new WangzhuanError("model_failed", "Codex 执行超时，请稍后重试", {
        provider: "codex",
        reason: "timeout",
        timeoutMs
      }, 502);
    }

    const lastMessage = await readFile(outputPath, "utf8").catch(() => "");
    const json = outputSchema ? parseStructuredOutput(lastMessage) : null;
    const finishedAt = nowIso();
    const durationMs = Date.now() - startedMs;

    if (exitCode !== 0) {
      throw new WangzhuanError("model_failed", "Codex 执行失败，请稍后重试", {
        provider: "codex",
        reason: "non_zero_exit",
        exitCode,
        stderr: safeTail(stderr),
        stdout: safeTail(stdout)
      }, 502);
    }

    return {
      ok: true,
      exitCode,
      stdout,
      stderr,
      lastMessage,
      json,
      args,
      outputPath,
      schemaPath,
      startedAt,
      finishedAt,
      durationMs
    };
  } catch (error) {
    if (error instanceof WangzhuanError) throw error;
    if (timedOut) {
      throw new WangzhuanError("model_failed", "Codex 执行超时，请稍后重试", {
        provider: "codex",
        reason: "timeout",
        timeoutMs
      }, 502);
    }
    throw new WangzhuanError("model_failed", "Codex 执行失败，请稍后重试", {
      provider: "codex",
      reason: settled ? "runtime_error" : "spawn_error",
      message: safeTail(error?.message || error)
    }, 502);
  } finally {
    if (timedOut) {
      try {
        child?.kill?.("SIGKILL");
      } catch {
        // Best effort only.
      }
    }
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
