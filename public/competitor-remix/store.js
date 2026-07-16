import { CAPABILITIES, getMode } from "./capability-catalog.js";

const STORAGE_KEY = "competitor-remix:v2";

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function draftKey(capabilityId, modeId) {
  return `${capabilityId}:${modeId}`;
}

function initialDrafts() {
  return Object.fromEntries(CAPABILITIES.flatMap((capability) => capability.modes.map((mode) => [
    draftKey(capability.id, mode.id),
    mode.createDraft()
  ])));
}

function initialSelectedModes() {
  return Object.fromEntries(CAPABILITIES.map((capability) => [
    capability.id,
    (capability.modes.find((mode) => !mode.hidden) || capability.modes[0]).id
  ]));
}

function cleanRunForStorage(run = {}) {
  const copy = cloneJson(run);
  if (copy.requestSnapshot?.input?.source) copy.requestSnapshot.input.source = "<redacted>";
  if (copy.requestSnapshot?.params?.mask_source) copy.requestSnapshot.params.mask_source = "<redacted>";
  return copy;
}

function loadPersisted(storage) {
  if (!storage?.getItem) return null;
  try {
    const value = JSON.parse(storage.getItem(STORAGE_KEY) || "null");
    return value && typeof value === "object" ? value : null;
  } catch {
    return null;
  }
}

function createInitialState(storage) {
  const persisted = loadPersisted(storage) || {};
  const drafts = initialDrafts();
  for (const [key, saved] of Object.entries(persisted.drafts || {})) {
    if (drafts[key] && saved && typeof saved === "object") drafts[key] = { ...drafts[key], ...saved };
  }
  const selectedModes = initialSelectedModes();
  for (const capability of CAPABILITIES) {
    const restored = capability.modes.find((mode) => mode.id === persisted.selectedModes?.[capability.id] && !mode.hidden);
    if (restored) selectedModes[capability.id] = restored.id;
  }
  const selectedCapabilityId = CAPABILITIES.some((item) => item.id === persisted.selectedCapabilityId)
    ? persisted.selectedCapabilityId
    : CAPABILITIES[0].id;
  const source = persisted.source?.mode === "file"
    ? { ...persisted.source, file: null, objectUrl: "", dataUrl: "", needsFile: true, status: "needs_file" }
    : {
        mode: persisted.source?.mode || "url",
        url: persisted.source?.url || "",
        reportText: persisted.source?.reportText || "",
        file: null,
        fileName: "",
        objectUrl: "",
        dataUrl: "",
        identity: persisted.source?.identity || "",
        metadata: persisted.source?.metadata || null,
        status: "idle",
        error: "",
        needsFile: false
      };
  return {
    user: null,
    selectedCapabilityId,
    selectedModes,
    drafts,
    source,
    runs: Array.isArray(persisted.runs) ? persisted.runs : [],
    activeRunId: persisted.activeRunId || ""
  };
}

function clearVisualDraftState(drafts) {
  const next = {};
  for (const [key, draft] of Object.entries(drafts)) {
    next[key] = { ...draft };
    if (Object.hasOwn(next[key], "points")) next[key].points = [];
    if (Object.hasOwn(next[key], "box")) next[key].box = null;
    if (Object.hasOwn(next[key], "frameIndex")) next[key].frameIndex = 0;
    if (Object.hasOwn(next[key], "frameTime")) next[key].frameTime = 0;
    delete next[key].previewDataUrl;
  }
  return next;
}

