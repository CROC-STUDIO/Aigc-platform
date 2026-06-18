import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { getChannelRules } from "./channel-rules.mjs";
import { REQUIRED_STRONG_TRUTH_FIELDS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { syncBatchFacts } from "./mysql-facts.mjs";
import { toProjectRelative, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

const SCRIPT_REQUIRED_FIELDS = Object.freeze([
  "scriptId",
  "batchId",
  "variantIndex",
  "segmentIndex",
  "durationSec",
  "hook",
  "body",
  "cta",
  "ending",
  "promptPath",
  "scriptPath"
]);

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function validateBatchId(batchId) {
  if (!/^wzb_\d{14}_[a-f0-9]{4}$/.test(String(batchId || ""))) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  }
}

function batchDir(context, batchId) {
  validateBatchId(batchId);
  return join(wangzhuanPaths(context).batchesDir, batchId);
}

function batchPath(context, batchId) {
  return join(batchDir(context, batchId), "batch.json");
}

async function readBatch(context, batchId) {
  const target = batchPath(context, batchId);
  if (!existsSync(target)) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  }
  const batch = JSON.parse(await readFile(target, "utf8"));
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权访问该批次", { batchId });
  }
  return batch;
}

async function writeBatch(context, batch) {
  const now = new Date().toISOString();
  const next = { ...batch, updatedAt: now };
  const paths = wangzhuanPaths(context);
  await writeAtomicJson(join(paths.batchesDir, next.batchId, "batch.json"), next);
  const indexPath = join(paths.batchesDir, "index.json");
  if (existsSync(indexPath)) {
    const index = JSON.parse(await readFile(indexPath, "utf8"));
    index.items = Array.isArray(index.items) ? index.items : [];
    const item = index.items.find((entry) => entry.batchId === next.batchId);
    if (item) {
      item.status = next.status;
      item.updatedAt = now;
    }
    await writeAtomicJson(indexPath, index);
  }
  await syncBatchFacts(context, next, "qc_completed");
  return next;
}

