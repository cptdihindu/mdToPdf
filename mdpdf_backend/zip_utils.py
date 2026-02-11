from __future__ import annotations

import io
import re
import zipfile
from dataclasses import dataclass
from pathlib import Path

from .config import ALLOWED_IMAGE_EXTS, IMAGES_SUBDIR
from .security import safe_join


@dataclass(frozen=True)
class ImportedZip:
    markdown_text: str
    images: dict[str, bytes]  # dest_basename -> bytes


_MD_IMG_RE = re.compile(
    r"(!\[[^\]]*\]\()(?P<url>[^)\s]+)(?P<rest>[^)]*\))|(<img\b[^>]*?\ssrc=)(?P<q>[\"'])(?P<hurl>[^\"']+)(?P=q)",
    re.IGNORECASE,
)


def rewrite_markdown_image_urls(markdown_text: str, image_basenames: set[str]) -> str:
    """Rewrite local image URLs to images/<basename>.

    This is used on ZIP import so that images (which are always written to
    workspace/images/) resolve even if the markdown referenced a different
    subpath inside the ZIP.

    Safety: we only rewrite non-http(s)/data URLs that end with a known basename.
    """
    if not markdown_text or not image_basenames:
        return markdown_text or ""

    basenames_lower = {b.lower(): b for b in image_basenames}

    def _rewrite_url(url: str) -> str:
        u = (url or "").strip()
        lowered = u.lower()
        if lowered.startswith(("http://", "https://", "data:")):
            return url
        # Strip query/fragment for basename matching but keep none in output.
        core = u.split("?", 1)[0].split("#", 1)[0]
        base = Path(core).name
        if not base:
            return url
        hit = basenames_lower.get(base.lower())
        if not hit:
            return url
        return f"{IMAGES_SUBDIR}/{hit}"

    def _sub(m: re.Match) -> str:
        if m.group("url") is not None:
            new_url = _rewrite_url(m.group("url"))
            return f"{m.group(1)}{new_url}{m.group('rest')}"
        # HTML img
        new_url = _rewrite_url(m.group("hurl"))
        return f"{m.group(4)}{m.group('q')}{new_url}{m.group('q')}"

    return _MD_IMG_RE.sub(_sub, markdown_text)


def is_zip_bytes(data: bytes) -> bool:
    try:
        return zipfile.is_zipfile(io.BytesIO(data))
    except Exception:
        return False


def _is_bad_zip_member(name: str) -> bool:
    # Zip Slip defenses.
    if not name or name.strip() == "":
        return True
    if name.startswith("/") or name.startswith("\\"):
        return True
    if ":" in name:
        # block drive letters / weird schemes
        return True
    parts = Path(name).parts
    if any(p in ("..",) for p in parts):
        return True
    return False


def _read_zip_text(zf: zipfile.ZipFile, member: zipfile.ZipInfo) -> str:
    raw = zf.read(member)
    # Best-effort decoding: prefer UTF-8, fall back to cp1252/latin1.
    for enc in ("utf-8", "utf-8-sig", "cp1252", "latin-1"):
        try:
            return raw.decode(enc)
        except Exception:
            continue
    return raw.decode("utf-8", errors="replace")


def import_zip_bytes(zip_bytes: bytes) -> ImportedZip:
    """Validate + parse a ZIP for import.

    Rules:
    - Exactly one markdown file (.md/.markdown/.txt)
    - Images only with allowed extensions
    - No Zip Slip (absolute paths, '..', drive letters)

    Returns the markdown text and a mapping of image basenames -> content bytes.

    Note: This function *does not* write to disk; caller decides destination.
    """
    if not is_zip_bytes(zip_bytes):
        raise ValueError("Invalid ZIP")

    md_members: list[zipfile.ZipInfo] = []
    images: dict[str, bytes] = {}

    with zipfile.ZipFile(io.BytesIO(zip_bytes)) as zf:
        for info in zf.infolist():
            name = info.filename
            if info.is_dir():
                continue
            if _is_bad_zip_member(name):
                raise ValueError("Unsafe path in ZIP")

            suffix = Path(name).suffix.lower()
            if suffix in (".md", ".markdown", ".txt"):
                md_members.append(info)
                continue

            if suffix in ALLOWED_IMAGE_EXTS:
                # Store all images; we will normalize into images/<basename> at import time.
                basename = Path(name).name
                if not basename:
                    raise ValueError("Invalid image name")
                if basename in images:
                    raise ValueError("Duplicate image filename in ZIP")
                images[basename] = zf.read(info)
                continue

            # Ignore other files (security: don't extract arbitrary content)

        if len(md_members) != 1:
            raise ValueError("ZIP must contain exactly one markdown file")

        markdown_text = _read_zip_text(zf, md_members[0])

    return ImportedZip(markdown_text=markdown_text, images=images)


def build_export_zip(markdown_text: str, images: dict[str, bytes]) -> bytes:
    """Build an export ZIP with document.md and images/ entries."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, mode="w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("document.md", markdown_text or "")
        for basename, data in images.items():
            suffix = Path(basename).suffix.lower()
            if suffix not in ALLOWED_IMAGE_EXTS:
                continue
            arcname = f"{IMAGES_SUBDIR}/{basename}"
            zf.writestr(arcname, data)
    return buf.getvalue()


def write_imported_images(images_dir: Path, images: dict[str, bytes]) -> None:
    images_dir.mkdir(parents=True, exist_ok=True)
    for basename, data in images.items():
        dest = safe_join(images_dir, basename)
        dest.write_bytes(data)
