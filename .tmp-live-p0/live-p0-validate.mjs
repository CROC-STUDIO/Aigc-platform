import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawn } from "node:child_process";
import {
  buildWalletVideoOpsRequest,
  executeWalletVideoOpsJobs
} from "../server.mjs";

const baseUrl = process.env.WALLET_LIVE_BASE_URL || "http://127.0.0.1:5187";
const evidenceRoot = process.env.WALLET_LIVE_EVIDENCE_DIR || ".tmp-live-p0/evidence-formal";
const stopLossPattern = /quota|credit|balance|billing|insufficient|rate.?limit|too many|queue|queued|capacity|cost|额度|余额|计费|排队|队列|限流|频率|成本/i;

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function saveJson(path, value) {
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function redactLargeValues(value) {
  if (typeof value === "string") {
    if (value.startsWith("data:video/")) return `[data-video ${value.length} chars]`;
    if (value.length > 2000) return `${value.slice(0, 500)}...[${value.length} chars]`;
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => redactLargeValues(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactLargeValues(item)]));
  }
  return value;
}

async function requestJson(path, { method = "GET", body, cookie = "" } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...(cookie ? { Cookie: cookie } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await response.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw_text: text };
  }
  return { status: response.status, headers: Object.fromEntries(response.headers.entries()), body: json };
}

function assertNoStopLoss(value, context) {
  const focused = value?.runState || value?.releaseHealth?.release_health || value;
  const text = typeof focused === "string" ? focused : JSON.stringify({
    running: focused?.running,
    batchTag: focused?.batchTag || focused?.batch_tag,
    failed: focused?.failed || focused?.failed_tasks,
    jobs: focused?.jobs?.map((job) => ({ status: job.status, error: job.error })),
    log: focused?.log?.filter((item) => /error|fail|quota|queue|cost|额度|排队|成本/i.test(`${item.type} ${item.message}`))
  });
  if (stopLossPattern.test(text)) {
    throw new Error(`STOP_LOSS_TRIGGERED ${context}: ${text.slice(0, 1000)}`);
  }
}

function dataUrlFor(filePath, mime) {
  return readFile(filePath).then((buffer) => `data:${mime};base64,${buffer.toString("base64")}`);
}

async function login() {
  const result = await requestJson("/api/login", {
    method: "POST",
    body: { username: "admin", password: "admin123" }
  });
  if (result.status !== 200) throw new Error(`login failed: ${JSON.stringify(result.body)}`);
  const cookie = String(result.headers["set-cookie"] || "").match(/ad_session=[^;]+/)?.[0] || "";
  if (!cookie) throw new Error("login did not return ad_session cookie");
  return { ...result, cookie };
}

async function uploadAsset(cookie, kind, filePath, mime, allowVideo = false, outDir = evidenceRoot) {
  const body = {
    kind,
    name: basename(filePath),
    content: await dataUrlFor(filePath, mime),
    allowVideo
  };
  const result = await requestJson("/api/wallet/upload", { method: "POST", cookie, body });
  await saveJson(join(outDir, `upload-${kind}.json`), { request: { ...body, content: `[data-url ${body.content.length} chars]` }, response: result });
  if (result.status !== 200) throw new Error(`upload ${kind} failed: ${JSON.stringify(result.body)}`);
  return result.body;
}

function liveTemplate({ label, duration, watermarkMode = "none" }) {
  return {
    templateName: `Live P0 ${duration}s ${label}`,
    productName: `PerkPlay ${label}`,
    productLink: "https://example.com/perkplay-live-smoke",
    targetRegion: "US",
    currency: "$",
    language: "英语",
    size: "720x1280",
    outputDuration: duration,
    variantCount: 1,
    revenueLevels: ["稳健版"],
    slogan: "Complete simple tasks and unlock rewards",
    earningRulesText: "",
    earningRules: {
      reward_type: "points",
      cashout_threshold: "",
      arrival_time: "",
      task_conditions: "Only show generic reward progress, no guaranteed payout."
    },
    watermarkMode,
    competitorScript: "Use a clean reward-app hook with phone UI and a simple CTA.",
    customPrompt: "Use the uploaded app icon colors. Keep claims generic and compliant.",
    negativePrompt: "No guaranteed payout, no fake transfer proof, no competitor logo."
  };
}

async function startBatch(cookie, request, outDir) {
  await saveJson(join(outDir, "start-request.json"), request);
  const result = await requestJson("/api/wallet/start", { method: "POST", cookie, body: request });
  await saveJson(join(outDir, "start-response.json"), result);
  if (result.status !== 200) throw new Error(`start failed: ${JSON.stringify(result.body)}`);
  assertNoStopLoss(result.body, "start");
  return result.body;
}

