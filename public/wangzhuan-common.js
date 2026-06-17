const JSON_HEADERS = { "Content-Type": "application/json" };

export class WangzhuanApiError extends Error {
  constructor(payload = {}, status = 0) {
    super(payload.message || payload.error || "请求失败");
    this.name = "WangzhuanApiError";
    this.code = payload.code || payload.error || "request_failed";
    this.data = payload.data || {};
    this.requestId = payload.requestId || "";
    this.status = status;
  }
}

export const channelLabels = {
  generic: "通用",
  meta_ads: "Meta Ads",
  tiktok_ads: "TikTok Ads",
  google_ads: "Google Ads",
  unity_ads: "Unity Ads",
  iron_source: "ironSource"
};

export const promiseLabels = {
  stable: "稳健版",
  strong_conversion: "强转化版",
  strong_commitment: "强承诺版"
};

export const operationLabels = {
  text_cta_ending_replace: "文字/CTA/ending 替换",
  logo_icon_cover_or_replace: "Logo/Icon 区域遮挡或替换",
  watermark_cover: "水印区域遮挡"
};

export const batchStatusLabels = {
  draft: "草稿",
  checking: "检查中",
  queued: "排队中",
  running: "生成中",
  stitching: "拼接中",
  qc: "质检中",
  succeeded: "已完成",
  partial_failed: "部分失败",
  failed: "失败",
  skipped: "已跳过",
  stopped: "已停止"
};

export const remixStatusLabels = {
  draft: "草稿",
  queued: "排队中",
  running: "处理中",
  qc: "质检中",
  preview_required: "待预览确认",
  succeeded: "已确认",
  partial_failed: "部分失败",
  failed: "失败",
  stopped: "已停止"
};

export const strongTruthFields = [
  ["rewardAmountRange", "收益金额范围"],
  ["rewardCondition", "收益触发条件"],
  ["withdrawalThreshold", "提现门槛"],
  ["withdrawalMethod", "提现方式"],
  ["arrivalTime", "到账时间"],
  ["applicableRegion", "适用地区"],
  ["applicableChannel", "适用渠道"],
  ["sourceOrUpdatedAt", "规则来源/更新时间"]
];

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export function $all(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function idempotencyKey(prefix) {
  if (crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function dataUrlFromFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result || "")));
    reader.addEventListener("error", () => reject(reader.error || new Error("文件读取失败")));
    reader.readAsDataURL(file);
  });
}

export function tinyVideoDataUrl(label = "sample") {
  return `data:video/mp4;base64,${btoa(`mock ${label} video`)}`;
}

export async function apiEnvelope(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers || {}) },
    credentials: "same-origin"
  });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new WangzhuanApiError({
      code: "invalid_json",
      message: "服务返回了无法解析的数据",
      requestId: response.headers.get("X-Request-Id") || ""
    }, response.status);
  }
  if (!response.ok || payload.code !== "ok") {
    throw new WangzhuanApiError(payload, response.status);
  }
  return payload.data;
}

export async function apiLegacy(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { ...JSON_HEADERS, ...(options.headers || {}) },
    credentials: "same-origin"
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) {
    throw new WangzhuanApiError({
      code: response.status === 401 ? "unauthenticated" : "legacy_error",
      message: payload.error || "请求失败"
    }, response.status);
  }
  return payload;
}

