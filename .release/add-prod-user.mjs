import { createAuthStore } from "../server/auth-store.mjs";

const username = process.argv[2];
const password = process.argv[3];
const displayName = process.argv[4] || username;
const role = process.argv[5] || "user";

if (!username || !password) {
  console.error("usage: node add-prod-user.mjs <username> <password> [displayName] [role]");
  process.exit(1);
}

const store = createAuthStore({ usersPath: process.env.AIGC_USERS_PATH || "/data/users/users.json" });
await store.init();
try {
  const users = await store.listUsers();
  if (users.some((item) => item.username === username)) {
    console.log(JSON.stringify({ ok: true, action: "exists", username }));
    process.exit(0);
  }
  const result = await store.createUser({ username, password, displayName, role });
  console.log(JSON.stringify({ ok: true, action: "created", users: result.users.map((item) => ({
    username: item.username,
    displayName: item.displayName,
    role: item.role
  })) }));
} finally {
  await store.close();
}
