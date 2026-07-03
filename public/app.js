const state = {
  materials: null,
  user: null,
  selectedRoles: new Set(),
  selectedMonsters: new Set(),
  selectedLogos: new Set(),
  selectedCompetitors: new Set(),
  selectedBatches: new Set(),
  batchesInitialized: false,
  activeBatchTag: "",
  batchFilterTouched: false,
  competitorSettings: {},
  uploadingCompetitors: new Set(),
  guangdadaItems: [],
  guangdadaTargetFolder: "",
  pollTimer: null
};

const GUANGDADA_DISABLED = false;
const DEFAULT_OUTPUT_SIZE = "1024x1024";
function splitSizeParts(value, fallback = DEFAULT_OUTPUT_SIZE) {
  const normalized = normalizeOutputSizeInput(value) || normalizeOutputSizeInput(fallback) || DEFAULT_OUTPUT_SIZE;
  const [width, height] = normalized.split("x").map(Number);
  return { width, height, size: `${width}x${height}` };
}
const COMPETITOR_UPLOAD_TEXT = "更换素材中";

const els = {
  projectPathInput: document.querySelector("#projectPathInput"),
  projectSelect: document.querySelector("#projectSelect"),
  switchProjectBtn: document.querySelector("#switchProjectBtn"),
  renameProjectBtn: document.querySelector("#renameProjectBtn"),
  deleteProjectBtn: document.querySelector("#deleteProjectBtn"),
  savePathBtn: document.querySelector("#savePathBtn"),
  modelBadge: document.querySelector("#modelBadge"),
  runBadge: document.querySelector("#runBadge"),
  batchTag: document.querySelector("#batchTag"),
  concurrencyInput: document.querySelector("#concurrencyInput"),
  repeatCountInput: document.querySelector("#repeatCountInput"),
  outputModeSelect: document.querySelector("#outputModeSelect"),
  imageModelSelect: document.querySelector("#imageModelSelect"),
  videoModelSelect: document.querySelector("#videoModelSelect"),
  refreshBtn: document.querySelector("#refreshBtn"),
  stopBtn: document.querySelector("#stopBtn"),
  startBtn: document.querySelector("#startBtn"),
  totalCount: document.querySelector("#totalCount"),
  doneCount: document.querySelector("#doneCount"),
  skipCount: document.querySelector("#skipCount"),
  failCount: document.querySelector("#failCount"),
  roleGrid: document.querySelector("#roleGrid"),
  monsterGrid: document.querySelector("#monsterGrid"),
  logoGrid: document.querySelector("#logoGrid"),
  roleUploader: document.querySelector("#roleUploader"),
  uploadRoleBtn: document.querySelector("#uploadRoleBtn"),
  uploadMonsterBtn: document.querySelector("#uploadMonsterBtn"),
  uploadLogoBtn: document.querySelector("#uploadLogoBtn"),
  toggleRoles: document.querySelector("#toggleRoles"),
  toggleMonsters: document.querySelector("#toggleMonsters"),
  toggleLogos: document.querySelector("#toggleLogos"),
  competitorList: document.querySelector("#competitorList"),
  globalRequirementText: document.querySelector("#globalRequirementText"),
  saveGlobalRequirementBtn: document.querySelector("#saveGlobalRequirementBtn"),
  guangdadaKeyword: document.querySelector("#guangdadaKeyword"),
  guangdadaMinPopularity: document.querySelector("#guangdadaMinPopularity"),
  guangdadaTopN: document.querySelector("#guangdadaTopN"),
  guangdadaMaterialType: document.querySelector("#guangdadaMaterialType"),
  guangdadaStartDate: document.querySelector("#guangdadaStartDate"),
  guangdadaEndDate: document.querySelector("#guangdadaEndDate"),
  guangdadaRecentRange: document.querySelector("#guangdadaRecentRange"),
  guangdadaSearchBtn: document.querySelector("#guangdadaSearchBtn"),
  guangdadaStatus: document.querySelector("#guangdadaStatus"),
  guangdadaGrid: document.querySelector("#guangdadaGrid"),
  guangdadaDeleteFolderBtn: document.querySelector("#guangdadaDeleteFolderBtn"),
  competitorNameModal: document.querySelector("#competitorNameModal"),
  competitorNameInput: document.querySelector("#competitorNameInput"),
  competitorNameCancelBtn: document.querySelector("#competitorNameCancelBtn"),
  competitorNameConfirmBtn: document.querySelector("#competitorNameConfirmBtn"),
  taskPreview: document.querySelector("#taskPreview"),
  currentJob: document.querySelector("#currentJob"),
  logList: document.querySelector("#logList"),
  jobTable: document.querySelector("#jobTable"),
  outputGrid: document.querySelector("#outputGrid"),
  batchFilters: document.querySelector("#batchFilters"),
  outputCount: document.querySelector("#outputCount"),
  exportOutputsBtn: document.querySelector("#exportOutputsBtn"),
  exportStatus: document.querySelector("#exportStatus"),
  changelogBtn: document.querySelector("#changelogBtn"),
  changelogModal: document.querySelector("#changelogModal"),
  changelogCloseBtn: document.querySelector("#changelogCloseBtn"),
  currentUserBadge: document.querySelector("#currentUserBadge"),
  adminUsersBtn: document.querySelector("#adminUsersBtn"),
  adminUsersModal: document.querySelector("#adminUsersModal"),
  adminUsersCloseBtn: document.querySelector("#adminUsersCloseBtn"),
  adminUsersList: document.querySelector("#adminUsersList"),
  adminUsersStatus: document.querySelector("#adminUsersStatus"),
  adminNewUsername: document.querySelector("#adminNewUsername"),
  adminNewDisplayName: document.querySelector("#adminNewDisplayName"),
  adminNewPassword: document.querySelector("#adminNewPassword"),
  adminNewRole: document.querySelector("#adminNewRole"),
  adminCreateUserBtn: document.querySelector("#adminCreateUserBtn"),
  logoutBtn: document.querySelector("#logoutBtn"),
  loginModal: document.querySelector("#loginModal"),
  loginUsername: document.querySelector("#loginUsername"),
  loginPassword: document.querySelector("#loginPassword"),
  loginBtn: document.querySelector("#loginBtn"),
  loginStatus: document.querySelector("#loginStatus")
};

function defaultBatchTag() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  } catch (error) {
    throw new Error(friendlyError(error.message || "Failed to fetch"));
  }
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const preview = text.trim().slice(0, 120);
    if (contentType.includes("text/html") || preview.startsWith("<!doctype") || preview.startsWith("<!DOCTYPE") || preview.startsWith("<html")) {
      throw new Error(`接口 ${path} 返回了 HTML 页面，不是 JSON。通常是服务器登录页或反向代理没有把 /api 请求转发到 Node 后端。`);
    }
    throw new Error(`接口 ${path} 返回内容不是 JSON：${preview || res.statusText}`);
  }
  if (res.status === 401) {
    showLogin(data.error || "请先登录");
    throw new Error(friendlyError(data.error || "请先登录"));
  }
  if (!res.ok || data.error) throw new Error(friendlyError(data.error || "请求失败"));
  return data;
}

function showLogin(message = "") {
  if (els.loginModal) els.loginModal.hidden = false;
  if (els.loginStatus) els.loginStatus.textContent = message;
  if (els.currentUserBadge) els.currentUserBadge.textContent = "未登录";
  if (els.adminUsersBtn) els.adminUsersBtn.hidden = true;
  updateProjectAdminActions();
  if (els.logoutBtn) els.logoutBtn.hidden = true;
  setTimeout(() => els.loginUsername?.focus(), 0);
}

function hideLogin(user) {
  state.user = user || null;
  if (els.loginModal) els.loginModal.hidden = true;
  if (els.loginStatus) els.loginStatus.textContent = "";
  if (els.loginPassword) els.loginPassword.value = "";
  if (els.currentUserBadge) els.currentUserBadge.textContent = user?.displayName || user?.username || "已登录";
  if (els.adminUsersBtn) els.adminUsersBtn.hidden = !user?.isAdmin;
  updateProjectAdminActions();
  if (els.logoutBtn) els.logoutBtn.hidden = false;
}

function updateProjectAdminActions() {
  const hidden = !state.user?.isAdmin;
  if (els.renameProjectBtn) els.renameProjectBtn.hidden = hidden;
  if (els.deleteProjectBtn) els.deleteProjectBtn.hidden = hidden;
}

function openChangelog() {
  if (els.changelogModal) els.changelogModal.hidden = false;
}

