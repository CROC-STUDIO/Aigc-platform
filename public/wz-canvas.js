// Horizontal node-canvas controller for the 网赚 pipeline.
// - Draws SVG links between nodes based on their REAL DOM positions
//   (no hard-coded coordinates → never misaligns, fully responsive).
// - Supports fan-out: "+ 添加改写分支" clones the rewrite node as a real
//   editable branch. The first branch keeps IDs for legacy bindings; clones
//   use data-branch-field attributes so business JS can save every branch.
// - Step bar click → smooth scroll; scroll → highlight current stage.
// Self-contained, no imports, safe to load with `defer`.
(() => {
  const canvas = document.getElementById("wzCanvas");
  const svg = document.getElementById("wzCanvasLinks");
  if (!canvas || !svg) return;

  canvas.setAttribute("tabindex", "0");

  const SVGNS = "http://www.w3.org/2000/svg";

  // Inject a collapse chevron button into every node header.
  function ensureCollapseButtons() {
    for (const head of canvas.querySelectorAll(".wz-node > .panel-head")) {
      if (head.querySelector(".wz-collapse-btn")) continue;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wz-collapse-btn";
      btn.title = "折叠 / 展开此节点";
      btn.setAttribute("aria-label", "折叠或展开此节点");
      btn.textContent = "▾";
      head.appendChild(btn);
    }
  }
  ensureCollapseButtons();

  // --- Link drawing -------------------------------------------------------
  // Each edge: from a source node's right port to a target node's left port.
  // Topology is fixed (upload → decompose → [branches] → batch → log/output),
  // but geometry is computed live from getBoundingClientRect.
  function nodeById(id) {
    return document.getElementById(id);
  }

  function edges() {
    const list = [];
    const upload = nodeById("wzNodeUpload");
    const decompose = nodeById("wzNodeDecompose");
    const batch = nodeById("wzNodeBatch");
    const log = nodeById("wzNodeLog");
    const output = nodeById("wzNodeOutput");
    const branches = [...document.querySelectorAll(".wz-node-branch")];

    if (upload && decompose) list.push([upload, decompose, "flow-blue"]);
    // fan-out: decompose → every rewrite branch
    for (const b of branches) {
      if (decompose) list.push([decompose, b, "flow-purple"]);
      // fan-in: every rewrite branch → batch
      if (batch) list.push([b, batch, "flow-purple"]);
    }
    if (batch && log) list.push([batch, log, "flow-blue"]);
    // batch also feeds the output node (visual fan-out on the result side)
    if (batch && output) list.push([batch, output, "flow-green"]);
    return list;
  }

  // Position of an element in the canvas's own (unscaled) coordinate space.
  // Uses the offsetParent chain so it is immune to zoom transforms & scroll.
  function pos(el) {
    let x = 0;
    let y = 0;
    let n = el;
    while (n && n !== canvas) {
      x += n.offsetLeft;
      y += n.offsetTop;
      n = n.offsetParent;
    }
    return { x, y, w: el.offsetWidth, h: el.offsetHeight };
  }

  function linkAnchorY(el) {
    const p = pos(el);
    return el?.classList?.contains("collapsed") ? p.y + p.h / 2 : p.y + 23;
  }

  function drawLinks() {
    if (canvas.classList.contains("wz-step-view")) {
      svg.setAttribute("viewBox", "0 0 0 0");
      svg.setAttribute("width", 0);
      svg.setAttribute("height", 0);
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      return;
    }

    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    const focused = canvas.querySelector(".wz-node.focused");
    for (const [from, to, cls] of edges()) {
      const a = pos(from);
      const b = pos(to);
      const x1 = a.x + a.w;
      const y1 = linkAnchorY(from);
      const x2 = b.x;
      const y2 = linkAnchorY(to);
      const span = Math.max(0, x2 - x1);
      const decomposeFanout = from?.id === "wzNodeDecompose" && to?.classList?.contains("wz-node-branch");
      const dx = decomposeFanout
        ? Math.max(88, span * 0.46)
        : Math.max(40, span * 0.5);

      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`);
      const done = from.classList.contains("state-done") ? " done" : "";
      const active = focused && (from === focused || to === focused) ? " flow-active" : "";
      path.setAttribute("class", `wz-canvas-link ${cls}${done}${active}`);
      svg.appendChild(path);
    }

    // Second level: vertical connectors between sub-nodes of EXPANDED branches.
    for (const branch of document.querySelectorAll(".wz-node-branch")) {
      if (branch.classList.contains("collapsed")) continue; // sub-flow hidden
      const subs = [...branch.querySelectorAll(".wz-subnode")];
      for (let i = 0; i < subs.length - 1; i++) {
        const a = pos(subs[i]);
        const b = pos(subs[i + 1]);
        const x1 = a.x + a.w / 2;
        const y1 = a.y + a.h;
        const x2 = b.x + b.w / 2;
        const y2 = b.y;
        const dy = Math.max(16, (y2 - y1) * 0.5);
        const path = document.createElementNS(SVGNS, "path");
        path.setAttribute("d", `M ${x1} ${y1} C ${x1} ${y1 + dy} ${x2} ${y2 - dy} ${x2} ${y2}`);
        path.setAttribute("class", "wz-canvas-link flow-purple wz-sublink");
        svg.appendChild(path);
      }
    }
  }

  const scheduleDraw = (() => {
    let raf = 0;
    return () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        drawLinks();
      });
    };
  })();

  // Redraw on anything that can move nodes.
  window.addEventListener("resize", scheduleDraw);
  canvas.querySelector(".wz-canvas-links")?.addEventListener("scroll", scheduleDraw);
  document.querySelector(".wz-canvas-scroll")?.addEventListener("scroll", scheduleDraw, { passive: true });
  // <details> open/close changes node height → redraw.
  canvas.addEventListener("toggle", scheduleDraw, true);
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(scheduleDraw);
    ro.observe(canvas);
    for (const n of canvas.querySelectorAll(".wz-node")) ro.observe(n);
    for (const s of canvas.querySelectorAll(".wz-subnode")) ro.observe(s);
  }

  // --- Fan-out: add / remove rewrite branches -----------------------------
  // branch is a FULL rewrite form (a clone of node #3.1). The first
  // branch keeps all real IDs and drives shared globals; clones have
  // id/name stripped but retain the same sub-flow structure as 3.1.
  const branchesWrap = document.getElementById("wzBranches");
  const addBtn = document.getElementById("wzAddBranchBtn");
  const baseNode = document.getElementById("wzNodeRewrite");
  let branchSeq = 1; // 3.1 is the real node
  const branchFieldIds = {
    wzProductName: "productName",
    wzProductLink: "productLink",
    wzCta: "cta",
    wzLanguage: "language",
    wzLanguages: "languages",
    wzTargetChannel: "targetChannel",
    wzTargetRegion: "targetRegion",
    wzTargetRegions: "targetRegions",
    wzMaterialDirection: "materialDirection",
    wzMaterialDirectionCustom: "materialDirectionCustom",
    wzVoiceoverStyle: "voiceoverStyle",
    wzPromiseLevel: "promiseLevel",
    wzProjectName: "projectName",
    wzBatchName: "batchName",
    wzTemplateSelect: "templateSelect",
    wzDisplayName: "displayName",
    wzGenerationMode: "generationMode",
    wzTemplateChannel: "templateChannel",
    wzRegions: "regions",
    wzDefaultDuration: "defaultDuration",
    wzEnding: "ending",
    wzCurrencySymbol: "currencySymbol",
    wzProductIconFile: "productIconFile",
    wzProductScreenshotFile: "productScreenshotFile",
    wzProductRecordingFile: "productRecordingFile",
    wzCtaAssetFile: "ctaAssetFile",
    wzEndingAssetFile: "endingAssetFile",
    wzPersonAssetFile: "personAssetFile",
    wzRewardElementFile: "rewardElementFile",
    wzVariantPrompt: "variantPrompt",
    wzCustomPrompt: "customPrompt",
    wzNegativePrompt: "negativePrompt",
    wzDisclaimerPreset: "disclaimerPreset",
    wzDisclaimer: "disclaimer",
    wzDisclaimerOverlayPosition: "disclaimerOverlayPosition",
    wzDisclaimerOverlayFontSize: "disclaimerOverlayFontSize",
    wzDisclaimerOverlayBoxHeight: "disclaimerOverlayBoxHeight",
    wzDisclaimerOverlayBottomMargin: "disclaimerOverlayBottomMargin",
    wzDisclaimerOverlayHorizontalMargin: "disclaimerOverlayHorizontalMargin"
  };

  function ensureBranchTemplateSaveUi(node) {
    const block = node?.querySelector(".wz-template-save-block");
    if (!block) return;
    let btn = block.querySelector(".wz-save-template-btn");
    if (!btn) {
      btn = document.createElement("button");
      btn.type = "button";
      btn.className = "mini ghost wz-save-template-btn";
      btn.textContent = "保存模板";
      const actions = block.querySelector(".modal-actions") || block;
      actions.appendChild(btn);
    } else {
      btn.type = "button";
      btn.classList.add("mini", "ghost", "wz-save-template-btn");
      if (!btn.textContent.trim()) btn.textContent = "保存模板";
    }
    let status = block.querySelector(".wz-template-save-status");
    if (!status) {
      status = document.createElement("div");
      status.className = "wz-template-save-status wz-field-hint wz-template-save-hint";
      status.textContent = "保存模板是可选项，不保存也可以估算并生成批次。";
      block.insertBefore(status, block.firstChild);
    } else {
      status.classList.add("wz-template-save-status", "wz-field-hint", "wz-template-save-hint");
    }
  }

  function branchId(value) {
    return String(value || "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 48) || `branch_${branchSeq}`;
  }

  function markCloneFields(node) {
    for (const el of node.querySelectorAll("[id]")) {
      const field = branchFieldIds[el.id];
      if (field) el.dataset.branchField = field;
    }
  }

  function stripBranchConfirmUi(node) {
    const actions = node?.querySelector(".panel-head .wz-panel-head-actions");
    if (!actions) return;
    for (const btn of [...actions.querySelectorAll("button:not(.wz-branch-remove)")]) {
      btn.remove();
    }
    if (!actions.querySelector(".wz-branch-remove")) actions.remove();
  }

  function wireBranch(node) {
    ensureCollapseButtons();
    stripBranchConfirmUi(node);
    node.querySelector(".wz-branch-remove")?.addEventListener("click", () => {
      const branchId = node.dataset.branchId || "";
      const refocusStep3 = stepViewEnabled() && activeStep === "3" && !node.hidden;
      node.remove();
      renumberBranches();
      syncBranchLayoutMeta();
      if (refocusStep3) {
        const next = branchesWrap?.querySelector(".wz-node-branch");
        if (next) activateStep("3", { branchNode: next, scroll: false });
      }
      window.dispatchEvent(new CustomEvent("wz:branch-removed", { detail: { branchId } }));
    });
    if ("ResizeObserver" in window) {
      try {
        const ro = new ResizeObserver(scheduleDraw);
        ro.observe(node);
        for (const s of node.querySelectorAll(".wz-subnode")) ro.observe(s);
      } catch (_) {}
    }
  }

  function renumberBranches() {
    const nodes = [...branchesWrap.querySelectorAll(".wz-node-branch")];
    nodes.forEach((n, i) => {
      const title = n.querySelector(".wz-branch-title");
      if (title) title.textContent = `改写 3.${i + 1}`;
      // Renumber this branch's sub-nodes → 3.{i+1}.{j+1}
      const subs = [...n.querySelectorAll(".wz-subnode")];
      subs.forEach((s, j) => {
        const tag = s.querySelector(".wz-subno");
        if (tag) tag.textContent = `3.${i + 1}.${j + 1}`;
      });
    });
    syncBranchLayoutMeta();
  }

  function isRewriteBranch(node) {
    return Boolean(node?.classList?.contains("wz-node-branch"));
  }

  function branchWrapFor(node) {
    return node?.closest(".wz-branches") || null;
  }

  function branchGroup(node) {
    const wrap = branchWrapFor(node);
    if (!wrap) return [];
    return [...wrap.querySelectorAll(".wz-node-branch")];
  }

  function syncBranchRail() {
    if (!branchesWrap) return;
    const branches = [...branchesWrap.querySelectorAll(".wz-node-branch")];
    let rail = branchesWrap.querySelector(".wz-branch-rail");
    if (branches.length < 2) {
      rail?.remove();
      return;
    }
    if (!rail) {
      rail = document.createElement("nav");
      rail.className = "wz-branch-rail";
      rail.setAttribute("aria-label", "裂变子节点切换");
      const firstBranch = branchesWrap.querySelector(".wz-node-branch");
      branchesWrap.insertBefore(rail, firstBranch);
    }
    rail.replaceChildren(...branches.map((branch, index) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "wz-branch-rail-item";
      btn.dataset.branchIndex = String(index);
      btn.textContent = branch.querySelector(".wz-branch-title")?.textContent?.trim() || `改写 3.${index + 1}`;
      btn.classList.toggle("active", branch.classList.contains("focused"));
      return btn;
    }));
  }

  function syncBranchLayoutMeta() {
    if (!branchesWrap) return;
    const count = branchesWrap.querySelectorAll(".wz-node-branch").length;
    branchesWrap.classList.toggle("wz-branches-multi", count > 1);
    syncBranchRail();
    scheduleDraw();
  }

  function scrollBranchIntoView(branch) {
    if (!branch) return;
    requestAnimationFrame(() => {
      const target = branch.querySelector(".panel-head") || branch;
      target.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      if (focusEnabled()) {
        branch.closest(".wz-col")?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    });
  }

  function focusBranch(branch, { railItem = null } = {}) {
    if (!branch) return;
    if (stepViewEnabled()) {
      activateStep("3", { branchNode: branch, railItem, scroll: false });
      return;
    }
    focusNodeLegacy(branch, { center: true });
    if (railItem) {
      const rail = railItem.closest(".wz-branch-rail");
      for (const item of rail?.querySelectorAll(".wz-branch-rail-item") || []) {
        item.classList.toggle("active", item === railItem);
      }
    }
  }

  function createBranchNode(draft = {}, options = {}) {
    if (!baseNode) return;
    branchSeq += 1;
    const clone = baseNode.cloneNode(true);
    markCloneFields(clone);

    // Remove duplicate IDs while keeping data-branch-field for business JS.
    clone.removeAttribute("id");
    clone.classList.add("wz-node-clone");
    clone.dataset.branch = String(branchSeq - 1);
    clone.dataset.branchId = branchId(draft.branchId || draft.id || `branch_${branchSeq}`);
    clone.dataset.branchLabel = draft.branchLabel || draft.label || "";
    for (const el of clone.querySelectorAll("[id]")) el.removeAttribute("id");
    for (const el of clone.querySelectorAll("[name]")) el.removeAttribute("name");
    for (const el of clone.querySelectorAll('input[type="file"]')) {
      el.value = "";
      el.dataset.storageUrl = "";
      el.dataset.storageKey = "";
      el.dataset.storedPath = "";
      el.dataset.uploadedFileName = "";
      el.dataset.assetId = "";
      el.dataset.reviewStatus = "";
      el.dataset.reviewReason = "";
      el.closest("label")?.querySelector(".wz-file-meta")?.remove();
    }
    // Drop state classes/pills carried over from the original.
    clone.classList.remove("focused", "collapsed", "state-done", "state-current", "state-pending", "wz-branch-inactive");
    clone.querySelector(".wz-node-state")?.remove();
    ensureBranchTemplateSaveUi(clone);

    const head = clone.querySelector(".panel-head");
    if (head && !head.querySelector(".wz-branch-remove")) {
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "mini ghost wz-branch-remove";
      rm.textContent = "移除";
      head.appendChild(rm);
    }

    branchesWrap.appendChild(clone);
    renumberBranches();
    wireBranch(clone);
    syncBranchLayoutMeta();
    if (options.focus !== false) {
      if (stepViewEnabled()) {
        activateStep("3", { branchNode: clone, scroll: false });
      } else {
        clone.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
    }
    scheduleDraw();
    window.dispatchEvent(new CustomEvent("wz:branch-created", { detail: { node: clone, draft } }));
    return clone;
  }

  function addBranch() {
    createBranchNode();
  }

  window.wzCreateBranchNode = createBranchNode;
  addBtn?.addEventListener("click", addBranch);
  if (baseNode) stripBranchConfirmUi(baseNode);
  for (const node of branchesWrap?.querySelectorAll(".wz-node-branch") || []) {
    stripBranchConfirmUi(node);
  }
  syncBranchLayoutMeta();

  // --- Step bar: smooth scroll + active highlight -------------------------
  const stepbar = document.getElementById("wzStepbar");
  const items = stepbar ? [...stepbar.querySelectorAll(".wz-stepbar-item")] : [];
  const scroller = document.querySelector(".wz-canvas-scroll");

  // --- Focus & collapse ---------------------------------------------------
  // Desktop (≥981px): menu-driven step view — one stage fills the workspace.
  // Mobile: vertical stack with scroll-into-view.
  const stepViewEnabled = () => window.matchMedia("(min-width: 981px)").matches;
  const focusEnabled = stepViewEnabled;
  let activeStep = "1";

  if ("IntersectionObserver" in window && !stepViewEnabled()) {
    const stageNodes = [
      ["1", nodeById("wzNodeUpload")],
      ["2", nodeById("wzNodeDecompose")],
      ["3", nodeById("wzNodeRewrite")],
      ["4", nodeById("wzNodeBatch")],
      ["5", nodeById("wzNodeLog")]
    ].filter(([, el]) => el);
    const visible = new Map();
    const byStep = new Map(items.map((it) => [it.dataset.step, it]));
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const step = entry.target.getAttribute("data-spy-step");
          if (entry.isIntersecting) visible.set(step, entry.intersectionRatio);
          else visible.delete(step);
        }
        let best = null;
        let bestRatio = -1;
        for (const [step, ratio] of visible) {
          if (ratio > bestRatio) {
            best = step;
            bestRatio = ratio;
          }
        }
        if (best) for (const it of items) it.classList.toggle("active", it === byStep.get(best));
      },
      { threshold: [0.2, 0.5, 0.8] }
    );
    for (const [step, el] of stageNodes) {
      el.setAttribute("data-spy-step", step);
      observer.observe(el);
    }
  }

  function columnForNode(node) {
    return node?.closest(".wz-col") || null;
  }

  function setStepbarActive(step) {
    if (!step) return;
    for (const it of items) it.classList.toggle("active", it.dataset.step === String(step));
  }

  function chipSummaryForNode(node) {
    if (!node) return "";
    switch (node.id) {
      case "wzNodeUpload": {
        const box = document.getElementById("wzReferenceBox");
        if (!box || box.classList.contains("empty-line")) return "未上传参考视频";
        return box.textContent.trim().replace(/\s+/g, " ").slice(0, 56) || "已上传参考视频";
      }
      case "wzNodeDecompose":
        if (node.dataset.decompositionConfirmed === "1") return "脚本拆解已确认";
        if (document.getElementById("wzDecompositionForm")?.hidden === false) return "脚本草稿待确认";
        return "待开始 AI 拆解";
      case "wzNodeRewrite":
        return document.getElementById("wzTemplateStatus")?.classList.contains("wz-success")
          ? "产品改写模板已保存"
          : "待填写产品改写";
      case "wzNodeBatch": {
        const batchStatus = document.getElementById("wzNodeBatch")?.dataset?.batchStatus;
        if (batchStatus === "preview_required") return "Seedance 预案待确认";
        const badge = document.getElementById("wzBatchBadge")?.textContent?.trim();
        if (stateEstimateReady()) return "批次已估算，可生成预案";
        return badge && badge !== "未开始" ? badge : "待估算本批任务";
      }
      case "wzNodeLog": {
        const badge = document.getElementById("wzBatchBadge")?.textContent?.trim();
        return badge && badge !== "未开始" ? `批次状态：${badge}` : "暂无批次日志";
      }
      case "wzNodeOutput": {
        const archive = document.getElementById("wzTaskArchiveBox");
        if (archive && !archive.classList.contains("empty-line")) return "结果已归档到任务管理";
        return "结果待归档";
      }
      default:
        if (node.classList.contains("wz-node-branch")) {
          return node.querySelector(".panel-head h2")?.textContent?.trim() || "改写分支";
        }
        return node.querySelector(".panel-head h2")?.textContent?.trim() || "";
    }
  }

  function stateEstimateReady() {
    const estimate = document.getElementById("wzEstimateBox");
    return estimate && !estimate.classList.contains("empty-line");
  }

  function updateChipSummaries() {
    for (const node of canvas.querySelectorAll(".wz-node")) {
      const summary = chipSummaryForNode(node);
      if (summary) node.setAttribute("data-chip-summary", summary);
      else node.removeAttribute("data-chip-summary");
    }
  }

  function defaultSubForBranch(branch) {
    const active = branch?.querySelector(".wz-subflow-nav-item.active");
    if (active?.dataset?.sub) return active.dataset.sub;
    return "1";
  }

  function activateSubPanel(subId, branchNode, { navItem = null } = {}) {
    if (!subId || !branchNode) return;
    branchNode.hidden = false;
    branchNode.classList.remove("collapsed");
    branchNode.classList.add("focused");
    const subflow = branchNode.querySelector(".wz-subflow");
    for (const sub of branchNode.querySelectorAll(".wz-subnode")) {
      const isActive = sub.dataset.sub === String(subId);
      sub.classList.toggle("is-sub-active", isActive);
      sub.hidden = !isActive;
      sub.classList.toggle("focused", isActive);
    }
    for (const item of subflow?.querySelectorAll(".wz-subflow-nav-item") || []) {
      item.classList.toggle("active", navItem ? item === navItem : item.dataset.sub === String(subId));
    }
  }

  function applyStep3BranchVisibility(focusBranch) {
    const step3Col = canvas.querySelector('.wz-col[data-step="3"]');
    if (!step3Col) return focusBranch;
    const branches = [...step3Col.querySelectorAll(".wz-node-branch")];
    const focus = focusBranch || branches[0];
    for (const branch of branches) {
      const show = branch === focus;
      branch.hidden = !show;
      branch.classList.toggle("focused", show);
      branch.classList.remove("collapsed", "wz-branch-inactive");
      branch.setAttribute("aria-expanded", "true");
      if (show) activateSubPanel(defaultSubForBranch(branch), branch);
    }
    syncBranchRail();
    return focus;
  }

  function resetStepViewDom() {
    canvas.classList.remove("wz-step-view");
    for (const col of canvas.querySelectorAll(".wz-col")) {
      col.hidden = false;
      col.classList.remove("is-step-active", "wz-col-focus");
    }
    for (const sub of canvas.querySelectorAll(".wz-subnode")) {
      sub.hidden = false;
      sub.classList.remove("is-sub-active");
    }
    for (const branch of canvas.querySelectorAll(".wz-node-branch")) {
      branch.hidden = false;
    }
  }

  function activateStep(step, options = {}) {
    activeStep = String(step);
    if (!stepViewEnabled()) {
      const stage = STAGES.find((item) => item.step === activeStep);
      const target = stage?.nodes?.map((id) => nodeById(id)).find(Boolean);
      if (target) focusNodeLegacy(target, options);
      return;
    }

    canvas.classList.add("wz-step-view");
    canvas.classList.remove("wz-focus-mode");
    canvas.removeAttribute("data-focus-step");

    for (const col of canvas.querySelectorAll(".wz-col")) {
      const isActive = col.dataset.step === activeStep;
      col.classList.toggle("is-step-active", isActive);
      col.hidden = !isActive;
      col.classList.remove("wz-col-focus");
    }
    setStepbarActive(activeStep);

    const activeCol = canvas.querySelector(".wz-col.is-step-active");
    if (activeCol) {
      for (const n of activeCol.querySelectorAll(".wz-node")) {
        n.classList.remove("collapsed", "wz-branch-inactive");
        n.setAttribute("aria-expanded", "true");
      }
    }

    for (const n of canvas.querySelectorAll(".wz-node")) {
      n.classList.remove("focused");
    }

    if (activeStep === "3") {
      const step3Col = canvas.querySelector('.wz-col[data-step="3"]');
      let focusBranch = options.branchNode
        || step3Col?.querySelector(".wz-node-branch.focused")
        || nodeById("wzNodeRewrite");
      focusBranch = applyStep3BranchVisibility(focusBranch);
      if (options.sub && focusBranch) {
        activateSubPanel(options.sub, focusBranch, options);
      }
      if (options.railItem) {
        const rail = options.railItem.closest(".wz-branch-rail");
        for (const item of rail?.querySelectorAll(".wz-branch-rail-item") || []) {
          item.classList.toggle("active", item === options.railItem);
        }
      }
    } else if (activeStep === "5") {
      for (const nid of ["wzNodeLog", "wzNodeOutput"]) {
        nodeById(nid)?.classList.add("focused");
      }
    } else {
      const stage = STAGES.find((item) => item.step === activeStep);
      for (const nid of stage?.nodes || []) {
        nodeById(nid)?.classList.add("focused");
      }
    }

    updateChipSummaries();
    scheduleDraw();

    if (options.scroll !== false) {
      requestAnimationFrame(() => {
        scroller?.scrollTo({ top: 0, behavior: "smooth" });
      });
    }
    runStepEnter(activeCol);
  }

  function runStepEnter(activeCol) {
    if (!activeCol || !stepViewEnabled()) return;
    activeCol.classList.remove("wz-step-enter");
    for (const node of activeCol.querySelectorAll(".wz-node")) {
      node.classList.remove("wz-step-enter");
    }
    void activeCol.offsetWidth;
    activeCol.classList.add("wz-step-enter");
    for (const [index, node] of [...activeCol.querySelectorAll(".wz-node")].entries()) {
      node.style.setProperty("--wz-step-stagger", `${Math.min(index, 4) * 60}ms`);
      node.classList.add("wz-step-enter");
    }
  }

  window.wzActivateStep = activateStep;

  function focusNodeLegacy(node, { center = true, collapseOthers = true } = {}) {
    if (!node) return;
    if (!focusEnabled()) {
      if (center) node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      return;
    }

    const focusCol = columnForNode(node);
    const focusStep = focusCol?.dataset?.step || null;
    const branchWrap = isRewriteBranch(node) ? branchWrapFor(node) : null;
    const multiBranch = Boolean(branchWrap && branchGroup(node).length > 1);
    canvas.classList.add("wz-focus-mode");
    canvas.dataset.focusStep = focusStep || "";
    for (const col of canvas.querySelectorAll(".wz-col")) {
      col.classList.toggle("wz-col-focus", col === focusCol);
    }
    setStepbarActive(focusStep);

    for (const n of canvas.querySelectorAll(".wz-node")) {
      const sameCol = columnForNode(n) === focusCol;
      const isTarget = n === node;
      const sameBranchGroup = multiBranch && isRewriteBranch(n) && branchWrapFor(n) === branchWrap;

      n.classList.toggle("focused", isTarget);
      n.classList.toggle("wz-branch-inactive", sameBranchGroup && !isTarget);
      n.setAttribute("aria-expanded", isTarget || sameBranchGroup ? "true" : "false");

      if (sameBranchGroup) {
        n.classList.remove("collapsed");
        continue;
      }

      if (!collapseOthers) {
        if (isTarget) n.classList.remove("collapsed");
        n.classList.remove("wz-branch-inactive");
        continue;
      }

      if (isTarget) {
        n.classList.remove("collapsed");
      } else if (sameCol && focusStep === "5") {
        // Step 5 column keeps both log + output visible; only dim non-target.
        n.classList.remove("collapsed");
      } else {
        n.classList.add("collapsed");
      }
      n.classList.remove("wz-branch-inactive");
    }

    for (const sub of canvas.querySelectorAll(".wz-subnode")) {
      sub.classList.remove("focused");
    }

    syncBranchRail();

    if (center) {
      requestAnimationFrame(() => {
        if (multiBranch && isRewriteBranch(node)) {
          scrollBranchIntoView(node);
        } else {
          node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        }
        scheduleDraw();
      });
    } else {
      scheduleDraw();
    }
    updateChipSummaries();
  }

  function focusNode(node, options = {}) {
    if (!node) return;
    if (stepViewEnabled()) {
      const col = columnForNode(node);
      const step = col?.dataset?.step;
      if (!step) return;
      const stepOpts = { ...options, scroll: options.center !== false };
      if (step === "3") {
        stepOpts.branchNode = isRewriteBranch(node) ? node : (options.branchNode || nodeById("wzNodeRewrite"));
        if (options.sub) stepOpts.sub = options.sub;
        else {
          const activeSub = node.querySelector?.(".wz-subnode.is-sub-active, .wz-subnode.focused");
          if (activeSub?.dataset?.sub) stepOpts.sub = activeSub.dataset.sub;
        }
      }
      activateStep(step, stepOpts);
      return;
    }
    focusNodeLegacy(node, options);
  }

  function focusStage(step, options = {}) {
    activateStep(step, options);
  }

  window.wzFocusNode = (idOrNode, options) => {
    const node = typeof idOrNode === "string" ? nodeById(idOrNode) : idOrNode;
    focusNode(node, options);
  };
  window.wzFocusStage = (step, options) => focusStage(step, options);

  function toggleCollapse(node) {
    if (stepViewEnabled()) return;
    node.classList.toggle("collapsed");
    if (!node.classList.contains("collapsed")) {
      focusNodeLegacy(node, { collapseOthers: true });
      return;
    }
    scheduleDraw();
  }

  function focusSubnode(sub, { navItem = null } = {}) {
    if (!sub) return;
    const branchNode = sub.closest(".wz-node-branch");
    const subId = sub.dataset.sub;
    if (stepViewEnabled()) {
      activateStep("3", { branchNode, sub: subId, navItem, scroll: false });
      return;
    }
    const subflow = sub.closest(".wz-subflow");
    if (branchNode) focusNodeLegacy(branchNode, { center: false });
    for (const s of canvas.querySelectorAll(".wz-subnode")) {
      s.classList.toggle("focused", s === sub);
    }
    for (const item of subflow?.querySelectorAll(".wz-subflow-nav-item") || []) {
      item.classList.toggle("active", navItem ? item === navItem : item.dataset.sub === subId);
    }
    requestAnimationFrame(() => {
      sub.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
    });
  }

  // Header click: chevron → collapse that node; elsewhere → focus it.
  canvas.addEventListener("click", (event) => {
    if (event.target.closest(".wz-collapse-btn")) {
      const headBtn = event.target.closest(".panel-head");
      const collapseNode = headBtn?.closest(".wz-node");
      if (collapseNode) toggleCollapse(collapseNode);
      return;
    }

    const navItem = event.target.closest(".wz-subflow-nav-item");
    if (navItem) {
      event.preventDefault();
      const subflow = navItem.closest(".wz-subflow");
      const sub = subflow?.querySelector(`.wz-subnode[data-sub="${navItem.dataset.sub}"]`);
      focusSubnode(sub, { navItem });
      return;
    }

    const railItem = event.target.closest(".wz-branch-rail-item");
    if (railItem) {
      event.preventDefault();
      const wrap = railItem.closest(".wz-branches");
      const index = Number(railItem.dataset.branchIndex);
      const branch = wrap?.querySelectorAll(".wz-node-branch")?.[index];
      focusBranch(branch, { railItem });
      return;
    }

    if (event.target.closest("button, a, input, select, textarea, label")) return;

    if (!stepViewEnabled()) {
      const collapsedNode = event.target.closest(".wz-node.collapsed");
      if (collapsedNode) {
        focusNode(collapsedNode);
        return;
      }
    }

    if (!stepViewEnabled()) {
      const subHead = event.target.closest(".wz-subnode-head");
      if (subHead) {
        focusSubnode(subHead.closest(".wz-subnode"));
        return;
      }
      const head = event.target.closest(".panel-head");
      if (!head) return;
      const node = head.closest(".wz-node");
      if (!node) return;
      if (event.target.closest(".wz-collapse-btn")) {
        toggleCollapse(node);
        return;
      }
      if (event.target.closest("button")) return;
      focusNode(node);
    }
  });

  canvas.addEventListener("keydown", (event) => {
    if (!focusEnabled() || event.target.closest("input, textarea, select")) return;
    const step = event.key;
    if (!/^[1-5]$/.test(step)) return;
    event.preventDefault();
    activateStep(step);
  });

  // Step bar is the sole desktop navigation between main stages.
  for (const item of items) {
    item.addEventListener("click", (event) => {
      event.preventDefault();
      const step = item.dataset.step;
      if (step) activateStep(step);
    });
  }

  // Newly added branch becomes the focused node.
  addBtn?.addEventListener("click", () => {
    const last = branchesWrap?.querySelector(".wz-node-branch:last-child");
    if (last) requestAnimationFrame(() => focusNode(last));
  });

  // Re-layout when crossing the responsive breakpoint.
  window.matchMedia("(min-width: 981px)").addEventListener?.("change", (event) => {
    if (event.matches) {
      activateStep(activeStep || "1", { scroll: false });
    } else {
      resetStepViewDom();
      scheduleDraw();
    }
  });

  // --- Grab-to-pan on empty canvas area -----------------------------------
  if (scroller) {
    let panning = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startWinY = 0;

    scroller.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      if (stepViewEnabled()) return;
      // Don't hijack drags that start on a node, control, or the step bar.
      if (event.target.closest(".wz-node") || event.target.closest("a, button, input, select, textarea")) return;
      panning = true;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = scroller.scrollLeft;
      startWinY = window.scrollY;
      scroller.classList.add("panning");
      try { scroller.setPointerCapture(event.pointerId); } catch (_) {}
    });

    scroller.addEventListener("pointermove", (event) => {
      if (!panning) return;
      scroller.scrollLeft = startLeft - (event.clientX - startX);
      window.scrollTo({ top: startWinY - (event.clientY - startY) });
    });

    const endPan = (event) => {
      if (!panning) return;
      panning = false;
      scroller.classList.remove("panning");
      try { scroller.releasePointerCapture(event.pointerId); } catch (_) {}
    };
    scroller.addEventListener("pointerup", endPan);
    scroller.addEventListener("pointercancel", endPan);
    scroller.addEventListener("pointerleave", endPan);
  }

  // --- Zoom (Ctrl/⌘ + wheel, and a floating zoom bar) ---------------------
  let zoom = 1;
  const ZMIN = 0.5;
  const ZMAX = 1.5;

  function applyZoom() {
    canvas.style.transform = zoom === 1 ? "" : `scale(${zoom})`;
    if (levelEl) levelEl.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(next) {
    zoom = Math.min(ZMAX, Math.max(ZMIN, Math.round(next * 100) / 100));
    applyZoom();
  }

  // Build the zoom bar inside the scroll area.
  let levelEl = null;
  if (scroller) {
    const bar = document.createElement("div");
    bar.className = "wz-zoom-bar";
    bar.innerHTML =
      '<button type="button" data-zoom="out" title="缩小">−</button>' +
      '<span class="wz-zoom-level">100%</span>' +
      '<button type="button" data-zoom="reset" title="重置">⊙</button>' +
      '<button type="button" data-zoom="in" title="放大">+</button>';
    scroller.appendChild(bar);
    levelEl = bar.querySelector(".wz-zoom-level");
    bar.addEventListener("click", (event) => {
      const act = event.target.closest("button")?.dataset.zoom;
      if (act === "in") setZoom(zoom + 0.1);
      else if (act === "out") setZoom(zoom - 0.1);
      else if (act === "reset") setZoom(1);
    });

    // Ctrl/⌘ + wheel to zoom; plain wheel scrolls as usual.
    scroller.addEventListener(
      "wheel",
      (event) => {
        if (!event.ctrlKey && !event.metaKey) return;
        if (!window.matchMedia("(min-width: 981px)").matches) return;
        event.preventDefault();
        setZoom(zoom + (event.deltaY < 0 ? 0.1 : -0.1));
      },
      { passive: false }
    );
  }

  // --- Soft pipeline state (done / current / pending) ---------------------
  // Pure visual layer. Drives off BACKEND-populated DOM signals only:
  // every result box carries `.empty-line` while empty and the business JS
  // removes it once real server data arrives. Default <input> values never
  // affect these, so the colors track actual task progress — not form text.
  // Stages are also monotonic: a step can't be "done" unless the one before
  // it is (prevents a later node lighting up while step 1 is untouched).
  const hasData = (id) => {
    const el = document.getElementById(id);
    return !!el && !el.classList.contains("empty-line");
  };
  const badgeDone = (id, ...waitingWords) => {
    const el = document.getElementById(id);
    if (!el) return false;
    const txt = (el.textContent || "").trim();
    return txt.length > 0 && !waitingWords.includes(txt);
  };

  const STAGES = [
    {
      step: "1",
      nodes: ["wzNodeUpload"],
      // reference video info loaded from server
      done: () => hasData("wzReferenceBox")
    },
    {
      step: "2",
      nodes: ["wzNodeDecompose"],
      done: () => document.getElementById("wzNodeDecompose")?.dataset.decompositionConfirmed === "1"
    },
    {
      step: "3",
      nodes: ["wzNodeRewrite"],
      done: () => document.getElementById("wzNodeRewrite")?.dataset.rewriteConfirmed === "1"
    },
    {
      step: "4",
      nodes: ["wzNodeBatch"],
      // Step 4 completes only after plan is confirmed (not while preview_required).
      done: () => {
        const batchNode = document.getElementById("wzNodeBatch");
        const status = batchNode?.dataset?.batchStatus;
        if (status === "preview_required") return false;
        return badgeDone("wzBatchBadge", "未开始");
      }
    },
    {
      step: "5",
      nodes: ["wzNodeLog", "wzNodeOutput"],
      // final outputs are converged into task management
      done: () => hasData("wzTaskArchiveBox")
    }
  ];

  const STATE_LABEL = { done: "已完成", current: "进行中", pending: "待开始" };

  function ensureStatePills() {
    for (const stage of STAGES) {
      for (const nid of stage.nodes) {
        const node = document.getElementById(nid);
        const head = node?.querySelector(".panel-head");
        if (head && !head.querySelector(".wz-node-state")) {
          const pill = document.createElement("span");
          pill.className = "wz-node-state";
          // place before the collapse chevron
          const chevron = head.querySelector(".wz-collapse-btn");
          head.insertBefore(pill, chevron || null);
        }
      }
    }
  }

  function setStateClass(el, state) {
    if (!el) return;
    el.classList.remove("state-done", "state-current", "state-pending");
    el.classList.add(`state-${state}`);
  }

  function refreshPipelineState() {
    ensureStatePills();
    const raw = STAGES.map((s) => {
      try { return !!s.done(); } catch (_) { return false; }
    });
    // Monotonic: a stage counts as done only if every earlier stage is done.
    const doneFlags = [];
    let prevDone = true;
    for (const d of raw) {
      const done = prevDone && d;
      doneFlags.push(done);
      prevDone = done;
    }
    // current = first not-done stage (or last if all done)
    let currentIdx = doneFlags.findIndex((d) => !d);
    if (currentIdx === -1) currentIdx = STAGES.length - 1;

    STAGES.forEach((stage, i) => {
      const state = doneFlags[i] ? "done" : i === currentIdx ? "current" : "pending";
      for (const nid of stage.nodes) {
        const node = document.getElementById(nid);
        setStateClass(node, state);
        const pill = node?.querySelector(".wz-node-state");
        if (pill) {
          pill.classList.remove("state-done", "state-current", "state-pending");
          pill.classList.add(`state-${state}`);
          pill.textContent = STATE_LABEL[state];
        }
      }
      if (stage.step === "3" && doneFlags[i]) {
        for (const branch of document.querySelectorAll(".wz-node-branch")) {
          setStateClass(branch, "done");
          const pill = branch.querySelector(".wz-node-state");
          if (pill) {
            pill.classList.remove("state-current", "state-pending");
            pill.classList.add("state-done");
            pill.textContent = STATE_LABEL.done;
          }
        }
      }
      const item = document.querySelector(`#wzStepbar .wz-stepbar-item[data-step="${stage.step}"]`);
      if (item) {
        item.classList.remove("state-done", "state-current", "state-pending");
        item.classList.add(`state-${state}`);
      }
    });

    if (focusEnabled()) {
      if (refreshPipelineState.lastDoneFlags) {
        for (let i = 0; i < doneFlags.length - 1; i += 1) {
          if (doneFlags[i] && !refreshPipelineState.lastDoneFlags[i]) {
            // Only auto-advance when the user is still on the step that just completed.
            if (Number(activeStep) === i + 1) {
              activateStep(STAGES[i + 1].step);
            }
            break;
          }
        }
      } else {
        activateStep(STAGES[currentIdx].step, { scroll: false });
      }
    }
    refreshPipelineState.lastDoneFlags = [...doneFlags];
    updateChipSummaries();
    scheduleDraw(); // re-tint completed links
  }

  // Re-evaluate on any user input and whenever result boxes mutate.
  document.addEventListener("input", refreshPipelineState, true);
  document.addEventListener("change", refreshPipelineState, true);
  window.addEventListener("wz:template-commit-changed", refreshPipelineState);
  window.addEventListener("wz:rewrite-confirmed-changed", refreshPipelineState);
  window.addEventListener("wz:decomposition-confirmed-changed", refreshPipelineState);
  if ("MutationObserver" in window) {
    const mo = new MutationObserver(refreshPipelineState);
    for (const id of ["wzReferenceBox", "wzRewriteStatus", "wzBatchBadge", "wzBatchBox", "wzTaskArchiveBox"]) {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
    const decomposeNode = document.getElementById("wzNodeDecompose");
    if (decomposeNode) {
      mo.observe(decomposeNode, { attributes: true, attributeFilter: ["data-decomposition-confirmed"] });
    }
    const batchNode = document.getElementById("wzNodeBatch");
    if (batchNode) {
      mo.observe(batchNode, { attributes: true, attributeFilter: ["data-batch-status"] });
    }
  }
  refreshPipelineState();

  // Initial paint (give layout a tick to settle, fonts/images may shift it).
  scheduleDraw();
  window.addEventListener("load", scheduleDraw);
  setTimeout(scheduleDraw, 300);
})();
