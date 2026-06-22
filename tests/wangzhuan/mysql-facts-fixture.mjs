export function fakePool() {
  const calls = [];
  const state = {
    users: new Map(),
    projects: new Map(),
    roles: new Map([["user", 11], ["admin", 12]]),
    runs: new Map(),
    runRows: new Map(),
    runStatuses: new Map(),
    tasks: new Map(),
    taskRowsByRunId: new Map(),
    templates: new Map(),
    templateVersions: new Map(),
    templateRows: [],
    channelRows: [],
    assets: new Map(),
    referenceVideos: new Map(),
    decompositions: new Map(),
    estimates: new Map(),
    idempotency: new Map(),
    scripts: new Map(),
    outputs: new Map(),
    outputRowsByRunId: new Map(),
    qcReports: new Map(),
    stitchReports: new Map(),
    remixRegionsByRunId: new Map(),
    schedulerJobs: new Map(),
    stateTransitionRules: new Set(),
    stateTransitionEvents: [],
    resourceLocks: new Map(),
    nextUserId: 101,
    nextProjectId: 201,
    nextRunId: 301,
    nextTaskId: 401,
    nextTemplateId: 501,
    nextTemplateVersionId: 601,
    nextAssetId: 701,
    nextReferenceVideoId: 801,
    nextDecompositionId: 901,
    nextEstimateId: 1001,
    nextScriptId: 1101,
    nextOutputId: 1201,
    nextQcReportId: 1251,
    nextStitchReportId: 1271,
    nextSchedulerJobId: 1301
  };

  const conn = {
    calls,
    async beginTransaction() {
      calls.push({ sql: "BEGIN", params: [] });
    },
    async commit() {
      calls.push({ sql: "COMMIT", params: [] });
    },
    async rollback() {
      calls.push({ sql: "ROLLBACK", params: [] });
    },
    release() {
      calls.push({ sql: "RELEASE", params: [] });
    },
    async execute(sql, params = []) {
      calls.push({ sql, params });

      if (sql.includes("SELECT id FROM app_users WHERE username")) {
        const id = state.users.get(params[0]);
        return [id ? [{ id }] : []];
      }
      if (sql.includes("INSERT INTO app_users")) {
        state.users.set(params[1], state.nextUserId++);
        return [{ insertId: state.users.get(params[1]) }];
      }
      if (sql.includes("SELECT id FROM rbac_roles")) {
        const id = state.roles.get(params[0]);
        return [id ? [{ id }] : []];
      }
      if (sql.includes("SELECT id FROM projects WHERE project_key")) {
        const id = state.projects.get(params[0]);
        return [id ? [{ id }] : []];
      }
      if (sql.includes("INSERT INTO projects")) {
        state.projects.set(params[1], state.nextProjectId++);
        return [{ insertId: state.projects.get(params[1]) }];
      }
      if (sql.trim().startsWith("SELECT asset_uid")) {
        const prefix = String(params[1] || "").replace(/%$/, "");
        const rows = [...state.assets.keys()]
          .filter((assetUid) => assetUid.startsWith(prefix))
          .sort()
          .reverse()
          .slice(0, 1)
          .map((asset_uid) => ({ asset_uid }));
        return [rows];
      }
      if (sql.trim().startsWith("SELECT estimate_uid")) {
        const prefix = String(params[1] || "").replace(/%$/, "");
        const rows = [...state.estimates.keys()]
          .filter((estimateUid) => estimateUid.startsWith(prefix))
          .sort()
          .reverse()
          .slice(0, 1)
          .map((estimate_uid) => ({ estimate_uid }));
        return [rows];
      }
      if (sql.includes("SELECT id FROM work_estimates") && sql.includes("estimate_uid")) {
        const estimate = state.estimates.get(params.at(-1));
        return [estimate ? [{ id: estimate.id }] : []];
      }
      if (sql.includes("SELECT id FROM workflow_runs") && sql.includes("run_uid")) {
        const id = state.runs.get(params.at(-1));
        return [id ? [{ id }] : []];
      }
      if (sql.includes("SELECT status FROM workflow_runs WHERE id")) {
        return [[{ status: state.runStatuses.get(params[0]) || "queued" }]];
      }
      if (sql.includes("INSERT IGNORE INTO state_transition_rules")) {
        state.stateTransitionRules.add(`${params[0]}|${params[1]}|${params[2]}|${params[3]}`);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM state_transition_rules")) {
        const key = `${params[0]}|${params[1]}|${params[2]}|${params[3]}`;
        return [state.stateTransitionRules.has(key) ? [{ id: 1 }] : []];
      }
      if (sql.includes("INSERT INTO state_transition_events")) {
        state.stateTransitionEvents.push({
          id: state.stateTransitionEvents.length + 1,
          event_uid: params[0],
          entity_type: params[1],
          entity_uid: params[2],
          from_status: params[3],
          to_status: params[4],
          trigger_name: params[5],
          actor_user_id: params[6],
          reason: params[7],
          occurred_at: "2026-06-18 00:00:00.000"
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM scheduler_jobs sj") && sql.includes("FOR UPDATE SKIP LOCKED")) {
        const workerId = params.at(-1);
        const rows = [...state.schedulerJobs.values()]
          .filter((job) => job.status === "pending" || (job.status === "running" && job.lockedBy === workerId))
          .sort((a, b) => (a.priority - b.priority) || (a.id - b.id))
          .slice(0, 1)
          .map((job) => ({
            id: job.id,
            job_uid: job.jobUid,
            job_type: job.jobType,
            status: job.status,
            attempts: job.attempts,
            max_attempts: job.maxAttempts,
            payload_json: JSON.stringify(job.payload),
            run_uid: job.runUid,
            task_uid: job.taskUid,
            username: "alice",
            project_key: "root:test"
          }));
        return [rows];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("status = 'succeeded'")) {
        const job = [...state.schedulerJobs.values()].find((item) => item.id === params.at(-2));
        if (job) {
          job.status = "succeeded";
          job.lockedBy = null;
        }
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("last_error_code")) {
        const job = [...state.schedulerJobs.values()].find((item) => item.id === params.at(-2));
        if (job) {
          job.status = params[0];
          job.lastErrorCode = params[3];
          job.lastErrorMessage = params[4];
          job.lockedBy = null;
        }
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("status = 'running'")) {
        const job = [...state.schedulerJobs.values()].find((item) => item.id === params[2]);
        if (job) {
          job.status = "running";
          job.lockedBy = params[0];
          job.attempts += 1;
        }
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("INSERT INTO resource_locks")) {
        state.resourceLocks.set(params[0], {
          lock_key: params[0],
          lock_type: "upstream_generation",
          status: "active",
          run_uid: [...state.runs.entries()].find(([, id]) => id === params[3])?.[0] || "",
          run_type: state.runRows.get(params[3])?.run_type || "pipeline",
          run_status: "running",
          expires_at: "2026-06-18 02:00:00.000"
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE resource_locks")) {
        const lock = state.resourceLocks.get(params[0]);
        if (lock) lock.status = "released";
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM resource_locks rl")) {
        const projectId = params[0];
        const userId = params[1];
        const lock = [...state.resourceLocks.values()].find((item) => {
          const run = [...state.runRows.values()].find((row) => row.run_uid === item.run_uid);
          return item.status === "active" && run?.project_id === projectId && run?.user_id === userId;
        });
        return [lock ? [lock] : []];
      }
      if (sql.includes("INSERT INTO workflow_runs")) {
        const existing = state.runs.get(params[0]);
        const id = existing ?? state.nextRunId++;
        state.runs.set(params[0], id);
        state.runStatuses.set(id, params[2]);
        state.runRows.set(id, {
          id,
          run_uid: params[0],
          run_type: params[1],
          status: params[2],
          project_id: params[3],
          user_id: params[4],
          estimate_id: params[5],
          template_version_id: params[6],
          reference_video_id: params[7],
          source_asset_file_id: params[8],
          operation_type: params[9],
          target_channel: params[10],
          template_snapshot_json: params[11],
          request_json: params[12],
          capability_json: params[13],
          qc_summary_json: params[14],
          stop_reason: params[15],
          started_at: params[16],
          finished_at: params[17],
          created_at: params[18],
          updated_at: params[19]
        });
        return [{ insertId: state.runs.get(params[0]) }];
      }
      if (sql.includes("SELECT id, status, attempts FROM workflow_tasks")) {
        const task = state.tasks.get(params.at(-1));
        return [task ? [task] : []];
      }
      if (sql.includes("INSERT INTO workflow_tasks")) {
        const existing = state.tasks.get(params[0]);
        const task = {
          id: existing?.id ?? state.nextTaskId++,
          task_uid: params[0],
          run_id: params[1],
          script_id: params[2],
          task_kind: params[3],
          status: params[4],
          model_image: params[5],
          model_video: params[6],
          provider: params[7],
          image_task_id: params[8],
          seedance_task_id: params[9],
          provider_job_id: params[10],
          prompt_asset_file_id: params[11],
          output_asset_file_id: params[12],
          attempts: params[13],
          max_attempts: params[14],
          started_at: params[15],
          finished_at: params[16],
          error_code: params[17],
          error_message: params[18],
          request_summary_json: params[19],
          response_summary_json: params[20]
        };
        state.tasks.set(params[0], { id: task.id, status: task.status, attempts: task.attempts, ...task });
        state.taskRowsByRunId.set(params[1], [
          ...(state.taskRowsByRunId.get(params[1]) || []).filter((item) => item.task_uid !== task.task_uid),
          task
        ]);
        return [{ insertId: state.tasks.get(params[0]).id }];
      }
      if (sql.includes("SELECT id FROM workflow_tasks") && sql.includes("task_uid")) {
        const task = state.tasks.get(params.at(-1));
        return [task ? [{ id: task.id }] : []];
      }
      if (sql.includes("SELECT id FROM generation_scripts") && sql.includes("script_uid")) {
        const script = state.scripts.get(params.at(-1));
        return [script ? [{ id: script.id }] : []];
      }
      if (sql.includes("INSERT INTO generation_scripts")) {
        const scriptUid = params[0];
        const existing = state.scripts.get(scriptUid);
        state.scripts.set(scriptUid, {
          id: existing?.id ?? state.nextScriptId++,
          scriptUid,
          runId: params[1],
          variantIndex: params[2],
          segmentIndex: params[3],
          durationSec: params[4],
          hookText: params[5],
          bodyText: params[6],
          ctaText: params[7],
          endingText: params[8],
          rewardExpression: params[9],
          scriptAssetFileId: params[10],
          promptAssetFileId: params[11]
        });
        return [{ insertId: state.scripts.get(scriptUid).id }];
      }
      if (sql.includes("SELECT id FROM workflow_outputs") && sql.includes("output_uid")) {
        const output = state.outputs.get(params.at(-1));
        return [output ? [{ id: output.id }] : []];
      }
      if (sql.includes("INSERT INTO workflow_outputs")) {
        const outputUid = params[0];
        const existing = state.outputs.get(outputUid);
        const output = {
          id: existing?.id ?? state.nextOutputId++,
          output_uid: outputUid,
          run_id: params[1],
          script_id: params[2],
          asset_file_id: params[3],
          source_type: params[4],
          output_kind: params[5],
          duration_sec: params[6],
          qc_status: params[7],
          download_eligible: params[8],
          visual_preview_required: params[9],
          preview_confirmed: params[10],
          preview_confirmed_by: params[11],
          preview_confirmed_at: params[12]
        };
        state.outputs.set(outputUid, { id: output.id, outputUid, ...output });
        state.outputRowsByRunId.set(params[1], [
          ...(state.outputRowsByRunId.get(params[1]) || []).filter((item) => item.output_uid !== output.output_uid),
          output
        ]);
        return [{ insertId: state.outputs.get(outputUid).id }];
      }
      if (sql.includes("INSERT INTO qc_reports")) {
        const outputId = params[0];
        const existing = state.qcReports.get(outputId);
        state.qcReports.set(outputId, {
          id: existing?.id ?? state.nextQcReportId++,
          output_id: outputId,
          report_asset_file_id: params[1],
          qc_status: params[2],
          checks_json: params[3],
          summary: params[4],
          created_by: params[5]
        });
        return [{ insertId: state.qcReports.get(outputId).id }];
      }
      if (sql.includes("INSERT INTO stitch_reports")) {
        const outputId = params[0];
        const existing = state.stitchReports.get(outputId);
        state.stitchReports.set(outputId, {
          id: existing?.id ?? state.nextStitchReportId++,
          output_id: outputId,
          report_asset_file_id: params[1],
          status: params[2],
          stitch_tool: params[3],
          segment_output_ids_json: params[4],
          command_summary: params[5],
          error_code: params[6],
          error_message: params[7],
          created_at: params[8]
        });
        return [{ insertId: state.stitchReports.get(outputId).id }];
      }
      if (sql.includes("SELECT id FROM product_templates") && sql.includes("template_uid")) {
        const template = state.templates.get(params.at(-1));
        return [template ? [{ id: template.id }] : []];
      }
      if (sql.includes("INSERT INTO product_templates")) {
        const templateId = params[0];
        const existing = state.templates.get(templateId);
        state.templates.set(templateId, {
          id: existing?.id ?? state.nextTemplateId++,
          templateId,
          projectId: params[1],
          displayName: params[2],
          status: params[3],
          createdBy: params[4],
          createdAt: params[5],
          updatedAt: params[6]
        });
        return [{ insertId: state.templates.get(templateId).id }];
      }
      if (sql.includes("INSERT INTO product_template_versions")) {
        const versionId = params[0];
        const existing = state.templateVersions.get(versionId);
        state.templateVersions.set(versionId, {
          id: existing?.id ?? state.nextTemplateVersionId++,
          versionId,
          templateDbId: params[1],
          versionNumber: params[2],
          status: params[3],
          draftJson: params[15],
          createdBy: params[16],
          createdAt: params[17]
        });
        return [{ insertId: state.templateVersions.get(versionId).id }];
      }
      if (sql.includes("SELECT id FROM product_template_versions") && sql.includes("template_version_uid")) {
        const version = state.templateVersions.get(params.at(-1));
        return [version ? [{ id: version.id }] : []];
      }
      if (sql.includes("FROM product_templates pt") && sql.includes("product_template_versions pv")) {
        if (state.templateRows.length) return [state.templateRows];
        const rows = [];
        const defaultVersionId = [...state.templateVersions.values()][0]?.id;
        for (const version of state.templateVersions.values()) {
          const template = [...state.templates.values()].find((item) => item.id === version.templateDbId);
          if (!template) continue;
          rows.push({
            template_uid: template.templateId,
            display_name: template.displayName,
            template_status: template.status,
            template_created_at: template.createdAt || "2026-06-18 00:00:00.000",
            template_updated_at: template.updatedAt || template.createdAt || "2026-06-18 00:00:00.000",
            template_version_uid: version.versionId,
            version_number: version.versionNumber,
            version_status: version.status,
            draft_json: version.draftJson,
            created_by_username: "alice",
            version_created_at: version.createdAt || "2026-06-18 00:00:00.000",
            is_default: version.id === defaultVersionId ? 1 : 0
          });
        }
        return [rows];
      }
      if (sql.includes("FROM channel_rules")) {
        return [state.channelRows];
      }
      if (sql.includes("INSERT INTO channel_rules")) {
        state.channelRows.push({
          rule_uid: params[1],
          channel: params[2],
          promise_level: params[3],
          rule_version: params[4],
          cta_strength: params[5],
          forbidden_terms_json: params[6],
          required_disclaimers_json: params[7],
          status: params[8]
        });
        return [{ insertId: state.channelRows.length }];
      }
      if (sql.includes("SELECT") && sql.includes("FROM asset_files") && sql.includes("asset_uid") && sql.includes("storage_relative_path")) {
        const asset = state.assets.get(params.at(-1));
        return [asset ? [{
          id: asset.id,
          asset_uid: asset.assetUid,
          storage_scope: asset.storageScope,
          asset_kind: asset.assetKind,
          file_name: asset.fileName,
          mime_type: asset.mimeType,
          size_bytes: asset.sizeBytes,
          storage_relative_path: asset.relativePath,
          width: asset.width,
          height: asset.height,
          duration_sec: asset.durationSec,
          probe_json: asset.probe,
          status: asset.status,
          storage_provider: asset.storageProvider,
          storage_bucket: asset.storageBucket,
          storage_key: asset.storageKey,
          storage_url: asset.storageUrl,
          created_at: asset.createdAt,
          updated_at: asset.updatedAt
        }] : []];
      }
      if (sql.includes("SELECT id FROM asset_files") && sql.includes("asset_uid")) {
        const asset = state.assets.get(params.at(-1));
        return [asset ? [{ id: asset.id }] : []];
      }
      if (sql.includes("INSERT INTO asset_files")) {
        const assetUid = params[0];
        const existing = state.assets.get(assetUid);
        state.assets.set(assetUid, {
          id: existing?.id ?? state.nextAssetId++,
          assetUid,
          storageScope: params[3],
          assetKind: params[4],
          fileName: params[5],
          mimeType: params[6],
          sizeBytes: params[7],
          relativePath: params[8],
          width: params[9],
          height: params[10],
          durationSec: params[11],
          probe: params[12],
          status: params[13],
          storageProvider: params[14] ?? null,
          storageBucket: params[15] ?? null,
          storageKey: params[16] ?? null,
          storageUrl: params[17] ?? null,
          storageSyncedAt: params[18] ?? null,
          createdAt: "2026-06-18 00:00:00.000",
          updatedAt: "2026-06-18 00:00:00.000"
        });
        return [{ insertId: state.assets.get(assetUid).id }];
      }
      if (sql.includes("SELECT request_hash, response_json, status") && sql.includes("FROM idempotency_keys")) {
        const key = `${params[0]}|${params[1]}|${params[2]}|${Buffer.from(params[3]).toString("hex")}`;
        const record = state.idempotency.get(key);
        return [record ? [{
          request_hash: record.requestHash,
          response_json: record.responseJson,
          status: record.status
        }] : []];
      }
      if (sql.includes("INSERT INTO idempotency_keys")) {
        const key = `${params[0]}|${params[1]}|${params[2]}|${Buffer.from(params[3]).toString("hex")}`;
        state.idempotency.set(key, {
          requestHash: params[4],
          resourceType: params[5],
          resourceId: params[6],
          responseJson: params[7],
          status: "succeeded",
          expiresAt: params[8]
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("SELECT id FROM reference_videos") && sql.includes("reference_video_uid")) {
        const reference = state.referenceVideos.get(params.at(-1));
        return [reference ? [{ id: reference.id }] : []];
      }
      if (sql.includes("INSERT INTO reference_videos")) {
        const referenceVideoId = params[0];
        const existing = state.referenceVideos.get(referenceVideoId);
        state.referenceVideos.set(referenceVideoId, {
          id: existing?.id ?? state.nextReferenceVideoId++,
          referenceVideoId,
          assetFileId: params[3],
          status: params[4],
          durationSec: params[5],
          width: params[6],
          height: params[7],
          ratio: params[8],
          canExtractFrame: params[9],
          issuesJson: params[10],
          probe: params[11]
        });
        return [{ insertId: state.referenceVideos.get(referenceVideoId).id }];
      }
      if (sql.includes("FROM reference_videos rv")) {
        const reference = state.referenceVideos.get(params[0]);
        if (!reference) return [[]];
        const asset = [...state.assets.values()].find((item) => item.id === reference.assetFileId)
          || state.assets.get(`asset_${reference.referenceVideoId}`)
          || {};
        const probe = JSON.parse(reference.probe || "{}");
        return [[{
          reference_video_uid: reference.referenceVideoId,
          status: reference.status,
          duration_sec: reference.durationSec ?? probe.durationSec ?? 15,
          width: reference.width ?? probe.width ?? 720,
          height: reference.height ?? probe.height ?? 1280,
          ratio: reference.ratio || probe.ratio || "9:16",
          can_extract_frame: reference.canExtractFrame ?? (probe.canExtractFrame ? 1 : 0),
          issues_json: reference.issuesJson || JSON.stringify(probe.issues || []),
          probe_json: reference.probe,
          file_name: asset.fileName || probe.fileName || "demo.mp4",
          mime_type: asset.mimeType || probe.mimeType || "video/mp4",
          size_bytes: asset.sizeBytes ?? probe.sizeBytes ?? 5,
          storage_relative_path: asset.relativePath || probe.storedPath,
          storage_key: asset.storageKey,
          storage_url: asset.storageUrl
        }]];
      }
      if (sql.includes("INSERT INTO video_decompositions")) {
        const reference = [...state.referenceVideos.values()].find((item) => item.id === params[0]);
        const referenceVideoId = reference?.referenceVideoId || params[0];
        state.decompositions.set(referenceVideoId, {
          id: state.nextDecompositionId++,
          referenceVideoId,
          schemaVersion: params[1],
          status: params[2],
          decomposition: params[3],
          missingFields: params[4]
        });
        return [{ insertId: state.decompositions.get(referenceVideoId).id }];
      }
      if (sql.includes("FROM video_decompositions vd")) {
        const decomposition = state.decompositions.get(params[0]);
        return [decomposition ? [{
          schema_version: decomposition.schemaVersion,
          status: decomposition.status,
          decomposition_json: decomposition.decomposition,
          missing_fields_json: decomposition.missingFields
        }] : []];
      }
      if (sql.includes("INSERT INTO work_estimates")) {
        const estimateUid = params[0];
        const existing = state.estimates.get(estimateUid);
        state.estimates.set(estimateUid, {
          id: existing?.id ?? state.nextEstimateId++,
          estimateUid,
          estimateType: params[1],
          referenceVideoId: params[5],
          sourceAssetFileId: params[6],
          requestHash: params[7],
          request: params[8],
          estimate: params[9],
          tokenHash: params[10],
          expiresAt: params[11],
          status: params[12]
        });
        return [{ insertId: state.estimates.get(estimateUid).id }];
      }
      if (sql.includes("INSERT INTO remix_regions")) {
        const region = {
          run_id: params[0],
          region_uid: params[1],
          region_type: params[2],
          label: params[3],
          bbox_x: params[4],
          bbox_y: params[5],
          bbox_width: params[6],
          bbox_height: params[7],
          description_text: params[8]
        };
        state.remixRegionsByRunId.set(params[0], [
          ...(state.remixRegionsByRunId.get(params[0]) || []).filter((item) => item.region_uid !== region.region_uid),
          region
        ]);
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("FROM workflow_runs wr") && sql.includes("LEFT JOIN asset_files af ON af.id = wr.source_asset_file_id")) {
        const runUid = params[1];
        const runId = state.runs.get(runUid);
        const run = state.runRows.get(runId);
        if (!run) return [[]];
        const source = [...state.assets.values()].find((asset) => asset.id === run.source_asset_file_id) || {};
        return [[{
          id: run.id,
          run_uid: run.run_uid,
          run_type: run.run_type,
          status: run.status,
          request_json: run.request_json,
          capability_json: run.capability_json,
          qc_summary_json: run.qc_summary_json,
          stop_reason: run.stop_reason,
          operation_type: run.operation_type,
          target_channel: run.target_channel,
          template_snapshot_json: run.template_snapshot_json,
          started_at: run.started_at,
          finished_at: run.finished_at,
          created_at: run.created_at,
          updated_at: run.updated_at,
          source_asset_uid: source.assetUid,
          source_file_name: source.fileName,
          source_mime_type: source.mimeType,
          source_size_bytes: source.sizeBytes,
          source_storage_relative_path: source.relativePath,
          source_width: source.width,
          source_height: source.height,
          source_duration_sec: source.durationSec,
          source_probe_json: source.probe,
          source_asset_status: source.status,
          source_storage_key: source.storageKey,
          source_storage_url: source.storageUrl,
          source_created_at: source.createdAt,
          source_updated_at: source.updatedAt
        }]];
      }
      if (sql.includes("FROM workflow_runs wr") && sql.includes("LEFT JOIN work_estimates we ON we.id = wr.estimate_id")) {
        const runUid = params[1];
        const runId = state.runs.get(runUid);
        const run = state.runRows.get(runId);
        if (!run) return [[]];
        const estimate = [...state.estimates.values()].find((item) => item.id === run.estimate_id) || {};
        const reference = [...state.referenceVideos.values()].find((item) => item.id === run.reference_video_id) || {};
        const refAsset = [...state.assets.values()].find((item) => item.id === reference.assetFileId) || {};
        const decomposition = reference.referenceVideoId ? state.decompositions.get(reference.referenceVideoId) : null;
        return [[{
          id: run.id,
          run_uid: run.run_uid,
          run_type: run.run_type,
          status: run.status,
          request_json: run.request_json,
          capability_json: run.capability_json,
          qc_summary_json: run.qc_summary_json,
          stop_reason: run.stop_reason,
          operation_type: run.operation_type,
          target_channel: run.target_channel,
          template_snapshot_json: run.template_snapshot_json,
          started_at: run.started_at,
          finished_at: run.finished_at,
          created_at: run.created_at,
          updated_at: run.updated_at,
          estimate_uid: estimate.estimateUid,
          estimate_request_json: estimate.request,
          estimate_json: estimate.estimate,
          reference_video_uid: reference.referenceVideoId,
          reference_status: reference.status,
          reference_duration_sec: reference.durationSec,
          reference_width: reference.width,
          reference_height: reference.height,
          reference_ratio: reference.ratio,
          reference_can_extract_frame: reference.canExtractFrame,
          reference_issues_json: reference.issuesJson,
          reference_probe_json: reference.probe,
          reference_file_name: refAsset.fileName,
          reference_mime_type: refAsset.mimeType,
          reference_size_bytes: refAsset.sizeBytes,
          reference_storage_relative_path: refAsset.relativePath,
          reference_storage_key: refAsset.storageKey,
          reference_storage_url: refAsset.storageUrl,
          decomposition_json: decomposition?.decomposition
        }]];
      }
      if (sql.includes("FROM remix_regions")) {
        return [state.remixRegionsByRunId.get(params[0]) || []];
      }
      if (sql.includes("FROM generation_scripts gs") && sql.includes("script_asset.storage_relative_path")) {
        const rows = [...state.scripts.values()]
          .filter((script) => script.runId === params[0])
          .sort((a, b) => (a.variantIndex - b.variantIndex) || (a.segmentIndex - b.segmentIndex) || (a.id - b.id))
          .map((script) => {
            const scriptAsset = [...state.assets.values()].find((item) => item.id === script.scriptAssetFileId) || {};
            const promptAsset = [...state.assets.values()].find((item) => item.id === script.promptAssetFileId) || {};
            return {
              script_uid: script.scriptUid,
              variant_index: script.variantIndex,
              segment_index: script.segmentIndex,
              duration_sec: script.durationSec,
              hook_text: script.hookText,
              body_text: script.bodyText,
              cta_text: script.ctaText,
              ending_text: script.endingText,
              reward_expression: script.rewardExpression,
              script_path: scriptAsset.relativePath,
              script_probe_json: scriptAsset.probe,
              prompt_path: promptAsset.relativePath
            };
          });
        return [rows];
      }
      if (sql.includes("FROM workflow_tasks") && sql.includes("ORDER BY id ASC")
        || sql.includes("FROM workflow_tasks wt") && sql.includes("ORDER BY wt.id ASC")) {
        const rows = (state.taskRowsByRunId.get(params[0]) || []).map((task) => {
          const promptAsset = [...state.assets.values()].find((item) => item.id === task.prompt_asset_file_id) || {};
          const outputAsset = [...state.assets.values()].find((item) => item.id === task.output_asset_file_id) || {};
          const script = [...state.scripts.values()].find((item) => item.id === task.script_id) || {};
          return {
            ...task,
            script_uid: script.scriptUid,
            prompt_storage_key: promptAsset.storageKey,
            prompt_storage_url: promptAsset.storageUrl,
            output_storage_key: outputAsset.storageKey,
            output_storage_url: outputAsset.storageUrl
          };
        });
        return [rows];
      }
      if (sql.includes("FROM workflow_outputs wo") && sql.includes("WHERE wo.run_id")) {
        const rows = (state.outputRowsByRunId.get(params[0]) || []).map((output) => {
          const asset = [...state.assets.values()].find((item) => item.id === output.asset_file_id) || {};
          const firstTask = (state.taskRowsByRunId.get(params[0]) || [])[0] || {};
          const promptAsset = [...state.assets.values()].find((item) => item.id === firstTask.prompt_asset_file_id) || {};
          const qcReport = [...(state.qcReports?.values?.() || [])].find((item) => item.output_id === output.id) || {};
          const qcAsset = [...state.assets.values()].find((item) => item.id === qcReport.report_asset_file_id) || {};
          const script = [...state.scripts.values()].find((item) => item.id === output.script_id) || {};
          return {
            output_uid: output.output_uid,
            source_type: output.source_type,
            output_kind: output.output_kind,
            duration_sec: output.duration_sec,
            qc_status: output.qc_status,
            download_eligible: output.download_eligible,
            visual_preview_required: output.visual_preview_required,
            preview_confirmed: output.preview_confirmed,
            preview_confirmed_at: output.preview_confirmed_at,
            script_uid: script.scriptUid,
            storage_relative_path: asset.relativePath,
            output_probe_json: asset.probe,
            storage_key: asset.storageKey,
            storage_url: asset.storageUrl,
            prompt_path: promptAsset.relativePath,
            prompt_storage_key: promptAsset.storageKey,
            prompt_storage_url: promptAsset.storageUrl,
            qc_report_path: qcAsset.relativePath,
            qc_report_storage_key: qcAsset.storageKey,
            qc_report_storage_url: qcAsset.storageUrl
          };
        });
        return [rows];
      }
      if (sql.includes("FROM stitch_reports sr")) {
        const outputIds = new Set((state.outputRowsByRunId.get(params[0]) || []).map((output) => output.id));
        const rows = [...(state.stitchReports?.values?.() || [])]
          .filter((report) => outputIds.has(report.output_id))
          .map((report) => {
            const output = [...state.outputs.values()].find((item) => item.id === report.output_id) || {};
            const asset = [...state.assets.values()].find((item) => item.id === report.report_asset_file_id) || {};
            return {
              output_uid: output.output_uid,
              status: report.status,
              stitch_tool: report.stitch_tool,
              segment_output_ids_json: report.segment_output_ids_json,
              command_summary: report.command_summary,
              error_code: report.error_code,
              error_message: report.error_message,
              created_at: report.created_at,
              report_path: asset.relativePath,
              report_storage_key: asset.storageKey,
              report_storage_url: asset.storageUrl
            };
          });
        return [rows];
      }
      if (sql.includes("SELECT run_uid") && sql.includes("FROM workflow_runs") && sql.includes("run_type = 'remix'")) {
        const projectId = params[0];
        const userId = params[1];
        const row = [...state.runRows.values()].find((run) => {
          return run.project_id === projectId
            && run.user_id === userId
            && run.run_type === "remix"
            && ["queued", "running", "qc", "preview_required"].includes(run.status);
        });
        return [row ? [{ run_uid: row.run_uid }] : []];
      }
      if (sql.includes("SELECT run_uid, status") && sql.includes("FROM workflow_runs") && sql.includes("run_type = 'pipeline'")) {
        const projectId = params[0];
        const userId = params[1];
        const row = [...state.runRows.values()].find((run) => {
          return run.project_id === projectId
            && run.user_id === userId
            && run.run_type === "pipeline"
            && ["checking", "queued", "running", "stitching", "qc"].includes(run.status);
        });
        return [row ? [{ run_uid: row.run_uid, status: row.status }] : []];
      }
      if (sql.includes("FROM state_transition_events")) {
        const runUid = params[0];
        const runId = state.runs.get(runUid);
        const taskUids = new Set((state.taskRowsByRunId.get(runId) || []).map((task) => task.task_uid));
        return [state.stateTransitionEvents.filter((event) => event.entity_uid === runUid || taskUids.has(event.entity_uid))];
      }
      if (sql.includes("FROM workflow_outputs wo") && sql.includes("JOIN workflow_runs wr")) {
        const rows = [];
        for (const output of state.outputs.values()) {
          const run = state.runRows.get(output.run_id);
          if (!run) continue;
          if (run.project_id !== params[0] || run.user_id !== params[1]) continue;
          if (sql.includes("wr.run_type = 'remix'") && run.run_type !== "remix") continue;
          if (sql.includes("wr.run_type = 'pipeline'") && run.run_type !== "pipeline") continue;
          if (sql.includes("wr.run_type IN ('pipeline', 'remix')") && !["pipeline", "remix"].includes(run.run_type)) continue;
          if (params.includes(run.run_uid) === false && (sql.includes("wr.run_uid = ?"))) continue;
          if (sql.includes("wo.download_eligible = 1") && !(output.download_eligible === 1 || output.download_eligible === true)) continue;
          if (sql.includes("wo.qc_status = ?") && !params.includes(output.qc_status)) continue;
          if (sql.includes("wo.output_kind = ?") && !params.includes(output.output_kind)) continue;
          const asset = [...state.assets.values()].find((item) => item.id === output.asset_file_id) || {};
          rows.push({
            id: output.id,
            run_uid: run.run_uid,
            run_type: run.run_type,
            run_status: run.status,
            target_channel: run.target_channel,
            template_snapshot_json: run.template_snapshot_json,
            run_created_at: run.created_at,
            run_updated_at: run.updated_at,
            output_uid: output.output_uid,
            source_type: output.source_type,
            output_kind: output.output_kind,
            duration_sec: output.duration_sec,
            qc_status: output.qc_status,
            download_eligible: output.download_eligible,
            visual_preview_required: output.visual_preview_required,
            preview_confirmed: output.preview_confirmed,
            storage_relative_path: asset.relativePath,
            storage_key: asset.storageKey,
            storage_url: asset.storageUrl
          });
        }
        rows.sort((left, right) => {
          const time = String(right.run_created_at || "").localeCompare(String(left.run_created_at || ""));
          if (time) return time;
          return Number(right.id || 0) - Number(left.id || 0);
        });
        if (/SELECT\s+COUNT\(\*\)\s+AS\s+total/i.test(sql)) {
          return [[{ total: rows.length }]];
        }
        if (sql.includes("GROUP BY wo.qc_status, wo.output_kind, wo.download_eligible")) {
          const grouped = new Map();
          for (const row of rows) {
            const key = `${row.qc_status}|${row.output_kind}|${row.download_eligible ? 1 : 0}`;
            const existing = grouped.get(key) || {
              qc_status: row.qc_status,
              output_kind: row.output_kind,
              download_eligible: row.download_eligible ? 1 : 0,
              count: 0
            };
            existing.count += 1;
            grouped.set(key, existing);
          }
          return [[...grouped.values()]];
        }
        if (sql.includes("LIMIT ? OFFSET ?")) {
          const limit = Number(params.at(-2));
          const offset = Number(params.at(-1));
          return [rows.slice(offset, offset + limit)];
        }
        return [rows];
      }
      if (sql.includes("FROM work_estimates we")) {
        const estimate = state.estimates.get(params[0]);
        const source = [...state.assets.values()].find((asset) => asset.id === estimate?.sourceAssetFileId) || {};
        const reference = [...state.referenceVideos.values()].find((item) => item.id === estimate?.referenceVideoId) || null;
        const referenceProbe = reference?.probe ? JSON.parse(reference.probe) : {};
        const decomposition = reference
          ? state.decompositions.get(reference.referenceVideoId)
          : null;
        return [estimate ? [{
          estimate_uid: estimate.estimateUid,
          estimate_type: estimate.estimateType,
          request_hash: estimate.requestHash,
          request_json: estimate.request,
          estimate_json: estimate.estimate,
          confirmation_expires_at: estimate.expiresAt,
          token_hash_available: Boolean(estimate.tokenHash),
          status: estimate.status,
          template_uid: "tpl_cash_reward_us_en_001",
          template_version_uid: "tplv_cash_reward_us_en_001_0001",
          template_version_number: 1,
          template_status: "active",
          template_draft_json: JSON.stringify({
            displayName: "Cash Reward US EN",
            productName: "Lucky Cash",
            cta: "Install today",
            ending: "Claim your bonus today",
            currencySymbol: "$",
            language: "en-US",
            regions: ["US"],
            targetChannels: ["meta_ads"],
            defaultOutputRatio: "9:16",
            defaultDurationSec: 15,
            promiseLevel: "strong_conversion"
          }),
          reference_video_uid: reference?.referenceVideoId,
          reference_status: reference?.status,
          reference_probe_json: reference?.probe || null,
          source_asset_uid: source.assetUid,
          source_file_name: source.fileName,
          source_mime_type: source.mimeType,
          source_size_bytes: source.sizeBytes,
          source_storage_relative_path: source.relativePath,
          source_width: source.width,
          source_height: source.height,
          source_duration_sec: source.durationSec,
          source_probe_json: source.probe,
          source_asset_status: source.status,
          source_storage_key: source.storageKey,
          source_storage_url: source.storageUrl,
          source_created_at: source.createdAt,
          source_updated_at: source.updatedAt,
          decomposition_json: decomposition?.decomposition || JSON.stringify({
            referenceVideoId: reference?.referenceVideoId || referenceProbe.referenceVideoId || "ref_20260618_001",
            schemaVersion: "video_decomposition.v1",
            scene: "Phone reward app",
            subject: "Phone",
            action: "Tap",
            camera: "Close-up",
            lighting: "Bright",
            style: "UGC",
            quality: "HD",
            hook: "Earn rewards",
            missingFields: []
          })
        }] : []];
      }
      if (sql.includes("FROM work_estimates") && sql.includes("confirmation_token_hash")) {
        const estimate = state.estimates.get(params[0]);
        const hashMatches = estimate?.tokenHash && Buffer.compare(Buffer.from(estimate.tokenHash), Buffer.from(params[2])) === 0;
        return [estimate && hashMatches ? [{ id: estimate.id }] : []];
      }
      if (sql.includes("SELECT id FROM download_packages") && sql.includes("package_uid")) {
        return [[{ id: 1301 }]];
      }
      if (sql.includes("INSERT INTO scheduler_jobs")) {
        const jobUid = params[0];
        const jobType = sql.includes("'upstream_poll'") ? "upstream_poll" : "task_retry";
        const payloadIndex = jobType === "upstream_poll" ? 2 : 3;
        const existing = state.schedulerJobs.get(jobUid);
        state.schedulerJobs.set(jobUid, {
          id: existing?.id ?? state.nextSchedulerJobId++,
          jobUid,
          jobType,
          status: "pending",
          runUid: [...state.runs.entries()].find(([, id]) => id === params[1])?.[0] || "",
          taskUid: jobType === "upstream_poll"
            ? ""
            : [...state.tasks.entries()].find(([, task]) => task.id === params[2])?.[0] || "",
          payload: JSON.parse(params[payloadIndex]),
          priority: jobType === "upstream_poll" ? Number(params[3] || 0) : 0,
          attempts: 0,
          maxAttempts: jobType === "upstream_poll" ? 1000 : 3,
          lockedBy: null
        });
        return [{ affectedRows: 1 }];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("status = 'canceled'")) {
        const job = state.schedulerJobs.get(params[0]);
        if (job) job.status = "canceled";
        return [{ affectedRows: job ? 1 : 0 }];
      }
      if (sql.includes("UPDATE scheduler_jobs") && sql.includes("status = 'pending'") && sql.includes("run_after = ?")) {
        const job = [...state.schedulerJobs.values()].find((item) => item.id === params.at(-2));
        if (job) {
          job.status = "pending";
          job.runAfter = params[0];
          job.lockedBy = null;
        }
        return [{ affectedRows: job ? 1 : 0 }];
      }
      return [{ affectedRows: 1 }];
    }
  };

  return {
    calls,
    state,
    async getConnection() {
      return conn;
    },
    async end() {
      calls.push({ sql: "END", params: [] });
    }
  };
}

export function context() {
  return {
    userProjectRoot: "C:/project/users/alice/current",
    sharedProjectRoot: "C:/project/current",
    userId: "alice",
    user: { userId: "alice", username: "alice", role: "user", isAdmin: false }
  };
}
