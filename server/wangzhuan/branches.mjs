const ASSET_KEYS = Object.freeze([
  "productIcon",
  "productScreenshot",
  "productRecording",
  "ctaAsset",
  "endingAsset",
  "personAsset",
  "rewardElement"
]);

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function mergeLanguageMap(base = {}, override = {}) {
  const merged = {};
  for (const [key, value] of Object.entries(isObject(base) ? base : {})) {
    const text = cleanString(value);
    if (text) merged[key] = text;
  }
  for (const [key, value] of Object.entries(isObject(override) ? override : {})) {
    const text = cleanString(value);
    if (text) merged[key] = text;
  }
  return merged;
}

function mergeAssetMap(base = {}, override = {}) {
  const merged = {};
  for (const key of ASSET_KEYS) {
    const value = cleanString(override?.[key]) || cleanString(base?.[key]);
    if (value) merged[key] = value;
  }
  for (const [key, value] of Object.entries(isObject(override) ? override : {})) {
    const text = cleanString(value);
    if (text) merged[key] = text;
  }
  return merged;
}

function branchHasAssetField(branch = {}, assetKey) {
  return Boolean(
    cleanString(branch.assetUrls?.[assetKey])
    || cleanString(branch.assetStorageKeys?.[assetKey])
    || cleanString(branch.assetStoredPaths?.[assetKey])
    || cleanString(branch.assetRelativePaths?.[assetKey])
    || cleanString(branch.assetFileNames?.[assetKey])
  );
}

function assetStorageIdentity(branch = {}, assetKey = "") {
  return cleanString(branch.assetStorageKeys?.[assetKey])
    || cleanString(branch.assetStoredPaths?.[assetKey])
    || cleanString(branch.assetRelativePaths?.[assetKey])
    || cleanString(branch.assetUrls?.[assetKey]);
}

function rawAssetChangesInheritedIdentity(raw = {}, base = {}, assetKey = "") {
  if (!branchHasAssetField(raw, assetKey) || !branchHasAssetField(base, assetKey)) return false;
  const rawHash = cleanString(raw.assetContentHashes?.[assetKey]);
  const baseHash = cleanString(base.assetContentHashes?.[assetKey]);
  if (rawHash && baseHash) return rawHash !== baseHash;
  if (rawHash && !baseHash) return true;
  const rawIdentity = assetStorageIdentity(raw, assetKey);
  const baseIdentity = assetStorageIdentity(base, assetKey);
  return !rawIdentity || !baseIdentity || rawIdentity !== baseIdentity;
}

function countBranchMediaFields(branch = {}) {
  let count = 0;
  for (const key of ASSET_KEYS) {
    if (branchHasAssetField(branch, key)) count += 1;
  }
  return count;
}

function pruneAssetContentHashes(hashes = {}, media = {}) {
  const pruned = {};
  for (const [key, value] of Object.entries(isObject(hashes) ? hashes : {})) {
    const contentHash = cleanString(value);
    if (!contentHash || !branchHasAssetField(media, key)) continue;
    pruned[key] = contentHash;
  }
  return pruned;
}

function reviewMatchesAssetContent(review = {}, media = {}, assetKey = "") {
  const assetContentHash = cleanString(media.assetContentHashes?.[assetKey]);
  const reviewContentHash = cleanString(review?.contentHash);
  return !assetContentHash || assetContentHash === reviewContentHash;
}

function pruneAssetReviews(reviews = {}, media = {}) {
  const pruned = {};
  for (const [key, review] of Object.entries(isObject(reviews) ? reviews : {})) {
    if (!branchHasAssetField(media, key)) continue;
    if (!reviewMatchesAssetContent(review, media, key)) continue;
    pruned[key] = review;
  }
  return pruned;
}

export function branchMediaFields(raw = {}, { inheritFrom = null } = {}) {
  const useInheritance = inheritFrom !== null && isObject(inheritFrom);
  const base = useInheritance ? inheritFrom : {};
  const media = {
    assetFileNames: mergeAssetMap(useInheritance ? base.assetFileNames : {}, raw.assetFileNames),
    assetUrls: mergeAssetMap(useInheritance ? base.assetUrls : {}, raw.assetUrls),
    assetStorageKeys: mergeAssetMap(useInheritance ? base.assetStorageKeys : {}, raw.assetStorageKeys),
    assetStoredPaths: mergeAssetMap(useInheritance ? base.assetStoredPaths : {}, raw.assetStoredPaths),
    assetContentHashes: mergeAssetMap(useInheritance ? base.assetContentHashes : {}, raw.assetContentHashes)
  };
  const changedAssetKeys = new Set();
  if (useInheritance) {
    const rawAssetKeys = new Set([
      ...Object.keys(isObject(raw.assetFileNames) ? raw.assetFileNames : {}),
      ...Object.keys(isObject(raw.assetUrls) ? raw.assetUrls : {}),
      ...Object.keys(isObject(raw.assetStorageKeys) ? raw.assetStorageKeys : {}),
      ...Object.keys(isObject(raw.assetStoredPaths) ? raw.assetStoredPaths : {}),
      ...Object.keys(isObject(raw.assetRelativePaths) ? raw.assetRelativePaths : {}),
      ...Object.keys(isObject(raw.assetContentHashes) ? raw.assetContentHashes : {})
    ]);
    for (const assetKey of rawAssetKeys) {
      if (rawAssetChangesInheritedIdentity(raw, base, assetKey)) changedAssetKeys.add(assetKey);
    }
  }
  for (const assetKey of changedAssetKeys) {
    if (!cleanString(raw.assetContentHashes?.[assetKey])) delete media.assetContentHashes[assetKey];
  }
  media.assetContentHashes = pruneAssetContentHashes(media.assetContentHashes, media);
  const reviewsSource = useInheritance
    ? {
        ...(isObject(base.assetReviews) ? base.assetReviews : {}),
        ...(isObject(raw.assetReviews) ? raw.assetReviews : {})
      }
    : { ...(isObject(raw.assetReviews) ? raw.assetReviews : {}) };
  for (const assetKey of changedAssetKeys) {
    if (!Object.prototype.hasOwnProperty.call(isObject(raw.assetReviews) ? raw.assetReviews : {}, assetKey)) {
      delete reviewsSource[assetKey];
    }
  }
  media.assetReviews = pruneAssetReviews(reviewsSource, media);
  return media;
}

