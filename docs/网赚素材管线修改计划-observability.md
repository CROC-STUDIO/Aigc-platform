# 网赚素材管线修改计划观测记录

> 用于记录《网赚素材管线修改计划》各 Sprint 上线前后的指标。当前先建立 Sprint 1 所需表格，具体数值由回归批次和线上 telemetry 补齐。

| 指标 | Baseline | Sprint 1 后 | Sprint 2 后 | Sprint 3 后 | Sprint 4 后 |
|---|---:|---:|---:|---:|---:|
| 单条素材平均 LLM 请求 prompt 字符数 | 40364.5 chars（full） | 15794.5 chars（compact，-60.87%） |  |  |  |
| 单条素材 token 成本 | 待采集 | 待采集 |  |  |  |
| 从确认到全部提交完成的耗时 | 待采集 | 待采集 |  |  |  |
| batch 走完全流程的平均耗时 | 待采集 | 待采集 |  |  |  |
| QC pass 率 | 待采集 | 待采集 |  |  |  |
| stitch 失败率 | 待采集 | 待采集 |  |  |  |
| 上游状态查询 P95 耗时 | 待采集 | 待采集 |  |  |  |
| plan_cache_hit 比例 | 待采集 | 待采集 |  |  |  |

## Sprint 1 采集方式

- `plan_prompt_built`：记录 plan prompt 字符数，用于 full/compact 对比。
- `plan_prompt_compact`：记录 compact 灰度命中情况。
- `plan_cache_hit`：记录方案缓存命中。
- `plan_batch_fallback`：记录 branch 批量预案失败后的 fallback。
- `scripts/plan-prompt-ab.mjs --batch-json <file>`：离线输出 full/compact 字符数 CSV。
- `scripts/plan-prompt-ab.mjs --batch-json <file> --invoke-llm --runs 3`：真实调用 LLM 做 full/compact 质量 A/B；默认不传 `--invoke-llm` 时只 dry-run prompt 长度，避免误消耗上游额度。
- `scripts/plan-prompt-ab.mjs --batch-json <file> --invoke-llm --runs 1 --max-pairs 1`：真实 LLM 小样本冒烟，只跑 1 个切片的 full/compact，适合正式 A/B 前先确认 API 与 CSV 字段。
- `scripts/sprint1-audit.mjs --out tmp/sprint1/sprint1-audit.json`：汇总 Sprint 1 本地实现与验收证据；若缺 A/B/C 真实媒体批次会以退出码 2 标记为未完全闭环。

## Sprint 1 离线 A/B 记录

| 日期 | 样本批次 | 模式 | 平均 prompt 字符数 | 降幅 | 产物 |
|---|---|---|---:|---:|---|
| 2026-07-10 | `wzb_20260709020324_1d51` | full | 40364.5 | - | `tmp/sprint1/plan-prompt-ab-wzb_20260709020324_1d51.csv` |
| 2026-07-10 | `wzb_20260709020324_1d51` | compact | 15794.5 | 60.87% | `tmp/sprint1/plan-prompt-ab-wzb_20260709020324_1d51.csv` |

## Sprint 1 本地验证记录

| 日期 | 验证项 | 命令/证据 | 结果 |
|---|---|---|---|
| 2026-07-10 | 单测全量回归 | `npm test` | 315 pass / 0 fail |
| 2026-07-10 | 4.2 prompt 瘦身 dry-run | `node scripts/plan-prompt-ab.mjs --batch-json 批处理记录/网赚管线/batches/wzb_20260709020324_1d51/batch.json --out tmp/sprint1/plan-prompt-ab-wzb_20260709020324_1d51.csv` | compact 平均字符数下降 60.87% |
| 2026-07-10 | 4.2 prompt 真实 LLM A/B | `node scripts/plan-prompt-ab.mjs --batch-json <file> --invoke-llm --runs 3` | 待执行；涉及真实 LLM 调用与主观质量判断 |
| 2026-07-10 | 4.4 轮询并发限制 | `tests/wangzhuan/upstream-poll-state.test.mjs` | 覆盖默认并发 3、配置上限和结果顺序 |
| 2026-07-10 | 4.5 variant 并发限制 | `tests/wangzhuan/multi-slice-plan.test.mjs` | 覆盖 variant 并发 2、输出顺序和 taskId 稳定性 |
| 2026-07-10 | 4.7 concat + overlay 单次路径 | `tests/wangzhuan/stitch-single-encode.test.mjs` | ffmpeg 产物可 probe，单路径测试通过 |
| 2026-07-10 | Sprint 1 本地审计 | `node scripts/sprint1-audit.mjs --out tmp/sprint1/sprint1-audit.json` | 8 项本地通过；剩余 `abc_real_media_regression_batches` 缺真实批次 |

## 回归批次

| 编号 | 场景 | batchId | 验收状态 |
|---|---|---|---|
| A | 30s + CTA/ending 尾图 | 待补 | 待验证 |
| B | 30s 无尾图 | 待补 | 待验证 |
| C | 15s + disclaimer overlay | 待补 | 待验证 |

当前本地 `批处理记录/网赚管线/batches/` 可见批次主要是 56.38s 多切片批次，未发现符合 A/B/C 定义的 15s 或 30s 回归批次；真实媒体端到端验收需要补充对应 batchId 或重新跑批次生成。
