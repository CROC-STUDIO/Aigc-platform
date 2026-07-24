#!/usr/bin/env python3
"""
Standalone video frame extraction + video understanding helper.

Usage examples:
  # Dry-run: inspect timestamps and request body without calling the model.
  python scripts/video_frame_understanding.py ./demo.mp4 --dry-run --output request.json

  # OpenAI-compatible chat/completions with scene-aware frames.
  VIDEO_LLM_API_KEY=xxx python scripts/video_frame_understanding.py ./demo.mp4 \
    --provider openai-compatible \
    --endpoint https://your-gateway.example.com/api/v1 \
    --model gpt-5.4 \
    --prompt "请分析这个视频的镜头、动作、字幕和可复用创意点，返回 JSON。"

  # Native Gemini API with a public video URL instead of frames.
  GEMINI_API_KEY=xxx python scripts/video_frame_understanding.py ./demo.mp4 \
    --provider gemini \
    --endpoint https://generativelanguage.googleapis.com/v1beta \
    --model gemini-2.5-pro \
    --video-url https://example.com/demo.mp4 \
    --prefer-video-url
"""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import re
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DEFAULT_SYSTEM_PROMPT = """你是严格的视频理解分析助手。
只基于输入的视频或抽帧内容分析，不要虚构不可见信息。
输出必须是一个合法 JSON 对象，不要使用 Markdown 代码块。"""

DEFAULT_USER_PROMPT = """请理解这个视频，按以下 JSON 结构输出：
{
  "summary": "一句话概括视频内容",
  "scenes": [
    {
      "start_sec": 0,
      "end_sec": 0,
      "visual": "画面内容",
      "action": "人物/物体动作",
      "camera": "镜头语言",
      "text": ["画面文字或字幕"],
      "audio_or_effect": "可见/可推断的音效或氛围",
      "reuse_points": ["可迁移到其他项目的创意点"]
    }
  ],
  "key_objects": ["主要人物、产品、Logo、道具"],
  "style": "视频风格",
  "risks": ["不确定或无法判断的信息"]
}"""


@dataclass(frozen=True)
class FrameSample:
    index: int
    timestamp_sec: float
    mime_type: str
    data_url: str
    path: str


def number_or_zero(value: Any) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return 0.0
    return number if number == number else 0.0


def round_timestamp_sec(value: float) -> float:
    return round(number_or_zero(value) + 1e-9, 2)


def clamp_timestamp_sec(duration_sec: float, value: float) -> float:
    duration = number_or_zero(duration_sec)
    if duration <= 0:
        return 0.0
    return round_timestamp_sec(min(max(0.0, number_or_zero(value)), max(0.0, duration - 0.1)))


def dedupe_sorted_timestamps(timestamps_sec: list[float]) -> list[float]:
    unique: list[float] = []
    for timestamp_sec in sorted(timestamps_sec):
        rounded = round_timestamp_sec(timestamp_sec)
        if not unique or abs(unique[-1] - rounded) >= 0.01:
            unique.append(rounded)
    return unique


def normalize_scene_cuts(duration_sec: float, scene_cuts_sec: list[float], min_gap_sec: float = 0.8) -> list[float]:
    duration = number_or_zero(duration_sec)
    if duration <= 0:
        return []
    max_timestamp = max(0.0, duration - 0.1)
    sorted_cuts = sorted(
        number_or_zero(value)
        for value in scene_cuts_sec
        if 0 < number_or_zero(value) < max_timestamp
    )
    normalized: list[float] = []
    for value in sorted_cuts:
        if not normalized or value - normalized[-1] >= min_gap_sec:
            normalized.append(round_timestamp_sec(value))
    return normalized


def build_scene_segments(duration_sec: float, scene_cuts_sec: list[float], min_gap_sec: float = 0.8) -> list[dict[str, float]]:
    duration = number_or_zero(duration_sec)
    if duration <= 0:
        return []
    boundaries = [0.0, *normalize_scene_cuts(duration, scene_cuts_sec, min_gap_sec), duration]
    segments: list[dict[str, float]] = []
    for index in range(len(boundaries) - 1):
        start_sec = boundaries[index]
        end_sec = boundaries[index + 1]
        if end_sec - start_sec <= 0.05:
            continue
        segments.append(
            {
                "index": float(index),
                "start_sec": round_timestamp_sec(start_sec),
                "end_sec": round_timestamp_sec(end_sec),
                "duration_sec": round_timestamp_sec(end_sec - start_sec),
            }
        )
    return segments


