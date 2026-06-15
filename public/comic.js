const state = {
  materials: { roles: [], monsters: [], scenes: [], referenceVideos: [] },
  selectedRoles: new Set(),
  selectedMonsters: new Set(),
  selectedScenes: new Set(),
  selectedRefVideos: new Set(),
  user: null
};

const els = {
  projectSelect: document.querySelector("#comicProjectSelect"),
  renameProjectBtn: document.querySelector("#comicRenameProjectBtn"),
  deleteProjectBtn: document.querySelector("#comicDeleteProjectBtn"),
  changelogBtn: document.querySelector("#comicChangelogBtn"),
  changelogModal: document.querySelector("#comicChangelogModal"),
  changelogCloseBtn: document.querySelector("#comicChangelogCloseBtn"),
  refCount: document.querySelector("#comicRefCount"),
  roleCount: document.querySelector("#comicRoleCount"),
  sceneCount: document.querySelector("#comicSceneCount"),
  videoRefCount: document.querySelector("#comicVideoRefCount"),
  shotCount: document.querySelector("#comicShotCount"),
  dialogueCount: document.querySelector("#comicDialogueCount"),
  uploadRoleBtn: document.querySelector("#comicUploadRoleBtn"),
  uploadMonsterBtn: document.querySelector("#comicUploadMonsterBtn"),
  uploadSceneBtn: document.querySelector("#comicUploadSceneBtn"),
  uploadRefVideoBtn: document.querySelector("#comicUploadRefVideoBtn"),
  currentUserBadge: document.querySelector("#comicCurrentUserBadge"),
  logoutBtn: document.querySelector("#comicLogoutBtn"),
  roleGrid: document.querySelector("#comicRoleGrid"),
  monsterGrid: document.querySelector("#comicMonsterGrid"),
  sceneGrid: document.querySelector("#comicSceneGrid"),
  refVideoGrid: document.querySelector("#comicRefVideoGrid"),
  toggleRoles: document.querySelector("#comicToggleRoles"),
  toggleMonsters: document.querySelector("#comicToggleMonsters"),
  toggleScenes: document.querySelector("#comicToggleScenes"),
  toggleRefVideos: document.querySelector("#comicToggleRefVideos"),
  batchTag: document.querySelector("#comicBatchTag"),
  generateMode: document.querySelector("#comicGenerateMode"),
  projectName: document.querySelector("#comicProjectName"),
  mode: document.querySelector("#comicMode"),
  aspect: document.querySelector("#comicAspect"),
  duration: document.querySelector("#comicDuration"),
  style: document.querySelector("#comicStyle"),
  dimensionRadios: document.querySelectorAll('input[name="comicDimension"]'),
  audio: document.querySelector("#comicAudio"),
  roleSource: document.querySelector("#comicRoleSource"),
  characterIdentity: document.querySelector("#comicCharacterIdentity"),
  characterPersonality: document.querySelector("#comicCharacterPersonality"),
  characterOutfit: document.querySelector("#comicCharacterOutfit"),
  hero: document.querySelector("#comicHero"),
  villain: document.querySelector("#comicVillain"),
  hook: document.querySelector("#comicHook"),
  scene: document.querySelector("#comicScene"),
  shotList: document.querySelector("#shotList"),
  dialogueList: document.querySelector("#dialogueList"),
  addShotBtn: document.querySelector("#addShotBtn"),
  addDialogueBtn: document.querySelector("#addDialogueBtn"),
  buildPromptBtn: document.querySelector("#buildPromptBtn"),
  generateVideoBtn: document.querySelector("#generateVideoBtn"),
  copyPromptBtn: document.querySelector("#copyPromptBtn"),
  downloadPromptBtn: document.querySelector("#downloadPromptBtn"),
  generateStatus: document.querySelector("#comicGenerateStatus"),
  videoResult: document.querySelector("#comicVideoResult"),
  promptOutput: document.querySelector("#comicPromptOutput"),
  promptLength: document.querySelector("#promptLength"),
  runLog: document.querySelector("#comicRunLog")
};

