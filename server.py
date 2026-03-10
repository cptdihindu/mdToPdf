from __future__ import annotations

import os
import re
import sys
import asyncio
import subprocess
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
from mdpdf_backend.layout_transform import transform_layout_rows


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
    while True:
        try:
            cleanup_expired_sessions()
        except Exception:
            pass
        try:
            await asyncio.sleep(max(30, CLEANUP_INTERVAL_SECONDS))
        except asyncio.CancelledError:
            break


@asynccontextmanager
async def lifespan(app: FastAPI):
    print("✓ Server starting (Playwright browsers should be pre-installed)")
    try:
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
        except asyncio.CancelledError:
            pass
        except Exception:
            pass


app = FastAPI(lifespan=lifespan)

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
    if path.endswith((".css", ".js", ".html")) and not path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


@app.post("/api/pdf")
async def render_pdf(payload: PdfRequest, request: Request) -> Response:
    html = payload.html or ""

    def add_heading_ids(html_text: str) -> str:
        import re
        import html as _html

        heading_re = re.compile(r'<h([1-6])([^>]*)>(.*?)</h\1>', re.IGNORECASE | re.DOTALL)

        def slugify_base(text: str) -> str:
            t = re.sub(r'<[^>]+>', '', str(text or ''))
            t = _html.unescape(t)
            t = re.sub(r'^#+\s*', '', t.strip())
            t = re.sub(r'[\s\-_.]+', '-', t)
            t = re.sub(r'[^a-z0-9\-]', '', t.lower())
            return t.strip('-')

        def repl(m: re.Match) -> str:
            level, attrs, inner = m.group(1), m.group(2), m.group(3)
            base = slugify_base(inner)
            if not base:
                return m.group(0)
            anchor = base if str(level) == '1' else f'h{level}-{base}'
            attrs_no_id = re.sub(r'\s+id\s*=\s*(["\"]).*?\1', '', attrs, flags=re.IGNORECASE)
            attrs_no_id = re.sub(r"\s+id\s*=\s*(['\"]).*?\1", '', attrs_no_id, flags=re.IGNORECASE)
            return f'<h{level}{attrs_no_id} id="{anchor}">{inner}</h{level}>'

        return heading_re.sub(repl, html_text)

    def split_long_code_blocks(html_text: str, max_lines: int = 20, max_chars: int = 1000) -> str:
        pre_re = re.compile(r"<pre(\s[^>]*)?>(.*?)</pre>", re.IGNORECASE | re.DOTALL)

        def split_pre(m: re.Match) -> str:
            attrs = m.group(1) or ""
            code = m.group(2) or ""
            lines = str(code).split("\n")
            blocks: list[str] = []
            i = 0
            while i < len(lines):
                chunk_lines: list[str] = []
                chunk_chars = 0
                while i < len(lines) and len(chunk_lines) < max_lines and (chunk_chars + len(lines[i])) <= max_chars:
                    chunk_lines.append(lines[i])
                    chunk_chars += len(lines[i])
                    i += 1
                joined = "\n".join(chunk_lines)
                blocks.append(f"<pre{attrs}>{joined}</pre>")
            return "".join(blocks)

        return pre_re.sub(split_pre, html_text or "")

    try:
        html = transform_layout_rows(html).html
    except Exception:
        pass

    html = add_heading_ids(html)
    html = split_long_code_blocks(html, max_lines=20, max_chars=1000)

    if payload.session_id:
        try:
            sid = normalize_session_id(payload.session_id)
            touch_session(sid)
            base_href = f"{request.base_url}s/{sid}/"
            if "<head" in html.lower():
                def _insert_base(m: re.Match) -> str:
                    return f"{m.group(1)}\n        <base href=\"{base_href}\" />"
                html = re.sub(r"(<head[^>]*>)", _insert_base, html, count=1, flags=re.IGNORECASE)
            else:
                html = f"<base href=\"{base_href}\" />\n" + html
        except Exception:
            pass

    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        await page.set_content(html, wait_until="networkidle")
        try:
            await page.evaluate("""async () => { if (document.fonts && document.fonts.ready) { await document.fonts.ready; } }""")
        except Exception:
            pass
        pdf_bytes = await page.pdf(format="A4", print_background=True, margin={"top": "0", "right": "0", "bottom": "0", "left": "0"})
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
        pass
    return JSONResponse({"ok": True})