def merge_short_scene_segments(
    segments: list[dict[str, float]],
    short_scene_merge_threshold_sec: float = 1.5,
) -> list[dict[str, float]]:
    if not segments or short_scene_merge_threshold_sec <= 0:
        return segments
    merged: list[dict[str, float]] = []
    for segment in segments:
        if not merged:
            merged.append(dict(segment))
            continue
        previous = merged[-1]
        if segment["duration_sec"] < short_scene_merge_threshold_sec or previous["duration_sec"] < short_scene_merge_threshold_sec:
            previous["end_sec"] = segment["end_sec"]
            previous["duration_sec"] = round_timestamp_sec(previous["end_sec"] - previous["start_sec"])
            continue
        merged.append(dict(segment))
    if len(merged) > 1 and merged[-1]["duration_sec"] < short_scene_merge_threshold_sec:
        last = merged.pop()
        previous = merged[-1]
        previous["end_sec"] = last["end_sec"]
        previous["duration_sec"] = round_timestamp_sec(previous["end_sec"] - previous["start_sec"])
    return [{**segment, "index": float(index)} for index, segment in enumerate(merged)]


def scene_sample_budget(duration_sec: float, medium_scene_threshold_sec: float, long_scene_threshold_sec: float) -> int:
    if duration_sec > long_scene_threshold_sec:
        return 4
    if duration_sec >= medium_scene_threshold_sec:
        return 2
    return 1


def segment_sample_frames(
    duration_sec: float,
    segment: dict[str, float],
    medium_scene_threshold_sec: float = 6,
    long_scene_threshold_sec: float = 15,
) -> list[dict[str, float]]:
    if not segment or segment["duration_sec"] <= 0:
        return []
    budget = scene_sample_budget(segment["duration_sec"], medium_scene_threshold_sec, long_scene_threshold_sec)
    ratios = [0.2, 0.4, 0.6, 0.8] if budget >= 4 else ([1 / 3, 2 / 3] if budget == 2 else [0.5])
    samples: list[dict[str, float]] = []
    for ratio_index, ratio in enumerate(ratios):
        span = max(0.05, segment["end_sec"] - segment["start_sec"])
        timestamp_sec = clamp_timestamp_sec(duration_sec, segment["start_sec"] + span * ratio)
        samples.append(
            {
                "timestamp_sec": timestamp_sec,
                "segment_index": segment["index"],
                "segment_duration_sec": segment["duration_sec"],
                "priority": 3 if ratio_index == 0 else (1 if ratio_index == len(ratios) - 1 else 2),
                "order": float(ratio_index),
            }
        )
    return samples


def reduce_scene_aware_samples(
    samples: list[dict[str, float]],
    max_frames: int,
    forced_timestamps: list[float],
) -> list[float]:
    deduped: dict[str, dict[str, float]] = {}
    for sample in samples:
        key = str(round_timestamp_sec(sample["timestamp_sec"]))
        existing = deduped.get(key)
        if (
            existing is None
            or sample["priority"] > existing["priority"]
            or (
                sample["priority"] == existing["priority"]
                and sample["segment_duration_sec"] > existing["segment_duration_sec"]
            )
            or (
                sample["priority"] == existing["priority"]
                and sample["segment_duration_sec"] == existing["segment_duration_sec"]
                and sample["order"] < existing["order"]
            )
        ):
            deduped[key] = {**sample, "timestamp_sec": round_timestamp_sec(sample["timestamp_sec"])}
    normalized = sorted(deduped.values(), key=lambda sample: sample["timestamp_sec"])
    if len(normalized) <= max_frames:
        return [sample["timestamp_sec"] for sample in normalized]

    forced_keys = {str(round_timestamp_sec(value)) for value in forced_timestamps}
    forced = [sample for sample in normalized if str(sample["timestamp_sec"]) in forced_keys]
    primary_by_segment: dict[str, dict[str, float]] = {}
    for sample in normalized:
        if str(sample["timestamp_sec"]) in forced_keys:
            continue
        key = str(sample["segment_index"])
        existing = primary_by_segment.get(key)
        if (
            existing is None
            or sample["priority"] > existing["priority"]
            or (
                sample["priority"] == existing["priority"]
                and sample["segment_duration_sec"] > existing["segment_duration_sec"]
            )
            or (
                sample["priority"] == existing["priority"]
                and sample["segment_duration_sec"] == existing["segment_duration_sec"]
                and sample["order"] < existing["order"]
            )
        ):
            primary_by_segment[key] = sample

    retained = list(forced)
    retained.extend(
        sorted(primary_by_segment.values(), key=lambda sample: (-sample["segment_duration_sec"], sample["timestamp_sec"]))[
            : max(0, max_frames - len(retained))
        ]
    )
    retained_keys = {str(sample["timestamp_sec"]) for sample in retained}
    if len(retained) < max_frames:
        extras = [
            sample
            for sample in sorted(
                normalized,
                key=lambda sample: (-sample["priority"], -sample["segment_duration_sec"], sample["timestamp_sec"]),
            )
            if str(sample["timestamp_sec"]) not in retained_keys
        ]
        retained.extend(extras[: max_frames - len(retained)])
    return dedupe_sorted_timestamps([sample["timestamp_sec"] for sample in retained])[:max_frames]


