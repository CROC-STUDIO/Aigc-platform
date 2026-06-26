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

function branchIdAt(index, raw = {}) {
  const rawId = cleanString(raw.branchId || raw.id);
  return rawId.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 48) || `branch_${index + 1}`;
}

export function normalizeBranchDrafts(draft = {}, overrides = undefined) {
  const base = isObject(draft) ? draft : {};
  const rawBranches = Array.isArray(overrides)
    ? overrides
    : Array.isArray(base.branches)
      ? base.branches
      : [];
  const source = rawBranches.length ? rawBranches : [base];

  return source.map((raw, index) => {
    const branch = isObject(raw) ? raw : {};
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
    return {
      ...base,
      ...branch,
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
      assetFileNames: mergeAssetMap(base.assetFileNames, branch.assetFileNames),
      assetUrls: mergeAssetMap(base.assetUrls, branch.assetUrls),
      assetStorageKeys: mergeAssetMap(base.assetStorageKeys, branch.assetStorageKeys),
      assetStoredPaths: mergeAssetMap(base.assetStoredPaths, branch.assetStoredPaths),
      assetReviews: {
        ...(isObject(base.assetReviews) ? base.assetReviews : {}),
        ...(isObject(branch.assetReviews) ? branch.assetReviews : {})
      },
      truthRules: isObject(branch.truthRules) && Object.keys(branch.truthRules).length ? branch.truthRules : (base.truthRules || {})
    };
  }).filter((branch) => branch.productName || branch.cta || branch.materialDirection);
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