export function createRemixStore({ storage = globalThis.sessionStorage } = {}) {
  let state = createInitialState(storage);
  const listeners = new Set();

  function snapshot() {
    return {
      ...state,
      selectedModes: { ...state.selectedModes },
      drafts: cloneJson(state.drafts),
      source: { ...state.source },
      runs: cloneJson(state.runs)
    };
  }

  function persist() {
    if (!storage?.setItem) return;
    const source = {
      mode: state.source.mode,
      url: state.source.url || "",
      reportText: state.source.reportText || "",
      fileName: state.source.fileName || "",
      identity: state.source.identity || "",
      metadata: state.source.metadata || null,
      needsFile: state.source.mode === "file"
    };
    const value = {
      selectedCapabilityId: state.selectedCapabilityId,
      selectedModes: state.selectedModes,
      drafts: state.drafts,
      source,
      runs: state.runs.map(cleanRunForStorage),
      activeRunId: state.activeRunId
    };
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      // Storage is a convenience; quota or privacy-mode failures must not block work.
    }
  }

  function emit() {
    persist();
    const value = snapshot();
    for (const listener of listeners) listener(value);
  }

  function getState() {
    return snapshot();
  }

  function subscribe(listener) {
    if (typeof listener !== "function") return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function setUser(user) {
    state = { ...state, user: user || null };
    emit();
  }

  function selectCapability(capabilityId) {
    if (!CAPABILITIES.some((item) => item.id === capabilityId)) return;
    state = { ...state, selectedCapabilityId: capabilityId };
    emit();
  }

  function selectMode(capabilityId, modeId) {
    const selected = getMode(capabilityId, modeId);
    if (!selected || selected.hidden) return;
    state = {
      ...state,
      selectedCapabilityId: capabilityId,
      selectedModes: { ...state.selectedModes, [capabilityId]: modeId }
    };
    emit();
  }

  function getDraft(capabilityId, modeId) {
    const selected = getMode(capabilityId, modeId);
    if (!selected) return null;
    return cloneJson(state.drafts[draftKey(capabilityId, modeId)] || selected.createDraft());
  }

  function updateDraft(capabilityId, modeId, patch = {}) {
    const selected = getMode(capabilityId, modeId);
    if (!selected || !patch || typeof patch !== "object") return;
    const key = draftKey(capabilityId, modeId);
    state = {
      ...state,
      drafts: {
        ...state.drafts,
        [key]: { ...(state.drafts[key] || selected.createDraft()), ...cloneJson(patch) }
      }
    };
    emit();
  }

  function replaceSource(source = {}) {
    const identityChanged = String(source.identity || "") !== String(state.source.identity || "");
    state = {
      ...state,
      source: {
        mode: source.mode || "url",
        url: source.url || "",
        reportText: source.reportText || state.source.reportText || "",
        file: source.file || null,
        fileName: source.fileName || source.file?.name || "",
        objectUrl: source.objectUrl || "",
        dataUrl: source.dataUrl || "",
        identity: source.identity || "",
        metadata: source.metadata || null,
        status: source.status || "ready",
        error: source.error || "",
        needsFile: Boolean(source.needsFile)
      },
      drafts: identityChanged ? clearVisualDraftState(state.drafts) : state.drafts
    };
    emit();
  }

  function patchSource(patch = {}) {
    state = { ...state, source: { ...state.source, ...patch } };
    emit();
  }

  function resetCurrentDraft() {
    const capabilityId = state.selectedCapabilityId;
    const modeId = state.selectedModes[capabilityId];
    const selected = getMode(capabilityId, modeId);
    if (!selected) return;
    state = {
      ...state,
      drafts: { ...state.drafts, [draftKey(capabilityId, modeId)]: selected.createDraft() }
    };
    emit();
  }

  function upsertRun(run = {}) {
    if (!run.runId) return;
    const index = state.runs.findIndex((item) => item.runId === run.runId);
    const runs = [...state.runs];
    if (index >= 0) runs[index] = { ...runs[index], ...cloneJson(run) };
    else runs.unshift(cloneJson(run));
    state = { ...state, runs, activeRunId: state.activeRunId || run.runId };
    emit();
  }

  function patchRun(runId, patch = {}) {
    const index = state.runs.findIndex((item) => item.runId === runId);
    if (index < 0) return;
    const runs = [...state.runs];
    runs[index] = { ...runs[index], ...cloneJson(patch) };
    state = { ...state, runs };
    emit();
  }

  function setActiveRun(runId) {
    if (runId && !state.runs.some((item) => item.runId === runId)) return;
    state = { ...state, activeRunId: runId || "" };
    emit();
  }

  function destroy() {
    listeners.clear();
  }

  return {
    getState,
    subscribe,
    setUser,
    selectCapability,
    selectMode,
    updateDraft,
    getDraft,
    replaceSource,
    patchSource,
    resetCurrentDraft,
    upsertRun,
    patchRun,
    setActiveRun,
    destroy
  };
}
