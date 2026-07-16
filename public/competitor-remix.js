import {
  $,
  apiEnvelope,
  bindLogin,
  dataUrlFromFile,
  showLogin
} from "./wangzhuan-common.js";
import { createRemixStore } from "./competitor-remix/store.js";
import { createMediaWorkspace } from "./competitor-remix/media-workspace.js";
import { createJobRunner } from "./competitor-remix/job-runner.js";
import { createRemixView } from "./competitor-remix/view.js";

const store = createRemixStore();
const media = createMediaWorkspace({ store, readAsDataURL: dataUrlFromFile });
const runner = createJobRunner({ store, request: apiEnvelope });
const loginModal = $("#remixLoginModal");
const view = createRemixView({
  store,
  media,
  runner,
  requireLogin: () => showLogin(loginModal, "请先登录后提交任务")
});

async function init() {
  await bindLogin({
    modal: loginModal,
    badge: $("#remixCurrentUserBadge"),
    logoutBtn: $("#remixLogoutBtn"),
    onAuthed(user) {
      store.setUser(user);
      runner.resume();
    }
  });
}

init().catch((error) => {
  showLogin(loginModal, error?.message || "登录状态读取失败");
});

window.addEventListener("beforeunload", () => {
  view.destroy();
  runner.destroy();
  media.destroy();
  store.destroy();
});
