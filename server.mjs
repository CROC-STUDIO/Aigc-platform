import { execFile } from "node:child_process";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream, createWriteStream, existsSync } from "node:fs";
import { access, copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { homedir, networkInterfaces } from "node:os";
import { Readable } from "node:stream";
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import { handleWangzhuanRequest } from "./server/wangzhuan/router.mjs";
import { runDueSchedulerJobs } from "./server/wangzhuan/scheduler.mjs";
import { resolveProjectFilePath } from "./server/project-file-paths.mjs";
import { createAuthStore, publicUser } from "./server/auth-store.mjs";
import { loadEnvFile, loadRuntimeConfig } from "./server/runtime-config.mjs";
import {
  buildPublicUrl,
  deleteObject,
  deleteRecordedAssetMetadata,
  getRecordedAssetMetadata,
  objectStorageEnabled,
  openObjectStream,
  projectStorageDescriptor,
  uploadProjectAsset
} from "./server/object-storage.mjs";

const execFileAsync = promisify(execFile);
const __dirname = fileURLToPath(new URL(".", import.meta.url));
loadEnvFile({ envPath: join(__dirname, ".env") });

function resolveAppPath(value, baseDir = __dirname) {
  const raw = String(value ?? "").trim();
  return resolve(isAbsolute(raw) ? raw : join(baseDir, raw || "."));
}

const CONFIG_PATH = process.env.AIGC_CONFIG_PATH ? resolveAppPath(process.env.AIGC_CONFIG_PATH) : join(__dirname, "config.json");
const DEFAULT_CONFIG_PATH = join(__dirname, "config.default.json");
const USERS_PATH = process.env.AIGC_USERS_PATH ? resolveAppPath(process.env.AIGC_USERS_PATH) : join(__dirname, "users.json");
const USER_PROFILES_PATH = process.env.AIGC_USER_PROFILES_PATH ? resolveAppPath(process.env.AIGC_USER_PROFILES_PATH) : join(__dirname, "user-profiles.json");
const SESSION_COOKIE_NAME = String(process.env.AIGC_SESSION_COOKIE_NAME || "ad_session").trim() || "ad_session";
const PROJECT_ROOT_COOKIE_NAME = String(process.env.AIGC_PROJECT_ROOT_COOKIE_NAME || "ad_project_root").trim() || "ad_project_root";
const CONFIG_DIR = dirname(CONFIG_PATH);
let projectRoot = process.env.AIGC_PROJECT_ROOT ? resolveAppPath(process.env.AIGC_PROJECT_ROOT) : resolve(__dirname, "..");
let savedProjects = [];
let authStore;
let appConfig = {};
const requestScope = new AsyncLocalStorage();
const PUBLIC_DIR = join(__dirname, "public");
const MODEL = "codex-gpt-image-2";
const IMAGE_MODEL_OPTIONS = {
  "codex-gpt-image-2": { model: "codex-gpt-image-2", label: "codex-gpt-image-2" },
  "codex-gpt-image2": { model: "codex-gpt-image-2", label: "codex-gpt-image-2" },
  "gpt-image-2": { model: "gpt-image-2", label: "gpt-image-2" },
  "ByteDance-Seedream-5-0-lite": { model: "doubao-seedream-5-0-260128", label: "ByteDance-Seedream-5-0-lite" },
  "doubao-seedream-5-0-260128": { model: "doubao-seedream-5-0-260128", label: "ByteDance-Seedream-5-0-lite" }
};
const IMAGE_MODELS = new Set(Object.keys(IMAGE_MODEL_OPTIONS));
const SEEDANCE_MODEL = "dreamina-seedance-2-0-260128";
const SEEDANCE_MODEL_LABEL = "Dreamina Seedance 2.0 Mini";
const VIDEO_MODEL_OPTIONS = {
  "dreamina-seedance-2-0-fast-260128": { model: "dreamina-seedance-2-0-fast-260128", label: "Seedance 2.0 Fast" },
  "dreamina-seedance-2-0-260128": { model: "dreamina-seedance-2-0-260128", label: "dreamina-seedance-2-0-260128" },
  "dreamina-seedance-2-0-mini": { model: "dreamina-seedance-2-0-260128", label: "Dreamina Seedance 2.0 Mini" }
};
const REVERSE_PROMPT_MODEL = process.env.REVERSE_PROMPT_MODEL || "gemini-3-flash-preview";
const REVERSE_PROMPT_ENDPOINT = process.env.REVERSE_PROMPT_ENDPOINT || process.env.OPENAI_BASE_URL || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || process.env.REVERSE_PROMPT_API_KEY || "";
const DEFAULT_OUTPUT_SIZE = "1024x1024";
const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm", ".mov"]);
const ZINGAPI_HOST = process.env.ZINGAPI_HOST || "openapi.dataideaglobal.com";
const ZINGAPI_VERSION = process.env.ZINGAPI_VERSION || "v1";
const ZINGAPI_CUSTOMER_NAME = process.env.ZINGAPI_CUSTOMER_NAME || process.env.GUANGDADA_CUSTOMER_NAME || "";
const ZINGAPI_ACCESS_KEY_ID = process.env.ZINGAPI_ACCESS_KEY_ID || process.env.GUANGDADA_ACCESS_KEY_ID || "";
const ZINGAPI_ACCESS_KEY_SECRET = process.env.ZINGAPI_ACCESS_KEY_SECRET || process.env.GUANGDADA_ACCESS_KEY_SECRET || "";

function defaultRunState() {
  return {
    running: false,
    stopRequested: false,
    batchTag: "",
    startedAt: "",
    finishedAt: "",
    total: 0,
    completed: 0,
    skipped: 0,
    failed: 0,
    current: "",
    jobs: [],
    log: []
  };
}

const sessionStates = new Map();

function sanitizeSegment(value, fallback = "default") {
  const clean = String(value ?? "")
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/\s+/g, "_")
    .slice(0, 80);
  return clean || fallback;
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function appendCookie(res, cookie) {
  const current = res.getHeader("Set-Cookie");
  if (!current) return res.setHeader("Set-Cookie", cookie);
  if (Array.isArray(current)) return res.setHeader("Set-Cookie", [...current, cookie]);
  return res.setHeader("Set-Cookie", [current, cookie]);
}

function clearCookie(name) {
  return `${name}=; Path=/; Max-Age=0; SameSite=Lax`;
}

async function loadUsers() {
  authStore = createAuthStore({ usersPath: USERS_PATH });
  await authStore.init();
}

async function userFromRequest(req) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME] || "";
  return authStore.userFromSessionToken(token);
}

async function login(req, res) {
  const body = await readJson(req);
  const username = String(body.username ?? "");
  const password = String(body.password ?? "");
  const result = await authStore.login(username, password, {
    ip: req.socket?.remoteAddress ?? "",
    userAgent: req.headers["user-agent"] ?? ""
  });
  if (!result.authenticated) {
    return sendJson(res, { error: "账号或密码错误" }, 401);
  }
  appendCookie(res, `${SESSION_COOKIE_NAME}=${encodeURIComponent(result.token)}; Path=/; Max-Age=2592000; SameSite=Lax; HttpOnly`);
  const profiles = await readUserProfiles();
  const profile = publicProfile(result.user.username, profiles[result.user.username]);
  return sendJson(res, { authenticated: true, user: { ...result.user, displayName: profile.displayName || result.user.displayName, avatar: profile.avatar, profile } });
}

async function logout(req, res) {
  const token = parseCookies(req)[SESSION_COOKIE_NAME] || "";
  await authStore.logout(token);
  appendCookie(res, clearCookie(SESSION_COOKIE_NAME));
  return sendJson(res, { ok: true, authenticated: false });
}

function currentUser() {
  return requestScope.getStore()?.user || null;
}

function requireAdmin() {
  const user = currentUser();
  if (!user?.isAdmin) {
    const error = new Error("只有管理员可以管理账号");
    error.status = 403;
    throw error;
  }
  return user;
}

async function listAdminUsers() {
  requireAdmin();
  return { users: await authStore.listUsers() };
}

async function createAdminUser(body = {}) {
  return authStore.createUser(body, requireAdmin());
}

async function updateAdminUser(body = {}) {
  const admin = requireAdmin();
  return authStore.updateUser(body, admin);
}

async function deleteAdminUser(body = {}) {
  const admin = requireAdmin();
  return authStore.deleteUser(body.username, admin);
}

