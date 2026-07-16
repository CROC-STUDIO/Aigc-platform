// 一次性端到端测试：用真实 S3 上传 + 真实 doubao 拆解，验证 URL 模式链路是否通顺。
// 用法：node scripts/test-doubao-decomposition.mjs "<视频绝对路径>"
// 依赖：项目 .env（含 WANGZHUAN_LLM_API_KEY + S3_*），ffmpeg，可出网到 skylink / S3。

import { mkdtemp, mkdir, readFile, rm, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const { loadEnvFile, loadRuntimeConfig } = await import(join(projectRoot, "server/runtime-config.mjs"));
loadEnvFile({ envPath: join(projectRoot, ".env") });

const { checkReferenceVideo, draftReferenceVideoDecomposition } =
  await import(join(projectRoot, "server/wangzhuan/reference-videos.mjs"));

const objStore = await import(join(projectRoot, "server/object-storage.mjs"));
const { S3Client } = await import("@aws-sdk/client-s3");

// 沙箱时钟偏差校正：从 S3 响应头拿真实时间，算出 systemClockOffset（毫秒）注入 S3 客户端。
async function computeClockOffsetMs() {
  try {
    const resp = await fetch(`${process.env.S3_PUBLIC_BASE_URL}/`, { method: "HEAD" });
    const serverDate = resp.headers.get("date");
    if (serverDate) return new Date(serverDate).getTime() - Date.now();
  } catch { /* ignore */ }
  return 0;
}

const videoPath = process.argv[2];
if (!videoPath) {
  console.error("用法: node scripts/test-doubao-decomposition.mjs <视频绝对路径>");
  process.exit(1);
}

function log(section, obj) {
  console.log(`\n===== ${section} =====`);
  if (obj !== undefined) console.log(typeof obj === "string" ? obj : JSON.stringify(obj, null, 2));
}

function short(s, n = 400) {
  const t = String(s ?? "");
  return t.length > n ? `${t.slice(0, n)}…(${t.length} chars)` : t;
}

const root = await mkdtemp(join(tmpdir(), "doubao-decomp-"));
try {
  const config = JSON.parse(await readFile(join(projectRoot, "config.json"), "utf8"));

  const clockOffsetMs = await computeClockOffsetMs();
  log("1. 环境自检");
  console.log("model:", config?.wangzhuan?.llm?.model);
  console.log("endpoint:", config?.wangzhuan?.llm?.endpoint);
  console.log("apiKey present:", Boolean(process.env[config?.wangzhuan?.llm?.apiKeyEnv || "WANGZHUAN_LLM_API_KEY"]));
  console.log("S3_PUBLIC_BASE_URL present:", Boolean(process.env.S3_PUBLIC_BASE_URL));
  console.log("S3_BUCKET:", process.env.S3_BUCKET || "(empty)");
  console.log("沙箱时钟偏差(ms):", clockOffsetMs, `(≈${(clockOffsetMs / 3600000).toFixed(1)}h)`);

  // 时钟校正版 S3 客户端，供注入上传用
  const s3Settings = objStore.objectStorageSettings();
  const clockCorrectedS3 = new S3Client({
    region: s3Settings.region,
    ...(s3Settings.endpoint ? { endpoint: s3Settings.endpoint } : {}),
    ...(s3Settings.forcePathStyle ? { forcePathStyle: true } : {}),
    systemClockOffset: clockOffsetMs
  });

  // 捕获真实 HEAD 探测的结果，便于观察
  let headResult = null;
  const context = {
    userProjectRoot: root,
    sharedProjectRoot: root,
    config,
    // 绕过 MySQL 的三个触点（用固定 ID / 空同步）
    nextReferenceVideoId: async () => `ref_20260710_${String(Date.now()).slice(-3)}`,
    syncReferenceVideoFact: async () => ({ skipped: false, referenceVideoId: 1 }),
    recordTelemetryEvent: async () => {},
    // 时钟校正版 S3 上传：复用项目自己的 descriptor + uploadObjectFile，只是换一个带 systemClockOffset 的客户端
    syncWangzhuanAsset: async ({ fullPath, assetKind }) => {
      const descriptor = objStore.projectStorageDescriptor({
        fullPath, userRoot: root, sharedRoot: root, userId: "local"
      });
      await objStore.uploadObjectFile({
        filePath: fullPath,
        storageKey: descriptor.storageKey,
        contentType: "video/mp4",
        client: clockCorrectedS3
      });
      return { assetKind, storageKey: descriptor.storageKey, storageUrl: descriptor.storageUrl, storedPath: descriptor.relativePath };
    },
    // 真实执行：抽帧、场景检测、S3 上传、HEAD 探测、LLM 调用都不注入桩
    headProbeReferenceUrl: async ({ fileUrl }) => {
      // 复用内置逻辑：这里手动做一次 HEAD 并记录，同时返回给主流程
      try {
        const resp = await fetch(fileUrl, { method: "HEAD", redirect: "follow" });
        headResult = { ok: resp.ok, status: resp.status };
        return { ok: resp.ok, reason: resp.ok ? "" : `http_status_${resp.status}` };
      } catch (e) {
        headResult = { ok: false, status: 0, error: String(e?.message || e) };
        return { ok: false, reason: String(e?.message || e) };
      }
    }
  };

  const content = `data:video/mp4;base64,${(await readFile(videoPath)).toString("base64")}`;

  log("2. 上传 + 探测 + 传 S3 (checkReferenceVideo)");
  const t0 = Date.now();
  const checked = await checkReferenceVideo(context, {
    fileName: "test-reference.mp4",
    mimeType: "video/mp4",
    content,
    fileHash: `test-${Date.now()}`
  });
  const rv = checked.referenceVideo;
  console.log("referenceVideoId:", rv.referenceVideoId);
  console.log("status:", rv.status);
  console.log("durationSec:", rv.durationSec, " ratio:", rv.width + "x" + rv.height);
  console.log("storageKey:", rv.storageKey);
  console.log("storageUrl:", rv.storageUrl);
  console.log("previewUrl:", rv.previewUrl);
  if (rv.decompositionProxy) console.log("proxy:", rv.decompositionProxy.sizeBytes, "bytes, crf", rv.decompositionProxy.crf);
  console.log("issues:", JSON.stringify(rv.issues || []));
  console.log(`checkReferenceVideo 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  // 用捕获到的 probe 喂给拆解（绕过 MySQL 的 loadReferenceVideoProbe）
  context.loadReferenceVideoProbe = async () => rv;

  log("3. 调 doubao 拆解 (draftReferenceVideoDecomposition, 非流式)");
  const t1 = Date.now();
  const result = await draftReferenceVideoDecomposition(context, {
    referenceVideoId: rv.referenceVideoId
  });
  console.log(`拆解耗时 ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  console.log("HEAD 探测结果:", JSON.stringify(headResult));
  console.log("warnings:", JSON.stringify(result.warnings || []));
  console.log("draft.source:", result.draft?.source, " model:", result.draft?.model);

  const d = result.decomposition || {};
  log("4. 拆解结果（8 必填维度）");
  for (const k of ["scene", "subject", "action", "camera", "lighting", "style", "quality", "hook"]) {
    console.log(`  ${k}: ${short(d[k], 120)}`);
  }
  const fission = d.fissionAnalysis || d;
  const slices = fission.seedanceSlices || d.seedanceSlices || [];
  const segs = fission.storySegments || d.storySegments || [];
  console.log(`storySegments: ${segs.length} 段, seedanceSlices: ${slices.length} 片`);
  if (slices.length) {
    console.log("首片:", JSON.stringify({
      idx: slices[0].seedanceSliceIndex,
      role: slices[0].segmentRole,
      dur: slices[0].sliceDurationSec ?? slices[0].durationSec
    }));
  }

  log("5. 抓 LLM 请求/响应 dump（确认 file_url 是否真发出去）");
  async function findDumps(dir) {
    const out = [];
    let entries = [];
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) out.push(...await findDumps(p));
      else if (/llm-(request|response)/.test(e.name)) out.push(p);
    }
    return out;
  }
  const dumps = await findDumps(root);
  console.log(`找到 ${dumps.length} 个 dump 文件`);
  for (const p of dumps.slice(0, 4)) {
    const j = JSON.parse(await readFile(p, "utf8"));
    const body = JSON.stringify(j);
    console.log(`- ${p.split("/").slice(-2).join("/")}`);
    console.log(`  inputMode=${j.inputMode || "?"}  含 file_url=${/file_url/.test(body)}  含 image(帧)=${/input_image|image_url/.test(body)}`);
    if (/request/.test(p)) {
      const m = body.match(/https?:\/\/[^"\\]+\.mp4[^"\\]*/);
      if (m) console.log(`  发出的视频URL: ${m[0]}`);
    }
  }

  log("✅ 结论");
  console.log(`URL 模式实际生效: ${headResult?.ok === true && (result.warnings || []).every(w => w.code !== "reference_video_url_head_unreachable")}`);
  console.log(`拆解成功: ${Boolean(d.scene && d.hook)}`);
} catch (error) {
  log("❌ 出错");
  console.error(error?.code || "", error?.message || error);
  if (error?.data) console.error("data:", JSON.stringify(error.data));
  process.exitCode = 1;
} finally {
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
