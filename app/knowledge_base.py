from __future__ import annotations

import json
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
KB_DIR = BASE_DIR / "data" / "knowledge_base"

_TOKEN_RE = re.compile(r"[A-Za-zА-Яа-яЁё0-9.+~/-]+")


def _load_json(name: str, default: Any) -> Any:
    path = KB_DIR / name
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, TypeError):
        return default


@lru_cache(maxsize=1)
def load_knowledge_base() -> dict[str, Any]:
    machine = _load_json("machine_profile.json", {})
    documents = _load_json("documents.json", [])
    entries = _load_json("entries.json", [])
    g_codes = _load_json("g_codes.json", [])
    m_codes = _load_json("m_codes.json", [])

    normalized: list[dict[str, Any]] = []
    for item in entries:
        normalized.append({**item, "kind": "article"})
    for item in g_codes:
        normalized.append({
            "id": f"gcode:{item.get('code', '')}",
            "kind": "g_code",
            "category": "g_codes",
            "title": f"{item.get('code', '')} — {item.get('title_ru', '')}",
            "summary": item.get("description_en") or item.get("description_uk") or item.get("title_ru", ""),
            "keywords": [item.get("code", ""), item.get("category", ""), item.get("title_ru", "")],
            "source": item.get("source", {}),
            "trust": item.get("trust", "reference_verify_version"),
            "safety": "verify_version_and_machine_options",
            "raw": item,
        })
    for item in m_codes:
        normalized.append({
            "id": f"mcode:{item.get('code', '')}",
            "kind": "m_code",
            "category": "m_codes",
            "title": f"{item.get('code', '')} — {item.get('title_ru', '')}",
            "summary": item.get("description_en") or item.get("description_uk") or item.get("title_ru", ""),
            "keywords": [item.get("code", ""), item.get("title_ru", ""), item.get("description_en", "")],
            "source": item.get("source", {}),
            "trust": item.get("trust", "unverified_oem"),
            "safety": "hard_block_unverified" if item.get("trust") != "common_verify_on_machine" else "verify_on_machine",
            "raw": item,
        })

    return {
        "machine": machine,
        "documents": documents,
        "entries": normalized,
        "counts": {
            "documents": len(documents),
            "articles": len(entries),
            "g_codes": len(g_codes),
            "m_codes": len(m_codes),
            "total_entries": len(normalized),
        },
    }


def _tokens(value: str) -> set[str]:
    return {token.lower() for token in _TOKEN_RE.findall(value or "") if len(token) > 1}


def _search_text(item: dict[str, Any]) -> tuple[str, str, str]:
    title = str(item.get("title") or "")
    summary = str(item.get("summary") or "")
    keywords = " ".join(str(value) for value in item.get("keywords", []) if value)
    raw = item.get("raw") if isinstance(item.get("raw"), dict) else {}
    extra = " ".join(str(raw.get(key) or "") for key in ("description_uk", "description_en", "description_zh", "category"))
    return title, keywords, f"{summary} {extra}"


def search_knowledge(query: str, *, category: str | None = None, limit: int = 12) -> list[dict[str, Any]]:
    kb = load_knowledge_base()
    query = (query or "").strip()
    q_tokens = _tokens(query)
    exact = query.lower()
    results: list[tuple[float, dict[str, Any]]] = []
    for item in kb["entries"]:
        if category and category not in {"all", item.get("category"), item.get("kind")}:
            continue
        title, keywords, body = _search_text(item)
        title_l, keywords_l, body_l = title.lower(), keywords.lower(), body.lower()
        if not query:
            score = 1.0 if item.get("kind") == "article" else 0.25
        else:
            title_tokens = _tokens(title)
            keyword_tokens = _tokens(keywords)
            body_tokens = _tokens(body)
            score = 0.0
            score += 7.0 * len(q_tokens & title_tokens)
            score += 5.0 * len(q_tokens & keyword_tokens)
            score += 1.5 * len(q_tokens & body_tokens)
            if exact and exact in title_l:
                score += 15.0
            if exact and exact in keywords_l:
                score += 10.0
            if exact and exact in body_l:
                score += 3.0
            # Exact NC/M-code searches must win even with punctuation variants.
            compact_query = re.sub(r"\s+", "", exact).upper()
            compact_title = re.sub(r"\s+", "", title).upper()
            if compact_query and compact_query in compact_title:
                score += 20.0
        if score > 0:
            results.append((score, item))
    results.sort(key=lambda pair: (-pair[0], str(pair[1].get("title") or "")))
    clean: list[dict[str, Any]] = []
    for score, item in results[: max(1, min(limit, 50))]:
        clean.append({
            "id": item.get("id"),
            "kind": item.get("kind"),
            "category": item.get("category"),
            "title": item.get("title"),
            "summary": item.get("summary"),
            "source": item.get("source"),
            "trust": item.get("trust"),
            "safety": item.get("safety"),
            "score": round(score, 2),
            "raw": item.get("raw") if item.get("kind") in {"g_code", "m_code"} else None,
        })
    return clean


def knowledge_summary() -> dict[str, Any]:
    kb = load_knowledge_base()
    machine = kb["machine"]
    return {
        "ok": bool(machine and kb["entries"]),
        "counts": kb["counts"],
        "machine": machine,
        "documents": kb["documents"],
        "categories": ["machine", "shopturn", "nc", "turn_mill", "tooling", "threading", "diagnostics", "safety", "g_codes", "m_codes"],
        "policy": {
            "primary_manual": "SINUMERIK 828D NC Programming V4.95",
            "shopturn_manual": "Turning Operating Manual V5.25 — workflow supplement",
            "oem_m_codes": "blocked until confirmed for CK52DWY",
            "automatic_mpf": machine.get("release_policy", {}).get("automatic_mpf", False),
        },
    }


def build_knowledge_context(query: str, *, limit: int = 8) -> str:
    kb = load_knowledge_base()
    machine = kb.get("machine", {})
    found = search_knowledge(query, limit=limit)
    control = machine.get("control", {}) if isinstance(machine, dict) else {}
    lines = [
        "ЛОКАЛЬНАЯ БАЗА ПРОЕКТА CK52DWY / SINUMERIK 828D:",
        f"- Станок: {machine.get('name', 'CK52DWY')}; стойка {control.get('family', 'SINUMERIK 828D')} {control.get('cnc_software', 'V4.95')}.",
        "- Оси X/Z/Y подтверждены по экрану; C, приводной инструмент и задняя бабка предусмотрены OEM, но их пределы и M-коды не подтверждены.",
        "- Основной источник NC-синтаксиса: Programming Manual V4.95. ShopTurn V5.25 используется только как дополнение по рабочему процессу.",
        "- Неподтверждённые OEM M-коды патрона, C-оси, револьвера, щупа и задней бабки запрещено выдавать как готовые команды.",
    ]
    if found:
        lines.append("РЕЛЕВАНТНЫЕ ЗАПИСИ БАЗЫ:")
        for index, item in enumerate(found, 1):
            source = item.get("source") or {}
            source_name = source.get("document") or source.get("ref") or source.get("type") or "локальная база"
            pages = source.get("pages")
            page_text = f", стр. {', '.join(map(str, pages))}" if isinstance(pages, list) and pages else ""
            lines.append(
                f"{index}. {item.get('title')}: {item.get('summary')} "
                f"[источник: {source_name}{page_text}; доверие: {item.get('trust')}; безопасность: {item.get('safety')}]"
            )
    return "\n".join(lines)
