const DEFAULT_GENERAL_PROMPT = `生成 15 秒竖屏 9:16 Q版手游角色展示广告，节奏必须非常快，像高爽感买量短视频：开头 0.5 秒内必须有爆点，中段每 1-1.5 秒都要有明确动作爽点，结尾必须有角色记忆点。不要慢铺垫、不要长时间走路、不要站桩展示、不要单一长镜头。
唯一主角必须使用上传角色图中的角色，保持角色外观完全一致：发型、脸型、眼睛、表情、头饰/王冠/角/耳朵、服装、武器、手持道具、漂浮道具、主色系和关键轮廓都不能变形或消失。
默认叙事结构：0-1秒强钩子，直接爆光、冲入、落地震屏或道具瞬间点燃，主角可以短暂看向镜头建立记忆点；1-3秒第一段动作爽点，主角立刻转身面向怪物/目标出手，出现第一次击飞或强反馈；3-6秒第二段连击爽点，快速切 2-3 个短镜头，连续命中、弹飞、追击、残影或连环技能；6-9秒第三段升级爽点，技能规模明显变大，镜头推拉、环绕、震屏、粒子爆发，不能停顿；9-13秒高潮大招，必须有大范围能量爆发、怪物群被清场或目标被压制，动作仍要对准怪物/目标，表现清楚攻击方向、命中反馈和空间关系；13-15秒结尾记忆点，只做角色拉近镜头展示，不要游戏下载引导、下载按钮、下载区域或额外广告文案。根据角色性格和形象给合适表情与小动作，例如俏皮坏笑、自信挑眉、冷酷凝视、害羞眨眼、骄傲扬头、温柔微笑或战后喘息，镜头拉近到脸部/半身，突出眼神、脸、头饰、武器或核心道具。
分镜和镜头规则：平均每 1 秒必须有动作变化或镜头变化，使用快切、推近、拉远、侧跟、反打、冲击定格、0.2秒慢动作后立刻加速等节奏。战斗/技能/互动段要用远景交代主角与怪物位置、侧面中景表现出手方向、反打镜头表现怪物被击中、近景只用于手部/道具/表情瞬间，不要连续正脸看镜头。主角朝向必须跟随目标移动，怪物在画面上方/前方/侧前方时，主角就朝对应方向出手。
如果勾选怪物图，怪物只作为敌群、压迫感目标或被击飞对象，外观参考上传怪物图，但不能抢主角戏份；如果没有怪物图，可以生成原创通用小怪或能量靶作为爽感反馈对象。
画面要求：Q版卡通手游美术，强技能特效，强震屏，快速推拉镜头，冲击波，残影拖尾，粒子爆发，短促音效点，连击反馈，适合短视频广告投放。
负向要求：不要竞品logo，不要竞品角色，不要竞品UI，不要真实品牌，不要水印，不要文字乱码，不要字幕，不要血条、伤害数字、按钮、卡牌或技能范围框，不要游戏下载引导、下载按钮、下载文案或下载区域，不要慢走、站桩、长时间摆pose、空镜头、慢节奏铺垫、连续 2 秒没有动作变化，不要改变主角外观，不要让主角在战斗过程中一直盯着镜头，不要让王冠、火球、武器、铃铛、裙子、发型、漂浮物或关键道具变形或消失。`;

const state = {
  user: null,
  materials: { roles: [], monsters: [], scenes: [], logos: [] },
  selectedRoles: new Set(),
  selectedMonsters: new Set(),
  selectedScenes: new Set(),
  selectedLogos: new Set(),
  selectedBatches: new Set(),
  batchesInitialized: false,
  batchFilterTouched: false,
  activeBatchTag: ""
};

const $ = (selector) => document.querySelector(selector);

