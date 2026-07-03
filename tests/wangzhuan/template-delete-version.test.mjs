import assert from "node:assert/strict";
import test from "node:test";

import { adminTemplateAction } from "../../server/wangzhuan/templates.mjs";

const user = {
  userId: "admin",
  role: "admin",
  isAdmin: true
};

function template({ templateId, versionId, versionNumber, status = "active", isDefault = false, displayName = "Template" }) {
  return {
    templateId,
    versionId,
    versionNumber,
    status,
    isDefault,
    draft: {
      displayName,
      productName: "Product",
      currencySymbol: "$",
      language: "en-US",
      regions: ["US"],
      targetChannels: ["meta_ads"],
      defaultOutputRatio: "9:16",
      defaultDurationSec: 15,
      promiseLevel: "stable"
    },
    createdBy: "admin",
    createdAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z"
  };
}

function templateContext(initialStore) {
  let store = structuredClone(initialStore);
  return {
    user,
    loadTemplateStore: async () => store,
    saveTemplateStore: async (nextStore) => {
      store = structuredClone(nextStore);
    },
    recordTelemetryEvent: async () => {},
    getStore: () => store
  };
}

test("delete template admin action only deletes the selected version when versionId is provided", async () => {
  const context = templateContext({
    schemaVersion: "templates.v1",
    defaultTemplateId: "tpl_bonus",
    nextTemplateSeq: 3,
    templates: [
      template({ templateId: "tpl_bonus", versionId: "tpl_bonus_v1", versionNumber: 1, isDefault: true }),
      template({ templateId: "tpl_bonus", versionId: "tpl_bonus_v2", versionNumber: 2 }),
      template({ templateId: "tpl_cash", versionId: "tpl_cash_v1", versionNumber: 1, displayName: "Cash" })
    ]
  });

  const result = await adminTemplateAction(context, {
    action: "delete",
    templateId: "tpl_bonus",
    versionId: "tpl_bonus_v1"
  });

  assert.equal(result.versionId, "tpl_bonus_v1");
  const store = context.getStore();
  assert.equal(store.templates.find((item) => item.versionId === "tpl_bonus_v1").status, "deleted");
  assert.equal(store.templates.find((item) => item.versionId === "tpl_bonus_v2").status, "active");
  assert.equal(store.templates.find((item) => item.versionId === "tpl_cash_v1").status, "active");
  assert.equal(store.defaultTemplateId, "tpl_bonus");
});

test("legacy delete without versionId still deletes all versions of the selected template", async () => {
  const context = templateContext({
    schemaVersion: "templates.v1",
    defaultTemplateId: "tpl_bonus",
    nextTemplateSeq: 3,
    templates: [
      template({ templateId: "tpl_bonus", versionId: "tpl_bonus_v1", versionNumber: 1, isDefault: true }),
      template({ templateId: "tpl_bonus", versionId: "tpl_bonus_v2", versionNumber: 2 }),
      template({ templateId: "tpl_cash", versionId: "tpl_cash_v1", versionNumber: 1, displayName: "Cash" })
    ]
  });

  await adminTemplateAction(context, {
    action: "delete",
    templateId: "tpl_bonus"
  });

  const store = context.getStore();
  assert.equal(store.templates.find((item) => item.versionId === "tpl_bonus_v1").status, "deleted");
  assert.equal(store.templates.find((item) => item.versionId === "tpl_bonus_v2").status, "deleted");
  assert.equal(store.templates.find((item) => item.versionId === "tpl_cash_v1").status, "active");
  assert.equal(store.defaultTemplateId, "");
});
