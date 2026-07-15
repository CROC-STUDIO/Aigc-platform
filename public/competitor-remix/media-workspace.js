const VIDEO_EXTENSIONS = /\.(mp4|mov|m4v|webm)$/i;

function defaultReadAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("视频文件读取失败"));
    reader.onabort = () => reject(new Error("视频文件读取已取消"));
    reader.readAsDataURL(file);
  });
}

function fileIdentity(file) {
  return `${file.name || "video"}:${Number(file.size || 0)}:${Number(file.lastModified || 0)}`;
}

function validateFile(file, maxBytes) {
  if (!file) throw new Error("请选择视频文件");
  const videoMime = /^video\//i.test(String(file.type || ""));
  if (!videoMime && !VIDEO_EXTENSIONS.test(String(file.name || ""))) throw new Error("只支持视频文件");
  if (!Number.isFinite(Number(file.size)) || Number(file.size) <= 0) throw new Error("视频文件为空或无法读取");
  if (Number(file.size) > maxBytes) throw new Error(`视频文件超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
}

export function createMediaWorkspace({
  store,
  maxBytes = 314572800,
  createObjectURL = (file) => URL.createObjectURL(file),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
  readAsDataURL = defaultReadAsDataURL
} = {}) {
  if (!store) throw new Error("media workspace 需要 store");
  let activeObjectUrl = store.getState().source.objectUrl || "";
  let preparingPromise = null;
  let preparedIdentity = "";
  let preparedDataUrl = "";

  function releaseObjectUrl() {
    if (!activeObjectUrl) return;
    try {
      revokeObjectURL(activeObjectUrl);
    } catch {
      // A revoked or unsupported object URL needs no further cleanup.
    }
    activeObjectUrl = "";
  }

  function selectFile(file) {
    validateFile(file, maxBytes);
    const nextObjectUrl = createObjectURL(file);
    releaseObjectUrl();
    activeObjectUrl = nextObjectUrl;
    preparingPromise = null;
    preparedIdentity = "";
    preparedDataUrl = "";
    store.replaceSource({
      mode: "file",
      file,
      fileName: file.name || "video",
      objectUrl: nextObjectUrl,
      dataUrl: "",
      identity: fileIdentity(file),
      metadata: null,
      status: "ready",
      error: "",
      needsFile: false
    });
    return store.getState().source;
  }

  function clearFile() {
    releaseObjectUrl();
    preparingPromise = null;
    preparedIdentity = "";
    preparedDataUrl = "";
    store.replaceSource({ mode: "url", url: "", identity: "", status: "idle" });
  }

  function setUrl(url) {
    releaseObjectUrl();
    preparingPromise = null;
    preparedIdentity = "";
    preparedDataUrl = "";
    const cleaned = String(url || "").trim();
    store.replaceSource({
      mode: "url",
      url: cleaned,
      identity: cleaned ? `url:${cleaned}` : "",
      status: cleaned ? "ready" : "idle",
      error: "",
      needsFile: false
    });
  }

  function updateMetadata(metadata = {}) {
    const width = Number(metadata.width);
    const height = Number(metadata.height);
    const duration = Number(metadata.duration);
    store.patchSource({
      metadata: {
        width: Number.isFinite(width) ? width : 0,
        height: Number.isFinite(height) ? height : 0,
        duration: Number.isFinite(duration) ? duration : 0
      }
    });
  }

  async function prepareInput() {
    const source = store.getState().source;
    if (source.mode !== "file") return source;
    if (!source.file) throw new Error("请重新选择本地视频文件");
    if (preparedIdentity === source.identity && preparedDataUrl) {
      if (source.dataUrl !== preparedDataUrl) store.patchSource({ dataUrl: preparedDataUrl, status: "ready", error: "" });
      return store.getState().source;
    }
    if (preparingPromise) return preparingPromise;
    store.patchSource({ status: "preparing", error: "" });
    const identity = source.identity;
    const file = source.file;
    preparingPromise = Promise.resolve()
      .then(() => readAsDataURL(file))
      .then((dataUrl) => {
        if (!String(dataUrl || "").startsWith("data:video/") && !String(dataUrl || "").startsWith("data:application/octet-stream")) {
          throw new Error("视频文件读取结果无效");
        }
        const current = store.getState().source;
        if (current.identity !== identity) throw new Error("视频文件已更换，请重新提交");
        preparedIdentity = identity;
        preparedDataUrl = String(dataUrl);
        store.patchSource({ dataUrl: preparedDataUrl, status: "ready", error: "", needsFile: false });
        return store.getState().source;
      })
      .catch((error) => {
        if (store.getState().source.identity === identity) {
          store.patchSource({ status: "error", error: error?.message || "视频文件读取失败" });
        }
        throw error;
      })
      .finally(() => {
        preparingPromise = null;
      });
    return preparingPromise;
  }

  function destroy() {
    releaseObjectUrl();
    preparingPromise = null;
  }

  return { selectFile, clearFile, setUrl, updateMetadata, prepareInput, destroy };
}