function assetFieldSignature(branch = {}, assetKey) {
  return [
    cleanString(branch.assetUrls?.[assetKey]),
    cleanString(branch.assetStorageKeys?.[assetKey]),
    cleanString(branch.assetStoredPaths?.[assetKey]),
    cleanString(branch.assetRelativePaths?.[assetKey]),
    cleanString(branch.assetFileNames?.[assetKey]),
    cleanString(branch.assetContentHashes?.[assetKey])
  ].join("|");
}

function cloneAssetMaps(branch = {}) {
  return {
    assetFileNames: { ...(isObject(branch.assetFileNames) ? branch.assetFileNames : {}) },
    assetUrls: { ...(isObject(branch.assetUrls) ? branch.assetUrls : {}) },
    assetStorageKeys: { ...(isObject(branch.assetStorageKeys) ? branch.assetStorageKeys : {}) },
    assetStoredPaths: {
      ...(isObject(branch.assetStoredPaths) ? branch.assetStoredPaths : {}),
      ...(isObject(branch.assetRelativePaths) ? branch.assetRelativePaths : {})
    },
    assetContentHashes: { ...(isObject(branch.assetContentHashes) ? branch.assetContentHashes : {}) },
    assetReviews: { ...(isObject(branch.assetReviews) ? branch.assetReviews : {}) }
  };
}

export function dedupeLeakedBranchAssets(branches = []) {
  if (branches.length <= 1) return branches;
  const primary = branches[0];
  return branches.map((branch, index) => {
    if (index === 0) return branch;
    const maps = cloneAssetMaps(branch);
    let changed = false;
    for (const key of ASSET_KEYS) {
      const branchSig = assetFieldSignature(branch, key);
      if (!branchSig.replace(/\|/g, "")) continue;
      if (branchSig !== assetFieldSignature(primary, key)) continue;
      for (const mapName of ["assetFileNames", "assetUrls", "assetStorageKeys", "assetStoredPaths", "assetContentHashes"]) {
        if (maps[mapName][key]) {
          delete maps[mapName][key];
          changed = true;
        }
      }
      if (maps.assetReviews[key]) {
        delete maps.assetReviews[key];
        changed = true;
      }
    }
    if (!changed) return branch;
    maps.assetContentHashes = pruneAssetContentHashes(maps.assetContentHashes, maps);
    maps.assetReviews = pruneAssetReviews(maps.assetReviews, maps);
    return { ...branch, ...maps };
  });
}

export function branchHasReferenceAssets(branch = {}) {
  return countBranchMediaFields(branch) > 0;
}

export function branchAssetPreviewUrl(branch = {}, assetKey = "") {
  const url = cleanString(branch.assetUrls?.[assetKey]);
  if (url) return url;
  const storedPath = cleanString(branch.assetStoredPaths?.[assetKey] || branch.assetRelativePaths?.[assetKey]);
  if (storedPath) return `/file?path=${encodeURIComponent(storedPath)}`;
  return "";
}

export function resolveBranchMediaRefs(branch = {}, planMediaRefs = {}) {
  const refs = {};
  for (const key of ASSET_KEYS) {
    const branchUrl = cleanString(branch.assetUrls?.[key]);
    if (!branchUrl) continue;
    const planUrl = cleanString(planMediaRefs?.[key]);
    refs[key] = planUrl === branchUrl ? planUrl : branchUrl;
  }
  return refs;
}

function branchIdAt(index, raw = {}) {
  const rawId = cleanString(raw.branchId || raw.id);
  return rawId.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 48) || `branch_${index + 1}`;
}

function branchDraftHasContent(branch = {}) {
  return Boolean(
    cleanString(branch.productName)
    || cleanString(branch.cta)
    || cleanString(branch.materialDirection)
    || countBranchMediaFields(branch) > 0
  );
}

