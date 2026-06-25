import {
  PROMISE_LEVELS,
  REQUIRED_DRAFT_FIELDS,
  REQUIRED_STRONG_TRUTH_FIELDS,
  TARGET_CHANNELS,
  TEMPLATE_ADMIN_ACTIONS,
  TEMPLATE_SAVE_MODES
} from "./constants.mjs";
import { WangzhuanError, requirePermission } from "./http.mjs";
import { makeAuditEventId, makeTemplateId, makeTemplateVersionId } from "./ids.mjs";
import { hasWangzhuanFactsStore, loadTemplateStoreFromMysql, syncTemplateStoreFacts } from "./mysql-facts.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const TEMPLATE_STORE_DEFAULT = Object.freeze({
  schemaVersion: "templates.v1",
  defaultTemplateId: "",
  nextTemplateSeq: 1,
  templates: []
});

function currentUser(context) {
  return context.user ?? context.currentUser?.() ?? null;
}

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? currentUser(context)?.userId ?? currentUser(context)?.username ?? "local";
}

function clone(value) {
  return structuredClone(value);
}

async function loadTemplateStore(context) {
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取模板状态");
  }
  const mysqlStore = await loadTemplateStoreFromMysql(context);
  const store = mysqlStore ?? TEMPLATE_STORE_DEFAULT;
  return {
    schemaVersion: "templates.v1",
    defaultTemplateId: "",
    nextTemplateSeq: 1,
    templates: [],
    ...store,
    templates: Array.isArray(store.templates) ? store.templates : []
  };
}

async function saveTemplateStore(context, store) {
  const synced = await syncTemplateStoreFacts(context, store);
  if (synced?.skipped) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存模板状态");
  }
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

export function validateTemplateDraft(draft) {
  const missingFields = [];
  if (!draft || typeof draft !== "object") {
    throw new WangzhuanError("validation_error", "模板草稿不能为空", { missingFields: REQUIRED_DRAFT_FIELDS });
  }
  for (const field of REQUIRED_DRAFT_FIELDS) {
    const value = draft[field];
    if (Array.isArray(value)) {
      if (value.length === 0) missingFields.push(field);
    } else if (value === undefined || value === null || value === "") {
      missingFields.push(field);
    }
  }
  if (missingFields.length) {
    throw new WangzhuanError("validation_error", "模板草稿缺少必填字段", { missingFields });
  }
  if (!PROMISE_LEVELS.includes(draft.promiseLevel)) {
    throw new WangzhuanError("validation_error", "promiseLevel 不在合同枚举内", { field: "promiseLevel" });
  }
  if (!Array.isArray(draft.targetChannels) || draft.targetChannels.some((channel) => !TARGET_CHANNELS.includes(channel))) {
    throw new WangzhuanError("validation_error", "targetChannels 不在合同枚举内", { field: "targetChannels" });
  }
  if (![15, 30].includes(Number(draft.defaultDurationSec))) {
    throw new WangzhuanError("validation_error", "defaultDurationSec 只能是 15 或 30", { field: "defaultDurationSec" });
  }
  if (draft.defaultOutputRatio !== "9:16") {
    throw new WangzhuanError("validation_error", "defaultOutputRatio 首期只支持 9:16", { field: "defaultOutputRatio" });
  }
  if (draft.promiseLevel === "strong_commitment") {
    const missingTruthFields = REQUIRED_STRONG_TRUTH_FIELDS.filter((field) => !isNonEmptyString(draft.truthRules?.[field]));
    if (missingTruthFields.length) {
      throw new WangzhuanError("validation_error", "强承诺需要补齐真实收益规则", { missingFields: missingTruthFields });
    }
  }
}

function activeTemplates(store, includeArchived) {
  return store.templates.filter((template) => {
    if (template.status === "deleted") return false;
    if (!includeArchived && template.status === "archived") return false;
    return true;
  });
}

export async function listTemplates(context, query = {}) {
  requirePermission(currentUser(context), "wangzhuan:view");
  const includeArchived = query.includeArchived === true || query.includeArchived === "true";
  const channel = query.channel;
  const region = query.region;
  const store = await loadTemplateStore(context);
  const templates = activeTemplates(store, includeArchived).filter((template) => {
    if (channel && !template.draft?.targetChannels?.includes(channel)) return false;
    if (region && !template.draft?.regions?.includes(region)) return false;
    return true;
  });
  return {
    templates,
    defaultTemplateId: store.defaultTemplateId,
    permissions: {
      canCreateVersion: true,
      canAdminTemplates: Boolean(currentUser(context)?.isAdmin || currentUser(context)?.role === "admin")
    }
  };
}

