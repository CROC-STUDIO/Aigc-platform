import { WangzhuanError } from "./http.mjs";
import { loadWorkflowTasksFromMysql } from "./mysql-facts.mjs";

export async function listTasks(context, query = {}) {
  const result = await loadWorkflowTasksFromMysql(context, query);
  if (!result) {
    throw new WangzhuanError("database_unavailable", "MySQL 未就绪，无法查询任务列表", {});
  }
  return result;
}