const els = {
  projectSelect: $("#showcaseProjectSelect"),
  renameProjectBtn: $("#showcaseRenameProjectBtn"),
  deleteProjectBtn: $("#showcaseDeleteProjectBtn"),
  changelogBtn: $("#showcaseChangelogBtn"),
  changelogModal: $("#showcaseChangelogModal"),
  changelogCloseBtn: $("#showcaseChangelogCloseBtn"),
  currentUserBadge: $("#showcaseCurrentUserBadge"),
  logoutBtn: $("#showcaseLogoutBtn"),
  refCount: $("#showcaseRefCount"),
  roleCount: $("#showcaseRoleCount"),
  monsterCount: $("#showcaseMonsterCount"),
  sceneCount: $("#showcaseSceneCount"),
  logoCount: $("#showcaseLogoCount"),
  uploadRoleBtn: $("#showcaseUploadRoleBtn"),
  uploadMonsterBtn: $("#showcaseUploadMonsterBtn"),
  uploadSceneBtn: $("#showcaseUploadSceneBtn"),
  uploadLogoBtn: $("#showcaseUploadLogoBtn"),
  roleGrid: $("#showcaseRoleGrid"),
  monsterGrid: $("#showcaseMonsterGrid"),
  sceneGrid: $("#showcaseSceneGrid"),
  logoGrid: $("#showcaseLogoGrid"),
  toggleRoles: $("#showcaseToggleRoles"),
  toggleMonsters: $("#showcaseToggleMonsters"),
  toggleScenes: $("#showcaseToggleScenes"),
  toggleLogos: $("#showcaseToggleLogos"),
  batchTag: $("#showcaseBatchTag"),
  repeatCount: $("#showcaseRepeatCount"),
  roleDesc: $("#showcaseRoleDesc"),
  videoModel: $("#showcaseVideoModel"),
  generalPrompt: $("#showcaseGeneralPrompt"),
  specialPrompt: $("#showcaseSpecialPrompt"),
  resetPromptBtn: $("#showcaseResetPromptBtn"),
  buildPromptBtn: $("#showcaseBuildPromptBtn"),
  copyPromptBtn: $("#showcaseCopyPromptBtn"),
  generateVideoBtn: $("#showcaseGenerateVideoBtn"),
  generateStatus: $("#showcaseGenerateStatus"),
  outputGrid: $("#showcaseOutputGrid"),
  batchFilters: $("#showcaseBatchFilters"),
  outputCount: $("#showcaseOutputCount"),
  exportOutputsBtn: $("#showcaseExportOutputsBtn"),
  promptOutput: $("#showcasePromptOutput"),
  promptLength: $("#showcasePromptLength"),
  runLog: $("#showcaseRunLog")
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}

function defaultBatchTag() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function api(path, options = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  const text = await res.text();
  let data = {};
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(text.trim().startsWith("<") ? "接口返回了 HTML 页面，请检查服务或登录状态。" : text);
  }
  if (res.status === 401) throw new Error(data.error || "请先登录");
  if (!res.ok || data.error) throw new Error(data.error || "请求失败");
  return data;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("素材读取失败"));
    reader.readAsDataURL(file);
  });
}

async function pickAndUpload(kind) {
  const picker = document.createElement("input");
  picker.type = "file";
  picker.accept = "image/png,image/jpeg,image/webp";
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      const content = await readFileAsDataUrl(file);
      await api("/api/upload-role", { method: "POST", body: JSON.stringify({ kind, mode: "add", name: file.name, content }) });
      clearGeneratedPrompt();
      await loadMaterials();
    } catch (error) {
      alert(error.message);
    }
  };
  picker.click();
}

function selectedItems(items, selected) {
  return (items || []).filter((item) => selected.has(item.name));
}

function selectedPayload() {
  return {
    roles: selectedItems(state.materials.roles, state.selectedRoles),
    monsters: selectedItems(state.materials.monsters, state.selectedMonsters),
    scenes: selectedItems(state.materials.scenes, state.selectedScenes),
    logos: selectedItems(state.materials.logos, state.selectedLogos)
  };
}