function latestVersionNumber(store, templateId) {
  return store.templates
    .filter((template) => template.templateId === templateId)
    .reduce((max, template) => Math.max(max, Number(template.versionNumber) || 0), 0);
}

function latestTemplate(store, templateId) {
  return store.templates
    .filter((template) => template.templateId === templateId && template.status !== "deleted")
    .sort((a, b) => b.versionNumber - a.versionNumber)[0];
}

function versionById(store, versionId) {
  return store.templates.find((template) => template.versionId === versionId && template.status !== "deleted");
}

export async function saveTemplate(context, request = {}) {
  requirePermission(currentUser(context), "template:create_version");
  if (!TEMPLATE_SAVE_MODES.includes(request.mode)) {
    throw new WangzhuanError("validation_error", "模板保存模式不支持", { field: "mode" });
  }
  validateTemplateDraft(request.draft);

  const store = await loadTemplateStore(context);
  const now = new Date().toISOString();
  let templateId;
  let versionNumber;
  let isDefault = false;

  if (request.mode === "create" || request.mode === "copy") {
    if (request.mode === "copy" && !versionById(store, request.copyFromVersionId)) {
      throw new WangzhuanError("template_not_found", "模板不存在或已被删除", { versionId: request.copyFromVersionId });
    }
    const seq = store.nextTemplateSeq || 1;
    templateId = makeTemplateId(request.draft.displayName, seq);
    store.nextTemplateSeq = seq + 1;
    versionNumber = 1;
    isDefault = !store.defaultTemplateId;
    if (isDefault) store.defaultTemplateId = templateId;
  } else {
    templateId = request.templateId;
    if (!templateId || !latestTemplate(store, templateId)) {
      throw new WangzhuanError("template_not_found", "模板不存在或已被删除", { templateId });
    }
    versionNumber = latestVersionNumber(store, templateId) + 1;
    isDefault = store.defaultTemplateId === templateId;
  }

  const template = {
    templateId,
    versionId: makeTemplateVersionId(templateId, versionNumber),
    versionNumber,
    status: "active",
    isDefault,
    draft: clone(request.draft),
    createdBy: currentUserId(context),
    createdAt: now,
    updatedAt: now
  };
  store.templates.push(template);
  await saveTemplateStore(context, store);

  const auditEventId = makeAuditEventId();
  await recordTelemetryEvent(context, "product_template_saved", {
    templateId,
    versionId: template.versionId,
    mode: request.mode,
    targetChannels: template.draft.targetChannels,
    promiseLevel: template.draft.promiseLevel,
    createdBy: currentUserId(context)
  }, { audit: true });
  return { template, auditEventId };
}

export async function adminTemplateAction(context, request = {}) {
  requirePermission(currentUser(context), "template:admin");
  if (!TEMPLATE_ADMIN_ACTIONS.includes(request.action)) {
    throw new WangzhuanError("validation_error", "模板管理动作不支持", { field: "action" });
  }
  const store = await loadTemplateStore(context);
  const matched = store.templates.filter((template) => template.templateId === request.templateId);
  if (!matched.length) {
    throw new WangzhuanError("template_not_found", "模板不存在或已被删除", { templateId: request.templateId });
  }

  let status = matched[0].status;
  let versionId = request.versionId;
  const now = new Date().toISOString();

  if (request.action === "archive" || request.action === "delete") {
    status = request.action === "archive" ? "archived" : "deleted";
    for (const template of matched) {
      template.status = status;
      template.updatedAt = now;
    }
    if (status === "deleted" && store.defaultTemplateId === request.templateId) store.defaultTemplateId = "";
  } else if (request.action === "rename") {
    if (!isNonEmptyString(request.displayName)) {
      throw new WangzhuanError("validation_error", "displayName 不能为空", { field: "displayName" });
    }
    for (const template of matched) {
      template.draft.displayName = request.displayName;
      template.updatedAt = now;
    }
  } else if (request.action === "set_default" || request.action === "rollback_default") {
    const selected = request.versionId ? versionById(store, request.versionId) : latestTemplate(store, request.templateId);
    if (!selected || selected.templateId !== request.templateId) {
      throw new WangzhuanError("template_not_found", "模板不存在或已被删除", { versionId: request.versionId });
    }
    store.defaultTemplateId = request.templateId;
    versionId = selected.versionId;
    for (const template of store.templates) {
      template.isDefault = template.templateId === request.templateId;
      template.updatedAt = now;
    }
  }

  await saveTemplateStore(context, store);
  const auditEventId = makeAuditEventId();
  await recordTelemetryEvent(context, "product_template_admin_changed", {
    templateId: request.templateId,
    versionId,
    action: request.action,
    status
  }, { audit: true });

  return {
    templateId: request.templateId,
    versionId,
    action: request.action,
    status,
    auditEventId
  };
}
