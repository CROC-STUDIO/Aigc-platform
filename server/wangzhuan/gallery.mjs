import { WangzhuanError } from "./http.mjs";
import { hasWangzhuanFactsStore, loadGalleryItemsFromMysql } from "./mysql-facts.mjs";

export async function getGallery(context, query = {}) {
  if (!await hasWangzhuanFactsStore()) {
    throw new WangzhuanError("database_unavailable", "MySQL 未配置或未连接，无法查询最终结果。请确认已启动 mysql 服务，并配置 AIGC_DB_HOST / AIGC_DB_NAME / AIGC_DB_USER（Docker 环境通常用 docker compose up）", {});
  }
  try {
    return await loadGalleryItemsFromMysql(context, query);
  } catch (error) {
    throw new WangzhuanError("database_unavailable", `MySQL 图库查询失败：${error?.message || "未知错误"}`, {
      cause: error?.code || error?.message || null
    });
  }
}
