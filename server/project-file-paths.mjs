import { isAbsolute, resolve } from "node:path";

function hasPathBoundary(fullPath, rootPath) {
  return fullPath === rootPath || fullPath.startsWith(`${rootPath}\\`) || fullPath.startsWith(`${rootPath}/`);
}

export function resolveProjectFilePath(path, { userRoot, sharedRoot }) {
  const raw = String(path || "");
  const roots = [resolve(userRoot), resolve(sharedRoot)];
  const candidates = isAbsolute(raw)
    ? [resolve(raw)]
    : roots.map((root) => resolve(root, raw));

  for (const candidate of candidates) {
    if (roots.some((root) => hasPathBoundary(candidate, root))) return candidate;
  }
  throw new Error("Path is outside project root");
}
