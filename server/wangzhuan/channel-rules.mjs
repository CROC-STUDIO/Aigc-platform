import { DEFAULT_CHANNEL_RULES, DEFAULT_RULE_PROMISE_LEVELS, PROMISE_LEVELS, TARGET_CHANNELS } from "./constants.mjs";
import { WangzhuanError } from "./http.mjs";
import { hasWangzhuanFactsStore, loadChannelRuleStoreFromMysql, syncChannelRuleStoreFacts } from "./mysql-facts.mjs";

const DEFAULT_RULE_STORE = Object.freeze({
  schemaVersion: "channel-rules.v1",
  rules: DEFAULT_CHANNEL_RULES
});

export async function loadChannelRuleStore(context) {
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "数据库未连接，无法读取渠道规则");
  }
  const mysqlStore = await loadChannelRuleStoreFromMysql(context);
  let store = mysqlStore;
  if (!store) {
    const synced = await syncChannelRuleStoreFacts(context, DEFAULT_RULE_STORE);
    if (synced?.skipped) {
      throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存渠道规则");
    }
    store = await loadChannelRuleStoreFromMysql(context);
  }
  if (!store?.schemaVersion || !Array.isArray(store.rules)) {
    throw new WangzhuanError("database_unavailable", "数据库渠道规则结构异常");
  }
  if (store.rules.length === 0) {
    const synced = await syncChannelRuleStoreFacts(context, DEFAULT_RULE_STORE);
    if (synced?.skipped) {
      throw new WangzhuanError("database_unavailable", "数据库未连接，无法保存渠道规则");
    }
    store = await loadChannelRuleStoreFromMysql(context);
  }
  if (!store?.rules?.length) {
    throw new WangzhuanError("database_unavailable", "数据库渠道规则为空，请先初始化规则");
  }
  return store;
}

export async function getChannelRules(context, query = {}) {
  const channel = TARGET_CHANNELS.includes(query.channel) ? query.channel : "generic";
  const promiseLevel = PROMISE_LEVELS.includes(query.promiseLevel) ? query.promiseLevel : "stable";
  const normalizedPromiseLevel = DEFAULT_RULE_PROMISE_LEVELS.includes(promiseLevel) ? promiseLevel : "strong_conversion";
  const store = await loadChannelRuleStore(context);

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
