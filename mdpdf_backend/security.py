from __future__ import annotations

import re
import uuid
from pathlib import Path


_SESSION_ID_RE = re.compile(r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$")


def normalize_session_id(session_id: str) -> str:
    """Validate and normalize a session id.

    Treat session IDs as capability tokens; keep them unguessable and validate
    them strictly to reduce accidental path tricks.
    """
    if not isinstance(session_id, str):
        raise ValueError("Invalid session id")
    session_id = session_id.strip()
    if not _SESSION_ID_RE.match(session_id):
        # uuid.UUID also accepts many formats; we want strict canonical UUID4 string.
        raise ValueError("Invalid session id")
    return str(uuid.UUID(session_id))


def is_safe_basename(name: str) -> bool:
    """Allow only simple filenames (no directories)."""
    if not isinstance(name, str) or not name:
        return False
    if name != Path(name).name:
        return False
    if "/" in name or "\\" in name:
        return False
    return True


def safe_join(base_dir: Path, *parts: str) -> Path:
    """Join paths and ensure the result stays within base_dir.

    This defends against path traversal when serving or extracting user-controlled paths.
    """
    base_dir = base_dir.resolve()
    candidate = base_dir
    for part in parts:
        candidate = candidate / part
    resolved = candidate.resolve()
    if resolved == base_dir:
        return resolved
    if base_dir not in resolved.parents:
        raise ValueError("Path traversal attempt")
    return resolved
