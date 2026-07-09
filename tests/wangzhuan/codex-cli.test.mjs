import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import { buildCodexExecArgs, runCodexExec } from "../../server/wangzhuan/codex-cli.mjs";

function createChild(onStdinEnd) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let stdinText = "";
  child.stdin = new Writable({
    write(chunk, encoding, callback) {
      stdinText += chunk.toString("utf8");
      callback();
    },
    final(callback) {
      onStdinEnd?.(stdinText, child);
      callback();
    }
  });
  child.kill = () => {
    queueMicrotask(() => child.emit("close", null));
    return true;
  };
  return child;
}

test("buildCodexExecArgs builds non-interactive command", () => {
  const args = buildCodexExecArgs({
    cwd: "/tmp/repo",
    model: "gpt-5.4",
    sandbox: "workspace-write",
    approval: "never",
    outputSchemaPath: "/tmp/schema.json",
    outputLastMessagePath: "/tmp/out.json",
    skipGitRepoCheck: true
  });
  assert.deepEqual(args, [
    "exec",
    "-C", "/tmp/repo",
    "-m", "gpt-5.4",
    "--ephemeral",
    "-s", "workspace-write",
    "-a", "never",
    "--skip-git-repo-check",
    "--output-schema", "/tmp/schema.json",
    "-o", "/tmp/out.json",
    "-"
  ]);
});

test("runCodexExec writes prompt to stdin and parses structured output", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-test-"));
  let capturedArgs = null;
  const result = await runCodexExec({
    cwd: root,
    prompt: "生成 seedance prompt",
    outputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string" }
      },
      required: ["prompt"],
      additionalProperties: false
    }
  }, {
    tmpRoot: root,
    spawnImpl(command, args) {
      capturedArgs = [command, ...args];
      const outputPath = args[args.indexOf("-o") + 1];
      const child = createChild(async (stdinText, emitter) => {
        assert.equal(stdinText, "生成 seedance prompt");
        await writeFile(outputPath, JSON.stringify({ prompt: "ok" }), "utf8");
        emitter.stdout.write("stdout");
        emitter.stderr.write("stderr");
        emitter.stdout.end();
        emitter.stderr.end();
        emitter.emit("close", 0);
      });
      return child;
    }
  });
  assert.equal(capturedArgs[0], "codex");
  assert.equal(result.ok, true);
  assert.deepEqual(result.json, { prompt: "ok" });
  assert.match(result.stdout, /stdout/);
  assert.match(result.stderr, /stderr/);
});

test("runCodexExec throws timeout as model_failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "codex-cli-timeout-"));
  await assert.rejects(
    runCodexExec({
      cwd: root,
      prompt: "slow",
      timeoutMs: 5
    }, {
      tmpRoot: root,
      spawnImpl() {
        return createChild();
      }
    }),
    (error) => {
      assert.equal(error.code, "model_failed");
      assert.equal(error.data.reason, "timeout");
      return true;
    }
  );
});
