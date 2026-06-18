import { DEFAULT_CHANNEL_RULES, DEFAULT_RULE_PROMISE_LEVELS, PROMISE_LEVELS, TARGET_CHANNELS } from "./constants.mjs";
import { loadChannelRuleStoreFromMysql, syncChannelRuleStoreFacts } from "./mysql-facts.mjs";
import { readJsonOrDefault, wangzhuanPaths, writeAtomicJson } from "./storage.mjs";

const DEFAULT_RULE_STORE = Object.freeze({
  schemaVersion: "channel-rules.v1",
  rules: DEFAULT_CHANNEL_RULES
});

export async function loadChannelRuleStore(context) {
  const paths = wangzhuanPaths(context);
  const mysqlStore = await loadChannelRuleStoreFromMysql(context);
  const store = mysqlStore ?? await readJsonOrDefault(paths.channelRulesPath, DEFAULT_RULE_STORE);
  if (!store?.schemaVersion || !Array.isArray(store.rules)) {
    return structuredClone(DEFAULT_RULE_STORE);
  }
  if (store.rules.length === 0) {
    await writeAtomicJson(paths.channelRulesPath, DEFAULT_RULE_STORE);
    await syncChannelRuleStoreFacts(context, DEFAULT_RULE_STORE);
    return structuredClone(DEFAULT_RULE_STORE);
  }
  return store;
}

export async function getChannelRules(context, query = {}) {
  const channel = TARGET_CHANNELS.includes(query.channel) ? query.channel : "generic";
  const promiseLevel = PROMISE_LEVELS.includes(query.promiseLevel) ? query.promiseLevel : "stable";
  const normalizedPromiseLevel = DEFAULT_RULE_PROMISE_LEVELS.includes(promiseLevel) ? promiseLevel : "strong_conversion";
  const paths = wangzhuanPaths(context);
  const mysqlStore = await loadChannelRuleStoreFromMysql(context);
  const existedStore = mysqlStore ?? await readJsonOrDefault(paths.channelRulesPath, null);
  const store = existedStore ?? DEFAULT_RULE_STORE;
  if (!existedStore) {
    await writeAtomicJson(paths.channelRulesPath, store);
    await syncChannelRuleStoreFacts(context, store);
  }

  let rules = store.rules.filter((rule) => rule.channel === channel && rule.promiseLevel === normalizedPromiseLevel);
  let fallbackUsed = false;
  const warnings = [];

  if (!rules.length && channel !== "generic") {
    fallbackUsed = true;
    rules = store.rules
      .filter((rule) => rule.channel === "generic" && rule.promiseLevel === normalizedPromiseLevel)
      .map((rule) => ({ ...rule, fallbackUsed: true }));
    warnings.push({
      code: "channel_rule_missing",
      field: "channel",
      message: "未配置该渠道规则，已使用通用规则",
      severity: "warn"
    });
  }

  return {
    rules,
    fallbackUsed,
    warnings
  };
}
