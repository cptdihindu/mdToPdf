from __future__ import annotations

import json
import os
import re
import shutil
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

from .config import (
    ALLOWED_IMAGE_EXTS,
    DOCUMENT_FILENAME,
    IMAGES_SUBDIR,
    META_FILENAME,
    TTL_HOURS,
    WORKSPACES_ROOT,
)
from .security import normalize_session_id, safe_join


@dataclass(frozen=True)
class SessionWorkspace:
    session_id: str
    root: Path
    document_path: Path
    images_dir: Path
    meta_path: Path


def _now_epoch() -> float:
    return time.time()


def _meta_default() -> dict:
    now = _now_epoch()
    return {"created_at": now, "last_access": now, "version": 1}


def _load_meta(meta_path: Path) -> dict:
    try:
        return json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return _meta_default()


def _write_meta(meta_path: Path, meta: dict) -> None:
    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True), encoding="utf-8")


def get_session_workspace(session_id: str) -> SessionWorkspace:
    sid = normalize_session_id(session_id)
    root = (WORKSPACES_ROOT / sid).resolve()
    return SessionWorkspace(
        session_id=sid,
        root=root,
        document_path=root / DOCUMENT_FILENAME,
        images_dir=root / IMAGES_SUBDIR,
        meta_path=root / META_FILENAME,
    )


def ensure_workspace_dirs(ws: SessionWorkspace) -> None:
    ws.images_dir.mkdir(parents=True, exist_ok=True)
    ws.root.mkdir(parents=True, exist_ok=True)
    if not ws.meta_path.exists():
        _write_meta(ws.meta_path, _meta_default())


def create_new_session() -> SessionWorkspace:
    WORKSPACES_ROOT.mkdir(parents=True, exist_ok=True)
    sid = str(uuid.uuid4())
    ws = get_session_workspace(sid)
    ensure_workspace_dirs(ws)
    return ws


def touch_session(session_id: str) -> None:
    ws = get_session_workspace(session_id)
    if not ws.root.exists():
        raise FileNotFoundError("Session not found")
    ensure_workspace_dirs(ws)
    meta = _load_meta(ws.meta_path)
    meta["last_access"] = _now_epoch()
    _write_meta(ws.meta_path, meta)


def delete_session(session_id: str) -> None:
    ws = get_session_workspace(session_id)
    if ws.root.exists():
        shutil.rmtree(ws.root, ignore_errors=True)


def save_document(session_id: str, markdown_text: str) -> Path:
    ws = get_session_workspace(session_id)
    ensure_workspace_dirs(ws)
    ws.document_path.write_text(markdown_text or "", encoding="utf-8")
    touch_session(session_id)
    return ws.document_path


def _guess_extension_from_content_type(content_type: str | None) -> str:
    if not content_type:
        return ".png"
    ct = content_type.split(";")[0].strip().lower()
    return {
        "image/png": ".png",
        "image/jpeg": ".jpg",
        "image/jpg": ".jpg",
        "image/gif": ".gif",
        "image/webp": ".webp",
        "image/svg+xml": ".svg",
    }.get(ct, ".png")


def save_pasted_image(session_id: str, data: bytes, content_type: str | None) -> str:
    """Save pasted image to session images dir.

    Returns the relative URL to use in markdown/html: images/<uuid>.<ext>
    """
    ws = get_session_workspace(session_id)
    ensure_workspace_dirs(ws)

    ext = _guess_extension_from_content_type(content_type)
    if ext not in ALLOWED_IMAGE_EXTS:
        # Shouldn't happen if content-type is sane; still enforce.
        ext = ".png"

    filename = f"{uuid.uuid4()}{ext}"
    dest = safe_join(ws.images_dir, filename)
    dest.write_bytes(data)
    touch_session(session_id)
    return f"{IMAGES_SUBDIR}/{filename}"


_IMAGE_URL_RE = re.compile(
    r"(?:!\[[^\]]*\]\((?P<mdurl>[^)\s]+)(?:\s+\"[^\"]*\")?\))|(?:<img\s+[^>]*?src=[\"'](?P<htmlurl>[^\"']+)[\"'][^>]*?>)",
    re.IGNORECASE,
)


def find_referenced_workspace_images(markdown_text: str) -> set[str]:
    """Return basenames referenced under images/ in markdown or embedded HTML.

    We intentionally only include images referenced as images/<name> (relative).
    """
    referenced: set[str] = set()
    text = markdown_text or ""
    for match in _IMAGE_URL_RE.finditer(text):
        url = match.group("mdurl") or match.group("htmlurl") or ""
        url = url.strip()
        if not url:
            continue
        # Ignore remote URLs/data URLs.
        lowered = url.lower()
        if lowered.startswith(("http://", "https://", "data:")):
            continue
        # Only include images/... paths.
        if not lowered.startswith(f"{IMAGES_SUBDIR.lower()}/"):
            continue
        # Strip any fragment/query.
        url_no_q = url.split("?", 1)[0].split("#", 1)[0]
        basename = Path(url_no_q).name
        if not basename:
            continue
        ext = Path(basename).suffix.lower()
        if ext in ALLOWED_IMAGE_EXTS:
            referenced.add(basename)
    return referenced


def cleanup_expired_sessions() -> int:
    """Delete sessions whose last_access is older than TTL.

    Returns the number of deleted workspaces.
    """
    deleted = 0
    root = WORKSPACES_ROOT
    if not root.exists():
        return 0

    ttl_seconds = max(0.0, TTL_HOURS) * 3600.0
    now = _now_epoch()

    for child in root.iterdir():
        if not child.is_dir():
            continue
        meta_path = child / META_FILENAME
        meta = _load_meta(meta_path)
        last_access = float(meta.get("last_access", meta.get("created_at", 0)))
        if ttl_seconds and (now - last_access) > ttl_seconds:
            shutil.rmtree(child, ignore_errors=True)
            deleted += 1
    return deleted


def _is_session_workspace_dir(path: Path) -> bool:
    if not path.is_dir():
        return False
    try:
        normalize_session_id(path.name)
    except Exception:
        return False
    # Our workspaces always have a meta file.
    return (path / META_FILENAME).is_file()


def delete_sessions_under_root(root: Path, except_session_ids: Iterable[str] | None = None) -> int:
    """Delete session workspaces directly under the given root.

    Only deletes directories that look like our session workspaces:
    - name is a valid UUID session id
    - contains META_FILENAME
    """
    keep: set[str] = set()
    if except_session_ids:
        for sid in except_session_ids:
            try:
                keep.add(normalize_session_id(str(sid)))
            except Exception:
                continue

    deleted = 0
    if not root.exists():
        return 0

    for child in root.iterdir():
        if child.name in keep:
            continue
        if not _is_session_workspace_dir(child):
            continue
        shutil.rmtree(child, ignore_errors=True)
        deleted += 1
    return deleted


def delete_all_sessions(except_session_ids: Iterable[str] | None = None) -> int:
    """Delete all session workspaces under WORKSPACES_ROOT.

    except_session_ids: session ids to keep (best-effort). Invalid ids are ignored.
    Returns number of deleted workspaces.
    """
    return delete_sessions_under_root(WORKSPACES_ROOT, except_session_ids=except_session_ids)
