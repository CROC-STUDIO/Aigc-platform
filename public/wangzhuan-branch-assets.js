function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function branchHasReferenceAsset(branch = {}, assetKey = "") {
  return Boolean(
    cleanString(branch.assetFileNames?.[assetKey])
    || cleanString(branch.assetUrls?.[assetKey])
    || cleanString(branch.assetStorageKeys?.[assetKey])
    || cleanString(branch.assetStoredPaths?.[assetKey])
    || cleanString(branch.assetRelativePaths?.[assetKey])
  );
}

export function pruneOrphanAssetReviews(branch = {}) {
  const assetContentHashes = Object.fromEntries(
    Object.entries(branch.assetContentHashes || {})
      .filter(([assetKey, contentHash]) => branchHasReferenceAsset(branch, assetKey) && cleanString(contentHash))
      .map(([assetKey, contentHash]) => [assetKey, cleanString(contentHash)])
  );
  return {
    ...branch,
    assetContentHashes,
    assetReviews: Object.fromEntries(
      Object.entries(branch.assetReviews || {}).filter(([assetKey, review]) => {
        if (!branchHasReferenceAsset(branch, assetKey)) return false;
        const contentHash = assetContentHashes[assetKey];
        const reviewContentHash = cleanString(review?.contentHash);
        return !contentHash || contentHash === reviewContentHash;
      })
    )
  };
}
