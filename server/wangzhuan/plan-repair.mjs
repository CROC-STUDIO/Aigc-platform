function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeStringList(value) {
  if (Array.isArray(value)) return value.map((item) => cleanString(item)).filter(Boolean);
  const text = cleanString(value);
  return text ? [text] : [];
}

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function uniqueList(values = []) {
  return [...new Set(normalizeStringList(values))];
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeBooleanLike(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = cleanString(value).toLowerCase();
  if (["false", "0", "no", "n", "off", "否", "不", "不是"].includes(normalized)) return false;
  if (["true", "1", "yes", "y", "on", "是", "对"].includes(normalized)) return true;
  return fallback;
}

export const MANDATORY_HIGH_ATTRACTION_MONEY_VISUALS = Object.freeze([
  "real_cash_stack",
  "coin_burst",
  "cash_rain",
  "full_screen_money_rain",
  "full_screen_coin_rain"
]);

const DEFAULT_HIGH_ENERGY_VOICEOVER_REPAIR = "high-energy, fast-paced, emotionally expressive, contagious net-earning ad delivery; the speaker sounds excited, urgent, credible, and drives curiosity in every spoken beat";
const DEFAULT_OPENING_HOOK_REPAIR = "first 1-2 seconds must start with a high-impact attention hook scene: visible reward feedback, top balance/reward counter rising, coin or cash burst, surprised human reaction, or withdrawal-success style proof visual before any slow explanation";

export function copyrightMusicRestriction(language = "") {
  const value = cleanString(language).toLowerCase();
  if (value.startsWith("zh") || /[一-鿿]/u.test(language)) return "禁止使用版权音乐。只使用原创、免版税或已获授权的音频。";
  if (value.startsWith("pt")) return "Não use música protegida por direitos autorais. Use apenas áudio original, livre de royalties ou devidamente licenciado.";
  if (value.startsWith("es")) return "No uses música con derechos de autor. Utiliza únicamente audio original, libre de regalías o debidamente autorizado.";
  if (value.startsWith("id")) return "Jangan gunakan musik berhak cipta. Gunakan hanya audio orisinal, bebas royalti, atau berlisensi.";
  if (value.startsWith("ja")) return "著作権で保護された音楽は禁止です。オリジナル、ロイヤリティフリー、または適切に許諾された音声のみを使用すること。";
  if (value.startsWith("ko")) return "저작권이 있는 음악은 금지입니다. 오리지널, 로열티 프리 또는 적법하게 라이선스된 오디오만 사용하세요.";
  return "Do not use copyrighted music. Use only original, royalty-free, or properly licensed audio.";
}

function normalizeConversionEffect(effect = "") {
  const value = cleanString(effect).toLowerCase();
  const aliases = {
    top_balance_growth: "top_balance_growth",
    top_withdrawal_growth: "top_balance_growth",
    reward_number_growth: "reward_number_growth",
    earnings_number: "reward_number_growth",
    continuous_earnings_rise: "continuous_earnings_rise",
    withdrawal_success: "withdrawal_success",
    arrival_animation: "withdrawal_success",
    withdrawal_record: "withdrawal_success",
    coin_burst: "coin_burst",
    cash_rain: "cash_rain",
    real_cash: "real_cash_stack",
    real_cash_stack: "real_cash_stack",
    cash_stack: "real_cash_stack",
    money_rain: "full_screen_money_rain",
    full_screen_money_rain: "full_screen_money_rain",
    full_screen_cash_rain: "full_screen_money_rain",
    coin_rain: "full_screen_coin_rain",
    full_screen_coin_rain: "full_screen_coin_rain",
    full_screen_coin_cash_rain: "cash_rain",
    real_cash_sound_cue: "real_cash_sound_cue",
    fast_reward_cue: "fast_reward_cue"
  };
  return aliases[value] || value;
}

function conversionEffectToMoneyVisual(effect = "") {
  const normalized = normalizeConversionEffect(effect);
  return [
    "top_balance_growth",
    "reward_number_growth",
    "continuous_earnings_rise",
    "withdrawal_success",
    "coin_burst",
    "cash_rain",
    "real_cash_stack",
    "full_screen_money_rain",
    "full_screen_coin_rain",
    "real_cash_sound_cue",
    "fast_reward_cue"
  ].includes(normalized) ? normalized : "";
}

function normalizeConversionEffectOpportunities(values = [], context = {}) {
  const source = Array.isArray(values) ? values : [];
  const seen = new Set();
  return source
    .map((item) => {
      const effect = normalizeConversionEffect(typeof item === "string" ? item : item?.effect);
      if (!effect) return null;
      const placement = cleanString(item?.placement) || (effect === "withdrawal_success" ? "phone UI proof beat" : "top overlay or app interaction beat");
      const key = `${effect}::${placement}`;
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        effect,
        placement,
        reason: cleanString(item?.reason) || "carried from source analysis or fission repair",
        language: cleanString(item?.language) || cleanString(context.targetLanguage),
        currencySymbol: cleanString(item?.currencySymbol) || cleanString(context.currencySymbol),
        useExactAmount: false
      };
    })
    .filter(Boolean);
}

