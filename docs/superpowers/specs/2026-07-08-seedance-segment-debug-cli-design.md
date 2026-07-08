# Seedance Segment Debug CLI Design

## Goal

Build a local-only debugging CLI that turns one reference video into a structured Seedance segment plan without changing the wangzhuan UI, background-job state machine, or production Seedance submission path. The CLI is for fast prompt iteration: inspect the source video's story structure, generate Seedance-ready slice durations, and write editable prompt files.

## Non-Goals

- Do not add UI controls or modify `public/wangzhuan-v2.html` / `public/wangzhuan-v2.js`.
- Do not create database records, batches, generation tasks, or workflow runs.
- Do not submit Seedance jobs.
- Do not replace the existing production plan-confirmation flow.
- Do not mechanically split every output into fixed 15-second slices.

## Entry Point

Add a standalone Node ESM CLI under `scripts/`, for example:

```bash
node scripts/wangzhuan-seedance-segment-debug.mjs \
  --video /absolute/path/reference.mp4 \
  --out tmp/seedance-segment-debug/run_001 \
  --language pt-BR \
  --region BR \
  --product-name "Drama Gold" \
  --currency-symbol "R$"
```

Required input:

- `--video`: local reference video path.

Optional inputs:

- `--out`: output directory. If omitted, create a timestamped directory under `tmp/seedance-segment-debug/`.
- `--language`: target language for voiceover, subtitles, and prompt context.
- `--region`: target market context.
- `--product-name`: product/app name for generated recommendation scenes.
- `--currency-symbol`: local currency hint.
- `--truth-rules-json`: optional JSON file containing allowed exact claims. Exact amounts, thresholds, arrival times, or guaranteed cashout claims may only appear when this file explicitly allows them.
- `--min-slice-sec`: default `8`.
- `--max-slice-sec`: default `15`.

## Architecture

The CLI is a thin orchestration layer over existing wangzhuan video-analysis and prompt rules.

1. Video intake and probes
   - Validate the local video path.
   - Probe duration and metadata using existing reference-video utilities where practical.
   - Extract representative frames using the existing frame extraction approach.
   - Run scene detection only as supporting evidence.

2. Story segmentation
   - Ask the LLM to infer story segments from extracted frames, video summary evidence, and optional scene-cut hints.
   - Scene detection must not be the source of truth for segment count. The LLM chooses story segments based on narrative function.
   - Each story segment contains the seven existing analysis dimensions: `scene`, `subject`, `action`, `camera`, `lighting`, `style`, `quality`.
   - Each story segment also contains `coreHook`, `explosivePoint`, and `moneyEffects`.

3. Seedance slice planning
   - Convert story segments into Seedance slices.
   - If a story segment is `<= maxSliceSec`, keep it as one slice.
   - If a story segment is `> maxSliceSec`, split it into two Seedance slices while preserving the same story segment identity.
   - Split durations may be `8-15s` by default. Example: a 16s story segment may become `8s + 8s`.
   - Do not mechanically produce `15s + remainder` unless that is the best fit for the story boundary.
   - Keep `durationSec` deterministic and directly usable as a later Seedance call parameter.

4. Prompt generation
   - Generate one Seedance prompt per Seedance slice.
   - Use the existing Seedance planning principles: reuse source structure, pacing, shot function, camera language, and conversion logic; redesign people, scenes, clothing, and props for output diversity.
   - Preserve the existing wangzhuan safety boundary: money visual motifs are allowed, but exact amount/threshold/arrival-time claims require `truthRules`.
   - Include high-impact wangzhuan visual effects when relevant: top withdrawal amount increasing, real-cash withdrawal sound cue, coin burst, cash rain, reward numbers rising, withdrawal success, arrival animation, and withdrawal record visuals without invented exact amounts.
   - Keep no burned subtitles in Seedance video prompts. Subtitle text belongs in `subtitleWorkflow.subtitleScript` for post-processing.

## Output Contract

