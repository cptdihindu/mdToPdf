from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from playwright.async_api import async_playwright


BASE_DIR = Path(__file__).resolve().parent


class PdfRequest(BaseModel):
    html: str
    filename: str = "document.pdf"


app = FastAPI()

# Allow the browser app to call the API even when index.html is opened from disk
# (file:// pages send Origin: null, which otherwise fails CORS).
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/api/pdf")
async def render_pdf(payload: PdfRequest) -> Response:
    # Generate a selectable-text PDF by printing the provided HTML in headless Chromium.
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()

        await page.set_content(payload.html, wait_until="networkidle")

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


# Static file hosting (so you can open http://localhost:8000/)
# Note: define API routes above, then mount static at '/'.
app.mount("/", StaticFiles(directory=str(BASE_DIR), html=True), name="static")


if __name__ == "__main__":
    # Convenience: python server.py
    import uvicorn

    port = int(os.environ.get("PORT", "8000"))
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)