function renderProjectSelect(projects) {
  if (!els.projectSelect) return;
  els.projectSelect.innerHTML = "";
  for (const project of projects || []) {
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

function updateProjectAdminActions() {
  const hidden = !state.user?.isAdmin;
  if (els.renameProjectBtn) els.renameProjectBtn.hidden = hidden;
  if (els.deleteProjectBtn) els.deleteProjectBtn.hidden = hidden;
}

function resetProjectState() {
  state.selectedRoles = new Set();
  state.selectedMonsters = new Set();
  state.selectedScenes = new Set();
  state.selectedLogos = new Set();
}

function materialKindLabel(kind) {
  return kind === "monster" ? "\u602a\u7269\u56fe"
    : kind === "scene" ? "\u573a\u666f\u56fe"
    : kind === "logo" ? "\u4ea7\u54c1 Logo"
      : "\u89d2\u8272\u56fe";
}

function renderAssetGrid({ items, grid, selected, toggle, kind }) {
  grid.innerHTML = "";
  for (const item of items || []) {
    const canAdminManage = Boolean(state.user?.isAdmin && ["role", "monster", "scene", "logo"].includes(kind));
    const card = document.createElement("label");
    card.className = `role-card ${selected.has(item.name) ? "selected" : ""}`;
    card.innerHTML = `
      <input type="checkbox" ${selected.has(item.name) ? "checked" : ""} />
      ${canAdminManage ? `
        <button class="material-settings" type="button" title="\u7d20\u6750\u8bbe\u7f6e" aria-label="\u7d20\u6750\u8bbe\u7f6e">&#9881;</button>
        <div class="material-menu" hidden>
          <button class="rename-material" type="button">\u91cd\u547d\u540d</button>
          <button class="delete-material danger" type="button">\u5220\u9664</button>
        </div>
      ` : ""}
      <img src="${item.url}" alt="${escapeHtml(item.title || item.name)}" />
      <b>${escapeHtml(item.title || item.name)}</b>
    `;
    const checkbox = card.querySelector("input");
    const settingsBtn = card.querySelector(".material-settings");
    const menu = card.querySelector(".material-menu");
    const renameBtn = card.querySelector(".rename-material");
    const deleteBtn = card.querySelector(".delete-material");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(item.name);
      else selected.delete(item.name);
      card.classList.toggle("selected", checkbox.checked);
      toggle.checked = (items || []).length > 0 && selected.size === (items || []).length;
      updateMetrics();
      clearGeneratedPrompt();
    });

    settingsBtn?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      document.querySelectorAll(".material-menu").forEach((itemMenu) => {
        if (itemMenu !== menu) itemMenu.hidden = true;
      });
      if (menu) menu.hidden = !menu.hidden;
    });

    menu?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
    });

    renameBtn?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu) menu.hidden = true;
      const ext = item.name.includes(".") ? `.${item.name.split(".").pop()}` : "";
      const currentBase = ext ? item.name.slice(0, -ext.length) : item.name;
      const nextName = prompt("\u8bf7\u8f93\u5165\u65b0\u7684\u7d20\u6750\u540d\u79f0", item.title || currentBase);
      if (nextName == null) return;
      const cleanName = nextName.trim();
      if (!cleanName) return alert("\u7d20\u6750\u540d\u79f0\u4e0d\u80fd\u4e3a\u7a7a");
      renameBtn.disabled = true;
      try {
        await api("/api/materials/rename", { method: "POST", body: JSON.stringify({ kind, name: item.name, newName: cleanName }) });
        selected.delete(item.name);
        await loadMaterials();
      } catch (error) {
        alert(error.message);
      } finally {
        renameBtn.disabled = false;
      }
    });

    deleteBtn?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (menu) menu.hidden = true;
      if (!confirm(`\u786e\u5b9a\u5220\u9664\u8fd9\u4e2a${materialKindLabel(kind)}\u5417\uff1f\n${item.name}`)) return;
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
    grid.append(card);
  }
  toggle.checked = (items || []).length > 0 && selected.size === (items || []).length;
}
async function checkAuth() {
  const auth = await api("/api/auth");
  state.user = auth.authenticated ? auth.user : null;
  if (!state.user) {
    location.href = "/";
    return;
  }
  els.currentUserBadge.textContent = state.user.displayName || state.user.username || "已登录";
  els.logoutBtn.hidden = false;
  updateProjectAdminActions();
}