function moneyVisualsFromSignals(signals = {}) {
  const values = [];
  for (const [key, signal] of Object.entries(signals || {})) {
    if (!signal?.present && !signal?.shouldReplicate) continue;
    if (key === "withdrawalSuccess") values.push("withdrawal_success");
    if (key === "earningsNumber") values.push("top_balance_growth", "reward_number_growth", "continuous_earnings_rise");
    if (key === "cashCoinFeedback") values.push("coin_burst", "cash_rain", "real_cash_sound_cue");
    if (key === "fastRewardCue") values.push("fast_reward_cue");
  }
  return values;
}

function truthRulesAllowExactMoney(context = {}) {
  if (context.allowExactMoneyAmounts === true) return true;
  const truthRules = normalizeObject(context.truthRules);
  return Boolean(truthRules.allowExactMoneyAmounts || truthRules.rewardAmountRange || truthRules.allowedExactAmounts);
}

function sanitizeMoneyAmounts(prompt = "", context = {}) {
  if (truthRulesAllowExactMoney(context)) return cleanString(prompt);
  const currencySymbol = cleanString(context.currencySymbol);
  const replacement = currencySymbol ? `${currencySymbol} generic reward amount` : "generic reward amount";
  return cleanString(prompt)
    .replace(/(?:R\$|US\$|\$|USD|BRL|RMB|CNY|Rp|IDR|¥|元|人民币)\s*\d(?:[\d.,]*\d)?/giu, replacement)
    .replace(/\d(?:[\d.,]*\d)?\s*(?:R\$|US\$|\$|USD|BRL|RMB|CNY|Rp|IDR|¥|元|人民币)/giu, replacement);
}

function forbiddenCurrencyText(currencySymbol = "") {
  const target = cleanString(currencySymbol);
  const candidates = ["$", "USD", "US$", "R$", "BRL", "Rp", "IDR", "¥", "RMB", "CNY", "元", "人民币"];
  return candidates
    .filter((item) => item !== target)
    .filter((item) => !(target === "¥" && item === "元"))
    .join(", ");
}

function normalizeSubtitleWorkflow(plan = {}, context = {}) {
  const source = normalizeObject(plan.subtitleWorkflow);
  const fallback = normalizeObject(context.subtitleWorkflow);
  const subtitles = normalizeStringList(plan.subtitles).length
    ? normalizeStringList(plan.subtitles)
    : normalizeStringList(context.defaultSubtitles);
  const subtitleScript = normalizeStringList(source.subtitleScript).length
    ? normalizeStringList(source.subtitleScript)
    : normalizeStringList(fallback.subtitleScript).length
      ? normalizeStringList(fallback.subtitleScript)
      : subtitles;

  return {
    burnedInSubtitles: false,
    postSubtitleRequired: Object.hasOwn(source, "postSubtitleRequired")
      ? normalizeBooleanLike(source.postSubtitleRequired, true)
      : normalizeBooleanLike(fallback.postSubtitleRequired, true),
    provider: cleanString(source.provider) || cleanString(fallback.provider) || "pixel_tech",
    subtitleScript
  };
}

