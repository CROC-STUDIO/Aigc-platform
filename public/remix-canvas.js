// Horizontal node-canvas controller for the 竞品素材改造 pipeline.
// Linear topology: source → mask → mask-preview → delivery → gallery.
// Draws SVG links from real DOM positions (responsive, no hard coords).
// Self-contained, no imports, safe to load with `defer`.
(() => {
  const canvas = document.getElementById("remixCanvas");
  const svg = document.getElementById("remixCanvasLinks");
  if (!canvas || !svg) return;

  canvas.setAttribute("tabindex", "0");

  const SVGNS = "http://www.w3.org/2000/svg";

  // Inject a collapse chevron button into every node header.
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
  const id = (x) => document.getElementById(x);

  function edges() {
    const source = id("remixNodeSource");
    const mask = id("remixNodeMask");
    const preview = id("remixNodeMaskPreview");
    const delivery = id("remixNodeDelivery");
    const gallery = id("remixNodeGallery");
    const list = [];
    if (source && mask) list.push([source, mask, "flow-blue"]);
    if (mask && preview) list.push([mask, preview, "flow-purple"]);
    if (preview && delivery) list.push([preview, delivery, "flow-blue"]);
    if (delivery && gallery) list.push([delivery, gallery, "flow-green"]);
    return list;
  }

  // Position in the canvas's own (unscaled) coordinate space — immune to zoom/scroll.
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
      const dx = Math.max(40, (x2 - x1) * 0.5);
      const path = document.createElementNS(SVGNS, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + dx} ${y1} ${x2 - dx} ${y2} ${x2} ${y2}`);
      const done = from.classList.contains("state-done") ? " done" : "";
      const active = focused && (from === focused || to === focused) ? " flow-active" : "";
      path.setAttribute("class", `wz-canvas-link ${cls}${done}${active}`);
      svg.appendChild(path);
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

  window.addEventListener("resize", scheduleDraw);
  document.querySelector(".wz-canvas-scroll")?.addEventListener("scroll", scheduleDraw, { passive: true });
  canvas.addEventListener("toggle", scheduleDraw, true);
  if ("ResizeObserver" in window) {
    const ro = new ResizeObserver(scheduleDraw);
    ro.observe(canvas);
    for (const n of canvas.querySelectorAll(".wz-node")) ro.observe(n);
  }

  const stepbar = id("remixStepbar");
  const items = stepbar ? [...stepbar.querySelectorAll(".wz-stepbar-item")] : [];

  if ("IntersectionObserver" in window) {
    const stageNodes = [
      ["1", id("remixNodeSource")],
      ["2", id("remixNodeMask")],
      ["3", id("remixNodeDelivery")]
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
  // Focus expands the active node, collapses others in focus mode, and scrolls
  // it into view — same behavior as the 网赚素材管线 canvas.
  const focusEnabled = () => window.matchMedia("(min-width: 981px)").matches;

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
      case "remixNodeSource": {
        const box = document.getElementById("remixSourceBox");
        if (!box || box.classList.contains("empty-line")) return "未上传源素材";
        return box.textContent.trim().replace(/\s+/g, " ").slice(0, 56) || "源素材已上传";
      }
      case "remixNodeMask": {
        const count = document.getElementById("remixRegionCount")?.textContent || "0";
        return Number(count) > 0 ? `已框选 ${count} 个区域` : "待框选改造区域";
      }
      case "remixNodeMaskPreview": {
        const summary = document.getElementById("remixMaskSummary")?.textContent?.trim();
        return summary && summary !== "未生成" ? summary : "Mask 预览待生成";
      }
      case "remixNodeDelivery": {
        const badge = document.getElementById("remixStatusBadge")?.textContent?.trim();
        return badge && badge !== "未开始" ? `任务状态：${badge}` : "暂无改造任务";
      }
      case "remixNodeGallery": {
        const count = document.getElementById("remixDownloadCount")?.textContent || "0";
        return Number(count) > 0 ? `${count} 个结果可下载` : "改造图库暂无结果";
      }
      default:
        return node.querySelector(".panel-head h2")?.textContent?.trim() || "";
    }
  }

  function updateChipSummaries() {
    for (const node of canvas.querySelectorAll(".wz-node")) {
      const summary = chipSummaryForNode(node);
      if (summary) node.setAttribute("data-chip-summary", summary);
      else node.removeAttribute("data-chip-summary");
    }
  }

  function focusNode(node, { center = true, collapseOthers = true } = {}) {
    if (!node) return;
    if (!focusEnabled()) {
      if (center) node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
      return;
    }

    const focusCol = columnForNode(node);
    const focusStep = focusCol?.dataset?.step || null;
    canvas.classList.add("wz-focus-mode");
    canvas.dataset.focusStep = focusStep || "";
    for (const col of canvas.querySelectorAll(".wz-col")) {
      col.classList.toggle("wz-col-focus", col === focusCol);
    }
    setStepbarActive(focusStep);

    for (const n of canvas.querySelectorAll(".wz-node")) {
      const sameCol = columnForNode(n) === focusCol;
      const isTarget = n === node;
      n.classList.toggle("focused", isTarget);
      n.setAttribute("aria-expanded", isTarget ? "true" : "false");
      if (!collapseOthers) {
        if (isTarget) n.classList.remove("collapsed");
        continue;
      }
      if (isTarget) {
        n.classList.remove("collapsed");
      } else if (sameCol && focusStep === "2") {
        // Step 2 column keeps mask editor + preview visible; only dim non-target.
        n.classList.remove("collapsed");
      } else {
        n.classList.add("collapsed");
      }
    }

    if (center) {
      requestAnimationFrame(() => {
        node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
        scheduleDraw();
      });
    } else {
      scheduleDraw();
    }
    updateChipSummaries();
  }

  function focusStage(step, options = {}) {
    const stage = STAGES.find((item) => item.step === String(step));
    const target = stage?.nodes?.map((nid) => id(nid)).find(Boolean);
    if (target) focusNode(target, options);
  }

  window.wzFocusNode = (idOrNode, options) => {
    const node = typeof idOrNode === "string" ? id(idOrNode) : idOrNode;
    focusNode(node, options);
  };
  window.wzFocusStage = (step, options) => focusStage(step, options);

  function toggleCollapse(node) {
    node.classList.toggle("collapsed");
    if (!node.classList.contains("collapsed")) {
      focusNode(node, { collapseOthers: true });
      return;
    }
    scheduleDraw();
  }

  canvas.addEventListener("click", (event) => {
    if (event.target.closest(".wz-collapse-btn")) {
      const collapseNode = event.target.closest(".panel-head")?.closest(".wz-node");
      if (collapseNode) toggleCollapse(collapseNode);
      return;
    }
    if (event.target.closest("button, a, input, select, textarea, label")) return;
    const collapsedNode = event.target.closest(".wz-node.collapsed");
    if (collapsedNode) {
      focusNode(collapsedNode);
      return;
    }
    const head = event.target.closest(".panel-head");
    if (!head) return;
    const node = head.closest(".wz-node");
    if (!node) return;
    focusNode(node);
  });

  canvas.addEventListener("keydown", (event) => {
    if (!focusEnabled() || event.target.closest("input, textarea, select")) return;
    const step = event.key;
    if (!/^[1-3]$/.test(step)) return;
    const item = items.find((it) => it.dataset.step === step);
    const href = item?.getAttribute("href") || "";
    const target = href.startsWith("#") ? id(href.slice(1)) : null;
    if (!target) return;
    event.preventDefault();
    focusNode(target);
  });

  for (const item of items) {
    item.addEventListener("click", (event) => {
      const href = item.getAttribute("href") || "";
      const target = href.startsWith("#") ? id(href.slice(1)) : null;
      if (!target) return;
      event.preventDefault();
      focusNode(target);
    });
  }

  window.matchMedia("(min-width: 981px)").addEventListener?.("change", () => {
    scheduleDraw();
  });

  // --- Grab-to-pan on empty canvas area -----------------------------------
  const scroller = document.querySelector(".wz-canvas-scroll");
  if (scroller) {
    let panning = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startWinY = 0;

    scroller.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
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
  let levelEl = null;

  function applyZoom() {
    canvas.style.transform = zoom === 1 ? "" : `scale(${zoom})`;
    if (levelEl) levelEl.textContent = `${Math.round(zoom * 100)}%`;
  }

  function setZoom(next) {
    zoom = Math.min(ZMAX, Math.max(ZMIN, Math.round(next * 100) / 100));
    applyZoom();
  }

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
  // Drives off BACKEND-populated DOM signals only (`.empty-line` is present
  // while a box is empty and removed when real server data arrives), plus the
  // mask summary text. Default form values never affect these. Monotonic.
  const hasData = (elId) => {
    const el = document.getElementById(elId);
    return !!el && !el.classList.contains("empty-line");
  };

  const STAGES = [
    {
      step: "1",
      nodes: ["remixNodeSource"],
      // server returned source spec
      done: () => hasData("remixSourceBox")
    },
    {
      step: "2",
      nodes: ["remixNodeMask", "remixNodeMaskPreview"],
      // mask composed (summary leaves the "未生成" placeholder)
      done: () => {
        const t = (document.getElementById("remixMaskSummary")?.textContent || "").trim();
        return t.length > 0 && t !== "未生成";
      }
    },
    {
      step: "3",
      nodes: ["remixNodeDelivery", "remixNodeGallery"],
      // a remix task / result exists
      done: () => hasData("remixDetailBox") || hasData("remixGalleryBox")
    }
  ];

  const STATE_LABEL = { done: "已完成", current: "进行中", pending: "待开始" };

  function ensureStatePills() {
    for (const stage of STAGES) {
      for (const nid of stage.nodes) {
        const head = document.getElementById(nid)?.querySelector(".panel-head");
        if (head && !head.querySelector(".wz-node-state")) {
          const pill = document.createElement("span");
          pill.className = "wz-node-state";
          head.insertBefore(pill, head.querySelector(".wz-collapse-btn") || null);
        }
      }
    }
  }

  function refreshPipelineState() {
    ensureStatePills();
    const raw = STAGES.map((s) => {
      try { return !!s.done(); } catch (_) { return false; }
    });
    const doneFlags = [];
    let prevDone = true;
    for (const d of raw) {
      const done = prevDone && d;
      doneFlags.push(done);
      prevDone = done;
    }
    let currentIdx = doneFlags.findIndex((d) => !d);
    if (currentIdx === -1) currentIdx = STAGES.length - 1;

    STAGES.forEach((stage, i) => {
      const state = doneFlags[i] ? "done" : i === currentIdx ? "current" : "pending";
      for (const nid of stage.nodes) {
        const node = document.getElementById(nid);
        if (node) {
          node.classList.remove("state-done", "state-current", "state-pending");
          node.classList.add(`state-${state}`);
        }
        const pill = node?.querySelector(".wz-node-state");
        if (pill) {
          pill.classList.remove("state-done", "state-current", "state-pending");
          pill.classList.add(`state-${state}`);
          pill.textContent = STATE_LABEL[state];
        }
      }
      const item = document.querySelector(`#remixStepbar .wz-stepbar-item[data-step="${stage.step}"]`);
      if (item) {
        item.classList.remove("state-done", "state-current", "state-pending");
        item.classList.add(`state-${state}`);
      }
    });

    if (focusEnabled()) {
      if (refreshPipelineState.lastDoneFlags) {
        for (let i = 0; i < doneFlags.length - 1; i += 1) {
          if (doneFlags[i] && !refreshPipelineState.lastDoneFlags[i]) {
            const nextStage = STAGES[i + 1];
            const nextNode = nextStage?.nodes?.map((nid) => id(nid)).find(Boolean);
            if (nextNode) focusNode(nextNode);
            break;
          }
        }
      } else {
        const currentStage = STAGES[currentIdx];
        const currentNode = currentStage?.nodes?.map((nid) => id(nid)).find(Boolean);
        if (currentNode) focusNode(currentNode, { center: false });
      }
    }
    refreshPipelineState.lastDoneFlags = [...doneFlags];
    updateChipSummaries();
    scheduleDraw();
  }

  document.addEventListener("input", refreshPipelineState, true);
  document.addEventListener("change", refreshPipelineState, true);
  if ("MutationObserver" in window) {
    const mo = new MutationObserver(refreshPipelineState);
    for (const elId of ["remixSourceBox", "remixMaskSummary", "remixDetailBox", "remixGalleryBox"]) {
      const el = document.getElementById(elId);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
  }
  refreshPipelineState();

  if (focusEnabled()) focusNode(id("remixNodeSource"), { center: false });

  scheduleDraw();
  window.addEventListener("load", scheduleDraw);
  setTimeout(scheduleDraw, 300);
})();