def _require_localhost(request: Request) -> None:
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
    try:
        sid = normalize_session_id(session_id)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid session")

    data = await file.read(MAX_IMAGE_UPLOAD_BYTES + 1)
    if len(data) > MAX_IMAGE_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")

    rel = save_pasted_image(sid, data, file.content_type)
    return JSONResponse({"relative_path": rel})


@app.get("/s/{session_id}/images/{filename}")
async def get_session_image(session_id: str, filename: str) -> Response:
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
    return FileResponse(path, headers={"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff"})


@app.post("/api/session/{session_id}/export-zip")
async def export_zip(session_id: str, payload: SessionDocRequest, request: Request) -> Response:
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

    if not images_bytes:
        headers = {
            "Content-Disposition": 'attachment; filename="document.md"',
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        }
        return Response(
            content=(markdown_text or "").encode("utf-8"),
            media_type="text/markdown; charset=utf-8",
            headers=headers,
        )

    zip_bytes = build_export_zip(markdown_text, images_bytes)
    headers = {
        "Content-Disposition": 'attachment; filename="document.zip"',
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    }
    return Response(content=zip_bytes, media_type="application/zip", headers=headers)


@app.post("/api/import-zip")
async def import_zip(file: UploadFile = File(...)) -> JSONResponse:
    zip_bytes = await file.read(MAX_ZIP_UPLOAD_BYTES + 1)
    if len(zip_bytes) > MAX_ZIP_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="ZIP too large")

    try:
        imported = import_zip_bytes(zip_bytes)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    ws = create_new_session()
    write_imported_images(ws.images_dir, imported.images)
    rewritten_md = rewrite_markdown_image_urls(imported.markdown_text, set(imported.images.keys()))
    save_document(ws.session_id, rewritten_md)
    return JSONResponse({"session_id": ws.session_id, "markdown": rewritten_md})


# ==================== AI Chat with Google Gemini ====================
from datetime import datetime, timedelta
import json

# Store quota info from Gemini API headers
quota_info = {
    "remaining": 1500,  # Default for Gemini free tier
    "limit": 1500,
    "resetTime": None,
    "resetType": "daily"
}


class AiChatRequest(BaseModel):
    message: str
    markdown: str = ""
    css: str = ""
    formattingExamples: str = ""
    conversationHistory: list = []  # Track conversation history


def get_groq_api_key() -> Optional[str]:
    """Get Groq API key from environment variable."""
    return os.environ.get("GROQ_API_KEY")


def count_line_changes(old_text: str, new_text: str) -> dict:
    """Count insertions and deletions between two texts."""
    old_lines = old_text.split('\n')
    new_lines = new_text.split('\n')
    
    # Simple diff: count added and removed lines
    # Use a basic diff algorithm or just count totals
    old_set = set(old_lines)
    new_set = set(new_lines)
    
    insertions = len([line for line in new_lines if line not in old_set])
    deletions = len([line for line in old_lines if line not in new_set])
    
    return {
        "insertions": insertions,
        "deletions": deletions
    }


def _escape_control_chars_in_json_strings(src: str) -> str:
    """Escape literal control characters that appear *inside* JSON strings.

    Gemini occasionally returns JSON-like text where string values contain literal
    newlines (\n) or tabs, which makes the JSON invalid. This function scans the
    text and replaces control characters only when we are inside a quoted JSON
    string, leaving structural whitespace intact.
    """
    if not src:
        return src

    out: list[str] = []
    in_string = False
    escaping = False

    for ch in src:
        if not in_string:
            if ch == '"':
                in_string = True
                escaping = False
            out.append(ch)
            continue

        # in_string == True
        if escaping:
            out.append(ch)
            escaping = False
            continue

        if ch == "\\":
            out.append(ch)
            escaping = True
            continue

        if ch == '"':
            out.append(ch)
            in_string = False
            continue

        # Escape literal control chars inside string values
        if ch == "\n":
            out.append("\\n")
            continue
        if ch == "\r":
            out.append("\\r")
            continue
        if ch == "\t":
            out.append("\\t")
            continue

        out.append(ch)

    return "".join(out)


def _extract_first_json_object(text: str) -> Optional[str]:
    """Extract the first top-level JSON object from a string.

    Uses a small state machine so braces inside strings don't break extraction.
    Returns None if no object is found.
    """
    if not text:
        return None

    start = text.find('{')
    if start < 0:
        return None

    depth = 0
    in_string = False
    escaping = False

    for i in range(start, len(text)):
        ch = text[i]

        if in_string:
            if escaping:
                escaping = False
            elif ch == "\\":
                escaping = True
            elif ch == '"':
                in_string = False
            continue

        # not in_string
        if ch == '"':
            in_string = True
            escaping = False
            continue

        if ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                return text[start : i + 1]

    return None