export async function downloadZip(request) {
  const response = await fetch("/api/wangzhuan/download", {
    method: "POST",
    headers: JSON_HEADERS,
    credentials: "same-origin",
    body: JSON.stringify(request)
  });
  const contentType = response.headers.get("Content-Type") || "";
  if (!response.ok) {
    let payload = {};
    if (contentType.includes("application/json")) {
      payload = await response.json().catch(() => ({}));
    }
    throw new WangzhuanApiError(payload, response.status);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") || "";
  const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || "wangzhuan-package.zip";
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  return { fileName, size: blob.size, requestId: response.headers.get("X-Request-Id") || "" };
}

export function showLogin(modal, message = "请先登录") {
  if (!modal) return;
  modal.hidden = false;
  const status = $(".login-status", modal);
  if (status) status.textContent = message;
}

export function hideLogin(modal) {
  if (modal) modal.hidden = true;
}

export async function bindLogin({ modal, badge, logoutBtn, onAuthed }) {
  const renderAuth = (auth) => {
    if (auth.authenticated) {
      hideLogin(modal);
      if (badge) badge.textContent = auth.user?.displayName || auth.user?.username || "已登录";
      if (logoutBtn) logoutBtn.hidden = false;
      onAuthed?.(auth.user);
      return true;
    }
    if (badge) badge.textContent = "未登录";
    if (logoutBtn) logoutBtn.hidden = true;
    showLogin(modal);
    return false;
  };

  $("#wangzhuanLoginBtn", modal)?.addEventListener("click", async () => {
    const status = $(".login-status", modal);
    if (status) status.textContent = "登录中...";
    try {
      const auth = await apiLegacy("/api/login", {
        method: "POST",
        body: JSON.stringify({
          username: $("#wangzhuanLoginUsername", modal)?.value || "",
          password: $("#wangzhuanLoginPassword", modal)?.value || ""
        })
      });
      renderAuth(auth);
    } catch (error) {
      if (status) status.textContent = error.message;
    }
  });

  logoutBtn?.addEventListener("click", async () => {
    await apiLegacy("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
    location.reload();
  });

  const auth = await apiLegacy("/api/auth").catch(() => ({ authenticated: false }));
  return renderAuth(auth);
}

export function renderError(target, error, context = "") {
  if (!target) return;
  const missing = Array.isArray(error?.data?.missingFields) ? error.data.missingFields : [];
  const capability = error?.data?.capability;
  target.hidden = false;
  target.innerHTML = `
    <strong>${escapeHtml(context || error?.code || "请求失败")}</strong>
    <span>${escapeHtml(error?.message || "请求失败")}</span>
    ${missing.length ? `<small>缺失字段：${missing.map(escapeHtml).join("、")}</small>` : ""}
    ${capability ? `<small>能力状态：${escapeHtml(capability.status || "unknown")}；provider：${escapeHtml(capability.provider || "unknown")}</small>` : ""}
    ${error?.requestId ? `<small>requestId：${escapeHtml(error.requestId)}</small>` : ""}
  `;
}

export function clearError(target) {
  if (!target) return;
  target.hidden = true;
  target.textContent = "";
}

export function badge(status, labelMap = batchStatusLabels) {
  const label = labelMap[status] || status || "未知";
  const tone = ["succeeded", "pass"].includes(status)
    ? "good"
    : ["failed", "partial_failed", "preview_required", "warn", "manual_required"].includes(status)
      ? "warn"
      : ["stopped", "unsupported"].includes(status)
        ? "bad"
        : "neutral";
  return `<span class="wz-badge ${tone}">${escapeHtml(label)}</span>`;
}

export function renderKeyValues(items) {
  return items.map(([key, value]) => `
    <div class="wz-kv">
      <span>${escapeHtml(key)}</span>
      <strong>${escapeHtml(value ?? "-")}</strong>
    </div>
  `).join("");
}

export function setBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    button.dataset.originalText = button.textContent;
    button.textContent = label || "处理中";
    button.disabled = true;
    return;
  }
  button.disabled = false;
  if (button.dataset.originalText) button.textContent = button.dataset.originalText;
}

export function terminalBatchStatus(status) {
  return ["succeeded", "partial_failed", "failed", "stopped", "skipped"].includes(status);
}

export function terminalRemixStatus(status) {
  return ["preview_required", "succeeded", "partial_failed", "failed", "stopped"].includes(status);
}

export function schedulePoll({ load, shouldStop, interval = 2000 }) {
  let timer = 0;
  const tick = async () => {
    const value = await load();
    if (shouldStop(value)) return;
    timer = window.setTimeout(tick, interval);
  };
  timer = window.setTimeout(tick, interval);
  return () => window.clearTimeout(timer);
}