const defaultShots = [
  { time: "0-1.5秒", camera: "超广角仰拍暴雨夜天空，乌云翻滚，雷电交织，镜头快速下压建立危机", action: "参考图1：一颗巨大燃烧火球从云层中急速坠落，火焰拖尾撕开雨幕，城市或山巅环境被橙红火光照亮", transition: "雷光闪白切入，不能同一景别停留太久" },
  { time: "1.5-3秒", camera: "远景切中景，火球即将砸落时镜头突然急停，再快速推近半空中的人影", action: "参考图2：一道黑色雨衣身影悬停在半空，狂风卷起雨衣衣摆，人物冷峻镇定，带强烈东方道术师气质", transition: "火球压迫感与人物静止形成反差，切反打看火球逼近" },
  { time: "3-5秒", camera: "近景到手部特写交替，先看道术师眼神，再反打到火球，最后切回双手", action: "参考图3：道术师猛然抬手掐诀，动作符合道家正常掐诀手法，手指变换极快、精准、利落、专业，诀印连续切换，有明确法术节奏", transition: "快切配合手指动作，必要时用0.5秒慢动作强调诀印完成" },
  { time: "5-7秒", camera: "微距手部特写，环绕半圈后拉到胸前中近景", action: "参考图4：掐诀瞬间指尖迸发金色灵光、细小电弧与炁流光丝，双手周围浮现微型法阵纹理，雨滴被无形法力震开形成旋转气场", transition: "灵光闪烁接雨滴被震开的慢动作" },
  { time: "7-9秒", camera: "跟拍符箓飞行，镜头贴近符纸穿过暴雨，再切道术师冷静侧脸反应", action: "参考图5：黄色符箓从指间飞出，在暴雨中高速前行并被金色道火点燃，朱砂符文逐渐发光，古老金色符文从符纸中浮现并游动缠绕", transition: "飞行镜头与人物反应镜头交替，避免长时间同景别" },
  { time: "9-11秒", camera: "俯仰结合，先跟随符文扩散，再仰拍天空能量凝聚", action: "参考图6：符文不断扩散，组成八卦轮廓与道家阵纹，天空中的能量迅速凝聚，雨幕被金色阵线切开", transition: "符文线条扩散做自然转场" },
  { time: "11-13秒", camera: "高空远景突然拉远，随后快速推入爆点，冲击波用短暂慢动作表现", action: "参考图7：符箓在高空轰然炸开，爆出一圈金色冲击波，巨大的风水阵法瞬间铺满天空，锁定坠落火球", transition: "爆点慢动作后接高速镜头，形成节奏反差" },
  { time: "13-15秒", camera: "超广角史诗全景，穿插道术师冷峻近景与火球被阵法压制的反打镜头", action: "参考图8、图9：层层圆环、八卦图、道家符号、古老咒文高速展开，形成恢弘立体玄门法阵；暴雨、雷电、火焰与金色阵光激烈碰撞，体积云、粒子特效、电影级光影、强烈仪式感", transition: "结尾定格在阵法锁住火球的史诗瞬间，不出现字幕" }
];

const defaultDialogues = [
  { speaker: "道术师", gender: "男", personality: "冷峻、沉稳、东方玄门宗师感", text: "天火将落，退。", timing: "第3秒，镜头推近人物冷峻表情时", style: "只作为人声对白播放，不出现字幕、不出现气泡、不出现屏幕文字；对白短促，避免同景别停留太久" },
  { speaker: "道术师", gender: "男", personality: "低沉、克制、念诀感强", text: "符起，阵开。", timing: "第7秒符箓飞出时", style: "只作为低声念诀的人声，配合法术动作和环境音，不要旁白，不要字幕" }
];

const dialogueToneSuggestions = [
  "冷峻、沉稳、东方玄门宗师感",
  "低沉、克制、念诀感强",
  "少年感、倔强、语速偏快",
  "温柔、坚定、有保护欲",
  "高傲、压迫感强、语速慢",
  "活泼、俏皮、轻快",
  "沙哑、疲惫、经历过大战",
  "神秘、空灵、带回声感"
];

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
    throw new Error(text.trim().startsWith("<") ? "接口返回了 HTML 页面，请检查 /api 是否代理到 Node 后端。" : text);
  }
  if (res.status === 401) throw new Error(data.error || "请先登录");
  if (!res.ok || data.error) throw new Error(data.error || "请求失败");
  return data;
}

