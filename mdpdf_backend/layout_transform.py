from __future__ import annotations

from dataclasses import dataclass
from typing import Iterable

from bs4 import BeautifulSoup
from bs4.element import Tag


@dataclass(frozen=True)
class LayoutTransformResult:
    html: str
    transformed_rows: int


def _merge_class_list(existing: object, add: Iterable[str]) -> list[str]:
    current: list[str] = []
    if isinstance(existing, list):
        current = [str(x) for x in existing if str(x).strip()]
    elif isinstance(existing, str):
        current = [p for p in existing.split() if p.strip()]

    for c in add:
        c = str(c).strip()
        if c and c not in current:
            current.append(c)
    return current


def _merge_style(existing: object, add_css: str) -> str:
    base = str(existing or "").strip()
    add = str(add_css or "").strip()
    if not add:
        return base
    if not base:
        return add
    if base.endswith(";"):
        return f"{base} {add}"
    return f"{base}; {add}"


def transform_layout_rows(html_text: str) -> LayoutTransformResult:
    """Transform custom <row>/<col> tags into <div class="layout-row/col">.

    Rules:
    - Detect all <row> blocks.
    - Inside each <row>, detect direct-child <col> elements.
    - Ignore <row cols="..."> and infer the number of columns from actual <col> tags.
    - Future-proof: if <col width="30%"> is present, attach width styles to the output.

    This intentionally avoids regex-based nested parsing by using BeautifulSoup.
    """

    raw = html_text or ""
    lowered = raw.lower()
    if "<row" not in lowered and "<md-row" not in lowered:
        return LayoutTransformResult(html=raw, transformed_rows=0)

    soup = BeautifulSoup(raw, "html.parser")
    rows = [r for r in soup.find_all(["row", "md-row"]) if isinstance(r, Tag)]

    transformed = 0
    for row in rows:
        # Only convert if we have at least one direct <col>.
        col_tags = [c for c in row.find_all(["col", "md-col"], recursive=False) if isinstance(c, Tag)]
        if not col_tags:
            continue

        row_div = soup.new_tag("div")
        row_div["class"] = _merge_class_list(row_div.get("class"), ["layout-row"])

        for col in col_tags:
            col_div = soup.new_tag("div")
            col_div["class"] = _merge_class_list(col_div.get("class"), ["layout-col"])

            width = col.get("width")
            if width is not None:
                width_str = str(width).strip()
                if width_str:
                    col_div["data-col-width"] = width_str
                    col_div["style"] = _merge_style(
                        col_div.get("style"),
                        f"flex: 0 0 {width_str}; max-width: {width_str};",
                    )

            # Move children into the new column div (preserves nested markup).
            for child in list(col.contents):
                try:
                    col_div.append(child.extract())
                except Exception:
                    # If extraction fails for any reason, skip that child.
                    pass

            row_div.append(col_div)

        row.replace_with(row_div)
        transformed += 1

    return LayoutTransformResult(html=str(soup), transformed_rows=transformed)