def build_scene_aware_frame_timestamps(
    duration_sec: float,
    scene_cuts_sec: list[float],
    *,
    short_scene_merge_threshold_sec: float = 1.5,
    medium_scene_threshold_sec: float = 6,
    long_scene_threshold_sec: float = 15,
    max_frames: int = 28,
    min_scene_gap_sec: float = 0.8,
    start_frame_offset_sec: float = 0.25,
    end_frame_offset_sec: float = 0.25,
) -> list[float]:
    duration = number_or_zero(duration_sec)
    if duration <= 0:
        return []
    segments = merge_short_scene_segments(
        build_scene_segments(duration, scene_cuts_sec, min_scene_gap_sec),
        short_scene_merge_threshold_sec,
    )
    forced_start = clamp_timestamp_sec(duration, start_frame_offset_sec)
    forced_end = clamp_timestamp_sec(duration, max(0.0, duration - end_frame_offset_sec))
    samples: list[dict[str, float]] = [
        {
            "timestamp_sec": forced_start,
            "segment_index": -1.0,
            "segment_duration_sec": duration,
            "priority": 5.0,
            "order": 0.0,
        }
    ]
    for segment in segments:
        samples.extend(
            segment_sample_frames(
                duration,
                segment,
                medium_scene_threshold_sec,
                long_scene_threshold_sec,
            )
        )
    samples.append(
        {
            "timestamp_sec": forced_end,
            "segment_index": float("inf"),
            "segment_duration_sec": duration,
            "priority": 5.0,
            "order": 0.0,
        }
    )
    return reduce_scene_aware_samples(samples, max_frames, [forced_start, forced_end])


def run_command(command: list[str], timeout_sec: float) -> subprocess.CompletedProcess[str]:
    try:
        return subprocess.run(
            command,
            check=True,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout_sec,
        )
    except FileNotFoundError as error:
        raise RuntimeError(f"command_not_found: {command[0]}") from error
    except subprocess.TimeoutExpired as error:
        raise RuntimeError(f"command_timeout: {command[0]} exceeded {timeout_sec}s") from error
    except subprocess.CalledProcessError as error:
        detail = (error.stderr or error.stdout or "").strip()[:800]
        raise RuntimeError(f"command_failed: {command[0]}: {detail}") from error


def probe_video_duration(video_path: Path, timeout_sec: float = 15) -> float:
    result = run_command(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(video_path),
        ],
        timeout_sec,
    )
    payload = json.loads(result.stdout)
    duration = number_or_zero(payload.get("format", {}).get("duration"))
    if duration <= 0:
        raise RuntimeError("ffprobe did not return a positive video duration")
    return duration


def detect_scene_cuts(
    video_path: Path,
    *,
    threshold: float = 0.1,
    min_gap_sec: float = 0.8,
    timeout_sec: float = 25,
) -> list[float]:
    result = run_command(
        [
            "ffmpeg",
            "-hide_banner",
            "-i",
            str(video_path),
            "-vf",
            f"select='gt(scene,{threshold})',showinfo",
            "-an",
            "-f",
            "null",
            "-",
        ],
        timeout_sec,
    )
    timestamps = [float(match.group(1)) for match in re.finditer(r"pts_time:([0-9]+(?:\.[0-9]+)?)", result.stderr)]
    return normalize_scene_cuts(float("inf"), timestamps, min_gap_sec)


