import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";

import { makePackageId } from "./ids.mjs";
import { WangzhuanError } from "./http.mjs";
import { syncDownloadPackageFact } from "./mysql-facts.mjs";
import { wangzhuanPaths, writeAtomicJson } from "./storage.mjs";
import { recordTelemetryEvent } from "./telemetry.mjs";

function currentUserId(context) {
  return context.userId ?? context.currentUserId?.() ?? context.user?.userId ?? context.user?.username ?? "local";
}

function validateBatchId(batchId) {
  if (!/^wzb_\d{14}_[a-f0-9]{4}$/.test(String(batchId || ""))) {
    throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  }
}

function validateRemixId(remixId) {
  if (!/^rmx_\d{14}_[a-f0-9]{4}$/.test(String(remixId || ""))) {
    throw new WangzhuanError("remix_not_found", "改造任务不存在或无权限", { remixId });
  }
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

async function readBatch(context, batchId) {
  validateBatchId(batchId);
  const target = join(wangzhuanPaths(context).batchesDir, batchId, "batch.json");
  if (!existsSync(target)) throw new WangzhuanError("batch_not_found", "批次不存在", { batchId });
  const batch = JSON.parse(await readFile(target, "utf8"));
  if (batch.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权访问该批次", { batchId });
  }
  return batch;
}

async function readRemix(context, remixId) {
  validateRemixId(remixId);
  const target = join(wangzhuanPaths(context).remixDir, remixId, "remix.json");
  if (!existsSync(target)) throw new WangzhuanError("remix_not_found", "改造任务不存在或无权限", { remixId });
  const remix = JSON.parse(await readFile(target, "utf8"));
  if (remix.userId !== currentUserId(context) && context.user?.role !== "admin" && !context.user?.isAdmin) {
    throw new WangzhuanError("permission_denied", "当前账号无权执行该操作", { remixId });
  }
  return remix;
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === "1";
}

function zipSafeName(name) {
  return String(name || "file").replace(/^[\\/]+/, "").replace(/[\\:*?"<>|]/g, "_");
}

function addStringFile(files, zipPath, value) {
  files.push({
    zipPath: zipSafeName(zipPath),
    data: Buffer.from(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`, "utf8")
  });
}

async function addDiskFile(context, files, missingFiles, zipPath, relativePath) {
  if (!relativePath) {
    missingFiles.push(zipPath);
    return;
  }
  const target = resolveUserPath(context, relativePath);
  if (!existsSync(target)) {
    missingFiles.push(zipPath);
    return;
  }
  files.push({ zipPath: zipSafeName(zipPath), data: await readFile(target) });
}

function outputPackagePath(batchRoot, output) {
  if (output.kind === "stitched_video") return `${batchRoot}/stitched/${output.outputId}_30s${extname(output.filePath) || ".mp4"}`;
  if (output.kind === "segment_video") return `${batchRoot}/segments/${output.outputId}${extname(output.filePath) || ".mp4"}`;
  return `${batchRoot}/outputs/${output.outputId}${extname(output.filePath) || ".mp4"}`;
}

function packageOutputSelection(batch, request) {
  const includeFailed = normalizeBoolean(request.includeFailed);
  const includeSegments = normalizeBoolean(request.includeSegments);
  return (Array.isArray(batch.outputs) ? batch.outputs : []).filter((output) => {
    if (output.downloadEligible) return true;
    if (includeSegments && output.kind === "segment_video" && batch.status === "partial_failed") return true;
    if (includeFailed) return true;
    return false;
  });
}

function packageRemixOutputSelection(remix, request) {
  const includeFailed = normalizeBoolean(request.includeFailed);
  return (Array.isArray(remix.outputs) ? remix.outputs : []).filter((output) => {
    if (output.downloadEligible) return true;
    if (includeFailed) return true;
    return false;
  });
}

function taskMapRows(batch, outputs, outputPathById) {
  const outputByTask = new Map();
  for (const output of outputs) {
    for (const taskId of output.generationTaskIds || []) outputByTask.set(taskId, output);
  }
  return (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    const output = outputByTask.get(task.generationTaskId);
    return {
      source_type: "pipeline",
      batch_id: batch.batchId,
      script_id: task.scriptId || "",
      generation_task_id: task.generationTaskId,
      image_task_id: task.imageTaskId || "",
      seedance_task_id: task.seedanceTaskId || "",
      model_image: task.modelImage,
      model_video: task.modelVideo,
      output_id: output?.outputId || "",
      output_file: output ? outputPathById.get(output.outputId) : "",
      qc_status: output?.qcStatus || "",
      error_code: task.errorCode || ""
    };
  });
}

function remixTaskMapRows(remix, outputs, outputPathById) {
  const outputByTask = new Map();
  for (const output of outputs) {
    for (const taskId of output.generationTaskIds || []) outputByTask.set(taskId, output);
  }
  return (Array.isArray(remix.tasks) ? remix.tasks : []).map((task) => {
    const output = outputByTask.get(task.generationTaskId);
    return {
      source_type: "remix",
      batch_id: "",
      remix_id: remix.remixId,
      script_id: task.scriptId || "",
      generation_task_id: task.generationTaskId,
      image_task_id: task.imageTaskId || "",
      seedance_task_id: task.seedanceTaskId || "",
      model_image: task.modelImage,
      model_video: task.modelVideo,
      output_id: output?.outputId || "",
      output_file: output ? outputPathById.get(output.outputId) : "",
      qc_status: output?.qcStatus || "",
      error_code: task.errorCode || ""
    };
  });
}

function csvEscape(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function taskMapCsv(rows) {
  const headers = [
    "source_type",
    "batch_id",
    "script_id",
    "generation_task_id",
    "image_task_id",
    "seedance_task_id",
    "model_image",
    "model_video",
    "output_id",
    "output_file",
    "qc_status",
    "error_code"
  ];
  return [headers, ...rows.map((row) => headers.map((header) => row[header]))]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
}

function sanitizedTasks(batch) {
  const blockedKeys = new Set(["remote" + "Url", "remote_" + "url"]);
  return (Array.isArray(batch.tasks) ? batch.tasks : []).map((task) => {
    return Object.fromEntries(Object.entries(task).filter(([key]) => !blockedKeys.has(key)));
  });
}

function sanitizedBatch(batch) {
  return {
    ...batch,
    tasks: sanitizedTasks(batch)
  };
}

function sanitizedRemix(remix) {
  return {
    ...remix,
    tasks: sanitizedTasks(remix)
  };
}

async function collectBatchFiles(context, batch, request, packageItems, missingFiles) {
  const files = [];
  const batchRoot = `batches/${batch.batchId}`;
  const selectedOutputs = packageOutputSelection(batch, request);
  if (!selectedOutputs.length) return { files, selectedOutputs };

  addStringFile(files, `${batchRoot}/batch.json`, sanitizedBatch(batch));
  const referenceExt = extname(batch.referenceVideo?.storedPath || "") || ".mp4";
  await addDiskFile(context, files, missingFiles, `${batchRoot}/original-reference/original${referenceExt}`, batch.referenceVideo?.storedPath);
  addStringFile(files, `${batchRoot}/original-reference/reference-video-probe.json`, batch.referenceVideo);
  addStringFile(files, `${batchRoot}/scripts/decomposition.json`, batch.decomposition);

  for (const script of Array.isArray(batch.scripts) ? batch.scripts : []) {
    await addDiskFile(context, files, missingFiles, `${batchRoot}/scripts/${basename(script.scriptPath)}`, script.scriptPath);
  }
  for (const task of Array.isArray(batch.tasks) ? batch.tasks : []) {
    const seedanceName = `${task.generationTaskId}_seedance.txt`;
    const imageName = `${task.generationTaskId}_image.txt`;
    await addDiskFile(context, files, missingFiles, `${batchRoot}/prompts/${seedanceName}`, task.promptPath);
    await addDiskFile(context, files, missingFiles, `${batchRoot}/prompts/${imageName}`, join(task.promptPath.split(/[\\/]/).slice(0, -1).join("/"), imageName));
  }

  const outputPathById = new Map();
  for (const output of selectedOutputs) {
    const zipPath = outputPackagePath(batchRoot, output);
    outputPathById.set(output.outputId, zipPath);
    await addDiskFile(context, files, missingFiles, zipPath, output.filePath);
    packageItems.push({
      sourceType: "pipeline",
      batchId: batch.batchId,
      outputId: output.outputId,
      kind: output.kind,
      status: batch.status,
      qcStatus: output.qcStatus,
      packagePath: zipPath,
      diagnostic: !output.downloadEligible
    });
  }

  const qcOutputs = new Map((Array.isArray(batch.outputs) ? batch.outputs : []).map((output) => [output.outputId, output]));
  for (const output of qcOutputs.values()) {
    const reportPath = output.qcReportPath || join("批处理记录", "网赚管线", "batches", batch.batchId, "qc", `${output.outputId}.json`);
    await addDiskFile(context, files, missingFiles, `${batchRoot}/qc/${output.outputId}.json`, reportPath);
  }

  const rows = taskMapRows(batch, selectedOutputs, outputPathById);
  addStringFile(files, `${batchRoot}/task-map/task-id-map.csv`, taskMapCsv(rows));
  addStringFile(files, `${batchRoot}/task-map/task-id-map.json`, sanitizedTasks(batch));

  for (const output of Array.isArray(batch.outputs) ? batch.outputs : []) {
    if (output.kind !== "segment_video") continue;
    await addDiskFile(context, files, missingFiles, outputPackagePath(batchRoot, output), output.filePath);
  }

  for (const report of Array.isArray(batch.stitchReports) ? batch.stitchReports : []) {
    await addDiskFile(context, files, missingFiles, `${batchRoot}/stitch/${report.outputId}_stitch-report.json`, report.reportPath);
  }

  return { files, selectedOutputs };
}

async function collectRemixFiles(context, remix, request, packageItems, missingFiles) {
  const files = [];
  const remixRoot = `remix/${remix.remixId}`;
  const selectedOutputs = packageRemixOutputSelection(remix, request);
  if (!selectedOutputs.length) return { files, selectedOutputs };

  addStringFile(files, `${remixRoot}/remix.json`, sanitizedRemix(remix));
  const sourceExt = extname(remix.source?.storedPath || "") || ".mp4";
  await addDiskFile(context, files, missingFiles, `${remixRoot}/source/original${sourceExt}`, remix.source?.storedPath);
  addStringFile(files, `${remixRoot}/source/source-probe.json`, remix.source || {});
  addStringFile(files, `${remixRoot}/regions/regions.json`, remix.regions || []);

  const outputPathById = new Map();
  for (const output of selectedOutputs) {
    const zipPath = `${remixRoot}/outputs/${output.outputId}${extname(output.filePath) || ".mp4"}`;
    outputPathById.set(output.outputId, zipPath);
    await addDiskFile(context, files, missingFiles, zipPath, output.filePath);
    packageItems.push({
      sourceType: "remix",
      remixId: remix.remixId,
      outputId: output.outputId,
      kind: output.kind,
      status: remix.status,
      qcStatus: output.qcStatus,
      packagePath: zipPath,
      diagnostic: !output.downloadEligible
    });
  }

  for (const task of Array.isArray(remix.tasks) ? remix.tasks : []) {
    const promptName = `${task.generationTaskId}_remix.txt`;
    await addDiskFile(context, files, missingFiles, `${remixRoot}/prompts/${promptName}`, task.promptPath);
  }

  for (const output of Array.isArray(remix.outputs) ? remix.outputs : []) {
    const reportPath = output.qcReportPath || join("批处理记录", "网赚管线", "remix", remix.remixId, "qc", `${output.outputId}.json`);
    await addDiskFile(context, files, missingFiles, `${remixRoot}/qc/${output.outputId}.json`, reportPath);
  }

  const rows = remixTaskMapRows(remix, selectedOutputs, outputPathById);
  addStringFile(files, `${remixRoot}/task-map/task-id-map.csv`, taskMapCsv(rows));
  addStringFile(files, `${remixRoot}/task-map/task-id-map.json`, sanitizedTasks(remix));
  await addDiskFile(context, files, missingFiles, `${remixRoot}/preview-confirmation.json`, join("批处理记录", "网赚管线", "remix", remix.remixId, "preview-confirmation.json"));

  return { files, selectedOutputs };
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

export function buildZip(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const file of files) {
    const data = Buffer.isBuffer(file.data) ? file.data : Buffer.from(String(file.data), "utf8");
    const nameBuffer = Buffer.from(zipSafeName(file.zipPath), "utf8");
    const checksum = crc32(data);
    const { time, day } = dosDateTime();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuffer, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(day, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuffer.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuffer);
    offset += local.length + nameBuffer.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

export async function buildDownloadPackage(context, request = {}) {
  const batchIds = Array.isArray(request.batchIds) ? request.batchIds.map(String) : [];
  const remixIds = Array.isArray(request.remixIds) ? request.remixIds.map(String) : [];
  if (!batchIds.length && !remixIds.length) {
    throw new WangzhuanError("empty_download_set", "当前筛选没有可下载素材", { field: "batchIds/remixIds" });
  }
  if (normalizeBoolean(request.includeRemoteUrls)) {
    throw new WangzhuanError("validation_error", "首期普通下载包不包含 remote URL", { field: "includeRemoteUrls" });
  }

  const packageItems = [];
  const missingFiles = [];
  const files = [];
  let selectedCount = 0;
  for (const batchId of batchIds) {
    const batch = await readBatch(context, batchId);
    const collected = await collectBatchFiles(context, batch, request, packageItems, missingFiles);
    selectedCount += collected.selectedOutputs.length;
    files.push(...collected.files);
  }
  for (const remixId of remixIds) {
    const remix = await readRemix(context, remixId);
    const collected = await collectRemixFiles(context, remix, request, packageItems, missingFiles);
    selectedCount += collected.selectedOutputs.length;
    files.push(...collected.files);
  }
  if (!selectedCount) {
    throw new WangzhuanError("empty_download_set", "当前筛选没有可下载素材", { batchIds, remixIds });
  }

  const manifest = {
    schemaVersion: "download_package.v1",
    packageId: makePackageId(),
    createdAt: new Date().toISOString(),
    createdBy: currentUserId(context),
    filters: {
      batchIds,
      remixIds,
      includeFailed: normalizeBoolean(request.includeFailed),
      includeSegments: normalizeBoolean(request.includeSegments),
      includeRemoteUrls: false
    },
    items: packageItems,
    missingFiles
  };

  if (missingFiles.length) {
    throw new WangzhuanError("missing_required_file", "交付包缺少必需文件，请重建或联系管理员", { missingFiles, manifest });
  }

  addStringFile(files, "package-manifest.json", manifest);
  await writeAtomicJson(join(wangzhuanPaths(context).batchesDir, "packages", `${manifest.packageId}.manifest.json`), manifest);
  await syncDownloadPackageFact(context, manifest);
  await recordTelemetryEvent(context, "batch_downloaded", {
    packageId: manifest.packageId,
    batchIds,
    remixIds,
    itemCount: packageItems.length,
    includeFailed: manifest.filters.includeFailed,
    includeSegments: manifest.filters.includeSegments
  }, { audit: true });
  return {
    manifest,
    zip: buildZip(files)
  };
}