function resolveUserPath(context, relativePath) {
  if (!relativePath || String(relativePath).match(/^[A-Za-z]:[\\/]|^\//)) {
    throw new WangzhuanError("validation_error", "文件路径不合法", { path: relativePath });
  }
  const root = resolve(context.userProjectRoot);
  const target = resolve(root, String(relativePath));
  if (target !== root && !target.startsWith(`${root}\\`) && !target.startsWith(`${root}/`)) {
    throw new WangzhuanError("validation_error", "文件路径越界", { path: relativePath });
  }
  return target;
}

async function readNonEmptyText(target) {
  if (!existsSync(target)) return "";
  return (await readFile(target, "utf8")).trim();
}

function check(checkId, status, message, field = "") {
  return {
    checkId,
    status,
    severity: status === "pass" ? "info" : status,
    message,
    ...(field ? { field } : {})
  };
}

function tasksForOutput(batch, output) {
  const taskIds = new Set(output.generationTaskIds || []);
  return (Array.isArray(batch.tasks) ? batch.tasks : []).filter((task) => taskIds.has(task.generationTaskId));
}

function scriptsForTasks(batch, tasks, output) {
  const scriptsById = new Map((Array.isArray(batch.scripts) ? batch.scripts : []).map((script) => [script.scriptId, script]));
  const ids = new Set(tasks.map((task) => task.scriptId).filter(Boolean));
  if (output.scriptId) ids.add(output.scriptId);
  return [...ids].map((scriptId) => scriptsById.get(scriptId)).filter(Boolean);
}

async function scriptSchemaCheck(context, batch, output, tasks) {
  const scripts = scriptsForTasks(batch, tasks, output);
  if (!scripts.length) {
    return check("script_schema", "fail", "输出缺少关联脚本", "scripts");
  }
  for (const script of scripts) {
    const missing = SCRIPT_REQUIRED_FIELDS.filter((field) => {
      const value = script[field];
      return value === undefined || value === null || value === "";
    });
    if (missing.length) {
      return check("script_schema", "fail", `脚本缺少字段：${missing.join(",")}`, "scripts");
    }
    if (!existsSync(resolveUserPath(context, script.scriptPath))) {
      return check("script_schema", "fail", "脚本文件不存在", "scriptPath");
    }
  }
  return check("script_schema", "pass", "脚本结构完整");
}

function templateSnapshotCheck(batch) {
  const draft = batch.templateSnapshot?.draft || {};
  if (!batch.templateSnapshot?.templateId || !batch.templateSnapshot?.versionId || !draft.productName) {
    return check("template_snapshot", "fail", "模板快照缺少 templateId/versionId/productName", "templateSnapshot");
  }
  return check("template_snapshot", "pass", "模板快照完整");
}

async function promptSchemaCheck(context, tasks) {
  if (!tasks.length) {
    return check("prompt_schema", "fail", "输出缺少关联任务", "tasks");
  }
  for (const task of tasks) {
    const seedancePrompt = resolveUserPath(context, task.promptPath);
    const imagePrompt = join(dirname(seedancePrompt), `${task.generationTaskId}_image.txt`);
    if (!(await readNonEmptyText(seedancePrompt))) {
      return check("prompt_schema", "fail", "Seedance prompt 缺失或为空", "promptPath");
    }
    if (!(await readNonEmptyText(imagePrompt))) {
      return check("prompt_schema", "fail", "Image prompt 缺失或为空", "promptPath");
    }
  }
  return check("prompt_schema", "pass", "prompt 文件存在且非空");
}

function taskIdPresenceCheck(tasks) {
  if (!tasks.length) return check("task_id_presence", "fail", "输出缺少关联任务", "generationTaskIds");
  if (tasks.some((task) => !task.seedanceTaskId)) {
    return check("task_id_presence", "fail", "Seedance task_id 缺失", "seedanceTaskId");
  }
  return check("task_id_presence", "pass", "上游 task_id 已记录");
}

function videoSpecCheck(context, output) {
  if (![15, 30].includes(Number(output.durationSec)) || !output.kind) {
    return check("video_spec", "fail", "输出缺少时长或类型记录", "output");
  }
  if (!existsSync(resolveUserPath(context, output.filePath))) {
    return check("video_spec", "fail", "输出文件不存在", "filePath");
  }
  return check("video_spec", "pass", "输出文件和规格记录存在");
}

async function stitchReportPresenceCheck(context, batch, output) {
  if (output.kind !== "stitched_video" && Number(output.durationSec) !== 30) return null;
  if (!output.stitchReportPath) {
    return check("stitch_report_presence", "fail", "30s 输出缺少 stitch report 路径", "stitchReportPath");
  }
  const reportTarget = resolveUserPath(context, output.stitchReportPath);
  if (!existsSync(reportTarget)) {
    return check("stitch_report_presence", "fail", "30s 输出缺少 stitch report 文件", "stitchReportPath");
  }
  const report = JSON.parse(await readFile(reportTarget, "utf8"));
  if (report.outputId !== output.outputId || report.status !== "succeeded") {
    return check("stitch_report_presence", "fail", "stitch report 与输出不匹配或未成功", "stitchReport");
  }
  const knownReport = (batch.stitchReports || []).find((item) => item.outputId === output.outputId);
  if (!knownReport) {
    return check("stitch_report_presence", "fail", "batch manifest 未记录 stitch report", "stitchReports");
  }
  return check("stitch_report_presence", "pass", "30s stitch report 存在且成功");
}

function textForPolicy(batch, tasks) {
  const scriptsById = new Map((Array.isArray(batch.scripts) ? batch.scripts : []).map((script) => [script.scriptId, script]));
  return tasks
    .map((task) => scriptsById.get(task.scriptId))
    .filter(Boolean)
    .map((script) => [script.hook, script.body, script.cta, script.ending, script.rewardExpression].filter(Boolean).join("\n"))
    .join("\n")
    .toLowerCase();
}

function productTextReplacementCheck(batch, tasks) {
  const productName = String(batch.templateSnapshot?.draft?.productName || "").trim().toLowerCase();
  const text = textForPolicy(batch, tasks);
  if (!productName || !text.includes(productName)) {
    return check("product_text_replacement", "warn", "脚本未明显包含模板产品名", "templateSnapshot.draft.productName");
  }
  return check("product_text_replacement", "pass", "脚本文案使用模板产品名");
}

function currencyLocaleCheck(batch) {
  const draft = batch.templateSnapshot?.draft || {};
  if (!draft.currencySymbol || !draft.language || !Array.isArray(draft.regions) || !draft.regions.length) {
    return check("currency_locale", "fail", "模板缺少货币、语言或地区", "templateSnapshot.draft");
  }
  return check("currency_locale", "pass", "货币、语言和地区字段存在");
}

function strongPromiseTruthRulesCheck(batch) {
  const draft = batch.templateSnapshot?.draft || {};
  if (draft.promiseLevel !== "strong_commitment") {
    return check("strong_promise_truth_rules", "pass", "非强承诺模板无需七字段检查");
  }
  const missing = REQUIRED_STRONG_TRUTH_FIELDS.filter((field) => !String(draft.truthRules?.[field] || "").trim());
  if (missing.length) {
    return check("strong_promise_truth_rules", "fail", `强承诺缺少字段：${missing.join(",")}`, "truthRules");
  }
  return check("strong_promise_truth_rules", "pass", "强承诺真实规则完整");
}

async function channelRuleCheck(context, batch, tasks) {
  const draft = batch.templateSnapshot?.draft || {};
  const channel = draft.targetChannels?.[0] || "generic";
  const rules = await getChannelRules(context, { channel, promiseLevel: draft.promiseLevel || "stable" });
  const text = textForPolicy(batch, tasks);
  const forbidden = rules.rules.flatMap((rule) => rule.forbiddenTerms || []);
  const hit = forbidden.find((term) => term && text.includes(String(term).toLowerCase()));
  if (hit) return check("channel_rule", "fail", `触发渠道禁用词：${hit}`, "channelRule");
  const requiredDisclaimers = [...new Set(rules.rules.flatMap((rule) => rule.requiredDisclaimers || []))];
  const missingDisclaimer = requiredDisclaimers.find((item) => item && !text.includes(String(item).toLowerCase()));
  if (missingDisclaimer) {
    return check("channel_rule", "fail", `缺少渠道免责声明：${missingDisclaimer}`, "channelRule.requiredDisclaimers");
  }
  return check("channel_rule", "pass", "未触发渠道禁用词");
}

function qcStatusFromChecks(checks) {
  if (checks.some((item) => item.status === "fail")) return "fail";
  if (checks.some((item) => item.status === "manual_required")) return "manual_required";
  if (checks.some((item) => item.status === "warn")) return "warn";
  return "pass";
}

function downloadEligibility(batch, output, qcStatus) {
  if (qcStatus !== "pass") return false;
  if (output.sourceType !== "pipeline") return false;
  if (output.kind === "stitched_video" && Number(output.durationSec) === 30) return true;
  if (Number(batch.estimate?.durationSec) === 15 && Number(output.durationSec) === 15) return true;
  return false;
}

async function qcReportForOutput(context, batch, output) {
  const tasks = tasksForOutput(batch, output);
  const checks = [
    await scriptSchemaCheck(context, batch, output, tasks),
    templateSnapshotCheck(batch),
    productTextReplacementCheck(batch, tasks),
    currencyLocaleCheck(batch),
    await channelRuleCheck(context, batch, tasks),
    strongPromiseTruthRulesCheck(batch),
    await promptSchemaCheck(context, tasks),
    taskIdPresenceCheck(tasks),
    videoSpecCheck(context, output)
  ];
  const stitchCheck = await stitchReportPresenceCheck(context, batch, output);
  if (stitchCheck) checks.push(stitchCheck);
  const qcStatus = qcStatusFromChecks(checks);
  return {
    schemaVersion: "qc_report.v1",
    outputId: output.outputId,
    sourceType: output.sourceType,
    ...(output.batchId ? { batchId: output.batchId } : {}),
    ...(output.remixId ? { remixId: output.remixId } : {}),
    qcStatus,
    visualPreviewRequired: Boolean(output.visualPreviewRequired),
    previewConfirmed: Boolean(output.previewConfirmed),
    checks,
    summary: qcStatus === "pass" ? "QC passed" : "QC requires attention",
    createdAt: new Date().toISOString()
  };
}

function batchStatusFromReports(reports) {
  if (!reports.length) return "qc";
  if (reports.every((report) => report.qcStatus === "pass")) return "succeeded";
  if (reports.every((report) => report.qcStatus === "fail")) return "failed";
  return "partial_failed";
}

export async function runBatchQc(context, batchId) {
  const batch = await readBatch(context, batchId);
  const outputs = Array.isArray(batch.outputs) ? batch.outputs : [];
  const reports = [];
  const nextOutputs = [];

  for (const output of outputs) {
    const report = await qcReportForOutput(context, batch, output);
    const reportTarget = join(batchDir(context, batch.batchId), "qc", `${output.outputId}.json`);
    await writeAtomicJson(reportTarget, report);
    await recordTelemetryEvent(context, "qc_completed", {
      outputId: output.outputId,
      batchId: batch.batchId,
      sourceType: output.sourceType,
      qcStatus: report.qcStatus,
      checkFailureCodes: report.checks.filter((item) => item.status !== "pass").map((item) => item.checkId)
    });
    reports.push(report);
    nextOutputs.push({
      ...output,
      qcStatus: report.qcStatus,
      downloadEligible: downloadEligibility(batch, output, report.qcStatus),
      qcReportPath: toProjectRelative(context.userProjectRoot, reportTarget)
    });
  }

  const failed = reports.filter((report) => report.qcStatus === "fail" || report.qcStatus === "manual_required").length;
  const warningReports = reports.filter((report) => report.qcStatus === "warn");
  const nextBatch = await writeBatch(context, {
    ...batch,
    status: batchStatusFromReports(reports),
    outputs: nextOutputs,
    qcSummary: {
      total: reports.length,
      passed: reports.filter((report) => report.qcStatus === "pass").length,
      failed,
      warnings: warningReports.map((report) => ({ outputId: report.outputId, qcStatus: report.qcStatus }))
    }
  });

  return {
    batch: nextBatch,
    reports,
    downloadSummary: {
      outputsTotal: nextOutputs.length,
      downloadEligibleCount: nextOutputs.filter((item) => item.downloadEligible).length,
      packageReady: nextOutputs.some((item) => item.downloadEligible),
      missingFiles: []
    }
  };
}
