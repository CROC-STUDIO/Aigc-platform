#!/usr/bin/env python3
"""Probe Skylink /responses payload shapes for reference-video decomposition.

Does NOT modify platform code. Sends controlled variants to Skylink gateway and
records status codes + error bodies so you can see which shape accepts video+frames.

Usage (PowerShell):
  $env:WANGZHUAN_LLM_API_KEY = "<your key>"
  python scripts/probe_skylink_decomposition.py

Optional:
  python scripts/probe_skylink_decomposition.py --variants platform_baseline,no_text_format
  python scripts/probe_skylink_decomposition.py --dry-run
  python scripts/probe_skylink_decomposition.py --dump "path/to/llm-request-*.json"
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


DEFAULT_ENDPOINT = "https://skylink-gateway.com/api/v1"
DEFAULT_MODEL = "gpt-5.4"
DEFAULT_VIDEO_URL = (
    "https://harpoons3.s3.ap-southeast-1.amazonaws.com/uploads/PROJECT_ROOT_P/"
    "users/admin/%E6%89%B9%E5%A4%84%E7%90%86%E8%AE%B0%E5%BD%95/"
    "%E7%BD%91%E8%B5%9A%E7%AE%A1%E7%BA%BF/reference-videos/ref_20260622_027/original.mp4"
)
DEFAULT_DUMP = (
    r"C:\Users\hutin\Desktop\project\ai-gc\project-data\PROJECT_ROOT_P"
    r"\用户数据\admin\PROJECT_ROOT_P\批处理记录\网赚管线\reference-videos"
    r"\ref_20260622_027\llm-request-req_20260622110707_1483.json"
)
DEFAULT_LOCAL_VIDEO = (
    r"C:\Users\hutin\Desktop\project\ai-gc\project-data\PROJECT_ROOT_P"
    r"\用户数据\admin\PROJECT_ROOT_P\批处理记录\网赚管线\reference-videos"
    r"\ref_20260622_027\original.mp4"
)

SYSTEM_PROMPT = (
    "你是网赚广告素材拆解专家，只做结构化拆解，不生成侵权复刻内容。\n"
    "你必须输出严格 JSON 对象，不要 markdown，不要解释。\n"
    "拆解目标是学习镜头结构、节奏、话术功能和转化逻辑，规避竞品品牌、人物、水印和原文案照搬。\n"
    "输出字段必须至少包含：scene, subject, action, camera, lighting, style, quality, hook。"
)

FILENAME = "V_40138_1_DramaGold_蓝衣男人口播_PT_ZY_720X1280.mp4"
DURATION_SEC = 17.323
FRAME_COUNT = 5


@dataclass
class ProbeContext:
    endpoint: str
    model: str
    api_key: str
    video_url: str
    user_text: str
    frame_data_urls: list[str] = field(default_factory=list)
    local_video_path: str = ""
    uploaded_file_id: str | None = None


@dataclass
class ProbeResult:
    variant: str
    url: str
    status: int | None
    ok: bool
    request_id: str
    elapsed_ms: int
    error: str
    response_preview: str
    notes: str = ""


def reference_frame_timestamps(duration_sec: float, frame_count: int) -> list[float]:
    duration = max(0.0, float(duration_sec))
    if duration <= 0 or frame_count <= 0:
        return []
    if frame_count == 1:
        ts = min(duration * 0.5, duration - 0.1)
        return [round(max(0.0, ts), 2)]
    end = max(0.0, duration - 0.1)
    return [round(end * (index / (frame_count - 1)), 2) for index in range(frame_count)]


def ffmpeg_extract_frames(video_path: str, timestamps: list[float]) -> list[str]:
    frames: list[str] = []
    with tempfile.TemporaryDirectory(prefix="wz-probe-frames-") as tmp:
        tmp_path = Path(tmp)
        for index, timestamp in enumerate(timestamps):
            out_file = tmp_path / f"frame-{index + 1:02d}.jpg"
            cmd = [
                "ffmpeg",
                "-y",
                "-ss",
                str(timestamp),
                "-i",
                video_path,
                "-frames:v",
                "1",
                "-vf",
                "scale='min(720,iw)':-2",
                "-q:v",
                "3",
                str(out_file),
            ]
            subprocess.run(
                cmd,
                check=True,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            raw = out_file.read_bytes()
            if raw:
                frames.append(f"data:image/jpeg;base64,{base64.b64encode(raw).decode('ascii')}")
    return frames


def load_dump(dump_path: str) -> tuple[str, list[str], dict[str, Any]]:
    path = Path(dump_path)
    if not path.is_file():
        raise FileNotFoundError(f"dump not found: {dump_path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    body = data.get("request", {}).get("body") or data.get("body") or {}
    user = next((item for item in body.get("input", []) if item.get("role") == "user"), {})
    content = user.get("content") or []
    text_part = next((part for part in content if part.get("type") == "input_text"), {})
    user_text = str(text_part.get("text") or "").strip()
    frames = [
        str(part.get("image_url") or "")
        for part in content
        if part.get("type") == "input_image" and part.get("image_url")
    ]
    return user_text, frames, body


def http_json(
    method: str,
    url: str,
    *,
    api_key: str,
    body: dict[str, Any] | None = None,
    timeout_sec: int = 180,
) -> tuple[int, dict[str, str], Any, str]:
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "X-Request-Id": f"probe_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}_{int(time.time() * 1000) % 10000}",
    }
    payload = None
    if body is not None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            parsed: Any
            try:
                parsed = json.loads(raw) if raw else {}
            except json.JSONDecodeError:
                parsed = {"raw": raw}
            return resp.status, dict(resp.headers), parsed, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        parsed: Any
        try:
            parsed = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            parsed = {"raw": raw}
        return exc.code, dict(exc.headers), parsed, raw


def upload_file_via_gateway(ctx: ProbeContext) -> str:
    if not ctx.local_video_path or not Path(ctx.local_video_path).is_file():
        raise FileNotFoundError("local video required for /v1/files upload")
    boundary = f"----wzprobe{int(time.time() * 1000)}"
    video_bytes = Path(ctx.local_video_path).read_bytes()
    parts = [
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="model"\r\n\r\n{ctx.model}\r\n',
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="purpose"\r\n\r\nuser_data\r\n',
        (
            f"--{boundary}\r\n"
            f'Content-Disposition: form-data; name="file"; filename="{FILENAME}"\r\n'
            f"Content-Type: video/mp4\r\n\r\n"
        ).encode("utf-8")
        + video_bytes
        + b"\r\n",
        f"--{boundary}--\r\n",
    ]
    body = b"".join(part.encode("utf-8") if isinstance(part, str) else part for part in parts)
    url = f"{ctx.endpoint.rstrip('/')}/files"
    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Authorization": f"Bearer {ctx.api_key}",
            "Content-Type": f"multipart/form-data; boundary={boundary}",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            payload = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"/v1/files upload failed {exc.code}: {detail[:500]}") from exc
    file_id = str(payload.get("id") or "").strip()
    if not file_id:
        raise RuntimeError(f"/v1/files returned no id: {payload}")
    return file_id


def build_responses_input(
    ctx: ProbeContext,
    *,
    include_video: bool = True,
    video_mode: str = "file_url",
    include_frames: bool = True,
    max_frames: int | None = None,
) -> list[dict[str, Any]]:
    content: list[dict[str, Any]] = [{"type": "input_text", "text": ctx.user_text}]
    if include_video:
        if video_mode == "file_url":
            content.append(
                {
                    "type": "input_file",
                    "filename": FILENAME,
                    "file_url": ctx.video_url,
                }
            )
        elif video_mode == "file_id":
            if not ctx.uploaded_file_id:
                raise ValueError("uploaded_file_id missing")
            content.append(
                {
                    "type": "input_file",
                    "file_id": ctx.uploaded_file_id,
                }
            )
        elif video_mode == "file_data":
            if not ctx.local_video_path:
                raise ValueError("local video required for file_data")
            raw = Path(ctx.local_video_path).read_bytes()
            content.append(
                {
                    "type": "input_file",
                    "filename": FILENAME,
                    "file_data": f"data:video/mp4;base64,{base64.b64encode(raw).decode('ascii')}",
                }
            )
        else:
            raise ValueError(f"unknown video_mode={video_mode}")
    if include_frames:
        frames = ctx.frame_data_urls[: max_frames or len(ctx.frame_data_urls)]
        for data_url in frames:
            content.append({"type": "input_image", "image_url": data_url})
    return [
        {
            "role": "system",
            "content": [{"type": "input_text", "text": SYSTEM_PROMPT}],
        },
        {"role": "user", "content": content},
    ]


def build_chat_messages(
    ctx: ProbeContext,
    *,
    include_video: bool = False,
    include_frames: bool = True,
) -> list[dict[str, Any]]:
    user_content: list[dict[str, Any]] = [{"type": "text", "text": ctx.user_text}]
    if include_video:
        user_content.append(
            {
                "type": "file",
                "file": {"filename": FILENAME, "file_url": ctx.video_url},
            }
        )
    if include_frames:
        for data_url in ctx.frame_data_urls:
            user_content.append({"type": "image_url", "image_url": {"url": data_url}})
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": user_content},
    ]


def response_text(payload: Any) -> str:
    if not isinstance(payload, dict):
        return str(payload)[:400]
    if isinstance(payload.get("output_text"), str):
        return payload["output_text"][:400]
    choices = payload.get("choices")
    if isinstance(choices, list) and choices:
        message = choices[0].get("message") if isinstance(choices[0], dict) else {}
        content = message.get("content") if isinstance(message, dict) else ""
        if isinstance(content, str):
            return content[:400]
    err = payload.get("error")
    if isinstance(err, dict):
        return str(err.get("message") or err)[:400]
    return json.dumps(payload, ensure_ascii=False)[:400]


def run_variant(
    name: str,
    ctx: ProbeContext,
    *,
    url_suffix: str,
    body: dict[str, Any],
    notes: str = "",
    dry_run: bool = False,
) -> ProbeResult:
    url = f"{ctx.endpoint.rstrip('/')}/{url_suffix.lstrip('/')}"
    if dry_run:
        size = len(json.dumps(body, ensure_ascii=False))
        return ProbeResult(
            variant=name,
            url=url,
            status=None,
            ok=False,
            request_id="dry_run",
            elapsed_ms=0,
            error="",
            response_preview=f"payload_bytes={size}",
            notes=notes or "dry-run only",
        )
    started = time.perf_counter()
    status, headers, payload, raw = http_json("POST", url, api_key=ctx.api_key, body=body)
    elapsed_ms = int((time.perf_counter() - started) * 1000)
    request_id = headers.get("X-Request-Id") or headers.get("x-request-id") or ""
    preview = response_text(payload)
    if not preview and raw:
        preview = raw[:400]
    return ProbeResult(
        variant=name,
        url=url,
        status=status,
        ok=200 <= status < 300,
        request_id=request_id,
        elapsed_ms=elapsed_ms,
        error="" if 200 <= status < 300 else preview,
        response_preview=preview,
        notes=notes,
    )


def variant_specs(ctx: ProbeContext, *, dry_run: bool = False) -> dict[str, Callable[[], ProbeResult]]:
    def responses_body(
        *,
        include_video: bool = True,
        video_mode: str = "file_url",
        include_frames: bool = True,
        with_text_format: bool = True,
        max_frames: int | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "model": ctx.model,
            "input": build_responses_input(
                ctx,
                include_video=include_video,
                video_mode=video_mode,
                include_frames=include_frames,
                max_frames=max_frames,
            ),
            "temperature": 0.2,
        }
        if with_text_format:
            body["text"] = {"format": {"type": "json_object"}}
        return body

    specs: dict[str, Callable[[], ProbeResult]] = {}

    specs["platform_baseline"] = lambda: run_variant(
        "platform_baseline",
        ctx,
        url_suffix="responses",
        body=responses_body(),
        notes="Current platform shape: file_url + 5 data:image + text.format json_object",
        dry_run=dry_run,
    )
    specs["no_text_format"] = lambda: run_variant(
        "no_text_format",
        ctx,
        url_suffix="responses",
        body=responses_body(with_text_format=False),
        notes="Same as platform but drop text.format (Volcengine-only field may confuse Codex upstream)",
        dry_run=dry_run,
    )
    specs["file_url_only"] = lambda: run_variant(
        "file_url_only",
        ctx,
        url_suffix="responses",
        body=responses_body(include_frames=False),
        notes="Video URL only — isolate whether file_url alone is rejected",
        dry_run=dry_run,
    )
    specs["frames_only_responses"] = lambda: run_variant(
        "frames_only_responses",
        ctx,
        url_suffix="responses",
        body=responses_body(include_video=False),
        notes="Frames only via /responses (no video file)",
        dry_run=dry_run,
    )
    specs["file_data_plus_frames"] = lambda: run_variant(
        "file_data_plus_frames",
        ctx,
        url_suffix="responses",
        body=responses_body(video_mode="file_data", with_text_format=False),
        notes="Inline base64 mp4 via file_data + frames (Codex may prefer this over file_url)",
        dry_run=dry_run,
    )
    specs["one_frame_plus_video"] = lambda: run_variant(
        "one_frame_plus_video",
        ctx,
        url_suffix="responses",
        body=responses_body(with_text_format=False, max_frames=1),
        notes="Reduce image payload size — rule out gateway/upstream size limits",
        dry_run=dry_run,
    )
    specs["chat_completions_frames"] = lambda: run_variant(
        "chat_completions_frames",
        ctx,
        url_suffix="chat/completions",
        body={
            "model": ctx.model,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": build_chat_messages(ctx, include_video=False, include_frames=True),
        },
        notes="Platform fallback path: chat/completions without video",
        dry_run=dry_run,
    )
    specs["chat_completions_video_url"] = lambda: run_variant(
        "chat_completions_video_url",
        ctx,
        url_suffix="chat/completions",
        body={
            "model": ctx.model,
            "temperature": 0.2,
            "response_format": {"type": "json_object"},
            "messages": build_chat_messages(ctx, include_video=True, include_frames=True),
        },
        notes="Try keeping video in chat/completions (non-standard; likely rejected but worth probing)",
        dry_run=dry_run,
    )

    def file_id_variant() -> ProbeResult:
        if dry_run:
            return ProbeResult(
                variant="files_api_then_file_id",
                url=f"{ctx.endpoint.rstrip('/')}/files -> responses",
                status=None,
                ok=False,
                request_id="dry_run",
                elapsed_ms=0,
                error="",
                response_preview="skipped upload in dry-run",
                notes="Skylink /v1/files is documented for Volcengine routes only; gpt-5.4 may fail here",
            )
        try:
            ctx.uploaded_file_id = upload_file_via_gateway(ctx)
        except Exception as exc:
            return ProbeResult(
                variant="files_api_then_file_id",
                url=f"{ctx.endpoint.rstrip('/')}/files -> responses",
                status=None,
                ok=False,
                request_id="",
                elapsed_ms=0,
                error=str(exc)[:500],
                response_preview="",
                notes="Skylink /v1/files is documented for Volcengine routes only; gpt-5.4 may fail here",
            )
        return run_variant(
            "files_api_then_file_id",
            ctx,
            url_suffix="responses",
            body=responses_body(video_mode="file_id", with_text_format=False),
            notes="Canonical gateway path: POST /files then input_file.file_id",
            dry_run=dry_run,
        )

    specs["files_api_then_file_id"] = file_id_variant
    return specs


def ensure_frames(ctx: ProbeContext, dump_path: str, skip_extract: bool) -> None:
    if ctx.frame_data_urls:
        return
    if dump_path and Path(dump_path).is_file():
        _, frames, _ = load_dump(dump_path)
        if frames:
            ctx.frame_data_urls = frames
            return
    if skip_extract:
        raise RuntimeError("No frames in dump and --skip-extract set")
    local = ctx.local_video_path
    if not local or not Path(local).is_file():
        raise RuntimeError("Need --local-video or dump with frames to extract JPEG samples")
    timestamps = reference_frame_timestamps(DURATION_SEC, FRAME_COUNT)
    ctx.frame_data_urls = ffmpeg_extract_frames(local, timestamps)


def main() -> int:
    parser = argparse.ArgumentParser(description="Probe Skylink decomposition request shapes")
    parser.add_argument("--endpoint", default=os.environ.get("WANGZHUAN_LLM_ENDPOINT", DEFAULT_ENDPOINT))
    parser.add_argument("--model", default=os.environ.get("WANGZHUAN_LLM_MODEL", DEFAULT_MODEL))
    parser.add_argument("--api-key", default=os.environ.get("WANGZHUAN_LLM_API_KEY", ""))
    parser.add_argument("--video-url", default=DEFAULT_VIDEO_URL)
    parser.add_argument("--local-video", default=DEFAULT_LOCAL_VIDEO)
    parser.add_argument("--dump", default=DEFAULT_DUMP, help="Platform llm-request dump JSON")
    parser.add_argument("--variants", default="", help="Comma-separated variant names; default=all")
    parser.add_argument("--dry-run", action="store_true", help="Build payloads only, no network")
    parser.add_argument("--skip-extract", action="store_true", help="Do not ffmpeg-extract; require dump frames")
    parser.add_argument("--out", default="", help="Write JSON report path")
    args = parser.parse_args()

    user_text = ""
    if args.dump and Path(args.dump).is_file():
        user_text, _, _ = load_dump(args.dump)
    if not user_text:
        user_text = (
            "请根据参考视频文件和抽样画面帧，生成网赚素材脚本拆解 JSON 草稿。\n\n"
            f"referenceVideoId：ref_20260622_027\n时长：{DURATION_SEC} 秒\n"
            "只返回 JSON 对象。"
        )

    ctx = ProbeContext(
        endpoint=args.endpoint,
        model=args.model,
        api_key=args.api_key,
        video_url=args.video_url,
        user_text=user_text,
        local_video_path=args.local_video,
    )
    ensure_frames(ctx, args.dump, args.skip_extract)

    if not args.api_key and not args.dry_run:
        print("ERROR: set WANGZHUAN_LLM_API_KEY or pass --api-key", file=sys.stderr)
        print("Tip: python scripts/probe_skylink_decomposition.py --dry-run", file=sys.stderr)
        return 2

    all_specs = variant_specs(ctx, dry_run=args.dry_run)
    selected = [name.strip() for name in args.variants.split(",") if name.strip()] or list(all_specs.keys())
    unknown = [name for name in selected if name not in all_specs]
    if unknown:
        print(f"Unknown variants: {unknown}", file=sys.stderr)
        print(f"Available: {', '.join(all_specs.keys())}", file=sys.stderr)
        return 2

    print(f"endpoint={ctx.endpoint} model={ctx.model} frames={len(ctx.frame_data_urls)} dry_run={args.dry_run}")
    results: list[ProbeResult] = []
    for name in selected:
        print(f"\n=== {name} ===")
        result = all_specs[name]()
        results.append(result)
        status = result.status if result.status is not None else "n/a"
        print(f"status={status} ok={result.ok} request_id={result.request_id} elapsed_ms={result.elapsed_ms}")
        if result.notes:
            print(f"notes: {result.notes}")
        if result.error:
            print(f"error: {result.error}")
        elif result.response_preview:
            print(f"preview: {result.response_preview[:240]}")

    report = {
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "endpoint": ctx.endpoint,
        "model": ctx.model,
        "videoUrl": ctx.video_url,
        "frameCount": len(ctx.frame_data_urls),
        "variants": [result.__dict__ for result in results],
        "recommendation": (
            "If platform_baseline fails but file_data_plus_frames or no_text_format succeeds, "
            "the fix is on the platform payload — not the gateway route."
        ),
    }
    out_path = args.out or str(
        Path(__file__).resolve().parent.parent
        / f"probe-skylink-decomposition-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    )
    Path(out_path).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nReport written: {out_path}")
    ok_variants = [r.variant for r in results if r.ok]
    if ok_variants:
        print(f"SUCCESS variants: {', '.join(ok_variants)}")
    return 0 if ok_variants or args.dry_run else 1


if __name__ == "__main__":
    raise SystemExit(main())
