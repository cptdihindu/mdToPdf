from __future__ import annotations

import os
from pathlib import Path


# Root directory for all sessions.
# Default: project-local ./sessions for easier inspection and cleanup.
# Override with env var MDPDF_WORKSPACES_ROOT.
_root_raw = os.environ.get("MDPDF_WORKSPACES_ROOT")
if _root_raw and _root_raw.strip():
    WORKSPACES_ROOT = Path(_root_raw)
else:
    # mdpdf_backend/ -> project root
    WORKSPACES_ROOT = Path(__file__).resolve().parent.parent / "sessions"
WORKSPACES_ROOT = WORKSPACES_ROOT.resolve()
WORKSPACES_ROOT.mkdir(parents=True, exist_ok=True)

# How long a workspace may live without activity.
TTL_HOURS = float(os.environ.get("MDPDF_TTL_HOURS", "6"))

# How often the server scans for expired sessions.
CLEANUP_INTERVAL_SECONDS = int(os.environ.get("MDPDF_CLEANUP_INTERVAL_SECONDS", "600"))

# Upload limits (best-effort; also enforced by proxy/browser typically).
MAX_IMAGE_UPLOAD_BYTES = int(os.environ.get("MDPDF_MAX_IMAGE_UPLOAD_BYTES", str(10 * 1024 * 1024)))  # 10MB
MAX_ZIP_UPLOAD_BYTES = int(os.environ.get("MDPDF_MAX_ZIP_UPLOAD_BYTES", str(50 * 1024 * 1024)))  # 50MB

# Allowed image extensions for paste + zip import/export.
ALLOWED_IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"}

# Only serve files from this subfolder inside a session.
IMAGES_SUBDIR = "images"
DOCUMENT_FILENAME = "document.md"
META_FILENAME = ".meta.json"