async function checkAuth() {
  const auth = await api("/api/auth");
  state.user = auth.authenticated ? auth.user : null;
  if (els.currentUserBadge) els.currentUserBadge.textContent = state.user?.displayName || state.user?.username || "未登录";
  if (els.logoutBtn) els.logoutBtn.hidden = !state.user;
  updateProjectAdminActions();
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
  picker.accept = kind === "referenceVideo" ? "video/mp4,video/webm,video/quicktime" : "image/png,image/jpeg,image/webp";
  picker.onchange = async () => {
    const file = picker.files?.[0];
    if (!file) return;
    try {
      const content = await readFileAsDataUrl(file);
      await api("/api/upload-role", { method: "POST", body: JSON.stringify({ kind, mode: "add", name: file.name, content, allowVideo: kind === "referenceVideo" }) });
      await loadMaterials();
    } catch (error) {
      alert(error.message);
    }
  };
  picker.click();
}

function renderAssetGrid({ items, grid, selected, toggle, kind }) {
  grid.innerHTML = "";
  for (const item of items) {
    const canDelete = Boolean(state.user?.isAdmin && ["role", "monster", "referenceVideo"].includes(kind));
    const isVideo = kind === "referenceVideo";
    const card = document.createElement("label");
    card.className = `role-card ${selected.has(item.name) ? "selected" : ""}`;
    card.innerHTML = `
      <input type="checkbox" ${selected.has(item.name) ? "checked" : ""} />
      ${canDelete ? '<button class="delete-material" type="button" title="删除素材" aria-label="删除素材">×</button>' : ""}
      ${isVideo ? `<video src="${item.url}" muted controls preload="metadata" playsinline></video>` : `<img src="${item.url}" alt="${escapeHtml(item.title || item.name)}" />`}
      <b>${escapeHtml(item.title || item.name)}</b>
    `;
    const checkbox = card.querySelector("input");
    const deleteBtn = card.querySelector(".delete-material");
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) selected.add(item.name);
      else selected.delete(item.name);
      card.classList.toggle("selected", checkbox.checked);
      toggle.checked = items.length > 0 && selected.size === items.length;
      updateMetrics();
      buildPrompt();
    });
    deleteBtn?.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const label = kind === "monster" ? "怪物图" : "角色图";
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
    grid.append(card);
  }
  toggle.checked = items.length > 0 && selected.size === items.length;
}

async function loadMaterials() {
  const materials = await api("/api/materials");
  const keep = (set, items) => new Set(items.map((item) => item.name).filter((name) => set.has(name)));
  state.materials = materials;
  renderProjectSelect(materials.projects || []);
  state.selectedRoles = keep(state.selectedRoles, materials.roles || []);
  state.selectedMonsters = keep(state.selectedMonsters, materials.monsters || []);
  state.selectedScenes = keep(state.selectedScenes, materials.scenes || []);
  state.selectedRefVideos = keep(state.selectedRefVideos, materials.referenceVideos || []);
  renderAssetGrid({ items: materials.roles || [], grid: els.roleGrid, selected: state.selectedRoles, toggle: els.toggleRoles, kind: "role" });
  renderAssetGrid({ items: materials.monsters || [], grid: els.monsterGrid, selected: state.selectedMonsters, toggle: els.toggleMonsters, kind: "monster" });
  renderAssetGrid({ items: materials.scenes || [], grid: els.sceneGrid, selected: state.selectedScenes, toggle: els.toggleScenes, kind: "scene" });
  renderAssetGrid({ items: materials.referenceVideos || [], grid: els.refVideoGrid, selected: state.selectedRefVideos, toggle: els.toggleRefVideos, kind: "referenceVideo" });
  refreshShotReferenceVideoOptions();
  updateMetrics();
  buildPrompt();
}

