import { claimSchedulerJob, completeSchedulerJob, failSchedulerJob, rescheduleSchedulerJob } from "./mysql-facts.mjs";
import { retryFailedGenerationTask } from "./pipeline.mjs";
import { runBatchQc } from "./qc.mjs";
import { pollUpstreamBatch } from "./upstream-poll.mjs";

const DEFAULT_DEPS = Object.freeze({
  retryFailedGenerationTask,
  pollUpstreamBatch,
  runBatchQc
});

function retryDelayMs(job) {
  const attempts = Math.max(1, Number(job?.attempts || 1));
  return Math.min(10 * 60_000, 30_000 * 2 ** (attempts - 1));
}

async function runTaskRetryJob(context, job, deps = DEFAULT_DEPS) {
  const batchId = job.payload?.batchId || job.runUid;
  const taskUid = job.payload?.taskUid || job.taskUid;
  if (!batchId || !taskUid) {
    const error = new Error("scheduler task_retry payload missing batchId or taskUid");
    error.code = "invalid_scheduler_payload";
    throw error;
  }
  return deps.retryFailedGenerationTask(context, batchId, taskUid);
}

export async function runUpstreamPollJob(context, job, deps = DEFAULT_DEPS) {
  const batchId = job.payload?.batchId || job.runUid;
  if (!batchId) {
    const error = new Error("scheduler upstream_poll payload missing batchId");
    error.code = "invalid_scheduler_payload";
    throw error;
  }
  const result = await deps.pollUpstreamBatch(context, batchId);
  const batch = result.batch;
  if (!result.needsPoll && batch?.status === "qc") {
    const qc = await deps.runBatchQc(context, batchId);
    return {
      ...result,
      batch: qc.batch || batch,
      qc
    };
  }
  return result;
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
      await completeSchedulerJob(job, { workerId });
    } else if (job.jobType === "upstream_poll") {
      result = await runUpstreamPollJob(jobContext, job);
      if (result.needsPoll) {
        await rescheduleSchedulerJob(job, { workerId, delayMs: options.upstreamPollDelayMs || 30_000 });
      } else {
        await completeSchedulerJob(job, { workerId });
      }
    } else {
      const error = new Error(`unsupported scheduler job type: ${job.jobType}`);
      error.code = "unsupported_scheduler_job";
      throw error;
    }
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