function stripBranchMeta(raw = {}) {
  if (!isObject(raw)) return {};
  const {
    branches: _branches,
    assetFileNames: _assetFileNames,
    assetUrls: _assetUrls,
    assetStorageKeys: _assetStorageKeys,
    assetStoredPaths: _assetStoredPaths,
    assetRelativePaths: _assetRelativePaths,
    assetContentHashes: _assetContentHashes,
    assetReviews: _assetReviews,
    branchId: _branchId,
    branchIndex: _branchIndex,
    branchLabel: _branchLabel,
    id: _id,
    label: _label,
    ...rest
  } = raw;
  return rest;
}

export function normalizeBranchDrafts(draft = {}, overrides = undefined) {
  const base = isObject(draft) ? draft : {};
  const rawBranches = Array.isArray(overrides)
    ? overrides
    : Array.isArray(base.branches)
      ? base.branches
      : [];
  const hasExplicitMultiBranch = rawBranches.length > 1;
  const source = rawBranches.length ? rawBranches : [base];
  const assetInheritFrom = hasExplicitMultiBranch ? null : base;
  const baseScalars = stripBranchMeta(base);

  const branches = source.map((raw, index) => {
    const branch = isObject(raw) ? raw : {};
    const branchScalars = stripBranchMeta(branch);
    const targetChannels = Array.isArray(branch.targetChannels) && branch.targetChannels.length
      ? branch.targetChannels
      : Array.isArray(base.targetChannels)
        ? base.targetChannels
        : [];
    const regions = Array.isArray(branch.regions) && branch.regions.length
      ? branch.regions
      : Array.isArray(base.regions)
        ? base.regions
        : [];
    const media = branchMediaFields(branch, { inheritFrom: assetInheritFrom });
    return {
      ...baseScalars,
      ...branchScalars,
      branchId: branchIdAt(index, branch),
      branchIndex: index + 1,
      branchLabel: cleanString(branch.branchLabel || branch.label || branch.displayName || base.displayName) || `改写 3.${index + 1}`,
      productName: cleanString(branch.productName) || cleanString(base.productName) || "Product",
      productLink: cleanString(branch.productLink) || cleanString(base.productLink),
      cta: cleanString(branch.cta) || cleanString(base.cta) || "Install now",
      ending: cleanString(branch.ending) || cleanString(base.ending) || "Try it today",
      currencySymbol: cleanString(branch.currencySymbol) || cleanString(base.currencySymbol),
      language: cleanString(branch.language) || cleanString(base.language),
      regions,
      targetChannels,
      promiseLevel: cleanString(branch.promiseLevel) || cleanString(base.promiseLevel) || "stable",
      materialDirection: cleanString(branch.materialDirection) || cleanString(base.materialDirection),
      voiceoverStyle: cleanString(branch.voiceoverStyle) || cleanString(base.voiceoverStyle),
      customPrompt: cleanString(branch.customPrompt) || cleanString(base.customPrompt),
      negativePrompt: cleanString(branch.negativePrompt) || cleanString(base.negativePrompt),
      variantPrompt: cleanString(branch.variantPrompt) || cleanString(base.variantPrompt),
      disclaimer: cleanString(branch.disclaimer) || cleanString(base.disclaimer),
      disclaimerPreset: cleanString(branch.disclaimerPreset) || cleanString(base.disclaimerPreset),
      disclaimerPresetId: cleanString(branch.disclaimerPresetId) || cleanString(base.disclaimerPresetId),
      disclaimerLanguage: cleanString(branch.disclaimerLanguage) || cleanString(base.disclaimerLanguage),
      disclaimerEnabled: branch.disclaimerEnabled ?? base.disclaimerEnabled,
      disclaimerOverlay: {
        ...(isObject(base.disclaimerOverlay) ? base.disclaimerOverlay : {}),
        ...(isObject(branch.disclaimerOverlay) ? branch.disclaimerOverlay : {})
      },
      disclaimerByLanguage: mergeLanguageMap(base.disclaimerByLanguage, branch.disclaimerByLanguage),
      ...media,
      truthRules: isObject(branch.truthRules) && Object.keys(branch.truthRules).length ? branch.truthRules : (base.truthRules || {})
    };
  }).filter(branchDraftHasContent);
  return hasExplicitMultiBranch ? dedupeLeakedBranchAssets(branches) : branches;
}

export function normalizeStoredBranchDrafts(templateSnapshot = null, branchDrafts = []) {
  const draft = isObject(templateSnapshot?.draft) ? templateSnapshot.draft : (isObject(templateSnapshot) ? templateSnapshot : {});
  const raw = Array.isArray(branchDrafts) ? branchDrafts : [];
  if (!raw.length) return [];
  return normalizeBranchDrafts(draft, raw);
}

export function branchSummaries(branches = []) {
  return branches.map((branch) => ({
    branchId: branch.branchId,
    branchIndex: branch.branchIndex,
    branchLabel: branch.branchLabel,
    productName: branch.productName,
    cta: branch.cta,
    materialDirection: branch.materialDirection || ""
  }));
}