async function loadMaterials() {
  const materials = await api("/api/materials");
  const keep = (set, items) => new Set((items || []).map((item) => item.name).filter((name) => set.has(name)));
  state.materials = materials;
  renderProjectSelect(materials.projects || []);
  state.selectedRoles = keep(state.selectedRoles, materials.roles || []);
  state.selectedMonsters = keep(state.selectedMonsters, materials.monsters || []);
  state.selectedScenes = keep(state.selectedScenes, materials.scenes || []);
  state.selectedLogos = keep(state.selectedLogos, materials.logos || []);
  renderAssetGrid({ items: materials.roles || [], grid: els.roleGrid, selected: state.selectedRoles, toggle: els.toggleRoles, kind: "role" });
  renderAssetGrid({ items: materials.monsters || [], grid: els.monsterGrid, selected: state.selectedMonsters, toggle: els.toggleMonsters, kind: "monster" });
  renderAssetGrid({ items: materials.scenes || [], grid: els.sceneGrid, selected: state.selectedScenes, toggle: els.toggleScenes, kind: "scene" });
  renderAssetGrid({ items: materials.logos || [], grid: els.logoGrid, selected: state.selectedLogos, toggle: els.toggleLogos, kind: "logo" });
  updateMetrics();
  renderOutputs();
  clearGeneratedPrompt();
}

function updateMetrics() {
  const total = state.selectedRoles.size + state.selectedMonsters.size + state.selectedScenes.size + state.selectedLogos.size;
  els.refCount.textContent = `${total} 个参考`;
  els.roleCount.textContent = state.selectedRoles.size;
  els.monsterCount.textContent = state.selectedMonsters.size;
  if (els.sceneCount) els.sceneCount.textContent = state.selectedScenes.size;
  els.logoCount.textContent = state.selectedLogos.size;
}

function showcaseOutputs() {
  return (state.materials.outputs || []).filter((output) => {
    const batch = String(output.batch || "");
    const name = String(output.name || "");
    return output.type === "video" && (output.module === "role_showcase" || batch.startsWith("role_showcase_") || name.includes("role_showcase_"));
  });
}

