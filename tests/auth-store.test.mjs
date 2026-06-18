import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createAuthStore,
  hashPassword,
  normalizeUsers,
  publicUser,
  verifyPassword
} from "../server/auth-store.mjs";

test("password hashes do not store plaintext and can be verified", async () => {
  const hash = await hashPassword("admin123");

  assert.match(hash, /^scrypt\$/);
  assert.equal(hash.includes("admin123"), false);
  assert.equal(await verifyPassword("admin123", hash), true);
  assert.equal(await verifyPassword("wrong-password", hash), false);
});

test("json auth store creates a default admin and persists login sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-auth-json-"));
  const usersPath = join(root, "users.json");
  try {
    const store = createAuthStore({ usersPath });
    await store.init();

    const created = JSON.parse(await readFile(usersPath, "utf8"));
    assert.equal(created.users[0].username, "admin");
    assert.equal(created.users[0].role, "admin");

    const login = await store.login("admin", "admin123", {
      ip: "127.0.0.1",
      userAgent: "node-test"
    });

    assert.equal(login.user.username, "admin");
    assert.equal(login.user.isAdmin, true);
    assert.equal(typeof login.token, "string");
    assert.equal(login.token.length > 40, true);

    const sessionUser = await store.userFromSessionToken(login.token);
    assert.deepEqual(publicUser(sessionUser), login.user);

    await store.logout(login.token);
    assert.equal(await store.userFromSessionToken(login.token), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("json auth store keeps admin user management behavior", async () => {
  const root = await mkdtemp(join(tmpdir(), "aigc-auth-admin-"));
  const usersPath = join(root, "users.json");
  try {
    await writeFile(usersPath, JSON.stringify({
      users: [
        { username: "admin", password: "admin123", displayName: "管理员", role: "admin" }
      ]
    }), "utf8");

    const store = createAuthStore({ usersPath });
    await store.init();

    await store.createUser({ username: "user01", password: "pass123", displayName: "用户01", role: "user" });
    let users = await store.listUsers();
    assert.equal(users.length, 2);
    assert.equal(users.find((item) => item.username === "user01").role, "user");

    await store.updateUser({ username: "user01", displayName: "用户一", password: "next123", role: "admin" }, { username: "admin" });
    users = await store.listUsers();
    assert.equal(users.find((item) => item.username === "user01").displayName, "用户一");
    assert.equal(users.find((item) => item.username === "user01").role, "admin");

    assert.equal((await store.login("user01", "pass123")).authenticated, false);
    assert.equal((await store.login("user01", "next123")).authenticated, true);

    await assert.rejects(
      () => store.deleteUser("admin", { username: "admin" }),
      /不能删除当前登录的管理员账号/
    );

    await store.deleteUser("user01", { username: "admin" });
    users = await store.listUsers();
    assert.equal(users.some((item) => item.username === "user01"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("normalizeUsers rejects blank and duplicate accounts", () => {
  assert.deepEqual(normalizeUsers([
    { username: "admin", password: "admin123" },
    { username: "admin", password: "duplicate" },
    { username: "", password: "ignored" },
    { username: "demo", password: "", role: "admin" }
  ]), [
    { username: "admin", password: "admin123", displayName: "admin", role: "admin" }
  ]);
});
