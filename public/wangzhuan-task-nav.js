import {
  activeLockActionsHtml,
  activeLockFromBatchError,
  taskSpaceHref
} from "./wangzhuan-common.js";

export { activeLockFromBatchError };

export function renderActiveLockBanner(host, lock) {
  if (!host?.actions || !host?.text) return null;
  host.state.activeLock = lock || null;
  if (!host.state.activeLock) {
    host.actions.hidden = true;
    host.text.textContent = "";
    return null;
  }
  host.actions.hidden = false;
  host.text.innerHTML = activeLockActionsHtml(host.state.activeLock);
  return host.state.activeLock;
}

export function showActiveLockFromError(host, error) {
  const lock = activeLockFromBatchError(error);
  if (lock) renderActiveLockBanner(host, lock);
  return lock;
}

export function clearActiveLockBanner(host) {
  return renderActiveLockBanner(host, null);
}

export function goToTaskManagement(lock) {
  if (!lock) return;
  location.assign(taskSpaceHref(lock.type, lock.id));
}