function renderOutputs() {
  if (!els.outputGrid || !els.batchFilters || !els.outputCount) return;
  const outputs = showcaseOutputs();
  const batches = [...new Set(outputs.map((output) => output.batch || "未分组"))];
  if (!state.batchesInitialized) {
    state.selectedBatches = state.activeBatchTag && batches.includes(state.activeBatchTag) ? new Set([state.activeBatchTag]) : new Set(batches);
    state.batchesInitialized = true;
  } else if (!state.batchFilterTouched && state.activeBatchTag) {
    state.selectedBatches = batches.includes(state.activeBatchTag) ? new Set([state.activeBatchTag]) : new Set();
  } else {
    state.selectedBatches = new Set([...state.selectedBatches].filter((batch) => batches.includes(batch)));
  }
  renderBatchFilters(batches);
  const visibleOutputs = outputs.filter((output) => state.selectedBatches.has(output.batch || "未分组"));
  els.outputCount.textContent = `${visibleOutputs.length} / ${outputs.length} 个`;
  if (els.exportOutputsBtn) {
    els.exportOutputsBtn.disabled = visibleOutputs.length <= 0 || state.selectedBatches.size <= 0;
    els.exportOutputsBtn.title = els.exportOutputsBtn.disabled ? "请先勾选要下载的结果批次" : "";
  }
  els.outputGrid.innerHTML = "";
  if (!visibleOutputs.length) {
    els.outputGrid.innerHTML = `<div class="empty-output">未勾选批次或暂无角色展示视频</div>`;
    return;
  }
  for (const output of visibleOutputs.slice(0, 120)) {
    const card = document.createElement("article");
    card.className = "output-card showcase-output-card";
    card.innerHTML = `
      <video src="${escapeHtml(output.url)}" muted controls preload="metadata" playsinline></video>
      <em>${escapeHtml(output.batch || "未分组")}</em>
      <b>${escapeHtml(output.name)}</b>
      <a class="mini ghost showcase-download-link" href="${escapeHtml(output.url)}" download>下载</a>
    `;
    els.outputGrid.append(card);
  }
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

async function downloadSelectedBatches() {
  if (!state.selectedBatches.size) return alert("请先勾选要下载的批次。");
  const res = await fetch("/api/outputs/export", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ batches: [...state.selectedBatches], module: "role_showcase" })
  });
  if (!res.ok) {
    let errorText = "下载失败";
    try {
      const data = await res.json();
      errorText = data.error || errorText;
    } catch {}
    throw new Error(errorText);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `role-showcase-results-${Date.now()}.zip`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function clearGeneratedPrompt() {
  if (!els.promptOutput) return;
  els.promptOutput.value = "";
  els.promptLength.textContent = "0 字";
}

function appendRunLog(message, type = "") {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  els.runLog.prepend(line);
}

async function buildPrompt() {
  els.generateStatus.textContent = "已点击生成提示词，正在检查素材...";
  appendRunLog("点击生成提示词", "start");
  if (!state.selectedRoles.size) {
    els.generateStatus.textContent = "请先勾选至少 1 张角色图";
    alert("请先勾选至少 1 张角色图。");
    return "";
  }
  const selected = selectedPayload();
  clearGeneratedPrompt();
  els.buildPromptBtn.disabled = true;
  els.buildPromptBtn.textContent = "生成中...";
  els.generateStatus.textContent = "正在生成最终提示词...";
  appendRunLog("开始调用模型生成最终 Seedance 提示词", "start");
  try {
    const result = await api("/api/role-showcase/generate-prompt", {
      method: "POST",
      body: JSON.stringify({
        roleDesc: els.roleDesc.value.trim(),
        generalPrompt: els.generalPrompt.value.trim(),
        specialPrompt: els.specialPrompt.value.trim(),
        roles: selected.roles.map((item) => ({ name: item.name, title: item.title, traits: item.traits, path: item.sourcePath || item.path })),
        monsters: selected.monsters.map((item) => ({ name: item.name, title: item.title, traits: item.traits, path: item.sourcePath || item.path })),
        scenes: selected.scenes.map((item) => ({ name: item.name, title: item.title, traits: item.traits, path: item.sourcePath || item.path })),
        logos: selected.logos.map((item) => ({ name: item.name, title: item.title, traits: item.traits, path: item.sourcePath || item.path }))
      })
    });
    const prompt = String(result.prompt || "").trim();
    if (!prompt) throw new Error("模型没有返回提示词，请重试。");
    els.promptOutput.value = prompt;
    els.promptLength.textContent = `${prompt.length} 字`;
    els.generateStatus.textContent = `提示词已生成：${result.model || "gpt-5.5"}`;
    appendRunLog(`最终提示词已生成，长度 ${prompt.length} 字`, "done");
    return prompt;
  } catch (error) {
    els.generateStatus.textContent = `提示词生成失败：${error.message}`;
    appendRunLog(`提示词生成失败：${error.message}`, "error");
    alert(error.message);
    return "";
  } finally {
    els.buildPromptBtn.disabled = false;
    els.buildPromptBtn.textContent = "生成提示词";
  }
}

async function generateVideo() {
  if (!state.selectedRoles.size) {
    alert("请先勾选至少 1 张角色图。");
    return;
  }
  const prompt = els.promptOutput.value.trim();
  if (!prompt) {
    alert("请先点击「生成提示词」，确认最终 Seedance 提示词后再生成视频。");
    return;
  }
  els.batchTag.value = defaultBatchTag();
  const batchTag = `role_showcase_${els.batchTag.value}`;
  const repeatCount = Math.max(1, Math.min(20, Number(els.repeatCount?.value || 1) || 1));
  state.activeBatchTag = batchTag;
  state.batchFilterTouched = false;
  els.generateVideoBtn.disabled = true;
  els.generateStatus.textContent = "正在提交 Seedance 2.0...";
  appendRunLog(`开始生成角色展示视频，批次 ${els.batchTag.value}，次数 ${repeatCount}`, "start");
  try {
    const selected = [
      ...selectedItems(state.materials.roles, state.selectedRoles),
      ...selectedItems(state.materials.monsters, state.selectedMonsters),
      ...selectedItems(state.materials.scenes, state.selectedScenes),
      ...selectedItems(state.materials.logos, state.selectedLogos)
    ];
    let lastResult = null;
    for (let index = 0; index < repeatCount; index += 1) {
      els.generateStatus.textContent = `正在生成视频 ${index + 1}/${repeatCount}...`;
      appendRunLog(`提交第 ${index + 1}/${repeatCount} 条视频`, "start");
      lastResult = await api("/api/comic/generate-video", {
        method: "POST",
        body: JSON.stringify({
          prompt,
          ratio: "9:16",
          duration: 15,
          videoModel: els.videoModel.value,
          batchTag,
          assetPaths: selected.map((item) => item.sourcePath || item.path).filter(Boolean)
        })
      });
      appendRunLog(`第 ${index + 1}/${repeatCount} 条完成，任务 ${lastResult.taskId || "unknown"}`, "done");
    }
    els.generateStatus.textContent = `生成完成：${lastResult?.modelLabel || lastResult?.model || els.videoModel.value}`;
    await loadMaterials();
  } catch (error) {
    els.generateStatus.textContent = `生成失败：${error.message}`;
    appendRunLog(`生成失败：${error.message}`, "error");
    alert(error.message);
  } finally {
    els.generateVideoBtn.disabled = false;
  }
}

els.batchTag.value = defaultBatchTag();
els.roleDesc.value = "";
els.generalPrompt.value = DEFAULT_GENERAL_PROMPT;
els.runLog.innerHTML = '<div class="log-line">等待生成任务...</div>';

els.uploadRoleBtn.addEventListener("click", () => pickAndUpload("role"));
els.uploadMonsterBtn.addEventListener("click", () => pickAndUpload("monster"));
els.uploadSceneBtn?.addEventListener("click", () => pickAndUpload("scene"));
els.uploadLogoBtn.addEventListener("click", () => pickAndUpload("logo"));

els.toggleRoles.addEventListener("change", () => {
  state.selectedRoles = new Set(els.toggleRoles.checked ? (state.materials.roles || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.roles || [], grid: els.roleGrid, selected: state.selectedRoles, toggle: els.toggleRoles, kind: "role" });
  updateMetrics();
  clearGeneratedPrompt();
});

els.toggleMonsters.addEventListener("change", () => {
  state.selectedMonsters = new Set(els.toggleMonsters.checked ? (state.materials.monsters || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.monsters || [], grid: els.monsterGrid, selected: state.selectedMonsters, toggle: els.toggleMonsters, kind: "monster" });
  updateMetrics();
  clearGeneratedPrompt();
});

els.toggleScenes?.addEventListener("change", () => {
  state.selectedScenes = new Set(els.toggleScenes.checked ? (state.materials.scenes || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.scenes || [], grid: els.sceneGrid, selected: state.selectedScenes, toggle: els.toggleScenes, kind: "scene" });
  updateMetrics();
  clearGeneratedPrompt();
});

els.toggleLogos.addEventListener("change", () => {
  state.selectedLogos = new Set(els.toggleLogos.checked ? (state.materials.logos || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.logos || [], grid: els.logoGrid, selected: state.selectedLogos, toggle: els.toggleLogos, kind: "logo" });
  updateMetrics();
  clearGeneratedPrompt();
});

els.resetPromptBtn.addEventListener("click", () => {
  els.generalPrompt.value = DEFAULT_GENERAL_PROMPT;
  clearGeneratedPrompt();
});

els.buildPromptBtn?.addEventListener("click", async () => {
  try {
    await buildPrompt();
  } catch (error) {
    els.generateStatus.textContent = `提示词生成失败：${error.message}`;
    appendRunLog(`提示词生成失败：${error.message}`, "error");
    alert(error.message);
  }
});

els.copyPromptBtn.addEventListener("click", async () => {
  const prompt = els.promptOutput.value.trim();
  if (!prompt) {
    alert("请先点击「生成提示词」。");
    return;
  }
  await navigator.clipboard.writeText(prompt);
  els.copyPromptBtn.textContent = "已复制";
  setTimeout(() => (els.copyPromptBtn.textContent = "复制"), 1000);
});

els.generateVideoBtn.addEventListener("click", generateVideo);
els.exportOutputsBtn?.addEventListener("click", async () => {
  try {
    els.exportOutputsBtn.disabled = true;
    els.generateStatus.textContent = "正在打包选中批次...";
    await downloadSelectedBatches();
    els.generateStatus.textContent = "选中批次已开始下载";
  } catch (error) {
    els.generateStatus.textContent = `下载失败：${error.message}`;
    alert(error.message);
  } finally {
    renderOutputs();
  }
});

[els.roleDesc, els.generalPrompt, els.specialPrompt, els.videoModel].forEach((input) => input.addEventListener("input", clearGeneratedPrompt));

els.projectSelect.addEventListener("change", async () => {
  const projectRoot = els.projectSelect.value;
  if (projectRoot === "__create_project__") {
    if (!state.user?.isAdmin) {
      await loadMaterials();
      return alert("只有管理员可以新增项目。");
    }
    const name = prompt("请输入新项目名称");
    if (name == null) return loadMaterials();
    const nextName = name.trim();
    if (!nextName) return loadMaterials();
    await api("/api/projects/create", { method: "POST", body: JSON.stringify({ name: nextName }) });
    resetProjectState();
    await loadMaterials();
    return;
  }
  if (!projectRoot) return;
  await api("/api/projects/switch", { method: "POST", body: JSON.stringify({ projectRoot }) });
  resetProjectState();
  await loadMaterials();
});

els.renameProjectBtn.addEventListener("click", async () => {
  if (!state.user?.isAdmin) return alert("只有管理员可以修改项目名称。");
  const projectRoot = els.projectSelect.value;
  if (!projectRoot || projectRoot === "__create_project__") return alert("请先选择项目");
  const currentName = (els.projectSelect.selectedOptions[0]?.dataset.name || "").trim();
  const name = prompt("请输入新的项目名称", currentName);
  if (name == null || !name.trim()) return;
  await api("/api/projects/rename", { method: "POST", body: JSON.stringify({ projectRoot, name: name.trim() }) });
  await loadMaterials();
});

els.deleteProjectBtn.addEventListener("click", async () => {
  if (!state.user?.isAdmin) return alert("只有管理员可以删除项目。");
  const projectRoot = els.projectSelect.value;
  if (!projectRoot || projectRoot === "__create_project__") return alert("请先选择项目");
  const currentName = (els.projectSelect.selectedOptions[0]?.dataset.name || projectRoot).trim();
  if (!confirm(`确定从项目列表删除「${currentName}」吗？不会删除服务器上的项目文件夹。`)) return;
  await api("/api/projects/delete", { method: "POST", body: JSON.stringify({ projectRoot }) });
  resetProjectState();
  await loadMaterials();
});

els.changelogBtn.addEventListener("click", () => (els.changelogModal.hidden = false));
els.changelogCloseBtn.addEventListener("click", () => (els.changelogModal.hidden = true));
els.changelogModal.addEventListener("click", (event) => {
  if (event.target === els.changelogModal) els.changelogModal.hidden = true;
});

els.logoutBtn.addEventListener("click", async () => {
  await api("/api/logout", { method: "POST", body: "{}" }).catch(() => {});
  location.href = "/";
});

document.addEventListener("click", (event) => {
  if (event.target.closest?.(".material-settings") || event.target.closest?.(".material-menu")) return;
  document.querySelectorAll(".material-menu").forEach((menu) => {
    menu.hidden = true;
  });
});

clearGeneratedPrompt();
checkAuth().then(loadMaterials).catch((error) => alert(error.message));
