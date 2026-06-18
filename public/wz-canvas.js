// Horizontal node-canvas controller for the 网赚 pipeline.
// - Draws SVG links between nodes based on their REAL DOM positions
//   (no hard-coded coordinates → never misaligns, fully responsive).
// - Supports fan-out: "+ 添加改写分支" clones the rewrite node as an
//   extension slot (disabled placeholder) until the backend accepts
//   multiple drafts. The first branch keeps all real IDs / JS bindings.
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
  }

  // --- Fan-out: add / remove rewrite branches -----------------------------
  const branchesWrap = document.getElementById("wzBranches");
  const addBtn = document.getElementById("wzAddBranchBtn");
  let branchSeq = 1; // branch #1 is the real node

  function addBranch() {
    branchSeq += 1;
    const index = branchSeq;
    const node = document.createElement("section");
    node.className = "wz-node wz-node-branch wz-node-placeholder";
    node.dataset.node = "rewrite";
    node.dataset.branch = String(index - 1);
    node.dataset.portIn = "1";
    node.dataset.portOut = "1";
    node.innerHTML = `
      <div class="panel-head">
        <h2>改写分支 #${index}</h2>
        <button class="mini ghost wz-branch-remove" type="button">移除</button>
      </div>
      <div class="wz-node-body">
        <div class="wz-branch-note">
          扩展位：并行改写分支已在画布中预留。<br />
          多分支的参数填写与提交将在后端「一次拆解 → 多组改写」接口就绪后启用；
          当前请使用 #1 分支跑通单条管线。
        </div>
      </div>`;
    branchesWrap.appendChild(node);
    ensureCollapseButtons();
    node.querySelector(".wz-branch-remove")?.addEventListener("click", () => {
      node.remove();
      scheduleDraw();
    });
    if ("ResizeObserver" in window) {
      // observe the new node too
      try {
        const ro = new ResizeObserver(scheduleDraw);
        ro.observe(node);
      } catch (_) {}
    }
    node.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "nearest" });
    scheduleDraw();
  }

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
  // Pure visual layer: observes existing DOM signals to color stages.
  // Does NOT lock steps and does NOT touch business logic.
  const STAGES = [
    {
      step: "1",
      nodes: ["wzNodeUpload"],
      // done when the reference box no longer shows the empty placeholder
      done: () => signalChanged("wzReferenceBox", "未上传参考视频")
    },
    {
      step: "2",
      nodes: ["wzNodeDecompose"],
      // done when the decomposition textarea has JSON content
      done: () => (document.getElementById("wzDecompositionText")?.value || "").trim().length > 0
    },
    {
      step: "3",
      nodes: ["wzNodeRewrite"],
      // done when a product name is filled (rewrite params started)
      done: () => (document.getElementById("wzProductName")?.value || "").trim().length > 0
    },
    {
      step: "4",
      nodes: ["wzNodeBatch"],
      // done when the user confirmed batch limits
      done: () => !!document.getElementById("wzConfirmLimits")?.checked
    },
    {
      step: "5",
      nodes: ["wzNodeLog", "wzNodeOutput"],
      // done when results/gallery has content
      done: () =>
        signalChanged("wzBatchBox", "暂无批次") || signalChanged("wzGalleryBox", "暂无可展示结果")
    }
  ];

  function signalChanged(id, placeholder) {
    const el = document.getElementById(id);
    if (!el) return false;
    const txt = (el.textContent || "").trim();
    return txt.length > 0 && txt !== placeholder;
  }

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
    const doneFlags = STAGES.map((s) => {
      try { return !!s.done(); } catch (_) { return false; }
    });
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
    for (const id of ["wzReferenceBox", "wzBatchBox", "wzGalleryBox", "wzDecompositionText"]) {
      const el = document.getElementById(id);
      if (el) mo.observe(el, { childList: true, characterData: true, subtree: true });
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
