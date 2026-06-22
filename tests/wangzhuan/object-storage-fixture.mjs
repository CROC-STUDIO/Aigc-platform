import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";

const MOCK_PUBLIC_BASE = "https://harpoons3.s3.ap-southeast-1.amazonaws.com";

export function attachMockObjectStorage(ctx) {
  const objectStore = new Map();
  const userRoot = ctx.userProjectRoot;
  const userId = ctx.userId || ctx.user?.userId || "alice";

  ctx.syncWangzhuanAsset = async ({ fullPath, assetKind }) => {
    const relativePath = fullPath
      .slice(userRoot.length)
      .replace(/^[\\/]+/, "")
      .replace(/\\/g, "/");
    const safeRelativePath = Buffer.from(relativePath, "utf8").toString("hex").slice(0, 64);
    const safeName = basename(fullPath).replace(/[^a-zA-Z0-9._-]+/g, "_") || "asset";
    const storageKey = `uploads/test/${userId}/${assetKind}/${safeRelativePath}_${safeName}`;
    objectStore.set(storageKey, await readFile(fullPath));
    return {
      storageKey,
      storageUrl: `${MOCK_PUBLIC_BASE}/${storageKey}`
    };
  };

  ctx.openWangzhuanObjectStream = async (storageKey) => {
    const buffer = objectStore.get(storageKey);
    if (!buffer) throw new Error(`missing object ${storageKey}`);
    return { body: Readable.from([buffer]) };
  };

  ctx.__mockObjectStore = objectStore;
  return { objectStore };
}