def build_batch_extraction_plan(frame_dir: Path, timestamps_sec: list[float]) -> tuple[str, list[str], list[dict[str, Any]]]:
    outputs = [
        {
            "index": index,
            "timestamp_sec": round_timestamp_sec(timestamp_sec),
            "input_label": f"v{index}",
            "output_label": f"o{index}",
            "frame_path": frame_dir / f"frame-{index + 1:02d}.jpg",
        }
        for index, timestamp_sec in enumerate(timestamps_sec)
    ]
    if not outputs:
        return "", [], []
    if len(outputs) == 1:
        output = outputs[0]
        filter_complex = (
            f"[0:v]trim=start={output['timestamp_sec']},setpts=PTS-STARTPTS,"
            f"select='eq(n\\,0)',scale='min(720,iw)':-2[{output['output_label']}]"
        )
    else:
        split_outputs = "".join(f"[{output['input_label']}]" for output in outputs)
        filter_parts = [f"[0:v]split={len(outputs)}{split_outputs}"]
        for output in outputs:
            filter_parts.append(
                f"[{output['input_label']}]trim=start={output['timestamp_sec']},setpts=PTS-STARTPTS,"
                f"select='eq(n\\,0)',scale='min(720,iw)':-2[{output['output_label']}]"
            )
        filter_complex = ";".join(filter_parts)
    output_args: list[str] = []
    for output in outputs:
        output_args.extend(["-map", f"[{output['output_label']}]", "-frames:v", "1", str(output["frame_path"])])
    return filter_complex, output_args, outputs


def extract_frames(video_path: Path, timestamps_sec: list[float], timeout_sec: float = 20, keep_dir: Path | None = None) -> list[FrameSample]:
    if not timestamps_sec:
        return []
    temp_context = None
    if keep_dir:
        frame_dir = keep_dir
        frame_dir.mkdir(parents=True, exist_ok=True)
    else:
        temp_context = tempfile.TemporaryDirectory(prefix="llm-frames-")
        frame_dir = Path(temp_context.name)
    try:
        filter_complex, output_args, outputs = build_batch_extraction_plan(frame_dir, timestamps_sec)
        run_command(
            ["ffmpeg", "-y", "-i", str(video_path), "-filter_complex", filter_complex, "-q:v", "3", *output_args],
            timeout_sec,
        )
        frames: list[FrameSample] = []
        for output in outputs:
            frame_path = Path(output["frame_path"])
            data = frame_path.read_bytes()
            if not data:
                continue
            frames.append(
                FrameSample(
                    index=int(output["index"]),
                    timestamp_sec=float(output["timestamp_sec"]),
                    mime_type="image/jpeg",
                    data_url=f"data:image/jpeg;base64,{base64.b64encode(data).decode('ascii')}",
                    path=str(frame_path),
                )
            )
        return frames
    finally:
        if temp_context is not None:
            temp_context.cleanup()


def read_text_arg(value: str | None, fallback: str) -> str:
    if not value:
        return fallback
    if value.startswith("@"):
        return Path(value[1:]).read_text(encoding="utf-8")
    return value


def mime_type_for_video(video_path: Path) -> str:
    return mimetypes.guess_type(str(video_path))[0] or "video/mp4"


def openai_messages(system_prompt: str, user_prompt: str, frames: list[FrameSample], video_url: str, video_part: str, file_name: str) -> list[dict[str, Any]]:
    user_content: list[dict[str, Any]] = [{"type": "text", "text": user_prompt}]
    if video_url:
        if video_part == "video_url":
            user_content.append({"type": "video_url", "video_url": {"url": video_url}})
        else:
            user_content.append({"type": "file", "file": {"filename": file_name, "file_url": video_url}})
    else:
        for frame in frames:
            user_content.append({"type": "image_url", "image_url": {"url": frame.data_url}})
    return [{"role": "system", "content": system_prompt}, {"role": "user", "content": user_content}]


def gemini_body(system_prompt: str, user_prompt: str, frames: list[FrameSample], video_url: str, mime_type: str) -> dict[str, Any]:
    parts: list[dict[str, Any]] = [{"text": user_prompt}]
    if video_url:
        parts.append({"fileData": {"mimeType": mime_type, "fileUri": video_url}})
    else:
        for frame in frames:
            image_base64 = frame.data_url.split(",", 1)[1]
            parts.append({"inlineData": {"mimeType": frame.mime_type, "data": image_base64}})
    return {
        "systemInstruction": {"parts": [{"text": system_prompt}]},
        "contents": [{"role": "user", "parts": parts}],
    }


def chat_completions_url(endpoint: str) -> str:
    clean = endpoint.rstrip("/")
    return clean if clean.endswith("/chat/completions") else f"{clean}/chat/completions"


