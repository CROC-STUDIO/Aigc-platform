export const REFERENCE_ASSET_ORDER = Object.freeze([
  "productIcon",
  "productScreenshot",
  "productRecording",
  "personAsset",
  "rewardElement"
]);

export const REFERENCE_VIDEO_ASSET_KEYS = new Set([
  "productRecording",
  "personAsset"
]);

const NON_SEEDANCE_REFERENCE_ASSET_KEYS = new Set([
  "ctaAsset",
  "endingAsset",
  "endingAssetInline"
]);

export const MAX_SEEDANCE_REFERENCE_ASSETS = 9;

const ASSET_KEY_LABELS = Object.freeze({
  productIcon: "产品 Logo",
  productScreenshot: "产品截图",
  productRecording: "产品录屏",
  ctaAsset: "CTA 图",
  endingAsset: "Ending 图",
  endingAssetInline: "Ending 图",
  personAsset: "人物素材",
  rewardElement: "奖励元素"
});

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

export function assetKeyLabel(assetKey = "") {
  return ASSET_KEY_LABELS[assetKey] || assetKey || "素材";
}

export function orderedReferenceAssets(assetUrls = {}) {
  const urls = assetUrls && typeof assetUrls === "object" ? assetUrls : {};
  const items = [];
  const seen = new Set();
  for (const key of REFERENCE_ASSET_ORDER) {
    const url = cleanString(urls[key]);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      key,
      url,
      isVideo: REFERENCE_VIDEO_ASSET_KEYS.has(key)
    });
  }
  for (const [key, rawUrl] of Object.entries(urls)) {
    if (REFERENCE_ASSET_ORDER.includes(key)) continue;
    if (NON_SEEDANCE_REFERENCE_ASSET_KEYS.has(key)) continue;
    const url = cleanString(rawUrl);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    items.push({
      key,
      url,
      isVideo: REFERENCE_VIDEO_ASSET_KEYS.has(key)
    });
  }
  return items;
}

export function buildReferenceAssetSlotGuide(assetUrls = {}, assetFileNames = {}) {
  const fileNames = assetFileNames && typeof assetFileNames === "object" ? assetFileNames : {};
  let imageIndex = 0;
  let videoIndex = 0;
  return orderedReferenceAssets(assetUrls).map((item) => {
    const orderLabel = item.isVideo ? `视频${++videoIndex}` : `图片${++imageIndex}`;
    return {
      assetKey: item.key,
      orderLabel,
      mediaType: item.isVideo ? "video" : "image",
      label: assetKeyLabel(item.key),
      fileName: cleanString(fileNames[item.key]),
      url: item.url
    };
  });
}

export function formatReferenceAssetSlotGuide(guide = []) {
  if (!Array.isArray(guide) || !guide.length) {
    return [
      "未上传 Seedance 参考素材。",
      "imagePrompt 与 seedancePrompt 按纯文案生成，不要使用 图片n / 视频n 指代。"
    ].join("\n");
  }
  const lines = [
    "已上传 Seedance 参考素材；确认生成后将按 omni_reference 顺序提交。",
    "imagePrompt 与 seedancePrompt 必须使用下列 orderLabel 指代对应素材，并保持主体特征一致："
  ];
  for (const slot of guide) {
    const namePart = slot.fileName ? `，文件名 ${slot.fileName}` : "";
    lines.push(`- ${slot.orderLabel} = ${slot.label}（assetKey=${slot.assetKey}${namePart}）`);
  }
  lines.push("示例：「图片1 中的产品 Logo 出现在手机左上角，视频1 的录屏作为中段 UI 演示。」");
  lines.push("禁止虚构未上传的素材编号；未列出的素材不得使用 图片n / 视频n 指代。");
  return lines.join("\n");
}
