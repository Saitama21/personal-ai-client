from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import PageBreak, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

FONT_REG = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
try:
    pdfmetrics.registerFont(TTFont("DV", FONT_REG))
    pdfmetrics.registerFont(TTFont("DV-Bold", FONT_BOLD))
except Exception:
    pass


def cache_dir(data_dir: Path) -> Path:
    path = data_dir / "manual_translations"
    path.mkdir(parents=True, exist_ok=True)
    return path


def cache_path(data_dir: Path, manual_id: str, page: int) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", manual_id)
    return cache_dir(data_dir) / f"{safe}_p{page:05d}.json"


def load_cached_translation(data_dir: Path, manual_id: str, page: int) -> dict[str, Any] | None:
    path = cache_path(data_dir, manual_id, page)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def save_cached_translation(data_dir: Path, payload: dict[str, Any]) -> Path:
    path = cache_path(data_dir, str(payload["manual_id"]), int(payload["page"]))
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


def list_cached_translations(data_dir: Path, manual_id: str | None = None) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for path in sorted(cache_dir(data_dir).glob("*.json")):
        try:
            item = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if manual_id and item.get("manual_id") != manual_id:
            continue
        result.append(item)
    return result


def _safe_para(text: str) -> str:
    import html
    return html.escape(text or "").replace("\n", "<br/>")


def build_translation_pdf(
    output: Path,
    *,
    manual: dict[str, Any],
    translations: list[dict[str, Any]],
    title: str | None = None,
) -> Path:
    output.parent.mkdir(parents=True, exist_ok=True)
    styles = getSampleStyleSheet()
    base = ParagraphStyle("BaseRU", parent=styles["BodyText"], fontName="DV", fontSize=9.2, leading=12.5, spaceAfter=5)
    h1 = ParagraphStyle("H1RU", parent=styles["Heading1"], fontName="DV-Bold", fontSize=18, leading=22, textColor=colors.HexColor("#133250"), alignment=TA_CENTER, spaceAfter=12)
    h2 = ParagraphStyle("H2RU", parent=styles["Heading2"], fontName="DV-Bold", fontSize=13, leading=16, textColor=colors.HexColor("#0A6B61"), spaceBefore=6, spaceAfter=8)
    note = ParagraphStyle("NoteRU", parent=base, fontSize=8, leading=10, textColor=colors.HexColor("#5F6B7A"))
    doc = SimpleDocTemplate(str(output), pagesize=A4, rightMargin=16*mm, leftMargin=16*mm, topMargin=15*mm, bottomMargin=15*mm, title=title or manual.get("title", "Перевод"))
    story: list[Any] = []
    story.append(Paragraph(_safe_para(title or f"Русский перевод: {manual.get('title','')}"), h1))
    meta = [
        ["Оригинал", manual.get("filename", "")],
        ["Редакция", manual.get("edition", "")],
        ["Версия ПО", manual.get("software", "")],
        ["Переведено страниц", str(len(translations))],
    ]
    tbl = Table(meta, colWidths=[40*mm, 130*mm])
    tbl.setStyle(TableStyle([
        ("FONTNAME", (0,0), (-1,-1), "DV"), ("FONTNAME", (0,0), (0,-1), "DV-Bold"),
        ("BACKGROUND", (0,0), (0,-1), colors.HexColor("#E7F0F8")),
        ("GRID", (0,0), (-1,-1), 0.4, colors.HexColor("#B8C7D6")),
        ("VALIGN", (0,0), (-1,-1), "TOP"), ("FONTSIZE", (0,0), (-1,-1), 8.5),
        ("LEFTPADDING", (0,0), (-1,-1), 6), ("RIGHTPADDING", (0,0), (-1,-1), 6),
    ]))
    story.extend([tbl, Spacer(1, 8), Paragraph("Перевод предназначен для рабочего использования. Команды, параметры и OEM-функции необходимо сверять с оригиналом и конкретной комплектацией станка.", note), PageBreak()])
    for idx, item in enumerate(sorted(translations, key=lambda x: int(x.get("page", 0)))):
        page = int(item.get("page", 0))
        story.append(Paragraph(f"Страница {page}", h2))
        source_title = item.get("source_title") or ""
        if source_title:
            story.append(Paragraph(f"Заголовок оригинала: {_safe_para(source_title)}", note))
        for block in re.split(r"\n\s*\n", str(item.get("translation") or "").strip()):
            if block.strip():
                story.append(Paragraph(_safe_para(block.strip()), base))
        if idx != len(translations)-1:
            story.append(PageBreak())
    doc.build(story)
    return output