function closeChangelog() {
  if (els.changelogModal) els.changelogModal.hidden = true;
}

function showToast(message, duration = 2600) {
  let toast = document.querySelector(".toast");
  if (!toast) {
    toast = document.createElement("div");
    toast.className = "toast";
    document.body.append(toast);
  }
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

async function checkAuth() {
  const auth = await api("/api/auth");
  if (!auth.authenticated) {
    showLogin("");
    return false;
  }
  hideLogin(auth.user);
  return true;
}

async function submitLogin() {
  const username = els.loginUsername.value.trim();
  const password = els.loginPassword.value;
  if (!username || !password) {
    els.loginStatus.textContent = "请输入账号和密码";
    return;
  }
  els.loginBtn.disabled = true;
  els.loginStatus.textContent = "正在登录...";
  try {
    const auth = await api("/api/login", { method: "POST", body: JSON.stringify({ username, password }) });
    hideLogin(auth.user);
    await loadMaterials({ resetSelection: true });
  } catch (error) {
    els.loginStatus.textContent = error.message;
  } finally {
    els.loginBtn.disabled = false;
  }
}

function renderAdminUsers(users = []) {
  if (!els.adminUsersList) return;
  if (!users.length) {
    els.adminUsersList.innerHTML = `<div class="empty-line">暂无账号</div>`;
    return;
  }
  els.adminUsersList.innerHTML = users.map((user) => `
    <div class="admin-user-row" data-username="${escapeHtml(user.username)}">
      <div>
        <strong>${escapeHtml(user.displayName || user.username)}</strong>
        <small>${escapeHtml(user.username)} · ${user.isAdmin ? "管理员" : "普通用户"}</small>
      </div>
      <input class="admin-display-name" type="text" value="${escapeHtml(user.displayName || "")}" placeholder="昵称" />
      <input class="admin-password" type="text" value="" placeholder="新密码，留空不改" />
      <select class="admin-role">
        <option value="user" ${user.isAdmin ? "" : "selected"}>普通用户</option>
        <option value="admin" ${user.isAdmin ? "selected" : ""}>管理员</option>
      </select>
      <button class="mini ghost admin-save-user" type="button">保存</button>
      <button class="mini ghost danger admin-delete-user" type="button">删除</button>
    </div>
  `).join("");
}

async function loadAdminUsers() {
  const result = await api("/api/admin/users");
  renderAdminUsers(result.users || []);
}

async function openAdminUsers() {
  if (!els.adminUsersModal) return;
  els.adminUsersModal.hidden = false;
  els.adminUsersStatus.textContent = "正在加载账号...";
  try {
    await loadAdminUsers();
    els.adminUsersStatus.textContent = "";
  } catch (error) {
    els.adminUsersStatus.textContent = error.message;
  }
}

function closeAdminUsers() {
  if (els.adminUsersModal) els.adminUsersModal.hidden = true;
}

async function createAdminUserFromForm() {
  const username = els.adminNewUsername.value.trim();
  const password = els.adminNewPassword.value;
  const displayName = els.adminNewDisplayName.value.trim();
  const role = els.adminNewRole.value;
  if (!username || !password) {
    els.adminUsersStatus.textContent = "请输入账号和密码";
    return;
  }
  els.adminCreateUserBtn.disabled = true;
  els.adminUsersStatus.textContent = "正在创建账号...";
  try {
    const result = await api("/api/admin/users/create", { method: "POST", body: JSON.stringify({ username, password, displayName, role }) });
    renderAdminUsers(result.users || []);
    els.adminNewUsername.value = "";
    els.adminNewDisplayName.value = "";
    els.adminNewPassword.value = "";
    els.adminNewRole.value = "user";
    els.adminUsersStatus.textContent = "已创建";
  } catch (error) {
    els.adminUsersStatus.textContent = error.message;
  } finally {
    els.adminCreateUserBtn.disabled = false;
  }
}

async function handleAdminUsersListClick(event) {
  const row = event.target.closest(".admin-user-row");
  if (!row) return;
  const username = row.dataset.username;
  if (event.target.classList.contains("admin-save-user")) {
    const displayName = row.querySelector(".admin-display-name").value.trim();
    const password = row.querySelector(".admin-password").value;
    const role = row.querySelector(".admin-role").value;
    event.target.disabled = true;
    els.adminUsersStatus.textContent = "正在保存...";
    try {
      const result = await api("/api/admin/users/update", { method: "POST", body: JSON.stringify({ username, displayName, password, role }) });
      renderAdminUsers(result.users || []);
      els.adminUsersStatus.textContent = "已保存";
    } catch (error) {
      els.adminUsersStatus.textContent = error.message;
    } finally {
      event.target.disabled = false;
    }
  }
  if (event.target.classList.contains("admin-delete-user")) {
    if (!confirm(`确定删除账号 ${username} 吗？该账号的服务器素材目录不会自动删除。`)) return;
    event.target.disabled = true;
    els.adminUsersStatus.textContent = "正在删除...";
    try {
      const result = await api("/api/admin/users/delete", { method: "POST", body: JSON.stringify({ username }) });
      renderAdminUsers(result.users || []);
      els.adminUsersStatus.textContent = "已删除";
    } catch (error) {
      els.adminUsersStatus.textContent = error.message;
    } finally {
      event.target.disabled = false;
    }
  }
}

function friendlyError(message) {
  const text = String(message || "");
  if (text.includes("Batch is running; cannot replace competitor material now")) return "当前正在生成中，不能更换或导入竞品素材。请先停止任务，或等待生成完成后再操作。";
  if (text.includes("Batch is running; cannot replace role image now")) return "当前正在生成中，不能更换角色/怪物图。请先停止任务，或等待生成完成后再操作。";
  if (text.includes("Batch is running; cannot change")) return "当前正在生成中，不能修改项目或素材配置。请先停止任务，或等待生成完成后再操作。";
  if (text.includes("Failed to fetch")) return "无法连接到本地网页服务，请确认服务已启动后再重试。";
  return text;
}

async function loadMaterials({ resetSelection = false, forceRefreshCompetitorSettings = false } = {}) {
  const previousRoles = new Set(state.selectedRoles);
  const previousMonsters = new Set(state.selectedMonsters);
  const previousLogos = new Set(state.selectedLogos);
  const previousCompetitors = new Set(state.selectedCompetitors);
  const hadMaterials = Boolean(state.materials) && !resetSelection;
  const materials = await api("/api/materials");
  state.materials = materials;
  if (els.projectPathInput) els.projectPathInput.value = materials.baseProjectRoot || materials.projectRoot;
  els.modelBadge.textContent = materials.model;
  els.globalRequirementText.value = materials.globalRequirement || "";
  renderProjectSelect(materials.projects || []);

  const roleNames = materials.roles.map((role) => role.name);
  const monsterNames = materials.monsters.map((monster) => monster.name);
  const logoNames = (materials.logos || []).map((logo) => logo.name);
  const competitorNames = materials.competitors.map((item) => item.name);
  state.selectedRoles = hadMaterials ? new Set(roleNames.filter((name) => previousRoles.has(name))) : new Set();
  state.selectedMonsters = hadMaterials ? new Set(monsterNames.filter((name) => previousMonsters.has(name))) : new Set();
  state.selectedLogos = hadMaterials ? new Set(logoNames.filter((name) => previousLogos.has(name))) : new Set();
  state.selectedCompetitors = hadMaterials ? new Set(competitorNames.filter((name) => previousCompetitors.has(name))) : new Set();
  if (!competitorNames.includes(state.guangdadaTargetFolder)) {
    state.guangdadaTargetFolder = competitorNames[0] || "";
  }

  for (const item of materials.competitors) {
    if (forceRefreshCompetitorSettings || !state.competitorSettings[item.name]) {
      state.competitorSettings[item.name] = {
        roleCount: item.roleCount ?? 1,
        monsterCount: item.monsterCount ?? 0,
        useLogo: Boolean(item.useLogo),
        imageSize: item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE,
        videoSize: item.videoSize || item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE,
        outputSize: item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE,
        specialRequirement: item.specialRequirement || ""
      };
    } else if (item.specialRequirement && !state.competitorSettings[item.name].specialRequirement) {
      state.competitorSettings[item.name].specialRequirement = item.specialRequirement;
      if (!state.competitorSettings[item.name].imageSize) state.competitorSettings[item.name].imageSize = item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE;
      if (!state.competitorSettings[item.name].videoSize) state.competitorSettings[item.name].videoSize = item.videoSize || item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE;
      if (!state.competitorSettings[item.name].outputSize) state.competitorSettings[item.name].outputSize = state.competitorSettings[item.name].imageSize;
    }
  }

  renderAll();
}

function renderAll() {
  renderAssetGrid({ items: state.materials.roles, grid: els.roleGrid, selected: state.selectedRoles, toggle: els.toggleRoles, kind: "role" });
  renderAssetGrid({ items: state.materials.monsters, grid: els.monsterGrid, selected: state.selectedMonsters, toggle: els.toggleMonsters, kind: "monster" });
  renderAssetGrid({ items: state.materials.logos || [], grid: els.logoGrid, selected: state.selectedLogos, toggle: els.toggleLogos, kind: "logo" });
  renderGuangdadaCompetitorSelect();
  renderCompetitors();
  renderOutputs();
  renderRunState(state.materials.runState);
  updateTaskPreview();
}

function renderProjectSelect(projects) {
  els.projectSelect.innerHTML = "";
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.path;
    option.dataset.name = project.name || project.path;
    option.textContent = `${project.active ? "当前：" : ""}${project.name || project.path}`;
    option.selected = Boolean(project.active);
    els.projectSelect.append(option);
  }
  if (state.user?.isAdmin) {
    const option = document.createElement("option");
    option.value = "__create_project__";
    option.textContent = "+ 新增项目";
    els.projectSelect.append(option);
  }
  updateProjectAdminActions();
}

