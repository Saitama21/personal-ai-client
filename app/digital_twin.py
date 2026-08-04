from __future__ import annotations

import json
import re
import sqlite3
from functools import lru_cache
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
DT_DIR = BASE_DIR / "app" / "resources" / "digital_twin"
DB_PATH = DT_DIR / "manual_index.sqlite3"


def _json(name: str, default: Any) -> Any:
    try:
        return json.loads((DT_DIR / name).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return default


@lru_cache(maxsize=1)
def load_digital_twin() -> dict[str, Any]:
    profile = _json("machine_profile.json", {})
    manuals = _json("manuals.json", [])
    photos = _json("photo_manifest.json", [])
    glossary = _json("query_glossary.json", {})
    page_count = sum(int(item.get("pages") or 0) for item in manuals)
    return {
        "profile": profile,
        "manuals": manuals,
        "photos": photos,
        "glossary": glossary,
        "counts": {
            "manuals": len(manuals),
            "manual_pages": page_count,
            "photos": len(photos),
        },
        "ready": bool(profile and manuals and photos and DB_PATH.exists()),
    }


def _tokens(text: str) -> list[str]:
    return re.findall(r"[A-Za-zА-Яа-яЁё0-9_.+/-]+", text or "")


def expand_query(query: str) -> str:
    twin = load_digital_twin()
    q = (query or "").strip()
    terms = _tokens(q)
    low = q.lower()
    for ru, values in twin.get("glossary", {}).items():
        if ru in low:
            terms.extend(str(value) for value in values)
    # add compact variants for NC/M codes
    for token in list(terms):
        compact = re.sub(r"\s+", "", token.upper())
        if re.fullmatch(r"(?:G|M|CYCLE)\d+(?:\.\d+)?", compact):
            terms.append(compact)
    seen: set[str] = set()
    clean: list[str] = []
    for term in terms:
        t = term.strip().replace('"', '')
        if len(t) < 2:
            continue
        key = t.lower()
        if key not in seen:
            seen.add(key)
            clean.append(t)
    return " OR ".join(f'"{term}"' for term in clean[:40])


def get_manual_page(manual_id: str, page: int) -> dict[str, Any] | None:
    if not DB_PATH.exists() or page < 1:
        return None
    with sqlite3.connect(DB_PATH) as con:
        con.row_factory = sqlite3.Row
        row = con.execute(
            "SELECT manual_id, page, title, text FROM manual_pages WHERE manual_id=? AND page=? LIMIT 1",
            (manual_id, page),
        ).fetchone()
    return dict(row) if row else None


def search_manuals(query: str, *, manual_id: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
    if not DB_PATH.exists() or not (query or "").strip():
        return []
    fts = expand_query(query)
    if not fts:
        return []
    sql = """
      SELECT p.manual_id, p.page, p.title,
             snippet(manual_pages, 3, '<mark>', '</mark>', ' … ', 28) AS snippet,
             bm25(manual_pages, 0.0, 0.0, 1.6, 1.0) AS rank,
             m.title AS manual_title, m.edition, m.software, m.trust, m.priority
      FROM manual_pages p
      JOIN manuals m ON m.id = p.manual_id
      WHERE manual_pages MATCH ?
    """
    params: list[Any] = [fts]
    if manual_id:
        sql += " AND p.manual_id=?"
        params.append(manual_id)
    sql += " ORDER BY rank ASC, m.priority ASC LIMIT ?"
    params.append(max(1, min(int(limit), 50)))
    try:
        with sqlite3.connect(DB_PATH) as con:
            con.row_factory = sqlite3.Row
            rows = con.execute(sql, params).fetchall()
    except sqlite3.Error:
        return []
    return [dict(row) for row in rows]


def twin_summary() -> dict[str, Any]:
    twin = load_digital_twin()
    profile = twin.get("profile", {})
    confirmed = profile.get("confirmed_by_photo", []) if isinstance(profile, dict) else []
    missing = profile.get("not_confirmed", []) if isinstance(profile, dict) else []
    total = len(confirmed) + len(missing)
    completeness = round(100 * len(confirmed) / total) if total else 0
    return {
        "ok": twin.get("ready", False),
        "counts": twin.get("counts", {}),
        "completeness_percent": completeness,
        "profile": profile,
        "manuals": twin.get("manuals", []),
        "photo_categories": sorted({str(p.get("category") or "other") for p in twin.get("photos", [])}),
        "safety": {
            "automatic_mpf": False,
            "automatic_oem_mcodes": False,
            "reason": "OEM M-коды, soft limits, безопасная парковка и механические запретные зоны не подтверждены.",
        },
    }


def build_twin_context(query: str, *, limit: int = 5) -> str:
    twin = load_digital_twin()
    if not twin.get("ready"):
        return "ЦИФРОВОЙ ДВОЙНИК НЕ ЗАГРУЖЕН: машинно-зависимые выводы считать неподтверждёнными."
    profile = twin["profile"]
    control = profile.get("control", {})
    config = profile.get("configuration", {})
    lines = [
        "ЦИФРОВОЙ ДВОЙНИК CK52PT-Y / SINUMERIK 828D:",
        f"- Профиль: {profile.get('name')}; версия двойника {profile.get('digital_twin_version')}; состояние {profile.get('status')}.",
        f"- Стойка: {control.get('family')} {control.get('variant')}, CNC {control.get('cnc_software')}.",
        f"- Оси: {json.dumps(config.get('axes', {}), ensure_ascii=False)}.",
        f"- Револьвер: {config.get('turret', {}).get('positions')} позиций; задняя бабка: {config.get('tailstock', {}).get('status')}.",
        "- Любые OEM M-коды, soft limits, координаты парковки и утверждения о столкновениях запрещено считать подтверждёнными без паспорта/проверки на станке.",
    ]
    results = search_manuals(query, limit=limit)
    if results:
        lines.append("РЕЛЕВАНТНЫЕ СТРАНИЦЫ МАНУАЛОВ:")
        for idx, item in enumerate(results, 1):
            snippet = re.sub(r"</?mark>", "", item.get("snippet") or "")
            lines.append(
                f"{idx}. {item.get('manual_title')}, стр. {item.get('page')}: {snippet} "
                f"[применимость: {item.get('trust')}; ПО: {item.get('software')}]"
            )
    return "\n".join(lines)
