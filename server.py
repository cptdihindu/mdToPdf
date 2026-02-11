from __future__ import annotations

import os
import re
import asyncio
from contextlib import asynccontextmanager
from typing import Optional
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from playwright.async_api import async_playwright

from mdpdf_backend.config import (
    ALLOWED_IMAGE_EXTS,
    CLEANUP_INTERVAL_SECONDS,
    IMAGES_SUBDIR,
    MAX_IMAGE_UPLOAD_BYTES,
    MAX_ZIP_UPLOAD_BYTES,
    WORKSPACES_ROOT,
)
from mdpdf_backend.security import is_safe_basename, normalize_session_id, safe_join
from mdpdf_backend.workspace import (
    cleanup_expired_sessions,
    create_new_session,
    delete_all_sessions,
    delete_sessions_under_root,
    delete_session,
    find_referenced_workspace_images,
    get_session_workspace,
    save_document,
    save_pasted_image,
    touch_session,
)
from mdpdf_backend.zip_utils import (
    build_export_zip,
    import_zip_bytes,
    rewrite_markdown_image_urls,
    write_imported_images,
)


BASE_DIR = Path(__file__).resolve().parent


class PdfRequest(BaseModel):
    html: str
    filename: str = "document.pdf"
    session_id: Optional[str] = None


class SessionDocRequest(BaseModel):
    markdown: str


class PruneSessionsRequest(BaseModel):
    keep_session_id: str


async def _cleanup_worker() -> None:
    # Periodically delete expired session workspaces.
    # Best practice: keep this loop resilient to unexpected filesystem errors.
    while True:
        try:
            cleanup_expired_sessions()
        except Exception:
            pass
        await asyncio.sleep(max(30, CLEANUP_INTERVAL_SECONDS))


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Run a cleanup pass at startup, then start the periodic cleanup task.
    try:
        # Back-compat: older versions stored session folders directly under the project root.
        # Now sessions default to ./sessions, so clean up those legacy session dirs too.
        if WORKSPACES_ROOT.resolve() != BASE_DIR.resolve():
            delete_sessions_under_root(BASE_DIR, except_session_ids=None)
        cleanup_expired_sessions()
    except Exception:
        pass

    task = asyncio.create_task(_cleanup_worker())
    app.state._cleanup_task = task
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except Exception:
            pass


app = FastAPI(lifespan=lifespan)

# Allow the browser app to call the API even when index.html is opened from disk
# (file:// pages send Origin: null, which otherwise fails CORS).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.middleware("http")
async def _no_cache_static_assets(request: Request, call_next):
    response = await call_next(request)
    path = (request.url.path or "").lower()
    # Make local iteration predictable: ensure browsers always re-fetch edited assets.
    if path.endswith((".css", ".js", ".html")) and not path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/pdf")
async def render_pdf(payload: PdfRequest, request: Request) -> Response:
    # Generate a selectable-text PDF by printing the provided HTML in headless Chromium.
    html = payload.html or ""

    # Ensure relative paths like images/... resolve correctly for the active session.
    # We do this by injecting a <base href="..."> tag, pointing at our session route.
    if payload.session_id:
        try:
            sid = normalize_session_id(payload.session_id)
            touch_session(sid)
            # request.base_url is guaranteed to end with '/'
            base_href = f"{request.base_url}s/{sid}/"
            if "<head" in html.lower():
                # Insert immediately after the opening <head> tag.
                def _insert_base(m: re.Match) -> str:
                    return f"{m.group(1)}\n        <base href=\"{base_href}\" />"

                html = re.sub(
                    r"(<head[^>]*>)",
                    _insert_base,
                    html,
                    count=1,
                    flags=re.IGNORECASE,
                )
            else:
                html = f"<base href=\"{base_href}\" />\n" + html
        except Exception:
            # If session id is invalid/missing on disk, keep going; images may fail to load.
            pass

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        await page.set_content(html, wait_until="networkidle")

        # Wait for web fonts (Google Fonts) to load if used.
        try:
            await page.evaluate(
                """async () => { if (document.fonts && document.fonts.ready) { await document.fonts.ready; } }"""
            )
        except Exception:
            pass

        pdf_bytes = await page.pdf(
            format="A4",
            print_background=True,
            margin={"top": "0", "right": "0", "bottom": "0", "left": "0"},
        )

        await browser.close()

    headers = {
        "Content-Disposition": f'attachment; filename="{payload.filename}"',
        "Cache-Control": "no-store",
    }
    return Response(content=pdf_bytes, media_type="application/pdf", headers=headers)


@app.post("/api/session/new")
async def new_session() -> JSONResponse:
    ws = create_new_session()
    return JSONResponse({"session_id": ws.session_id})


@app.post("/api/session/{session_id}/touch")
async def touch(session_id: str) -> JSONResponse:
    try:
        sid = normalize_session_id(session_id)
        touch_session(sid)
        return JSONResponse({"ok": True})
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found")


@app.post("/api/session/{session_id}/reset")
async def reset_session(session_id: str) -> JSONResponse:
    # Delete the old workspace (if any) and start fresh.
    try:
        sid = normalize_session_id(session_id)
        delete_session(sid)
    except Exception:
        pass
    ws = create_new_session()
    return JSONResponse({"session_id": ws.session_id})