function competitorLabel(item) {
  const displayName = item.displayName || item.name;
  return displayName === item.name ? item.name : `${displayName}（${item.name}）`;
}

function findCompetitor(folder) {
  return (state.materials?.competitors || []).find((item) => item.name === folder);
}

function setCompetitorUploading(folder, uploading, sourceElement = null) {
  if (!folder) return;
  if (uploading) state.uploadingCompetitors.add(folder);
  else state.uploadingCompetitors.delete(folder);
  const selector = `.competitor[data-folder="${CSS.escape(folder)}"]`;
  const block = els.competitorList?.querySelector(selector) || sourceElement?.closest?.(".competitor");
  if (!block) return;
  block.classList.toggle("drop-uploading", uploading);
  if (uploading) block.setAttribute("aria-busy", "true");
  else block.removeAttribute("aria-busy");
}

function competitorNameOptions() {
  return state.materials?.competitorNames || [];
}

function selectedGuangdadaCompetitor() {
  return findCompetitor(state.guangdadaTargetFolder || state.materials?.competitors?.[0]?.name || "");
}

function renderGuangdadaCompetitorSelect() {
  if (!els.guangdadaKeyword) return;
  const names = competitorNameOptions();
  const previous = els.guangdadaKeyword.value;
  els.guangdadaKeyword.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "请选择竞品";
  els.guangdadaKeyword.append(placeholder);
  for (const name of names) {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    option.selected = previous === name;
    els.guangdadaKeyword.append(option);
  }
  const createOption = document.createElement("option");
  createOption.value = "__create__";
  createOption.textContent = "+ 新增竞品名称";
  els.guangdadaKeyword.append(createOption);
}

function resetProjectState() {
  state.materials = null;
  state.selectedRoles = new Set();
  state.selectedMonsters = new Set();
  state.selectedLogos = new Set();
  state.selectedCompetitors = new Set();
  state.selectedBatches = new Set();
  state.batchesInitialized = false;
  state.activeBatchTag = "";
  state.batchFilterTouched = false;
  state.competitorSettings = {};
  state.guangdadaItems = [];
  state.guangdadaTargetFolder = "";
}

function renderAssetGrid({ items, grid, selected, toggle, kind }) {
  grid.innerHTML = "";
  for (const item of items) {
    const canDelete = Boolean(state.user?.isAdmin && ["role", "monster", "logo"].includes(kind));
    const card = document.createElement("label");
    card.className = `role-card ${selected.has(item.name) ? "selected" : ""}`;
    card.innerHTML = `
      <input type="checkbox" ${selected.has(item.name) ? "checked" : ""} />
      ${canDelete ? '<button class="delete-material" type="button" title="删除素材" aria-label="删除素材">×</button>' : ""}
      <img src="${item.url}" alt="${escapeHtml(item.title || item.name)}" />
      <b>${escapeHtml(item.title || item.name)}</b>
      <button class="replace-role" type="button">替换</button>
    `;
    const checkbox = card.querySelector("input");
    const replaceBtn = card.querySelector(".replace-role");
    const deleteBtn = card.querySelector(".delete-material");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(item.name);
      else selected.delete(item.name);
      card.classList.toggle("selected", checkbox.checked);
      toggle.checked = items.length > 0 && selected.size === items.length;
      updateTaskPreview();
    });
    deleteBtn?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const label = kind === "monster" ? "怪物图" : kind === "logo" ? "产品 Logo" : "角色图";
      if (!confirm(`确定删除这个${label}吗？\n${item.name}`)) return;
      deleteBtn.disabled = true;
      try {
        await api("/api/materials/delete", { method: "POST", body: JSON.stringify({ kind, name: item.name }) });
        selected.delete(item.name);
        await loadMaterials();
      } catch (error) {
        alert(error.message);
      } finally {
        deleteBtn.disabled = false;
      }
    });
    replaceBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      pickImageAndUpload({
        endpoint: "/api/upload-role",
        payload: { kind, mode: "replace", targetName: item.name },
        successText: kind === "monster" ? "怪物图已替换" : "角色图已替换"
      });
    });
    grid.append(card);
  }
  toggle.checked = items.length > 0 && selected.size === items.length;
}