def gemini_generate_content_url(endpoint: str, model: str) -> str:
    clean = endpoint.rstrip("/")
    encoded_model = urllib.parse.quote(model.strip(), safe="")
    if clean.endswith("/v1beta"):
        return f"{clean}/models/{encoded_model}:generateContent"
    if clean.endswith("/api"):
        return f"{clean}/v1beta/models/{encoded_model}:generateContent"
    if clean.endswith("/v1"):
        return f"{clean}beta/models/{encoded_model}:generateContent"
    return f"{clean}/v1beta/models/{encoded_model}:generateContent"


def post_json(url: str, headers: dict[str, str], body: dict[str, Any], timeout_sec: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers=headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout_sec) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:1000]
        raise RuntimeError(f"model_http_error: status={error.code} body={detail}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"model_request_failed: {error.reason}") from error


def call_openai_compatible(args: argparse.Namespace, messages: list[dict[str, Any]]) -> dict[str, Any]:
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise RuntimeError(f"missing API key env: {args.api_key_env}")
    body: dict[str, Any] = {
        "model": args.model,
        "messages": messages,
        "temperature": args.temperature,
        "response_format": {"type": "json_object"},
    }
    if args.max_tokens > 0:
        body["max_tokens"] = args.max_tokens
    payload = post_json(
        chat_completions_url(args.endpoint),
        {"Content-Type": "application/json", "Authorization": f"Bearer {api_key}"},
        body,
        args.timeout,
    )
    content = payload.get("choices", [{}])[0].get("message", {}).get("content", "")
    return {"raw_response": payload, "content": content, "parsed_json": parse_json_content(content)}


def call_gemini(args: argparse.Namespace, body: dict[str, Any]) -> dict[str, Any]:
    api_key = os.environ.get(args.api_key_env, "")
    if not api_key:
        raise RuntimeError(f"missing API key env: {args.api_key_env}")
    request_body = {
        **body,
        "generationConfig": {"temperature": args.temperature},
    }
    payload = post_json(
        gemini_generate_content_url(args.endpoint, args.model),
        {"Content-Type": "application/json", "x-goog-api-key": api_key},
        request_body,
        args.timeout,
    )
    parts = payload.get("candidates", [{}])[0].get("content", {}).get("parts", [])
    content = "\n".join(part.get("text", "") for part in parts if isinstance(part, dict))
    return {"raw_response": payload, "content": content, "parsed_json": parse_json_content(content)}


def parse_json_content(content: str) -> dict[str, Any]:
    text = str(content or "").strip()
    if not text:
        raise RuntimeError("model returned empty content")
    candidates = [
        text,
        re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.IGNORECASE).strip(),
    ]
    object_match = re.search(r"\{[\s\S]*\}", text)
    if object_match:
        candidates.append(object_match.group(0))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    raise RuntimeError("model returned invalid JSON")


