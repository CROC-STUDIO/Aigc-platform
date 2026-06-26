// Horizontal node-canvas controller for the 竞品素材 video-ops 工作台.
// Linear topology: task → input → job → result.
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
    const task = id("remixNodeTask");
    const input = id("remixNodeInput");
    const job = id("remixNodeJob");
    const result = id("remixNodeResult");
    const list = [];
    if (task && input) list.push([task, input, "flow-blue"]);
    if (input && job) list.push([input, job, "flow-purple"]);
    if (job && result) list.push([job, result, "flow-green"]);
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
      ["1", id("remixNodeTask")],
      ["2", id("remixNodeInput")],
      ["3", id("remixNodeJob")]
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
      case "remixNodeTask": {
        const title = document.getElementById("videoOpsSelectedTitle")?.textContent?.trim();
        return title || "未选择任务";
      }
      case "remixNodeInput": {
        const reportText = document.getElementById("videoOpsReportText")?.value?.trim();
        if (reportText) return "分析文本已填写";
        const url = document.getElementById("videoOpsSourceUrl")?.value?.trim();
        if (url) return "视频 URL 已填写";
        const fileStatus = document.getElementById("videoOpsFileStatus");
        const fileLabel = fileStatus?.textContent?.trim().replace(/\s+/g, " ") || "";
        if (fileLabel && fileLabel !== "未选择文件" && !fileStatus?.classList.contains("empty-line")) {
          return fileLabel.slice(0, 56);
        }
        return "待填写输入素材";
      }
      case "remixNodeJob": {
        const badge = document.getElementById("videoOpsStatusBadge")?.textContent?.trim();
        return badge && badge !== "未提交" ? `任务状态：${badge}` : "暂无任务";
      }
      case "remixNodeResult": {
        const link = document.getElementById("videoOpsTaskDetailLink");
        const box = document.getElementById("videoOpsResultBox");
        if (link && link.getAttribute("aria-disabled") === "false") return "结果已归档到任务管理";
        return box?.textContent?.trim() || "结果待归档";
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
      } else if (sameCol && (focusStep === "2" || focusStep === "3")) {
        // Wide input column and job/result column keep sibling nodes visible.
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

  // Drives off DOM signals for the video-ops workbench. Monotonic.
  const hasVideoInput = () => {
    const reportText = document.getElementById("videoOpsReportText")?.value?.trim();
    if (reportText) return true;
    const url = document.getElementById("videoOpsSourceUrl")?.value?.trim();
    if (/^https?:\/\//i.test(url || "")) return true;
    const fileStatus = document.getElementById("videoOpsFileStatus");
    const fileLabel = fileStatus?.textContent?.trim() || "";
    return Boolean(fileLabel && fileLabel !== "未选择文件" && !fileStatus?.classList.contains("empty-line"));
  };

  const hasSubmittedJob = () => {
    const summary = document.getElementById("videoOpsJobSummary");
    if (!summary || summary.classList.contains("empty-line")) return false;
    return (summary.textContent || "").trim() !== "暂无任务";
  };

  const STAGES = [
    {
      step: "1",
      nodes: ["remixNodeTask"],
      done: () => Boolean(document.getElementById("videoOpsSelectedTitle")?.textContent?.trim())
    },
    {
      step: "2",
      nodes: ["remixNodeInput"],
      done: () => hasVideoInput()
    },
    {
      step: "3",
      nodes: ["remixNodeJob", "remixNodeResult"],
      done: () => hasSubmittedJob()
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
    for (const elId of ["videoOpsFileStatus", "videoOpsJobSummary", "videoOpsResultBox", "videoOpsStatusBadge"]) {
      const el = document.getElementById(elId);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["class"] });
    }
  }
  refreshPipelineState();

  if (focusEnabled()) focusNode(id("remixNodeTask"), { center: false });

  scheduleDraw();
  window.addEventListener("load", scheduleDraw);
  setTimeout(scheduleDraw, 300);
})();