function renderCompetitors() {
  els.competitorList.innerHTML = "";
  for (const item of state.materials.competitors) {
    const firstImage = item.images[0];
    const firstVideo = item.videos?.[0];
    const materialPreview = firstVideo
      ? `<video src="${firstVideo.url}" muted controls preload="metadata" playsinline></video>`
      : firstImage
        ? `<img src="${firstImage.url}" alt="${escapeHtml(item.name)}" />`
        : '<div class="empty-thumb">暂无素材</div>';
    const setting = state.competitorSettings[item.name] || { roleCount: item.roleCount ?? 1, monsterCount: item.monsterCount ?? 0, useLogo: Boolean(item.useLogo), imageSize: item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE, videoSize: item.videoSize || item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE, outputSize: item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE, specialRequirement: item.specialRequirement || "" };
    const imageSizeParts = splitSizeParts(setting.imageSize || setting.outputSize, item.defaultOutputSize || DEFAULT_OUTPUT_SIZE);
    const videoSizeParts = splitSizeParts(setting.videoSize || setting.imageSize || setting.outputSize, imageSizeParts.size);
    const block = document.createElement("article");
    block.className = "competitor";
    block.dataset.folder = item.name;
    const isUploading = state.uploadingCompetitors.has(item.name);
    if (isUploading) {
      block.classList.add("drop-uploading");
      block.setAttribute("aria-busy", "true");
    }
    block.innerHTML = `
      <div class="competitor-preview">${materialPreview}</div>
      <div class="competitor-body">
        <div class="competitor-title">
          <label class="competitor-check"><input type="checkbox" ${state.selectedCompetitors.has(item.name) ? "checked" : ""} /> <span>${escapeHtml(competitorLabel(item))}</span></label>
          <span class="autosave-status">已保存</span>
        </div>
          <div class="competitor-actions">
            <label class="count-field">角色 <input class="role-count" type="number" min="0" max="8" value="${setting.roleCount}" /></label>
            <label class="count-field">怪物 <input class="monster-count" type="number" min="0" max="8" value="${setting.monsterCount}" /></label>
            <label class="count-field logo-field">Logo <input class="logo-enabled" type="checkbox" ${setting.useLogo ? "checked" : ""} /></label>
            <label class="count-field split-size-field">图片尺寸 <input class="image-width" type="number" min="256" max="4096" step="1" value="${imageSizeParts.width}" /><span>×</span><input class="image-height" type="number" min="256" max="4096" step="1" value="${imageSizeParts.height}" /></label>
            <label class="count-field split-size-field">视频尺寸 <input class="video-width" type="number" min="256" max="4096" step="1" value="${videoSizeParts.width}" /><span>×</span><input class="video-height" type="number" min="256" max="4096" step="1" value="${videoSizeParts.height}" /></label>
            <button class="replace-competitor mini ghost" type="button">更换素材</button>
          </div>
        <label class="field-label">特殊提示词</label>
        <textarea class="special-requirement" spellcheck="false" placeholder="上传竞品素材后会自动生成 JSON 反推提示词；可直接修改 image2_prompt_guidance、seedance2_video_prompt 或 user_overrides">${escapeHtml(setting.specialRequirement || "")}</textarea>
      </div>
    `;
    const uploadMask = document.createElement("div");
    uploadMask.className = "competitor-upload-mask";
    uploadMask.setAttribute("aria-live", "polite");
    uploadMask.textContent = COMPETITOR_UPLOAD_TEXT;
    block.append(uploadMask);
    const checkbox = block.querySelector(".competitor-title > label input");
    const specialRequirement = block.querySelector(".special-requirement");
    const roleCountInput = block.querySelector(".role-count");
    const monsterCountInput = block.querySelector(".monster-count");
    const logoEnabledInput = block.querySelector(".logo-enabled");
    const imageWidthInput = block.querySelector(".image-width");
    const imageHeightInput = block.querySelector(".image-height");
    const videoWidthInput = block.querySelector(".video-width");
    const videoHeightInput = block.querySelector(".video-height");
    const replaceBtn = block.querySelector(".replace-competitor");
    const autosaveStatus = block.querySelector(".autosave-status");
    block.addEventListener("click", (event) => {
      if (!block.classList.contains("drop-uploading")) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    block.addEventListener("input", (event) => {
      if (!block.classList.contains("drop-uploading")) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    block.addEventListener("change", (event) => {
      if (!block.classList.contains("drop-uploading")) return;
      event.preventDefault();
      event.stopPropagation();
    }, true);
    replaceBtn.disabled = Boolean(state.materials?.runState?.running);
    replaceBtn.title = replaceBtn.disabled ? "生成中不能更换素材，请先停止或等待完成" : "";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.selectedCompetitors.add(item.name);
      else state.selectedCompetitors.delete(item.name);
      updateTaskPreview();
    });
    const updateSetting = () => {
      state.competitorSettings[item.name] = {
        roleCount: clampNumber(roleCountInput.value, 0, 8),
        monsterCount: clampNumber(monsterCountInput.value, 0, 8),
        useLogo: logoEnabledInput.checked,
        imageSize: sizeFromInputs(imageWidthInput, imageHeightInput, item.defaultOutputSize || DEFAULT_OUTPUT_SIZE),
        videoSize: sizeFromInputs(videoWidthInput, videoHeightInput, item.videoSize || item.imageSize || item.outputSize || item.defaultOutputSize || DEFAULT_OUTPUT_SIZE),
        outputSize: sizeFromInputs(imageWidthInput, imageHeightInput, item.defaultOutputSize || DEFAULT_OUTPUT_SIZE),
        specialRequirement: specialRequirement.value
      };
      updateTaskPreview();
    };
    const autoSaveSetting = debounce(async () => {
      updateSetting();
      autosaveStatus.textContent = "保存中";
      try {
        await api("/api/competitor-settings", {
          method: "POST",
          body: JSON.stringify({ folder: item.name, ...state.competitorSettings[item.name] })
        });
        item.specialRequirement = specialRequirement.value;
        autosaveStatus.textContent = "已保存";
      } catch (error) {
        autosaveStatus.textContent = "保存失败";
        console.warn(error);
      }
    }, 600);
    roleCountInput.addEventListener("input", () => { updateSetting(); autoSaveSetting(); });
    monsterCountInput.addEventListener("input", () => { updateSetting(); autoSaveSetting(); });
    logoEnabledInput.addEventListener("change", () => { updateSetting(); autoSaveSetting(); });
    for (const sizeInput of [imageWidthInput, imageHeightInput, videoWidthInput, videoHeightInput]) {
      sizeInput.addEventListener("input", () => { updateSetting(); autoSaveSetting(); });
      sizeInput.addEventListener("blur", () => {
        sizeInput.value = clampNumber(sizeInput.value, 256, 4096);
        updateSetting();
        autoSaveSetting();
      });
    }
    specialRequirement.addEventListener("input", () => { updateSetting(); autoSaveSetting(); });
    replaceBtn.addEventListener("click", async () => {
      if (state.materials?.runState?.running) return alert("当前正在生成中，不能更换竞品素材。请先停止任务，或等待生成完成后再操作。");
      await pickImageAndUpload({
        endpoint: "/api/upload-competitor",
        payload: { folder: item.name, allowVideo: true },
        successText: `${item.name} 素材已更换，特殊提示词已自动更新`,
        statusElement: autosaveStatus
      });
    });
    bindCompetitorDrop(block, item);
    els.competitorList.append(block);
  }
}

function renderOutputs() {
  const outputs = state.materials.outputs || [];
  const batches = [...new Set(outputs.map((output) => output.batch || "未分组"))];
  if (!state.batchesInitialized) {
    state.selectedBatches = new Set(batches);
    state.batchesInitialized = true;
  } else if (!state.batchFilterTouched && state.activeBatchTag) {
    state.selectedBatches = batches.includes(state.activeBatchTag) ? new Set([state.activeBatchTag]) : new Set();
  } else {
    state.selectedBatches = new Set([...state.selectedBatches].filter((batch) => batches.includes(batch)));
  }
  renderBatchFilters(batches);
  const visibleOutputs = outputs.filter((output) => state.selectedBatches.has(output.batch || "未分组"));
  els.outputCount.textContent = `${visibleOutputs.length} / ${outputs.length} 个`;
  updateExportControls(visibleOutputs.length);
  els.outputGrid.innerHTML = "";
  if (!visibleOutputs.length) {
    els.outputGrid.innerHTML = `<div class="empty-output">未勾选批次或暂无结果</div>`;
    return;
  }
  for (const output of visibleOutputs.slice(0, 120)) {
    const card = document.createElement("a");
    card.className = "output-card";
    card.href = output.url;
    card.target = "_blank";
    card.rel = "noreferrer";
    const media = output.type === "video"
      ? `<video src="${output.url}" muted controls preload="metadata"></video>`
      : `<img src="${output.url}" alt="${escapeHtml(output.name)}" />`;
    card.innerHTML = `${media}<em>${escapeHtml(output.batch || "未分组")}</em><b>${escapeHtml(output.name)}</b>`;
    els.outputGrid.append(card);
  }
}

function updateExportControls(visibleCount = 0) {
  if (!els.exportOutputsBtn) return;
  els.exportOutputsBtn.disabled = visibleCount <= 0 || state.selectedBatches.size <= 0;
  els.exportOutputsBtn.title = els.exportOutputsBtn.disabled ? "请先勾选要另存的结果批次" : "";
}

function renderBatchFilters(batches) {
  els.batchFilters.innerHTML = "";
  if (!batches.length) {
    els.batchFilters.textContent = "暂无结果";
    return;
  }
  const allLabel = document.createElement("label");
  allLabel.innerHTML = `<input type="checkbox" ${state.selectedBatches.size === batches.length ? "checked" : ""} /> 全部批次`;
  allLabel.querySelector("input").addEventListener("change", (event) => {
    state.batchFilterTouched = true;
    state.selectedBatches = event.target.checked ? new Set(batches) : new Set();
    renderOutputs();
  });
  els.batchFilters.append(allLabel);
  for (const batch of batches) {
    const label = document.createElement("label");
    label.innerHTML = `<input type="checkbox" ${state.selectedBatches.has(batch) ? "checked" : ""} /> ${escapeHtml(batch)}`;
    label.querySelector("input").addEventListener("change", (event) => {
      state.batchFilterTouched = true;
      if (event.target.checked) state.selectedBatches.add(batch);
      else state.selectedBatches.delete(batch);
      renderOutputs();
    });
    els.batchFilters.append(label);
  }
}

function renderGuangdadaItems(items) {
  state.guangdadaItems = items;
  els.guangdadaGrid.innerHTML = "";
  if (!items.length) {
    els.guangdadaGrid.innerHTML = `<div class="empty-output">没有找到符合人气值条件的素材</div>`;
    return;
  }
  const folderOptions = (state.materials?.competitors || [])
    .map((competitor) => `<option value="${escapeHtml(competitor.name)}" ${competitor.name === state.guangdadaTargetFolder ? "selected" : ""}>${escapeHtml(competitor.name)}</option>`)
    .join("");
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "guangdada-card";
    const videoPreviewUrl = item.proxyVideoUrl || item.videoUrl || "";
    const preview = item.isVideoMaterial && (item.proxyVideoUrl || item.videoUrl)
      ? `<div class="video-preview-wrap">
          <video src="${escapeHtml(videoPreviewUrl)}" poster="${escapeHtml(item.proxyUrl || "")}" muted controls preload="metadata" playsinline></video>
          <button class="video-play-btn" type="button">播放</button>
        </div>`
      : `<img src="${escapeHtml(item.proxyUrl || "")}" alt="${escapeHtml(item.title)}" />`;
    card.innerHTML = `
      ${preview}
      <div class="guangdada-meta">
        <b>${escapeHtml(item.title || "未命名素材")}</b>
        <span>人气 ${escapeHtml(item.popularity)} · ${escapeHtml(item.platform || "未知平台")}</span>
        <small>${escapeHtml(item.advertiser || "")}</small>
      </div>
      <div class="guangdada-import">
        <select class="guangdada-card-target">${folderOptions || '<option value="">请选择竞品素材</option>'}</select>
        <button class="mini" type="button">导入</button>
      </div>
    `;
    const button = card.querySelector(".guangdada-import button");
    const playButton = card.querySelector(".video-play-btn");
    const video = card.querySelector("video");
    const folderSelect = card.querySelector(".guangdada-card-target");
    if (playButton && video) {
      playButton.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          video.muted = false;
          video.controls = true;
          await video.play();
          playButton.textContent = "播放中";
          setTimeout(() => (playButton.textContent = "播放"), 1200);
        } catch {
          window.open(videoPreviewUrl, "_blank", "noopener,noreferrer");
        }
      });
      video.addEventListener("error", () => {
        playButton.textContent = "打开预览";
        playButton.title = "视频源限制了内嵌播放，点击在新窗口打开预览";
      });
    }
    const isRunning = Boolean(state.materials?.runState?.running);
    button.disabled = isRunning;
    folderSelect.disabled = isRunning;
    button.title = isRunning ? "生成中不能导入素材，请先停止或等待完成" : "";
    button.addEventListener("click", async () => {
      if (state.materials?.runState?.running) return alert("当前正在生成中，不能导入竞品素材。请先停止任务，或等待生成完成后再操作。");
      const folder = folderSelect.value || state.guangdadaTargetFolder || state.materials?.competitors?.[0]?.name || "";
      if (!folder) return alert("请先选择或新增一个竞品素材");
      button.disabled = true;
      button.textContent = "导入中";
      setCompetitorUploading(folder, true);
      try {
        await api("/api/guangdada/import", {
          method: "POST",
          body: JSON.stringify({ folder, imageUrl: item.imageUrl, videoUrl: item.videoUrl, isVideoMaterial: item.isVideoMaterial, title: item.title, id: item.id, adKey: item.adKey, appType: item.appType, searchFlag: item.searchFlag })
        });
        await loadMaterials({ forceRefreshCompetitorSettings: true });
        renderGuangdadaItems(state.guangdadaItems);
        showToast("素材已导入，特殊提示词 JSON 已刷新");
        button.textContent = "已导入";
      } catch (error) {
        alert(error.message);
        button.textContent = "导入";
      } finally {
        setCompetitorUploading(folder, false);
        button.disabled = false;
      }
    });
    els.guangdadaGrid.append(card);
  }
}