function localizedFallbackText(kind, language = "") {
  const normalized = cleanString(language).toLowerCase();
  if (normalized.startsWith("zh")) {
    return kind === "ending" ? "继续按步骤体验" : "继续";
  }
  if (normalized.startsWith("id")) {
    return kind === "ending" ? "Lanjutkan sesuai aturan aplikasi" : "Lanjutkan";
  }
  if (normalized.startsWith("pt")) {
    return kind === "ending" ? "Continue seguindo as regras do app" : "Continuar";
  }
  if (normalized.startsWith("es")) {
    return kind === "ending" ? "Continúa siguiendo las reglas de la app" : "Continuar";
  }
  return kind === "ending" ? "Continue following the app rules" : "Continue";
}

export function repairSeedancePromptContract(prompt, context = {}) {
  const targetLanguage = cleanString(context.targetLanguage);
  const sourceLanguage = cleanString(context.sourceLanguage) || cleanString(context.originalLanguage) || targetLanguage;
  const targetRegion = cleanString(context.targetRegion);
  const currencySymbol = cleanString(context.currencySymbol);
  const currencyName = cleanString(context.currencyName);
  const localeIdentity = cleanString(context.localeIdentity);
  const characterDiversity = cleanString(context.characterDiversity);
  const previousSliceId = cleanString(context.previousSliceId);
  const isContinuousSlice = cleanString(context.continuityMode) === "continuous_from_previous"
    || Boolean(previousSliceId);
  const moneyVisualsDisabled = Boolean(context.disableMandatoryMoneyVisuals);
  const voiceoverPerformance = cleanString(context.voiceoverPerformance)
    || (moneyVisualsDisabled
      ? "high-energy, fast-paced, emotionally expressive short-drama trailer delivery with urgent but natural performance"
      : DEFAULT_HIGH_ENERGY_VOICEOVER_REPAIR);
  const openingHookRepair = cleanString(context.openingHookRepair) || DEFAULT_OPENING_HOOK_REPAIR;
  const moneyVisuals = uniqueList(context.moneyVisuals);
  const effectOpportunities = normalizeConversionEffectOpportunities(context.conversionEffectOpportunities, context);
  const isOpeningSlice = Boolean(context.isOpeningSlice);
  const isMandatoryMoneyVisualCarrier = Boolean(context.mandatoryMoneyVisualCarrier || isOpeningSlice);
  const forbiddenCurrencies = forbiddenCurrencyText(currencySymbol);
  const additions = [];
  let repaired = sanitizeMoneyAmounts(prompt, context);
  if (isContinuousSlice) {
    repaired = repaired.replace(
      /\s*Character diversity requirement for this slice:.*?This slice must visibly differ from adjacent slices in person, scene, clothing, and camera setup\./gis,
      ""
    ).trim();
  }

  if (targetLanguage && !new RegExp(`targetLanguage\\s*=\\s*${escapeRegExp(targetLanguage)}|language must be ${escapeRegExp(targetLanguage)}|use target language ${escapeRegExp(targetLanguage)}`, "i").test(repaired)) {
    additions.push(`Hard language lock: targetLanguage=${targetLanguage}; all visible scene text, generated app/UI microcopy, subtitles/captions, CTA wording, voiceover, spoken dialogue, and audio direction must use ${targetLanguage} only. Do not show Chinese, English defaults, source-video language, or mixed-language text unless ${targetLanguage} explicitly requires it.`);
  }
  if (targetRegion && !new RegExp(`targetRegion\\s*=\\s*${escapeRegExp(targetRegion)}|targetRegion=${escapeRegExp(targetRegion)}|region ${escapeRegExp(targetRegion)}`, "i").test(repaired)) {
    additions.push(`Hard region lock: targetRegion=${targetRegion}; people, faces, clothing, homes, streets, phones, UI habits, and voice identity must match the target market.`);
  }
  if (!moneyVisualsDisabled && currencySymbol && !repaired.includes(currencySymbol)) {
    additions.push(`Hard currency lock: any money-related page, balance, withdrawal screen, reward counter, payout UI, cash/coin overlay, or top balance overlay must visibly use ${currencySymbol}${currencyName ? ` (${currencyName})` : ""} only; no exact payout amount.`);
  }
  if (!moneyVisualsDisabled && currencySymbol) {
    additions.push(`Forbidden currency repair: do not show ${forbiddenCurrencies}; use only ${currencySymbol} for generic non-specific reward or withdrawal visuals.`);
  }
  if (localeIdentity && !repaired.includes(localeIdentity)) {
    additions.push(`Local identity repair: ${localeIdentity}.`);
  }
  if (!isContinuousSlice && characterDiversity && !/Character diversity requirement|must visibly differ from adjacent slices|person, scene, clothing/i.test(repaired)) {
    additions.push(`Character diversity requirement for this slice: ${characterDiversity}. This slice must visibly differ from adjacent slices in person, scene, clothing, and camera setup.`);
  }
  if (isContinuousSlice && !/Continuity preservation requirement/i.test(repaired)) {
    const anchors = context.globalContinuityAnchors && typeof context.globalContinuityAnchors === "object"
      ? JSON.stringify(context.globalContinuityAnchors)
      : cleanString(context.globalContinuityAnchors);
    const startState = context.startFrameState && typeof context.startFrameState === "object"
      ? JSON.stringify(context.startFrameState)
      : cleanString(context.startFrameState);
    const endState = context.endFrameState && typeof context.endFrameState === "object"
      ? JSON.stringify(context.endFrameState)
      : cleanString(context.endFrameState);
    additions.push(`Continuity preservation requirement: continue from previousSliceId=${previousSliceId || "previous slice"}; keep the same ensemble identity, character relationships, wardrobe, scene, lighting, product/UI state, voice, and room tone. Global anchors: ${anchors || "preserve prior established anchors"}. Start frame state: ${startState || "continue the approved prior tail frame"}. End frame state: ${endState || "advance the same scene without resetting identity"}. Any generic instruction to change person, scene, clothing, camera setup, or voice is overridden for this slice.`);
  }
  if (!/Voiceover performance repair|high-energy|fast-paced|emotionally expressive|contagious/i.test(repaired)) {
    additions.push(`Voiceover performance repair: all spoken lines and audio direction for this slice must use ${voiceoverPerformance}; avoid slow, flat, neutral explanatory delivery.`);
  }
  if (isOpeningSlice && !/Opening hook repair|first 1-2 seconds|first two seconds|high-impact attention hook/i.test(repaired)) {
    additions.push(moneyVisualsDisabled
      ? "Opening hook repair: the first 1-2 seconds must begin with a high-impact narrative conflict, decisive facial reaction, or concrete character action; do not show balance, reward, cash, coin, payout, or withdrawal imagery, and do not begin with a slow walking setup or calm explanation."
      : `Opening hook repair: ${openingHookRepair}; do not begin with a slow walking setup or calm explanation.`);
  }
  if (!/no burned subtitles|no captions|no dense text blocks/i.test(repaired)) {
    additions.push("Subtitle repair: no burned subtitles, no captions, no dense text blocks, no paragraph text; if visible text appears, keep only 1-3 short UI words in the target language.");
  }
  if (!/copyrighted music|版权音乐|direitos autorais|derechos de autor|berhak cipta|著作権で保護された音楽|저작권이 있는 음악/i.test(repaired)) {
    additions.push(copyrightMusicRestriction(sourceLanguage));
  }
  if (!/no gibberish|no pseudo-text|avoid AI-generated gibberish|real product screenshots/i.test(repaired)) {
    additions.push("UI text repair: avoid AI-generated gibberish text, pseudo-letters, fake unreadable app UI, and dense generated screens; when a phone UI is needed, use approved product screenshots/reference assets or simple icon/button/progress visuals with only 1-3 short target-language words.");
  }
  if (!/no disclaimer text inside|post-production bottom overlay only|do not generate disclaimer/i.test(repaired)) {
    additions.push("Disclaimer repair: do not generate disclaimer, policy, terms, legal, or long warning text inside Seedance frames; any disclaimer is added only by post-production bottom overlay, so keep the generated frame clean and readable.");
  }
  if (moneyVisuals.length || effectOpportunities.length) {
    const effectText = uniqueList([
      ...moneyVisuals,
      ...effectOpportunities.map((item) => item.effect)
    ]).join(", ");
    if (effectText && !repaired.includes(effectText)) {
      if (isMandatoryMoneyVisualCarrier) {
        additions.push(`Mandatory wangzhuan visual carrier repair: this slice is the final-video carrier for at least one visible high-attraction net-earning visual, such as real cash, coins, cash rain, coin burst, full-screen money rain, or full-screen coin rain. Carry these money/reward visual opportunities into the shot plan where natural: ${effectText}; intensity can vary by slice, but this final video must visibly include at least one high-attraction money visual; when this is the opening slice, place the strongest visible effect in the first 0-3 seconds; keep all amounts generic and currency-locked.`);
      } else {
        additions.push(`Conversion visual repair: preserve only the observed or selected money/reward visual opportunities for this slice where natural: ${effectText}; do not force extra full-screen cash or coin effects here unless they fit this slice; keep all amounts generic and currency-locked.`);
      }
    }
  }
  if (!/No watermark|no competitor logo/i.test(repaired)) {
    additions.push("Brand safety repair: no watermark, no competitor logo.");
  }

  return [repaired, ...additions].filter(Boolean).join(" ");
}

