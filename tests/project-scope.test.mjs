import assert from "node:assert/strict";
import test from "node:test";

import { resolveProjectByKey } from "../server/project-scope.mjs";

test("resolveProjectByKey accepts a configured legacy project key", () => {
  const project = {
    name: "PROJECT_ROOT_P",
    path: "/data/project-data/PROJECT_ROOT_P",
    legacyProjectKeys: ["7e35e0d0778de1240a8b91722061e4a890fd38ca5d5f939e1cc694752acee5e2"]
  };

  assert.equal(
    resolveProjectByKey([project], "root:7e35e0d0778de1240a8b91722061e4a890fd38ca5d5f939e1cc694752acee5e2"),
    project
  );
});

test("resolveProjectByKey still accepts the canonical path hash", () => {
  const project = {
    name: "PROJECT_ROOT_P",
    path: "/data/project-data/PROJECT_ROOT_P",
    legacyProjectKeys: []
  };

  assert.equal(
    resolveProjectByKey([project], "d6ce4e41f71792e98325015ae5551007eb630edf2cdf972eae5e5c17a6b7fa1b"),
    project
  );
});
