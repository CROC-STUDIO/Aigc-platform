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

  function drawLinks() {
    const W = canvas.offsetWidth;
    const H = canvas.offsetHeight;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    while (svg.firstChild) svg.removeChild(svg.firstChild);

    for (const [from, to, cls] of edges()) {
      const a = pos(from);
      const b = pos(to);
      const x1 = a.x + a.w;
      const y1 = a.y + 23;
      const x2 = b.x;
      const y2 = b.y + 23;
      const dx = Math.max(40, (x2 - x1) * 0.5);

      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`);
      const done = from.classList.contains("state-done") ? " done" : "";
      path.setAttribute("class", `wz-canvas-link ${cls}${done}`);
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
  // Each branch is a FULL rewrite form (a clone of node #3.1). The first
  // branch keeps all real IDs and drives the backend; clones have their
  // id/name attributes stripped (so they never collide) and stay fillable —
  // ready to wire up once the backend accepts multiple drafts.
  const branchesWrap = document.getElementById("wzBranches");
  const addBtn = document.getElementById("wzAddBranchBtn");
  const baseNode = document.getElementById("wzNodeRewrite");
  let branchSeq = 1; // 3.1 is the real node
  const branchFieldIds = {
    wzProductName: "productName",
    wzProductLink: "productLink",
    wzCta: "cta",
    wzLanguage: "language",
    wzTargetChannel: "targetChannel",
    wzTargetRegion: "targetRegion",
    wzMaterialDirection: "materialDirection",
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
    wzEndingAssetFile: "endingAssetFile",
    wzPersonAssetFile: "personAssetFile",
    wzRewardElementFile: "rewardElementFile",
    wzVariantPrompt: "variantPrompt",
    wzCustomPrompt: "customPrompt",
    wzNegativePrompt: "negativePrompt"
  };

  function branchId(value) {
    return String(value || "").replace(/[^a-z0-9_-]+/gi, "_").slice(0, 48) || `branch_${branchSeq}`;
  }

  function markCloneFields(node) {
    for (const el of node.querySelectorAll("[id]")) {
      const field = branchFieldIds[el.id];
      if (field) el.dataset.branchField = field;
    }
  }

  function wireBranch(node) {
    ensureCollapseButtons();
    node.querySelector(".wz-branch-remove")?.addEventListener("click", () => {
      node.remove();
      renumberBranches();
      scheduleDraw();
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
    }
    // Drop state classes/pills carried over from the original.
    clone.classList.remove("focused", "collapsed", "state-done", "state-current", "state-pending");
    clone.querySelector(".wz-node-state")?.remove();

    const head = clone.querySelector(".panel-head");
    const saveBtn = head?.querySelector("button");
    if (saveBtn) {
      saveBtn.removeAttribute("id");
      saveBtn.className = "mini wz-save-branch";
      saveBtn.textContent = "保存全部分支";
      const rm = document.createElement("button");
      rm.type = "button";
      rm.className = "mini ghost wz-branch-remove";
      rm.textContent = "移除";
      head.appendChild(rm);
    }

    branchesWrap.appendChild(clone);
    renumberBranches();
    wireBranch(clone);
    if (options.focus !== false) {
      clone.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
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

  // --- Step bar: smooth scroll + active highlight -------------------------
  const stepbar = document.getElementById("wzStepbar");
  const items = stepbar ? [...stepbar.querySelectorAll(".wz-stepbar-item")] : [];
  const scroller = document.querySelector(".wz-canvas-scroll");

  for (const item of items) {
    item.addEventListener("click", (event) => {
      const href = item.getAttribute("href") || "";
      const target = href.startsWith("#") ? document.getElementById(href.slice(1)) : null;
      if (!target) return;
      event.preventDefault();
      target.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      for (const it of items) it.classList.toggle("active", it === item);
    });
  }

  if ("IntersectionObserver" in window) {
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

  // --- Focus & collapse ---------------------------------------------------
  // Focus = highlight + center the node (does NOT collapse the others).
  // Collapse = manual, per-node, via the chevron button on the header.
  const focusEnabled = () => window.matchMedia("(min-width: 981px)").matches;

  function focusNode(node, { center = true } = {}) {
    if (!node || !focusEnabled()) return;
    for (const n of canvas.querySelectorAll(".wz-node")) {
      n.classList.toggle("focused", n === node);
    }
    if (center) {
      requestAnimationFrame(() =>
        node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" })
      );
    }
  }

  function toggleCollapse(node) {
    node.classList.toggle("collapsed");
    scheduleDraw();
  }

  // Header click: chevron → collapse that node; elsewhere → focus it.
  canvas.addEventListener("click", (event) => {
    // Second level: clicking a sub-node header focuses that sub-node.
    const subHead = event.target.closest(".wz-subnode-head");
    if (subHead) {
      const sub = subHead.closest(".wz-subnode");
      if (sub) {
        for (const s of canvas.querySelectorAll(".wz-subnode")) {
          s.classList.toggle("focused", s === sub);
        }
        sub.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      }
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
    if (event.target.closest("button")) return; // real action buttons
    focusNode(node);
  });

  // Step bar focuses the matching node (no collapsing).
  for (const item of items) {
    item.addEventListener("click", (event) => {
      const href = item.getAttribute("href") || "";
      const target = href.startsWith("#") ? nodeById(href.slice(1)) : null;
      if (target && focusEnabled()) {
        event.preventDefault();
        event.stopImmediatePropagation();
        focusNode(target);
      }
    }, true);
  }

  // Newly added branch becomes the focused node.
  addBtn?.addEventListener("click", () => {
    const last = branchesWrap?.querySelector(".wz-node-branch:last-child");
    if (last) requestAnimationFrame(() => focusNode(last));
  });

  // Re-paint links when crossing the responsive breakpoint.
  window.matchMedia("(min-width: 981px)").addEventListener?.("change", () => {
    scheduleDraw();
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
      // decomposition confirmed/saved → reference box shows success note,
      // or the decompose button has been disabled after a confirmed save.
      done: () => hasData("wzReferenceBox") && /拆解已确认|已确认保存/.test(
        document.getElementById("wzReferenceBox")?.textContent || ""
      )
    },
    {
      step: "3",
      nodes: ["wzNodeRewrite"],
      // channel rules loaded for the product (server-driven)
      done: () => !document.getElementById("wzRulesBox")?.classList.contains("empty-line")
    },
    {
      step: "4",
      nodes: ["wzNodeBatch"],
      // a batch exists (badge left the "未开始" placeholder)
      done: () => badgeDone("wzBatchBadge", "未开始")
    },
    {
      step: "5",
      nodes: ["wzNodeLog", "wzNodeOutput"],
      // results gallery populated by server
      done: () => hasData("wzGalleryBox")
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
      const item = document.querySelector(`#wzStepbar .wz-stepbar-item[data-step="${stage.step}"]`);
      if (item) {
        item.classList.remove("state-done", "state-current", "state-pending");
        item.classList.add(`state-${state}`);
      }
    });
    scheduleDraw(); // re-tint completed links
  }

  // Re-evaluate on any user input and whenever result boxes mutate.
  document.addEventListener("input", refreshPipelineState, true);
  document.addEventListener("change", refreshPipelineState, true);
  if ("MutationObserver" in window) {
    const mo = new MutationObserver(refreshPipelineState);
    for (const id of ["wzReferenceBox", "wzRulesBox", "wzBatchBadge", "wzBatchBox", "wzGalleryBox"]) {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
  }
  refreshPipelineState();

  // Default focus: the first node.
  if (focusEnabled()) focusNode(nodeById("wzNodeUpload"), { center: false });

  // Initial paint (give layout a tick to settle, fonts/images may shift it).
  scheduleDraw();
  window.addEventListener("load", scheduleDraw);
  setTimeout(scheduleDraw, 300);
})();