function renderRunState(runState) {
  els.totalCount.textContent = runState.total || 0;
  els.doneCount.textContent = runState.completed || 0;
  els.skipCount.textContent = runState.skipped || 0;
  els.failCount.textContent = runState.failed || 0;
  els.currentJob.textContent = runState.current || (runState.running ? "准备中" : "未运行");
  els.runBadge.textContent = runState.running ? "运行中" : "空闲";
  els.runBadge.classList.toggle("running", Boolean(runState.running));
  updateStartButtonState(Boolean(runState.running));
  els.stopBtn.disabled = !runState.running;
  syncMaterialActionState(Boolean(runState.running));
  renderJobTable(runState.jobs || []);
  els.logList.innerHTML = "";
  for (const line of [...(runState.log || [])].reverse()) {
    const div = document.createElement("div");
    div.className = `log-line ${line.type || ""}`;
    div.textContent = `${formatTime(line.time)}  ${formatLogLine(line)}`;
    els.logList.append(div);
  }
}

function updateStartButtonState(isRunning = Boolean(state.materials?.runState?.running)) {
  const missingImageModel = !els.imageModelSelect?.value;
  const needsVideoModel = els.outputModeSelect?.value === "video";
  const missingVideoModel = needsVideoModel && !els.videoModelSelect?.value;
  if (els.videoModelSelect) els.videoModelSelect.disabled = !needsVideoModel || Boolean(isRunning);
  els.startBtn.disabled = Boolean(isRunning) || missingImageModel || missingVideoModel;
  els.startBtn.title = missingImageModel ? "请先选择生图模型" : missingVideoModel ? "请先选择视频模型" : "开始生成";
}

function syncMaterialActionState(isRunning) {
  document.querySelectorAll(".replace-competitor, .guangdada-import button, .guangdada-card-target").forEach((element) => {
    element.disabled = isRunning;
    element.title = isRunning ? "生成中不能更换或导入素材，请先停止或等待完成" : "";
  });
}

function renderJobTable(jobs) {
  if (!jobs.length) {
    els.jobTable.innerHTML = `<div class="empty-jobs">暂无任务</div>`;
    return;
  }
  els.jobTable.innerHTML = `<div class="job-row job-head"><span>#</span><span>生成任务</span><span>状态</span><span>耗时</span></div>`;
  for (const job of jobs) {
    const row = document.createElement("div");
    row.className = `job-row ${job.status || "pending"}`;
    row.title = job.error || "";
    row.innerHTML = `<span>${job.index}</span><span>${escapeHtml(job.name)}${job.error ? `<small>${escapeHtml(compactError(job.error))}</small>` : ""}</span><span><i></i>${statusLabel(job)}</span><span>${durationText(job.startedAt, job.finishedAt)}</span>`;
    els.jobTable.append(row);
  }
}

function statusLabel(job) {
  const labels = {
    pending: "等待中",
    running: `生成中${workerSuffix(job.statusText)}`,
    done: "已完成",
    skipped: "已跳过",
    failed: "失败",
    stopped: "已停止"
  };
  return labels[job.status] || "等待中";
}

function workerSuffix(text) {
  const match = String(text || "").match(/W\d+/);
  return match ? ` ${match[0]}` : "";
}

function formatLogLine(line) {
  const worker = line.worker ? `W${line.worker} ` : "";
  const job = line.job || "";
  if (line.type === "start") {
    const repeat = line.message?.match(/repeat=(\d+)/)?.[1] || "1";
    const suffix = repeat !== "1" ? `，每组生成 ${repeat} 次` : "";
    return line.message?.includes("mode=video") ? `开始批处理，先生成图片再生成 Seedance 视频${suffix}` : `开始批处理，并发生成，模型 codex-gpt-image2${suffix}`;
  }
  if (line.type === "job-start") return `${worker}开始 ${job}`;
  if (line.type === "video-start") return `${worker}开始视频 ${job}`;
  if (line.type === "video-wait") return `${worker}等待视频 ${job}`;
  if (line.type === "done") return `${worker}完成 ${job}`;
  if (line.type === "skip") return `${worker}跳过 ${job}`;
  if (line.type === "retry") return `${worker}重试 ${job}`;
  if (line.type === "error") return `${worker}失败 ${job || compactError(line.message || "")}`;
  if (line.type === "warn") return line.message || "配置提醒";
  if (line.type === "stop") return "已请求停止当前批处理";
  if (line.type === "finish") return "批处理结束";
  return line.message || "状态更新";
}

function compactError(error) {
  return String(error).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-2).join(" | ").slice(0, 160);
}

