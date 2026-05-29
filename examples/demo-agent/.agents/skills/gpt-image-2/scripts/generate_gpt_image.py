#!/usr/bin/env python3
"""Generate images with a GPT-Image-2 compatible API.

Supports plain text-to-image generation and reference-image edits through
OpenAI-compatible endpoints.
"""
from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import os
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path
from typing import Any

DEFAULT_MODEL = "gpt-image-2"
DEFAULT_RPM = 7


def api_base() -> str:
    value = os.environ.get("OPENCODE_IMAGE_API_BASE")
    if not value:
        raise RuntimeError("Missing OPENCODE_IMAGE_API_BASE")
    return value.rstrip("/")


def api_key() -> str:
    value = os.environ.get("OPENCODE_IMAGE_API_KEY")
    if not value:
        raise RuntimeError("Missing OPENCODE_IMAGE_API_KEY")
    return value


def read_prompt(args: argparse.Namespace) -> str:
    if args.prompt and args.prompt_file:
        raise RuntimeError("Use either --prompt or --prompt-file, not both")
    if args.prompt_file:
        return Path(args.prompt_file).read_text(encoding="utf-8").strip()
    if args.prompt:
        return args.prompt.strip()
    raise RuntimeError("A prompt is required via --prompt or --prompt-file")


def post_json(url: str, payload: dict[str, Any], timeout: int) -> dict[str, Any]:
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def post_multipart(url: str, fields: dict[str, str], file_field: str, file_path: Path, timeout: int) -> dict[str, Any]:
    boundary = f"----pi-gpt-image-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            str(value).encode(),
            b"\r\n",
        ])
    mime = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
    chunks.extend([
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="{file_field}"; filename="{file_path.name}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        file_path.read_bytes(),
        b"\r\n",
        f"--{boundary}--\r\n".encode(),
    ])
    body = b"".join(chunks)
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def extract_image_bytes(response: dict[str, Any]) -> bytes:
    data = response.get("data")
    if isinstance(data, list) and data and isinstance(data[0], dict) and data[0].get("b64_json"):
        return base64.b64decode(data[0]["b64_json"])
    raise RuntimeError(f"No data[0].b64_json in image response: {json.dumps(response)[:1000]}")


def generate_image(
    prompt: str,
    out_path: Path,
    *,
    size: str,
    quality: str,
    output_format: str,
    compression: int,
    background: str,
    moderation: str,
    reference: Path | None,
    timeout: int,
    retries: int,
) -> dict[str, Any]:
    model = os.environ.get("OPENCODE_IMAGE_MODEL", DEFAULT_MODEL)
    for attempt in range(retries + 1):
        try:
            if reference:
                fields = {
                    "model": model,
                    "prompt": prompt,
                    "size": size,
                    "quality": quality,
                    "n": "1",
                    "input_fidelity": "high",
                    "output_format": output_format,
                    "background": background,
                    "moderation": moderation,
                }
                if output_format in {"jpeg", "webp"}:
                    fields["output_compression"] = str(compression)
                response = post_multipart(f"{api_base()}/openai/v1/images/edits", fields, "image", reference, timeout)
            else:
                payload: dict[str, Any] = {
                    "model": model,
                    "prompt": prompt,
                    "size": size,
                    "n": 1,
                    "quality": quality,
                    "output_format": output_format,
                    "background": background,
                    "moderation": moderation,
                }
                if output_format in {"jpeg", "webp"}:
                    payload["output_compression"] = compression
                response = post_json(f"{api_base()}/openai/v1/images/generations", payload, timeout)

            out_path.parent.mkdir(parents=True, exist_ok=True)
            out_path.write_bytes(extract_image_bytes(response))
            return {
                "ok": True,
                "model": model,
                "out": str(out_path),
                "responseKeys": sorted(response.keys()),
                "size": size,
                "format": output_format,
                "reference": str(reference) if reference else None,
            }
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")[:1500]
            if exc.code in (429, 500, 502, 503, 504) and attempt < retries:
                sleep_s = min(60, 8 * (2**attempt))
                print(f"HTTP {exc.code}; retrying in {sleep_s}s", file=sys.stderr)
                time.sleep(sleep_s)
                continue
            raise RuntimeError(f"Image API failed: HTTP {exc.code} {exc.reason}\n{body}") from exc


def maybe_wait_for_rate_limit(last_request_at: float | None, rpm: int) -> float:
    if not last_request_at or rpm <= 0:
        return time.time()
    min_interval = 60.0 / rpm
    elapsed = time.time() - last_request_at
    if elapsed < min_interval:
        time.sleep(min_interval - elapsed)
    return time.time()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompt")
    ap.add_argument("--prompt-file")
    ap.add_argument("--out", required=True)
    ap.add_argument("--reference")
    ap.add_argument("--size", default="1536x1024")
    ap.add_argument("--quality", choices=["low", "medium", "high"], default="medium")
    ap.add_argument("--format", choices=["png", "jpeg", "webp"], default="png")
    ap.add_argument("--compression", type=int, default=85)
    ap.add_argument("--background", choices=["auto", "opaque", "transparent"], default="auto")
    ap.add_argument("--moderation", choices=["auto", "low"], default="auto")
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--retries", type=int, default=2)
    ap.add_argument("--rpm", type=int, default=DEFAULT_RPM)
    ap.add_argument("--metadata-out")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    prompt = read_prompt(args)
    out_path = Path(args.out).expanduser().resolve()
    reference = Path(args.reference).expanduser().resolve() if args.reference else None

    metadata = {
        "prompt": prompt,
        "out": str(out_path),
        "reference": str(reference) if reference else None,
        "size": args.size,
        "quality": args.quality,
        "format": args.format,
        "background": args.background,
        "moderation": args.moderation,
        "model": os.environ.get("OPENCODE_IMAGE_MODEL", DEFAULT_MODEL),
    }

    if args.dry_run:
        print(json.dumps(metadata, ensure_ascii=False, indent=2))
        return 0

    maybe_wait_for_rate_limit(None, args.rpm)
    result = generate_image(
        prompt,
        out_path,
        size=args.size,
        quality=args.quality,
        output_format=args.format,
        compression=args.compression,
        background=args.background,
        moderation=args.moderation,
        reference=reference,
        timeout=args.timeout,
        retries=args.retries,
    )

    metadata.update(result)
    if args.metadata_out:
        metadata_path = Path(args.metadata_out).expanduser().resolve()
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    print(json.dumps(metadata, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