The CLI writes three primary files.

### `analysis.json`

Contains source-video facts and story-segment analysis:

```json
{
  "sourceVideo": {
    "path": "/absolute/path/reference.mp4",
    "durationSec": 42.4,
    "sceneCutsSec": [3.2, 10.8, 22.5]
  },
  "storySegments": [
    {
      "storySegmentIndex": 1,
      "startSec": 0,
      "endSec": 12.4,
      "durationSec": 12.4,
      "scene": "...",
      "subject": "...",
      "action": "...",
      "camera": "...",
      "lighting": "...",
      "style": "...",
      "quality": "...",
      "coreHook": "...",
      "explosivePoint": "...",
      "moneyEffects": ["reward_number_growth", "coin_burst"]
    }
  ]
}
```

### `seedance-plan.json`

Contains Seedance-ready slices:

```json
{
  "slices": [
    {
      "storySegmentIndex": 1,
      "seedanceSliceIndex": 1,
      "segmentRole": "hook_slice",
      "startSec": 0,
      "endSec": 12,
      "durationSec": 12,
      "scene": "...",
      "subject": "...",
      "action": "...",
      "camera": "...",
      "lighting": "...",
      "style": "...",
      "quality": "...",
      "coreHook": "...",
      "explosivePoint": "...",
      "moneyEffects": ["reward_number_growth", "coin_burst"],
      "imagePrompt": "...",
      "seedancePrompt": "...",
      "negativePrompt": "No competitor logo, no watermark, no burned subtitles, no invented exact payout amount.",
      "subtitleWorkflow": {
        "burnedInSubtitles": false,
        "postSubtitleRequired": true,
        "provider": "pixel_tech",
        "subtitleScript": ["..."]
      }
    }
  ]
}
```

### `seedance-prompts.md`

Human-editable prompt preview grouped by story segment and Seedance slice. Each slice section includes:

- Source timing and planned `durationSec`.
- Seven-dimension analysis.
- Core hook and explosive point.
- Money effects.
- `imagePrompt`.
- `seedancePrompt`.
- `negativePrompt`.
- Subtitle script.

## Error Handling

- Missing video path: fail with a clear usage message.
- Probe or frame extraction failure: fail before calling the LLM.
- Scene detection failure: continue with empty `sceneCutsSec` and mark a warning because scene cuts are only references.
- LLM JSON parse failure: write the raw response to the output directory and fail with the parse error.
- Invalid slice duration: normalize into `8-15s` where possible, otherwise fail with the offending segment index.
- Missing exact-claim permission: strip or reject exact money claims unless `truthRules` allows them.

## Testing

Add focused tests around pure helpers rather than full model calls:

- CLI argument normalization.
- Story segment to Seedance slice splitting, including `16s -> 8s + 8s`.
- Preservation of seven dimensions in output slices.
- Money-effect safety behavior when `truthRules` is absent.
- Markdown prompt rendering includes duration, seven dimensions, prompt, and subtitle workflow.

Manual smoke test:

```bash
node scripts/wangzhuan-seedance-segment-debug.mjs \
  --video /absolute/path/reference.mp4 \
  --out tmp/seedance-segment-debug/smoke \
  --language pt-BR \
  --region BR
```

Expected result:

- `analysis.json` exists.
- `seedance-plan.json` exists and each slice has deterministic `durationSec`.
- `seedance-prompts.md` exists and is usable for prompt review.
- No production batch, DB row, or Seedance task is created.

## Open Decisions Resolved

- Use a standalone CLI, not UI or production API integration.
- Input is the original video file, not a prewritten analysis report.
- Use seven dimensions: `scene`, `subject`, `action`, `camera`, `lighting`, `style`, `quality`.
- LLM determines story segments from frames and summary evidence; scene detection is only a reference.
- Slices default to `8-15s`; story segments longer than 15s may split into two non-fixed slices.
- Output both machine-readable JSON and human-editable Seedance prompts.