function durationText(startedAt, finishedAt) {
  if (!startedAt) return "-";
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  const seconds = Math.max(0, Math.round((end - new Date(startedAt).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function estimateTaskCount() {
  let baseTotal = 0;
  for (const name of state.selectedCompetitors) {
    const setting = state.competitorSettings[name] || { roleCount: 1, monsterCount: 0 };
    if (setting.useLogo && !state.selectedLogos.size) return `${name} 勾选了 Logo，但没有勾选产品 Logo 图。请勾选产品 Logo，或取消该竞品的 Logo。`;
    const roleCount = clampNumber(setting.roleCount, 0, 8);
    const monsterCount = clampNumber(setting.monsterCount, 0, 8);
    const combo = roleCount !== 1 || monsterCount > 0;
    if (combo) {
      const roleGroups = roleCount > 0 ? Math.ceil(state.selectedRoles.size / roleCount) : 0;
      const monsterGroups = monsterCount > 0 ? Math.ceil(state.selectedMonsters.size / monsterCount) : 0;
      baseTotal += Math.max(1, roleGroups, monsterGroups);
    } else {
      baseTotal += state.selectedRoles.size;
    }
  }
  return baseTotal * clampNumber(els.repeatCountInput?.value || 1, 1, 50);
}

function zeroTaskReason() {
  if (!state.selectedCompetitors.size) return "请至少勾选一个竞品素材。";
  if (!state.selectedRoles.size) return "请至少勾选一个角色图。页面默认不勾选角色图，需要手动选择。";
  for (const name of state.selectedCompetitors) {
    const setting = state.competitorSettings[name] || { roleCount: 1, monsterCount: 0 };
    const roleCount = clampNumber(setting.roleCount, 0, 8);
    const monsterCount = clampNumber(setting.monsterCount, 0, 8);
    if (roleCount > 0 && !state.selectedRoles.size) return `${name} 需要 ${roleCount} 个角色，请先勾选角色图。`;
    if (monsterCount > 0 && !state.selectedMonsters.size) return `${name} 设置了 ${monsterCount} 个怪物，但没有勾选怪物图。请勾选怪物图，或把怪物数量改成 0。`;
  }
  return "当前选择没有形成可生成任务。请检查角色数量、怪物数量、角色图、怪物图、产品 Logo 和竞品素材勾选状态。";
}

function updateTaskPreview() {
  const total = estimateTaskCount();
  els.taskPreview.textContent = `${total} 个预估任务`;
}

async function refreshState() {
  const runState = await api("/api/state");
  if (runState.running && runState.batchTag) {
    state.activeBatchTag = runState.batchTag;
  }
  renderRunState(runState);
  const materials = await api("/api/materials");
  state.materials.outputs = materials.outputs;
  state.materials.runState = materials.runState;
  renderOutputs();
  if (!runState.running) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString("zh-CN", { hour12: false });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function clampNumber(value, min, max) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, Math.floor(number)));
}

function normalizeOutputSizeInput(value) {
  const match = String(value || "").trim().toLowerCase().match(/^(\d{3,4})\s*[x×*]\s*(\d{3,4})$/);
  if (!match) return "";
  const width = Math.max(256, Math.min(4096, Number(match[1])));
  const height = Math.max(256, Math.min(4096, Number(match[2])));
  return `${width}x${height}`;
}

function sizeFromInputs(widthInput, heightInput, fallback = DEFAULT_OUTPUT_SIZE) {
  const fallbackParts = splitSizeParts(fallback);
  const width = clampNumber(widthInput?.value || fallbackParts.width, 256, 4096);
  const height = clampNumber(heightInput?.value || fallbackParts.height, 256, 4096);
  return `${width}x${height}`;
}

function formatDateInput(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function applyRecentRange(days) {
  const count = Number(days || 0);
  if (!count) return;
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - count + 1);
  els.guangdadaStartDate.value = formatDateInput(start);
  els.guangdadaEndDate.value = formatDateInput(end);
}

function openCompetitorNameModal() {
  els.competitorNameInput.value = "";
  els.competitorNameModal.hidden = false;
  requestAnimationFrame(() => els.competitorNameInput.focus());
}

function closeCompetitorNameModal() {
  els.competitorNameModal.hidden = true;
  renderGuangdadaCompetitorSelect();
}

async function confirmCreateCompetitorName() {
  const displayName = els.competitorNameInput.value.trim();
  if (!displayName) return alert("请输入竞品名称，例如 Capybara Go!");
  els.competitorNameConfirmBtn.disabled = true;
  try {
    const result = await api("/api/competitors/create", {
      method: "POST",
      body: JSON.stringify({ displayName })
    });
    els.competitorNameModal.hidden = true;
    await loadMaterials();
    els.guangdadaKeyword.value = result.displayName || displayName;
    if (state.guangdadaItems.length) renderGuangdadaItems(state.guangdadaItems);
  } catch (error) {
    alert(error.message);
    renderGuangdadaCompetitorSelect();
  } finally {
    els.competitorNameConfirmBtn.disabled = false;
  }
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function captureVideoCover(file) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(file);
    let settled = false;
    const finish = (value = null) => {
      if (settled) return;
      settled = true;
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const capture = () => {
      try {
        const width = video.videoWidth || 720;
        const height = video.videoHeight || 1280;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(video, 0, 0, width, height);
        finish({
          coverContent: canvas.toDataURL("image/jpeg", 0.86),
          coverName: `${file.name.replace(/\.[^.]+$/, "")}_封面.jpg`
        });
      } catch {
        finish(null);
      }
    };
    video.muted = true;
    video.preload = "metadata";
    video.playsInline = true;
    video.addEventListener("loadedmetadata", () => {
      const targetTime = Number.isFinite(video.duration) && video.duration > 2 ? 1 : 0;
      try {
        video.currentTime = targetTime;
      } catch {
        capture();
      }
    }, { once: true });
    video.addEventListener("seeked", capture, { once: true });
    video.addEventListener("loadeddata", () => {
      if (!Number.isFinite(video.duration) || video.duration <= 0.2) capture();
    }, { once: true });
    video.addEventListener("error", () => finish(null), { once: true });
    setTimeout(() => finish(null), 8000);
    video.src = url;
  });
}

async function uploadPickedFile({ file, endpoint, payload = {}, successText, quiet = false, statusElement = null }) {
  if (state.materials?.runState?.running) {
    alert("?????????????????");
    return false;
  }
  if (!file) return false;
  if (!file.type.startsWith("image/") && !(payload.allowVideo && file.type.startsWith("video/"))) {
    alert(payload.allowVideo ? "??????????" : "???????");
    return false;
  }
  const isCompetitorUpload = endpoint === "/api/upload-competitor";
  if (isCompetitorUpload) setCompetitorUploading(payload.folder, true, statusElement);
  try {
    if (statusElement) statusElement.textContent = isCompetitorUpload ? "??????????..." : "????...";
    const content = await readFileAsDataUrl(file);
    if (typeof content !== "string" || (!content.startsWith("data:image/") && !(payload.allowVideo && content.startsWith("data:video/")))) {
      throw new Error("??????????????");
    }
    const cover = payload.allowVideo && file.type.startsWith("video/") ? await captureVideoCover(file) : null;
    const result = await api(endpoint, { method: "POST", body: JSON.stringify({ ...payload, name: file.name, content, ...(cover || {}) }) });
    await loadMaterials({ forceRefreshCompetitorSettings: isCompetitorUpload });
    if (statusElement) {
      const usedFallback = isCompetitorUpload && String(result.specialRequirement || "").includes('"reverse_model": "local_fallback"');
      statusElement.textContent = usedFallback ? "??????????????????? fallback" : "????????";
    }
    if (isCompetitorUpload) showToast("????? JSON ???");
    if (!quiet) alert(isCompetitorUpload ? successText + "\n??????????????? JSON?" : successText);
    return true;
  } finally {
    if (isCompetitorUpload) setCompetitorUploading(payload.folder, false);
  }
}

async function pickImageAndUpload({ endpoint, payload = {}, successText, statusElement = null }) {
  if (state.materials?.runState?.running) {
    alert("?????????????????");
    return false;
  }
  const isCompetitorUpload = endpoint === "/api/upload-competitor";
  if (isCompetitorUpload) setCompetitorUploading(payload.folder, true, statusElement);
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = payload.allowVideo ? "image/png,image/jpeg,image/webp,video/mp4,video/webm,video/quicktime" : "image/png,image/jpeg,image/webp";
  return new Promise((resolve, reject) => {
    let picked = false;
    picker.onchange = async () => {
      picked = true;
      const file = picker.files?.[0];
      if (!file) {
        if (isCompetitorUpload) setCompetitorUploading(payload.folder, false, statusElement);
        resolve(false);
        return;
      }
      try {
        const result = await uploadPickedFile({ file, endpoint, payload, successText, statusElement });
        resolve(result);
      } catch (error) {
        alert(error.message);
        reject(error);
      }
    };
    picker.click();
    window.setTimeout(() => {
      window.addEventListener("focus", () => {
        window.setTimeout(() => {
          if (!picked && isCompetitorUpload) {
            setCompetitorUploading(payload.folder, false, statusElement);
            resolve(false);
          }
        }, 250);
      }, { once: true });
    }, 0);
  });
}
function bindCompetitorDrop(block, item) {
  const canDrop = () => !state.materials?.runState?.running && !block.classList.contains("drop-uploading");
  const stop = (event) => {
    event.preventDefault();
    event.stopPropagation();
  };
  block.addEventListener("dragenter", (event) => {
    stop(event);
    if (!canDrop()) return;
    block.classList.add("drag-over");
  });
  block.addEventListener("dragover", (event) => {
    stop(event);
    if (canDrop()) event.dataTransfer.dropEffect = "copy";
  });
  block.addEventListener("dragleave", (event) => {
    if (!block.contains(event.relatedTarget)) block.classList.remove("drag-over");
  });
  block.addEventListener("drop", async (event) => {
    stop(event);
    block.classList.remove("drag-over");
    if (!canDrop()) return alert("当前正在生成中，不能导入素材。请先停止任务，或等待生成完成后再操作。");
    const file = [...(event.dataTransfer?.files || [])].find((entry) => entry.type.startsWith("image/") || entry.type.startsWith("video/"));
    if (!file) return alert("请拖入图片或视频文件");
    const statusElement = block.querySelector(".autosave-status");
    try {
      await uploadPickedFile({
        file,
        endpoint: "/api/upload-competitor",
        payload: { folder: item.name, allowVideo: true },
        successText: `${item.name} 素材已导入，特殊提示词已自动更新`,
        quiet: true,
        statusElement
      });
    } catch (error) {
      alert(error.message);
    }
  });
}

els.batchTag.value = defaultBatchTag();
updateStartButtonState(false);
els.guangdadaMinPopularity.value = "100000";
els.guangdadaTopN.value = "3";
els.guangdadaRecentRange.value = "3";
els.guangdadaMaterialType.value = "image";
applyRecentRange("3");

els.uploadRoleBtn.addEventListener("click", () => {
  pickImageAndUpload({ endpoint: "/api/upload-role", payload: { kind: "role", mode: "add" }, successText: "角色图已上传" });
});

els.uploadMonsterBtn.addEventListener("click", () => {
  pickImageAndUpload({ endpoint: "/api/upload-role", payload: { kind: "monster", mode: "add" }, successText: "怪物图已上传" });
});

els.uploadLogoBtn.addEventListener("click", () => {
  pickImageAndUpload({ endpoint: "/api/upload-role", payload: { kind: "logo", mode: "add" }, successText: "产品 Logo 已上传" });
});

els.savePathBtn?.addEventListener("click", async () => {
  const projectRoot = els.projectPathInput.value.trim();
  if (!projectRoot) return alert("请输入项目根目录路径");
  els.savePathBtn.disabled = true;
  try {
    await api("/api/config", { method: "POST", body: JSON.stringify({ projectRoot }) });
    resetProjectState();
    await loadMaterials({ resetSelection: true });
    alert("项目已保存并切换");
  } catch (error) {
    alert(error.message);
  } finally {
    els.savePathBtn.disabled = false;
  }
});

els.switchProjectBtn?.addEventListener("click", async () => {
  const projectRoot = els.projectSelect.value || els.projectPathInput.value.trim();
  if (!projectRoot) return alert("请选择项目或输入项目路径");
  els.switchProjectBtn.disabled = true;
  try {
    await api("/api/projects/switch", { method: "POST", body: JSON.stringify({ projectRoot }) });
    resetProjectState();
    await loadMaterials({ resetSelection: true });
  } catch (error) {
    alert(error.message);
  } finally {
    els.switchProjectBtn.disabled = false;
  }
});

els.renameProjectBtn?.addEventListener("click", async () => {
  if (!state.user?.isAdmin) return alert("只有管理员可以修改项目名称");
  const projectRoot = els.projectSelect.value || els.projectPathInput?.value.trim();
  if (projectRoot === "__create_project__") return;
  if (!projectRoot) return alert("请先选择项目");
  const option = els.projectSelect.selectedOptions[0];
  const currentName = (option?.dataset.name || option?.textContent || "").replace(/^当前：/, "").trim();
  const name = prompt("请输入新的项目名称", currentName);
  if (name == null) return;
  const nextName = name.trim();
  if (!nextName) return alert("项目名称不能为空");
  els.renameProjectBtn.disabled = true;
  try {
    await api("/api/projects/rename", { method: "POST", body: JSON.stringify({ projectRoot, name: nextName }) });
    await loadMaterials();
  } catch (error) {
    alert(error.message);
  } finally {
    els.renameProjectBtn.disabled = false;
  }
});

els.deleteProjectBtn?.addEventListener("click", async () => {
  if (!state.user?.isAdmin) return alert("只有管理员可以删除项目");
  const projectRoot = els.projectSelect.value || els.projectPathInput?.value.trim();
  if (projectRoot === "__create_project__") return;
  if (!projectRoot) return alert("请先选择项目");
  const option = els.projectSelect.selectedOptions[0];
  const currentName = (option?.dataset.name || option?.textContent || projectRoot).replace(/^当前：/, "").trim();
  if (!confirm(`确定从项目列表删除「${currentName}」吗？\n不会删除服务器上的项目文件夹。`)) return;
  els.deleteProjectBtn.disabled = true;
  try {
    await api("/api/projects/delete", { method: "POST", body: JSON.stringify({ projectRoot }) });
    resetProjectState();
    await loadMaterials({ resetSelection: true });
  } catch (error) {
    alert(error.message);
  } finally {
    els.deleteProjectBtn.disabled = false;
  }
});

els.projectSelect.addEventListener("change", async () => {
  const projectRoot = els.projectSelect.value;
  if (projectRoot === "__create_project__") {
    if (!state.user?.isAdmin) {
      await loadMaterials();
      return alert("只有管理员可以新增项目");
    }
    const name = prompt("请输入新项目名称");
    if (name == null) return loadMaterials();
    const nextName = name.trim();
    if (!nextName) {
      await loadMaterials();
      return alert("项目名称不能为空");
    }
    els.projectSelect.disabled = true;
    try {
      await api("/api/projects/create", { method: "POST", body: JSON.stringify({ name: nextName }) });
      resetProjectState();
      await loadMaterials({ resetSelection: true });
    } catch (error) {
      alert(error.message);
      await loadMaterials();
    } finally {
      els.projectSelect.disabled = false;
    }
    return;
  }
  if (!projectRoot) return;
  if (els.projectPathInput) els.projectPathInput.value = projectRoot;
  els.projectSelect.disabled = true;
  try {
    await api("/api/projects/switch", { method: "POST", body: JSON.stringify({ projectRoot }) });
    resetProjectState();
    await loadMaterials({ resetSelection: true });
  } catch (error) {
    alert(error.message);
    await loadMaterials();
  } finally {
    els.projectSelect.disabled = false;
  }
});

els.refreshBtn?.addEventListener("click", async () => {
  els.refreshBtn.disabled = true;
  try {
    await loadMaterials();
  } catch (error) {
    alert(error.message);
  } finally {
    els.refreshBtn.disabled = false;
  }
});

els.toggleRoles.addEventListener("change", () => {
  state.selectedRoles = new Set(els.toggleRoles.checked ? state.materials.roles.map((role) => role.name) : []);
  renderAssetGrid({ items: state.materials.roles, grid: els.roleGrid, selected: state.selectedRoles, toggle: els.toggleRoles, kind: "role" });
  updateTaskPreview();
});

els.toggleMonsters.addEventListener("change", () => {
  state.selectedMonsters = new Set(els.toggleMonsters.checked ? state.materials.monsters.map((monster) => monster.name) : []);
  renderAssetGrid({ items: state.materials.monsters, grid: els.monsterGrid, selected: state.selectedMonsters, toggle: els.toggleMonsters, kind: "monster" });
  updateTaskPreview();
});

els.toggleLogos.addEventListener("change", () => {
  state.selectedLogos = new Set(els.toggleLogos.checked ? (state.materials.logos || []).map((logo) => logo.name) : []);
  renderAssetGrid({ items: state.materials.logos || [], grid: els.logoGrid, selected: state.selectedLogos, toggle: els.toggleLogos, kind: "logo" });
  updateTaskPreview();
});

els.repeatCountInput.addEventListener("input", updateTaskPreview);

els.saveGlobalRequirementBtn.addEventListener("click", async () => {
  els.saveGlobalRequirementBtn.disabled = true;
  els.saveGlobalRequirementBtn.textContent = "保存中";
  try {
    await api("/api/global-requirement", { method: "POST", body: JSON.stringify({ text: els.globalRequirementText.value }) });
    if (state.materials) state.materials.globalRequirement = els.globalRequirementText.value;
    els.saveGlobalRequirementBtn.textContent = "已保存";
    setTimeout(() => (els.saveGlobalRequirementBtn.textContent = "保存通用提示词"), 1000);
  } catch (error) {
    alert(error.message);
    els.saveGlobalRequirementBtn.textContent = "保存通用提示词";
  } finally {
    els.saveGlobalRequirementBtn.disabled = false;
  }
});

els.guangdadaSearchBtn.addEventListener("click", async () => {
  if (GUANGDADA_DISABLED) {
    els.guangdadaStatus.textContent = "已禁用";
    return alert("广大大抓取暂时禁用，请自行上传竞品素材。");
  }
  if (!els.guangdadaKeyword.value || els.guangdadaKeyword.value === "__create__") {
    alert("请先选择或新增一个竞品名称");
    return;
  }
  els.guangdadaSearchBtn.disabled = true;
  els.guangdadaSearchBtn.textContent = "抓取中";
  els.guangdadaStatus.textContent = "抓取中...";
  try {
    const minPopularity = Number(els.guangdadaMinPopularity.value || 100000);
    els.guangdadaMinPopularity.value = String(minPopularity);
    const result = await api("/api/guangdada/search", {
      method: "POST",
      body: JSON.stringify({
        keyWord: els.guangdadaKeyword.value.trim(),
        minPopularity,
        topN: Number(els.guangdadaTopN.value || 30),
        materialType: els.guangdadaMaterialType.value,
        startDate: els.guangdadaStartDate.value,
        endDate: els.guangdadaEndDate.value
      })
    });
    renderGuangdadaItems(result.items || []);
    const dateText = result.startDate || result.endDate ? `，日期 ${result.startDate || "不限"} 至 ${result.endDate || "不限"}` : "";
    els.guangdadaStatus.textContent = `找到 ${result.count} / ${result.total} 个${dateText}`;
  } catch (error) {
    alert(error.message);
    els.guangdadaStatus.textContent = "抓取失败";
  } finally {
    els.guangdadaSearchBtn.disabled = false;
    els.guangdadaSearchBtn.textContent = "抓取";
  }
});

els.exportOutputsBtn.addEventListener("click", async () => {
  const batches = [...state.selectedBatches];
  if (!batches.length) return alert("请先勾选至少一个结果批次");
  els.exportOutputsBtn.disabled = true;
  els.exportStatus.textContent = "正在打包";
  try {
    const res = await fetch("/api/outputs/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ batches })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(friendlyError(data.error || "下载失败"));
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const disposition = res.headers.get("content-disposition") || "";
    const filename = disposition.match(/filename="([^"]+)"/)?.[1] || `ad-results-${defaultBatchTag()}.zip`;
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    els.exportStatus.textContent = `已开始下载 ${filename}`;
  } catch (error) {
    els.exportStatus.textContent = `下载失败：${error.message}`;
  } finally {
    updateExportControls((state.materials?.outputs || []).filter((output) => state.selectedBatches.has(output.batch || "未分组")).length);
  }
});

els.guangdadaRecentRange.addEventListener("change", () => {
  applyRecentRange(els.guangdadaRecentRange.value);
});

els.guangdadaStartDate.addEventListener("input", () => {
  els.guangdadaRecentRange.value = "";
});

els.guangdadaEndDate.addEventListener("input", () => {
  els.guangdadaRecentRange.value = "";
});

els.imageModelSelect.addEventListener("change", () => {
  updateStartButtonState();
});

els.videoModelSelect?.addEventListener("change", () => {
  updateStartButtonState();
});

els.outputModeSelect?.addEventListener("change", () => {
  updateStartButtonState();
});

els.guangdadaKeyword.addEventListener("change", async () => {
  const selectedOption = els.guangdadaKeyword.options[els.guangdadaKeyword.selectedIndex];
  if (els.guangdadaKeyword.value === "__create__") {
    openCompetitorNameModal();
    return;
  }
  if (state.guangdadaItems.length) renderGuangdadaItems(state.guangdadaItems);
});

els.competitorNameCancelBtn.addEventListener("click", closeCompetitorNameModal);
els.competitorNameConfirmBtn.addEventListener("click", confirmCreateCompetitorName);
els.competitorNameModal.addEventListener("click", (event) => {
  if (event.target === els.competitorNameModal) closeCompetitorNameModal();
});
els.competitorNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") confirmCreateCompetitorName();
  if (event.key === "Escape") closeCompetitorNameModal();
});

