import { WangzhuanError } from "./http.mjs";
import { loadGalleryItemsFromMysql } from "./mysql-facts.mjs";

export async function getGallery(context, query = {}) {
  const mysqlGallery = await loadGalleryItemsFromMysql(context, query);
  if (mysqlGallery) return mysqlGallery;
  throw new WangzhuanError("database_unavailable", "MySQL 未就绪，无法查询最终结果", {});
}
