import { claimSchedulerJob, completeSchedulerJob, failSchedulerJob } from "./mysql-facts.mjs";
import { retryFailedGenerationTask } from "./pipeline.mjs";

function retryDelayMs(job) {
  const attempts = Math.max(1, Number(job?.attempts || 1));
  return Math.min(10 * 60_000, 30_000 * 2 ** (attempts - 1));
}

async function runTaskRetryJob(context, job) {
  const batchId = job.payload?.batchId || job.runUid;
  const taskUid = job.payload?.taskUid || job.taskUid;
  if (!batchId || !taskUid) {
    const error = new Error("scheduler task_retry payload missing batchId or taskUid");
    error.code = "invalid_scheduler_payload";
    throw error;
  }
  return retryFailedGenerationTask(context, batchId, taskUid);
}

export async function runDueSchedulerJob(context, options = {}) {
  const workerId = options.workerId || `wangzhuan_scheduler_${process.pid || "local"}`;
  const job = await claimSchedulerJob({ workerId, lockSeconds: options.lockSeconds || 60 });
  if (!job) return { claimed: false };
  try {
    const jobContext = options.contextForJob ? await options.contextForJob(job, context) : context;
    let result = null;
    if (job.jobType === "task_retry") {
      result = await runTaskRetryJob(jobContext, job);
    } else {
      const error = new Error(`unsupported scheduler job type: ${job.jobType}`);
      error.code = "unsupported_scheduler_job";
      throw error;
    }
    await completeSchedulerJob(job, { workerId });
    return { claimed: true, job, result };
  } catch (error) {
    await failSchedulerJob(job, error, { workerId, retryDelayMs: retryDelayMs(job) });
    return { claimed: true, job, error };
  }
}

export async function runDueSchedulerJobs(context, options = {}) {
  const limit = Math.max(1, Math.min(Number(options.limit || 5), 50));
  const results = [];
  for (let index = 0; index < limit; index += 1) {
    const result = await runDueSchedulerJob(context, options);
    if (!result.claimed) break;
    results.push(result);
  }
  return {
    claimedCount: results.length,
    succeededCount: results.filter((item) => !item.error).length,
    failedCount: results.filter((item) => item.error).length,
    results
  };
}