export function repairFormalPlanContract(plan = {}, context = {}) {
  const targetLanguage = cleanString(plan.targetLanguage) || cleanString(context.targetLanguage);
  const targetRegion = cleanString(plan.targetRegion) || cleanString(context.targetRegion);
  const currencySymbol = cleanString(plan.currencySymbol) || cleanString(context.currencySymbol);
  const currencyName = cleanString(plan.currencyName) || cleanString(context.currencyName);
  const localeIdentity = cleanString(plan.localeIdentity) || cleanString(context.localeIdentity);
  const sourceSlice = context.sourceSlice || {};
  const isOpeningSlice = Boolean(context.isOpeningSlice || context.segmentIndex === 1 || plan.segmentIndex === 1);
  const moneyVisualsDisabled = Boolean(context.disableMandatoryMoneyVisuals || plan.disableMandatoryMoneyVisuals);
  const sourceOpportunities = moneyVisualsDisabled
    ? []
    : [
        ...normalizeConversionEffectOpportunities(sourceSlice.conversionEffectOpportunities, { targetLanguage, currencySymbol }),
        ...normalizeConversionEffectOpportunities(plan.conversionEffectOpportunities, { targetLanguage, currencySymbol }),
        ...normalizeConversionEffectOpportunities(context.conversionEffectOpportunities, { targetLanguage, currencySymbol })
      ];
  const sourceMoneyVisuals = sourceOpportunities
    .map((item) => conversionEffectToMoneyVisual(item.effect))
    .filter(Boolean);
  const openingMoneyVisuals = !moneyVisualsDisabled && isOpeningSlice && context.enableOpeningConversionEffects !== false
    ? ["top_balance_growth", "continuous_earnings_rise", "real_cash_sound_cue"]
    : [];
  const isMandatoryMoneyVisualCarrier = !moneyVisualsDisabled
    && Boolean(context.mandatoryMoneyVisualCarrier ?? isOpeningSlice);
  const mandatoryMoneyVisuals = !isMandatoryMoneyVisualCarrier
    ? []
    : MANDATORY_HIGH_ATTRACTION_MONEY_VISUALS;
  const moneyVisuals = uniqueList([
    ...mandatoryMoneyVisuals,
    ...normalizeStringList(plan.moneyVisuals),
    ...normalizeStringList(context.moneyVisuals),
    ...(moneyVisualsDisabled ? [] : moneyVisualsFromSignals(plan.conversionSignals || sourceSlice.conversionSignals)),
    ...sourceMoneyVisuals,
    ...openingMoneyVisuals
  ]);
  const subtitles = normalizeStringList(plan.subtitles).length
    ? normalizeStringList(plan.subtitles).slice(0, 2)
    : normalizeStringList(context.defaultSubtitles).slice(0, 2);
  const voiceover = cleanString(plan.voiceover) || subtitles.join(" ") || cleanString(context.defaultVoiceover);
  const cta = cleanString(plan.cta) || cleanString(context.defaultCta) || localizedFallbackText("cta", targetLanguage);
  const ending = cleanString(plan.ending) || cleanString(context.defaultEnding) || localizedFallbackText("ending", targetLanguage);
  const rawSliceDurationSec = Number.isFinite(Number(plan.sliceDurationSec))
    ? Number(plan.sliceDurationSec)
    : Number(context.sliceDurationSec || sourceSlice.durationSec || 15);
  const sliceDurationSec = Math.max(5, Math.min(15, rawSliceDurationSec));
  const repairedOpportunities = normalizeConversionEffectOpportunities([
    ...sourceOpportunities,
    ...moneyVisuals.map((effect) => ({
      effect,
      placement: effect === "withdrawal_success" ? "phone UI proof beat" : "top overlay or app interaction beat",
      reason: "normalized into final formal plan"
    }))
  ], { targetLanguage, currencySymbol });
  const previousSliceId = cleanString(context.previousSliceId) || cleanString(sourceSlice.previousSliceId);
  const continuityMode = cleanString(context.continuityMode) || cleanString(sourceSlice.continuityMode);
  const isContinuousSlice = continuityMode === "continuous_from_previous" || Boolean(previousSliceId);
  const characterDiversity = isContinuousSlice
    ? ""
    : cleanString(context.characterDiversity)
      || cleanString(plan.characterDiversityPlan?.currentSlice)
      || cleanString(context.characterDiversityPlan?.currentSlice);
  const subtitleWorkflow = normalizeSubtitleWorkflow(plan, context);
  const repairedPrompt = repairSeedancePromptContract(plan.seedancePrompt, {
    targetLanguage,
    targetRegion,
    currencySymbol,
    currencyName,
    localeIdentity,
    characterDiversity,
    continuityMode,
    previousSliceId,
    startFrameState: context.startFrameState ?? sourceSlice.startFrameState,
    endFrameState: context.endFrameState ?? sourceSlice.endFrameState,
    globalContinuityAnchors: context.globalContinuityAnchors ?? sourceSlice.globalContinuityAnchors,
    moneyVisuals,
    conversionEffectOpportunities: repairedOpportunities,
    isOpeningSlice,
    voiceoverPerformance: cleanString(context.voiceoverPerformance) || cleanString(plan.voiceoverPerformance),
    openingHookRepair: cleanString(context.openingHookRepair) || cleanString(plan.openingHookRepair),
    mandatoryMoneyVisualCarrier: isMandatoryMoneyVisualCarrier,
    disableMandatoryMoneyVisuals: moneyVisualsDisabled,
    truthRules: context.truthRules,
    allowExactMoneyAmounts: context.allowExactMoneyAmounts
  });
  const hasWithdrawal = moneyVisuals.includes("withdrawal_success");
  const complianceNotes = uniqueList([
    ...normalizeStringList(plan.complianceNotes),
    "Repair applied: target language, region, currency, subtitle, and conversion-effect contracts were normalized before validation.",
    isMandatoryMoneyVisualCarrier
      ? "Repair applied: this slice carries the final-video requirement for at least one visible high-attraction wangzhuan visual such as real cash, coins, cash rain, coin burst, full-screen money rain, or full-screen coin rain."
      : "",
    "Repair applied: voiceover must be high-energy, fast-paced, emotionally expressive, and contagious instead of slow neutral explanation.",
    isOpeningSlice ? "Repair applied: opening slice must start with a high-impact hook scene in the first 1-2 seconds and front-load reward/cash/coin feedback where natural." : "",
    currencySymbol ? `Repair applied: money-related visuals must use ${currencySymbol} only and avoid exact payout amounts.` : "",
    "Repair applied: Seedance prompt must avoid burned subtitles; subtitle scripts remain post-process fields."
  ]);

  return {
    ...plan,
    targetLanguage,
    targetRegion,
    currencySymbol,
    currencyName,
    localeIdentity,
    sliceDurationSec,
    subtitles,
    voiceover,
    cta,
    ending,
    seedancePrompt: repairedPrompt,
    moneyVisuals,
    withdrawalVisual: cleanString(plan.withdrawalVisual) || (hasWithdrawal ? `generic AI-generated withdrawal success visual using ${currencySymbol || "target currency"} symbol without exact amount` : ""),
    conversionEffectOpportunities: repairedOpportunities,
    subtitleWorkflow,
    mediaRefs: normalizeObject(plan.mediaRefs),
    complianceNotes,
    repairApplied: true,
    characterDiversityPlan: {
      ...(context.characterDiversityPlan || {}),
      ...(plan.characterDiversityPlan || {}),
      ...(isContinuousSlice
        ? { currentSlice: "" }
        : characterDiversity ? { currentSlice: characterDiversity } : {}),
      mustDifferFromAdjacentSlices: isContinuousSlice
        ? false
        : plan.characterDiversityPlan?.mustDifferFromAdjacentSlices ?? context.characterDiversityPlan?.mustDifferFromAdjacentSlices ?? true
    }
  };
}
