import test from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import { resolveProjectFilePath } from "../server/project-file-paths.mjs";

test("resolves project-relative file paths inside the current user root", () => {
  const root = resolve("C:/workspace/project/user-root");
  const file = resolveProjectFilePath("批处理记录/网赚管线/remix/out.mp4", {
    userRoot: root,
    sharedRoot: resolve("C:/workspace/project/shared-root")
  });

  assert.equal(file, join(root, "批处理记录", "网赚管线", "remix", "out.mp4"));
});

test("keeps accepting absolute file paths inside project roots", () => {
  const userRoot = resolve("C:/workspace/project/user-root");
  const absolute = join(userRoot, "效果图", "a.png");

  assert.equal(resolveProjectFilePath(absolute, {
    userRoot,
    sharedRoot: resolve("C:/workspace/project/shared-root")
  }), absolute);
});

test("rejects relative traversal outside project roots", () => {
  assert.throws(
    () => resolveProjectFilePath("../outside.txt", {
      userRoot: resolve("C:/workspace/project/user-root"),
      sharedRoot: resolve("C:/workspace/project/shared-root")
    }),
    /Path is outside project root/
  );
});

test("rejects absolute paths outside project roots", () => {
  assert.throws(
    () => resolveProjectFilePath(resolve("C:/workspace/other/out.mp4"), {
      userRoot: resolve("C:/workspace/project/user-root"),
      sharedRoot: resolve("C:/workspace/project/shared-root")
    }),
    /Path is outside project root/
  );
});
