function finite(value) {
  return Number.isFinite(Number(value));
}

function rounded(value) {
  return Math.round(value * 1000000) / 1000000;
}

function clamp(value, min = 0, max = 1) {
  return Math.min(max, Math.max(min, value));
}

export function visibleMediaRect(containerRect = {}, mediaSize = {}) {
  const left = Number(containerRect.left);
  const top = Number(containerRect.top);
  const containerWidth = Number(containerRect.width);
  const containerHeight = Number(containerRect.height);
  const mediaWidth = Number(mediaSize.width);
  const mediaHeight = Number(mediaSize.height);
  if (![left, top, containerWidth, containerHeight, mediaWidth, mediaHeight].every(Number.isFinite)) return null;
  if (containerWidth <= 0 || containerHeight <= 0 || mediaWidth <= 0 || mediaHeight <= 0) return null;

  const scale = Math.min(containerWidth / mediaWidth, containerHeight / mediaHeight);
  const width = mediaWidth * scale;
  const height = mediaHeight * scale;
  return {
    left: rounded(left + (containerWidth - width) / 2),
    top: rounded(top + (containerHeight - height) / 2),
    width: rounded(width),
    height: rounded(height)
  };
}

export function normalizedPoint(pointer = {}, mediaRect = null) {
  if (!mediaRect) return null;
  const clientX = Number(pointer.clientX);
  const clientY = Number(pointer.clientY);
  if (![clientX, clientY, mediaRect.left, mediaRect.top, mediaRect.width, mediaRect.height].every(finite)) return null;
  if (mediaRect.width <= 0 || mediaRect.height <= 0) return null;
  const x = (clientX - mediaRect.left) / mediaRect.width;
  const y = (clientY - mediaRect.top) / mediaRect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x: rounded(clamp(x)), y: rounded(clamp(y)) };
}

export function normalizedBox(start, end, minSize = 0.01) {
  if (!start || !end || ![start.x, start.y, end.x, end.y].every(finite)) return null;
  const x1 = clamp(Math.min(Number(start.x), Number(end.x)));
  const y1 = clamp(Math.min(Number(start.y), Number(end.y)));
  const x2 = clamp(Math.max(Number(start.x), Number(end.x)));
  const y2 = clamp(Math.max(Number(start.y), Number(end.y)));
  if (x2 - x1 < minSize || y2 - y1 < minSize) return null;
  return { x1: rounded(x1), y1: rounded(y1), x2: rounded(x2), y2: rounded(y2) };
}

export function createRegionEditor({ surface, getMediaSize, onChange } = {}) {
  if (!surface?.addEventListener) throw new Error("区域编辑器需要可交互画布");
  let mode = "box";
  let pointLabel = "positive";
  let value = { box: null, points: [] };
  let dragStart = null;

  function emit(meta = {}) {
    onChange?.({
      box: value.box ? { ...value.box } : null,
      points: value.points.map((point) => ({ ...point })),
      ...meta
    });
  }

  function pointForEvent(event) {
    const containerRect = surface.getBoundingClientRect();
    const mediaRect = visibleMediaRect(containerRect, getMediaSize?.() || {});
    return normalizedPoint(event, mediaRect);
  }

  function pointerDown(event) {
    const point = pointForEvent(event);
    if (!point) return;
    if (mode === "point") {
      value = {
        ...value,
        points: [...value.points, { ...point, label: pointLabel === "negative" ? "negative" : "positive" }]
      };
      emit({ phase: "complete" });
      return;
    }
    dragStart = point;
    surface.setPointerCapture?.(event.pointerId);
  }

  function pointerMove(event) {
    if (!dragStart || mode !== "box") return;
    const box = normalizedBox(dragStart, pointForEvent(event));
    if (!box) return;
    value = { ...value, box };
    emit({ phase: "preview" });
  }

  function pointerUp(event) {
    if (!dragStart || mode !== "box") return;
    const box = normalizedBox(dragStart, pointForEvent(event));
    dragStart = null;
    try {
      surface.releasePointerCapture?.(event.pointerId);
    } catch {
      // Pointer capture may already be released when the pointer leaves the page.
    }
    if (!box) return;
    value = { ...value, box };
    emit({ phase: "complete" });
  }

  function pointerCancel() {
    dragStart = null;
  }

  surface.addEventListener("pointerdown", pointerDown);
  surface.addEventListener("pointermove", pointerMove);
  surface.addEventListener("pointerup", pointerUp);
  surface.addEventListener("pointercancel", pointerCancel);

  function setMode(nextMode, nextPointLabel = pointLabel) {
    mode = nextMode === "point" ? "point" : "box";
    pointLabel = nextPointLabel === "negative" ? "negative" : "positive";
    dragStart = null;
  }

  function setValue(next = {}) {
    value = {
      box: next.box ? { ...next.box } : null,
      points: Array.isArray(next.points) ? next.points.map((point) => ({ ...point })) : []
    };
    dragStart = null;
  }

  function clear() {
    value = { box: null, points: [] };
    dragStart = null;
    emit({ phase: "clear" });
  }

  function undoPoint() {
    if (!value.points.length) return;
    value = { ...value, points: value.points.slice(0, -1) };
    emit({ phase: "complete" });
  }

  function destroy() {
    surface.removeEventListener("pointerdown", pointerDown);
    surface.removeEventListener("pointermove", pointerMove);
    surface.removeEventListener("pointerup", pointerUp);
    surface.removeEventListener("pointercancel", pointerCancel);
  }

  return { setMode, setValue, clear, undoPoint, destroy };
}