async function pollState(cookie, outDir, { timeoutMs = 90 * 60 * 1000, intervalMs = 10000 } = {}) {
  const started = Date.now();
  const history = [];
  while (Date.now() - started < timeoutMs) {
    const state = await requestJson("/api/wallet/state", { cookie });
    history.push({ time: new Date().toISOString(), status: state.status, body: state.body });
    await saveJson(join(outDir, "poll-history.json"), history);
    assertNoStopLoss(state.body, "poll");
    const runState = state.body?.runState || state.body;
    if (!runState.running) {
      await saveJson(join(outDir, "final-state.json"), state);
      return { ...state.body, runState };
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`poll timeout after ${timeoutMs}ms`);
}

async function ffprobe(filePath) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "stream=codec_type,width,height",
      "-show_entries", "format=duration",
      "-of", "json",
      filePath
    ]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffprobe failed ${code}: ${stderr}`));
      else resolve(JSON.parse(stdout || "{}"));
    });
  });
}

async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function collectBatchEvidence(batchTag, outDir) {
  const config = await requestJson("/api/config", { cookie: globalThis.__walletCookie });
  const projectRoot = config.body.projectRoot;
  const batchDir = join(projectRoot, "批处理记录", "网赚素材管线", "任务记录", batchTag);
  const files = {};
  for (const name of ["05-video-tasks.json", "06-video-ops-jobs.json", "07-merged-finals.json", "08-output-index.json", "09-quality-plan.json"]) {
    const path = join(batchDir, name);
    if (existsSync(path)) {
      files[name] = path;
      await saveJson(join(outDir, name), await readJsonFile(path));
    }
  }
  const outputIndexPath = files["08-output-index.json"];
  const outputIndex = outputIndexPath ? await readJsonFile(outputIndexPath) : [];
  const probes = [];
  for (const item of outputIndex) {
    if (item?.path && existsSync(item.path) && String(item.path).endsWith(".mp4")) {
      probes.push({ output_id: item.output_id, segment: item.segment, path: item.path, ffprobe: await ffprobe(item.path) });
    }
  }
  const tasksPath = files["05-video-tasks.json"];
  const tasks = tasksPath ? await readJsonFile(tasksPath) : [];
  for (const task of tasks) {
    if (task?.output_file && existsSync(task.output_file) && !probes.some((probe) => probe.path === task.output_file)) {
      probes.push({ task_id: task.id, segment: task.segment, path: task.output_file, ffprobe: await ffprobe(task.output_file) });
    }
  }
  await saveJson(join(outDir, "ffprobe-results.json"), probes);
  return { batchDir, files, probes };
}

async function waitForNoRunning(cookie) {
  const state = await requestJson("/api/wallet/state", { cookie });
  if (state.body.running) throw new Error(`wallet batch already running: ${state.body.batchTag}`);
}

async function runSeedance15() {
  const outDir = join(evidenceRoot, `seedance-15s-${Date.now()}`);
  await ensureDir(outDir);
  await uploadAsset(globalThis.__walletCookie, "icon", ".tmp-live-p0/wallet-icon-live.png", "image/png", false, outDir);
  await uploadAsset(globalThis.__walletCookie, "referenceVideo", ".tmp-live-p0/wallet-reference-live.mp4", "video/mp4", true, outDir);
  const batchTag = `formal_p0_15s_${Date.now()}`;
  const request = {
    client_request_id: `${batchTag}_req`,
    batchTag,
    count: 1,
    referenceVideoName: "wallet-reference-live.mp4",
    template: liveTemplate({ label: "15s Smoke", duration: 15 })
  };
  await startBatch(globalThis.__walletCookie, request, outDir);
  const finalState = await pollState(globalThis.__walletCookie, outDir);
  const runState = finalState.runState || finalState;
  if (runState.failed > 0 || runState.completed < 1) throw new Error(`15s batch failed: ${JSON.stringify(runState)}`);
  const evidence = await collectBatchEvidence(batchTag, outDir);
  await saveJson(join(outDir, "summary.json"), { batchTag, finalState, evidence });
  return { outDir, batchTag, finalState, evidence };
}

async function runSeedance30() {
  const outDir = join(evidenceRoot, `seedance-30s-${Date.now()}`);
  await ensureDir(outDir);
  const batchTag = `formal_p0_30s_${Date.now()}`;
  const request = {
    client_request_id: `${batchTag}_req`,
    batchTag,
    count: 1,
    referenceVideoName: "wallet-reference-live.mp4",
    template: liveTemplate({ label: "30s Smoke", duration: 30 })
  };
  await startBatch(globalThis.__walletCookie, request, outDir);
  const finalState = await pollState(globalThis.__walletCookie, outDir);
  const runState = finalState.runState || finalState;
  if (runState.failed > 0 || runState.completed < 2) throw new Error(`30s batch failed: ${JSON.stringify(runState)}`);
  const evidence = await collectBatchEvidence(batchTag, outDir);
  await saveJson(join(outDir, "summary.json"), { batchTag, finalState, evidence });
  return { outDir, batchTag, finalState, evidence };
}

async function runVideoOps(kind) {
  const outDir = join(evidenceRoot, `video-ops-${kind}-${Date.now()}`);
  await ensureDir(outDir);
  const source = await dataUrlFor(".tmp-live-p0/wallet-reference-live.mp4", "video/mp4");
  await saveJson(join(outDir, "source-info.json"), { source_url: `[data-url ${source.length} chars]` });

  const manualRegion = { shape: "rectangle", x: 520, y: 60, width: 150, height: 70, coordinate_space: "pixel" };
  const kframe = { frame_count: 3, confirmed: true, manual_region: manualRegion, duration_ms: 5000 };
  const jobKind = kind === "watermark" ? "watermark_mask" : "kframe_replace";
  const request = buildWalletVideoOpsRequest({
    kind: jobKind,
    source_url: source,
    manual_region: manualRegion,
    kframe,
    watermarkMode: kind === "kframe" ? "mask" : "",
    config: { videoOpsBaseUrl: "https://video-aigc.skylink-gateway.com" }
  });
  await saveJson(join(outDir, "request.json"), {
    method: request.method,
    url: request.url,
    headers: request.headers,
    body: { ...request.body, input: { ...request.body.input, source: `[data-url ${source.length} chars]` } }
  });
  const batchTag = `formal_p0_vops_${kind}_${Date.now()}`;
  const executed = await executeWalletVideoOpsJobs({
    jobs: [{
      batch_id: batchTag,
      final_id: `${batchTag}_01`,
      segment: "single",
      source_asset_id: "wallet-reference-live.mp4",
      source_url: source,
      video_ops_job_id: `${batchTag}_video_ops_01`,
      kind: jobKind,
      external_job_type: request.body.job_type,
      manual_region: kind === "watermark" || kind === "kframe" ? manualRegion : null,
      time_ranges: request.body.params?.time_ranges || request.body.params?.region_spec?.[0]?.time_ranges || [],
      request
    }],
    workDir: outDir,
    outputDir: outDir,
    config: { videoOpsBaseUrl: "https://video-aigc.skylink-gateway.com", videoOpsPollIntervalMs: 5000, videoOpsTimeoutMs: 30 * 60 * 1000 }
  });
  await saveJson(join(outDir, "executed-jobs.json"), executed);
  assertNoStopLoss(executed, `video-ops-${kind}`);
  const relevant = executed.jobs[0];
  if (!relevant) throw new Error(`video ops ${kind} did not create expected job`);
  if (relevant.status !== "succeeded" && relevant.status !== "review_required") throw new Error(`video ops ${kind} failed: ${JSON.stringify(relevant)}`);
  if (relevant.output_path && existsSync(relevant.output_path)) {
    await saveJson(join(outDir, "video-ops-ffprobe.json"), { path: relevant.output_path, ffprobe: await ffprobe(relevant.output_path) });
  }
  await saveJson(join(outDir, "summary.json"), { batchTag, relevant, executed });
  return { outDir, batchTag, relevant, executed };
}

async function main() {
  await ensureDir(evidenceRoot);
  const loginResult = await login();
  globalThis.__walletCookie = loginResult.cookie;
  await saveJson(join(evidenceRoot, "login.json"), { status: loginResult.status, has_cookie: Boolean(loginResult.cookie) });
  await waitForNoRunning(loginResult.cookie);
  const mode = process.argv[2] || "all";
  const summary = { mode, started_at: new Date().toISOString(), results: [] };
  if (mode === "seedance15" || mode === "all") summary.results.push({ name: "seedance15", ...(await runSeedance15()) });
  if (mode === "seedance30" || mode === "all") summary.results.push({ name: "seedance30", ...(await runSeedance30()) });
  if (mode === "videoops-watermark" || mode === "all") summary.results.push({ name: "videoops-watermark", ...(await runVideoOps("watermark")) });
  if (mode === "videoops-kframe" || mode === "all") summary.results.push({ name: "videoops-kframe", ...(await runVideoOps("kframe")) });
  summary.finished_at = new Date().toISOString();
  await saveJson(join(evidenceRoot, "summary.json"), summary);
  console.log(JSON.stringify(redactLargeValues(summary), null, 2));
}

main().catch(async (error) => {
  await saveJson(join(evidenceRoot, "fatal-error.json"), {
    time: new Date().toISOString(),
    message: error.message,
    stack: error.stack
  }).catch(() => {});
  console.error(error);
  process.exit(1);
});