els.guangdadaDeleteFolderBtn.addEventListener("click", async () => {
  const selectedOption = els.guangdadaKeyword.options[els.guangdadaKeyword.selectedIndex];
  const displayName = selectedOption?.value || "";
  if (!displayName || displayName === "__create__") return alert("请先选择要删除的竞品名称");
  if (!confirm(`确定删除 ${displayName} 吗？只会删除竞品名称，不会删除竞品素材栏位。`)) return;
  els.guangdadaDeleteFolderBtn.disabled = true;
  try {
    await api("/api/competitors/delete", { method: "POST", body: JSON.stringify({ displayName }) });
    await loadMaterials();
    if (state.guangdadaItems.length) renderGuangdadaItems(state.guangdadaItems);
  } catch (error) {
    alert(error.message);
  } finally {
    els.guangdadaDeleteFolderBtn.disabled = false;
  }
});

els.startBtn.addEventListener("click", async () => {
  const imageModel = els.imageModelSelect.value;
  const videoModel = els.videoModelSelect?.value || "";
  if (els.outputModeSelect.value === "video" && !videoModel) return alert("请先选择视频模型");
  if (!imageModel) return alert("请先选择生图模型");
  if (!state.selectedCompetitors.size) return alert("请至少选择一个竞品素材类型");
  const estimatedCount = estimateTaskCount();
  if (estimatedCount <= 0) return alert(zeroTaskReason());
  if (estimatedCount > 10 && !confirm(`本次预计生成 ${estimatedCount} 个任务，可能耗时较久并消耗较多额度。确定继续吗？`)) return;
  const freshBatchTag = defaultBatchTag();
  els.batchTag.value = freshBatchTag;
  els.startBtn.disabled = true;
  try {
    const runState = await api("/api/start", {
      method: "POST",
      body: JSON.stringify({
        batchTag: freshBatchTag,
        concurrency: Number(els.concurrencyInput.value || 3),
        repeatCount: clampNumber(els.repeatCountInput.value || 1, 1, 50),
        outputMode: els.outputModeSelect.value,
        imageModel,
        videoModel,
        roles: [...state.selectedRoles],
        monsters: [...state.selectedMonsters],
        logos: [...state.selectedLogos],
        competitors: [...state.selectedCompetitors],
        globalRequirement: els.globalRequirementText.value,
        competitorSettings: state.competitorSettings
      })
    });
    state.activeBatchTag = runState.batchTag || freshBatchTag;
    state.batchFilterTouched = false;
    state.selectedBatches = new Set();
    renderRunState(runState);
    await refreshState();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(refreshState, 2000);
  } catch (error) {
    alert(error.message);
    updateStartButtonState(false);
  }
});