@app.post("/api/session/{session_id}/delete")
async def delete_session_api(session_id: str) -> JSONResponse:
    try:
        sid = normalize_session_id(session_id)
        delete_session(sid)
    except Exception:
        # Idempotent: deleting a missing/invalid session is treated as success.
        pass
    return JSONResponse({"ok": True})


def _require_localhost(request: Request) -> None:
    # These endpoints are destructive; restrict to local use.
    host = getattr(request.client, "host", "") if request.client else ""
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="Forbidden")


@app.post("/api/sessions/delete-all")
async def delete_all(request: Request) -> JSONResponse:
    _require_localhost(request)
    deleted = delete_all_sessions(except_session_ids=None)
    return JSONResponse({"ok": True, "deleted": deleted})


@app.post("/api/sessions/prune")
async def prune_sessions(payload: PruneSessionsRequest, request: Request) -> JSONResponse:
    _require_localhost(request)
    try:
        keep = normalize_session_id(payload.keep_session_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid session")
    deleted = delete_all_sessions(except_session_ids=[keep])
    return JSONResponse({"ok": True, "deleted": deleted, "kept": keep})


@app.post("/api/session/{session_id}/document")
async def save_doc(session_id: str, payload: SessionDocRequest) -> JSONResponse:
    try:
        sid = normalize_session_id(session_id)
        save_document(sid, payload.markdown or "")
        return JSONResponse({"ok": True})
    except FileNotFoundError:
        raise HTTPException(status_code=404, detail="Session not found")
    except Exception:
        raise HTTPException(status_code=400, detail="Bad request")


@app.post("/api/session/{session_id}/paste-image")
async def paste_image(session_id: str, file: UploadFile = File(...)) -> JSONResponse:
    """Save a pasted image into /tmp/mdpdf/<session_id>/images/ (OS temp dir on Windows).

    Returns a *relative* path (images/<uuid>.<ext>) suitable for inserting into the editor.
    """
    try:
        sid = normalize_session_id(session_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid session")

    # Limit read to prevent accidental huge clipboard uploads.
    data = await file.read(MAX_IMAGE_UPLOAD_BYTES + 1)
    if len(data) > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")

    rel = save_pasted_image(sid, data, file.content_type)
    return JSONResponse({"relative_path": rel})


@app.get("/s/{session_id}/images/{filename}")
async def get_session_image(session_id: str, filename: str) -> Response:
    """Serve session images securely.

    Security:
    - session_id must be a strict UUID
    - filename must be a basename (no directories)
    - only allowed image extensions
    - safe_join ensures it cannot escape the workspace
    """
    try:
        sid = normalize_session_id(session_id)
    except Exception:
        raise HTTPException(status_code=404, detail="Not found")

    if not is_safe_basename(filename):
        raise HTTPException(status_code=404, detail="Not found")
    ext = Path(filename).suffix.lower()
    if ext not in ALLOWED_IMAGE_EXTS:
        raise HTTPException(status_code=404, detail="Not found")

    ws = get_session_workspace(sid)
    if not ws.images_dir.exists():
        raise HTTPException(status_code=404, detail="Not found")
    try:
        path = safe_join(ws.images_dir, filename)
    except Exception:
        raise HTTPException(status_code=404, detail="Not found")
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Not found")

    touch_session(sid)
    # FileResponse sets correct content-length; add nosniff for safety.
    return FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@app.post("/api/session/{session_id}/export-zip")
async def export_zip(session_id: str, payload: SessionDocRequest, request: Request) -> Response:
    """Export a ZIP containing document.md and referenced images/.* only."""
    try:
        sid = normalize_session_id(session_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid session")

    markdown_text = payload.markdown or ""
    save_document(sid, markdown_text)

    ws = get_session_workspace(sid)
    referenced = find_referenced_workspace_images(markdown_text)
    images_bytes: dict[str, bytes] = {}
    for basename in referenced:
        try:
            image_path = safe_join(ws.images_dir, basename)
        except Exception:
            continue
        if image_path.exists() and image_path.is_file():
            try:
                images_bytes[basename] = image_path.read_bytes()
            except Exception:
                continue

    zip_bytes = build_export_zip(markdown_text, images_bytes)

    # Filename is decided client-side; default here is generic.
    headers = {
        "Content-Disposition": 'attachment; filename="document.zip"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    return Response(content=zip_bytes, media_type="application/zip", headers=headers)


@app.post("/api/import-zip")
async def import_zip(file: UploadFile = File(...)) -> JSONResponse:
    """Validate and import a ZIP into a new session workspace."""
    zip_bytes = await file.read(MAX_ZIP_UPLOAD_BYTES + 1)
    if len(zip_bytes) > MAX_ZIP_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="ZIP too large")

    try:
        imported = import_zip_bytes(zip_bytes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ws = create_new_session()
    # Write images into workspace/images and return markdown for editor.
    write_imported_images(ws.images_dir, imported.images)
    rewritten_md = rewrite_markdown_image_urls(imported.markdown_text, set(imported.images.keys()))
    save_document(ws.session_id, rewritten_md)
    return JSONResponse({"session_id": ws.session_id, "markdown": rewritten_md})




# Static file hosting (so you can open http://localhost:8010/)
# Note: define API routes above, then mount static at '/'.
app.mount("/", StaticFiles(directory=str(BASE_DIR), html=True), name="static")


if __name__ == "__main__":
    # Convenience: python server.py
    import uvicorn

    port = int(os.environ.get("PORT", "8010"))
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)