async function readUserProfiles() {
  if (!existsSync(USER_PROFILES_PATH)) return {};
  try {
    const data = JSON.parse(await readFile(USER_PROFILES_PATH, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

async function writeUserProfiles(profiles) {
  await writeFile(USER_PROFILES_PATH, `${JSON.stringify(profiles, null, 2)}\n`, "utf8");
}

function maskApiKey(value) {
  const key = String(value || "").trim();
  if (!key) return "";
  if (key.length <= 10) return "已配置";
  return `${key.slice(0, 4)}...${key.slice(-4)}`;
}

function publicProfile(username, profile = {}) {
  return {
    username,
    displayName: String(profile.displayName || "").trim(),
    avatar: String(profile.avatar || "").trim(),
    hasApiKey: Boolean(String(profile.apiKey || "").trim()),
    apiKeyPreview: maskApiKey(profile.apiKey)
  };
}

async function getMyProfile() {
  const user = currentUser();
  if (!user?.username) throw new Error("请先登录");
  const profiles = await readUserProfiles();
  return { profile: publicProfile(user.username, profiles[user.username]) };
}

async function updateMyProfile(body = {}) {
  const user = currentUser();
  if (!user?.username) throw new Error("请先登录");
  const profiles = await readUserProfiles();
  const current = profiles[user.username] || {};
  const displayName = String(body.displayName ?? current.displayName ?? user.displayName ?? user.username).trim().slice(0, 60);
  const avatar = String(body.avatar ?? current.avatar ?? "").trim().slice(0, 3_000_000);
  const apiKeyInput = String(body.apiKey ?? "").trim();
  profiles[user.username] = {
    ...current,
    displayName: displayName || user.username,
    avatar,
    apiKey: apiKeyInput ? apiKeyInput : String(current.apiKey || ""),
    updatedAt: new Date().toISOString()
  };
  await writeUserProfiles(profiles);
  return { ok: true, profile: publicProfile(user.username, profiles[user.username]) };
}

function resolveImageModel(value = MODEL) {
  const key = String(value || MODEL).trim();
  const info = IMAGE_MODEL_OPTIONS[key];
  if (!info) throw new Error("请先选择生图模型。");
  return info;
}

async function currentUserProfile() {
  const username = currentUserId();
  const profiles = await readUserProfiles();
  return profiles[username] || {};
}

async function requireUserApiKeyForModel(model, label = "模型") {
  const profile = await currentUserProfile();
  const apiKey = String(profile.apiKey || "").trim();
  if (!apiKey) {
    const error = new Error(`请先点击右上角头像，在个人信息里配置 API Key 后再使用 ${label}`);
    error.status = 400;
    throw error;
  }
  return apiKey;
}

function taiEnvForApiKey(apiKey) {
  const clean = String(apiKey || "").trim();
  if (!clean) return {};
  return {
    OPENAI_API_KEY: clean,
    OPENAI_KEY: clean,
    REVERSE_PROMPT_API_KEY: clean,
    TAI_API_KEY: clean,
    TAI_TOKEN: clean
  };
}

async function checkModelAccess(body = {}) {
  const imageModel = String(body.imageModel || "").trim();
  const videoModel = String(body.videoModel || "").trim();
  const outputMode = body.outputMode === "video" ? "video" : "image";
  if (imageModel) {
    const info = resolveImageModel(imageModel);
    await requireUserApiKeyForModel(info.model, info.label);
  }
  if (outputMode === "video") {
    const info = resolveVideoModel(videoModel || "dreamina-seedance-2-0-mini");
    await requireUserApiKeyForModel(info.model, info.label);
  }
  return { ok: true };
}

function currentUserId() {
  return requestScope.getStore()?.userId || "local";
}

function currentProjectRoot() {
  return requestScope.getStore()?.userProjectRoot || projectRoot;
}

function currentBaseProjectRoot() {
  return requestScope.getStore()?.baseProjectRoot || projectRoot;
}

function sessionKey() {
  return `${currentUserId()}::${resolve(currentBaseProjectRoot())}`;
}

function sessionState() {
  const key = sessionKey();
  if (!sessionStates.has(key)) sessionStates.set(key, { runState: defaultRunState(), activeChildren: new Set() });
  return sessionStates.get(key);
}

function getRunState() {
  return sessionState().runState;
}

function setRunState(next) {
  sessionState().runState = next;
  return next;
}

function activeChildren() {
  return sessionState().activeChildren;
}

process.on("unhandledRejection", (error) => {
  console.error("Unhandled rejection:", error);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});

function taiEntryPath() {
  const candidates = [
    process.env.TAI_ENTRY,
    process.env.APPDATA ? join(process.env.APPDATA, "npm", "node_modules", "tai-ai", "dist", "tai.min.js") : "",
    process.env.HOME ? join(process.env.HOME, ".npm-global", "lib", "node_modules", "tai-ai", "dist", "tai.min.js") : ""
  ].filter(Boolean);
  const found = candidates.find((item) => existsSync(item));
  if (!found) throw new Error("Tai CLI not found. Please install it with: npm install -g tai-ai, or set TAI_ENTRY to tai.min.js");
  return found;
}

function toolPath(name) {
  const exe = process.platform === "win32" ? `${name}.exe` : name;
  const candidates = [
    process.env[`${name.toUpperCase()}_PATH`],
    join(__dirname, "tools", "ffmpeg", "bin", exe),
    join(homedir(), "Documents", "Codex", "2026-05-19", "seedance-ad-video-seedance", "tools", "ffmpeg-8.1.1-essentials_build", "bin", exe),
    name
  ].filter(Boolean);
  return candidates.find((item) => item === name || existsSync(item)) || name;
}

function dirs() {
  const root = currentProjectRoot();
  const sharedRoot = currentBaseProjectRoot();
  const recordDir = join(root, "\u6279\u5904\u7406\u8bb0\u5f55");
  const sharedRecordDir = join(sharedRoot, "\u6279\u5904\u7406\u8bb0\u5f55");
  return {
    projectRoot: root,
    sharedProjectRoot: sharedRoot,
    roleDir: join(sharedRoot, "\u89d2\u8272\u56fe"),
    monsterDir: join(sharedRoot, "\u602a\u7269\u56fe"),
    sceneDir: join(sharedRoot, "\u573a\u666f\u56fe"),
    referenceVideoDir: join(sharedRoot, "\u53c2\u8003\u89c6\u9891"),
    logoDir: join(sharedRoot, "\u4ea7\u54c1logo"),
    outputDir: join(root, "\u6548\u679c\u56fe"),
    recordDir,
    guangdadaCacheDir: join(recordDir, "guangdada_cache"),
    globalRequirementPath: join(recordDir, "\u901a\u7528\u63d0\u793a\u8bcd.txt"),
    competitorNameLibraryPath: join(recordDir, "\u7ade\u54c1\u540d\u79f0\u5e93.json"),
    upscaledDir: join(sharedRecordDir, "upscaled_refs_20260608_b")
  };
}

async function loadConfig() {
  try {
    const { config, runtimeConfigExists } = await loadRuntimeConfig({
      runtimePath: CONFIG_PATH,
      defaultPath: DEFAULT_CONFIG_PATH
    });
    appConfig = config;
    if (runtimeConfigExists && config.projectRoot && !process.env.AIGC_PROJECT_ROOT) projectRoot = resolveConfiguredProjectPath(config.projectRoot);
    savedProjects = normalizeProjects(config.projects ?? [{ name: basename(projectRoot), path: projectRoot }]);
  } catch {
    appConfig = {};
    projectRoot = process.env.AIGC_PROJECT_ROOT ? resolveAppPath(process.env.AIGC_PROJECT_ROOT) : resolve(__dirname, "..");
    savedProjects = normalizeProjects([{ name: basename(projectRoot), path: projectRoot }]);
  }
}

function resolveConfiguredProjectPath(value) {
  const raw = String(value ?? "").trim();
  return resolveAppPath(raw, CONFIG_DIR);
}

function projectPathForConfig(value) {
  const fullPath = resolve(String(value ?? "").trim());
  const relPath = relative(CONFIG_DIR, fullPath).replace(/\\/g, "/");
  if (!relPath || relPath.startsWith("../..") || isAbsolute(relPath)) return fullPath;
  return relPath.startsWith(".") ? relPath : `./${relPath}`;
}

function normalizeProjects(items) {
  const seen = new Set();
  const normalized = [];
  for (const item of items ?? []) {
    const path = resolveConfiguredProjectPath(item.path ?? item.projectRoot);
    if (!path || seen.has(path)) continue;
    seen.add(path);
    normalized.push({ name: String(item.name ?? basename(path) ?? path).trim() || basename(path), path });
  }
  if (!normalized.some((item) => item.path === projectRoot)) {
    normalized.unshift({ name: basename(projectRoot), path: projectRoot });
  }
  return normalized;
}

function projectList() {
  savedProjects = normalizeProjects(savedProjects);
  const activeBase = resolve(currentBaseProjectRoot());
  return savedProjects.map((item) => ({ ...item, active: item.path === activeBase, userPath: userProjectRoot(item.path, currentUserId()) }));
}

function userProjectRoot(baseRoot = currentBaseProjectRoot(), userId = currentUserId()) {
  return join(resolve(baseRoot), "\u7528\u6237\u6570\u636e", sanitizeSegment(userId), sanitizeSegment(basename(resolve(baseRoot))));
}

async function ensureUserProjectScope(userId = currentUserId()) {
  const root = userProjectRoot(currentBaseProjectRoot(), userId);
  await ensureProjectStructure(root);
  return root;
}

async function ensureProjectStructure(root = projectRoot) {
  const names = [
    "\u89d2\u8272\u56fe",
    "\u602a\u7269\u56fe",
    "\u573a\u666f\u56fe",
    "\u53c2\u8003\u89c6\u9891",
    "\u4ea7\u54c1logo",
    "\u6548\u679c\u56fe",
    "\u6279\u5904\u7406\u8bb0\u5f55",
    "\u7ade\u54c1\u7d20\u67501",
    "\u7ade\u54c1\u7d20\u67502",
    "\u7ade\u54c1\u7d20\u67503"
  ];
  await mkdir(root, { recursive: true });
  await Promise.all(names.map((name) => mkdir(join(root, name), { recursive: true })));
}

async function canUseProjectRoot(root) {
  const target = resolve(String(root || "").trim() || ".");
  try {
    await mkdir(target, { recursive: true });
    await access(target, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

async function firstUsableProjectRoot(preferredRoot = projectRoot) {
  if (await canUseProjectRoot(preferredRoot)) return resolve(preferredRoot);
  for (const item of savedProjects) {
    if (await canUseProjectRoot(item.path)) return item.path;
  }
  return resolve(preferredRoot);
}

async function saveConfig() {
  savedProjects = normalizeProjects(savedProjects);
  appConfig = {
    ...appConfig,
    projectRoot: projectPathForConfig(projectRoot),
    projects: savedProjects.map((item) => ({
      ...item,
      path: projectPathForConfig(item.path)
    }))
  };
  await writeFile(CONFIG_PATH, JSON.stringify(appConfig, null, 2), "utf8");
}

const ROLE_META = {
  "heroIcon_450101.png": { title: "Dragon Blade Rogue", traits: "chibi red-haired rogue swordsman, spiky orange-red hair, mischievous grin, white martial robe, red scarf and belt, huge blue silver sword, small dark dragon companion behind him", theme: "dragon fire, red scarf, blue sword slash", className: "Rogue" },
  "Icon_Head_1005.png": { title: "Rabbit Moon Mage", traits: "chibi rabbit mage, purple wizard hat and robe, long ears, pink face, green eyes, holding a golden moon staff, carrying a small plush charm, playful smile", theme: "moon staff, purple magic, rabbit ears, soft sparkles", className: "Mage" },
  "Icon_Head_201102.png": { title: "Golden Wing Knight", traits: "chibi golden armored wing knight, black hair, blue eyes, huge gold wing armor, red waist accents, holding a silver sword, heroic stance", theme: "gold wings, sword light, holy armor, blue gem glow", className: "Knight" },
  "Icon_Head_210101.png": { title: "Bone Snack Dino", traits: "chibi green baby dinosaur, cyan head spikes, big sparkling teal eyes, cream belly, holding a white bone, tiny claws and tail, cute hungry pose", theme: "tiny dino, bone snack, green scales, playful bite", className: "Pet" },
  "Icon_Head_210301.png": { title: "Candy Witch Dino", traits: "chibi pink dinosaur wizard, huge blue wizard hat, red bow tie, holding a red spiral lollipop wand with tiny white wings, cheerful magical pose", theme: "candy wand, blue wizard hat, pink magic, sweet sparkles", className: "Mage" },
  "Icon_Head_210401.png": { title: "Cowboy Sling Dino", traits: "chibi teal dinosaur cowboy, brown hat with yellow feather, red scarf, holding a wooden slingshot, alert eyes, small green spikes", theme: "slingshot, cowboy hat, red scarf, desert dust", className: "Shooter" },
  "Icon_Head_210501.png": { title: "Monkey King Cub", traits: "chibi monkey warrior cub, golden helmet with long yellow plumes, red and gold armor, red cape, holding a golden staff, determined yellow eyes", theme: "golden staff, monkey king armor, red cape, heroic sparks", className: "Warrior" },
  "Icon_Head_3011.png": { title: "Aqua Demon Rogue", traits: "chibi aqua-haired demon girl, cyan hair covering one eye, purple curved horns, purple bat wings, violet bodysuit, curved blue dagger, small tail", theme: "bat wings, cyan dagger, purple horns, aqua shadow magic", className: "Rogue" },
  "Icon_Head_4012.png": { title: "Ribbon Shadow Ninja", traits: "chibi white-haired ninja girl, large pink ribbon, black face mask, black and pink outfit, dual curved daggers, pink wing-like energy behind her, crouched action pose", theme: "pink shadow blades, ribbon, ninja smoke, swift slash", className: "Ninja" }
};

const DEFAULT_REQUIREMENTS = {
  "\u7ade\u54c1\u7d20\u67501": "Use the competitor image only as an abstract layout and ad-mechanic reference. Preserve composition relationships, subject scale, camera angle, emotional acting, text hierarchy, and the functional roles of props, but redesign the concrete scene, background, props, logo area, and decorative details into the selected user-owned asset's own world and visual language. Do not copy the exact competitor background, volcano, table, teapot, logo, mascot, prop shapes, color blocks, or proprietary UI. Do not force RPG stats, battle UI, skill icons, or weapon showcase unless the reference clearly contains those elements.",
  "\u7ade\u54c1\u7d20\u67502": "Use the competitor image only as an abstract layout and ad-mechanic reference. Preserve composition relationships, subject scale, camera angle, emotional acting, text hierarchy, and the functional roles of props, but redesign the concrete scene, background, props, logo area, and decorative details into the selected user-owned asset's own world and visual language. Use wide output when the reference is wide. Do not copy competitor logos, names, characters, background, prop shapes, watermarks, or proprietary UI.",
  "\u7ade\u54c1\u7d20\u67503": "Use the competitor image only as an abstract multi-subject layout and ad-mechanic reference. Preserve composition relationships, subject scale, emotional acting, facial expression, restraint/binding state, danger silhouette role, spacing, camera angle, and text hierarchy, but redesign the concrete scene, background, props, threat design, logo area, and decorative details into the selected user-owned assets' own world and visual language. Combine selected user-owned role and monster assets according to the count settings and preserve each identity clearly. Do not copy competitor logos, names, characters, backgrounds, prop shapes, watermarks, or proprietary UI."
};

const GLOBAL_LOGO_RULE = "如果竞品图中有游戏 logo，把该 logo 替换成上传的产品 logo；如果竞品图中没有游戏 logo，也要在合适的广告角落或标题区加上上传的产品 logo，不能使用竞品 logo。";

function defaultGlobalRequirement() {
  return [
    "1. 只把竞品素材作为抽象广告参考：参考画面比例、构图重心、主体大小、镜头距离、情绪表演、道具功能关系、文字/Logo层级和广告节奏，不照搬竞品角色、品牌、logo、具体场景、专有UI、道具造型、装饰形状或色块。",
    "2. 生成内容必须替换为我方上传的角色、怪物、场景或产品Logo等自有素材风格。若参考素材里有对应主体，请用我方素材替换原主体的位置、比例和姿态关系，不要在原主体旁边额外新增。",
    "3. 场景与道具要根据当前项目的世界观重新设计。可以保留参考素材的功能布局和互动关系，但具体视觉元素、背景皮肤、UI样式和装饰细节必须原创化。",
    "4. 根据当前竞品素材实际类型生成：可以是休闲、搞笑、生活化、宠物互动、经营、换装、合成、解谜、剧情、产品展示或战斗玩法。只有参考素材明确出现战斗/塔防/攻击/升级时，才加入对应玩法元素；否则不要强行加入怪物进攻、武器、技能、血条、伤害数字、升级卡或战斗UI。",
    "5. 表情和肢体动作只参考当前素材实际可见的情绪方向、眼神、嘴型、姿态、角色间距离和互动方向；不要混入其他素材或历史结果里的特殊状态。",
    "6. 如果参考素材有文字区域，只保留文字位置、大小和层级。具体文字按特殊提示词替换，或使用简短原创英文广告文案，避免乱码和竞品品牌名。",
    `7. ${GLOBAL_LOGO_RULE}`,
    "8. 画面保持移动游戏广告质感：主体清晰、轮廓干净、色彩有吸引力、层次明确、适合投放素材预览。"
  ].join("\n");
}

function chineseRequirementAfterReplace(analysis = {}) {
  const ratioText = analysis.orientation === "wide"
    ? "当前参考图偏横版，优先使用横版广告构图。"
    : analysis.orientation === "tall"
      ? "当前参考图偏竖版，优先使用竖版广告构图。"
      : "当前参考图接近方图，优先保持方形广告构图。";
  const base = [
    `1. 默认要求来自本次上传的当前竞品参考图。${ratioText}只参考当前图的抽象版式、镜头角度、主体大小、广告节奏、文案层级和道具的功能关系，不要照搬竞品的具体背景、具体道具、logo、角色、吉祥物、装饰形状、色块和专有UI。`,
    "2. 角色或怪物必须使用我方上传素材，保留我方素材的发型、脸型、服装、武器、颜色、轮廓和标志性特征。",
    "3. 场景需要根据我方角色/怪物的世界观重新设计。可以保留当前参考图实际可见的功能位置和布局关系，但具体视觉元素必须替换成原创设计。",
    "4. 表情和肢体表演只参考当前竞品图实际可见的情绪方向、眼神、嘴型、头部角度、姿态和互动关系；不要从其他竞品图或历史结果里借用特殊状态。",
    "5. 如果参考图有文字，只保留文字区域和层级；文字内容按用户特殊要求替换，或者使用简短原创英文广告文案。",
    `6. ${GLOBAL_LOGO_RULE}`,
    "7. 画风保持高饱和、干净卡通、清晰轮廓、移动游戏广告质感。"
  ];
  return base.join("\n");
}

async function ensureGlobalRequirementLogoRule(text) {
  const current = String(text ?? "").trim();
  if (!current || isLegacyGlobalRequirement(current)) {
    const next = defaultGlobalRequirement();
    await mkdir(dirs().recordDir, { recursive: true });
    await writeFile(dirs().globalRequirementPath, next, "utf8");
    return next;
  }
  if (current.includes("上传的产品 logo") || current.includes("上传的产品 Logo")) return current;
  const next = current ? `${current}\n${GLOBAL_LOGO_RULE}` : chineseRequirementAfterReplace();
  await mkdir(dirs().recordDir, { recursive: true });
  await writeFile(dirs().globalRequirementPath, next, "utf8");
  return next;
}

function isLegacyGlobalRequirement(text) {
  return text.includes("默认要求来自本次上传的当前竞品参考图")
    && text.includes("角色或怪物必须使用我方上传素材")
    && text.includes("画风保持高饱和");
}

function chineseSpecialRequirementAfterReplace(analysis = {}) {
  const sourceLine = analysis.width && analysis.height
    ? `来源：本段默认要求根据本次上传图片生成（${analysis.width}x${analysis.height}，${analysis.orientationLabel}），不是按竞品素材文件夹编号套模板。`
    : "来源：本段默认要求根据本次上传图片生成，不是按竞品素材文件夹编号套模板。";
  const composition = analysis.subjectX
    ? `构图反推：当前图是${analysis.orientationLabel || "参考图"}，主体视觉重心偏${analysis.subjectX}${analysis.subjectY}，画面整体是${analysis.brightnessLabel}、${analysis.saturationLabel}的${analysis.paletteLabel}调性，边缘细节${analysis.detailLabel}。生成时必须保留这种画面比例、视觉重心、疏密节奏、明暗关系和广告层级；如果当前图是方图，就不要扩展成横版阵容图。具体角色、场景、道具和装饰全部换成我方资产风格。`
    : `构图反推：当前图是${analysis.orientationLabel || "参考图"}广告构图。请按当前图实际可见的主体位置、画面比例、画面重心、文字区域、道具关系和互动姿态来安排新图，不要套用其他竞品图的剧情；如果当前图是方图，就不要扩展成横版阵容图。`;
  const colorLine = analysis.dominantColors?.length
    ? `色彩反推：参考图主要色彩约为 ${analysis.dominantColors.join("、")}，可以保留相近的冷暖对比和视觉节奏，但不要照搬原图色块形状、logo区域或专有UI。`
    : "";
  const lines = [
    sourceLine,
    composition,
    colorLine,
    "表情与动作：请观察当前图里实际可见的眼神、嘴型、头部角度、手势、站坐姿、角色间距离和互动方向，并在我方角色/怪物上复刻这种情绪表演。不要默认改成开心英雄展示，也不要借用其他竞品图的被困、战斗、威胁或特殊姿态。",
    "文字与UI：如果当前图有标题、按钮、手机框、标签或文案区，只保留它们的层级和位置关系；具体文字按用户在这里补充的替换要求执行。"
  ].filter(Boolean);
  return lines.join("\n");
}

function chineseVideoSpecialRequirement(fileName, analysis = null) {
  const frameText = analysis
    ? chineseSpecialRequirementAfterReplace(analysis).replace("本次上传图片", "本次上传视频封面帧")
    : [
        `来源：本段默认要求根据本次上传视频 ${fileName} 生成，不是按竞品素材文件夹编号套模板。`,
        "视频反推：请观察当前视频的广告类型、镜头远近、主体入场方向、UI/文字层级、动作节奏、道具互动、情绪变化和转场时机，并把这些抽象关系写入我方生成要求。只有当前视频明确是战斗/塔防玩法时，才反推攻击因果、升级链路或敌我方向。",
        "首帧要求：先用视频中最能代表广告布局的一帧作为 codex-gpt-image-2 效果图参考，保留画面比例、主体位置、主体比例、道具/按钮/文字区域和镜头距离；不要套用其他竞品图或历史生成图的构图。",
        "替换规则：竞品角色、logo、品牌名、UI文字、具体场景皮肤、建筑造型、专有道具和装饰细节都必须改成我方原创风格；我方角色或素材要替换原参考中的对应主体位置，不能在原主体旁边额外新增。非战斗素材不要强行加入怪物、攻击、技能、升级卡或塔防元素。"
      ].join("\n");
  return `${frameText}\n视频节奏：生成视频时继续参考本视频的前3秒钩子、镜头推进、主体运动、表情/道具反馈、高潮记忆点和结尾停留，但只保留抽象节奏、镜头语言和广告关系，不复制竞品具体元素。只有当前视频明确是战斗玩法时，才加入攻击反馈或升级节奏；否则保持非战斗广告类型。`;
}

function specialRequirementJson({ type, fileName, analysis = null, videoPrompt = "" }) {
  const isVideo = type === "video";
  const ai = analysis?.ai && !analysis.ai.error ? analysis.ai : null;
  const sourcePrompt = isVideo
    ? chineseVideoSpecialRequirement(fileName, analysis)
    : chineseSpecialRequirementAfterReplace(analysis || {});
  const imagePrompt = ai?.image2_prompt_guidance || sourcePrompt;
  const seedancePrompt = ai?.seedance2_video_prompt || (isVideo
    ? [
        `参考当前竞品视频 ${fileName} 的反推结构制作 Seedance 2.0 视频，但只保留抽象镜头语言、节奏和广告关系。`,
        "先根据 codex-gpt-image-2 生成的我方效果图作为首帧/主体设定，再延续当前视频的前3秒钩子、镜头推进、主体运动方向、表情变化、道具互动、产品/Logo露出和结尾停留。",
        "如果当前视频明确是战斗/塔防玩法，才保留敌我方向、单位位置、升级链路和攻击因果；如果不是战斗视频，必须保持原参考的非战斗类型，不要加入怪物进攻、武器、技能、血条、伤害数字、升级卡或战斗UI。",
        "所有竞品角色、logo、品牌名、UI文字、具体场景皮肤、建筑造型、专有道具和装饰细节都要替换成我方原创风格；我方角色/怪物/Logo必须替换原参考里的对应主体位置，不能与原主体同时存在。"
      ].join("\n")
    : "");
  const dialogue = normalizeDialogueAnalysis(analysis?.dialogue || ai?.dialogue || ai?.dialogue_language || null);
  const dialoguePrompt = isVideo ? dialogueInstructionBlock(dialogue) : "";
  const data = {
    schema_version: "1.0",
    material_type: isVideo ? "video" : "image",
    source_file: fileName,
    reverse_model: ai ? REVERSE_PROMPT_MODEL : "local_fallback",
    reverse_analysis: {
      source: ai ? "ai_vision_reverse_prompt" : (isVideo ? "uploaded_video_cover_or_video_metadata_local_fallback" : "uploaded_image_local_visual_analysis_fallback"),
      ai_error: analysis?.ai?.error || "",
      visual_summary: ai?.visual_summary || "",
      composition: ai?.composition || "",
      subjects: ai?.subjects || "",
      expressions: ai?.expressions || "",
      scene: ai?.scene || "",
      props: ai?.props || "",
      text_logo_ui: ai?.text_logo_ui || "",
      camera: ai?.camera || "",
      color_lighting: ai?.color_lighting || "",
      ad_mechanic: ai?.ad_mechanic || "",
      dialogue,
      is_combat_reference: Boolean(ai?.is_combat_reference),
      non_combat_guard: ai?.non_combat_guard || "",
      infringement_avoidance: ai?.infringement_avoidance || "",
      orientation: analysis?.orientationLabel || "",
      size: analysis?.width && analysis?.height ? `${analysis.width}x${analysis.height}` : "",
      visual_focus: analysis?.subjectX ? `${analysis.subjectX}${analysis.subjectY || ""}` : "",
      brightness: analysis?.brightnessLabel || "",
      saturation: analysis?.saturationLabel || "",
      palette: analysis?.paletteLabel || "",
      detail_density: analysis?.detailLabel || "",
      dominant_colors: analysis?.dominantColors || [],
      composition_prompt: sourcePrompt,
      editable_note: ai?.user_edit_tip || "本JSON由上传素材自动反推生成；如需要更精确的表情、剧情、文字替换或动作细节，请直接修改本JSON中的提示词字段。"
    },
    image2_prompt_guidance: imagePrompt,
    seedance2_video_prompt: [seedancePrompt, dialoguePrompt].filter(Boolean).join("\n"),
    user_overrides: ""
  };
  return JSON.stringify(data, null, 2);
}

function normalizeDialogueAnalysis(value) {
  if (!value) return { has_dialogue: false, language: "", original_lines: [], preserve_language: true, instruction: "未检测到明确台词；不要额外添加新台词，除非用户特别要求。" };
  if (typeof value === "string") {
    const text = value.trim();
    return { has_dialogue: Boolean(text), language: detectDialogueLanguage(text), original_lines: text ? [text] : [], preserve_language: true, instruction: text ? `保留原视频台词语种（${detectDialogueLanguage(text) || "原语种"}），按原台词含义和节奏改写到新视频。` : "未检测到明确台词；不要额外添加新台词，除非用户特别要求。" };
  }
  const lines = Array.isArray(value.original_lines) ? value.original_lines.map((line) => String(line).trim()).filter(Boolean) : [];
  const text = lines.join("\n") || String(value.text || value.transcript || "").trim();
  const language = String(value.language || value.dialogue_language || detectDialogueLanguage(text)).trim();
  return {
    has_dialogue: Boolean(value.has_dialogue ?? text),
    language,
    original_lines: lines.length ? lines : (text ? [text] : []),
    preserve_language: value.preserve_language !== false,
    instruction: String(value.instruction || (text ? `保留原视频台词语种（${language || "原语种"}），按原台词含义和节奏改写到新视频。` : "未检测到明确台词；不要额外添加新台词，除非用户特别要求。"))
  };
}

function dialogueInstructionBlock(dialogue) {
  if (!dialogue?.has_dialogue || !dialogue.original_lines?.length) {
    return [
      "音频规则：生成视频必须包含自然环境音、动作音效和人物语音/口播，不要生成完全静音视频。",
      "台词规则：当前系统未能从原视频自动识别出明确台词时，也要参考原视频是否存在人物口型、口播节奏、字幕或对白气口；如画面明显有人说话，请生成同语种、极短、自然的人物语音或口播。不要添加背景音乐，除非用户特别要求。",
      "如果用户在特殊提示词中补充了台词，以用户补充为准；否则使用与参考视频一致的语种和广告语气，不要把英文改成中文，也不要把中文改成英文。"
    ].join("\n");
  }
  return [
    "音频规则：生成视频必须包含自然环境音、动作音效和人物语音，不要生成完全静音视频；不要添加背景音乐，除非用户特别要求。",
    `台词规则：原视频存在台词，必须保留原台词语种：${dialogue.language || "原语种"}。除非用户在特殊要求中明确要求翻译或改语种，否则新视频不能改变台词语种。`,
    "原视频台词/可见字幕参考：",
    ...dialogue.original_lines.slice(0, 8).map((line, index) => `${index + 1}. ${line}`),
    "新视频可以按我方角色与场景做轻微改写，但必须保持相同语言、相近语气、相近节奏和相同剧情功能；不要把英文改成中文，也不要把中文改成英文。"
  ].join("\n");
}

function detectDialogueLanguage(text = "") {
  const value = String(text);
  if (/[\u4e00-\u9fff]/.test(value)) return "zh-CN";
  if (/[a-zA-Z]/.test(value)) return "en-US";
  return "";
}

function parseSpecialRequirementJson(text) {
  const raw = String(text ?? "").trim();
  if (!raw.startsWith("{")) return null;
  try {
    const data = JSON.parse(raw);
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function specialRequirementForImagePrompt(text) {
  const data = parseSpecialRequirementJson(text);
  if (!data) return String(text ?? "");
  return [
    data.image2_prompt_guidance,
    data.reverse_analysis?.composition_prompt,
    data.user_overrides
  ].filter(Boolean).join("\n");
}

function specialRequirementForVideoPrompt(text) {
  const data = parseSpecialRequirementJson(text);
  if (!data) return "";
  return [
    data.seedance2_video_prompt,
    data.user_overrides
  ].filter(Boolean).join("\n");
}

async function analyzeUploadedCompetitorImage(imagePath, options = {}) {
  const dimensions = await readImageDimensions(imagePath).catch(() => null);
  const width = dimensions?.width ?? 0;
  const height = dimensions?.height ?? 0;
  const ratio = width && height ? width / height : 1;
  const orientation = ratio > 1.15 ? "wide" : ratio < 0.87 ? "tall" : "square";
  const orientationLabel = orientation === "wide" ? "横版" : orientation === "tall" ? "竖版" : "方图";
  const visual = await analyzeImageWithPython(imagePath).catch(() => ({}));
  const ai = await reversePromptWithVisionModel(imagePath, { type: options.type || "image", fileName: options.fileName || basename(imagePath), width, height, orientationLabel }).catch((error) => ({ error: error.message }));
  return { width, height, orientation, orientationLabel, ...visual, ai };
}

async function reversePromptWithVisionModel(imagePath, { type = "image", fileName = basename(imagePath), width = 0, height = 0, orientationLabel = "" } = {}) {
  const gateway = await reversePromptGatewayConfig();
  if (!gateway.apiKey) throw new Error("未配置可用于视觉反推的 API Key，使用本地视觉统计 fallback");
  const buffer = await readFile(imagePath);
  const mime = contentTypeForFile(imagePath).startsWith("image/") ? contentTypeForFile(imagePath) : detectImageContentType(buffer);
  const dataUrl = `data:${mime};base64,${buffer.toString("base64")}`;
  const instruction = [
    "你是手游广告素材反推专家。请只根据上传的当前竞品图片/视频封面做视觉反推，不要套用历史模板。",
    "输出必须是严格 JSON，不要 Markdown，不要代码块。",
    "重点描述：素材类型、画面比例、主体数量和位置、主体比例、表情眼神嘴型、姿态手势、场景空间、道具功能、文字/logo/UI区域、镜头景别、光影色彩、广告钩子、是否战斗/塔防/升级玩法。",
    "如果画面中有可见字幕、对白气泡、口播文字或明显台词信息，请提取到 dialogue.original_lines，并判断 language。若看不出明确台词，dialogue.has_dialogue=false。",
    "台词语种必须保留：除非用户明确要求翻译或改语种，新视频不能改变原视频台词语种。例如原版是英文，新视频也必须是英文；原版是中文，新视频也必须是中文。",
    "如果不是战斗素材，要明确 non_combat_guard，禁止强行加入敌人、怪物进攻、攻击、武器、技能、血条、伤害数字、升级卡、战斗UI。",
    "如果是视频封面，请根据封面和上传视频语境写 seedance2_video_prompt：用于 Seedance 2.0 生成15秒竖屏视频，描述前3秒钩子、镜头推进、主体运动、表情/道具反馈、高潮和结尾停留，只保留抽象节奏，不复制竞品IP。",
    "image2_prompt_guidance 必须用于 codex-gpt-image-2 图生图：要求替换成我方角色/怪物/Logo，保留参考的抽象构图、主体位置、比例、表情和广告层级，但场景、道具、UI和具体元素原创化。",
    "JSON字段：material_type, visual_summary, composition, subjects, expressions, scene, props, text_logo_ui, dialogue, camera, color_lighting, ad_mechanic, is_combat_reference, non_combat_guard, infringement_avoidance, image2_prompt_guidance, seedance2_video_prompt, user_edit_tip。dialogue格式为 { has_dialogue, language, original_lines, preserve_language, instruction }。"
  ].join("\n");
  const inputText = `${instruction}\n当前素材类型：${type}\n文件名：${fileName}\n尺寸：${width || "unknown"}x${height || "unknown"}，${orientationLabel || "未知比例"}`;
  const payload = {
    model: REVERSE_PROMPT_MODEL,
    input: [{
      role: "user",
      content: [
        { type: "input_text", text: inputText },
        { type: "input_image", image_url: dataUrl }
      ]
    }],
    text: { format: { type: "json_object" } }
  };
  const endpoint = gateway.endpoint.replace(/\/$/, "");
  let res = await fetch(`${endpoint}/responses`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${gateway.apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  let raw = await res.text();
  if (res.status === 404 && /gemini/i.test(REVERSE_PROMPT_MODEL)) {
    const chatPayload = {
      model: REVERSE_PROMPT_MODEL,
      messages: [{
        role: "user",
        content: [
          { type: "text", text: inputText },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }],
      response_format: { type: "json_object" }
    };
    res = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${gateway.apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(chatPayload)
    });
    raw = await res.text();
  }
  if (!res.ok) throw new Error(`视觉反推失败 HTTP ${res.status}: ${raw.slice(0, 300)}`);
  const json = JSON.parse(raw);
  const text = extractResponseText(json);
  if (!text) throw new Error("视觉反推没有返回文本");
  return JSON.parse(text);
}

async function reversePromptGatewayConfig() {
  if (OPENAI_API_KEY || REVERSE_PROMPT_ENDPOINT) {
    return {
      apiKey: OPENAI_API_KEY,
      endpoint: REVERSE_PROMPT_ENDPOINT || "https://api.openai.com/v1"
    };
  }
  const codexConfigPath = join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "config.toml");
  const text = existsSync(codexConfigPath) ? await readFile(codexConfigPath, "utf8").catch(() => "") : "";
  const endpoint = text.match(/^\s*base_url\s*=\s*"([^"]+)"/m)?.[1] || "";
  const apiKey = text.match(/^\s*experimental_bearer_token\s*=\s*"([^"]+)"/m)?.[1] || "";
  return {
    apiKey,
    endpoint: endpoint || "https://api.openai.com/v1"
  };
}

function extractResponseText(response) {
  if (typeof response.output_text === "string") return response.output_text;
  const chatText = response.choices?.[0]?.message?.content;
  if (typeof chatText === "string") return chatText;
  if (Array.isArray(chatText)) return chatText.map((part) => part.text || "").join("\n").trim();
  const parts = [];
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === "string") parts.push(content.text);
    }
  }
  return parts.join("\n").trim();
}

async function analyzeImageWithPython(imagePath) {
  const script = `
import json, sys
from PIL import Image, ImageFilter, ImageStat
img = Image.open(sys.argv[1]).convert("RGB")
small = img.resize((96, 96))
gray = small.convert("L")
stat = ImageStat.Stat(small)
brightness = sum(ImageStat.Stat(gray).mean) / 255
saturation = ImageStat.Stat(small.convert("HSV")).mean[1] / 255
edges = gray.filter(ImageFilter.FIND_EDGES)
edge_mean = ImageStat.Stat(edges).mean[0] / 255
pixels = list(small.getdata())
weights = []
for i, (r, g, b) in enumerate(pixels):
    y = i // 96
    x = i % 96
    lum = (r + g + b) / 3
    sat = (max(r, g, b) - min(r, g, b))
    weights.append((x, y, sat + abs(lum - 128) * 0.5 + 1))
total = sum(w for _, _, w in weights) or 1
cx = sum(x * w for x, _, w in weights) / total / 95
cy = sum(y * w for _, y, w in weights) / total / 95
quant = small.quantize(colors=5, method=Image.Quantize.MEDIANCUT).convert("RGB")
colors = quant.getcolors(96 * 96) or []
colors.sort(reverse=True)
dominant = []
for _, color in colors[:4]:
    if color not in dominant:
        dominant.append("#%02X%02X%02X" % color)
print(json.dumps({
  "brightness": brightness,
  "saturation": saturation,
  "edgeMean": edge_mean,
  "centerX": cx,
  "centerY": cy,
  "dominantColors": dominant
}, ensure_ascii=False))
`;
  const { stdout } = await execFileAsync("python", ["-c", script, imagePath], { timeout: 8000 });
  const data = JSON.parse(stdout);
  const subjectX = data.centerX < 0.42 ? "左侧" : data.centerX > 0.58 ? "右侧" : "中间";
  const subjectY = data.centerY < 0.42 ? "上方" : data.centerY > 0.58 ? "下方" : "中部";
  const brightnessLabel = data.brightness < 0.34 ? "偏暗" : data.brightness > 0.66 ? "明亮" : "中等明度";
  const saturationLabel = data.saturation < 0.28 ? "低饱和" : data.saturation > 0.55 ? "高饱和" : "中等饱和";
  const detailLabel = data.edgeMean < 0.055 ? "较简洁" : data.edgeMean > 0.13 ? "较丰富" : "适中";
  const paletteLabel = data.saturation > 0.55 ? "强广告色" : data.brightness < 0.34 ? "戏剧氛围" : "清晰卡通";
  return { ...data, subjectX, subjectY, brightnessLabel, saturationLabel, detailLabel, paletteLabel };
}

async function readImageDimensions(imagePath) {
  const buffer = await readFile(imagePath);
  if (buffer.length >= 24 && buffer.toString("ascii", 1, 4) === "PNG") {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  if (buffer.length >= 10 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const size = buffer.readUInt16BE(offset + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + size;
    }
  }
  if (buffer.length >= 30 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") {
    const type = buffer.toString("ascii", 12, 16);
    if (type === "VP8X") {
      return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
    }
    if (type === "VP8 " && buffer.length >= 30) {
      return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
    }
    if (type === "VP8L" && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  }
  return null;
}

const remoteImageCache = new Map();
const remoteVideoCache = new Map();

function addLog(type, message, data = {}) {
  const runState = getRunState();
  runState.log.push({ time: new Date().toISOString(), type, message, ...data });
  if (runState.log.length > 600) runState.log.shift();
}

function updateJobState(jobName, patch) {
  const runState = getRunState();
  const item = runState.jobs.find((job) => job.name === jobName);
  if (item) Object.assign(item, patch);
}

function summarizeErrorText(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-4)
    .join(" | ")
    .slice(0, 700);
}

function isBytePlusAssetUploadRejected(text = "") {
  return /Asset upload rejected|CreateAsset HTTP 400|BytePlus Asset API/i.test(String(text || ""));
}

function sleepWithStop(ms) {
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const runState = getRunState();
      if (runState.stopRequested || Date.now() - started >= ms) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

function execTai(args, options = {}) {
  return new Promise((resolve, reject) => {
    const childEnv = { ...process.env, ...(options.env || {}) };
    for (const key of options.unsetEnv || []) delete childEnv[key];
    const child = execFile("node", [taiEntryPath(), ...args], { cwd: dirs().outputDir, env: childEnv, maxBuffer: 1024 * 1024 * 20, windowsHide: true }, (error, stdout, stderr) => {
      activeChildren().delete(child);
      const raw = `${stdout ?? ""}\n${stderr ?? ""}`;
      const succeededBeforeCrash = /Status:\s*succeeded/i.test(raw) && /\[1\]\s*\S+/i.test(raw);
      if (error && succeededBeforeCrash) {
        addLog("warn", `TAI_EXIT_AFTER_SUCCESS ${summarizeErrorText(raw)}`);
        resolve({ stdout, stderr });
        return;
      }
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    activeChildren().add(child);
  });
}

function execTool(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: options.cwd || dirs().outputDir, maxBuffer: 1024 * 1024 * 20, windowsHide: true }, (error, stdout, stderr) => {
      activeChildren().delete(child);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    activeChildren().add(child);
  });
}

async function listImageFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !IMAGE_EXTS.has(extname(entry.name).toLowerCase())) continue;
    const fullPath = join(dir, entry.name);
    const info = await stat(fullPath);
    files.push({ name: entry.name, path: fullPath, batch: inferBatchFromOutputName(entry.name), size: info.size, mtimeMs: info.mtimeMs, url: await publicUrlForProjectFile(fullPath, Math.round(info.mtimeMs)) });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

async function listOutputFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const ext = extname(entry.name).toLowerCase();
    const type = IMAGE_EXTS.has(ext) ? "image" : VIDEO_EXTS.has(ext) ? "video" : "";
    if (!type) continue;
    const fullPath = join(dir, entry.name);
    const info = await stat(fullPath);
    files.push({ name: entry.name, path: fullPath, type, batch: inferBatchFromOutputName(entry.name), size: info.size, mtimeMs: info.mtimeMs, url: type === "video" ? localFileUrl(fullPath, Math.round(info.mtimeMs)) : await publicUrlForProjectFile(fullPath, Math.round(info.mtimeMs)) });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

async function listVideoFiles(dir) {
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !VIDEO_EXTS.has(extname(entry.name).toLowerCase())) continue;
    const fullPath = join(dir, entry.name);
    const info = await stat(fullPath);
    files.push({ name: entry.name, path: fullPath, type: "video", batch: inferBatchFromOutputName(entry.name), size: info.size, mtimeMs: info.mtimeMs, url: await publicUrlForProjectFile(fullPath, Math.round(info.mtimeMs)) });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
}

function inferBatchFromOutputName(name) {
  const stem = parse(name).name;
  const timeBatch = stem.match(/^(\d{8}_\d{4,6}|\d{12,14})(?:_|$)/);
  if (timeBatch) return timeBatch[1];
  const markers = ["_heroIcon_", "_Icon_Head_", "_\u7ade\u54c1\u7d20\u6750"];
  const indexes = markers.map((marker) => stem.indexOf(marker)).filter((index) => index > 0);
  if (!indexes.length) return "ungrouped";
  return stem.slice(0, Math.min(...indexes));
}

async function competitorFolders() {
  const entries = await readdir(dirs().projectRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^竞品素材\d+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));
}

function validateCompetitorFolderName(name) {
  const folder = basename(String(name ?? "").trim());
  if (!/^竞品素材\d+$/.test(folder)) throw new Error("本地素材文件夹必须是 竞品素材+数字，例如 竞品素材4");
  return folder;
}

function competitorNamePath(folder) {
  return safeInsideProject(join(dirs().projectRoot, folder, "竞品名称.txt"));
}

async function readCompetitorDisplayName(folder) {
  const text = await readTextIfExists(competitorNamePath(folder), "");
  return text.trim() || folder;
}

async function writeCompetitorDisplayName(folder, displayName) {
  const name = String(displayName ?? "").trim();
  if (!name) throw new Error("请输入竞品名称，例如 Capybara Go!");
  await writeFile(competitorNamePath(folder), name, "utf8");
  return name;
}

async function loadCompetitorNameLibrary() {
  await mkdir(dirs().recordDir, { recursive: true });
  let names = [];
  if (existsSync(dirs().competitorNameLibraryPath)) {
    try {
      const data = JSON.parse(await readFile(dirs().competitorNameLibraryPath, "utf8"));
      names = Array.isArray(data.names) ? data.names : Array.isArray(data) ? data : [];
    } catch {
      names = [];
    }
  }
  const legacyFolders = await competitorFolders().catch(() => []);
  for (const folder of legacyFolders) {
    const displayName = await readCompetitorDisplayName(folder).catch(() => folder);
    if (displayName && displayName !== folder) names.push(displayName);
  }
  return [...new Set(names.map((name) => String(name).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));
}

async function saveCompetitorNameLibrary(names) {
  await mkdir(dirs().recordDir, { recursive: true });
  const clean = [...new Set((names ?? []).map((name) => String(name).trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-Hans-CN", { numeric: true }));
  await writeFile(dirs().competitorNameLibraryPath, JSON.stringify({ names: clean }, null, 2), "utf8");
  return clean;
}

async function createCompetitorFolder(body = {}) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot change competitor folders now");
  const displayName = String(body.displayName ?? body.name ?? "").trim();
  if (!displayName) throw new Error("请输入竞品名称，例如 Capybara Go!");
  const names = await loadCompetitorNameLibrary();
  if (!names.includes(displayName)) names.push(displayName);
  return { ok: true, displayName, names: await saveCompetitorNameLibrary(names) };
}

async function deleteCompetitorFolder(body = {}) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot change competitor folders now");
  const displayName = String(body.displayName ?? body.name ?? "").trim();
  if (!displayName) throw new Error("请先选择要删除的竞品名称");
  const names = (await loadCompetitorNameLibrary()).filter((name) => name !== displayName);
  return { ok: true, displayName, names: await saveCompetitorNameLibrary(names) };
}

async function updateCompetitorName(body = {}) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot change competitor folders now");
  const folder = validateCompetitorFolderName(body.folder);
  const target = safeInsideProject(join(dirs().projectRoot, folder));
  if (!existsSync(target)) throw new Error("竞品素材不存在");
  const displayName = await writeCompetitorDisplayName(folder, body.displayName ?? body.name);
  return { ok: true, name: folder, displayName, path: target };
}

async function readTextIfExists(path, fallback = "") {
  if (!existsSync(path)) return fallback;
  return readFile(path, "utf8");
}

function competitorSettingsPath(folder) {
  return safeInsideProject(join(dirs().projectRoot, folder, "设置.json"));
}

async function readCompetitorSettings(folder) {
  const fallback = { roleCount: 1, monsterCount: 0, useLogo: false, visualStyleMode: "2D" };
  const target = competitorSettingsPath(folder);
  if (!existsSync(target)) return fallback;
  try {
    const data = JSON.parse(await readFile(target, "utf8"));
    const visualStyleMode = String(data.visualStyleMode || data.styleMode || fallback.visualStyleMode).toUpperCase() === "3D" ? "3D" : "2D";
    return {
      roleCount: Math.max(0, Math.min(8, Number(data.roleCount ?? fallback.roleCount))),
      monsterCount: Math.max(0, Math.min(8, Number(data.monsterCount ?? fallback.monsterCount))),
      useLogo: Boolean(data.useLogo ?? fallback.useLogo),
      visualStyleMode
    };
  } catch {
    return fallback;
  }
}

async function saveCompetitorSettings(body = {}) {
  const folder = validateCompetitorFolderName(body.folder);
  const dir = safeInsideProject(join(dirs().projectRoot, folder));
  await mkdir(dir, { recursive: true });
  const existing = await readCompetitorSettings(folder);
  const roleCount = Math.max(0, Math.min(8, Number(body.roleCount ?? existing.roleCount)));
  const monsterCount = Math.max(0, Math.min(8, Number(body.monsterCount ?? existing.monsterCount)));
  const useLogo = Boolean(body.useLogo ?? existing.useLogo);
  const visualStyleMode = String(body.visualStyleMode ?? existing.visualStyleMode ?? "2D").toUpperCase() === "3D" ? "3D" : "2D";
  const specialRequirement = String(body.specialRequirement ?? body.text ?? "");
  const specialRequirementPath = safeInsideProject(join(dir, "\u7528\u6237\u7279\u6b8a\u8981\u6c42.txt"));
  await writeFile(specialRequirementPath, specialRequirement, "utf8");
  const jsonVideoPrompt = specialRequirementForVideoPrompt(specialRequirement);
  if (jsonVideoPrompt) {
    const videoPromptPath = safeInsideProject(join(dir, "视频反推提示词.txt"));
    await writeFile(videoPromptPath, jsonVideoPrompt, "utf8");
  }
  const settingsPath = competitorSettingsPath(folder);
  await writeFile(settingsPath, JSON.stringify({ roleCount, monsterCount, useLogo, visualStyleMode }, null, 2), "utf8");
  return { ok: true, folder, roleCount, monsterCount, useLogo, visualStyleMode, specialRequirementPath, settingsPath };
}

async function selectedOutputsForBatches(body = {}) {
  const batches = Array.isArray(body.batches) ? body.batches.map((item) => String(item)) : [];
  if (!batches.length) throw new Error("请先勾选至少一个结果批次");
  const outputs = await listOutputFiles(dirs().outputDir);
  const batchSet = new Set(batches);
  const selected = outputs.filter((output) => batchSet.has(output.batch || "未分组"));
  if (!selected.length) throw new Error("当前勾选批次中没有可下载的图片或视频");
  return selected;
}

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ -1) >>> 0;
}

function dosDateTime(date = new Date()) {
  const year = Math.max(1980, date.getFullYear());
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function safeZipName(name) {
  return String(name || "file").replace(/[\\/:*?"<>|]/g, "_");
}

async function buildOutputsZip(outputs) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const output of outputs) {
    const source = safeInsideProject(output.path);
    const data = await readFile(source);
    const nameBuffer = Buffer.from(`${safeZipName(output.batch || "未分组")}/${safeZipName(output.name)}`, "utf8");
    const checksum = crc32(data);
    const { time, day } = dosDateTime(new Date(output.mtimeMs || Date.now()));

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
  end.writeUInt16LE(outputs.length, 8);
  end.writeUInt16LE(outputs.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

async function sendOutputsZip(res, body = {}) {
  const selected = await selectedOutputsForBatches(body);
  const zip = await buildOutputsZip(selected);
  const stamp = new Date().toISOString().slice(0, 16).replace(/\D/g, "");
  const filename = `ad-results-${stamp}.zip`;
  res.writeHead(200, {
    "Content-Type": "application/zip",
    "Content-Length": zip.length,
    "Content-Disposition": `attachment; filename="${filename}"`
  });
  res.end(zip);
}

async function loadMaterials() {
  await ensureProjectStructure(dirs().projectRoot);
  await ensureProjectStructure(dirs().sharedProjectRoot);
  await mkdir(dirs().outputDir, { recursive: true });
  await mkdir(dirs().recordDir, { recursive: true });
  await mkdir(dirs().upscaledDir, { recursive: true });
  await mkdir(dirs().roleDir, { recursive: true });
  await mkdir(dirs().monsterDir, { recursive: true });
  await mkdir(dirs().sceneDir, { recursive: true });
  await mkdir(dirs().referenceVideoDir, { recursive: true });
  await mkdir(dirs().logoDir, { recursive: true });
  const roleFiles = await listImageFiles(dirs().roleDir);
  const roles = roleFiles.map((file) => ({
    ...file,
    sourcePath: existsSync(join(dirs().upscaledDir, file.name)) ? join(dirs().upscaledDir, file.name) : file.path,
    ...(ROLE_META[file.name] ?? inferRoleMeta(file.name))
  }));
  const monsterFiles = await listImageFiles(dirs().monsterDir);
  const monsters = monsterFiles.map((file) => ({
    ...file,
    sourcePath: file.path,
    title: parse(file.name).name,
    traits: `the user-owned monster or creature from ${file.name}, preserving its exact silhouette, face, colors, body shape, horns, wings, tail, armor, and props`
  }));
  const logoFiles = await listImageFiles(dirs().logoDir);
  const logos = logoFiles.map((file) => ({
    ...file,
    sourcePath: file.path,
    title: parse(file.name).name,
    traits: `the user-owned product logo from ${file.name}, preserving its exact readable logo mark, lettering, colors, proportions, and transparent/clean edges`
  }));
  const sceneFiles = await listImageFiles(dirs().sceneDir);
  const scenes = sceneFiles.map((file) => ({
    ...file,
    sourcePath: file.path,
    title: parse(file.name).name,
    traits: `the user-owned scene or background reference from ${file.name}, preserving its environment type, camera angle, lighting, color mood, depth, and key layout zones`
  }));
  const referenceVideos = (await listVideoFiles(dirs().referenceVideoDir)).map((file) => ({
    ...file,
    title: parse(file.name).name,
    traits: `the user-owned reference video ${file.name}, used only for storyboard timing, shot rhythm, camera movement, action pacing, and transition reference`
  }));
  const globalRequirement = await ensureGlobalRequirementLogoRule(await readTextIfExists(dirs().globalRequirementPath, defaultGlobalRequirement()));

  const folders = (await competitorFolders()).filter((folder) => /^竞品素材[1-3]$/.test(folder));
  const competitorNames = await loadCompetitorNameLibrary();
  const competitors = [];
  for (const folder of folders) {
    const dir = join(dirs().projectRoot, folder);
    const images = await listImageFiles(dir);
    const videos = await listVideoFiles(dir);
    const firstDimensions = images[0] ? await readImageDimensions(images[0].path).catch(() => null) : null;
    const layout = firstDimensions ? layoutFromDimensions(firstDimensions) : videos.length ? layoutFromDimensions({ width: 720, height: 1280 }) : layoutFromDimensions();
    const specialRequirementPath = join(dir, "\u7528\u6237\u7279\u6b8a\u8981\u6c42.txt");
    const specialRequirement = await readTextIfExists(specialRequirementPath, "");
    const settings = await readCompetitorSettings(folder);
    const defaultOutputSize = layout.size || DEFAULT_OUTPUT_SIZE;
    const imageSize = defaultOutputSize;
    const videoSize = defaultOutputSize;
    const outputSize = imageSize;
    const referenceVideoPath = videos[0]?.path || "";
    const referenceVideoDuration = referenceVideoPath ? await readVideoDurationSeconds(referenceVideoPath) : 0;
    const videoPromptPath = join(dir, "视频反推提示词.txt");
    const videoPrompt = await readTextIfExists(videoPromptPath, "");
    const imagePromptPath = join(dir, "图片反推提示词.txt");
    const imagePrompt = await readTextIfExists(imagePromptPath, "");
    const displayName = await readCompetitorDisplayName(folder);
    competitors.push({ name: folder, displayName, path: dir, images, videos, layout, defaultOutputSize, imageSize, videoSize, outputSize, referenceVideoPath, referenceVideoDuration, roleCount: settings.roleCount, monsterCount: settings.monsterCount, useLogo: settings.useLogo, visualStyleMode: settings.visualStyleMode || "2D", specialRequirement, specialRequirementPath, imagePrompt, imagePromptPath, videoPrompt, videoPromptPath });
  }

  const outputs = await listOutputFiles(dirs().outputDir);
  return { projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), userId: currentUserId(), projects: projectList(), model: MODEL, globalRequirement, roles, monsters, logos, scenes, referenceVideos, competitors, competitorNames, outputs: outputs.reverse(), runState: getRunState() };
}

function inferRoleMeta(fileName) {
  const name = parse(fileName).name;
  return {
    title: name,
    traits: `the user-owned chibi game character from ${fileName}, preserving its exact silhouette, face, colors, outfit, weapon, and props`,
    theme: "signature character effects",
    className: "Hero"
  };
}

function requirementBlock(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return "";
  return `\nAdditional layout and style notes, rewritten as safe all-ages advertising guidance. Use these notes only for abstract composition, functional layout relationships, UI placement, readable typography, emotional acting, scene mood, prop roles, and user-owned character identity preservation. If these notes ask to preserve a concrete competitor scene, background, prop, logo, mascot, color block, or decorative detail, reinterpret that as preserving only the functional role while redesigning the visual element in the selected user-owned asset's style and lore. Do not introduce action-game, tower-defense, combat, enemy, boss, attack, weapon, skill, HP, or damage elements unless they are clearly visible in the current competitor reference or explicitly requested by the user.\n${sanitizeRequirementText(trimmed)}\n`;
}

function layoutFromDimensions(dimensions = null) {
  const width = dimensions?.width ?? 0;
  const height = dimensions?.height ?? 0;
  const ratio = width && height ? width / height : 1;
  if (ratio > 1.15) {
    return { width, height, orientation: "wide", label: "横版", size: "1536x1024", promptSize: "Wide horizontal 1536x1024" };
  }
  if (ratio < 0.87) {
    return { width, height, orientation: "tall", label: "竖版", size: "1024x1536", promptSize: "Tall vertical 1024x1536" };
  }
  return { width, height, orientation: "square", label: "方图", size: "1024x1024", promptSize: "Square 1024x1024" };
}

function normalizeOutputSize(value = "") {
  const match = String(value ?? "").trim().toLowerCase().match(/^(\d{3,4})\s*[x×*]\s*(\d{3,4})$/);
  if (!match) return "";
  const width = Math.max(256, Math.min(4096, Number(match[1])));
  const height = Math.max(256, Math.min(4096, Number(match[2])));
  return `${width}x${height}`;
}

function normalizeStoredOutputSize(value = "") {
  const normalized = normalizeOutputSize(value);
  return normalized === "720x1280" ? DEFAULT_OUTPUT_SIZE : (normalized || DEFAULT_OUTPUT_SIZE);
}

function layoutWithOutputSize(layout, outputSize = "") {
  const normalized = normalizeOutputSize(outputSize);
  if (!normalized) return layout ?? layoutFromDimensions();
  const [width, height] = normalized.split("x").map(Number);
  const base = layoutFromDimensions({ width, height });
  return {
    ...base,
    width,
    height,
    size: normalized,
    promptSize: `Custom ${normalized}`,
    label: `${base.label} ${normalized}`
  };
}

function imageSizeForModel(outputSize = "", imageModel = MODEL) {
  const normalized = normalizeOutputSize(outputSize) || DEFAULT_OUTPUT_SIZE;
  const [width, height] = normalized.split("x").map(Number);
  const tall = height > width * 1.08;
  const wide = width > height * 1.08;
  if (String(imageModel || "") === "doubao-seedream-5-0-260128") {
    if (tall) return "1440x2560";
    if (wide) return "2560x1440";
    return "1920x1920";
  }
  if (tall) return "1024x1536";
  if (wide) return "1536x1024";
  return "1024x1024";
}

function ratioFromOutputSize(outputSize = "") {
  const normalized = normalizeOutputSize(outputSize);
  const [width, height] = normalized.split("x").map(Number);
  if (!width || !height) return "9:16";
  const ratio = width / height;
  const choices = [
    ["21:9", 21 / 9],
    ["16:9", 16 / 9],
    ["4:3", 4 / 3],
    ["1:1", 1],
    ["3:4", 3 / 4],
    ["9:16", 9 / 16]
  ];
  return choices.reduce((best, item) => Math.abs(item[1] - ratio) < Math.abs(best[1] - ratio) ? item : best, choices[0])[0];
}

function videoSizeInstruction(outputSize = "") {
  const normalized = normalizeOutputSize(outputSize);
  const ratio = ratioFromOutputSize(normalized);
  return `目标视频尺寸：${normalized}，画幅比例按 ${ratio} 构图。`;
}

async function readVideoDurationSeconds(videoPath = "") {
  if (!videoPath || !existsSync(videoPath)) return 0;
  try {
    const ffprobe = toolPath("ffprobe");
    const { stdout } = await execTool(ffprobe, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath
    ]);
    const seconds = Number.parseFloat(String(stdout || "").trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  } catch (error) {
    addLog("warn", `VIDEO_DURATION_READ_FAILED ${basename(videoPath)} ${summarizeErrorText(`${error.stderr ?? ""}\n${error.message ?? ""}`)}`);
    return 0;
  }
}

async function readVideoMetadata(videoPath = "") {
  if (!videoPath || !existsSync(videoPath)) return null;
  try {
    const ffprobe = toolPath("ffprobe");
    const { stdout } = await execTool(ffprobe, [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height,duration",
      "-of", "json",
      videoPath
    ]);
    const stream = JSON.parse(stdout || "{}")?.streams?.[0] || {};
    const width = Number(stream.width) || 0;
    const height = Number(stream.height) || 0;
    const duration = Number.parseFloat(stream.duration || "0") || 0;
    return width && height ? { width, height, duration, pixelCount: width * height } : null;
  } catch (error) {
    addLog("warn", `VIDEO_METADATA_READ_FAILED ${basename(videoPath)} ${summarizeErrorText(`${error.stderr ?? ""}\n${error.message ?? ""}`)}`);
    return null;
  }
}

function isSeedanceCompatibleVideo(metadata) {
  return Boolean(metadata?.width && metadata?.height && metadata.pixelCount >= 409600 && (!metadata.duration || (metadata.duration >= 1.8 && metadata.duration <= 15.2)));
}

function isVideoCodecCompatible(metadata) {
  return Boolean(metadata?.width && metadata?.height);
}

async function seedanceSafeVideoReference(videoPath = "", workDir = dirs().recordDir) {
  if (!videoPath || !existsSync(videoPath)) return "";
  const metadata = await readVideoMetadata(videoPath);
  if (isSeedanceCompatibleVideo(metadata) && existsSync(videoPath)) return videoPath;
  await mkdir(workDir, { recursive: true });
  const target = join(workDir, `${parse(videoPath).name}_seedance_ref_1024.mp4`);
  const ffmpeg = toolPath("ffmpeg");
  const sourceWidth = metadata?.width || 576;
  const sourceHeight = metadata?.height || 1024;
  const scale = sourceWidth >= sourceHeight ? Math.max(1, 1024 / sourceWidth) : Math.max(1, 1024 / sourceHeight);
  const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2);
  const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2);
  await execTool(ffmpeg, [
    "-y",
    "-i", videoPath,
    ...(metadata?.duration && metadata.duration > 15.2 ? ["-t", "15"] : []),
    "-vf", `scale=${width}:${height}`,
    "-c:v", "libx264",
    "-pix_fmt", "yuv420p",
    "-preset", "veryfast",
    "-crf", "20",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    target
  ]);
  const nextMetadata = await readVideoMetadata(target);
  addLog("video-ref-normalized", `REFERENCE_VIDEO_NORMALIZED ${basename(videoPath)} ${metadata?.width || "?"}x${metadata?.height || "?"} ${metadata?.duration ? `${metadata.duration.toFixed(1)}s` : "?s"} -> ${nextMetadata?.width || "?"}x${nextMetadata?.height || "?"} ${nextMetadata?.duration ? `${nextMetadata.duration.toFixed(1)}s` : "?s"}`, { source: videoPath, output: target });
  return target;
}

function normalizeSeedanceDuration(seconds = 15) {
  const rounded = Math.round(Number(seconds) || 15);
  return Math.max(4, Math.min(15, rounded));
}

function seedanceSegmentDurations(totalSeconds = 15) {
  const total = Math.max(4, Math.round(Number(totalSeconds) || 15));
  if (total <= 15) return [normalizeSeedanceDuration(total)];
  const segments = [];
  let remaining = total;
  while (remaining > 0) {
    if (remaining <= 15) {
      segments.push(normalizeSeedanceDuration(remaining));
      break;
    }
    if (remaining < 19) {
      const first = Math.ceil(remaining / 2);
      segments.push(normalizeSeedanceDuration(first));
      remaining -= first;
    } else {
      segments.push(15);
      remaining -= 15;
    }
  }
  return segments;
}

async function concatVideos(segmentPaths, outputPath) {
  if (segmentPaths.length === 1) {
    await copyFile(segmentPaths[0], outputPath);
    return;
  }
  const ffmpeg = toolPath("ffmpeg");
  if (!existsSync(ffmpeg) && ffmpeg !== "ffmpeg") throw new Error("未找到 ffmpeg，无法拼接超过 15 秒的分段视频");
  const listPath = join(dirname(outputPath), `${parse(outputPath).name}_concat.txt`);
  const content = segmentPaths.map((item) => `file '${String(item).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n");
  await writeFile(listPath, content, "utf8");
  await execTool(ffmpeg, ["-y", "-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outputPath], { cwd: dirname(outputPath) });
}

function resolveVideoModel(value = "") {
  return VIDEO_MODEL_OPTIONS[String(value || "").trim()] || VIDEO_MODEL_OPTIONS["dreamina-seedance-2-0-mini"];
}

function layoutLockBlock(competitor) {
  const layout = competitor.layout ?? layoutFromDimensions();
  return `\nReference layout lock: the output must keep the current competitor reference's ${layout.label} aspect ratio, camera zoom, full viewport, and major layout map. Preserve the relative positions and approximate size hierarchy of visible logo/title area, main subject group, secondary characters or creatures, foreground props, background depth, and bottom text/banner area when those elements are present. Do not crop in, zoom in, enlarge the board, enlarge tiles, enlarge units, or simplify the screen into a close-up. If the reference is square, do not expand into a wide banner; keep a square poster composition. If multiple user assets are selected, arrange them inside the same layout zones and original footprints instead of inventing a new team-lineup scene.\n`;
}

function videoReferenceBlock(competitor) {
  if (!competitor.videos?.length && !competitor.videoPrompt) return "";
  if (competitor.referenceVideoPath || competitor.videos?.length) {
    const actionLine = isCombatReference(competitor)
      ? "If and only if the current uploaded reference video visibly contains gameplay or battle, preserve its abstract gameplay layout and camera rhythm."
      : "The current uploaded reference video should be treated as a direct storyboard and pacing reference, not as text keywords. Preserve only its shot rhythm, subject placement, emotional beats, camera distance, prop interaction, product/logo placement, editing cadence, and ending hold.";
    return `\nVideo reference guidance: ${actionLine} Do not infer or add battle, enemy, monster wave, attack, weapon, skill release, upgrade card, HP bar, damage number, tower-defense lane, or victory battle settlement unless these elements are clearly visible in the current uploaded reference video. Do not copy competitor characters, logos, exact UI text, brand names, proprietary scene skins, props, building shapes, decorations, or concrete visual details.\n`;
  }
  const actionLine = isCombatReference(competitor)
    ? "When the current reference is clearly gameplay/battle, preserve its gameplay layout, camera angle, unit direction, UI rhythm, upgrade timing, attack causality, and ad pacing."
    : "When the current reference is not clearly gameplay/battle, preserve its non-combat creative structure: scene type, camera rhythm, emotional beats, character interaction, props, product/logo placement, editing cadence, and ad pacing. Do not introduce battles, enemies, monsters, weapons, towers, attack effects, upgrade cards, HP bars, or combat UI unless they are visibly present in the current reference.";
  const jsonVideoPrompt = specialRequirementForVideoPrompt(competitor.specialRequirement);
  const mergedVideoPrompt = [jsonVideoPrompt, competitor.videoPrompt].filter(Boolean).join("\n");
  return `\nVideo reference guidance: first reverse-infer the competitor video structure, then use that structure to create the codex-gpt-image-2 setup frame. ${actionLine} Do not copy competitor characters, logos, exact UI text, brand names, proprietary scene skins, props, building shapes, decorations, or concrete visual details.\n${sanitizeRequirementText(mergedVideoPrompt).slice(0, 1800)}\n`;
}

function isCombatReference(competitor = {}) {
  const reverseJson = parseSpecialRequirementJson(competitor.specialRequirement);
  if (reverseJson && typeof reverseJson.reverse_analysis?.is_combat_reference === "boolean") {
    return reverseJson.reverse_analysis.is_combat_reference;
  }
  if (competitor.videos?.length) {
    const videoText = `${specialRequirementForImagePrompt(competitor.specialRequirement)}\n${competitor.requirement || ""}`;
    return /tower[-\s]?defense|combat|battle|fight|hp\s?bar|damage|enemy\s+(wave|spawn|attack)|monster\s+(wave|spawn|attack)|boss\s+(fight|battle)|塔防|战斗|血条|伤害|防线|敌人进攻|怪物进攻|怪潮|波次|首领战|Boss战/i.test(videoText);
  }
  const text = competitor.videos?.length
    ? `${specialRequirementForImagePrompt(competitor.specialRequirement)}\n${competitor.requirement || ""}`
    : `${specialRequirementForImagePrompt(competitor.specialRequirement)}\n${competitor.videoPrompt || ""}\n${competitor.requirement || ""}`;
  return /tower[-\s]?defense|battle|attack|weapon|skill|hp\s?bar|damage|combat|fight|raid|pvp|enemy\s+(wave|spawn|attack)|monster\s+(wave|spawn|attack)|boss\s+(fight|battle)|塔防|战斗|攻击|技能|升级|血条|伤害|防线|敌人进攻|怪物进攻|怪潮|波次|首领战|Boss战/i.test(text);
}

function seedanceReferencePromptText(competitor = {}, combat = false) {
  const jsonVideoPrompt = specialRequirementForVideoPrompt(competitor.specialRequirement);
  if (jsonVideoPrompt) return [jsonVideoPrompt, competitor.videoPrompt].filter(Boolean).join("\n");
  if (combat) return competitor.videoPrompt || "";
  return sanitizeNonCombatVideoPrompt([competitor.videoPrompt, specialRequirementForImagePrompt(competitor.specialRequirement)].filter(Boolean).join("\n"));
}

function sanitizeNonCombatVideoPrompt(text = "") {
  return sanitizeRequirementText(text)
    .replaceAll("怪物", "互动对象")
    .replaceAll("攻击因果", "动作反馈关系")
    .replaceAll("攻击反馈", "动作反馈")
    .replaceAll("攻击", "动作")
    .replaceAll("升级", "节奏推进")
    .replaceAll("塔防", "广告场景")
    .replaceAll("战斗", "广告演绎")
    .replaceAll("敌人", "挑战对象")
    .replaceAll("波次", "节奏段落")
    .replaceAll("血条", "状态信息")
    .replaceAll("伤害", "反馈效果")
    .replaceAll("武器", "道具")
    .replaceAll("技能", "特效动作")
    .replace(/\b(monsters?|enemies|attack|battle|combat|tower[-\s]?defense|hp bar|damage|weapon|skill|upgrade)\b/gi, "creative beat");
}

function referenceTypeGuardBlock(competitor = {}) {
  if (isCombatReference(competitor)) return "";
  return `\nReference type guard: the current reference is not clearly a battle, tower-defense, RPG stats, skill showcase, weapon showcase, or enemy-wave ad. Preserve the actual reference category and mood, such as lifestyle, comedy, tea-drinking, pet, creature, cooking, decoration, merge, puzzle, social, casual, management, dress-up, product/logo display, or story scene. Do not introduce combat, enemies, monster waves, towers, attacks, weapons, skill icons, HP bars, damage numbers, upgrade cards, A/S/SS rarity cards, battlefield lanes, or victory battle settlement unless the current reference visibly contains them or the user explicitly asks for them.\n`;
}

function gameplayLayoutLockBlock(competitor) {
  if (!isCombatReference(competitor)) return "";
  return `\nGameplay layout lock: this is an in-game tower-defense/battle reference, not a character poster. Preserve the actual gameplay map and unit positions from the current reference frame. If the reference has the allied hero or defense line in the lower part of the screen and monsters entering from the upper path, keep exactly that vertical relationship: player hero/defense stays in the lower lane or bottom placement cell, monsters stay above or enter from the top path, attacks travel from lower hero/defense toward upper monsters. If the reference has grid cells, lane tiles, placement squares, card slots, or a board path, every playable hero and monster must stay inside the corresponding original cell/lane/path footprint; do not place units outside the grid or overlap UI. The uploaded hero must replace the original capybara/player unit at the exact same tile center, same lane, same board side, and same screen-depth layer; do not move it to an adjacent tile, empty card slot, path edge, or decorative ground. Keep the bottom card slots, HP bar, currency, upgrade/summon button area, left-side control icons, top wave/title area, and right-side target portrait as layout zones when visible, but redesign their concrete skin into original generic UI. Never change this into a left-versus-right duel, hero showcase, poster composition, treasure scene, pirate scene, or side-by-side hero-monster lineup.\n`;
}

function unitScaleLockBlock(competitor) {
  if (!isCombatReference(competitor)) return "";
  return `\nUnit scale and replacement lock: match the current reference's gameplay unit scale exactly. The uploaded hero image is an identity reference only, not a foreground illustration. Replace the original allied hero/capybara/player unit with the uploaded hero; remove the original competitor unit completely. Replace original competitor monsters only with selected user-owned monsters when monster assets are provided; otherwise use generic original creatures that do not copy the competitor. Do not add the uploaded hero alongside the original capybara/hero; there must be no duplicate old unit plus new unit. In a vertical in-game battle frame, render the hero as a small playable unit inside the exact original tile footprint, roughly the same on-screen size as the original allied hero in the reference, about 4-8% of image height unless the reference clearly shows a larger unit. Render monsters at the same relative size as the reference monsters and keep them inside the same lane/path cells. Preserve the number of visible tiles, board density, empty-road space, UI margins, and camera distance from the reference. Do not enlarge the hero to poster scale, do not let the hero occupy the center foreground, do not enlarge the battlefield, do not cover the road, UI slots, HP bar, or monster path, and do not make the monster a huge side-by-side character unless the current reference does so.\n`;
}

function logoInstructionBlock(logos = []) {
  if (!logos.length) return "";
  const logoLines = logos.map((logo, index) => `Logo ${index + 1}: ${logo.traits}.`).join("\n");
  return `\nProduct logo replacement: use the provided user-owned product logo reference(s) below. If the competitor reference contains a game logo, replace that logo with the uploaded product logo while preserving the same functional logo area, readability, scale, and hierarchy. If the competitor reference does not contain a visible game logo, add the uploaded product logo in a tasteful mobile-ad corner, header, end-card, or title-safe area without covering important characters, UI, or gameplay. Never include the competitor logo, brand name, or copied logo styling.\n${logoLines}\n`;
}

function specialRequirementBlock(text) {
  const trimmed = specialRequirementForImagePrompt(text).trim();
  if (!trimmed) return "";
  return `\nUser special request. Follow this exactly when it is about replacing visible text, changing labels, removing marks, composition details, color, character count, or asset placement. The request may be written in Chinese; interpret it as an instruction for the generated advertising image, while still avoiding competitor IP copying and unsafe content.\n${trimmed.slice(0, 1000)}\n`;
}

function originalityBlock() {
  return `\nOriginality and reskin rule: do not copy the competitor scene verbatim. Keep only abstract layout relationships and ad mechanics from the current competitor reference image, such as logo area, foreground prop role, character position, phone-frame role, action direction, dramatic background role, or text hierarchy. Redesign the concrete background, props, logo area, silhouettes, decorative shapes, color blocks, and environmental details into original elements that match the selected user-owned character's world, costume, powers, companion, and visual style. The final image should feel like the user's own game ad using a similar layout logic, not the competitor scene with only the character swapped.\n`;
}

function noCrossReferenceBlock() {
  return `\nNo cross-reference contamination: use only the currently selected competitor reference image for pose, scene elements, emotional acting, props, UI frame, and background logic. Do not borrow any specific pose, prop, background, hazard, framing device, or character state from other competitor folders, previous references, or previous generations. Only include a specific visual element when it is visibly present in the current reference or explicitly requested by the user.\n`;
}

function visualStyleModeBlock(mode = "2D") {
  return String(mode || "2D").toUpperCase() === "3D"
    ? "\nVisual style mode: 3D. Render the ad as polished 3D game CG / stylized 3D animation, with dimensional characters, volumetric lighting, physically plausible materials, depth, soft shadows, and cinematic camera feel. Keep the competitor reference's layout and ad rhythm, but convert all user-owned characters, props, UI, and scene elements into a consistent original 3D game style.\n"
    : "\nVisual style mode: 2D. Render the ad as crisp 2D mobile game illustration / cartoon ad art, with clean shapes, expressive linework, flat-to-soft shaded color, readable UI, and no photorealistic 3D render look. Keep the competitor reference's layout and ad rhythm, but convert all user-owned characters, props, UI, and scene elements into a consistent original 2D game art style.\n";
}

function visualStyleFinalRule(mode = "2D") {
  return String(mode || "2D").toUpperCase() === "3D"
    ? "Keep the image all-ages and promotional while preserving the reference mood. Do not include competitor logo, copied text unless specifically requested as replacement text, copied character, watermark, gore, injury, horror, or proprietary UI. Use polished stylized 3D game CG: modeled dimensional forms, readable silhouettes, material response, soft shadows, depth, cinematic lighting, and clean advertising composition. Do not render as flat 2D line art, thick-outline cartoon illustration, sticker art, or hand-drawn poster style."
    : "Keep the image all-ages and promotional while preserving the reference mood. Do not include competitor logo, copied text unless specifically requested as replacement text, copied character, watermark, gore, injury, horror, or proprietary UI. Use crisp 2D mobile game cartoon advertising art: clean shapes, expressive linework, smooth gradients, readable bold text when needed, no grain, no photorealism.";
}

function videoVisualStyleRule(mode = "2D") {
  return String(mode || "2D").toUpperCase() === "3D"
    ? "视觉风格规则：必须保持风格化3D游戏CG/国漫动画质感，角色和场景有清晰立体体积、材质反光、空间阴影、景深和电影光影；不要做成平面2D线稿、厚描边卡通插画、贴纸感或手绘海报。不要写实真人，但必须是3D动画/游戏CG。"
    : "视觉风格规则：必须保持2D移动游戏广告插画/卡通动画质感，线条干净、色块清晰、表情夸张；不要做成写实3D渲染。";
}

function sanitizeRequirementText(text) {
  return String(text)
    .replaceAll("战斗", "能力展示")
    .replaceAll("战力", "能力值")
    .replaceAll("攻击", "活力")
    .replaceAll("伤害", "特效")
    .replaceAll("弱化", "初始")
    .replaceAll("敌人", "挑战元素")
    .replaceAll("Boss", "large background emblem")
    .replaceAll("boss", "large background emblem")
    .replaceAll("武器", "标志性道具")
    .replaceAll("血", "生命值")
    .replaceAll("杀", "展示")
    .slice(0, 1600);
}

function singleRolePrompt(role, competitor, logos = []) {
  const sizeText = (competitor.layout ?? layoutFromDimensions()).promptSize;

  return `${sizeText} mobile game advertising picture, fully original. Use the provided user-owned character as identity reference and the competitor image only as composition reference.

First analyze the competitor reference image directly. Recreate its advertising idea, mood, camera angle, subject scale, background rhythm, prop placement, UI/text hierarchy, and pacing, but replace every competitor-owned character or mascot with this selected user-owned character: ${role.traits}.
${layoutLockBlock(competitor)}
${videoReferenceBlock(competitor)}
${gameplayLayoutLockBlock(competitor)}
${unitScaleLockBlock(competitor)}
${logoInstructionBlock(logos)}
${referenceTypeGuardBlock(competitor)}

If the competitor reference is a calm lifestyle, comedy, tea-drinking, meme, pet, creature, social, or cute scene, preserve that scene type and mood. Do not force RPG stats, battle attributes, skill icons, weapon showcase, combat UI, progress bars, or hero-unlocked layouts unless those elements are clearly present in the competitor reference image.
${originalityBlock()}
${noCrossReferenceBlock()}
${visualStyleModeBlock(competitor.visualStyleMode)}

Expression and acting lock: match the current reference character's emotional performance as closely as possible. Preserve scared, worried, crying, shocked, embarrassed, calm, smug, happy, or tired expressions when present. Copy only visible emotional signals from the current reference, such as eye shape, eyebrow angle, tears, sweat drops, blush, open mouth shape, clenched mouth, head tilt, shoulder posture, and body pose. Do not invent extra character states or danger elements that are not visible in the current reference.

Place the user-owned character naturally into the same kind of scene shown by the reference. Preserve the character identity exactly: ${role.traits}. Use readable short text only when the reference has text or the user special request asks for text replacement.
${requirementBlock(competitor.requirement)}
${specialRequirementBlock(competitor.specialRequirement)}
${visualStyleFinalRule(competitor.visualStyleMode)}`;
}

function trioPrompt(roles, competitor, groupName) {
  const sizeText = (competitor.layout ?? layoutFromDimensions()).promptSize;
  return `${sizeText} mobile game team banner, fully original. Use the three provided user-owned character images as identity references and the competitor image only as layout reference.

Composition: analyze the competitor reference for scene type, mood, emotional acting, spacing, camera angle, background rhythm, prop placement, and text hierarchy. Place three heroes according to the reference composition. Left hero: ${roles[0].traits}. Center hero: ${roles[1].traits}. Right hero: ${roles[2].traits}. Preserve all three identities clearly and do not merge them. Group mood: ${groupName}.
${layoutLockBlock(competitor)}
${videoReferenceBlock(competitor)}
${gameplayLayoutLockBlock(competitor)}
${unitScaleLockBlock(competitor)}
${referenceTypeGuardBlock(competitor)}
${originalityBlock()}
${noCrossReferenceBlock()}
${visualStyleModeBlock(competitor.visualStyleMode)}

Expression and acting lock: match the current reference character's emotional performance as closely as possible, including scared, crying, shocked, calm, happy, or smug expressions. Preserve only visible emotional signals from the current reference, such as eye shape, eyebrow angle, tears, sweat drops, mouth shape, head tilt, and body pose. Do not invent extra character states or danger elements that are not visible in the current reference.
${requirementBlock(competitor.requirement)}
${specialRequirementBlock(competitor.specialRequirement)}
${visualStyleFinalRule(competitor.visualStyleMode)}`;
}

function repeatSuffix(index, repeatCount) {
  return repeatCount > 1 ? `_第${index}次` : "";
}

function buildJobs({ roles, monsters, logos = [], competitors, selectedRoleNames, selectedMonsterNames, selectedLogoNames = [], selectedCompetitorNames, competitorSettings, globalRequirement, batchTag, outputMode = "image", repeatCount = 1, imageModel = MODEL, videoModel = "dreamina-seedance-2-0-mini" }) {
  const chosenRoles = roles.filter((role) => selectedRoleNames.includes(role.name));
  const chosenMonsters = monsters.filter((monster) => selectedMonsterNames.includes(monster.name));
  const chosenLogos = logos.filter((logo) => selectedLogoNames.includes(logo.name));
  const chosenCompetitors = competitors.filter((item) => selectedCompetitorNames.includes(item.name));
  const repeats = Math.max(1, Math.min(50, Number(repeatCount || 1)));
  const resolvedImageModel = resolveImageModel(imageModel);
  const resolvedVideoModel = resolveVideoModel(videoModel);
  const jobs = [];

  for (const competitor of chosenCompetitors) {
    const setting = competitorSettings?.[competitor.name] ?? {};
    const roleCount = Math.max(0, Math.min(8, Number(setting.roleCount ?? 1)));
    const monsterCount = Math.max(0, Math.min(8, Number(setting.monsterCount ?? 0)));
    const useLogo = Boolean(setting.useLogo);
    const visualStyleMode = String(setting.visualStyleMode ?? competitor.visualStyleMode ?? "2D").toUpperCase() === "3D" ? "3D" : "2D";
    const requestedImageSize = normalizeOutputSize(competitor.imageSize ?? competitor.outputSize ?? competitor.layout?.size ?? DEFAULT_OUTPUT_SIZE);
    const imageSize = imageSizeForModel(requestedImageSize, resolvedImageModel.model);
    const videoSize = normalizeOutputSize(competitor.videoSize ?? requestedImageSize ?? imageSize);
    const jobLogos = useLogo ? chosenLogos : [];
    if (useLogo && !jobLogos.length) {
      addLog("warn", `${competitor.name} requires logo but no logo selected`, { competitor: competitor.name });
      continue;
    }
    const promptCompetitor = { ...competitor, layout: layoutWithOutputSize(competitor.layout, imageSize), imageSize, videoSize, outputSize: imageSize, visualStyleMode, requirement: [globalRequirement, competitor.imagePrompt].filter(Boolean).join("\n"), specialRequirement: setting.specialRequirement ?? "", videoPrompt: competitor.videoPrompt ?? "", videos: competitor.videos ?? [] };
    const requiresCombo = roleCount !== 1 || monsterCount > 0;

    if (requiresCombo) {
      if (roleCount > 0 && !chosenRoles.length) {
        addLog("warn", `${competitor.name} requires roles but no roles selected`, { competitor: competitor.name });
        continue;
      }
      if (monsterCount > 0 && !chosenMonsters.length) {
        addLog("warn", `${competitor.name} requires monsters but no monsters selected`, { competitor: competitor.name });
        continue;
      }
      const roleGroups = roleCount > 0 ? Math.ceil(chosenRoles.length / roleCount) : 0;
      const monsterGroups = monsterCount > 0 ? Math.ceil(chosenMonsters.length / monsterCount) : 0;
      const groupCount = Math.max(1, roleGroups, monsterGroups);
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex++) {
        for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
          const groupRoles = cyclePick(chosenRoles, groupIndex * Math.max(1, roleCount), roleCount);
          const groupMonsters = cyclePick(chosenMonsters, groupIndex * Math.max(1, monsterCount), monsterCount);
          const baseGroupName = `组合_${roleCount}角色_${monsterCount}怪物_${groupIndex + 1}`;
          const groupName = `${baseGroupName}${repeatSuffix(repeatIndex, repeats)}`;
          const ref = competitor.images[0]?.path;
          jobs.push({
            id: `${competitor.name}_${groupName}`,
            name: `${competitor.name}_${groupName}`,
            outputMode,
            imageModel: resolvedImageModel.model,
            imageModelLabel: resolvedImageModel.label,
            videoModel: resolvedVideoModel.model,
            videoModelLabel: resolvedVideoModel.label,
            size: (promptCompetitor.layout ?? layoutFromDimensions()).size,
            videoSize,
            referenceVideoPath: competitor.referenceVideoPath || "",
            referenceVideoDuration: competitor.referenceVideoDuration || 0,
            prompt: comboPrompt({ roles: groupRoles, monsters: groupMonsters, logos: jobLogos, competitor: promptCompetitor, groupName }),
            videoPrompt: seedanceAdVideoPrompt({ roles: groupRoles, monsters: groupMonsters, competitor: promptCompetitor, groupName }),
            images: [...groupRoles.map((role) => role.sourcePath), ...groupMonsters.map((monster) => monster.sourcePath), ...jobLogos.map((logo) => logo.sourcePath), ref].filter(Boolean),
            output: join(dirs().outputDir, `${batchTag}_${competitor.name}_${groupName}.png`),
            videoOutput: join(dirs().outputDir, `${batchTag}_${competitor.name}_${groupName}.mp4`)
          });
        }
      }
      continue;
    }

    for (const role of chosenRoles) {
      for (let repeatIndex = 1; repeatIndex <= repeats; repeatIndex++) {
        const ref = competitor.images[0]?.path;
        const layout = promptCompetitor.layout ?? layoutFromDimensions();
        const baseTypeName = layout.orientation === "wide" ? "参考图横版" : layout.orientation === "tall" ? "参考图竖版" : "参考图构图";
        const typeName = `${baseTypeName}${repeatSuffix(repeatIndex, repeats)}`;
        jobs.push({
          id: `${parse(role.name).name}_${competitor.name}_${typeName}`,
          name: `${parse(role.name).name}_${competitor.name}_${typeName}`,
          outputMode,
          imageModel: resolvedImageModel.model,
          imageModelLabel: resolvedImageModel.label,
          videoModel: resolvedVideoModel.model,
          videoModelLabel: resolvedVideoModel.label,
          size: layout.size,
          videoSize,
          referenceVideoPath: competitor.referenceVideoPath || "",
          referenceVideoDuration: competitor.referenceVideoDuration || 0,
          prompt: singleRolePrompt(role, promptCompetitor, jobLogos),
          videoPrompt: seedanceAdVideoPrompt({ roles: [role], monsters: [], competitor: promptCompetitor, groupName: typeName }),
          images: [role.sourcePath, ...jobLogos.map((logo) => logo.sourcePath), ref].filter(Boolean),
          output: join(dirs().outputDir, `${batchTag}_${parse(role.name).name}_${competitor.name}_${typeName}.png`),
          videoOutput: join(dirs().outputDir, `${batchTag}_${parse(role.name).name}_${competitor.name}_${typeName}.mp4`)
        });
      }
    }
  }
  return jobs;
}

async function runTaiJob(job, promptDir, logPath) {
  await writeFile(join(promptDir, `prompt_${job.name}.txt`), job.prompt, "utf8");
  if (job.outputMode === "video") await writeFile(join(promptDir, `seedance_${job.name}.txt`), job.videoPrompt, "utf8");
  if (job.outputMode === "video" && existsSync(job.videoOutput)) return { skipped: true };
  if (job.outputMode !== "video" && existsSync(job.output)) return { skipped: true };

  let imageResult = null;
  if (existsSync(job.output)) {
    imageResult = { skippedImage: true };
  } else {
    imageResult = await runImageStage(job, promptDir, logPath);
  }

  if (job.outputMode !== "video") return { skipped: false, ...imageResult };

  const videoResult = await runSeedanceVideoStage(job, promptDir, logPath);
  return { skipped: false, ...imageResult, ...videoResult };
}

async function runImageStage(job, promptDir, logPath) {
  let imageModel = job.imageModel || MODEL;
  let imageModelLabel = job.imageModelLabel || imageModel;
  let apiKey = await requireUserApiKeyForModel(imageModel, imageModelLabel);
  let didFallbackToGptImage = false;
  const args = ["aigc", "image", job.prompt, "--model", imageModel, "--size", job.size, "-n", "1"];
  for (const image of job.images) args.push("--image", image);

  let stdout = "";
  let stderr = "";
  for (let attempt = 1; attempt <= 12; attempt++) {
    const runState = getRunState();
    if (runState.stopRequested) throw new Error("Batch stopped by user");
    try {
      args[4] = imageModel;
      const result = await execTai(args, { env: taiEnvForApiKey(apiKey) });
      stdout = result.stdout;
      stderr = result.stderr;
      break;
    } catch (error) {
      const combined = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`;
      const quotaError = /no available codex image quota|quota|insufficient.*credit|balance/i.test(combined);
      const retryable = combined.includes("429") ||
        combined.includes("Too many requests") ||
        combined.includes("image_poll_timeout") ||
        combined.includes("fetch failed") ||
        combined.includes("Unexpected token '<'") ||
        combined.includes("<!DOCTYPE") ||
        error.code === 3221226505;
      addLog("error", `ERROR_REASON ${job.name}: ${summarizeErrorText(combined)}`, { job: job.name });
      if (quotaError && imageModel === "codex-gpt-image-2" && !didFallbackToGptImage) {
        didFallbackToGptImage = true;
        imageModel = "gpt-image-2";
        imageModelLabel = "gpt-image-2";
        apiKey = await requireUserApiKeyForModel(imageModel, imageModelLabel);
        addLog("fallback", `FALLBACK ${job.name}: codex-gpt-image-2 quota unavailable, retrying with gpt-image-2`, { job: job.name, from: "codex-gpt-image-2", to: "gpt-image-2" });
        continue;
      }
      if (retryable && attempt < 12) {
        const waitMs = 30000;
        addLog("retry", `RETRY ${job.name} attempt=${attempt} wait=${waitMs / 1000}s ${summarizeErrorText(combined)}`, { job: job.name });
        await sleepWithStop(waitMs);
        continue;
      }
      if (quotaError) {
        throw new Error(`当前账号的 ${imageModelLabel} 生图额度不可用或已用完。图片+视频模式必须先生成图片首帧，所以视频阶段还没开始。请切换到 ByteDance-Seedream-5-0-lite，或更换有 codex-gpt-image-2 额度的 API Key。${summarizeErrorText(combined)}`);
      }
      if (/401|403|unauthorized|forbidden|invalid api key|api key|permission|not support|unsupported|model/i.test(combined)) {
        throw new Error(`当前账号 API Key 不支持或无权使用模型 ${imageModelLabel}。请点击右上角头像更换 API Key，或选择该 Key 支持的模型。${summarizeErrorText(combined)}`);
      }
      throw error;
    }
  }

  const raw = `${stdout}\n${stderr}`.trim();
  const model = raw.match(/Model:\s*(.+)/)?.[1]?.trim() ?? "";
  const taskId = raw.match(/Task:\s*(.+)/)?.[1]?.trim() ?? "";
  const imageUrl = raw.match(/\[1\]\s*(\S+)/)?.[1]?.trim() ?? "";
  if (model && model !== imageModel) throw new Error(`Unexpected model, expected ${imageModel}, actual ${model || "unknown"}`);
  if (!imageUrl) throw new Error(`No image URL returned\n${raw}`);

  await downloadImage(imageUrl, job.output);
  const storage = await syncProjectAssetToObjectStorage(job.output, "generated_image");
  const record = { time: new Date().toISOString(), name: job.name, model: model || imageModel, model_label: imageModelLabel, task_id: taskId, prompt_path: join(promptDir, `prompt_${job.name}.txt`), output: job.output, remote_url: imageUrl };
  if (didFallbackToGptImage) record.fallback_from = "codex-gpt-image-2";
  if (storage) {
    record.storage_key = storage.storageKey;
    record.storage_url = storage.storageUrl;
  }
  await writeFile(logPath, `${JSON.stringify(record)}\n`, { flag: "a" });
  return { model, taskId };
}

async function runSeedanceVideoStage(job, promptDir, logPath) {
  const runState = getRunState();
  if (runState.stopRequested) throw new Error("Batch stopped by user");
  const videoModel = job.videoModel || SEEDANCE_MODEL;
  const apiKey = await requireUserApiKeyForModel(videoModel, job.videoModelLabel || videoModel);
  const targetDuration = job.referenceVideoDuration > 0 ? Math.round(job.referenceVideoDuration) : 15;
  const segmentDurations = seedanceSegmentDurations(targetDuration);
  const ratio = ratioFromOutputSize(job.videoSize);
  const segmentPaths = [];
  const taskIds = [];
  const remoteUrls = [];
  const normalizedVideoRefs = [];
  addLog("video-start", `VIDEO_START ${job.name} [${job.videoModelLabel || SEEDANCE_MODEL_LABEL}] duration=${targetDuration}s segments=${segmentDurations.join("+")}`, { job: job.name, model: videoModel });
  for (let index = 0; index < segmentDurations.length; index += 1) {
    if (getRunState().stopRequested) throw new Error("Batch stopped by user");
    const segmentDuration = segmentDurations[index];
    const segmentName = segmentDurations.length > 1 ? `${job.name}_part${index + 1}` : job.name;
    const segmentPath = segmentDurations.length > 1
      ? join(dirname(job.videoOutput), `${parse(job.videoOutput).name}_part${index + 1}.mp4`)
      : job.videoOutput;
    const referenceVideoForSeedance = index === 0 && job.referenceVideoPath && existsSync(job.referenceVideoPath)
      ? await seedanceSafeVideoReference(job.referenceVideoPath, promptDir)
      : "";
    if (referenceVideoForSeedance) normalizedVideoRefs.push(referenceVideoForSeedance);
    const hasReferenceVideo = Boolean(referenceVideoForSeedance);
    const firstSegmentPrompt = `${job.videoPrompt}\nMatch the uploaded reference ad video duration and shot rhythm as closely as possible. This is segment ${index + 1}/${segmentDurations.length}; keep the first segment as the opening hook and do not end abruptly unless more segments follow.`;
    const sourceVideoForExtend = index > 0 ? await seedanceSafeVideoReference(segmentPaths[index - 1], promptDir) : "";
    const args = index === 0
      ? [
          "aigc", "seedance",
          "--mode", hasReferenceVideo ? "omni_reference" : "image_to_video",
          "--model", videoModel,
          "--image", job.output,
          ...(hasReferenceVideo ? ["--video", referenceVideoForSeedance] : []),
          "--duration", String(segmentDuration),
          "--ratio", ratio,
          "--resolution", "720p",
          firstSegmentPrompt
        ]
      : [
          "aigc", "seedance",
          "--mode", "video_extend",
          "--model", videoModel,
          "--source-video", sourceVideoForExtend,
          "--duration", String(segmentDuration),
          "--ratio", ratio,
          "--resolution", "720p",
          `${job.videoPrompt}\nContinue from the previous generated segment. This is segment ${index + 1}/${segmentDurations.length}; preserve motion continuity, character identity, camera direction, dialogue language, and ad rhythm. End naturally only on the final segment.`
        ];
    addLog("video-segment", `VIDEO_SEGMENT ${segmentName} duration=${segmentDuration}s${hasReferenceVideo ? " reference_video=on" : ""}`, { job: job.name, segment: index + 1, referenceVideo: hasReferenceVideo });
    const { stdout, stderr } = await execTai(args, { env: taiEnvForApiKey(apiKey) });
    const raw = `${stdout}\n${stderr}`.trim();
    const taskId = raw.match(/Task:\s*(.+)/)?.[1]?.trim() || raw.match(/task[_-]?id[:：]\s*(\S+)/i)?.[1]?.trim() || "";
    const videoUrl = taskId ? await pollSeedanceVideoUrl(taskId, segmentName, segmentPath) : parseSeedanceVideoUrl(raw);
    if (!videoUrl) throw new Error(`No Seedance video URL returned\n${raw}`);
    if (!taskId) await downloadVerifiedVideo(videoUrl, segmentPath, segmentName);
    segmentPaths.push(segmentPath);
    taskIds.push(taskId);
    remoteUrls.push(videoUrl);
  }
  if (segmentPaths.length > 1) {
    await concatVideos(segmentPaths, job.videoOutput);
  }
  const storage = null;
  const record = { time: new Date().toISOString(), name: job.name, model: videoModel, model_label: job.videoModelLabel || SEEDANCE_MODEL_LABEL, task_id: taskIds.filter(Boolean).join(","), prompt_path: join(promptDir, `seedance_${job.name}.txt`), image: job.output, output: job.videoOutput, remote_url: remoteUrls[remoteUrls.length - 1] || "", reference_video: job.referenceVideoPath || "", seedance_reference_video: normalizedVideoRefs[0] || "", reference_video_duration: job.referenceVideoDuration || 0, target_duration: targetDuration, segment_durations: segmentDurations };
  if (storage) {
    record.storage_key = storage.storageKey;
    record.storage_url = storage.storageUrl;
  }
  await writeFile(logPath, `${JSON.stringify(record)}\n`, { flag: "a" });
  return { videoTaskId: taskIds.filter(Boolean).join(",") };
}

async function generateComicVideo(body = {}) {
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) throw new Error("请先生成或填写 Seedance 提示词");
  const ratio = ["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"].includes(String(body.ratio)) ? String(body.ratio) : "9:16";
  const videoModelInfo = resolveVideoModel(body.videoModel || "dreamina-seedance-2-0-mini");
  const duration = Math.max(4, Math.min(15, Number.parseInt(String(body.duration ?? "15"), 10) || 15));
  const batchTag = sanitizeSegment(body.batchTag || new Date().toISOString().slice(0, 19).replace(/\D/g, ""));
  const workDir = join(dirs().recordDir, `comic_${batchTag}`);
  await mkdir(workDir, { recursive: true });
  await mkdir(dirs().outputDir, { recursive: true });
  const refs = Array.isArray(body.refs) ? body.refs.slice(0, 8) : [];
  const assetPaths = Array.isArray(body.assetPaths) ? body.assetPaths.slice(0, 8) : [];
  const imageArgs = [];
  const videoArgs = [];
  const audioArgs = [];
  for (const assetPath of assetPaths) {
    const full = safeInsideProject(String(assetPath || ""));
    if (!existsSync(full)) continue;
    const ext = extname(full).toLowerCase();
    if (IMAGE_EXTS.has(ext)) imageArgs.push(full);
    else if (VIDEO_EXTS.has(ext)) videoArgs.push(full);
  }
  for (let index = 0; index < refs.length; index += 1) {
    const ref = refs[index] || {};
    const name = sanitizeFileName(ref.name || `ref_${index + 1}`);
    const content = String(ref.content || "");
    if (!content.includes(",")) continue;
    const mime = content.slice(5, content.indexOf(";")).toLowerCase();
    const base64 = content.split(",").pop() || "";
    const buffer = Buffer.from(base64, "base64");
    if (!buffer.length) continue;
    const ext = extname(name).toLowerCase() || (mime.includes("png") ? ".png" : mime.includes("webp") ? ".webp" : mime.includes("video") ? ".mp4" : mime.includes("audio") ? ".mp3" : ".jpg");
    const target = safeInsideProject(join(workDir, `${String(index + 1).padStart(2, "0")}_${sanitizeSegment(parse(name).name)}${ext}`));
    await writeFile(target, buffer);
    if (mime.startsWith("image/")) imageArgs.push(target);
    else if (mime.startsWith("video/")) videoArgs.push(target);
    else if (mime.startsWith("audio/")) audioArgs.push(target);
  }
  const mode = imageArgs.length || videoArgs.length || audioArgs.length ? "omni_reference" : "text_to_video";
  const args = ["aigc", "seedance", "--mode", mode, "--model", videoModelInfo.model, "--duration", String(duration), "--ratio", ratio, "--resolution", "720p"];
  for (const item of imageArgs) args.push("--image", item);
  for (const item of videoArgs) args.push("--video", item);
  for (const item of audioArgs) args.push("--audio", item);
  args.push(prompt);
  let stdout = "";
  let stderr = "";
  try {
    const result = await execTai(args);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    const rawError = `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.message ?? ""}`.trim();
    await writeFile(join(workDir, "seedance_error.txt"), rawError || String(error), "utf8");
    throw new Error(`Seedance 2.0 生成提交失败：${summarizeErrorText(rawError || error.message)}。完整错误已保存到 ${join(workDir, "seedance_error.txt")}`);
  }
  const raw = `${stdout}\n${stderr}`.trim();
  const taskId = raw.match(/Task:\s*(.+)/)?.[1]?.trim() || raw.match(/task[_-]?id[:：]\s*(\S+)/i)?.[1]?.trim() || "";
  const videoUrl = taskId ? await pollSeedanceVideoUrl(taskId, `comic_${batchTag}`) : parseSeedanceVideoUrl(raw);
  if (!videoUrl) throw new Error(`No Seedance video URL returned\n${raw}`);
  const output = join(dirs().outputDir, `${batchTag}_游戏漫剧_Seedance2.mp4`);
  await downloadBinary(videoUrl, output);
  const storage = await syncProjectAssetToObjectStorage(output, "comic_video_output");
  const promptPath = join(workDir, "seedance_prompt.txt");
  await writeFile(promptPath, prompt, "utf8");
  await writeFile(join(workDir, "seedance_result.json"), JSON.stringify({ time: new Date().toISOString(), model: videoModelInfo.model, model_label: videoModelInfo.label, mode, taskId, promptPath, output, remoteUrl: videoUrl, refs: { images: imageArgs.length, videos: videoArgs.length, audios: audioArgs.length } }, null, 2), "utf8");
  const info = await stat(output);
  return { ok: true, model: videoModelInfo.model, modelLabel: videoModelInfo.label, mode, taskId, output, url: storage?.storageUrl || localFileUrl(output, Math.round(info.mtimeMs)), remoteUrl: videoUrl, ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl } : {}) };
}

function parseSeedanceVideoUrl(raw) {
  const lines = String(raw).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const cleanUrl = (value = "") => String(value).trim().replace(/[)"'，,。]+$/g, "");
  const fromObject = (value, path = "") => {
    if (!value || typeof value !== "object") return "";
    const isOutputPath = /(output|result|generated|generation|video|download|play|preview)/i.test(path) &&
      !/(input|source|reference|asset|upload|origin|prompt)/i.test(path);
    const keys = ["video_url", "videoUrl", "output_url", "outputUrl", "result_url", "resultUrl", "download_url", "downloadUrl", "play_url", "playUrl", "url"];
    for (const key of keys) {
      const nextPath = path ? `${path}.${key}` : key;
      const keyLooksLikeOutput = /(output|result|generated|generation|video|download|play|preview)/i.test(nextPath) &&
        !/(input|source|reference|asset|upload|origin|prompt)/i.test(nextPath);
      if (typeof value[key] === "string" && (isOutputPath || keyLooksLikeOutput) && isLikelyVideoUrl(value[key])) return cleanUrl(value[key]);
    }
    for (const key of ["data", "result", "output", "video", "videos", "generated", "generation", "download"]) {
      const found = fromObject(value[key], path ? `${path}.${key}` : key);
      if (found) return found;
    }
    for (const item of Object.values(value)) {
      if (Array.isArray(item)) {
        const arrayPath = Object.entries(value).find(([, candidate]) => candidate === item)?.[0] || "items";
        for (const child of item) {
          const found = fromObject(child, path ? `${path}.${arrayPath}` : arrayPath);
          if (found) return found;
        }
      }
    }
    return "";
  };
  for (const line of lines) {
    if (!line.startsWith("{") && !line.startsWith("[")) continue;
    try {
      const found = fromObject(JSON.parse(line));
      if (found) return found;
    } catch {
      // CLI output often contains non-JSON progress lines.
    }
  }
  const outputLine = lines.find((line) =>
    /(Output|Result|Generated|Preview|Video\s*(URL|Output|Result)|视频结果|生成结果|输出)/i.test(line) &&
    !/(Upload|Uploaded|Input|Source|Reference|Asset|--video|source-video|参考|输入|上传)/i.test(line)
  );
  return cleanUrl(outputLine?.match(/(https?:\/\/\S+|\/v1\/public\/\S+)/i)?.[1] || "");
}

async function pollSeedanceVideoUrl(taskId, jobName, targetPath = "") {
  if (!taskId) return "";
  for (let attempt = 1; attempt <= 60; attempt += 1) {
    const runState = getRunState();
    if (runState.stopRequested) throw new Error("Batch stopped by user");
    await sleepWithStop(30000);
    const { stdout, stderr } = await execTai(["aigc", "seedance-status", taskId]).catch((error) => ({
      stdout: error.stdout ?? "",
      stderr: `${error.stderr ?? ""}\n${error.message ?? ""}`
    }));
    const raw = `${stdout}\n${stderr}`.trim();
    const videoUrl = parseSeedanceVideoUrl(raw);
    if (videoUrl) {
      if (!targetPath) return videoUrl;
      try {
        await downloadVerifiedVideo(videoUrl, targetPath, jobName);
        return videoUrl;
      } catch (error) {
        addLog("warn", `VIDEO_URL_NOT_READY ${jobName} ${summarizeErrorText(error.message)}`, { job: jobName, url: videoUrl });
      }
    }
    if (/failed|rejected|error/i.test(raw)) throw new Error(`Seedance failed for ${jobName}: ${summarizeErrorText(raw)}`);
    if (attempt === 1 || attempt % 2 === 0) addLog("video-wait", `VIDEO_WAIT ${jobName} task=${taskId} attempt=${attempt}`, { job: jobName });
  }
  throw new Error(`Seedance video timeout for ${jobName}: ${taskId}`);
}

async function downloadImage(url, targetPath) {
  return downloadBinary(url, targetPath);
}

async function downloadBinary(url, targetPath) {
  const fullUrl = url.startsWith("http") ? url : `https://skylink-gateway.com${url}`;
  const res = await fetch(fullUrl);
  if (!res.ok) throw new Error(`Download failed ${res.status}: ${fullUrl}`);
  const file = createWriteStream(targetPath);
  await new Promise((resolveDownload, reject) => {
    file.on("error", reject);
    file.on("finish", resolveDownload);
    res.body.pipeTo(new WritableStream({
      write(chunk) { file.write(Buffer.from(chunk)); },
      close() { file.end(); },
      abort(err) { file.destroy(err); reject(err); }
    })).catch(reject);
  });
}

async function startBatch(options = {}) {
  let runState = getRunState();
  if (runState.running) throw new Error("Batch is already running");
  const materials = await loadMaterials();
  const selectedRoleNames = options.roles?.length ? options.roles : materials.roles.map((role) => role.name);
  const selectedMonsterNames = options.monsters?.length ? options.monsters : [];
  const selectedLogoNames = options.logos?.length ? options.logos : [];
  const selectedCompetitorNames = options.competitors?.length ? options.competitors : materials.competitors.map((item) => item.name);
  const batchTag = options.batchTag?.trim() || new Date().toISOString().slice(0, 16).replace(/\D/g, "");
  const concurrency = Math.min(4, Math.max(1, Number(options.concurrency || 2)));
  const repeatCount = Math.max(1, Math.min(50, Number(options.repeatCount || 1)));
  const outputMode = options.outputMode === "video" ? "video" : "image";
  const imageModel = String(options.imageModel || "").trim();
  if (!IMAGE_MODELS.has(imageModel)) throw new Error("请先选择生图模型。");
  const imageModelInfo = resolveImageModel(imageModel);
  const requestedVideoModel = String(options.videoModel || "dreamina-seedance-2-0-mini").trim();
  if (outputMode === "video" && !VIDEO_MODEL_OPTIONS[requestedVideoModel]) throw new Error("请先选择视频模型。");
  const videoModelInfo = resolveVideoModel(requestedVideoModel);
  const jobs = buildJobs({
    roles: materials.roles,
    monsters: materials.monsters,
    logos: materials.logos,
    competitors: materials.competitors,
    selectedRoleNames,
    selectedMonsterNames,
    selectedLogoNames,
    selectedCompetitorNames,
    competitorSettings: options.competitorSettings ?? {},
    globalRequirement: options.globalRequirement ?? materials.globalRequirement,
    batchTag,
    outputMode,
    repeatCount,
    imageModel: imageModelInfo.model,
    videoModel: requestedVideoModel
  });
  if (!jobs.length) {
    const needsMonster = materials.competitors
      .filter((item) => selectedCompetitorNames.includes(item.name))
      .some((item) => Number((options.competitorSettings ?? {})[item.name]?.monsterCount ?? item.monsterCount ?? 0) > 0);
    const needsLogo = materials.competitors
      .filter((item) => selectedCompetitorNames.includes(item.name))
      .some((item) => Boolean((options.competitorSettings ?? {})[item.name]?.useLogo ?? item.useLogo));
    if (!selectedRoleNames.length) throw new Error("没有可生成任务：请至少勾选一个角色图。");
    if (needsMonster && !selectedMonsterNames.length) throw new Error("没有可生成任务：已选竞品设置了怪物数量，但没有勾选怪物图。请勾选怪物图，或把怪物数量改成 0。");
    if (needsLogo && !selectedLogoNames.length) throw new Error("没有可生成任务：已选竞品勾选了 Logo，但没有勾选产品 Logo 图。请勾选产品 Logo，或取消该竞品的 Logo。");
    throw new Error("没有可生成任务：请检查竞品素材、角色数量、怪物数量和素材勾选状态。");
  }
  const safeImageModel = imageModelInfo.model.replace(/[^a-zA-Z0-9_-]/g, "_");
  const promptDir = join(dirs().recordDir, `prompts_${batchTag}_${safeImageModel}`);
  const logPath = join(dirs().recordDir, `batch_${batchTag}_${safeImageModel}_${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  await mkdir(promptDir, { recursive: true });
  await mkdir(dirs().outputDir, { recursive: true });

  runState = setRunState({
    running: true,
    stopRequested: false,
    batchTag,
    startedAt: new Date().toISOString(),
    finishedAt: "",
    total: jobs.length,
    completed: 0,
    skipped: 0,
    failed: 0,
    outputMode,
    current: "",
    concurrency,
    repeatCount,
    imageModel: imageModelInfo.model,
    videoModel: outputMode === "video" ? videoModelInfo.model : "",
    videoModelLabel: outputMode === "video" ? videoModelInfo.label : "",
    jobs: jobs.map((job, index) => ({
      index: index + 1,
      name: job.name,
      size: job.size,
      outputMode: job.outputMode,
      imageModel: job.imageModel,
      videoModel: job.videoModel || "",
      videoModelLabel: job.videoModelLabel || "",
      status: "pending",
      statusText: "pending",
      output: job.output,
      startedAt: "",
      finishedAt: "",
      error: ""
    })),
    log: []
  });
  addLog("start", `START total=${jobs.length} concurrency=${concurrency} repeat=${repeatCount} mode=${outputMode} model=${imageModelInfo.label}${outputMode === "video" ? ` videoModel=${videoModelInfo.label}` : ""}`);

  void (async () => {
    let cursor = 0;
    async function worker(workerId) {
      while (!getRunState().stopRequested) {
        const job = jobs[cursor++];
        if (!job) return;
        runState = getRunState();
        runState.current = job.name;
        updateJobState(job.name, { status: "running", statusText: `running W${workerId}`, startedAt: new Date().toISOString(), error: "" });
        addLog("job-start", `W${workerId} START ${job.name}`, { job: job.name, worker: workerId });
        try {
          const result = await runTaiJob(job, promptDir, logPath);
          if (result.skipped) {
            runState = getRunState();
            runState.skipped += 1;
            updateJobState(job.name, { status: "skipped", statusText: "skipped", finishedAt: new Date().toISOString() });
            addLog("skip", `SKIP ${job.name}`, { job: job.name, output: job.output, worker: workerId });
          } else {
            runState = getRunState();
            runState.completed += 1;
            updateJobState(job.name, { status: "done", statusText: "done", finishedAt: new Date().toISOString(), output: job.outputMode === "video" ? job.videoOutput : job.output });
            addLog("done", `DONE ${job.name} [${job.outputMode === "video" ? (job.videoModelLabel || SEEDANCE_MODEL_LABEL) : MODEL}]`, { job: job.name, output: job.outputMode === "video" ? job.videoOutput : job.output, worker: workerId });
          }
        } catch (error) {
          runState = getRunState();
          runState.failed += 1;
          updateJobState(job.name, { status: runState.stopRequested ? "stopped" : "failed", statusText: runState.stopRequested ? "stopped" : "failed", finishedAt: new Date().toISOString(), error: error.message ?? String(error) });
          addLog("error", `ERROR ${job.name}: ${error.message}`, { job: job.name, worker: workerId });
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, jobs.length)) }, (_, index) => worker(index + 1)));

    runState = getRunState();
    if (runState.stopRequested) {
      for (const item of runState.jobs) {
        if (item.status === "pending") Object.assign(item, { status: "stopped", statusText: "stopped", finishedAt: new Date().toISOString() });
      }
    }
    runState.running = false;
    runState.stopRequested = false;
    runState.current = "";
    runState.finishedAt = new Date().toISOString();
    addLog("finish", `FINISH completed=${runState.completed} skipped=${runState.skipped} failed=${runState.failed}`);
  })();

  return runState;
}

async function stopBatch() {
  const runState = getRunState();
  if (!runState.running) return runState;
  runState.stopRequested = true;
  addLog("stop", "STOP requested");
  for (const child of activeChildren()) {
    try {
      child.kill();
    } catch {
      // Ignore kill failures; the child may have already exited.
    }
  }
  activeChildren().clear();
  return runState;
}

function comboPrompt({ roles, monsters, logos = [], competitor, groupName }) {
  const roleLines = roles.map((role, index) => `Hero ${index + 1}: ${role.traits}.`).join("\n");
  const monsterLines = monsters.map((monster, index) => `Creature ${index + 1}: ${monster.traits}.`).join("\n");
  const hasMonsters = monsters.length > 0;
  const sizeText = (competitor.layout ?? layoutFromDimensions()).promptSize;
  return `${sizeText} mobile game promotional picture, fully original. Use the provided user-owned character and creature images as identity references. Use the competitor image only as layout, pacing, hierarchy, and UI composition reference.

Composition: analyze the competitor reference to decide spacing, scale, framing, scene type, mood, emotional acting, background rhythm, prop functional roles, badge placement, and text hierarchy. Place ${roles.length} user hero character(s)${hasMonsters ? ` and ${monsters.length} user creature/monster(s)` : ""} clearly in the scene, but fit them into the same layout zones used by the reference instead of inventing a new lineup. Preserve each identity separately and do not merge them.
${layoutLockBlock(competitor)}
${videoReferenceBlock(competitor)}
${gameplayLayoutLockBlock(competitor)}
${unitScaleLockBlock(competitor)}
${logoInstructionBlock(logos)}
${referenceTypeGuardBlock(competitor)}
${originalityBlock()}
${noCrossReferenceBlock()}
${visualStyleModeBlock(competitor.visualStyleMode)}

Expression and acting lock: match the current reference character's emotional performance as closely as possible. Preserve scared, worried, crying, shocked, embarrassed, calm, smug, happy, or tired expressions when present. Copy only visible emotional signals from the current reference, such as eye shape, eyebrow angle, tears, sweat drops, blush, open mouth shape, clenched mouth, head tilt, shoulder posture, and body pose. Do not invent extra character states or danger elements that are not visible in the current reference.

${roleLines}
${monsterLines}

Group label: ${groupName}. Add short readable English UI text only when the reference has text or the user special request asks for text replacement. Keep the image all-ages, polished, and promotional while preserving the reference mood.
${requirementBlock(competitor.requirement)}
${specialRequirementBlock(competitor.specialRequirement)}
${visualStyleFinalRule(competitor.visualStyleMode)}`;
}

async function downloadVerifiedVideo(videoUrl, targetPath, jobName) {
  await downloadBinary(videoUrl, targetPath);
  const metadata = await readVideoMetadata(targetPath);
  if (!isVideoCodecCompatible(metadata)) {
    await rm(targetPath, { force: true }).catch(() => {});
    throw new Error(`Seedance returned a non-video asset for ${jobName}: ${videoUrl}`);
  }
  return metadata;
}

function seedanceAdVideoPrompt({ roles, monsters, competitor, groupName }) {
  if (competitor.referenceVideoPath || competitor.videos?.length) {
    return seedanceDirectReferenceVideoPrompt({ roles, monsters, competitor, groupName });
  }
  const combat = isCombatReference(competitor);
  return combat
    ? seedanceBattleVideoPrompt({ roles, monsters, competitor, groupName })
    : seedanceGeneralVideoPrompt({ roles, monsters, competitor, groupName });
}

function seedanceDirectReferenceVideoPrompt({ roles, monsters, competitor, groupName }) {
  const roleText = roles.map((role, index) => `角色${index + 1}保持：${role.traits}`).join("；");
  const monsterText = monsters.length ? `附加生物/宠物素材保持：${monsters.map((monster, index) => `素材${index + 1}${monster.traits}`).join("；")}。` : "";
  const styleText = videoVisualStyleRule(competitor.visualStyleMode);
  const layout = competitor.layout ?? layoutFromDimensions();
  const aspectText = layout.orientation === "wide" ? "如果参考视频是横版，只参考其镜头节奏和主体关系；输出比例按当前任务自动适配，但不要改变主体相对位置。" : layout.orientation === "tall" ? "保持参考视频的竖屏广告节奏、镜头距离和主体比例。" : "保持参考视频的核心版式关系、镜头距离和主体比例。";
  const dialoguePrompt = dialogueInstructionBlock(parseSpecialRequirementJson(competitor.specialRequirement)?.reverse_analysis?.dialogue);
  return `请直接参考已上传的竞品视频素材来生成视频：参考它的分镜节奏、镜头运动、主体位置、动作时机、表情变化、道具互动、转场和结尾停留方式；参考上一阶段生成的效果图作为我方画面、角色身份和美术风格来源。${styleText}${aspectText}

必须把参考视频里的竞品角色/主体替换为我方生成图中的角色和资产，不能让竞品原角色与我方角色同时存在。${roleText}。${monsterText}

只保留参考视频的抽象节奏和镜头结构，不复制竞品logo、品牌名、字幕、UI文字、角色形象、具体场景皮肤、专有道具或水印。不要根据历史模板自行添加参考视频里没有的内容；如果参考视频没有打怪、战斗、攻击、怪物波次、升级卡、HP血条、伤害数字、技能释放或胜利结算，就绝对不要生成这些元素。

音频规则：如果参考视频有人声或台词，保持原语种和台词节奏；如果没有明显台词，只生成自然环境音、动作/道具音效或轻量口播，不要强行添加背景音乐。
${dialoguePrompt}

当前分组：${groupName}。特殊要求：${sanitizeRequirementText(specialRequirementForImagePrompt(competitor.specialRequirement) || "无")}`;
}

function seedanceGeneralVideoPrompt({ roles, monsters, competitor, groupName }) {
  const roleText = roles.map((role, index) => `角色${index + 1}保持：${role.traits}`).join("；");
  const extraAssets = monsters.length ? `如使用附加生物/宠物素材，只把它作为当前参考中对应宠物、伙伴、装饰角色或互动对象的替换参考，不要改成怪物敌人：${monsters.map((monster, index) => `素材${index + 1}${monster.traits}`).join("；")}。` : "";
  const styleText = videoVisualStyleRule(competitor.visualStyleMode);
  const layout = competitor.layout ?? layoutFromDimensions();
  const targetVideoSize = videoSizeInstruction(competitor.videoSize);
  const aspectText = layout.orientation === "wide" ? "参考图是横版广告构图，视频如需改编为竖屏9:16，也必须保留核心主体相对位置、镜头距离、文字/Logo层级和广告节奏。" : layout.orientation === "tall" ? "保持参考图的竖屏广告节奏、镜头距离和主体比例。" : "参考图接近方图，视频可以改编为竖屏9:16，但必须保留核心版式关系和主体比例。";
  const mergedVideoPrompt = seedanceReferencePromptText(competitor, false);
  const dialoguePrompt = dialogueInstructionBlock(parseSpecialRequirementJson(competitor.specialRequirement)?.reverse_analysis?.dialogue);
  const videoReference = mergedVideoPrompt
    ? `\n\n竞品视频JSON反推参考：\n${sanitizeRequirementText(mergedVideoPrompt).slice(0, 2200)}\n\n请先反推当前竞品视频的非战斗广告结构：前3秒钩子、镜头推进方式、角色互动、表情变化、道具使用、场景转场、产品/Logo露出和结尾停留方式。只保留抽象节奏和布局关系，不能复制竞品角色、logo、UI文字、品牌名、具体场景皮肤或专有道具。`
    : "";
  return `参考上一阶段由 codex-gpt-image-2 生成的效果图，制作15秒 Seedance 2.0 手游广告视频。${styleText}${targetVideoSize}${aspectText}${videoReference}

当前参考素材未明确表现战斗/塔防/怪物进攻玩法，因此本视频必须按当前参考的实际类型生成：可以是生活化、休闲、搞笑、经营、换装、合成、剧情、解谜、宠物互动、社交展示或产品广告演绎。不要强行加入战斗、敌人、怪物进攻、攻击、武器、技能释放、塔防道路、升级卡、A/S/SS卡牌、HP血条、伤害数字、Boss或战斗UI。必须保留效果图中的我方角色身份、构图、镜头角度、UI/文字层级、道具功能、场景情绪和主体比例。${roleText}。${extraAssets}

0-3秒：按当前参考的真实广告钩子开场。保持原参考的场景类型、主体位置和情绪方向，例如惊讶、搞笑、轻松、温馨、尴尬、治愈、展示或选择决策。用镜头推进、表情变化、道具动作或画面反差制造吸引力，不出现攻击和战斗压迫。
3-7秒：延续同一非战斗场景，让角色根据参考图/视频的互动逻辑行动，例如拿起道具、喝茶、换装、合成、经营、摆放、选择、表演、与宠物互动或观察变化。镜头可以切近景和反打，但不要变成战场或技能展示。
7-11秒：加强广告节奏，展示角色表情、道具变化、场景反馈、Logo或产品信息层级。若参考中有文字区域，只保留位置和层级，文字按用户特殊提示词替换或使用简短原创英文；不要生成乱码。
11-15秒：形成结尾记忆点，保持参考的结尾停留逻辑，例如角色满意/震惊/开心/无奈定格，产品Logo露出，场景成果展示，或轻微镜头拉远展示完整构图。不能突然切入怪物、攻击、爆炸、升级或胜利战斗结算。

视频规则：不要竞品logo、不要竞品角色、不要竞品UI、不要中文乱码、不要水印、不要写实真人、不要血腥恐怖。${videoVisualStyleRule(competitor.visualStyleMode)}保持当前参考素材的非战斗类型和情绪，不要把其他竞品图的束缚、危险状态、战斗场景或塔防玩法混入当前视频。
音频总规则：必须生成音频轨道，包含自然环境音、动作/道具音效和人物语音/口播；不要生成完全静音视频。除非用户明确要求，否则不要添加背景音乐。
${dialoguePrompt}

当前分组：${groupName}。特殊要求：${sanitizeRequirementText(specialRequirementForImagePrompt(competitor.specialRequirement) || "无")}`;
}

function seedanceBattleVideoPrompt({ roles, monsters, competitor, groupName }) {
  const roleText = roles.map((role, index) => `角色${index + 1}保持：${role.traits}`).join("；");
  const monsterText = monsters.length ? `怪物素材保持：${monsters.map((monster, index) => `怪物${index + 1}${monster.traits}`).join("；")}。` : "";
  const styleText = videoVisualStyleRule(competitor.visualStyleMode);
  const layout = competitor.layout ?? layoutFromDimensions();
  const targetVideoSize = videoSizeInstruction(competitor.videoSize);
  const aspectText = layout.orientation === "wide" ? "参考图是横版广告构图，但视频请改编为竖屏9:16，并保留核心主体相对位置和广告节奏。" : layout.orientation === "tall" ? "保持参考图的竖屏广告节奏。" : "参考图接近方图，视频请改编为竖屏9:16，保留核心版式关系。";
  const mergedVideoPrompt = seedanceReferencePromptText(competitor, true);
  const dialoguePrompt = dialogueInstructionBlock(parseSpecialRequirementJson(competitor.specialRequirement)?.reverse_analysis?.dialogue);
  const videoReference = mergedVideoPrompt
    ? `\n\n竞品视频JSON反推参考：\n${sanitizeRequirementText(mergedVideoPrompt).slice(0, 2200)}\n\n请先反推竞品视频的玩法结构、单位位置、镜头节奏、波次推进、升级链路和攻击因果，再套用到我方效果图。只能保留抽象玩法布局和广告节奏，不能复制竞品角色、logo、UI文字、品牌名、具体场景皮肤、建筑造型、冰雪门楼、火把、地图装饰或专有道具。`
    : "";
  return `参考上一阶段由 codex-gpt-image-2 生成的局内效果图，制作15秒 Seedance 2.0 手游广告视频。${styleText}${targetVideoSize}${aspectText}${videoReference}

必须保留效果图中的我方角色身份、地图布局、镜头角度、UI层级、敌我方向和主体比例。若参考视频是纵向塔防局内画面，英雄/防线必须保持在下方或底部格子，怪物必须保持在上方路径或从上方入口推进，攻击从下方英雄/防线朝上方怪物发出。保持原始镜头缩放、完整游戏屏幕、格子密度、道路宽度和UI边距，不能把场地、格子、敌人、英雄整体放大，不能裁切成近景。英雄必须保持小型局内单位比例，约等于参考视频里原英雄的屏幕占比，不能变成中心大插画、角色特写或前景展示；怪物也按参考视频怪物的相对尺寸和路径关系出现。必须用我方角色替换原卡皮/原英雄，原竞品单位必须消失，不能出现“原卡皮+我方角色”同时存在。我方角色必须站在原卡皮/原玩家单位所在同一个格子中心、同一条路线、同一层级。所有单位都必须在原版对应格子、路径或站位范围内运动，不能站出格子外或遮挡底部UI。不能改成左右对峙、横向决斗、海报展示或角色怪物并排站位。${roleText}。${monsterText}

0-3秒：强钩子，画面保持效果图布局，既定入口出现少量怪物/压力目标，弹出通用三选一升级卡，玩家选择一个A阶技能或装备。只用图标、星星和A/S/SS字母，不出现中文，不复制竞品文字。
3-7秒：角色或防御点开始基础攻击，攻击必须从角色/武器/塔发出， projectile/beam/slash 先移动再命中，敌人命中后才后退或消失。随后同一技能升级到4颗星，视觉输出变快或范围变宽。
7-11秒：出现S阶升级和更高生命值目标，怪物数量逐步增加但保持从同一入口/同一路径进入，战场连续不跳切。角色外观或武器出现轻微强化，仍保持原身份。
11-15秒：出现SS阶终极升级，释放大范围但因果清晰的终结技能：蓄力、发射、覆盖目标、敌人反应、奖励回流，最后胜利定格。

视频规则：不要竞品logo、不要竞品角色、不要竞品UI、不要中文文字、不要乱码、不要水印、不要写实真人、不要血腥恐怖。${videoVisualStyleRule(competitor.visualStyleMode)}清晰动作因果，敌人不能在未被击中前凭空消失，不能把其他竞品图的束缚、危险状态或场景混入当前视频。
音频总规则：必须生成音频轨道，包含自然环境音、攻击/道具音效和人物语音/口播；不要生成完全静音视频。除非用户明确要求，否则不要添加背景音乐。
${dialoguePrompt}

当前分组：${groupName}。特殊要求：${sanitizeRequirementText(specialRequirementForImagePrompt(competitor.specialRequirement) || "无")}`;
}

function cyclePick(items, start, count) {
  if (!count || !items.length) return [];
  return Array.from({ length: count }, (_, offset) => items[(start + offset) % items.length]);
}

async function updateConfig(body) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot change project root now");
  const nextRoot = resolve(String(body.projectRoot ?? "").trim());
  if (!nextRoot) throw new Error("Project root is required");
  try {
    await mkdir(nextRoot, { recursive: true });
    await access(nextRoot, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new Error(`项目目录不可写：${nextRoot}`);
  }
  const name = String(body.name ?? basename(nextRoot)).trim() || basename(nextRoot);
  savedProjects = normalizeProjects([{ name, path: nextRoot }, ...savedProjects.filter((item) => item.path !== nextRoot)]);
  await saveConfig();
  const scoped = requestScope.getStore();
  if (scoped) {
    scoped.baseProjectRoot = nextRoot;
    scoped.userProjectRoot = await ensureUserProjectScope(scoped.userId);
  }
  return { ok: true, projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), projects: projectList() };
}

async function switchProject(body) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot switch project now");
  const nextRoot = resolve(String(body.projectRoot ?? "").trim());
  if (!nextRoot) throw new Error("Project root is required");
  try {
    await mkdir(nextRoot, { recursive: true });
    await access(nextRoot, fsConstants.R_OK | fsConstants.W_OK);
  } catch {
    throw new Error(`项目目录不可写：${nextRoot}`);
  }
  const existing = savedProjects.find((item) => item.path === nextRoot);
  const name = String(body.name ?? existing?.name ?? basename(nextRoot)).trim() || basename(nextRoot);
  savedProjects = normalizeProjects([{ name, path: nextRoot }, ...savedProjects.filter((item) => item.path !== nextRoot)]);
  await saveConfig();
  const scoped = requestScope.getStore();
  if (scoped) {
    scoped.baseProjectRoot = nextRoot;
    scoped.userProjectRoot = await ensureUserProjectScope(scoped.userId);
  }
  return { ok: true, projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), projects: projectList() };
}

async function createProject(body) {
  requireAdmin();
  const runState = getRunState();
  if (runState.running) throw new Error("正在生成中，不能新增项目");
  const name = String(body.name ?? "").trim();
  if (!name) throw new Error("项目名称不能为空");
  const parentDir = dirname(resolve(currentBaseProjectRoot()));
  const nextRoot = resolve(parentDir, sanitizeSegment(name));
  if (savedProjects.some((item) => item.path === nextRoot)) throw new Error("项目已存在");
  await mkdir(nextRoot, { recursive: true });
  savedProjects = normalizeProjects([{ name, path: nextRoot }, ...savedProjects]);
  await saveConfig();
  const scoped = requestScope.getStore();
  if (scoped) {
    scoped.baseProjectRoot = nextRoot;
    scoped.userProjectRoot = await ensureUserProjectScope(scoped.userId);
  }
  return { ok: true, projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), projects: projectList() };
}

async function renameProject(body) {
  requireAdmin();
  const runState = getRunState();
  if (runState.running) throw new Error("正在生成中，不能修改项目名称");
  const targetRoot = resolve(String(body.projectRoot ?? "").trim());
  const name = String(body.name ?? "").trim();
  if (!targetRoot) throw new Error("请选择项目");
  if (!name) throw new Error("项目名称不能为空");
  const existing = savedProjects.find((item) => item.path === targetRoot);
  if (!existing) throw new Error("项目不存在");
  savedProjects = normalizeProjects(savedProjects.map((item) => item.path === targetRoot ? { ...item, name } : item));
  await saveConfig();
  return { ok: true, projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), projects: projectList() };
}

async function deleteProject(body) {
  requireAdmin();
  const runState = getRunState();
  if (runState.running) throw new Error("正在生成中，不能删除项目");
  const targetRoot = resolve(String(body.projectRoot ?? "").trim());
  if (!targetRoot) throw new Error("请选择项目");
  if (!savedProjects.some((item) => item.path === targetRoot)) throw new Error("项目不存在");
  if (savedProjects.length <= 1) throw new Error("至少保留一个项目");
  const remainingProjects = savedProjects.filter((item) => item.path !== targetRoot);
  if (resolve(projectRoot) === targetRoot || resolve(currentBaseProjectRoot()) === targetRoot) {
    projectRoot = remainingProjects[0].path;
  }
  savedProjects = normalizeProjects(remainingProjects);
  if (resolve(currentBaseProjectRoot()) === targetRoot) {
    const scoped = requestScope.getStore();
    if (scoped) {
      scoped.baseProjectRoot = projectRoot;
      scoped.userProjectRoot = await ensureUserProjectScope(scoped.userId);
    }
  }
  await saveConfig();
  return { ok: true, projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), projects: projectList() };
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function readRequestBuffer(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function parseMultipartBoundary(contentType = "") {
  const match = String(contentType || "").match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return (match?.[1] || match?.[2] || "").trim();
}

function parseContentDisposition(value = "") {
  const result = {};
  for (const part of String(value || "").split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    const key = rawKey.trim().toLowerCase();
    if (!key) continue;
    const joined = rawValue.join("=").trim();
    result[key] = joined.replace(/^"|"$/g, "");
  }
  return result;
}

async function readMultipart(req) {
  const contentType = req.headers["content-type"] || "";
  const boundary = parseMultipartBoundary(contentType);
  if (!boundary) throw new Error("multipart boundary missing");
  const body = await readRequestBuffer(req);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let cursor = 0;
  while (cursor < body.length) {
    const start = body.indexOf(delimiter, cursor);
    if (start < 0) break;
    let partStart = start + delimiter.length;
    if (body.slice(partStart, partStart + 2).toString() === "--") break;
    if (body.slice(partStart, partStart + 2).toString() === "\r\n") partStart += 2;
    const headerEnd = body.indexOf(Buffer.from("\r\n\r\n"), partStart);
    if (headerEnd < 0) break;
    const rawHeaders = body.slice(partStart, headerEnd).toString("utf8");
    let partEnd = body.indexOf(delimiter, headerEnd + 4);
    if (partEnd < 0) partEnd = body.length;
    let content = body.slice(headerEnd + 4, partEnd);
    if (content.slice(-2).toString() === "\r\n") content = content.slice(0, -2);
    cursor = partEnd;

    const headers = {};
    for (const line of rawHeaders.split("\r\n")) {
      const index = line.indexOf(":");
      if (index <= 0) continue;
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
    }
    const disposition = parseContentDisposition(headers["content-disposition"]);
    const name = disposition.name;
    if (!name) continue;
    if (disposition.filename != null) {
      files[name] = {
        fileName: basename(disposition.filename || "upload.bin"),
        mimeType: headers["content-type"] || "application/octet-stream",
        buffer: content
      };
    } else {
      fields[name] = content.toString("utf8");
    }
  }
  return { fields, files };
}

async function readUpload(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  let data;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("上传数据格式错误，请重新选择素材");
  }
  if (!data || typeof data !== "object") throw new Error("上传数据为空，请重新选择素材");
  if (!data.name) throw new Error("上传素材缺少文件名，请重新选择素材");
  if (typeof data.content !== "string" || !data.content.includes(",")) {
    throw new Error("上传素材读取失败，请重新选择素材");
  }
  const ext = extname(String(data.name)).toLowerCase();
  const allowedExts = data.allowVideo ? new Set([...IMAGE_EXTS, ...VIDEO_EXTS]) : IMAGE_EXTS;
  if (!allowedExts.has(ext)) throw new Error(data.allowVideo ? "Only png, jpg, jpeg, webp, mp4, webm, and mov files are supported" : "Only png, jpg, jpeg, and webp images are supported");
  const base64 = data.content.split(",").pop();
  if (!base64) throw new Error("上传素材内容为空，请重新选择素材");
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw new Error("Uploaded file is empty");
  let coverImageBuffer = null;
  let coverImageName = "";
  if (typeof data.coverContent === "string" && data.coverContent.startsWith("data:image/") && data.coverContent.includes(",")) {
    const coverBase64 = data.coverContent.split(",").pop();
    const coverBuffer = Buffer.from(coverBase64 || "", "base64");
    if (coverBuffer.length && isImageBuffer(coverBuffer)) {
      coverImageBuffer = coverBuffer;
      coverImageName = sanitizeFileName(data.coverName || `${parse(data.name).name}_封面.jpg`);
    }
  }
  return { name: sanitizeFileName(data.name), ext, buffer, kind: data.kind, mode: data.mode, folder: data.folder, targetName: data.targetName, allowVideo: Boolean(data.allowVideo), coverImageBuffer, coverImageName };
}

function sanitizeFileName(name) {
  const parsed = parse(basename(name));
  const safeBase = parsed.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "image";
  const safeExt = parsed.ext.toLowerCase();
  return `${safeBase}${safeExt}`;
}

async function uploadRole(req) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot replace role image now");
  const upload = await readUpload(req);
  if (upload.kind === "referenceVideo" && !VIDEO_EXTS.has(upload.ext)) throw new Error("参考视频素材只能上传 mp4、webm 或 mov");
  const targetDir = upload.kind === "monster" ? dirs().monsterDir : upload.kind === "logo" ? dirs().logoDir : upload.kind === "scene" ? dirs().sceneDir : upload.kind === "referenceVideo" ? dirs().referenceVideoDir : dirs().roleDir;
  await mkdir(targetDir, { recursive: true });
  const fileName = upload.mode === "replace" && upload.targetName ? sanitizeFileName(upload.targetName) : upload.name;
  const target = safeInsideProject(join(targetDir, fileName));
  await writeFile(target, upload.buffer);
  const storage = await syncProjectAssetToObjectStorage(target, upload.kind === "referenceVideo" ? "reference_video" : upload.kind === "monster" ? "monster_image" : upload.kind === "logo" ? "product_logo" : upload.kind === "scene" ? "scene_image" : "role_image");
  if (!["monster", "referenceVideo"].includes(upload.kind)) {
    const upscaledTarget = join(dirs().upscaledDir, fileName);
    if (existsSync(upscaledTarget)) await rm(upscaledTarget, { force: true });
  }
  return { ok: true, path: target, name: fileName, ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl, url: storage.storageUrl } : {}) };
}

async function deleteSharedMaterial(body = {}) {
  requireAdmin();
  const runState = getRunState();
  if (runState.running) throw new Error("正在生成中，不能删除素材，请先停止或等待完成");
  const kind = String(body.kind ?? "");
  const name = sanitizeFileName(body.name ?? "");
  const targetDir = kind === "monster" ? dirs().monsterDir : kind === "logo" ? dirs().logoDir : kind === "role" ? dirs().roleDir : kind === "referenceVideo" ? dirs().referenceVideoDir : "";
  if (!targetDir) throw new Error("只能删除角色图、怪物图、产品 Logo 或参考视频素材");
  if (!name) throw new Error("缺少要删除的素材名称");
  const target = safeInsideProject(join(targetDir, name));
  const ext = extname(target).toLowerCase();
  if (kind === "referenceVideo" ? !VIDEO_EXTS.has(ext) : !IMAGE_EXTS.has(ext)) throw new Error(kind === "referenceVideo" ? "只能删除视频素材" : "只能删除图片素材");
  if (!existsSync(target)) throw new Error("素材不存在或已被删除");
  await removeProjectAssetFromObjectStorage(target);
  await rm(target, { force: true });
  const upscaledTarget = join(dirs().upscaledDir, name);
  if (existsSync(upscaledTarget)) await rm(upscaledTarget, { force: true });
  return { ok: true, kind, name };
}

function sharedMaterialTargetDir(kind) {
  return kind === "monster" ? dirs().monsterDir
    : kind === "logo" ? dirs().logoDir
      : kind === "role" ? dirs().roleDir
        : kind === "referenceVideo" ? dirs().referenceVideoDir
          : "";
}

function sharedMaterialAssetKind(kind) {
  return kind === "referenceVideo" ? "reference_video"
    : kind === "monster" ? "monster_image"
      : kind === "logo" ? "product_logo"
        : "role_image";
}

async function renameSharedMaterial(body = {}) {
  requireAdmin();
  const runState = getRunState();
  if (runState.running) throw new Error("正在生成中，不能重命名素材，请先停止或等待完成");
  const kind = String(body.kind ?? "");
  const oldName = sanitizeFileName(body.name ?? "");
  const rawNewName = String(body.newName ?? "").trim();
  const targetDir = sharedMaterialTargetDir(kind);
  if (!targetDir) throw new Error("只能重命名角色图、怪物图、产品 Logo 或参考视频素材");
  if (!oldName) throw new Error("缺少要重命名的素材名称");
  if (!rawNewName) throw new Error("请输入新名称");
  const oldPath = safeInsideProject(join(targetDir, oldName));
  if (!existsSync(oldPath)) throw new Error("素材不存在或已被删除");
  const ext = extname(oldName).toLowerCase();
  if (kind === "referenceVideo" ? !VIDEO_EXTS.has(ext) : !IMAGE_EXTS.has(ext)) throw new Error(kind === "referenceVideo" ? "只能重命名视频素材" : "只能重命名图片素材");
  const desiredName = rawNewName.toLowerCase().endsWith(ext) ? rawNewName : `${rawNewName}${ext}`;
  const newName = sanitizeFileName(desiredName);
  if (!newName || newName === oldName) return { ok: true, kind, name: oldName, newName: oldName };
  const newPath = safeInsideProject(join(targetDir, newName));
  if (existsSync(newPath)) throw new Error("同名素材已存在，请换一个名称");
  await removeProjectAssetFromObjectStorage(oldPath);
  await rename(oldPath, newPath);
  if (kind !== "referenceVideo") {
    const oldUpscaled = join(dirs().upscaledDir, oldName);
    const newUpscaled = join(dirs().upscaledDir, newName);
    if (existsSync(oldUpscaled) && !existsSync(newUpscaled)) await rename(oldUpscaled, newUpscaled);
  }
  const storage = await syncProjectAssetToObjectStorage(newPath, sharedMaterialAssetKind(kind));
  return { ok: true, kind, name: oldName, newName, path: newPath, ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl, url: storage.storageUrl } : {}) };
}

async function uploadCompetitor(req) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot replace competitor material now");
  const upload = await readUpload(req);
  return replaceCompetitorMaterial({ folder: upload.folder, name: upload.name, buffer: upload.buffer, coverImageBuffer: upload.coverImageBuffer, coverImageName: upload.coverImageName });
}

async function replaceCompetitorMaterial({ folder, name, buffer, coverImageBuffer = null, coverImageName = "", sourceVideoUrl = "" }) {
  const folderName = validateCompetitorFolderName(folder);
  const dir = safeInsideProject(join(dirs().projectRoot, folderName));
  await mkdir(dir, { recursive: true });
  const oldImages = await listImageFiles(dir);
  for (const image of oldImages) {
    await removeProjectAssetFromObjectStorage(image.path);
    await rm(image.path, { force: true });
  }
  const oldVideos = await listVideoFiles(dir);
  for (const video of oldVideos) {
    await removeProjectAssetFromObjectStorage(video.path);
    await rm(video.path, { force: true });
  }
  const fileName = sanitizeFileName(name);
  const target = safeInsideProject(join(dir, fileName));
  await writeFile(target, buffer);
  const storage = await syncProjectAssetToObjectStorage(target, VIDEO_EXTS.has(extname(fileName).toLowerCase()) ? "competitor_video" : "competitor_image");
  if (VIDEO_EXTS.has(extname(fileName).toLowerCase())) {
    const videoPromptPath = safeInsideProject(join(dir, "视频反推提示词.txt"));
    let coverPath = "";
    const specialRequirementPath = safeInsideProject(join(dir, "\u7528\u6237\u7279\u6b8a\u8981\u6c42.txt"));
    let analysis = null;
    if (coverImageBuffer?.length) {
      const coverName = sanitizeFileName(coverImageName || `${parse(fileName).name}_封面.jpg`).replace(/\.[^.]+$/, ".jpg");
      coverPath = safeInsideProject(join(dir, coverName));
      await writeFile(coverPath, coverImageBuffer);
      await syncProjectAssetToObjectStorage(coverPath, "competitor_video_cover");
      analysis = await analyzeUploadedCompetitorImage(coverPath, { type: "video", fileName });
    }
    let transcript = await transcribeVideoDialogue(target).catch((error) => ({ error: error.message }));
    if (!transcript?.text && sourceVideoUrl) {
      transcript = await transcribeVideoDialogue(sourceVideoUrl).catch((error) => ({ error: error.message }));
    }
    if (analysis) analysis.dialogue = transcriptToDialogue(transcript);
    else analysis = { dialogue: transcriptToDialogue(transcript) };
    const reverseRequirement = specialRequirementJson({ type: "video", fileName, analysis });
    const videoPrompt = specialRequirementForVideoPrompt(reverseRequirement) || defaultVideoReversePrompt(fileName);
    const specialRequirement = "";
    await writeFile(videoPromptPath, videoPrompt, "utf8");
    await writeFile(specialRequirementPath, specialRequirement, "utf8");
    return { ok: true, path: target, name: fileName, coverPath, videoPromptPath, videoPrompt, specialRequirementPath, specialRequirement, ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl, url: storage.storageUrl } : {}) };
  }
  const analysis = await analyzeUploadedCompetitorImage(target);
  const specialRequirementPath = safeInsideProject(join(dir, "\u7528\u6237\u7279\u6b8a\u8981\u6c42.txt"));
  const imagePromptPath = safeInsideProject(join(dir, "图片反推提示词.txt"));
  const reverseRequirement = specialRequirementJson({ type: "image", fileName, analysis });
  const imagePrompt = specialRequirementForImagePrompt(reverseRequirement);
  const specialRequirement = "";
  await writeFile(imagePromptPath, imagePrompt, "utf8");
  await writeFile(specialRequirementPath, specialRequirement, "utf8");
  return { ok: true, path: target, name: fileName, imagePromptPath, imagePrompt, specialRequirementPath, specialRequirement, ...(storage ? { storageKey: storage.storageKey, storageUrl: storage.storageUrl, url: storage.storageUrl } : {}) };
}

function defaultVideoReversePrompt(fileName) {
  return `请把当前上传的竞品视频 ${fileName} 当作视频节奏参考，而不是IP复制对象。生成视频时先反推并参考它的广告结构：前3秒钩子、镜头推进方式、主体入场方向、角色互动、道具使用、UI或文案出现时机、情绪变化、高潮记忆点、结尾停留方式。只保留抽象节奏、镜头语言、动作强弱关系和转化节拍，不复制竞品角色、logo、UI文字、品牌名、具体场景、专有道具或画面细节。只有当前视频明确是战斗/塔防玩法时，才参考攻击因果、升级节奏、怪物进攻或战斗UI；否则必须保持当前视频的非战斗广告类型，不要强行加入怪物、攻击、技能、升级卡或塔防元素。请结合上一阶段 codex-gpt-image-2 生成的我方效果图，重写成我方角色与素材的原创15秒竖屏9:16 Seedance视频。`;
}

async function transcribeVideoDialogue(videoPath) {
  const attempts = [
    ["asr", "transcribe", videoPath, "--language", "en-US", "--format", extname(videoPath).slice(1) || "mp4"],
    ["asr", "transcribe", videoPath, "--language", "zh-CN", "--format", extname(videoPath).slice(1) || "mp4"]
  ];
  let lastError = null;
  for (const args of attempts) {
    try {
      const { stdout, stderr } = await execTai(args);
      const raw = `${stdout}\n${stderr}`.trim();
      const text = extractTranscriptText(raw);
      if (text) return { text, language: args.includes("en-US") ? "en-US" : "zh-CN", raw };
      lastError = new Error("ASR 未识别到台词");
    } catch (error) {
      lastError = error;
    }
  }
  return { text: "", language: "", error: lastError?.message || "ASR failed" };
}

function extractTranscriptText(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    return String(json.text || json.transcript || json.result?.text || json.data?.text || "").trim();
  } catch {
    // CLI may print plain transcript or status lines. Keep user-facing speech-like lines.
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, "").trim())
    .filter((line) => line && !/^(task|status|model|file|url|duration|language|success|upload|result)[:：]/i.test(line))
    .join("\n")
    .trim();
}

function transcriptToDialogue(transcript = {}) {
  const text = String(transcript.text || "").trim();
  if (!text) return {
    has_dialogue: false,
    language: "",
    original_lines: [],
    preserve_language: true,
    instruction: transcript.error
      ? `ASR未识别到明确台词：${transcript.error}。如果原视频画面有人物口型、口播节奏、字幕或对白气口，新视频仍需生成同语种、极短、自然的人物语音；不要生成完全静音视频。`
      : "未检测到明确台词；如参考视频明显有人说话，新视频仍需生成同语种、极短、自然的人物语音，不要完全静音。"
  };
  const lines = text.split(/\r?\n|(?<=[.!?。！？])\s+/).map((line) => line.trim()).filter(Boolean).slice(0, 12);
  const language = transcript.language || detectDialogueLanguage(text);
  return {
    has_dialogue: true,
    language,
    original_lines: lines,
    preserve_language: true,
    instruction: `ASR提取到原视频台词。新视频必须保持原台词语种 ${language || "原语种"}，除非用户明确要求翻译或改语种。`
  };
}

async function searchGuangdada(body) {
  const keyWord = String(body.keyWord ?? "").trim();
  if (!keyWord) throw new Error("请输入广大大搜索关键词");
  assertZingApiConfig();
  const minPopularity = Math.max(0, Number(body.minPopularity ?? 0));
  const topN = Math.max(1, Math.min(10, Number(body.topN ?? 10)));
  const materialType = ["all", "image", "video"].includes(String(body.materialType ?? "")) ? String(body.materialType) : "image";
  const startDate = parseDateFilter(body.startDate);
  const endDate = parseDateFilter(body.endDate, true);
  const cacheKey = guangdadaCacheKey({ keyWord, minPopularity, topN, materialType, startDate: body.startDate || "", endDate: body.endDate || "" });
  const cached = await readGuangdadaCache(cacheKey);
  if (cached) return { ...cached, cached: true };
  const dateChunks = guangdadaDateChunks(startDate, endDate);
  const maxPagesPerChunk = guangdadaMaxPagesForThreshold(minPopularity);
  const itemMap = new Map();
  let total = 0;
  let lastPayload = null;
  for (const chunk of dateChunks) {
    const basePayload = buildGuangdadaSearchPayload({ keyWord, startDate: chunk.startDate, endDate: chunk.endDate, materialType, minPopularity });
    for (let page = 1; page <= maxPagesPerChunk; page += 1) {
      const payload = { ...basePayload, page };
      lastPayload = payload;
      const data = await zingApiRequest("creative-list", `/zingapi/v1/creative/list/${encodeURIComponent(ZINGAPI_CUSTOMER_NAME)}`, payload);
      const list = data?.data?.creative_list ?? data?.creative_list ?? [];
      const remoteTotal = Number(data?.data?.total_count ?? data?.total_count ?? 0) || 0;
      total = Math.max(total, remoteTotal);
      if (!remoteTotal) total += list.length;
      for (const item of list.map(normalizeGuangdadaItem)) {
        if (!matchGuangdadaDateRange(item, startDate, endDate)) continue;
        if (!item.imageUrl || !matchGuangdadaMaterialType(item, materialType) || item.popularity < minPopularity) continue;
        keepBestGuangdadaItem(itemMap, item);
      }
      if (list.length < basePayload.page_size || itemMap.size >= topN) break;
    }
  }
  const items = await hydrateGuangdadaVideoUrls(Array.from(itemMap.values()))
    .then((hydrated) => hydrated
    .sort((a, b) => b.popularity - a.popularity || normalizeUnixMs(b.timestamp) - normalizeUnixMs(a.timestamp))
    .slice(0, topN));
  const result = { ok: true, cached: false, query: lastPayload, minPopularity, materialType, startDate: body.startDate || "", endDate: body.endDate || "", scannedPagesPerChunk: maxPagesPerChunk, total, count: items.length, items };
  await writeGuangdadaCache(cacheKey, result);
  return result;
}

async function hydrateGuangdadaVideoUrls(items) {
  const hydrated = [];
  for (const item of items) {
    if (item.isVideoMaterial && !item.videoUrl && item.adKey) {
      try {
        const detailUrls = await guangdadaDetailUrls(item);
        const videoUrl = detailUrls.videos[0] || "";
        if (videoUrl) {
          hydrated.push({
            ...item,
            videoUrl,
            proxyVideoUrl: `/api/guangdada/video?url=${encodeURIComponent(videoUrl)}`
          });
          continue;
        }
      } catch {
        // Keep the list result usable even when a detail request fails.
      }
    }
    hydrated.push(item);
  }
  return hydrated;
}

function guangdadaCacheKey(value) {
  return sha256Hex(JSON.stringify(value)).slice(0, 32);
}

async function readGuangdadaCache(cacheKey) {
  const cachePath = join(dirs().guangdadaCacheDir, `${cacheKey}.json`);
  if (!existsSync(cachePath)) return null;
  try {
    const data = JSON.parse(await readFile(cachePath, "utf8"));
    const createdAt = Date.parse(data.createdAt || "");
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > 30 * 24 * 60 * 60 * 1000) {
      await rm(cachePath, { force: true }).catch(() => {});
      return null;
    }
    const result = data.result || null;
    if (result?.items?.some((item) => item?.isVideoMaterial && !item?.videoUrl && item?.adKey)) {
      result.items = await hydrateGuangdadaVideoUrls(result.items);
      await writeGuangdadaCache(cacheKey, result).catch(() => {});
    }
    return result;
  } catch {
    await rm(cachePath, { force: true }).catch(() => {});
    return null;
  }
}

async function writeGuangdadaCache(cacheKey, result) {
  await mkdir(dirs().guangdadaCacheDir, { recursive: true });
  const cachePath = join(dirs().guangdadaCacheDir, `${cacheKey}.json`);
  await writeFile(cachePath, JSON.stringify({ createdAt: new Date().toISOString(), result }, null, 2), "utf8");
}

function assertZingApiConfig() {
  const missing = [];
  if (!ZINGAPI_CUSTOMER_NAME) missing.push("ZINGAPI_CUSTOMER_NAME");
  if (!ZINGAPI_ACCESS_KEY_ID) missing.push("ZINGAPI_ACCESS_KEY_ID");
  if (!ZINGAPI_ACCESS_KEY_SECRET) missing.push("ZINGAPI_ACCESS_KEY_SECRET");
  if (missing.length) throw new Error(`ZingAPI 未配置：请在 D:\\Aigc-platform\\.env 中配置 ${missing.join(", ")}`);
}

function stableJsonStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
}

function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function zingAuthorization({ method, path, query = "", headers, bodyText }) {
  const signedHeaderNames = Object.keys(headers).map((key) => key.toLowerCase()).sort();
  const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value).trim()]));
  const canonicalHeaders = signedHeaderNames.map((key) => `${key}:${lowerHeaders[key]}\n`).join("");
  const signedHeaders = signedHeaderNames.join(";");
  const canonicalRequest = [
    method.toUpperCase(),
    path,
    query,
    canonicalHeaders,
    signedHeaders,
    sha256Hex(bodyText)
  ].join("\n");
  const stringToSign = `zf3-HMAC-SHA256\n${sha256Hex(canonicalRequest)}`;
  const signature = createHmac("sha256", ZINGAPI_ACCESS_KEY_SECRET).update(stringToSign, "utf8").digest("hex");
  return `zf3-HMAC-SHA256 Credential=${ZINGAPI_ACCESS_KEY_ID},SignedHeaders=${signedHeaders},Signature=${signature}`;
}

async function zingApiRequest(action, path, payload) {
  assertZingApiConfig();
  const bodyText = JSON.stringify(payload);
  const contentHash = sha256Hex(bodyText);
  const headersToSign = {
    "content-type": "application/json; charset=utf-8",
    "x-zf-action": action,
    "x-zf-content-sha256": contentHash,
    "x-zf-date": new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    "x-zf-nonce": randomUUID(),
    "x-zf-version": ZINGAPI_VERSION
  };
  const authorization = zingAuthorization({ method: "POST", path, headers: headersToSign, bodyText });
  const res = await fetch(`https://${ZINGAPI_HOST}${path}`, {
    method: "POST",
    headers: {
      host: ZINGAPI_HOST,
      ...headersToSign,
      "x-timezone": "+0800",
      Authorization: authorization
    },
    body: bodyText
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`ZingAPI 返回非 JSON：HTTP ${res.status} ${text.slice(0, 300)}`);
  }
  if (!res.ok || (data.message && data.message !== "success") || data.code || data.error) {
    const rawMessage = String(data.message || data.error || data.code || text.slice(0, 300));
    const authHint = rawMessage === "invalid auth argument"
      ? "（AccessKeyId 已被服务端识别，但签名校验未通过；请核对 ZINGAPI_ACCESS_KEY_SECRET、customer_name 是否绑定该 key，并让 ZingAPI 供应商按 trace_id 核查签名串）"
      : "";
    const detail = [
      `${rawMessage}${authHint}`,
      data.trace_id ? `trace_id=${data.trace_id}` : "",
      data.request_id ? `request_id=${data.request_id}` : ""
    ].filter(Boolean).join(" ");
    throw new Error(`ZingAPI 请求失败：HTTP ${res.status} ${detail}`);
  }
  return data;
}

function keepBestGuangdadaItem(map, item) {
  const key = guangdadaDedupKey(item);
  if (!key) return;
  const existing = map.get(key);
  if (!existing || item.popularity > existing.popularity || (item.popularity === existing.popularity && normalizeUnixMs(item.timestamp) > normalizeUnixMs(existing.timestamp))) {
    map.set(key, item);
  }
}

function guangdadaDedupKey(item) {
  return String(item.imageHash || normalizeMaterialUrl(item.imageUrl) || item.id || "").toLowerCase();
}

function guangdadaMaxPagesForThreshold(minPopularity) {
  if (minPopularity <= 1000) return 20;
  if (minPopularity <= 10000) return 15;
  if (minPopularity <= 50000) return 10;
  return 5;
}

function guangdadaDateChunks(startDate, endDate) {
  if (!startDate || !endDate) return [{ startDate, endDate }];
  const dayMs = 24 * 60 * 60 * 1000;
  if (endDate - startDate <= 45 * dayMs) return [{ startDate, endDate }];
  const chunks = [];
  let chunkEnd = endDate;
  while (chunkEnd >= startDate) {
    const chunkStart = Math.max(startDate, chunkEnd - 30 * dayMs + 1);
    chunks.push({ startDate: chunkStart, endDate: chunkEnd });
    chunkEnd = chunkStart - 1;
  }
  return chunks;
}

function buildGuangdadaSearchPayload({ keyWord, startDate, endDate, materialType, minPopularity = 0 }) {
  const now = Date.now();
  const seenBegin = startDate ? Math.floor(startDate / 1000) : Math.floor((now - 365 * 24 * 60 * 60 * 1000) / 1000);
  const seenEnd = endDate ? Math.floor(endDate / 1000) : Math.floor(now / 1000);
  const adsType = materialType === "image" ? [1] : materialType === "video" ? [2] : [1, 2];
  const payload = {
    page: 1,
    page_size: 20,
    seen_begin: seenBegin,
    seen_end: seenEnd,
    sort_field: "-heat_degree",
    duplicate_removal: 1,
    search_type: "1",
    keyword: keyWord,
    complete_country_match: false,
    fb_merge: false,
    new_ads_flag: 0,
    original_flag: 0,
    is_dynamic: 0,
    landing_page: 0,
    app_type: 1,
    ads_type: adsType
  };
  return payload;
}

function normalizeGuangdadaItem(item) {
  const imageUrl = item.preview_img_url || item.preview_image_url || item.image_url || item.logo_url || item.cover_url || "";
  const videoUrl = item.video_url || item.play_url || item.source_url || (Array.isArray(item.resource_urls) ? item.resource_urls.find((res) => res?.video_url)?.video_url : "") || "";
  const timestamp = Number(item.last_seen ?? item.first_seen ?? item.created_at ?? item.updated_at ?? 0);
  const videoDuration = Number(item.video_duration ?? item.duration ?? 0);
  const resourceType = Number(item.resource_type ?? item.material_type_id ?? item.type ?? 0);
  const typeText = String([
    item.material_type,
    item.creative_type,
    item.resource_type,
    item.ad_format,
    item.format,
    item.type_name
  ].filter(Boolean).join(" ")).toLowerCase();
  const adsType = Number(item.ads_type ?? 0);
  const exposureValue = Number(item.all_exposure_value ?? item.exposure_value ?? item.exposure ?? 0);
  const viewValue = Number(item.view_count || item.impression || 0);
  const heatValue = Number(item.heat ?? item.hot ?? 0);
  const explicitPopularity = Number(item.popularity ?? 0);
  const popularity = Math.max(heatValue, explicitPopularity, exposureValue, viewValue);
  const hasVideoSignal = Boolean(
    adsType === 2 ||
    resourceType === 2 ||
    videoDuration > 0 ||
    item.video_url ||
    item.video_cover_url ||
    item.video2pic ||
    item.play_url ||
    item.video_id ||
    /\b(video|mp4|mov|m3u8)\b/i.test(typeText) ||
    /视频|短剧|短视频|素材视频/.test(typeText)
  );
  const hasStillImageSignal = Boolean(item.preview_img_url || item.preview_image_url || item.image_url || item.logo_url || isLikelyImageUrl(imageUrl));
  const isVideoMaterial = hasVideoSignal;
  const isImageMaterial = Boolean(imageUrl && (adsType === 1 || hasStillImageSignal) && !hasVideoSignal);
  return {
    id: String(item.ad_key || item.creative_id || item.id || item.image_ahash_md5 || imageUrl),
    title: String(item.title || item.body || item.advertiser_name || "未命名素材").slice(0, 120),
    advertiser: String(item.advertiser_name || item.page_name || item.app_developer || ""),
    popularity,
    heat: heatValue,
    exposure: exposureValue,
    views: viewValue,
    likes: Number(item.like_count ?? 0),
    platform: Array.isArray(item.platform) ? item.platform.join(", ") : String(item.platform || ""),
    adsType,
    resourceType,
    videoDuration,
    isVideoMaterial,
    isImageMaterial,
    imageHash: String(item.image_ahash_md5 || item.image_md5 || ""),
    adKey: String(item.ad_key || ""),
    appType: Number(item.app_type ?? 1),
    searchFlag: String(item.search_flag ?? ""),
    firstSeen: Number(item.first_seen ?? 0),
    lastSeen: Number(item.last_seen ?? 0),
    createdAt: Number(item.created_at ?? 0),
    timestamp,
    dateLabel: timestamp ? new Date(normalizeUnixMs(timestamp)).toISOString().slice(0, 10) : "",
    imageUrl,
    videoUrl,
    proxyUrl: `/api/guangdada/image?url=${encodeURIComponent(imageUrl)}`,
    proxyVideoUrl: videoUrl ? `/api/guangdada/video?url=${encodeURIComponent(videoUrl)}` : "",
    raw: item
  };
}

function matchGuangdadaMaterialType(item, materialType) {
  if (materialType === "all") return item.isImageMaterial || item.isVideoMaterial;
  if (materialType === "video") return item.isVideoMaterial;
  return item.isImageMaterial;
}

function normalizeMaterialUrl(value) {
  try {
    const url = new URL(String(value));
    url.search = "";
    return url.toString().toLowerCase();
  } catch {
    return String(value ?? "").trim().toLowerCase();
  }
}

function isLikelyImageUrl(value) {
  try {
    const pathname = new URL(String(value)).pathname.toLowerCase();
    return /\.(png|jpe?g|webp|gif|avif)(?:$|\?)/i.test(pathname);
  } catch {
    return false;
  }
}

function isLikelyVideoUrl(value) {
  try {
    const pathname = new URL(String(value)).pathname.toLowerCase();
    return /\.(mp4|webm|mov|m3u8)(?:$|\?)/i.test(pathname);
  } catch {
    return false;
  }
}

function parseDateFilter(value, endOfDay = false) {
  const text = String(value ?? "").trim();
  if (!text) return null;
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("日期格式必须是 YYYY-MM-DD");
  const date = new Date(`${text}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}+08:00`);
  return Number.isNaN(date.getTime()) ? null : date.getTime();
}

function normalizeUnixMs(value) {
  const number = Number(value || 0);
  return number > 100000000000 ? number : number * 1000;
}

function matchGuangdadaDateRange(item, startDate, endDate) {
  if (!startDate && !endDate) return true;
  const rawTimes = [item.firstSeen, item.lastSeen, item.createdAt, item.timestamp].filter(Boolean);
  if (!rawTimes.length) return true;
  return rawTimes.some((time) => {
    const ms = normalizeUnixMs(time);
    return (!startDate || ms >= startDate) && (!endDate || ms <= endDate);
  });
}

async function importGuangdadaMaterial(body) {
  const runState = getRunState();
  if (runState.running) throw new Error("Batch is running; cannot replace competitor material now");
  const folder = validateCompetitorFolderName(body.folder);
  const imageUrl = String(body.imageUrl ?? "").trim();
  const videoUrl = String(body.videoUrl ?? "").trim();
  const detailUrls = await guangdadaDetailUrls(body).catch(() => ({ images: [], videos: [] }));
  const isVideo = Boolean(body.isVideoMaterial || videoUrl || detailUrls.videos.length);
  if (!imageUrl && !videoUrl) throw new Error("缺少有效的广大大素材链接");
  const candidates = isVideo ? [videoUrl, ...detailUrls.videos].filter(Boolean) : [imageUrl, ...detailUrls.images].filter(Boolean);
  const coverCandidates = isVideo ? [imageUrl, ...detailUrls.images].filter(Boolean) : [];
  let buffer = null;
  let coverImageBuffer = null;
  let lastError = null;
  for (const candidate of [...new Set(candidates)].filter(Boolean)) {
    try {
      buffer = isVideo ? await downloadRemoteBinary(candidate) : await downloadRemoteImage(candidate, body.title || body.id || "guangdada.jpg");
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!buffer) throw lastError || new Error(isVideo ? "广大大视频下载失败" : "广大大图片下载失败");
  if (isVideo) {
    for (const candidate of [...new Set(coverCandidates)].filter(Boolean)) {
      try {
        coverImageBuffer = await downloadRemoteImage(candidate, body.title || body.id || "guangdada_cover.jpg");
        break;
      } catch {
        // Cover is best-effort; the video can still be imported.
      }
    }
  }
  const sourceUrl = candidates[0] || imageUrl || videoUrl;
  const ext = extname(new URL(sourceUrl).pathname).toLowerCase();
  const safeExt = isVideo ? (VIDEO_EXTS.has(ext) ? ext : ".mp4") : (IMAGE_EXTS.has(ext) ? ext : ".jpg");
  const base = sanitizeFileName(String(body.title || body.id || "guangdada").slice(0, 60)).replace(/\.[^.]+$/, "");
  return replaceCompetitorMaterial({ folder, name: `${base}${safeExt}`, buffer, coverImageBuffer, coverImageName: `${base}_封面.jpg`, sourceVideoUrl: isVideo ? (videoUrl || detailUrls.videos[0] || "") : "" });
}

async function guangdadaDetailUrls(body) {
  const adKey = String(body.adKey ?? body.raw?.ad_key ?? "").trim();
  if (!adKey) return { images: [], videos: [] };
  const params = new URLSearchParams({ ad_key: adKey, app_type: String(body.appType ?? 1) });
  if (body.searchFlag) params.set("search_flag", String(body.searchFlag));
  const res = await fetch(`http://120.27.200.123:3000/api/guangdada/creative-detail?${params.toString()}`);
  const detail = await res.json().catch(() => null);
  const data = detail?.data?.data ?? detail?.data ?? {};
  const urls = [
    ...(Array.isArray(data.cdn_url) ? data.cdn_url : []),
    ...(Array.isArray(data.cdn_url_by_nation) ? data.cdn_url_by_nation : []),
    ...(Array.isArray(data.resource_urls) ? data.resource_urls.flatMap((item) => [item.image_url, item.video_url]) : []),
    data.preview_img_url,
    data.logo_url,
    data.video_url,
    data.play_url,
    data.source_url
  ].filter(Boolean);
  return { images: urls.filter(isLikelyImageUrl), videos: urls.filter(isLikelyVideoUrl) };
}

async function guangdadaDetailImageUrls(body) {
  return (await guangdadaDetailUrls(body)).images;
}

async function downloadRemoteImage(imageUrl, fileName = "guangdada.jpg") {
  const safeName = sanitizeFileName(fileName).replace(/\.[^.]+$/, "") || "guangdada";
  const candidates = [
    imageUrl,
    `http://120.27.200.123:3000/api/proxy-media?url=${encodeURIComponent(imageUrl)}`,
    `http://120.27.200.123:3000/api/download-image?url=${encodeURIComponent(imageUrl)}&filename=${encodeURIComponent(`${safeName}.jpg`)}`
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      return await tryDownloadImage(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("广大大图片下载失败");
}

async function downloadRemoteBinary(url) {
  const candidates = [
    { url, headers: { "User-Agent": "Mozilla/5.0", Accept: "video/mp4,video/*,*/*;q=0.8" } },
    { url, headers: { "User-Agent": "Mozilla/5.0", Accept: "video/mp4,video/*,*/*;q=0.8", Referer: "" } },
    { url: `http://120.27.200.123:3000/api/proxy-media?url=${encodeURIComponent(url)}`, headers: { "User-Agent": "Mozilla/5.0", Accept: "video/mp4,video/*,*/*;q=0.8" } }
  ];
  let lastError = null;
  for (const candidate of candidates) {
    try {
      const res = await fetch(candidate.url, { headers: candidate.headers });
      const buffer = Buffer.from(await res.arrayBuffer());
      const contentType = res.headers.get("content-type") || "";
      if (!res.ok) throw new Error(`下载失败 HTTP ${res.status}`);
      if (!buffer.length) throw new Error("下载内容为空");
      if (!contentType.startsWith("video/") && !isLikelyVideoBuffer(buffer)) {
        throw new Error(`下载内容不是视频：${contentType || "unknown"}`);
      }
      return buffer;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("下载失败");
}

function isLikelyVideoBuffer(buffer) {
  if (!buffer?.length || buffer.length < 12) return false;
  const head = buffer.toString("ascii", 0, Math.min(buffer.length, 64));
  return head.includes("ftyp") || head.includes("webm") || head.includes("moov") || head.includes("mdat");
}

async function tryDownloadImage(imageUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  const res = await fetch(imageUrl, {
    signal: controller.signal,
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36",
      Accept: "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"
    }
  }).finally(() => clearTimeout(timeout));
  const contentType = res.headers.get("content-type") || "";
  const buffer = Buffer.from(await res.arrayBuffer());
  if (!res.ok) throw new Error(`图片下载失败 HTTP ${res.status}`);
  if (!contentType.startsWith("image/") && !isImageBuffer(buffer)) {
    throw new Error(`下载内容不是图片：${contentType || "unknown"}`);
  }
  return buffer;
}

async function proxyGuangdadaImage(req, res, url) {
  const imageUrl = String(url.searchParams.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(imageUrl)) throw new Error("缺少有效的图片链接");
  assertAllowedGuangdadaMediaUrl(imageUrl);
  const cacheKey = imageUrl;
  const cached = remoteImageCache.get(cacheKey);
  if (cached && Date.now() - cached.time < 20 * 60 * 1000) {
    res.writeHead(200, {
      "Content-Type": cached.contentType,
      "Cache-Control": "public, max-age=600",
      "Content-Length": cached.buffer.length
    });
    res.end(cached.buffer);
    return;
  }
  const buffer = await downloadRemoteImage(imageUrl, "guangdada.jpg");
  const contentType = detectImageContentType(buffer);
  remoteImageCache.set(cacheKey, { time: Date.now(), buffer, contentType });
  if (remoteImageCache.size > 180) {
    const firstKey = remoteImageCache.keys().next().value;
    remoteImageCache.delete(firstKey);
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": "public, max-age=600",
    "Content-Length": buffer.length
  });
  res.end(buffer);
}

async function proxyGuangdadaVideo(req, res, url) {
  const videoUrl = String(url.searchParams.get("url") ?? "").trim();
  if (!/^https?:\/\//i.test(videoUrl)) throw new Error("缺少有效的视频链接");
  assertAllowedGuangdadaMediaUrl(videoUrl);
  const cacheKey = videoUrl;
  let cached = remoteVideoCache.get(cacheKey);
  if (!cached || Date.now() - cached.time > 20 * 60 * 1000) {
    const buffer = await downloadRemoteBinary(videoUrl);
    const head = buffer.toString("ascii", 0, Math.min(buffer.length, 64)).toLowerCase();
    const contentType = head.includes("webm") ? "video/webm" : "video/mp4";
    cached = { time: Date.now(), buffer, contentType };
    remoteVideoCache.set(cacheKey, cached);
    if (remoteVideoCache.size > 40) {
      const firstKey = remoteVideoCache.keys().next().value;
      remoteVideoCache.delete(firstKey);
    }
  }
  const total = cached.buffer.length;
  const range = String(req.headers.range || "");
  if (range) {
    const match = range.match(/bytes=(\d*)-(\d*)/);
    const startByte = match?.[1] ? Number(match[1]) : 0;
    const endByte = match?.[2] ? Math.min(Number(match[2]), total - 1) : total - 1;
    if (Number.isFinite(startByte) && Number.isFinite(endByte) && startByte <= endByte && startByte < total) {
      res.writeHead(206, {
        "Content-Type": cached.contentType,
        "Accept-Ranges": "bytes",
        "Cache-Control": "public, max-age=300",
        "Content-Range": `bytes ${startByte}-${endByte}/${total}`,
        "Content-Length": endByte - startByte + 1
      });
      res.end(cached.buffer.subarray(startByte, endByte + 1));
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": cached.contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "public, max-age=300",
    "Content-Length": total
  });
  res.end(cached.buffer);
}

function assertAllowedGuangdadaMediaUrl(value) {
  const { hostname } = new URL(String(value));
  const host = hostname.toLowerCase();
  if (host === "120.27.200.123" || host === "zingfront.com" || host.endsWith(".zingfront.com")) return;
  throw new Error("Unsupported Guangdada media host");
}

function detectImageContentType(buffer) {
  if (buffer.length >= 8 && buffer.toString("ascii", 1, 4) === "PNG") return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return "image/gif";
  return "image/jpeg";
}

function isImageBuffer(buffer) {
  if (!buffer?.length) return false;
  if (buffer.length >= 8 && buffer.toString("ascii", 1, 4) === "PNG") return true;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return true;
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return true;
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) return true;
  return false;
}

function sendJson(res, data, status = 200) {
  const body = Buffer.from(JSON.stringify(data), "utf8");
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": body.length });
  res.end(body);
}

function sendError(res, error, status = 500) {
  sendJson(res, { error: error.message ?? String(error) }, error.status || status);
}

function contentTypeForFile(fullPath) {
  const ext = extname(fullPath).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  if (ext === ".mp4") return "video/mp4";
  if (ext === ".webm") return "video/webm";
  if (ext === ".mov") return "video/quicktime";
  return "application/octet-stream";
}

function attachmentNameForFile(fullPath) {
  const raw = basename(fullPath) || "download";
  return raw.replace(/["\r\n]/g, "_");
}

function localFileUrl(fullPath, version = "") {
  const suffix = version ? `&v=${encodeURIComponent(version)}` : "";
  return `/file?path=${encodeURIComponent(fullPath)}${suffix}`;
}

async function projectAssetMetadata(fullPath) {
  try {
    const descriptor = projectStorageDescriptor({
      fullPath,
      userRoot: dirs().projectRoot,
      sharedRoot: dirs().sharedProjectRoot,
      userId: currentUserId()
    });
    return getRecordedAssetMetadata({
      root: descriptor.root,
      relativePath: descriptor.relativePath
    });
  } catch {
    return null;
  }
}

async function publicUrlForProjectFile(fullPath, version = "") {
  const metadata = await projectAssetMetadata(fullPath);
  return metadata?.storageUrl || localFileUrl(fullPath, version);
}

async function syncProjectAssetToObjectStorage(fullPath, assetKind = "file") {
  if (!objectStorageEnabled()) return null;
  try {
    return await uploadProjectAsset({
      fullPath,
      userRoot: dirs().projectRoot,
      sharedRoot: dirs().sharedProjectRoot,
      userId: currentUserId(),
      assetKind,
      contentType: contentTypeForFile(fullPath)
    });
  } catch (error) {
    console.warn(`[object-storage] failed to upload ${assetKind}: ${error.message}`);
    return null;
  }
}

async function removeProjectAssetFromObjectStorage(fullPath) {
  if (!objectStorageEnabled()) return null;
  try {
    const descriptor = projectStorageDescriptor({
      fullPath,
      userRoot: dirs().projectRoot,
      sharedRoot: dirs().sharedProjectRoot,
      userId: currentUserId()
    });
    const metadata = await getRecordedAssetMetadata({
      root: descriptor.root,
      relativePath: descriptor.relativePath
    });
    if (metadata?.storageKey) await deleteObject(metadata.storageKey);
    await deleteRecordedAssetMetadata({
      root: descriptor.root,
      relativePath: descriptor.relativePath
    });
    return metadata;
  } catch (error) {
    console.warn(`[object-storage] failed to delete object: ${error.message}`);
    return null;
  }
}

async function sendProjectFile(req, res, fullPath) {
  const info = await stat(fullPath);
  const ext = extname(fullPath).toLowerCase();
  const contentType = contentTypeForFile(fullPath);
  const isVideo = VIDEO_EXTS.has(ext);
  if (isVideo && req.headers.range) {
    const match = String(req.headers.range).match(/bytes=(\d*)-(\d*)/);
    const start = match?.[1] ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), info.size - 1) : info.size - 1;
    if (Number.isFinite(start) && Number.isFinite(end) && start <= end) {
      res.writeHead(206, {
        "Content-Type": contentType,
        "Accept-Ranges": "bytes",
        "Content-Range": `bytes ${start}-${end}/${info.size}`,
        "Content-Length": end - start + 1
      });
      return createReadStream(fullPath, { start, end }).pipe(res);
    }
  }
  res.writeHead(200, {
    "Content-Type": contentType,
    "Content-Length": info.size,
    ...(isVideo ? { "Accept-Ranges": "bytes" } : {})
  });
  return createReadStream(fullPath).pipe(res);
}

async function sendPublicAsset(req, res, storageKey) {
  const key = String(storageKey || "").replace(/^\/+/, "");
  if (!key || key.includes("..")) {
    return sendJson(res, { error: "asset not found" }, 404);
  }
  if (process.env.S3_PUBLIC_BASE_URL) {
    res.writeHead(302, { Location: buildPublicUrl(key) });
    res.end();
    return;
  }
  if (!objectStorageEnabled()) {
    return sendJson(res, { error: "object storage is not configured" }, 404);
  }
  try {
    const range = /^bytes=\d*-\d*$/i.test(String(req.headers.range || "")) ? String(req.headers.range) : "";
    const payload = await openObjectStream(key, { range });
    const headers = {
      "Content-Type": payload.contentType,
      "Cache-Control": payload.cacheControl
    };
    if (payload.contentLength != null) headers["Content-Length"] = String(payload.contentLength);
    if (payload.contentRange) headers["Content-Range"] = payload.contentRange;
    if (payload.acceptRanges || range) headers["Accept-Ranges"] = payload.acceptRanges || "bytes";
    res.writeHead(payload.contentRange ? 206 : 200, headers);
    payload.body.on("error", (error) => {
      console.warn(`[object-storage] stream failed: ${error.message}`);
      if (!res.headersSent) sendJson(res, { error: "asset not found" }, 404);
      else res.destroy(error);
    });
    return payload.body.pipe(res);
  } catch {
    return sendJson(res, { error: "asset not found" }, 404);
  }
}

function safeInsideProject(path) {
  return resolveProjectFilePath(path, {
    userRoot: dirs().projectRoot,
    sharedRoot: dirs().sharedProjectRoot
  });
}

async function withRequestScope(req, res, handler, options = {}) {
  const cookies = parseCookies(req);
  const user = await userFromRequest(req);
  if (!user) {
    if (typeof options.onUnauthenticated === "function") return options.onUnauthenticated();
    return sendJson(res, { error: "请先登录" }, 401);
  }
  const userId = user.username;
  const cookieBase = cookies[PROJECT_ROOT_COOKIE_NAME] ? resolve(cookies[PROJECT_ROOT_COOKIE_NAME]) : projectRoot;
  const configuredBase = savedProjects.some((item) => item.path === cookieBase) ? cookieBase : projectRoot;
  const allowedBase = await firstUsableProjectRoot(configuredBase);
  if (cookies[PROJECT_ROOT_COOKIE_NAME] !== allowedBase) {
    appendCookie(res, `${PROJECT_ROOT_COOKIE_NAME}=${encodeURIComponent(allowedBase)}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  const scopedProjectRoot = userProjectRoot(allowedBase, userId);
  await ensureProjectStructure(scopedProjectRoot);
  await ensureProjectStructure(allowedBase);
  return requestScope.run({ userId, user: publicUser(user), baseProjectRoot: allowedBase, userProjectRoot: scopedProjectRoot }, handler);
}

async function serveStatic(req, res, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const fullPath = resolve(PUBLIC_DIR, relative);
  if (!fullPath.startsWith(PUBLIC_DIR) || !existsSync(fullPath)) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }
  const contentTypes = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
  res.writeHead(200, { "Content-Type": contentTypes[extname(fullPath)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(fullPath).pipe(res);
}

async function handleRequest(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/auth") {
      const user = await userFromRequest(req);
      return sendJson(res, user ? { authenticated: true, user: publicUser(user) } : { authenticated: false });
    }
    if (req.method === "POST" && url.pathname === "/api/login") return login(req, res);
    if (req.method === "POST" && url.pathname === "/api/logout") return logout(req, res);
    if (url.pathname.startsWith("/api/wangzhuan/")) {
      return handleWangzhuanRequest(req, res, url, {
        readJson,
        readMultipart,
        currentUser,
        currentUserId,
        currentProjectRoot,
        currentBaseProjectRoot,
        getLegacyRunState: getRunState,
        config: appConfig
      });
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/public/assets/")) {
      const storageKey = decodeURIComponent(url.pathname.slice("/api/public/assets/".length));
      return await sendPublicAsset(req, res, storageKey);
    }
    if (req.method === "GET" && url.pathname === "/api/materials") return sendJson(res, await loadMaterials());
    if (req.method === "GET" && url.pathname === "/api/admin/users") return sendJson(res, await listAdminUsers());
    if (req.method === "POST" && url.pathname === "/api/admin/users/create") return sendJson(res, await createAdminUser(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/admin/users/update") return sendJson(res, await updateAdminUser(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/admin/users/delete") return sendJson(res, await deleteAdminUser(await readJson(req)));
    if (req.method === "GET" && url.pathname === "/api/config") return sendJson(res, { projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), userId: currentUserId(), projects: projectList() });
    if (req.method === "POST" && url.pathname === "/api/config") {
      const result = await updateConfig(await readJson(req));
      appendCookie(res, `${PROJECT_ROOT_COOKIE_NAME}=${encodeURIComponent(currentBaseProjectRoot())}; Path=/; Max-Age=31536000; SameSite=Lax`);
      return sendJson(res, result);
    }
    if (req.method === "GET" && url.pathname === "/api/projects") return sendJson(res, { projectRoot: dirs().projectRoot, baseProjectRoot: currentBaseProjectRoot(), userId: currentUserId(), projects: projectList() });
    if (req.method === "GET" && url.pathname === "/api/profile") return sendJson(res, await getMyProfile());
    if (req.method === "POST" && url.pathname === "/api/profile") return sendJson(res, await updateMyProfile(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/model-access") return sendJson(res, await checkModelAccess(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/projects/switch") {
      const result = await switchProject(await readJson(req));
      appendCookie(res, `${PROJECT_ROOT_COOKIE_NAME}=${encodeURIComponent(currentBaseProjectRoot())}; Path=/; Max-Age=31536000; SameSite=Lax`);
      return sendJson(res, result);
    }
    if (req.method === "POST" && url.pathname === "/api/projects/create") {
      const result = await createProject(await readJson(req));
      appendCookie(res, `${PROJECT_ROOT_COOKIE_NAME}=${encodeURIComponent(currentBaseProjectRoot())}; Path=/; Max-Age=31536000; SameSite=Lax`);
      return sendJson(res, result);
    }
    if (req.method === "POST" && url.pathname === "/api/projects/rename") return sendJson(res, await renameProject(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/projects/delete") {
      const result = await deleteProject(await readJson(req));
      appendCookie(res, `${PROJECT_ROOT_COOKIE_NAME}=${encodeURIComponent(currentBaseProjectRoot())}; Path=/; Max-Age=31536000; SameSite=Lax`);
      return sendJson(res, result);
    }
    if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, getRunState());
    if (req.method === "POST" && url.pathname === "/api/start") return sendJson(res, await startBatch(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/stop") return sendJson(res, await stopBatch());
    if (req.method === "POST" && url.pathname === "/api/upload-role") return sendJson(res, await uploadRole(req));
    if (req.method === "POST" && url.pathname === "/api/materials/rename") return sendJson(res, await renameSharedMaterial(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/materials/delete") return sendJson(res, await deleteSharedMaterial(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/upload-competitor") return sendJson(res, await uploadCompetitor(req));
    if (req.method === "POST" && url.pathname === "/api/competitors/create") return sendJson(res, await createCompetitorFolder(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/competitors/delete") return sendJson(res, await deleteCompetitorFolder(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/competitors/name") return sendJson(res, await updateCompetitorName(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/guangdada/search") return sendJson(res, await searchGuangdada(await readJson(req)));
    if (req.method === "POST" && url.pathname === "/api/guangdada/import") return sendJson(res, await importGuangdadaMaterial(await readJson(req)));
    if (req.method === "GET" && url.pathname === "/api/guangdada/image") return await proxyGuangdadaImage(req, res, url);
    if (req.method === "GET" && url.pathname === "/api/guangdada/video") return await proxyGuangdadaVideo(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/global-requirement") {
      const body = await readJson(req);
      await mkdir(dirs().recordDir, { recursive: true });
      const target = safeInsideProject(dirs().globalRequirementPath);
      await writeFile(target, String(body.text ?? ""), "utf8");
      return sendJson(res, { ok: true, path: target });
    }
    if (req.method === "POST" && url.pathname === "/api/requirements") {
      const body = await readJson(req);
      const folder = basename(body.folder ?? "");
      if (!/^竞品素材\d+$/.test(folder)) throw new Error("Invalid competitor folder");
      const target = safeInsideProject(join(dirs().projectRoot, folder, "\u51fa\u56fe\u8981\u6c42.txt"));
      await writeFile(target, String(body.text ?? ""), "utf8");
      return sendJson(res, { ok: true, path: target });
    }
    if (req.method === "POST" && url.pathname === "/api/special-requirements") {
      const body = await readJson(req);
      return sendJson(res, await saveCompetitorSettings(body));
    }
    if (req.method === "POST" && url.pathname === "/api/competitor-settings") {
      return sendJson(res, await saveCompetitorSettings(await readJson(req)));
    }
    if (req.method === "POST" && url.pathname === "/api/outputs/export") {
      return await sendOutputsZip(res, await readJson(req));
    }
    if (req.method === "POST" && url.pathname === "/api/comic/generate-video") {
      return sendJson(res, await generateComicVideo(await readJson(req)));
    }
    if (req.method === "GET" && url.pathname === "/file") {
      const full = safeInsideProject(url.searchParams.get("path") ?? "");
      if (!existsSync(full)) throw new Error("File does not exist");
      if (url.searchParams.get("download") === "1") {
        res.setHeader("Content-Disposition", `attachment; filename="${attachmentNameForFile(full)}"`);
      }
      return sendProjectFile(req, res, full);
    }
    return serveStatic(req, res, url.pathname);
  } catch (error) {
    sendError(res, error);
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  const isPublicAuth = url.pathname === "/api/auth" || url.pathname === "/api/login" || url.pathname === "/api/logout";
  const isWangzhuanApi = url.pathname.startsWith("/api/wangzhuan/");
  const isPublicAsset = url.pathname.startsWith("/api/public/assets/");
  const isPublicGuangdadaPreview = req.method === "GET" && (url.pathname === "/api/guangdada/image" || url.pathname === "/api/guangdada/video");
  const isStatic = !url.pathname.startsWith("/api/") && url.pathname !== "/file";
  if (isPublicAuth || isPublicAsset || isPublicGuangdadaPreview || isStatic) {
    handleRequest(req, res).catch((error) => sendError(res, error));
    return;
  }
  withRequestScope(req, res, () => handleRequest(req, res), isWangzhuanApi ? { onUnauthenticated: () => handleRequest(req, res) } : {}).catch((error) => sendError(res, error));
});

const port = Number(process.env.PORT || 5182);
const host = process.env.HOST || "0.0.0.0";
await loadConfig();
await loadUsers();
server.listen(port, host, () => {
  console.log(`Seedance ad picture web UI: http://localhost:${port}`);
  for (const url of localNetworkUrls(port)) console.log(`LAN access: ${url}`);
});

let schedulerTimer = null;
let schedulerRunning = false;

function schedulerIntervalMs() {
  const raw = process.env.AIGC_SCHEDULER_INTERVAL_MS ?? appConfig.wangzhuan?.scheduler?.intervalMs ?? 30_000;
  return Math.max(5_000, Math.min(Number(raw) || 30_000, 10 * 60_000));
}

function schedulerEnabled() {
  const raw = process.env.AIGC_SCHEDULER_ENABLED ?? appConfig.wangzhuan?.scheduler?.enabled ?? "true";
  return String(raw).toLowerCase() !== "false";
}

function sha256Hex(value) {
  return createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function projectKeyForRoot(root) {
  return `root:${sha256Hex(root)}`;
}

function baseRootForProjectKey(projectKey) {
  if (!projectKey) return currentBaseProjectRoot();
  const candidates = savedProjects.map((item) => item.path);
  return candidates.find((item) => projectKeyForRoot(item) === projectKey) || currentBaseProjectRoot();
}

function schedulerContext(job = {}) {
  const userId = job.username || "local";
  const baseRoot = baseRootForProjectKey(job.projectKey);
  return {
    userId,
    user: { userId, username: userId, role: "admin", isAdmin: true },
    userProjectRoot: userProjectRoot(baseRoot, userId),
    sharedProjectRoot: baseRoot,
    config: appConfig,
    currentUserId: () => userId,
    currentProjectRoot: () => userProjectRoot(baseRoot, userId),
    currentBaseProjectRoot: () => baseRoot
  };
}

async function tickWangzhuanScheduler() {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    const result = await runDueSchedulerJobs(schedulerContext(), {
      workerId: `aigc-platform:${process.pid}`,
      limit: Number(process.env.AIGC_SCHEDULER_BATCH_SIZE || appConfig.wangzhuan?.scheduler?.batchSize || 5),
      lockSeconds: Number(process.env.AIGC_SCHEDULER_LOCK_SECONDS || appConfig.wangzhuan?.scheduler?.lockSeconds || 60),
      contextForJob: (job) => schedulerContext(job)
    });
    if (result.claimedCount > 0) {
      console.log(`[wangzhuan-scheduler] claimed=${result.claimedCount} succeeded=${result.succeededCount} failed=${result.failedCount}`);
    }
  } catch (error) {
    console.warn(`[wangzhuan-scheduler] tick failed: ${error.message}`);
  } finally {
    schedulerRunning = false;
  }
}

function startWangzhuanScheduler() {
  if (!schedulerEnabled() || schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    tickWangzhuanScheduler().catch((error) => {
      console.warn(`[wangzhuan-scheduler] unhandled tick failure: ${error.message}`);
    });
  }, schedulerIntervalMs());
  schedulerTimer.unref?.();
  tickWangzhuanScheduler().catch((error) => {
    console.warn(`[wangzhuan-scheduler] startup tick failed: ${error.message}`);
  });
}

function stopWangzhuanScheduler() {
  if (!schedulerTimer) return;
  clearInterval(schedulerTimer);
  schedulerTimer = null;
}

server.on("close", stopWangzhuanScheduler);
startWangzhuanScheduler();

function localNetworkUrls(port) {
  const urls = [];
  for (const items of Object.values(networkInterfaces())) {
    for (const item of items ?? []) {
      if (item.family !== "IPv4" || item.internal) continue;
      urls.push(`http://${item.address}:${port}/`);
    }
  }
  return urls;
}