els.stopBtn.addEventListener("click", async () => {
  els.stopBtn.disabled = true;
  try {
    renderRunState(await api("/api/stop", { method: "POST", body: "{}" }));
  } catch (error) {
    alert(error.message);
  }
});

els.loginBtn?.addEventListener("click", submitLogin);
els.loginPassword?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") submitLogin();
});
els.loginUsername?.addEventListener("keydown", (event) => {
  if (event.key === "Enter") els.loginPassword?.focus();
});
els.logoutBtn?.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch {
    // Ignore logout transport errors and return to the login screen.
  }
  state.materials = null;
  state.user = null;
  showLogin("已退出登录");
});
els.adminUsersBtn?.addEventListener("click", openAdminUsers);
els.changelogBtn?.addEventListener("click", openChangelog);
els.changelogCloseBtn?.addEventListener("click", closeChangelog);
els.changelogModal?.addEventListener("click", (event) => {
  if (event.target === els.changelogModal) closeChangelog();
});
els.adminUsersCloseBtn?.addEventListener("click", closeAdminUsers);
els.adminUsersModal?.addEventListener("click", (event) => {
  if (event.target === els.adminUsersModal) closeAdminUsers();
});
els.adminCreateUserBtn?.addEventListener("click", createAdminUserFromForm);
els.adminUsersList?.addEventListener("click", handleAdminUsersListClick);
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeChangelog();
});

checkAuth().then((authenticated) => {
  if (authenticated) return loadMaterials();
}).catch((error) => {
  showLogin(error.message);
});