def redacted_request(provider: str, url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    redacted_headers = dict(headers)
    if "Authorization" in redacted_headers:
        redacted_headers["Authorization"] = "Bearer <REDACTED>"
    if "x-goog-api-key" in redacted_headers:
        redacted_headers["x-goog-api-key"] = "<REDACTED>"
    return {"provider": provider, "url": url, "headers": redacted_headers, "body": body}


def build_arg_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Extract scene-aware frames from a video and call a vision LLM.")
    parser.add_argument("video", help="Local video path.")
    parser.add_argument("--provider", choices=["openai-compatible", "gemini"], default="openai-compatible")
    parser.add_argument("--endpoint", default=os.environ.get("VIDEO_LLM_ENDPOINT", "https://example.invalid/api/v1"))
    parser.add_argument("--model", default=os.environ.get("VIDEO_LLM_MODEL", "gpt-5.4"))
    parser.add_argument("--api-key-env", default=os.environ.get("VIDEO_LLM_API_KEY_ENV", "VIDEO_LLM_API_KEY"))
    parser.add_argument("--prompt", help="User prompt text, or @path/to/prompt.txt. Defaults to DEFAULT_USER_PROMPT in this file.")
    parser.add_argument("--system-prompt", help="System prompt text, or @path/to/system.txt. Defaults to DEFAULT_SYSTEM_PROMPT in this file.")
    parser.add_argument("--temperature", type=float, default=0.2)
    parser.add_argument("--timeout", type=float, default=300)
    parser.add_argument("--max-tokens", type=int, default=0, help="Optional output cap. 0 means omit the field.")
    parser.add_argument("--max-frames", type=int, default=28)
    parser.add_argument("--scene-threshold", type=float, default=0.1)
    parser.add_argument("--scene-min-gap-sec", type=float, default=0.8)
    parser.add_argument("--short-scene-merge-sec", type=float, default=1.5)
    parser.add_argument("--medium-scene-sec", type=float, default=6)
    parser.add_argument("--long-scene-sec", type=float, default=15)
    parser.add_argument("--video-url", default="", help="Public video URL for models that can fetch video directly.")
    parser.add_argument("--prefer-video-url", action="store_true", help="Send --video-url instead of extracted frames.")
    parser.add_argument("--video-part", choices=["video_url", "file"], default="video_url")
    parser.add_argument("--keep-frames-dir", help="Directory to keep extracted JPEG frames for inspection.")
    parser.add_argument("--dry-run", action="store_true", help="Build frames and payload but do not call the model.")
    parser.add_argument("--output", help="Write result JSON to this path; defaults to stdout.")
    return parser


def main() -> int:
    args = build_arg_parser().parse_args()
    video_path = Path(args.video).expanduser().resolve()
    if not video_path.is_file():
        raise RuntimeError(f"video file not found: {video_path}")

    started_at = time.time()
    system_prompt = read_text_arg(args.system_prompt, DEFAULT_SYSTEM_PROMPT)
    user_prompt = read_text_arg(args.prompt, DEFAULT_USER_PROMPT)
    duration_sec = probe_video_duration(video_path)
    scene_cuts_sec = detect_scene_cuts(
        video_path,
        threshold=args.scene_threshold,
        min_gap_sec=args.scene_min_gap_sec,
    )
    timestamps_sec = build_scene_aware_frame_timestamps(
        duration_sec,
        scene_cuts_sec,
        short_scene_merge_threshold_sec=args.short_scene_merge_sec,
        medium_scene_threshold_sec=args.medium_scene_sec,
        long_scene_threshold_sec=args.long_scene_sec,
        max_frames=max(1, args.max_frames),
        min_scene_gap_sec=args.scene_min_gap_sec,
    )
    use_video_url = bool(args.prefer_video_url and args.video_url)
    frames = [] if use_video_url else extract_frames(
        video_path,
        timestamps_sec,
        timeout_sec=min(args.timeout, 120),
        keep_dir=Path(args.keep_frames_dir).expanduser().resolve() if args.keep_frames_dir else None,
    )
    mime_type = mime_type_for_video(video_path)

    if args.provider == "gemini":
        body = gemini_body(system_prompt, user_prompt, frames, args.video_url if use_video_url else "", mime_type)
        request_preview = redacted_request(
            args.provider,
            gemini_generate_content_url(args.endpoint, args.model),
            {"Content-Type": "application/json", "x-goog-api-key": os.environ.get(args.api_key_env, "")},
            {**body, "generationConfig": {"temperature": args.temperature}},
        )
        model_result = None if args.dry_run else call_gemini(args, body)
    else:
        messages = openai_messages(
            system_prompt,
            user_prompt,
            frames,
            args.video_url if use_video_url else "",
            args.video_part,
            video_path.name,
        )
        body = {
            "model": args.model,
            "messages": messages,
            "temperature": args.temperature,
            "response_format": {"type": "json_object"},
            **({"max_tokens": args.max_tokens} if args.max_tokens > 0 else {}),
        }
        request_preview = redacted_request(
            args.provider,
            chat_completions_url(args.endpoint),
            {"Content-Type": "application/json", "Authorization": f"Bearer {os.environ.get(args.api_key_env, '')}"},
            body,
        )
        model_result = None if args.dry_run else call_openai_compatible(args, messages)

    result = {
        "video": {
            "path": str(video_path),
            "mime_type": mime_type,
            "duration_sec": round_timestamp_sec(duration_sec),
        },
        "sampling": {
            "scene_cuts_sec": scene_cuts_sec,
            "timestamps_sec": timestamps_sec,
            "frame_count": len(frames),
            "input_mode": "video_url" if use_video_url else "frames_only",
            "kept_frame_paths": [frame.path for frame in frames if args.keep_frames_dir],
        },
        "request": request_preview,
        "model_result": model_result,
        "elapsed_sec": round(time.time() - started_at, 3),
    }

    output_text = json.dumps(result, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).expanduser().write_text(output_text + "\n", encoding="utf-8")
    else:
        print(output_text)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"error: {error}", file=sys.stderr)
        raise SystemExit(1)
