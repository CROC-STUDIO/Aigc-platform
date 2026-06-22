import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getChannelRules } from "../../server/wangzhuan/channel-rules.mjs";
import { DEFAULT_CHANNEL_RULES } from "../../server/wangzhuan/constants.mjs";
import {
  closeWangzhuanFactsPool,
  setWangzhuanFactsPoolForTest,
  syncChannelRuleStoreFacts
} from "../../server/wangzhuan/mysql-facts.mjs";
import { adminTemplateAction, listTemplates, saveTemplate } from "../../server/wangzhuan/templates.mjs";
import { fakePool } from "./mysql-facts-fixture.mjs";

const draft = {
  displayName: "Cash Reward US EN",
  productName: "Lucky Cash",
  cta: "Download now",
  ending: "Claim your bonus today",
  currencySymbol: "$",
  language: "en-US",
  regions: ["US"],
  targetChannels: ["meta_ads"],
  defaultOutputRatio: "9:16",
  defaultDurationSec: 15,
  promiseLevel: "strong_conversion"
};

function context(root, role = "user") {
  return {
    sharedProjectRoot: join(root, "shared"),
    userProjectRoot: join(root, "user"),
    user: { userId: role, username: role, role, isAdmin: role === "admin" },
    userId: role
  };
}

let activePool = null;

function ensureFactsPool() {
  if (!activePool) {
    activePool = fakePool();
    setWangzhuanFactsPoolForTest(activePool);
  }
  return activePool;
}

async function resetFactsPool() {
  activePool = null;
  setWangzhuanFactsPoolForTest(null);
  await closeWangzhuanFactsPool();
}

test("creates templates, appends immutable versions, and lists active templates", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-template-"));
  ensureFactsPool();
  try {
    const first = await saveTemplate(context(root), { mode: "create", draft });
    assert.match(first.template.templateId, /^tpl_cash_reward_us_en_\d{3}$/);
    assert.equal(first.template.versionNumber, 1);
    assert.equal(first.template.isDefault, true);

    const second = await saveTemplate(context(root), {
      mode: "edit_new_version",
      templateId: first.template.templateId,
      draft: { ...draft, cta: "Install today" }
    });
    assert.equal(second.template.templateId, first.template.templateId);
    assert.equal(second.template.versionNumber, 2);
    assert.notEqual(second.template.versionId, first.template.versionId);

    const listed = await listTemplates(context(root), {});
    assert.equal(listed.templates.length, 2);
    assert.equal(listed.defaultTemplateId, first.template.templateId);
    assert.deepEqual(listed.permissions, {
      canCreateVersion: true,
      canAdminTemplates: false
    });
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects strong commitment templates without user-maintained truth rules", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-strong-"));
  ensureFactsPool();
  try {
    await assert.rejects(
      () => saveTemplate(context(root), { mode: "create", draft: { ...draft, promiseLevel: "strong_commitment" } }),
      { code: "validation_error" }
    );
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("admin-only template actions update status and write audit events", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-admin-"));
  const pool = ensureFactsPool();
  try {
    const created = await saveTemplate(context(root), { mode: "create", draft });

    await assert.rejects(
      () => adminTemplateAction(context(root), { action: "archive", templateId: created.template.templateId }),
      { code: "permission_denied" }
    );

    const result = await adminTemplateAction(context(root, "admin"), {
      action: "archive",
      templateId: created.template.templateId
    });
    assert.equal(result.status, "archived");
    assert.match(result.auditEventId, /^audit_\d{14}_[a-f0-9]{4}$/);

    assert.equal(pool.state.auditEvents.some((event) => event.action === "product_template_admin_changed"), true);
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});

test("seeds default channel rules and falls back to generic rules explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "wz-rules-"));
  ensureFactsPool();
  try {
    const seeded = await getChannelRules(context(root), { channel: "meta_ads", promiseLevel: "strong_conversion" });
    assert.equal(seeded.rules.length, 1);
    assert.equal(seeded.rules[0].channel, "meta_ads");
    assert.equal(seeded.rules[0].fallbackUsed, false);

    await resetFactsPool();
    ensureFactsPool();
    await syncChannelRuleStoreFacts(context(root), {
      schemaVersion: "channel-rules.v1",
      rules: DEFAULT_CHANNEL_RULES.filter((rule) => rule.channel === "generic" && rule.promiseLevel === "stable")
    });

    const fallback = await getChannelRules(context(root), { channel: "unity_ads", promiseLevel: "stable" });
    assert.equal(fallback.fallbackUsed, true);
    assert.equal(fallback.rules[0].channel, "generic");
    assert.equal(fallback.rules[0].fallbackUsed, true);
    assert.equal(fallback.warnings[0].code, "channel_rule_missing");
  } finally {
    await resetFactsPool();
    await rm(root, { recursive: true, force: true });
  }
});
