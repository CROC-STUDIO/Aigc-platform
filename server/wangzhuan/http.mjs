import { makeRequestId } from "./ids.mjs";

export class WangzhuanError extends Error {
  constructor(code, message, data = {}, status) {
    super(message);
    this.name = "WangzhuanError";
    this.code = code;
    this.data = data && typeof data === "object" ? data : {};
    this.status = status ?? statusForCode(code);
  }
}

export const ERROR_HTTP_STATUS = Object.freeze({
  unauthenticated: 401,
  permission_denied: 403,
  validation_error: 400,
  template_not_found: 404,
  template_conflict: 409,
  reference_video_not_found: 404,
  invalid_video: 400,
  invalid_material: 400,
  file_too_large: 413,
  strong_rule_missing: 400,
  channel_rule_missing: 200,
  schema_invalid: 422,
  model_failed: 502,
  limit_confirmation_required: 409,
  hard_limit_exceeded: 400,
  batch_already_running: 409,
  batch_not_found: 404,
  not_running: 409,
  invalid_state_transition: 409,
  stitcher_unavailable: 503,
  no_segments: 409,
  stitch_failed: 500,
  unsupported_capability: 400,
  region_required: 400,
  remix_not_found: 404,
  output_not_found: 404,
  missing_required_file: 409,
  empty_download_set: 400,
  upstream_rate_limited: 429,
  upstream_failed: 502,
  internal_error: 500
});

export const ERROR_MESSAGES = Object.freeze({
  unauthenticated: "请先登录",
  permission_denied: "当前账号无权执行该操作",
  validation_error: "请检查表单字段",
  template_not_found: "模板不存在或已被删除",
  template_conflict: "模板已更新，请刷新后重试",
  channel_rule_missing: "未配置该渠道规则，已使用通用稳健规则",
  internal_error: "系统错误，请记录 requestId 并联系管理员"
});

export function statusForCode(code) {
  return ERROR_HTTP_STATUS[code] ?? 500;
}

export function okEnvelope(data = {}, requestId = makeRequestId()) {
  return { code: "ok", message: "", data, requestId };
}

export function errorEnvelope(error, requestId = makeRequestId()) {
  const code = error?.code || "internal_error";
  const message = error?.message || ERROR_MESSAGES[code] || ERROR_MESSAGES.internal_error;
  const data = error?.data && typeof error.data === "object" ? error.data : {};
  return { code, message, data, requestId };
}

export function sendEnvelope(res, payload, status = 200) {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-Request-Id": payload.requestId
  });
  res.end(body);
}

export function sendOk(res, data, requestId) {
  return sendEnvelope(res, okEnvelope(data, requestId), 200);
}

export function sendErrorEnvelope(res, error, requestId) {
  let safeError = error;
  if (!(safeError instanceof WangzhuanError)) {
    if (safeError?.code === "invalid_state_transition") {
      safeError = new WangzhuanError(
        "invalid_state_transition",
        "任务状态流转不被允许",
        safeError.details || {},
        409
      );
    } else {
      safeError = new WangzhuanError("internal_error", ERROR_MESSAGES.internal_error);
    }
  }
  return sendEnvelope(res, errorEnvelope(safeError, requestId), safeError.status);
}

export function requirePermission(user, permission) {
  if (!user) {
    throw new WangzhuanError("unauthenticated", ERROR_MESSAGES.unauthenticated);
  }
  const isAdmin = user.isAdmin || user.role === "admin";
  const permissions = user.permissions && typeof user.permissions === "object" ? user.permissions : {};
  const allowed = isAdmin || permissions[permission] === true || (permission === "template:admin" ? false : Object.keys(permissions).length === 0);
  if (!allowed) {
    throw new WangzhuanError("permission_denied", ERROR_MESSAGES.permission_denied, { requestedPermission: permission });
  }
  return true;
}