function renderProjectSelect(projects) {
  if (!els.projectSelect) return;
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

function resetProjectState() {
  state.selectedRoles = new Set();
  state.selectedMonsters = new Set();
  state.selectedScenes = new Set();
  state.selectedRefVideos = new Set();
  if (els.toggleRoles) els.toggleRoles.checked = false;
  if (els.toggleMonsters) els.toggleMonsters.checked = false;
  if (els.toggleScenes) els.toggleScenes.checked = false;
  if (els.toggleRefVideos) els.toggleRefVideos.checked = false;
}

function selectedItems(items, selected) {
  return (items || []).filter((item) => selected.has(item.name));
}

function referenceLines() {
  const roles = selectedItems(state.materials.roles, state.selectedRoles);
  const monsters = selectedItems(state.materials.monsters, state.selectedMonsters);
  const scenes = selectedItems(state.materials.scenes, state.selectedScenes);
  const videos = selectedItems(state.materials.referenceVideos, state.selectedRefVideos);
  const lines = [];
  roles.forEach((item) => lines.push(`图片${lines.length + 1}：角色图 ${item.name}，用于主角/角色形象参考，保持角色外观特征一致。`));
  monsters.forEach((item) => lines.push(`图片${lines.length + 1}：怪物图 ${item.name}，用于反派/怪物形象参考，保持轮廓、颜色和威胁感一致。`));
  scenes.forEach((item) => lines.push(`图片${lines.length + 1}：场景图 ${item.name}，用于环境、构图、光影和空间层次参考。`));
  videos.forEach((item, index) => lines.push(`参考视频${index + 1}：${item.name}，仅用于分镜节奏、运镜、动作速度、转场和镜头停留参考，不复制原视频角色、品牌、文字或具体画面。`));
  return lines.length ? lines.join("\n") : "未勾选参考素材。可在左侧勾选角色图、怪物图、场景图、参考视频；生成时会按图片1、图片2和参考视频明确指代。";
}

function selectedDimension() {
  return document.querySelector('input[name="comicDimension"]:checked')?.value || "2D";
}

function dimensionStyleLine() {
  return selectedDimension() === "3D"
    ? "画面维度为3D国漫短片：角色和场景有明确体积感、空间纵深、电影级体积光、超写实雨夜材质和真实镜头运动，动作保持立体但不要改变分镜布局。"
    : "画面维度为2D游戏漫剧动画：漫画分镜感强，线条清晰，角色表情夸张，扁平动画节奏明确，动作和构图保持清楚。";
}

function updateMetrics() {
  const refTotal = state.selectedRoles.size + state.selectedMonsters.size + state.selectedScenes.size + state.selectedRefVideos.size;
  els.refCount.textContent = String(refTotal) + " 个参考";
  els.roleCount.textContent = state.selectedRoles.size;
  els.sceneCount.textContent = state.selectedScenes.size;
  if (els.videoRefCount) els.videoRefCount.textContent = state.selectedRefVideos.size;
  els.shotCount.textContent = document.querySelectorAll(".shot-card").length;
  els.dialogueCount.textContent = document.querySelectorAll(".dialogue-card").length;
}

function referenceVideoOptions(selectedName = "") {
  const videos = state.materials.referenceVideos || [];
  return ['<option value="">不指定</option>', ...videos.map((item) => '<option value="' + escapeHtml(item.name) + '" ' + (item.name === selectedName ? "selected" : "") + '>' + escapeHtml(item.title || item.name) + '</option>')].join("");
}

function refreshShotReferenceVideoOptions() {
  document.querySelectorAll(".shot-ref-video").forEach((select) => {
    const selected = select.value;
    select.innerHTML = referenceVideoOptions(selected);
  });
}

function createShotCard(data = {}) {
  const card = document.createElement("div");
  card.className = "shot-card";
  card.innerHTML = [
    '<label>时间 <input class="shot-time" type="text" value="' + escapeHtml(data.time || "") + '" /></label>',
    '<label>运镜/切镜 <input class="shot-camera" type="text" value="' + escapeHtml(data.camera || "") + '" /></label>',
    '<label>主体运动 <textarea class="shot-action requirement-text">' + escapeHtml(data.action || "") + '</textarea></label>',
    '<label>衔接 <input class="shot-transition" type="text" value="' + escapeHtml(data.transition || "") + '" /></label>',
    '<label>参考视频 <select class="shot-ref-video">' + referenceVideoOptions(data.referenceVideo || "") + '</select></label>',
    '<label>参考秒数 <input class="shot-ref-time" type="text" value="' + escapeHtml(data.referenceTime || "") + '" placeholder="如 3.2s 或 00:03-00:05" /></label>',
    '<button class="mini ghost remove-shot" type="button">删除</button>'
  ].join("");
  card.querySelector(".remove-shot").addEventListener("click", () => {
    card.remove();
    updateMetrics();
    buildPrompt();
  });
  card.querySelectorAll("input, textarea, select").forEach((input) => input.addEventListener("input", buildPrompt));
  card.querySelectorAll("select").forEach((input) => input.addEventListener("change", buildPrompt));
  els.shotList.append(card);
  updateMetrics();
}

function createDialogueCard(data = {}) {
  const card = document.createElement("div");
  card.className = "dialogue-card";
  const gender = data.gender || "不指定";
  const genderName = `dialogue-gender-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  card.innerHTML = `
    <label>角色 <input class="dialogue-speaker" type="text" value="${escapeHtml(data.speaker || "")}" /></label>
    <fieldset class="dialogue-gender">
      <legend>性别</legend>
      <label><input type="radio" name="${genderName}" value="男" ${gender === "男" ? "checked" : ""} /> 男</label>
      <label><input type="radio" name="${genderName}" value="女" ${gender === "女" ? "checked" : ""} /> 女</label>
      <label><input type="radio" name="${genderName}" value="不指定" ${gender !== "男" && gender !== "女" ? "checked" : ""} /> 不限</label>
    </fieldset>
    <label>语言性格 <input class="dialogue-personality" list="dialogueToneOptions" type="text" value="${escapeHtml(data.personality || "")}" placeholder="可输入新性格/声音要求" /></label>
    <label>台词 <input class="dialogue-text" type="text" value="${escapeHtml(data.text || "")}" /></label>
    <label>时机 <input class="dialogue-timing" type="text" value="${escapeHtml(data.timing || "")}" /></label>
    <label>表现方式 <textarea class="dialogue-style requirement-text">${escapeHtml(data.style || "")}</textarea></label>
    <button class="mini ghost remove-dialogue" type="button">删除</button>
  `;
  card.querySelector(".remove-dialogue").addEventListener("click", () => {
    card.remove();
    updateMetrics();
    buildPrompt();
  });
  card.querySelectorAll("input, textarea").forEach((input) => input.addEventListener("input", buildPrompt));
  card.querySelectorAll('input[type="radio"]').forEach((input) => input.addEventListener("change", buildPrompt));
  els.dialogueList.append(card);
  updateMetrics();
}

function collectShots() {
  return [...document.querySelectorAll(".shot-card")].map((card, index) => ({
    index: index + 1,
    time: card.querySelector(".shot-time")?.value.trim() || "",
    camera: card.querySelector(".shot-camera")?.value.trim() || "",
    action: card.querySelector(".shot-action")?.value.trim() || "",
    transition: card.querySelector(".shot-transition")?.value.trim() || "",
    referenceVideo: card.querySelector(".shot-ref-video")?.value.trim() || "",
    referenceTime: card.querySelector(".shot-ref-time")?.value.trim() || ""
  })).filter((item) => item.time || item.camera || item.action || item.transition || item.referenceVideo || item.referenceTime);
}

function collectDialogues() {
  return [...document.querySelectorAll(".dialogue-card")].map((card) => ({
    speaker: card.querySelector(".dialogue-speaker").value.trim(),
    gender: card.querySelector(".dialogue-gender input:checked")?.value || "不指定",
    personality: card.querySelector(".dialogue-personality").value.trim(),
    text: card.querySelector(".dialogue-text").value.trim(),
    timing: card.querySelector(".dialogue-timing").value.trim(),
    style: card.querySelector(".dialogue-style").value.trim()
  })).filter((item) => item.speaker || item.gender !== "不指定" || item.personality || item.text || item.timing || item.style);
}

function dialogueVoiceGuide(line) {
  const genderLine = line.gender && line.gender !== "不指定" ? `${line.gender}性声音` : "声音性别按角色形象自然判断";
  const personalityLine = line.personality ? `语言性格为${line.personality}` : "语气贴合角色形象、年龄感、服装气质和当前剧情压力";
  return `${genderLine}，${personalityLine}；根据角色形象、性别和性格自动匹配适合的说话语气、声线年龄、气息强弱、语速和情绪克制程度。`;
}

function rolePromptBlock() {
  const source = els.roleSource?.value || "reference";
  const identity = els.characterIdentity?.value.trim();
  const personality = els.characterPersonality?.value.trim();
  const outfit = els.characterOutfit?.value.trim();
  const hero = els.hero?.value.trim();
  const villain = els.villain?.value.trim();
  const manualLines = [
    identity ? `人物身份：${identity}` : "",
    personality ? `人物性格：${personality}` : "",
    outfit ? `服装外观：${outfit}` : "",
    hero ? `主角补充设定：${hero}` : ""
  ].filter(Boolean);
  const sourceLine = {
    reference: "角色来源：使用左侧已勾选角色图作为主角视觉参考，保持角色身份、比例、脸型、发型、服装、道具、体型、气质一致；手动设定只作为补充说明。",
    manual: "角色来源：不强制使用左侧角色图，优先按照下方手动人物设定生成主角。",
    mixed: "角色来源：以左侧已勾选角色图保持视觉一致性，同时叠加下方手动身份、性格、服装和表演补充。"
  }[source] || "";
  return [
    sourceLine,
    manualLines.join("\n"),
    villain ? `反派/怪物设定：${villain}` : ""
  ].filter(Boolean).join("\n");
}

function buildPrompt() {
  const shots = collectShots();
  const dialogues = collectDialogues();
  const prompt = [
    `生成一个${els.duration.value}的${els.aspect.value}游戏漫剧视频，生成类型为${els.mode.value}。`,
    "",
    "【多模态参考指代】",
    referenceLines(),
    "",
    "【角色功能】",
    rolePromptBlock(),
    "",
    "【剧情钩子】",
    `${els.hook.value.trim()}`,
    "",
    "【环境与美学】",
    `${els.scene.value.trim()}`,
    dimensionStyleLine(),
    `${els.style.value}`,
    "",
    "【分镜、动作与运镜】",
    shots.map((shot) => {
      const refVideo = shot.referenceVideo ? `参考视频：${shot.referenceVideo}${shot.referenceTime ? `，参考秒数：${shot.referenceTime}` : ""}；只参考该时间点附近的镜头节奏、运镜、动作速度、构图变化和转场方式，不复制视频中的角色、品牌、文字或具体画面。` : "";
      return `分镜${shot.index}（${shot.time || "未指定时间"}）：${shot.camera || "镜头自然衔接"}，${shot.action || "主体动作清晰"}，${shot.transition || "动作连贯过渡"}。${refVideo}`;
    }).join("\n"),
    "",
    "【对白与表演】",
    dialogues.length
      ? dialogues.map((line) => `${line.timing || "合适时机"}，${line.speaker || "角色"}说：“${line.text || "台词"}”。${dialogueVoiceGuide(line)}${line.style || "只播放人声对白，不出现字幕、气泡或屏幕文字。"}`).join("\n")
      : "如有对白，只播放人声对白，不出现字幕、气泡或屏幕文字；不要旁白。",
    "",
    "【音频】",
    els.audio.value,
    "",
    "【生成约束】",
    "提示词必须清晰指代图片1、图片2等参考对象；保持被参考主体的核心特征一致。",
    "如果参考分镜图，按分镜顺序出现；如果参考场景图，保持其构图、光影和空间层次。",
    "一句话不要同景别停留太久；对白较长时适当加入反打镜头、手部特写、环境反应镜头或动作插镜。",
    "只需要对话和剧情演绎，不要旁白，不要字幕，不要气泡台词，不要任何屏幕文字或logo。",
    "氛围光感按电影标准：暴雨、雷电、火焰、金色法阵、体积云、粒子特效、慢动作与高速镜头结合。",
    "不要复制无关品牌、水印或竞品专有元素；保持画面为高质量游戏漫剧广告质感。"
  ].filter(Boolean).join("\n");
  els.promptOutput.value = prompt;
  els.promptLength.textContent = `${prompt.length} 字`;
  renderChecklist(prompt, shots, dialogues);
}

function renderChecklist(prompt, shots, dialogues) {
  return { prompt, shots, dialogues };
}

function appendRunLog(message, type = "") {
  if (!els.runLog) return;
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  els.runLog.prepend(line);
}

function clearRunLog() {
  if (!els.runLog) return;
  els.runLog.innerHTML = '<div class="log-line">等待生成任务...</div>';
}

async function generateVideo() {
  if (!els.promptOutput.value.trim()) buildPrompt();
  if (!confirm("确定调用 Seedance 2.0 生成视频吗？这会消耗视频额度，生成可能需要几分钟。")) return;
  els.batchTag.value = defaultBatchTag();
  els.generateVideoBtn.disabled = true;
  els.generateStatus.textContent = "正在提交 Seedance 2.0...";
  els.videoResult.innerHTML = `<div class="empty-output">正在生成视频，请稍等...</div>`;
  clearRunLog();
  appendRunLog(`开始生成漫剧视频，批次 ${els.batchTag.value}`, "start");
  try {
    const selected = [
      ...selectedItems(state.materials.roles, state.selectedRoles),
      ...selectedItems(state.materials.monsters, state.selectedMonsters),
      ...selectedItems(state.materials.scenes, state.selectedScenes),
      ...selectedItems(state.materials.referenceVideos, state.selectedRefVideos)
    ];
    const shotVideoNames = new Set(collectShots().map((shot) => shot.referenceVideo).filter(Boolean));
    for (const item of state.materials.referenceVideos || []) {
      if (shotVideoNames.has(item.name) && !selected.some((selectedItem) => selectedItem.path === item.path)) selected.push(item);
    }
    appendRunLog(`提交 Seedance 2.0，参考素材 ${els.generateMode.value === "text" ? 0 : selected.length} 个，时长 ${Number.parseInt(els.duration.value, 10) || 15}s`, "start");
    const result = await api("/api/comic/generate-video", {
      method: "POST",
      body: JSON.stringify({
        prompt: els.promptOutput.value,
        ratio: els.aspect.value,
        duration: Number.parseInt(els.duration.value, 10) || 15,
        batchTag: `comic_${els.batchTag.value}`,
        assetPaths: els.generateMode.value === "text" ? [] : selected.map((item) => item.path)
      })
    });
    els.generateStatus.textContent = `生成完成：${result.model}`;
    appendRunLog(`生成完成：${result.model}，任务 ${result.taskId || "unknown"}`, "done");
    els.videoResult.innerHTML = `<video src="${result.url}" controls playsinline></video><a class="export-primary nav-link" href="${result.url}" download>下载视频</a>`;
  } catch (error) {
    els.generateStatus.textContent = `生成失败：${error.message}`;
    appendRunLog(`生成失败：${error.message}`, "error");
    alert(error.message);
  } finally {
    els.generateVideoBtn.disabled = false;
  }
}

els.batchTag.value = defaultBatchTag();
clearRunLog();
els.changelogBtn?.addEventListener("click", openChangelog);
els.changelogCloseBtn?.addEventListener("click", closeChangelog);
els.changelogModal?.addEventListener("click", (event) => {
  if (event.target === els.changelogModal) closeChangelog();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeChangelog();
});
els.projectSelect?.addEventListener("change", async () => {
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
      await loadMaterials();
    } catch (error) {
      alert(error.message);
      await loadMaterials();
    } finally {
      els.projectSelect.disabled = false;
    }
    return;
  }
  if (!projectRoot) return;
  els.projectSelect.disabled = true;
  try {
    await api("/api/projects/switch", { method: "POST", body: JSON.stringify({ projectRoot }) });
    resetProjectState();
    await loadMaterials();
  } catch (error) {
    alert(error.message);
    await loadMaterials();
  } finally {
    els.projectSelect.disabled = false;
  }
});

els.renameProjectBtn?.addEventListener("click", async () => {
  if (!state.user?.isAdmin) return alert("只有管理员可以修改项目名称");
  const projectRoot = els.projectSelect.value;
  if (!projectRoot || projectRoot === "__create_project__") return alert("请先选择项目");
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
  const projectRoot = els.projectSelect.value;
  if (!projectRoot || projectRoot === "__create_project__") return alert("请先选择项目");
  const option = els.projectSelect.selectedOptions[0];
  const currentName = (option?.dataset.name || option?.textContent || projectRoot).replace(/^当前：/, "").trim();
  if (!confirm(`确定从项目列表删除「${currentName}」吗？\n不会删除服务器上的项目文件夹。`)) return;
  els.deleteProjectBtn.disabled = true;
  try {
    await api("/api/projects/delete", { method: "POST", body: JSON.stringify({ projectRoot }) });
    resetProjectState();
    await loadMaterials();
  } catch (error) {
    alert(error.message);
  } finally {
    els.deleteProjectBtn.disabled = false;
  }
});

els.uploadRoleBtn.addEventListener("click", () => pickAndUpload("role"));
els.uploadMonsterBtn.addEventListener("click", () => pickAndUpload("monster"));
els.uploadSceneBtn.addEventListener("click", () => pickAndUpload("scene"));
els.uploadRefVideoBtn.addEventListener("click", () => pickAndUpload("referenceVideo"));
els.toggleRoles.addEventListener("change", () => {
  state.selectedRoles = new Set(els.toggleRoles.checked ? (state.materials.roles || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.roles || [], grid: els.roleGrid, selected: state.selectedRoles, toggle: els.toggleRoles, kind: "role" });
  updateMetrics(); buildPrompt();
});
els.toggleMonsters.addEventListener("change", () => {
  state.selectedMonsters = new Set(els.toggleMonsters.checked ? (state.materials.monsters || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.monsters || [], grid: els.monsterGrid, selected: state.selectedMonsters, toggle: els.toggleMonsters, kind: "monster" });
  updateMetrics(); buildPrompt();
});
els.toggleScenes.addEventListener("change", () => {
  state.selectedScenes = new Set(els.toggleScenes.checked ? (state.materials.scenes || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.scenes || [], grid: els.sceneGrid, selected: state.selectedScenes, toggle: els.toggleScenes, kind: "scene" });
  updateMetrics(); buildPrompt();
});
els.toggleRefVideos.addEventListener("change", () => {
  state.selectedRefVideos = new Set(els.toggleRefVideos.checked ? (state.materials.referenceVideos || []).map((item) => item.name) : []);
  renderAssetGrid({ items: state.materials.referenceVideos || [], grid: els.refVideoGrid, selected: state.selectedRefVideos, toggle: els.toggleRefVideos, kind: "referenceVideo" });
  updateMetrics(); buildPrompt();
});
els.addShotBtn.addEventListener("click", () => createShotCard({ time: "新增时间段", camera: "镜头描述", action: "主体动作", transition: "衔接方式" }));
els.addDialogueBtn.addEventListener("click", () => createDialogueCard({ speaker: "角色", gender: "不指定", personality: "", text: "台词", timing: "出现时机", style: "只播放人声对白，不出现字幕、气泡或屏幕文字" }));
els.buildPromptBtn.addEventListener("click", buildPrompt);
els.generateVideoBtn.addEventListener("click", generateVideo);
els.copyPromptBtn.addEventListener("click", async () => {
  if (!els.promptOutput.value.trim()) buildPrompt();
  await navigator.clipboard.writeText(els.promptOutput.value);
  els.copyPromptBtn.textContent = "已复制";
  setTimeout(() => (els.copyPromptBtn.textContent = "复制"), 1000);
});
els.logoutBtn?.addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: "{}" });
  } catch {
    // Ignore logout transport errors and return to the login flow.
  }
  location.href = "/";
});
els.downloadPromptBtn.addEventListener("click", () => {
  if (!els.promptOutput.value.trim()) buildPrompt();
  const blob = new Blob([els.promptOutput.value], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${els.projectName.value.trim() || "game-comic"}-seedance-prompt.txt`;
  a.click();
  URL.revokeObjectURL(url);
});
[els.projectName, els.mode, els.aspect, els.duration, els.style, els.audio, els.roleSource, els.characterIdentity, els.characterPersonality, els.characterOutfit, els.hero, els.villain, els.hook, els.scene].filter(Boolean).forEach((input) => input.addEventListener("input", buildPrompt));
els.roleSource?.addEventListener("change", buildPrompt);
els.dimensionRadios.forEach((input) => input.addEventListener("change", buildPrompt));

const toneList = document.createElement("datalist");
toneList.id = "dialogueToneOptions";
toneList.innerHTML = dialogueToneSuggestions.map((item) => `<option value="${escapeHtml(item)}"></option>`).join("");
document.body.append(toneList);

for (const shot of defaultShots) createShotCard(shot);
for (const dialogue of defaultDialogues) createDialogueCard(dialogue);
buildPrompt();
checkAuth().then(() => loadMaterials()).catch((error) => alert(error.message));