@app.post("/api/ai/chat")
async def ai_chat(request: AiChatRequest):
    """Handle AI chat requests using Groq API with smart Search/Replace edits."""
    api_key = get_groq_api_key()
    
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="AI chat is not configured. Please set GROQ_API_KEY environment variable."
        )
    
    try:
        import httpx
        
        # Build context for AI with NEW Diff-based instructions
        system_instruction = f"""You are a helpful AI coding assistant for a Markdown editor.
You are strictly a JSON generator. You do not output conversational text outside of the JSON object.

Input Context:
- User is editing a Markdown file (and optionally CSS).
- You will receive the current file content.

Task:
- If the user asks a question, answer in the "message" field.
- If the user asks for changes, generate a list of "edits".

CRITICAL RULES FOR EDITING:
1. DO NOT return the full file unless necessary. Use "edits" to patch the file.
2. Formulate your edits using the "edits" array. Each edit has:
   - "target": "markdown" or "css"
   - "search": The EXACT string to find as it appears in the Current Markdown. Must match character-for-character, including whitespace.
   - "replace": The new string to replace it with.
3. Special Search Tokens:
   - "search": "__ALL__" -> Replaces the ENTIRE file content. Use this if the file is empty or major rewrite is needed.
   - "search": "__END__" -> Appends content to the end of the file.
4. If "search" is empty string "" and the file is empty, it acts like "__ALL__".
5. For deletions, set "replace" to empty string.
6. For insertions in the middle, include the surrounding context in "search" and add your new content in "replace".

Response Format (JSON ONLY):
{{
  "message": "Friendly response describing what you did.",
  "edits": [
    {{
      "target": "markdown", 
      "search": "exact string to replace",
      "replace": "new content"
    }}
  ]
}}

Current Markdown:
```markdown
{request.markdown}
```

Current CSS:
```css
{request.css}
```
"""

        # Build messages in OpenAI format (Groq is OpenAI-compatible)
        messages = [{"role": "system", "content": system_instruction}]

        # Add conversation history
        if request.conversationHistory:
            for msg in request.conversationHistory:
                if msg.get('role') and msg.get('content'):
                    messages.append({
                        "role": msg['role'],  # 'user' or 'assistant'
                        "content": msg['content']
                    })

        # Add current user prompt
        messages.append({"role": "user", "content": request.message})

        # Call Groq API
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                "https://api.groq.com/openai/v1/chat/completions",
                headers={
                    "Content-Type": "application/json",
                    "Authorization": f"Bearer {api_key}"
                },
                json={
                    "model": "llama-3.3-70b-versatile",
                    "messages": messages,
                    "temperature": 0.3,
                    "max_tokens": 32768,
                    "response_format": {"type": "json_object"}
                }
            )

        if response.status_code != 200:
            raise HTTPException(
                status_code=response.status_code,
                detail=f"Groq API error: {response.text}"
            )

        try:
            if 'x-ratelimit-remaining-requests' in response.headers:
                quota_info["remaining"] = int(response.headers.get('x-ratelimit-remaining-requests', 1500))
                quota_info["limit"] = int(response.headers.get('x-ratelimit-limit-requests', 1500))
        except:
            pass

        result = response.json()
        ai_response_text = result["choices"][0]["message"]["content"]
        
        # Parse AI response
        import json
        import re

        def _extract_and_parse_json(text: str):
            """Robustly extract and parse JSON from AI response."""
            text = text.strip()
            
            # 1. Try stripping markdown blocks
            if text.startswith("```"):
                # Remove first line (```json) and last line (```)
                lines = text.split('\n')
                if len(lines) >= 2:
                    text = '\n'.join(lines[1:-1])

            # 2. Try extracting a JSON object from surrounding text
            candidate = _extract_first_json_object(text) or text

            # 3. Parse attempts:
            #    - raw candidate
            #    - candidate with control chars escaped only inside strings
            attempts = [candidate]
            attempts.append(_escape_control_chars_in_json_strings(candidate))

            for attempt in attempts:
                try:
                    return json.loads(attempt)
                except json.JSONDecodeError as _e:
                    print(f"[JSON parse attempt failed] {type(_e).__name__}: {_e} (pos={_e.pos}, lineno={_e.lineno})")
                    continue

            # 4. Last resort: try regex greedy block (older behavior)
            match = re.search(r'\{.*\}', text, re.DOTALL)
            if match:
                block = match.group(0)
                for attempt in (block, _escape_control_chars_in_json_strings(block)):
                    try:
                        return json.loads(attempt)
                    except json.JSONDecodeError as _e:
                        print(f"[JSON parse last-resort failed] {type(_e).__name__}: {_e}")
                        continue

            print(f"[JSON parse TOTAL FAILURE] raw text head: {text[:200]!r}")
            return None

        ai_data = _extract_and_parse_json(ai_response_text)
        
        if not isinstance(ai_data, dict):
            # Fallback for repair failure
            # Try one last desperate measure: strict mode=False provided by some libs? No.
            # Assume it is raw text if it looks like conversation
            ai_data = {
                "message": ai_response_text,
                "newMarkdown": None,
                "newCss": None,
                "edits": []
            }
        
        # Apply Edits
        new_markdown = request.markdown
        new_css = request.css
        
        edits = ai_data.get("edits", [])
        
        if edits:
            for edit in edits:
                target = edit.get("target", "markdown")
                search_str = edit.get("search")
                replace_str = edit.get("replace", "")
                
                # Check for None explicitly
                if search_str is None:
                    continue
                    
                if target == "markdown":
                    if search_str == "__ALL__":
                        new_markdown = replace_str
                    elif search_str == "__END__":
                        if new_markdown:
                            new_markdown = new_markdown + "\n\n" + replace_str
                        else:
                            new_markdown = replace_str
                    elif search_str == "" and len(new_markdown.strip()) == 0:
                        new_markdown = replace_str
                    elif search_str in new_markdown:
                        new_markdown = new_markdown.replace(search_str, replace_str, 1)
                
                elif target == "css":
                    if search_str == "__ALL__":
                        new_css = replace_str
                    elif search_str == "__END__":
                        new_css = new_css + "\n" + replace_str
                    elif search_str == "" and len(new_css.strip()) == 0:
                        new_css = replace_str
                    elif search_str in new_css:
                         new_css = new_css.replace(search_str, replace_str, 1)

        # Calculate changes/stats
        response_markdown = None
        response_css = None
        changes = {"insertions": 0, "deletions": 0}
        
        if new_markdown != request.markdown:
             response_markdown = new_markdown
             md_changes = count_line_changes(request.markdown, new_markdown)
             changes["insertions"] += md_changes["insertions"]
             changes["deletions"] += md_changes["deletions"]
             
        if new_css != request.css:
             response_css = new_css
             css_changes = count_line_changes(request.css, new_css)
             changes["insertions"] += css_changes["insertions"]
             changes["deletions"] += css_changes["deletions"]

        return JSONResponse({
            "message": ai_data.get("message", "Processed."),
            "newMarkdown": response_markdown,
            "newCss": response_css,
            "changes": changes
        })

    except Exception as e:
        print(f"AI Error: {str(e)}")
        err_msg = str(e)
        # Surface rate-limit info clearly
        if "429" in err_msg or "rate" in err_msg.lower():
            err_msg = "⏳ Rate limit hit — please wait a moment and try again."
        elif "401" in err_msg or "auth" in err_msg.lower():
            err_msg = "🔑 Invalid API key — check your GROQ_API_KEY."
        return JSONResponse({
            "message": err_msg,
            "newMarkdown": None,
            "newCss": None,
            "changes": {"insertions": 0, "deletions": 0}
        })


@app.get("/api/ai/quota")
async def get_ai_quota():
    """Get current AI quota status from Gemini API."""
    return quota_info


# Static file hosting (so you can open http://localhost:8010/)
# Note: define API routes above, then mount static at '/'.
app.mount("/", StaticFiles(directory=str(BASE_DIR), html=True), name="static")

if __name__ == "__main__":
    import uvicorn
    import sys
    import importlib
    
    REQUIRED_MODULES = [
        "fastapi",
        "uvicorn",
        "playwright.async_api",
        "pydantic",
        "multipart",
        "bs4",
    ]

    missing = []
    for mod in REQUIRED_MODULES:
        try:
            importlib.import_module(mod)
        except ImportError:
            missing.append(mod)

    if missing:
        print("\nERROR: Missing required packages:")
        for m in missing:
            print(f"  - {m}")
        print("\nPlease install all requirements with:\n  pip install -r requirements.txt\n")
        sys.exit(1)

    port = int(os.environ.get("PORT", "8010"))
    host = os.environ.get("HOST", "0.0.0.0")
    uvicorn.run("server:app", host=host, port=port, reload=False)
