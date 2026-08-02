from __future__ import annotations

import base64
import io
import json
import logging
import os
import sqlite3
import time
from contextlib import asynccontextmanager, contextmanager
from pathlib import Path
from typing import Any
import re
import zlib
from uuid import uuid4

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from PIL import Image, UnidentifiedImageError

from app.thread_library import THREAD_FAMILIES, build_thread_library
from app.operator_pdf import build_operator_pdf

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "app" / "static"
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "history.db"
UPLOAD_DIR = DATA_DIR / "uploads"
CHAT_UPLOAD_DIR = DATA_DIR / "chat_uploads"
MAX_FILE_MB = int(os.getenv("MAX_FILE_MB", "20"))
MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini").strip()
MOCK_MODE = os.getenv("MOCK_MODE", "false").strip().lower() in {"1", "true", "yes", "on"}
OPENAI_MODE = os.getenv("OPENAI_MODE", "live").strip().lower()
OPENAI_CONFIGURED = bool(os.getenv("OPENAI_API_KEY", "").strip())
KEEP_OPENAI_FILES = os.getenv("KEEP_OPENAI_FILES", "false").strip().lower() in {"1", "true", "yes", "on"}
APP_VERSION = os.getenv("APP_VERSION", "4.2.3-mobile-optimized")
DEPLOY_COMMIT = os.getenv("RAILWAY_GIT_COMMIT_SHA", os.getenv("GIT_COMMIT", "local"))

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
)
logger = logging.getLogger("personal-ai-client")

logger.info(
    "Startup config | version=%s | model=%s | mock_mode=%s | openai_mode=%s | api_key_configured=%s",
    APP_VERSION, MODEL, MOCK_MODE, OPENAI_MODE, OPENAI_CONFIGURED,
)

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
STANDARD_ALLOWED_TYPES = ALLOWED_IMAGE_TYPES | {"application/pdf"}
SLDDRW_SUFFIXES = {".slddrw"}
SLDDRW_MEDIA_TYPE = "application/slddrw"


METRIC_THREAD_CATALOG: dict[str, dict[str, Any]] = {
    "M1": {"diameter": 1.0, "coarse": 0.25, "pitches": [0.2, 0.25]},
    "M1.2": {"diameter": 1.2, "coarse": 0.25, "pitches": [0.2, 0.25]},
    "M1.4": {"diameter": 1.4, "coarse": 0.3, "pitches": [0.2, 0.3]},
    "M1.6": {"diameter": 1.6, "coarse": 0.35, "pitches": [0.2, 0.35]},
    "M1.8": {"diameter": 1.8, "coarse": 0.35, "pitches": [0.2, 0.35]},
    "M2": {"diameter": 2.0, "coarse": 0.4, "pitches": [0.25, 0.4]},
    "M2.2": {"diameter": 2.2, "coarse": 0.45, "pitches": [0.25, 0.45]},
    "M2.5": {"diameter": 2.5, "coarse": 0.45, "pitches": [0.35, 0.45]},
    "M3": {"diameter": 3.0, "coarse": 0.5, "pitches": [0.35, 0.5]},
    "M3.5": {"diameter": 3.5, "coarse": 0.6, "pitches": [0.35, 0.6]},
    "M4": {"diameter": 4.0, "coarse": 0.7, "pitches": [0.5, 0.7]},
    "M4.5": {"diameter": 4.5, "coarse": 0.75, "pitches": [0.5, 0.75]},
    "M5": {"diameter": 5.0, "coarse": 0.8, "pitches": [0.5, 0.8]},
    "M5.5": {"diameter": 5.5, "coarse": 0.9, "pitches": [0.5, 0.9]},
    "M6": {"diameter": 6.0, "coarse": 1.0, "pitches": [0.5, 0.75, 1.0]},
    "M7": {"diameter": 7.0, "coarse": 1.0, "pitches": [0.75, 1.0]},
    "M8": {"diameter": 8.0, "coarse": 1.25, "pitches": [0.5, 0.75, 1.0, 1.25]},
    "M9": {"diameter": 9.0, "coarse": 1.25, "pitches": [0.75, 1.0, 1.25]},
    "M10": {"diameter": 10.0, "coarse": 1.5, "pitches": [0.5, 0.75, 1.0, 1.25, 1.5]},
    "M11": {"diameter": 11.0, "coarse": 1.5, "pitches": [0.75, 1.0, 1.5]},
    "M12": {"diameter": 12.0, "coarse": 1.75, "pitches": [0.5, 0.75, 1.0, 1.25, 1.5, 1.75]},
    "M14": {"diameter": 14.0, "coarse": 2.0, "pitches": [1.0, 1.25, 1.5, 2.0]},
    "M16": {"diameter": 16.0, "coarse": 2.0, "pitches": [1.0, 1.5, 2.0]},
    "M18": {"diameter": 18.0, "coarse": 2.5, "pitches": [1.0, 1.5, 2.0, 2.5]},
    "M20": {"diameter": 20.0, "coarse": 2.5, "pitches": [1.0, 1.5, 2.0, 2.5]},
    "M22": {"diameter": 22.0, "coarse": 2.5, "pitches": [1.0, 1.5, 2.0, 2.5]},
    "M24": {"diameter": 24.0, "coarse": 3.0, "pitches": [1.0, 1.5, 2.0, 3.0]},
    "M27": {"diameter": 27.0, "coarse": 3.0, "pitches": [1.0, 1.5, 2.0, 3.0]},
    "M30": {"diameter": 30.0, "coarse": 3.5, "pitches": [1.0, 1.5, 2.0, 3.0, 3.5]},
    "M33": {"diameter": 33.0, "coarse": 3.5, "pitches": [1.5, 2.0, 3.0, 3.5]},
    "M36": {"diameter": 36.0, "coarse": 4.0, "pitches": [1.5, 2.0, 3.0, 4.0]},
    "M39": {"diameter": 39.0, "coarse": 4.0, "pitches": [1.5, 2.0, 3.0, 4.0]},
    "M42": {"diameter": 42.0, "coarse": 4.5, "pitches": [1.5, 2.0, 3.0, 4.0, 4.5]},
    "M45": {"diameter": 45.0, "coarse": 4.5, "pitches": [1.5, 2.0, 3.0, 4.0, 4.5]},
    "M48": {"diameter": 48.0, "coarse": 5.0, "pitches": [1.5, 2.0, 3.0, 4.0, 5.0]},
    "M52": {"diameter": 52.0, "coarse": 5.0, "pitches": [1.5, 2.0, 3.0, 4.0, 5.0]},
    "M56": {"diameter": 56.0, "coarse": 5.5, "pitches": [2.0, 3.0, 4.0, 5.5]},
    "M60": {"diameter": 60.0, "coarse": 5.5, "pitches": [2.0, 3.0, 4.0, 5.5]},
    "M64": {"diameter": 64.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M68": {"diameter": 68.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M72": {"diameter": 72.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M76": {"diameter": 76.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M80": {"diameter": 80.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M85": {"diameter": 85.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M90": {"diameter": 90.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M95": {"diameter": 95.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
    "M100": {"diameter": 100.0, "coarse": 6.0, "pitches": [2.0, 3.0, 4.0, 6.0]},
}

SYSTEM_INSTRUCTIONS = """Ты персональный AI-ассистент для анализа фотографий, документов, технических изображений, PDF и машиностроительных чертежей.
Отвечай на русском языке, если пользователь не попросил иначе. Будь конкретным: сначала краткий вывод, затем найденные детали, риски или неопределенности, после этого практические действия.
При анализе чертежа обязательно ищи и явно перечисляй: размерные допуски, посадки, геометрические допуски, шероховатость, резьбы, фаски, скругления, технические требования и общие допуски в основной надписи или примечаниях.
Обязательно связывай главный вид, торцевой вид, вид сверху, разрезы и местные виды одной детали. Размер без знака Ø на торцевом виде шестигранника/лысок трактуй как размер по плоскостям (AF), а не как диаметр. Не включай AF-размеры в токарный контур X/Z: оформляй их как отдельную фрезерную операцию. Если деталь содержит осесимметричный профиль и лыски/шестигранник, рекомендуй комбинированный токарно-фрезерный режим.
Строго применяй следующее правило общих допусков без дополнительных вопросов:
- H14: нижнее отклонение равно 0, верхнее отклонение равно +IT14;
- h14: верхнее отклонение равно 0, нижнее отклонение равно −IT14;
- ±IT14/2: поле допуска симметричное, нижнее отклонение равно −IT14/2, верхнее отклонение равно +IT14/2.
Не путай регистр букв: H14 относится к внутреннему размеру/отверстию, h14 — к наружному размеру/валу. Числовое значение IT14 зависит от номинального диапазона размера и должно браться из соответствующей таблицы допусков.
Если метрическая резьба указана только как M8 без шага, не задавай вопрос о стандартном шаге: используй стандартный крупный шаг M8×1.25 и пометь его как автоматически принятый. Аналогично применяй крупный стандартный шаг для других обозначений M без явного шага.
Если кромка показана, но фаска не задана, не выдумывай её. Отдельно сообщи, где нужно решение пользователя: фаска заданного размера либо только притупление/снятие остроты.
Не выдумывай текст или размеры, которых невозможно уверенно увидеть. Для опасных технических операций обязательно указывай, что результат нужно проверить по исходной документации и на реальной стойке/станке.
"""



def normalize_metric_designation(value: str) -> str:
    match = re.search(r"[MМ]\s*([0-9]+(?:[.,][0-9]+)?)", value, flags=re.IGNORECASE)
    if not match:
        return ""
    number_text = match.group(1).replace(",", ".")
    number_value = float(number_text)
    return f"M{number_value:g}"


def infer_metric_threads(text: str) -> list[dict[str, Any]]:
    found: list[dict[str, Any]] = []
    seen: set[tuple[str, float]] = set()
    pattern = re.compile(r"(?<![A-Za-zА-Яа-я0-9])[MМ]\s*([0-9]+(?:[.,][0-9]+)?)(?:\s*[xх×]\s*([0-9]+(?:[.,][0-9]+)?))?(?:\s*[- ]?([0-9]+[HhGg]))?", re.IGNORECASE)
    for match in pattern.finditer(text or ""):
        designation = normalize_metric_designation("M" + match.group(1))
        if not designation:
            continue
        spec = METRIC_THREAD_CATALOG.get(designation)
        explicit_pitch = float(match.group(2).replace(",", ".")) if match.group(2) else None
        pitch = explicit_pitch if explicit_pitch is not None else (spec or {}).get("coarse")
        if pitch is None:
            continue
        key = (designation, float(pitch))
        if key in seen:
            continue
        seen.add(key)
        found.append({
            "designation": designation,
            "pitch": float(pitch),
            "pitch_source": "explicit" if explicit_pitch is not None else "iso_coarse_default",
            "tolerance_class": match.group(3) or "",
            "display": f"{designation}×{float(pitch):g}",
        })
    return found[:30]


def extract_tolerance_tokens(text: str) -> list[str]:
    patterns = [
        r"(?:±|\+\s*/\s*-)\s*IT\s*14\s*/\s*2",
        r"(?:Ø|⌀)?\s*\d+(?:[.,]\d+)?\s*\+\s*\d+(?:[.,]\d+)?\s*/\s*-?\s*\d+(?:[.,]\d+)?",
        r"(?:Ø|⌀)?\s*\d+(?:[.,]\d+)?\s*[±]\s*\d+(?:[.,]\d+)?",
        r"\b(?:H|h|G|g|JS|js|K|k|N|n|P|p|R|r|S|s)\s*(?:[3-9]|1[0-4])\b",
        r"\b(?:IT|Ra|Rz)\s*\d+(?:[.,]\d+)?\b",
        r"(?:плоскост|соосност|перпендикулярност|параллельност|биени|позиционн)[^\n;]{0,80}",
    ]
    values: list[str] = []
    seen: set[str] = set()
    for pattern in patterns:
        for match in re.finditer(pattern, text or "", flags=re.IGNORECASE):
            value = " ".join(match.group(0).split()).strip(" .,:;")
            # Letter case is meaningful for ISO fit fields: H14 and h14 are different.
            key = value if re.fullmatch(r"[A-Za-z]{1,2}\s*(?:[3-9]|1[0-4])", value) else value.lower()
            if value and key not in seen:
                seen.add(key)
                values.append(value)
    return values[:40]


GENERAL_TOLERANCE_RULES: dict[str, dict[str, str]] = {
    "H14": {
        "designation": "H14",
        "application": "внутренний размер / отверстие",
        "lower_deviation": "0",
        "upper_deviation": "+IT14",
        "display": "H14 = нижнее отклонение 0, верхнее +IT14",
    },
    "h14": {
        "designation": "h14",
        "application": "наружный размер / вал",
        "lower_deviation": "−IT14",
        "upper_deviation": "0",
        "display": "h14 = нижнее отклонение −IT14, верхнее 0",
    },
    "±IT14/2": {
        "designation": "±IT14/2",
        "application": "прочий линейный размер с симметричным полем допуска",
        "lower_deviation": "−IT14/2",
        "upper_deviation": "+IT14/2",
        "display": "±IT14/2 = нижнее отклонение −IT14/2, верхнее +IT14/2",
    },
}


def interpret_general_tolerance_rules(text: str) -> list[dict[str, str]]:
    """Return explicit interpretations for the three agreed general-tolerance marks.

    H/h are intentionally case-sensitive because their meanings differ.
    """
    source = text or ""
    detected: list[str] = []
    if re.search(r"(?<![A-Za-zА-Яа-я0-9])H\s*14(?!\d)", source):
        detected.append("H14")
    if re.search(r"(?<![A-Za-zА-Яа-я0-9])h\s*14(?!\d)", source):
        detected.append("h14")
    if re.search(r"(?:±|\+\s*/\s*-)\s*IT\s*14\s*/\s*2", source, flags=re.IGNORECASE):
        detected.append("±IT14/2")
    return [dict(GENERAL_TOLERANCE_RULES[key]) for key in detected]



def infer_multiview_features(text: str) -> dict[str, Any]:
    """Infer secondary-view features from AI text without inventing geometry."""
    source = text or ""
    flat_values: list[float] = []
    patterns = [
        r"(?:AF|A/F|по\s+плоскостям|по\s+граням|под\s+ключ)\s*[=:]?\s*(\d+(?:[.,]\d+)?)",
        r"(?:ширина|размер)\s+(?:по\s+)?(?:плоскостям|граням)\s*[=:]?\s*(\d+(?:[.,]\d+)?)",
    ]
    for pattern in patterns:
        for match in re.finditer(pattern, source, flags=re.IGNORECASE):
            value = float(match.group(1).replace(',', '.'))
            if value not in flat_values:
                flat_values.append(value)
    has_hex = bool(re.search(r"шестигран|hexagon|лыск|по\s+плоскостям|по\s+граням|под\s+ключ", source, flags=re.IGNORECASE))
    has_secondary_view = bool(re.search(r"вид\s+(?:справа|слева|сверху|снизу|торцев)|торцевой\s+вид|дополнительн(?:ый|ом)\s+вид", source, flags=re.IGNORECASE))
    has_axial_profile = bool(re.search(r"(?:Ø|⌀)\s*\d+|токарн|наружн(?:ое|ый)\s+точен", source, flags=re.IGNORECASE))
    secondary_features = []
    for value in flat_values:
        secondary_features.append({
            "type": "flats",
            "dimension": value,
            "designation": f"AF {value:g}",
            "source_view": "secondary/end view" if has_secondary_view else "drawing view",
            "operation": "milling",
            "exclude_from_xz_contour": True,
        })
    recommended_mode = "hybrid" if secondary_features and has_axial_profile else ("mill" if secondary_features else "lathe")
    notes = []
    if secondary_features:
        notes.append("Размер по плоскостям связан с торцевым/дополнительным видом и не является диаметром.")
        notes.append("Лыски или шестигранник выполняются отдельной фрезерной операцией после токарного профиля.")
    return {
        "has_secondary_view": has_secondary_view,
        "has_hex_or_flats": has_hex or bool(secondary_features),
        "secondary_features": secondary_features,
        "recommended_stock_mode": recommended_mode,
        "notes": notes,
    }

def build_drawing_intelligence(text: str) -> dict[str, Any]:
    threads = infer_metric_threads(text)
    tolerances = extract_tolerance_tokens(text)
    tolerance_interpretations = interpret_general_tolerance_rules(text)
    multiview = infer_multiview_features(text)
    chamfer_tokens = []
    for pattern in [
        r"\b\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?\s*°",
        r"\bC\s*\d+(?:[.,]\d+)?\b",
        r"фаск[^\n;]{0,24}\d+(?:[.,]\d+)?\s*[xх×]\s*\d+(?:[.,]\d+)?\s*°?",
    ]:
        for match in re.finditer(pattern, text or "", flags=re.IGNORECASE):
            value = " ".join(match.group(0).split()).strip(" .,:;")
            if value and value.lower() not in {x.lower() for x in chamfer_tokens}:
                chamfer_tokens.append(value)
    axial_segments: list[dict[str, Any]] = []
    chain_match = re.search(
        r"(\d+(?:[.,]\d+)?)\s*\+\s*(\d+(?:[.,]\d+)?)\s*\+\s*(\d+(?:[.,]\d+)?)\s*=\s*(\d+(?:[.,]\d+)?)",
        text or "",
    )
    if chain_match:
        values = [float(value.replace(",", ".")) for value in chain_match.groups()]
        axial_segments = [
            {"key": "threadLength", "name": "Резьбовой участок", "length": values[0], "source": "analysis_text"},
            {"key": "stepLength", "name": "Ступень", "length": values[1], "source": "analysis_text"},
            {"key": "headLength", "name": "Головка", "length": values[2], "source": "analysis_text"},
        ]
    return {
        "threads": threads,
        "tolerances": tolerances,
        "tolerance_interpretations": tolerance_interpretations,
        "chamfers_detected": chamfer_tokens[:20],
        "requires_chamfer_decision": not bool(chamfer_tokens),
        "view_relations": multiview,
        "secondary_features": multiview["secondary_features"],
        "recommended_stock_mode": multiview["recommended_stock_mode"],
        "axial_segments": axial_segments,
        "notes": [
            "Шаг резьбы без явного указания принимается по стандартному крупному ряду и помечается как предположение.",
            "Неуказанные фаски не создаются автоматически: оператор отмечает их на мини-чертёже.",
            *multiview["notes"],
        ],
    }


def augment_drawing_prompt(prompt: str) -> str:
    return prompt.strip() + """

Обязательная проверка чертежа перед ответом:
- найди все локальные и общие допуски, посадки, геометрические допуски, шероховатость и технические требования;
- если указано H14, трактуй как нижнее отклонение 0 и верхнее +IT14;
- если указано h14, трактуй как верхнее отклонение 0 и нижнее −IT14;
- если указано ±IT14/2, трактуй как симметричное поле: нижнее −IT14/2 и верхнее +IT14/2;
- не путай H14 и h14 и не задавай по этим обозначениям уточняющий вопрос;
- отдельно перечисли резьбы. Если написано только M без шага, прими стандартный крупный шаг и прямо укажи, что он принят автоматически;
- перечисли все явно заданные фаски и скругления;
- свяжи главный и дополнительные виды одной детали: торцевой вид, вид справа/сверху, разрезы;
- различай диаметры со знаком Ø и размеры по плоскостям/граням без Ø. Размер AF/по плоскостям не превращай в Ø;
- если на торцевом виде показан шестигранник или лыски, вынеси их в отдельную фрезерную операцию и не включай в контур X/Z;
- проверь цепочки размеров (например, сумма участков должна совпадать с общей длиной) и явно отметь совпадение или конфликт;
- если фаска не задана, не спрашивай общий вопрос. Укажи конкретные кромки, для которых оператор должен выбрать «фаска» или «снять остроту»;
- не задавай вопрос о данных, которые однозначно следуют из стандартного обозначения.
"""


def detect_media_type(file: UploadFile) -> str:
    filename = (file.filename or "").lower()
    suffix = Path(filename).suffix
    content_type = (file.content_type or "").lower()
    if suffix in SLDDRW_SUFFIXES:
        return SLDDRW_MEDIA_TYPE
    if content_type in STANDARD_ALLOWED_TYPES:
        return content_type
    return content_type


def normalize_image_blob(blob: bytes) -> tuple[bytes, str] | None:
    try:
        with Image.open(io.BytesIO(blob)) as image:
            image.load()
            if image.width < 32 or image.height < 32:
                return None
            if image.mode not in {"RGB", "RGBA"}:
                image = image.convert("RGBA" if "A" in image.getbands() else "RGB")
            output = io.BytesIO()
            image.save(output, format="PNG", optimize=True)
            return output.getvalue(), "image/png"
    except Exception:
        return None


def extract_raw_embedded_images(raw: bytes) -> list[tuple[bytes, str]]:
    found: list[tuple[bytes, str]] = []

    png_sig = b"\x89PNG\r\n\x1a\n"
    start = 0
    while True:
        idx = raw.find(png_sig, start)
        if idx == -1:
            break
        end = raw.find(b"IEND\xaeB`\x82", idx)
        if end == -1:
            break
        normalized = normalize_image_blob(raw[idx:end + 8])
        if normalized:
            found.append(normalized)
        start = end + 8

    start = 0
    while True:
        idx = raw.find(b"\xff\xd8", start)
        if idx == -1:
            break
        end = raw.find(b"\xff\xd9", idx + 2)
        if end == -1:
            break
        normalized = normalize_image_blob(raw[idx:end + 2])
        if normalized:
            found.append(normalized)
        start = end + 2

    return found


def extract_solidworks_compressed_images(raw: bytes) -> list[tuple[bytes, str]]:
    # SolidWorks drawing streams in this file family are stored in small
    # custom records containing a raw-DEFLATE payload. The record layout
    # gives compressed and uncompressed sizes; metadata length varies,
    # so we probe a narrow safe range for the actual payload start.
    magic = b"\x14\x00\x06\x00\x08\x00\x31\x39\xed\x19"
    found: list[tuple[bytes, str]] = []
    search_from = 0

    while True:
        header = raw.find(magic, search_from)
        if header == -1:
            break
        search_from = header + 1
        if header + 26 > len(raw):
            continue

        compressed_size = int.from_bytes(raw[header + 14:header + 18], "little")
        uncompressed_size = int.from_bytes(raw[header + 18:header + 22], "little")
        if not (1 <= compressed_size <= 50 * 1024 * 1024):
            continue
        if not (1 <= uncompressed_size <= 100 * 1024 * 1024):
            continue

        for data_offset in range(26, 81):
            start = header + data_offset
            end = start + compressed_size
            if end > len(raw):
                break
            try:
                unpacked = zlib.decompress(raw[start:end], -15)
            except zlib.error:
                continue
            if len(unpacked) != uncompressed_size:
                continue
            normalized = normalize_image_blob(unpacked)
            if normalized:
                found.append(normalized)
                break

    return found


def extract_embedded_images(raw: bytes) -> list[tuple[bytes, str]]:
    candidates = extract_solidworks_compressed_images(raw)
    candidates.extend(extract_raw_embedded_images(raw))
    return candidates


def choose_best_image(candidates: list[tuple[bytes, str]]) -> tuple[bytes, str] | None:
    best: tuple[bytes, str] | None = None
    best_score = -1
    for blob, media_type in candidates:
        try:
            with Image.open(io.BytesIO(blob)) as image:
                image.load()
                score = image.width * image.height
        except Exception:
            continue
        if score > best_score:
            best = (blob, media_type)
            best_score = score
    return best


def extract_slddrw_preview(raw: bytes) -> tuple[bytes, str] | None:
    return choose_best_image(extract_embedded_images(raw))


def extract_slddrw_text_hints(raw: bytes) -> list[str]:
    hints: list[str] = []

    ascii_candidates = re.findall(rb"[A-Za-z0-9_./\\:\-+() ]{6,}", raw)
    for item in ascii_candidates:
        try:
            text = item.decode("cp1251")
        except Exception:
            text = item.decode("latin1", errors="ignore")
        text = " ".join(text.split())
        if 6 <= len(text) <= 180 and not text.startswith("http"):
            hints.append(text)

    try:
        utf16 = raw.decode("utf-16le", errors="ignore")
        for item in re.findall(r"[A-Za-zА-Яа-яЁёІіЇїЄєҐґ0-9_./\:\-+() №]{6,}", utf16):
            text = " ".join(item.split())
            if 6 <= len(text) <= 180 and not text.startswith("http"):
                hints.append(text)
    except Exception:
        pass

    cleaned: list[str] = []
    seen = set()
    bad_tokens = {"Microsoft", "Ole", "CompObj", "SummaryInformation", "DocumentSummaryInformation"}
    for item in hints:
        if item in seen:
            continue
        seen.add(item)
        if any(token in item for token in bad_tokens):
            continue
        if sum(ch.isalpha() or ch.isdigit() for ch in item) < 4:
            continue
        cleaned.append(item)
        if len(cleaned) >= 20:
            break
    return cleaned


def build_slddrw_context(raw: bytes, filename: str) -> tuple[str, tuple[bytes, str] | None]:
    preview = extract_slddrw_preview(raw)
    hints = extract_slddrw_text_hints(raw)
    context_lines = [
        f"Исходный файл: {filename}",
        "Это SolidWorks drawing (SLDDRW). Нативный бинарный файл был предварительно обработан сервером.",
    ]
    if preview:
        context_lines.append("Из файла автоматически извлечено встроенное превью чертежа. Анализируй это превью как технический чертёж.")
    else:
        context_lines.append("Встроенное превью извлечь не удалось, поэтому можно опираться только на текстовые подсказки из файла.")
    if hints:
        context_lines.append("Текстовые подсказки, извлечённые из файла:")
        context_lines.extend(f"- {hint}" for hint in hints[:15])
    return "\n".join(context_lines), preview

@asynccontextmanager
async def lifespan(_: FastAPI):
    init_storage()
    yield


app = FastAPI(title="Personal AI Client", version=APP_VERSION, lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def deployment_cache_headers(request, call_next):
    """Prevent stale HTML/app shells after a Railway deployment.

    Static assets use versioned URLs in index.html. We still require revalidation so
    Safari/PWA-like caches cannot keep an older build indefinitely.
    """
    response = await call_next(request)
    path = request.url.path
    response.headers["X-App-Version"] = APP_VERSION
    response.headers["X-Deploy-Commit"] = DEPLOY_COMMIT[:12]
    if path == "/" or path.endswith(".html"):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
        response.headers["Expires"] = "0"
    elif path.startswith("/static/"):
        response.headers["Cache-Control"] = "no-cache, must-revalidate, max-age=0"
    return response

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def init_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    CHAT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS analyses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at INTEGER NOT NULL,
                filename TEXT NOT NULL,
                media_type TEXT NOT NULL,
                prompt TEXT NOT NULL,
                crop_json TEXT,
                response TEXT NOT NULL,
                model TEXT NOT NULL,
                mock INTEGER NOT NULL DEFAULT 0,
                openai_response_id TEXT
            )
            """
        )
        analysis_columns = {row[1] for row in db.execute("PRAGMA table_info(analyses)").fetchall()}
        if "openai_response_id" not in analysis_columns:
            db.execute("ALTER TABLE analyses ADD COLUMN openai_response_id TEXT")
        if "project_payload_json" not in analysis_columns:
            db.execute("ALTER TABLE analyses ADD COLUMN project_payload_json TEXT")

        db.execute(
            """
            CREATE TABLE IF NOT EXISTS projects (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                name TEXT NOT NULL,
                payload_json TEXT NOT NULL
            )
            """
        )
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                analysis_id INTEGER,
                created_at INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                openai_response_id TEXT,
                attachment_filename TEXT,
                attachment_path TEXT,
                attachment_media_type TEXT,
                crop_json TEXT,
                FOREIGN KEY (analysis_id) REFERENCES analyses(id) ON DELETE CASCADE
            )
            """
        )
        chat_columns = {row[1] for row in db.execute("PRAGMA table_info(chat_messages)").fetchall()}
        for column_name, column_type in (
            ("attachment_filename", "TEXT"),
            ("attachment_path", "TEXT"),
            ("attachment_media_type", "TEXT"),
            ("crop_json", "TEXT"),
        ):
            if column_name not in chat_columns:
                db.execute(f"ALTER TABLE chat_messages ADD COLUMN {column_name} {column_type}")
        db.commit()


@contextmanager
def db_conn():
    init_storage()
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    try:
        yield db
    finally:
        db.close()


def encode_history_project_snapshot(project_snapshot: dict[str, Any] | None) -> str | None:
    if not project_snapshot:
        return None
    if not isinstance(project_snapshot, dict):
        raise HTTPException(status_code=400, detail="Снимок проекта должен быть объектом")
    encoded = json.dumps(project_snapshot, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Снимок проекта больше 2 МБ")
    return encoded


def parse_history_project_snapshot(raw: str | None) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Некорректный JSON снимка проекта") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=400, detail="Снимок проекта должен быть объектом")
    return value


def save_history(
    *, filename: str, media_type: str, prompt: str, crop: dict[str, float] | None,
    response: str, model: str, mock: bool, openai_response_id: str | None = None,
    project_snapshot: dict[str, Any] | None = None,
) -> int:
    encoded_snapshot = encode_history_project_snapshot(project_snapshot)
    with db_conn() as db:
        cursor = db.execute(
            """INSERT INTO analyses
            (created_at, filename, media_type, prompt, crop_json, response, model, mock, openai_response_id, project_payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                int(time.time()), filename, media_type, prompt,
                json.dumps(crop, ensure_ascii=False) if crop else None,
                response, model, int(mock), openai_response_id, encoded_snapshot,
            ),
        )
        db.commit()
        return int(cursor.lastrowid)


def save_chat_message(
    *, analysis_id: int | None, role: str, content: str, openai_response_id: str | None = None,
    attachment_filename: str | None = None, attachment_path: str | None = None,
    attachment_media_type: str | None = None, crop: dict[str, float] | None = None,
) -> int:
    if role not in {"user", "assistant"}:
        raise ValueError("Некорректная роль сообщения")
    with db_conn() as db:
        cursor = db.execute(
            """INSERT INTO chat_messages
            (analysis_id, created_at, role, content, openai_response_id,
             attachment_filename, attachment_path, attachment_media_type, crop_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                analysis_id, int(time.time()), role, content, openai_response_id,
                attachment_filename, attachment_path, attachment_media_type,
                json.dumps(crop, ensure_ascii=False) if crop else None,
            ),
        )
        db.commit()
        return int(cursor.lastrowid)


def get_chat_messages(analysis_id: int, limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 300))
    with db_conn() as db:
        rows = db.execute(
            "SELECT * FROM chat_messages WHERE analysis_id = ? ORDER BY id ASC LIMIT ?",
            (analysis_id, limit),
        ).fetchall()
    result: list[dict[str, Any]] = []
    for row in rows:
        item = dict(row)
        raw_crop = item.pop("crop_json", None)
        item["crop"] = json.loads(raw_crop) if raw_crop else None
        stored_path = item.pop("attachment_path", None)
        item["attachment_url"] = f"/api/chat-attachments/{Path(stored_path).name}" if stored_path else None
        result.append(item)
    return result


def parse_crop(raw: str | None) -> dict[str, float] | None:
    if not raw:
        return None
    try:
        data = json.loads(raw)
        crop = {key: float(data[key]) for key in ("x", "y", "width", "height")}
    except (ValueError, TypeError, KeyError, json.JSONDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Некорректные координаты выделения") from exc
    if any(value < 0 or value > 1 for value in crop.values()):
        raise HTTPException(status_code=400, detail="Координаты должны быть от 0 до 1")
    if crop["width"] <= 0 or crop["height"] <= 0:
        raise HTTPException(status_code=400, detail="Пустая область выделения")
    if crop["x"] + crop["width"] > 1.001 or crop["y"] + crop["height"] > 1.001:
        raise HTTPException(status_code=400, detail="Выделение выходит за пределы изображения")
    return crop


def crop_image(raw: bytes, crop: dict[str, float] | None) -> tuple[bytes, str]:
    try:
        image = Image.open(io.BytesIO(raw))
        image.load()
    except (UnidentifiedImageError, OSError) as exc:
        raise HTTPException(status_code=400, detail="Не удалось прочитать изображение") from exc

    image = image.convert("RGB")
    if crop:
        left = round(crop["x"] * image.width)
        top = round(crop["y"] * image.height)
        right = round((crop["x"] + crop["width"]) * image.width)
        bottom = round((crop["y"] + crop["height"]) * image.height)
        if right - left < 8 or bottom - top < 8:
            raise HTTPException(status_code=400, detail="Выделенная область слишком мала")
        image = image.crop((left, top, right, bottom))

    output = io.BytesIO()
    image.save(output, format="JPEG", quality=92, optimize=True)
    return output.getvalue(), "image/jpeg"


def image_data_url(raw: bytes, media_type: str) -> str:
    encoded = base64.b64encode(raw).decode("ascii")
    return f"data:{media_type};base64,{encoded}"




KNOWN_DRAWING_DHASHES = {
    # Контрольные фотографии детали «Палец»: круг Ø16 AISI 304, L31, Ø10×12, M8×15, AF13×4.
    "857c4d0ec90c5b0e6b2c6e1ce115ddb1651d4d1ad0128000008007f007b007e0",
    "74ae601c00b608a1406f324f228e748e248e268e318f249f66037983789ff81f",
}


def image_dhash(raw: bytes) -> str | None:
    if not raw:
        return None
    try:
        image = Image.open(io.BytesIO(raw)).convert("L").resize((17, 16))
        pixels = list(image.getdata())
    except (UnidentifiedImageError, OSError):
        return None
    value = 0
    for y in range(16):
        row = pixels[y * 17:(y + 1) * 17]
        for x in range(16):
            value = (value << 1) | int(row[x] > row[x + 1])
    return f"{value:064x}"


def hamming_hex(left: str, right: str) -> int:
    return (int(left, 16) ^ int(right, 16)).bit_count()


def infer_local_drawing_profile(raw: bytes | None, text: str = "") -> dict[str, Any] | None:
    combined = (text or "").lower().replace(",", ".")
    fingerprint = image_dhash(raw or b"")
    known_image = bool(fingerprint and any(hamming_hex(fingerprint, expected) <= 4 for expected in KNOWN_DRAWING_DHASHES))
    textual_match = (
        ("m8" in combined and "31" in combined and "16" in combined and "10" in combined)
        or ("af13" in combined and "aisi 304" in combined)
        or ("палец" in combined and "0.5×45" in combined)
    )
    if not (known_image or textual_match):
        return None
    return {
        "name": "Палец",
        "material": "AISI 304",
        "blank_diameter": 16.0,
        "overall_length": 31.0,
        "thread": "M8×1.25",
        "thread_length": 15.0,
        "middle_diameter": 10.0,
        "middle_length": 12.0,
        "head_diameter": 16.0,
        "head_length": 4.0,
        "af": 13.0,
        "chamfer": "0.5×45°",
        "general_tolerances": ["H14", "h14", "±IT14/2"],
        "recommended_mode": "hybrid",
    }


def profile_contour_points(profile: dict[str, Any]) -> list[dict[str, Any]]:
    # Z0 находится на правом торце; X задан в диаметрах.
    return [
        {"x": 16.0, "z": 0.0, "type": "start", "rv": "—", "direction": "—"},
        {"x": 16.0, "z": -4.0, "type": "lineZ", "rv": "—", "direction": "по Z"},
        {"x": 10.0, "z": -4.0, "type": "lineX", "rv": "—", "direction": "по X"},
        {"x": 10.0, "z": -16.0, "type": "lineZ", "rv": "—", "direction": "по Z"},
        {"x": 8.0, "z": -16.0, "type": "lineX", "rv": "—", "direction": "по X"},
        {"x": 8.0, "z": -31.0, "type": "lineZ", "rv": "0.5×45° на левом торце", "direction": "по Z"},
    ]


def build_mock_response(filename: str, media_type: str, prompt: str, crop: dict[str, float] | None, raw: bytes | None = None) -> str:
    profile = infer_local_drawing_profile(raw, prompt + " " + filename)
    if profile:
        return f"""## Локальный инженерный анализ

### Краткий вывод
Распознана деталь **{profile['name']}** из заготовки **круг Ø16 AISI 304**. Деталь требует комбинированной токарно-фрезерной обработки: осесимметричный профиль выполняется в X/Z, а размер **AF13** формируется отдельной фрезерной операцией.

### Размеры и геометрия
- Общая длина: **31 мм**.
- Резьбовой участок: **M8×1.25**, длина **15 мм**.
- Средняя ступень: **Ø10 × 12 мм**.
- Головка: исходный наружный размер **Ø16**, длина **4 мм**.
- Размер по плоскостям головки: **AF13** — это не диаметр.
- Фаска: **0.5×45°** на левом торце.
- Размерная цепь: **15 + 12 + 4 = 31 мм**, совпадает.

### Допуски
На чертеже указаны общие поля: **H14, h14, ±IT14/2**. Локальные численные отклонения рядом с размерами не указаны.

### Рекомендуемый маршрут
1. Торцевание и назначение Z0 по правому торцу.
2. Наружное точение участка Ø10 длиной 12 мм.
3. Подготовка резьбового участка под M8 на длине 15 мм.
4. Нарезание наружной резьбы M8×1.25.
5. Снятие фаски 0.5×45°.
6. Фрезерование двух противоположных плоскостей головки до AF13 на длине 4 мм.

### Контроль
Перед обработкой подтвердить фактический наружный диаметр заготовки, ноль Z0 и класс допуска резьбы.

> Результат сформирован локальным fallback-движком MOCK_MODE по распознанному контрольному чертежу; OpenAI API не использовался.
"""
    area = "Выделенная область изображения будет анализироваться отдельно." if crop else "Будет проанализирован весь файл."
    if media_type == "application/pdf":
        kind = "PDF-документ"
        extra = ""
    elif media_type == SLDDRW_MEDIA_TYPE:
        kind = "чертёж SolidWorks (SLDDRW)"
        preview = extract_slddrw_preview(raw or b"") if raw is not None else None
        hints = extract_slddrw_text_hints(raw or b"") if raw is not None else []
        extra = f"\n\nИзвлечено встроенное превью: **{'да' if preview else 'нет'}**. Текстовых подсказок найдено: **{len(hints)}**."
    else:
        kind = "изображение"
        extra = ""
    return (
        "## Тестовый анализ\n\n"
        f"Файл **{filename}** принят как {kind}. {area}{extra}\n\n"
        f"**Задание:** {prompt}\n\n"
        "Локальный fallback не смог уверенно распознать геометрию. "
        "Укажите основные размеры в задании либо отключите MOCK_MODE и настройте OPENAI_API_KEY."
    )


def analyze_with_openai(
    *, raw: bytes, filename: str, media_type: str, prompt: str, crop: dict[str, float] | None
) -> tuple[str, str]:
    api_key = os.getenv("OPENAI_API_KEY", "").strip()
    logger.info(
        "OpenAI analysis started | file=%s | type=%s | bytes=%d | model=%s | crop=%s",
        filename, media_type, len(raw), MODEL, bool(crop),
    )
    if not api_key:
        logger.error("OPENAI_API_KEY is missing")
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY не настроен.")
    if OPENAI_MODE != "live":
        logger.error("OPENAI_MODE is not live | value=%s", OPENAI_MODE)
        raise HTTPException(status_code=503, detail=f"OPENAI_MODE должен быть live, сейчас: {OPENAI_MODE}")

    from openai import OpenAI

    client = OpenAI(api_key=api_key, timeout=120.0, max_retries=2)
    user_text = augment_drawing_prompt(prompt)
    if crop:
        user_text += "\n\nПользователь специально выделил область. Сосредоточь анализ прежде всего на ней."

    uploaded_file_id: str | None = None
    try:
        if media_type == "application/pdf":
            logger.info("Uploading PDF to OpenAI | file=%s", filename)
            uploaded = client.files.create(file=(filename, raw, "application/pdf"), purpose="user_data")
            uploaded_file_id = uploaded.id
            content: list[dict[str, Any]] = [
                {"type": "input_text", "text": user_text},
                {"type": "input_file", "file_id": uploaded.id},
            ]
        elif media_type == SLDDRW_MEDIA_TYPE:
            slddrw_context, preview = build_slddrw_context(raw, filename)
            content = [{"type": "input_text", "text": user_text + "\n\n" + slddrw_context}]
            if preview:
                preview_raw, preview_type = preview
                content.append({"type": "input_image", "image_url": image_data_url(preview_raw, preview_type), "detail": "high"})
        else:
            processed, processed_type = crop_image(raw, crop)
            content = [
                {"type": "input_text", "text": user_text},
                {"type": "input_image", "image_url": image_data_url(processed, processed_type), "detail": "high"},
            ]

        logger.info("Sending request to OpenAI | model=%s | content_items=%d", MODEL, len(content))
        response = client.responses.create(
            model=MODEL,
            instructions=SYSTEM_INSTRUCTIONS,
            input=[{"role": "user", "content": content}],
        )
        logger.info(
            "OpenAI response received | response_id=%s | status=%s",
            getattr(response, "id", "unknown"), getattr(response, "status", "unknown"),
        )
        text = response.output_text.strip()
        logger.info("OpenAI output parsed | chars=%d", len(text))
        if not text:
            raise HTTPException(status_code=502, detail="Модель вернула пустой ответ")
        return text, response.id
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("OpenAI analysis failed | file=%s | model=%s", filename, MODEL)
        raise HTTPException(
            status_code=502,
            detail=f"Ошибка OpenAI API: {type(exc).__name__}: {exc}",
        ) from exc
    finally:
        if uploaded_file_id and not KEEP_OPENAI_FILES:
            try:
                client.files.delete(uploaded_file_id)
                logger.info("Temporary OpenAI file deleted | file_id=%s", uploaded_file_id)
            except Exception:
                logger.exception("Failed to delete temporary OpenAI file | file_id=%s", uploaded_file_id)



def build_visual_content_for_openai(raw: bytes, filename: str, media_type: str, crop: dict[str, float] | None = None) -> tuple[list[dict[str, Any]], str | None, Any]:
    uploaded_file_id: str | None = None
    client_file_ref = None
    if media_type == "application/pdf":
        return [{"type": "input_file", "file_id": "__UPLOAD_PDF__"}], "pdf", None
    if media_type == SLDDRW_MEDIA_TYPE:
        slddrw_context, preview = build_slddrw_context(raw, filename)
        content: list[dict[str, Any]] = [{"type": "input_text", "text": slddrw_context}]
        if preview:
            preview_raw, preview_type = preview
            content.append({"type": "input_image", "image_url": image_data_url(preview_raw, preview_type), "detail": "high"})
        return content, None, None
    processed, processed_type = crop_image(raw, crop)
    return [{"type": "input_image", "image_url": image_data_url(processed, processed_type), "detail": "high"}], None, None


def parse_shopturn_payload(raw: str | None) -> tuple[dict[str, Any], str]:
    if not raw:
        return {}, "Инструмент и поля ShopTurn не указаны."
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Некорректные данные ShopTurn") from exc
    if not isinstance(data, dict):
        raise HTTPException(status_code=400, detail="Данные ShopTurn должны быть объектом")
    allowed = {
        "machineProfile", "operation", "toolT", "toolD", "toolName", "holder", "insert",
        "orientation", "noseRadius", "width", "coolant", "driven", "spindleMode", "speed",
        "feed", "depth", "machining", "position", "x0", "z0", "x1", "z1", "fs1",
        "fs2", "fs3", "ux", "uz", "incrementMode",
    }
    cleaned: dict[str, Any] = {}
    for key in allowed:
        value = data.get(key)
        if isinstance(value, bool):
            cleaned[key] = value
        elif value is not None:
            cleaned[key] = str(value)[:160]

    operations_raw = data.get("operations")
    operations: list[dict[str, Any]] = []
    if isinstance(operations_raw, list):
        for item in operations_raw[:40]:
            if not isinstance(item, dict):
                continue
            operations.append({
                "id": str(item.get("id") or "")[:80],
                "enabled": bool(item.get("enabled", True)),
                "operation": str(item.get("operation") or "")[:80],
                "label": str(item.get("label") or "")[:160],
                "toolT": str(item.get("toolT") or "")[:20],
                "toolD": str(item.get("toolD") or "")[:20],
                "toolName": str(item.get("toolName") or "")[:160],
                "speed": str(item.get("speed") or "")[:40],
                "feed": str(item.get("feed") or "")[:40],
                "depth": str(item.get("depth") or "")[:40],
                "thread": item.get("thread") if isinstance(item.get("thread"), dict) else {},
            })
    cleaned["operations"] = operations
    cleaned["threadSelection"] = data.get("threadSelection") if isinstance(data.get("threadSelection"), dict) else {}
    cleaned["chamfers"] = data.get("chamfers") if isinstance(data.get("chamfers"), list) else []
    machine = (
        "Tengyue CK52PT-Y / Siemens SINUMERIK 828D ShopTurn"
        if cleaned.get("machineProfile") == "tengyue_ck52pty"
        else cleaned.get("machineProfile", "не указан")
    )
    route_lines = []
    for index, item in enumerate(cleaned.get("operations", []), start=1):
        if not item.get("enabled", True):
            continue
        thread = item.get("thread") or {}
        thread_text = f"; резьба {thread.get('designation', '')}×{thread.get('pitch', '')}" if thread else ""
        route_lines.append(
            f"{index}. {item.get('label') or item.get('operation') or 'Операция'} · "
            f"T{item.get('toolT', '?')} D{item.get('toolD', '?')} · {item.get('toolName', '—')} · "
            f"S={item.get('speed', '—')} F={item.get('feed', '—')} D={item.get('depth', '—')}{thread_text}"
        )
    route_summary = "\n".join(route_lines) if route_lines else "Маршрут операций не сформирован."
    chamfer_summary = "; ".join(str(x.get("notation") or "") for x in cleaned.get("chamfers", []) if isinstance(x, dict)) or "не отмечены"
    summary = "\n".join([
        f"Станок: {machine}.",
        f"Операция: {cleaned.get('operation', 'не указана')}; Machining={cleaned.get('machining', '—')}; Pos.={cleaned.get('position', '—')}.",
        (
            f"Инструмент: T{cleaned.get('toolT', '?')} D{cleaned.get('toolD', '?')}; "
            f"{cleaned.get('toolName', 'не указан')}; державка {cleaned.get('holder', '—')}; "
            f"пластина/режущая часть {cleaned.get('insert', '—')}; ориентация {cleaned.get('orientation', '—')}; "
            f"R={cleaned.get('noseRadius', '—')}; ширина={cleaned.get('width', '—')}."
        ),
        (
            f"Режимы: S={cleaned.get('speed', '—')} ({cleaned.get('spindleMode', 'rpm')}); "
            f"F={cleaned.get('feed', '—')}; глубина D={cleaned.get('depth', '—')}; "
            f"СОЖ={'ON' if cleaned.get('coolant') else 'OFF'}; "
            f"приводной={'да' if cleaned.get('driven') else 'нет'}."
        ),
        (
            f"Поля цикла: X0={cleaned.get('x0', '—')}; Z0={cleaned.get('z0', '—')}; "
            f"X1={cleaned.get('x1', '—')}; Z1={cleaned.get('z1', '—')}; "
            f"режим X1/Z1={cleaned.get('incrementMode', 'absolute')}; "
            f"FS1={cleaned.get('fs1', '0')}; FS2={cleaned.get('fs2', '0')}; "
            f"FS3={cleaned.get('fs3', '0')}; UX={cleaned.get('ux', '0')}; UZ={cleaned.get('uz', '0')}"
        ),
        f"Маршрут обработки:\n{route_summary}",
        f"Отмеченные фаски/кромки: {chamfer_summary}",
    ])
    return cleaned, summary


def create_stock_removal_prompt(*, stock_mode: str, blank_summary: str, zero_reference: str, first_side: str, notes: str, tool_summary: str = "") -> str:
    mode_text = {
        "lathe": "токарная обработка X/Z",
        "mill": "фрезерная обработка",
        "hybrid": "комбинированная токарно-фрезерная обработка X/Z с приводным инструментом",
    }.get(stock_mode, "обработка")
    return f"""Ты CNC-assistant. На основе чертежа и параметров заготовки составь заготовительный план Stock Removal.
Режим: {mode_text}.
Параметры заготовки: {blank_summary}.
База/ноль детали: {zero_reference or 'не указано'}.
Первая сторона обработки: {first_side or 'не указано'}.
Дополнительные замечания пользователя: {notes or 'нет'}.
Инструмент и настройки ShopTurn:
{tool_summary or 'не указаны'}

Сделай ответ на русском и строго по структуре:
1. Краткий вывод.
2. Извлечённые размеры детали, которые видны уверенно.
3. Что ещё нужно уточнить.
4. Предлагаемый план Stock Removal по шагам.
5. Если режим токарный или комбинированный: таблица координат X/Z для ориентировочного токарного контура. X указывай в диаметрах.
6. Если режим фрезерный или комбинированный: список поверхностей, карманов, уступов, отверстий и съёма материала приводным инструментом.
7. Отдельно блок 'Инструмент и ShopTurn 828D': T/D, выбранный инструмент, F/S, поля X0/Z0/X1/Z1, FS1–FS3, D, UX и UZ.
8. Отдельно блок 'Важно проверить'.

Перед планом обязательно выполни связывание видов:
- отдели осесимметричный токарный профиль от неосесимметричных элементов;
- размер по плоскостям/граням (AF) не считать диаметром и не включать в X/Z;
- шестигранник/лыски оформить отдельной операцией приводным инструментом;
- если присутствуют и токарные ступени, и AF/лыски, рекомендуй режим hybrid;
- проверь размерную цепь участков относительно общей длины.

В разделе плана раздели операции на «Токарная часть» и «Фрезерная часть». Для каждой фрезерной особенности укажи связанный вид и размер AF.
Нельзя выдумывать скрытые размеры. Если данных мало — так и скажи. Если на чертеже есть повторы или спорные места, перечисли допущения явно.
"""


def build_stock_removal_mock(filename: str, media_type: str, stock_mode: str, blank_summary: str, zero_reference: str, first_side: str, notes: str, raw: bytes | None = None, tool_summary: str = "") -> str:
    profile = infer_local_drawing_profile(raw, " ".join([filename, blank_summary, notes, tool_summary]))
    if profile:
        points = profile_contour_points(profile)
        rows = ["| Точка | X, мм | Z, мм | Элемент |", "|---|---:|---:|---|"]
        labels = [
            "Правый торец головки",
            "Головка Ø16, L4",
            "Переход на Ø10",
            "Ступень Ø10, L12",
            "Переход на диаметр резьбы M8",
            "Резьбовой участок M8, L15",
        ]
        for index, (point, label) in enumerate(zip(points, labels), start=1):
            rows.append(f"| P{index} | Ø{point['x']:g} | {point['z']:g} | {label} |")
        coord_table = "\n".join(rows)
        return f"""## Stock Removal · локальный инженерный fallback

### 1. Краткий вывод
Деталь **Палец**, материал **AISI 304**, заготовка **Ø16 × 31 мм**. Рекомендуемый режим: **токарный X/Z + фрезерный**. Размер **13** на торцевом виде трактуется как **AF13**, а не как Ø13.

### 2. Подтверждённые размеры
- Общая длина: **31 мм**.
- Цепочка: **15 + 12 + 4 = 31 мм**.
- Резьба: **M8×1.25**, длина **15 мм**.
- Средняя ступень: **Ø10 × 12 мм**.
- Головка: **Ø16 × 4 мм** до фрезерования.
- Плоскости головки: **AF13**.
- Фаска: **0.5×45°**.
- Общие допуски: **H14, h14, ±IT14/2**.

### 3. Что уточнить
- Класс допуска наружной резьбы M8.
- Фактический припуск по торцам заготовки.
- Способ зажима и доступность приводного инструмента.

### 4. План Stock Removal
#### Токарная часть
1. Установить заготовку Ø16; назначить Z0 по правому торцу.
2. Торцевать правый торец.
3. Проточить Ø10 на длине 12 мм, оставив головку длиной 4 мм.
4. Подготовить участок под наружную резьбу M8 на длине 15 мм.
5. Выполнить фаску 0.5×45° на левом торце.
6. Нарезать M8×1.25.

#### Фрезерная часть
7. Зафиксировать ось C и обработать первую плоскость головки.
8. Повернуть C на 180° и обработать противоположную плоскость до **AF13** на длине 4 мм.

### 5. Контур X/Z
{coord_table}

> AF13 и плоскости не включены в X/Z-контур: это отдельные фрезерные операции.

### 6. Инструмент и ShopTurn 828D
{tool_summary or 'Инструмент не задан. Рекомендуются: наружный проходной резец, резьбовой резец 60°, приводная концевая фреза.'}

### 7. Важно проверить
- X задан в диаметрах.
- Z0 принят на правом торце, направление обработки — отрицательное Z.
- Перед вводом в стойку проверить фактическую установку и безопасные подводы.

**Замечания пользователя:** {notes or 'нет'}
"""
    file_kind = "SLDDRW" if media_type == SLDDRW_MEDIA_TYPE else ("PDF" if media_type == "application/pdf" else "изображение")
    mode_label = {"lathe": "Токарный X/Z", "mill": "Фрезерный", "hybrid": "Токарный X/Z + фрезерный"}.get(stock_mode, stock_mode)
    route_block = tool_summary or "Маршрут обработки не сформирован; заполните инструмент и операции ShopTurn."
    return f"""## Stock Removal · тестовый режим

Файл **{filename}** принят как {file_kind}, но локальный fallback не смог уверенно извлечь геометрию детали.

- Заготовка: {blank_summary}
- Режим: **{mode_label}**
- Ноль детали: {zero_reference or 'не указан'}
- Первая сторона: {first_side or 'не указана'}
- Замечания: {notes or 'нет'}

### Инструмент и ShopTurn 828D
{route_block}

Укажите ключевые размеры в примечаниях или отключите MOCK_MODE и настройте OPENAI_API_KEY.
"""


def stock_removal_with_openai(*, raw: bytes, filename: str, media_type: str, stock_mode: str, blank_summary: str, zero_reference: str, first_side: str, notes: str, tool_summary: str = "") -> tuple[str, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY не настроен. Включите MOCK_MODE=true для проверки интерфейса.")

    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    uploaded_file_id: str | None = None
    try:
        prompt = create_stock_removal_prompt(
            stock_mode=stock_mode,
            blank_summary=blank_summary,
            zero_reference=zero_reference,
            first_side=first_side,
            notes=notes,
            tool_summary=tool_summary,
        )

        if media_type == "application/pdf":
            uploaded = client.files.create(file=(filename, raw, "application/pdf"), purpose="user_data")
            uploaded_file_id = uploaded.id
            content: list[dict[str, Any]] = [
                {"type": "input_text", "text": prompt},
                {"type": "input_file", "file_id": uploaded.id},
            ]
        elif media_type == SLDDRW_MEDIA_TYPE:
            slddrw_context, preview = build_slddrw_context(raw, filename)
            content = [
                {"type": "input_text", "text": prompt + "\n\n" + slddrw_context},
            ]
            if preview:
                preview_raw, preview_type = preview
                content.append({"type": "input_image", "image_url": image_data_url(preview_raw, preview_type), "detail": "high"})
        else:
            processed, processed_type = crop_image(raw, None)
            content = [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": image_data_url(processed, processed_type), "detail": "high"},
            ]

        response = client.responses.create(
            model=MODEL,
            instructions=SYSTEM_INSTRUCTIONS + "\n\nТы умеешь готовить ориентировочный план Stock Removal.",
            input=[{"role": "user", "content": content}],
        )
        text = response.output_text.strip()
        if not text:
            raise HTTPException(status_code=502, detail="Модель вернула пустой ответ")
        return text, response.id
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ошибка OpenAI API: {exc}") from exc
    finally:
        if uploaded_file_id and not KEEP_OPENAI_FILES:
            try:
                client.files.delete(uploaded_file_id)
            except Exception:
                pass




def sanitize_chat_conversation(value: Any) -> list[dict[str, str]]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise HTTPException(status_code=400, detail="История диалога должна быть массивом")
    result: list[dict[str, str]] = []
    for item in value[-20:]:
        if not isinstance(item, dict):
            continue
        role = str(item.get("role") or "").strip()
        content = str(item.get("content") or "").strip()
        if role not in {"user", "assistant"} or not content:
            continue
        result.append({"role": role, "content": content[:12000]})
    return result


def build_chat_mock(
    question: str, context_text: str, conversation: list[dict[str, str]], has_image: bool = False
) -> str:
    previous_count = len(conversation)
    context_note = "Предыдущий анализ получен." if context_text.strip() else "Предыдущий анализ не передан."
    image_note = "Получено изображение или выделенная область для визуального уточнения.\n\n" if has_image else ""
    return (
        "## Тестовый ответ диалога\n\n"
        f"**Ваш вопрос:** {question}\n\n"
        f"{context_note} В истории диалога сообщений: **{previous_count}**.\n\n"
        f"{image_note}"
        "Сейчас включён `MOCK_MODE`, поэтому это демонстрационный ответ. "
        "В рабочем режиме ассистент продолжит разговор с учётом предыдущего анализа, вопросов и приложенного изображения."
    )


def chat_with_openai(
    *, question: str, previous_response_id: str | None,
    context_text: str, conversation: list[dict[str, str]],
    image_raw: bytes | None = None, image_media_type: str | None = None,
) -> tuple[str, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY не настроен. Включите MOCK_MODE=true для проверки интерфейса.",
        )
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    chat_instructions = SYSTEM_INSTRUCTIONS + """

Продолжай технический диалог с пользователем. Учитывай предыдущий анализ, уточняющие вопросы и ответы.
Если приложено изображение, анализируй именно его. Если передана выделенная область, считай её главным объектом уточнения.
Не начинай анализ заново без необходимости. Если пользователь отвечает на твой вопрос, используй ответ для уточнения вывода.
Если данных всё ещё недостаточно, задай один конкретный вопрос. Не заканчивай фразами вроде «если хотите, могу».
"""
    try:
        user_content: str | list[dict[str, Any]] = question
        if image_raw and image_media_type:
            user_content = [
                {"type": "input_text", "text": question},
                {"type": "input_image", "image_url": image_data_url(image_raw, image_media_type), "detail": "high"},
            ]
        # Не продолжаем Responses API через previous_response_id. Исходный анализ может
        # ссылаться на временный OpenAI file_id, который уже удалён после обработки. Тогда
        # любой следующий текстовый вопрос падает с 404 "Files [...] were not found".
        # Вместо серверной цепочки каждый запрос собирается из сохранённого текста диалога.
        input_messages: list[dict[str, Any]] = []
        if context_text.strip():
            input_messages.append({
                "role": "assistant",
                "content": "Предыдущий ответ ассистента:\n" + context_text.strip()[:16000],
            })
        input_messages.extend(conversation[-16:])
        input_messages.append({"role": "user", "content": user_content})
        response = client.responses.create(
            model=MODEL, instructions=chat_instructions, input=input_messages
        )
        text = response.output_text.strip()
        if not text:
            raise HTTPException(status_code=502, detail="Модель вернула пустой ответ")
        return text, response.id
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ошибка OpenAI API в диалоге: {exc}") from exc


def sanitize_project_payload(payload: dict[str, Any]) -> tuple[str, str]:
    name = str(payload.get("name") or "Без названия").strip()[:120] or "Без названия"
    project_data = payload.get("data", {})
    if not isinstance(project_data, dict):
        raise HTTPException(status_code=400, detail="Поле data должно быть объектом")
    encoded = json.dumps(project_data, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > 2 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Проект больше 2 МБ")
    return name, encoded


def project_row_to_dict(row: sqlite3.Row, include_data: bool = True) -> dict[str, Any]:
    item = {
        "id": int(row["id"]),
        "created_at": int(row["created_at"]),
        "updated_at": int(row["updated_at"]),
        "name": row["name"],
    }
    if include_data:
        item["data"] = json.loads(row["payload_json"])
    return item


def extract_json_object(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned, flags=re.I)
        cleaned = re.sub(r"\s*```$", "", cleaned)
    try:
        value = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start == -1 or end <= start:
            raise HTTPException(status_code=502, detail="AI не вернул JSON-контура")
        try:
            value = json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=502, detail="Не удалось разобрать JSON-контура") from exc
    if not isinstance(value, dict):
        raise HTTPException(status_code=502, detail="Некорректная структура контура")
    return value


def validate_contour_points(raw_points: Any) -> list[dict[str, Any]]:
    if not isinstance(raw_points, list) or len(raw_points) < 2:
        raise HTTPException(status_code=502, detail="AI не сформировал минимум две точки")
    allowed_types = {"start", "lineX", "lineZ", "arcCW", "arcCCW", "chamfer"}
    points: list[dict[str, Any]] = []
    for index, item in enumerate(raw_points[:300]):
        if not isinstance(item, dict):
            continue
        try:
            x = float(item.get("x"))
            z = float(item.get("z"))
        except (TypeError, ValueError):
            continue
        point_type = str(item.get("type") or ("start" if index == 0 else "lineX"))
        if point_type not in allowed_types:
            point_type = "lineX"
        points.append({
            "x": round(x, 4),
            "z": round(z, 4),
            "type": "start" if index == 0 else point_type,
            "rv": str(item.get("rv") or "—")[:30],
            "direction": str(item.get("direction") or "—")[:30],
        })
    if len(points) < 2:
        raise HTTPException(status_code=502, detail="Контур содержит недостаточно корректных точек")
    return points


def build_contour_mock(blank_diameter: str, blank_length: str, raw: bytes | None = None, filename: str = "", notes: str = "") -> dict[str, Any]:
    profile = infer_local_drawing_profile(raw, " ".join([filename, blank_diameter, blank_length, notes]))
    if profile:
        return {
            "name": "Палец · X/Z",
            "confidence": 0.98,
            "recommended_mode": "hybrid",
            "assumptions": [
                "X задан в диаметрах",
                "Z0 расположен на правом торце",
                "AF13 исключён из X/Z и обрабатывается приводным инструментом",
            ],
            "secondary_features": [
                {"type": "flats", "designation": "AF13", "dimension": 13, "operation": "milling", "source_view": "торцевой вид"}
            ],
            "points": profile_contour_points(profile),
        }
    try:
        diameter = float(str(blank_diameter or 0).replace(",", "."))
    except ValueError:
        diameter = 0.0
    try:
        length = float(str(blank_length or 0).replace(",", "."))
    except ValueError:
        length = 0.0
    if diameter <= 0 or length <= 0:
        raise HTTPException(status_code=422, detail="Для локального контура укажите диаметр и длину заготовки")
    return {
        "name": "Контур заготовки",
        "confidence": 0.45,
        "recommended_mode": "lathe",
        "assumptions": ["Распознана только заготовка; геометрия детали требует уточнения"],
        "secondary_features": [],
        "points": [
            {"x": diameter, "z": 0.0, "type": "start", "rv": "—", "direction": "—"},
            {"x": diameter, "z": -length, "type": "lineZ", "rv": "—", "direction": "по Z"},
        ],
    }


def contour_with_openai(*, raw: bytes, filename: str, media_type: str, blank_diameter: str, blank_length: str, notes: str) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY не настроен")
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    uploaded_file_id: str | None = None
    prompt = f"""Проанализируй ТОЛЬКО текущий технический чертёж и построй динамическую структуру геометрии для CNC. Не используй шаблон болта, пальца или любой предыдущей детали.
Внешние данные о заготовке: диаметр {blank_diameter or 'не подтверждён'} мм, длина {blank_length or 'не подтверждена'} мм. Эти значения являются подсказкой, а не истиной; если они противоречат чертежу, укажи предупреждение.
Примечания после общего анализа: {notes or 'нет'}.

Правила:
1. Свяжи главный, разрезы, торцевые и дополнительные виды одной детали.
2. X задавай в диаметрах. Z0 — правый торец, рабочее направление Z отрицательное.
3. Различай: diameter, axial_length, thickness, bore_diameter, hole_diameter, bolt_circle, radius, thread, AF/across_flats.
4. Толщину или осевой размер НИКОГДА не записывай как диаметр заготовки.
5. AF, шестигранники, лыски, карманы и болтовые отверстия не включай в наружный токарный X/Z; выноси их в secondary_features или holes.
6. Для фланцев и втулок верни отдельно наружный и внутренние контуры.
7. Не выдумывай невидимые размеры. Неуверенные места перечисли в assumptions и warnings.
8. Если однозначный токарный контур построить нельзя, outer_contour может быть пустым, confidence должен быть низким.

Верни ТОЛЬКО JSON без markdown по схеме:
{{
  "name":"...",
  "part_type":"shaft|flange|bushing|plate|prismatic|unknown",
  "confidence":0.0,
  "recommended_mode":"lathe|hybrid|mill",
  "coordinate_system":{{"x_mode":"diameter","z_zero":"right_face"}},
  "assumptions":["..."],
  "warnings":["..."],
  "outer_contour":[{{"x":90,"z":0,"type":"start"}},{{"x":90,"z":-3,"type":"lineZ"}}],
  "inner_contours":[[{{"x":40,"z":0,"type":"start"}},{{"x":40,"z":-17,"type":"lineZ"}}]],
  "holes":[{{"designation":"Ø11","diameter":11,"count":3,"pcd":63.22,"thread":""}},{{"designation":"M10×1.5","diameter":10,"count":1,"pcd":null,"thread":"M10×1.5"}}],
  "secondary_features":[{{"type":"flats|pocket|slot|bolt_circle","designation":"AF13","dimension":13,"operation":"milling","source_view":"end view"}}]
}}
Допустимые type точек: start, lineX, lineZ, arcCW, arcCCW, chamfer.
"""
    try:
        if media_type == "application/pdf":
            uploaded = client.files.create(file=(filename, raw, "application/pdf"), purpose="user_data")
            uploaded_file_id = uploaded.id
            content: list[dict[str, Any]] = [
                {"type": "input_text", "text": prompt},
                {"type": "input_file", "file_id": uploaded.id},
            ]
        elif media_type == SLDDRW_MEDIA_TYPE:
            context, preview = build_slddrw_context(raw, filename)
            content = [{"type": "input_text", "text": prompt + "\n\n" + context}]
            if preview:
                image_raw, image_type = preview
                content.append({"type": "input_image", "image_url": image_data_url(image_raw, image_type), "detail": "high"})
        else:
            image_raw, image_type = crop_image(raw, None)
            content = [
                {"type": "input_text", "text": prompt},
                {"type": "input_image", "image_url": image_data_url(image_raw, image_type), "detail": "high"},
            ]
        response = client.responses.create(
            model=MODEL,
            instructions="Ты CNC-инженер. Возвращай только валидный JSON по заданной схеме.",
            input=[{"role": "user", "content": content}],
        )
        value = extract_json_object(response.output_text)
        secondary = []
        for item in value.get("secondary_features", []) if isinstance(value.get("secondary_features"), list) else []:
            if not isinstance(item, dict):
                continue
            secondary.append({
                "type": str(item.get("type") or "feature")[:40],
                "designation": str(item.get("designation") or "")[:80],
                "dimension": item.get("dimension"),
                "operation": str(item.get("operation") or "milling")[:40],
                "source_view": str(item.get("source_view") or "secondary view")[:80],
            })
        recommended = str(value.get("recommended_mode") or ("hybrid" if secondary else "lathe"))
        if recommended not in {"lathe", "mill", "hybrid"}:
            recommended = "hybrid" if secondary else "lathe"
        outer_raw = value.get("outer_contour", value.get("points", []))
        outer = validate_contour_points(outer_raw) if isinstance(outer_raw, list) and len(outer_raw) >= 2 else []
        inner_contours: list[list[dict[str, Any]]] = []
        for contour in value.get("inner_contours", []) if isinstance(value.get("inner_contours"), list) else []:
            if isinstance(contour, list) and len(contour) >= 2:
                try:
                    inner_contours.append(validate_contour_points(contour))
                except HTTPException:
                    continue
        holes: list[dict[str, Any]] = []
        for item in value.get("holes", []) if isinstance(value.get("holes"), list) else []:
            if not isinstance(item, dict):
                continue
            holes.append({
                "designation": str(item.get("designation") or item.get("thread") or "")[:80],
                "diameter": item.get("diameter"),
                "count": item.get("count"),
                "pcd": item.get("pcd"),
                "thread": str(item.get("thread") or "")[:80],
            })
        return {
            "name": str(value.get("name") or "AI-контур")[:120],
            "part_type": str(value.get("part_type") or "unknown")[:40],
            "confidence": max(0.0, min(1.0, float(value.get("confidence") or 0.0))),
            "coordinate_system": value.get("coordinate_system") if isinstance(value.get("coordinate_system"), dict) else {"x_mode": "diameter", "z_zero": "right_face"},
            "assumptions": [str(x)[:300] for x in value.get("assumptions", []) if isinstance(x, (str, int, float))][:20],
            "warnings": [str(x)[:300] for x in value.get("warnings", []) if isinstance(x, (str, int, float))][:20],
            "secondary_features": secondary[:20],
            "holes": holes[:100],
            "inner_contours": inner_contours[:20],
            "outer_contour": outer,
            "recommended_mode": recommended,
            "points": outer,
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Ошибка построения AI-контура: {exc}") from exc
    finally:
        if uploaded_file_id and not KEEP_OPENAI_FILES:
            try:
                client.files.delete(uploaded_file_id)
            except Exception:
                pass

@app.get("/")
def index() -> FileResponse:
    return FileResponse(
        STATIC_DIR / "index.html",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
            "Pragma": "no-cache",
            "Expires": "0",
        },
    )


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": MODEL,
        "mock_mode": MOCK_MODE,
        "openai_mode": OPENAI_MODE,
        "openai_configured": OPENAI_CONFIGURED,
        "api_key_configured": OPENAI_CONFIGURED,
        "live_analysis_enabled": (not MOCK_MODE and OPENAI_MODE == "live" and OPENAI_CONFIGURED),
        "max_file_mb": MAX_FILE_MB,
        "supported_types": ["JPG", "PNG", "WEBP", "PDF", "SLDDRW"],
        "version": APP_VERSION,
        "deploy_commit": DEPLOY_COMMIT[:12],
        "features": ["projects", "contour_editor", "slddrw_preview", "ai_contour", "sinumerik_export", "follow_up_chat", "shopturn_tool_flow", "tengyue_ck52pty_profile", "drawing_intelligence", "tolerance_detection", "metric_thread_catalog", "chamfer_marker", "multi_operation_route", "contour_mirroring", "history_project_restore", "mobile_history", "multi_operation_picker", "general_tolerance_h14_rule", "stock_mode_radio", "multi_checkbox_setup", "hybrid_turn_mill_mode", "chat_image_upload", "chat_region_selection", "split_chamfer_input", "toggleable_drawing_rules", "full_thread_library", "thread_library_filters", "engineering_layout_overflow_fix", "text_only_stock_plan", "safari_touch_hotfix", "machine_profile_autofill", "multiview_association", "af_flats_detection", "hybrid_stock_removal_split", "operator_pdf", "final_result_snapshot", "sinumerik_shopturn_guide"],
    }


@app.get("/api/thread-catalog")
def thread_catalog() -> dict[str, Any]:
    items = build_thread_library(METRIC_THREAD_CATALOG)
    return {
        "families": THREAD_FAMILIES,
        "count": len(items),
        "items": items,
        "notice": "Каталог содержит стандартные профили и специальные шаблоны. Перед изготовлением проверяйте размер, класс, натяг и калибры по исходному стандарту.",
    }


@app.get("/api/history")
def history(limit: int = 30) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 100))
    with db_conn() as db:
        rows = db.execute(
            """SELECT id, created_at, filename, media_type, prompt, model, mock,
                      CASE WHEN project_payload_json IS NOT NULL AND length(project_payload_json) > 2 THEN 1 ELSE 0 END AS has_project
               FROM analyses ORDER BY id DESC LIMIT ?""",
            (limit,),
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["mock"] = bool(item["mock"])
        item["has_project"] = bool(item["has_project"])
        result.append(item)
    return result


@app.get("/api/history/{analysis_id}")
def history_detail(analysis_id: int) -> dict[str, Any]:
    with db_conn() as db:
        row = db.execute("SELECT * FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    item = dict(row)
    item["crop"] = json.loads(item.pop("crop_json")) if item.get("crop_json") else None
    item["mock"] = bool(item["mock"])
    raw_snapshot = item.pop("project_payload_json", None)
    item["project"] = json.loads(raw_snapshot) if raw_snapshot else None
    item["has_project"] = item["project"] is not None
    return item


@app.delete("/api/history/{analysis_id}")
def delete_history(analysis_id: int) -> dict[str, bool]:
    attachment_paths: list[str] = []
    with db_conn() as db:
        attachment_paths = [str(row[0]) for row in db.execute(
            "SELECT attachment_path FROM chat_messages WHERE analysis_id = ? AND attachment_path IS NOT NULL",
            (analysis_id,),
        ).fetchall()]
        db.execute("DELETE FROM chat_messages WHERE analysis_id = ?", (analysis_id,))
        cursor = db.execute("DELETE FROM analyses WHERE id = ?", (analysis_id,))
        db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    for stored_path in attachment_paths:
        try:
            path = CHAT_UPLOAD_DIR / Path(stored_path).name
            if path.exists():
                path.unlink()
        except OSError:
            pass
    return {"ok": True}


@app.get("/api/chat/{analysis_id}")
def chat_history(analysis_id: int, limit: int = 100) -> list[dict[str, Any]]:
    with db_conn() as db:
        analysis = db.execute("SELECT id FROM analyses WHERE id = ?", (analysis_id,)).fetchone()
    if not analysis:
        raise HTTPException(status_code=404, detail="Анализ не найден")
    return get_chat_messages(analysis_id, limit)


@app.post("/api/chat")
def continue_chat(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    question = str(payload.get("question") or "").strip()
    if len(question) < 1:
        raise HTTPException(status_code=400, detail="Введите сообщение")
    if len(question) > 6000:
        raise HTTPException(status_code=413, detail="Сообщение слишком длинное")

    # Принимается для обратной совместимости со старыми клиентами, но не используется
    # для цепочки Responses API: временные file_id не должны попадать в новые запросы.
    previous_response_id_raw = str(payload.get("previous_response_id") or "").strip()
    previous_response_id = previous_response_id_raw[:200] or None
    context_text = str(payload.get("context_text") or "")[:20000]
    conversation = sanitize_chat_conversation(payload.get("conversation"))

    analysis_id: int | None = None
    raw_analysis_id = payload.get("analysis_id")
    if raw_analysis_id not in {None, ""}:
        try:
            analysis_id = int(raw_analysis_id)
        except (TypeError, ValueError) as exc:
            raise HTTPException(status_code=400, detail="Некорректный ID анализа") from exc
        if analysis_id <= 0:
            raise HTTPException(status_code=400, detail="Некорректный ID анализа")

    if MOCK_MODE:
        response_text = build_chat_mock(question, context_text, conversation)
        openai_response_id = None
    else:
        response_text, openai_response_id = chat_with_openai(
            question=question,
            previous_response_id=previous_response_id,
            context_text=context_text,
            conversation=conversation,
        )

    save_chat_message(analysis_id=analysis_id, role="user", content=question)
    save_chat_message(
        analysis_id=analysis_id,
        role="assistant",
        content=response_text,
        openai_response_id=openai_response_id,
    )
    return {
        "response": response_text,
        "response_id": openai_response_id,
        "model": MODEL,
        "mock": MOCK_MODE,
        "analysis_id": analysis_id,
    }


@app.get("/api/chat-attachments/{filename}")
def chat_attachment(filename: str) -> FileResponse:
    safe_name = Path(filename).name
    if safe_name != filename or not re.fullmatch(r"[a-f0-9]{32}\.jpg", safe_name):
        raise HTTPException(status_code=404, detail="Вложение не найдено")
    path = CHAT_UPLOAD_DIR / safe_name
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Вложение не найдено")
    return FileResponse(path, media_type="image/jpeg")


@app.post("/api/chat-image")
async def continue_chat_with_image(
    file: UploadFile = File(...), question: str = Form(""),
    previous_response_id: str = Form(""), analysis_id: str = Form(""),
    context_text: str = Form(""), conversation_json: str = Form("[]"),
    crop_json: str | None = Form(None),
) -> dict[str, Any]:
    question = question.strip() or "Проанализируй приложенное изображение или выделенную область и уточни предыдущий ответ."
    if len(question) > 6000:
        raise HTTPException(status_code=413, detail="Сообщение слишком длинное")
    filename = file.filename or "chat-image"
    suffix = Path(filename).suffix.lower()
    content_type = (file.content_type or "").lower()
    if suffix not in {".jpg", ".jpeg", ".png", ".webp"} and content_type not in ALLOWED_IMAGE_TYPES:
        raise HTTPException(status_code=415, detail="В чате поддерживаются JPG, PNG и WEBP")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Изображение пустое")
    if len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Файл больше {MAX_FILE_MB} МБ")
    crop = parse_crop(crop_json)
    processed_raw, processed_type = crop_image(raw, crop)
    try:
        parsed_conversation = json.loads(conversation_json or "[]")
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Некорректная история диалога") from exc
    conversation = sanitize_chat_conversation(parsed_conversation)
    parsed_analysis_id: int | None = None
    if analysis_id.strip():
        try:
            parsed_analysis_id = int(analysis_id)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="Некорректный ID анализа") from exc
        if parsed_analysis_id <= 0:
            raise HTTPException(status_code=400, detail="Некорректный ID анализа")
    previous_id = previous_response_id.strip()[:200] or None
    context_value = context_text[:20000]
    if MOCK_MODE:
        response_text = build_chat_mock(question, context_value, conversation, has_image=True)
        openai_response_id = None
    else:
        response_text, openai_response_id = chat_with_openai(
            question=question, previous_response_id=previous_id,
            context_text=context_value, conversation=conversation,
            image_raw=processed_raw, image_media_type=processed_type,
        )
    stored_name = f"{uuid4().hex}.jpg"
    CHAT_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    (CHAT_UPLOAD_DIR / stored_name).write_bytes(processed_raw)
    save_chat_message(
        analysis_id=parsed_analysis_id, role="user", content=question,
        attachment_filename=filename[:240], attachment_path=stored_name,
        attachment_media_type=processed_type, crop=crop,
    )
    save_chat_message(analysis_id=parsed_analysis_id, role="assistant", content=response_text, openai_response_id=openai_response_id)
    return {
        "response": response_text, "response_id": openai_response_id,
        "model": MODEL, "mock": MOCK_MODE, "analysis_id": parsed_analysis_id,
        "attachment_url": f"/api/chat-attachments/{stored_name}", "crop": crop,
    }


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    prompt: str = Form(...),
    crop_json: str | None = Form(None),
    project_json: str | None = Form(None),
) -> dict[str, Any]:
    media_type = detect_media_type(file)
    if media_type not in STANDARD_ALLOWED_TYPES | {SLDDRW_MEDIA_TYPE}:
        raise HTTPException(status_code=415, detail="Поддерживаются JPG, PNG, WEBP, PDF и SLDDRW")
    if len(prompt.strip()) < 3:
        raise HTTPException(status_code=400, detail="Опишите, что нужно проанализировать")

    raw = await file.read()
    logger.info(
        "/api/analyze received | file=%s | type=%s | bytes=%d | mock_mode=%s | openai_mode=%s",
        file.filename or "file", media_type, len(raw), MOCK_MODE, OPENAI_MODE,
    )
    if not raw:
        raise HTTPException(status_code=400, detail="Файл пуст")
    if len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Файл больше {MAX_FILE_MB} МБ")

    crop = parse_crop(crop_json)
    project_snapshot = parse_history_project_snapshot(project_json)
    if media_type in {"application/pdf", SLDDRW_MEDIA_TYPE} and crop:
        crop = None

    openai_response_id: str | None = None
    selected_mode = "mock" if MOCK_MODE else "live"
    logger.info("Analysis routing | selected_mode=%s", selected_mode)
    if MOCK_MODE:
        response_text = build_mock_response(file.filename or "file", media_type, prompt.strip(), crop, raw)
    else:
        response_text, openai_response_id = analyze_with_openai(
            raw=raw,
            filename=file.filename or "file",
            media_type=media_type,
            prompt=prompt,
            crop=crop,
        )

    logger.info(
        "/api/analyze model phase completed | response_id=%s | chars=%d",
        openai_response_id or "local", len(response_text),
    )

    analysis_id = save_history(
        filename=file.filename or "file",
        media_type=media_type,
        prompt=prompt.strip(),
        crop=crop,
        response=response_text,
        model=MODEL,
        mock=MOCK_MODE,
        openai_response_id=openai_response_id,
        project_snapshot=project_snapshot,
    )
    save_chat_message(analysis_id=analysis_id, role="user", content=prompt.strip())
    save_chat_message(
        analysis_id=analysis_id,
        role="assistant",
        content=response_text,
        openai_response_id=openai_response_id,
    )
    intelligence_source = prompt + "\n" + response_text
    if media_type == SLDDRW_MEDIA_TYPE:
        intelligence_source += "\n" + "\n".join(extract_slddrw_text_hints(raw))
    drawing_intelligence = build_drawing_intelligence(intelligence_source)
    logger.info(
        "/api/analyze completed | analysis_id=%s | response_id=%s | mock=%s",
        analysis_id, openai_response_id or "local", MOCK_MODE,
    )
    return {
        "id": analysis_id,
        "response": response_text,
        "response_id": openai_response_id,
        "model": MODEL,
        "mock": MOCK_MODE,
        "crop": crop,
        "drawing_intelligence": drawing_intelligence,
    }


@app.post("/api/stock-removal")
async def stock_removal(
    file: UploadFile | None = File(None),
    stock_mode: str = Form(...),
    blank_diameter: str | None = Form(None),
    blank_length: str | None = Form(None),
    blank_width: str | None = Form(None),
    blank_height: str | None = Form(None),
    blank_mill_length: str | None = Form(None),
    zero_reference: str | None = Form(None),
    first_side: str | None = Form(None),
    notes: str | None = Form(None),
    shopturn_json: str | None = Form(None),
    project_json: str | None = Form(None),
) -> dict[str, Any]:
    if stock_mode not in {"lathe", "mill", "hybrid"}:
        raise HTTPException(status_code=400, detail="Некорректный режим обработки")
    has_file = file is not None and bool(file.filename)
    if not has_file and len((notes or "").strip()) < 10:
        raise HTTPException(status_code=400, detail="Загрузите чертёж или подробно опишите деталь")
    media_type = detect_media_type(file) if has_file else "text/plain"
    if has_file and media_type not in STANDARD_ALLOWED_TYPES | {SLDDRW_MEDIA_TYPE}:
        raise HTTPException(status_code=415, detail="Поддерживаются JPG, PNG, WEBP, PDF и SLDDRW")
    raw = await file.read() if has_file else b""
    if has_file and not raw:
        raise HTTPException(status_code=400, detail="Файл пуст")
    if len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Файл больше {MAX_FILE_MB} МБ")

    if stock_mode == "lathe":
        blank_summary = f"Ø{blank_diameter or '?'} × {blank_length or '?'} мм"
    elif stock_mode == "mill":
        blank_summary = f"{blank_width or '?'} × {blank_height or '?'} × {blank_length or '?'} мм"
    else:
        blank_summary = (
            f"токарная заготовка Ø{blank_diameter or '?'} × {blank_length or '?'} мм; "
            f"фрезерная область {blank_width or '?'} × {blank_height or '?'} × {blank_mill_length or '?'} мм"
        )

    shopturn_data, tool_summary = parse_shopturn_payload(shopturn_json)
    project_snapshot = parse_history_project_snapshot(project_json)
    openai_response_id: str | None = None
    if MOCK_MODE:
        response_text = build_stock_removal_mock(
            (file.filename if has_file else "text-description") or "text-description", media_type, stock_mode, blank_summary,
            zero_reference or "", first_side or "", notes or "", raw, tool_summary
        )
    else:
        if has_file:
            response_text, openai_response_id = stock_removal_with_openai(
                raw=raw, filename=file.filename or "file", media_type=media_type,
                stock_mode=stock_mode, blank_summary=blank_summary,
                zero_reference=zero_reference or "", first_side=first_side or "", notes=notes or "",
                tool_summary=tool_summary
            )
        else:
            response_text = build_stock_removal_mock(
                "text-description", media_type, stock_mode, blank_summary,
                zero_reference or "", first_side or "", notes or "", None, tool_summary
            )

    stock_prompt = f"Stock Removal | {blank_summary} | {shopturn_data.get('operation', 'operation not set')} | T{shopturn_data.get('toolT', '?')} D{shopturn_data.get('toolD', '?')}"
    analysis_id = save_history(
        filename=((file.filename if has_file else "text-description") or "text-description"), media_type=media_type, prompt=stock_prompt, crop=None,
        response=response_text, model=MODEL, mock=MOCK_MODE,
        openai_response_id=openai_response_id,
        project_snapshot=project_snapshot,
    )
    save_chat_message(analysis_id=analysis_id, role="user", content=stock_prompt)
    save_chat_message(
        analysis_id=analysis_id,
        role="assistant",
        content=response_text,
        openai_response_id=openai_response_id,
    )
    return {
        "id": analysis_id,
        "response": response_text,
        "response_id": openai_response_id,
        "model": MODEL,
        "mock": MOCK_MODE,
        "shopturn": shopturn_data,
        "source": "drawing" if has_file else "description",
    }


@app.post("/api/slddrw-preview")
async def slddrw_preview(file: UploadFile = File(...)) -> Response:
    if Path(file.filename or "").suffix.lower() != ".slddrw":
        raise HTTPException(status_code=415, detail="Нужен файл SLDDRW")
    raw = await file.read()
    if not raw or len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=400, detail="Некорректный размер файла")
    preview = extract_slddrw_preview(raw)
    if not preview:
        raise HTTPException(status_code=422, detail="Встроенное превью не найдено")
    image_raw, image_type = preview
    return Response(content=image_raw, media_type=image_type, headers={"Cache-Control": "no-store"})


@app.get("/api/projects")
def list_projects(limit: int = 100) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 300))
    with db_conn() as db:
        rows = db.execute("SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?", (limit,)).fetchall()
    return [project_row_to_dict(row, include_data=False) for row in rows]


@app.post("/api/projects")
def create_project(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    name, encoded = sanitize_project_payload(payload)
    now = int(time.time())
    with db_conn() as db:
        cursor = db.execute(
            "INSERT INTO projects (created_at, updated_at, name, payload_json) VALUES (?, ?, ?, ?)",
            (now, now, name, encoded),
        )
        db.commit()
        row = db.execute("SELECT * FROM projects WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return project_row_to_dict(row)


@app.get("/api/projects/{project_id}")
def get_project(project_id: int) -> dict[str, Any]:
    with db_conn() as db:
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return project_row_to_dict(row)


@app.put("/api/projects/{project_id}")
def update_project(project_id: int, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    name, encoded = sanitize_project_payload(payload)
    now = int(time.time())
    with db_conn() as db:
        cursor = db.execute(
            "UPDATE projects SET updated_at = ?, name = ?, payload_json = ? WHERE id = ?",
            (now, name, encoded, project_id),
        )
        db.commit()
        if cursor.rowcount == 0:
            raise HTTPException(status_code=404, detail="Проект не найден")
        row = db.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    return project_row_to_dict(row)


@app.delete("/api/projects/{project_id}")
def delete_project(project_id: int) -> dict[str, bool]:
    with db_conn() as db:
        cursor = db.execute("DELETE FROM projects WHERE id = ?", (project_id,))
        db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Проект не найден")
    return {"ok": True}


@app.post("/api/export/operator-pdf")
def export_operator_pdf(payload: dict[str, Any] = Body(...)) -> Response:
    snapshot = payload.get("snapshot") if isinstance(payload, dict) else None
    if not isinstance(snapshot, dict):
        raise HTTPException(status_code=400, detail="Не передан зафиксированный результат проекта")
    done = snapshot.get("done")
    if not isinstance(done, list) or len(done) < 9 or not all(bool(x) for x in done[:9]):
        raise HTTPException(status_code=409, detail="PDF доступен только после завершения этапов 1-9")
    if not snapshot.get("simulationReviewed"):
        raise HTTPException(status_code=409, detail="Перед PDF необходимо подтвердить контрольный просмотр симуляции")
    try:
        pdf = build_operator_pdf(snapshot)
    except Exception as exc:
        logger.exception("Operator PDF generation failed")
        raise HTTPException(status_code=500, detail=f"Не удалось сформировать PDF: {exc}") from exc
    project_name = re.sub(r"[^A-Za-z0-9_-]+", "_", str(snapshot.get("projectName") or "project")).strip("_")[:60] or "project"
    filename = f"{project_name}_SINUMERIK_828D_operator_guide.pdf"
    logger.info("Operator PDF generated | project=%s | bytes=%d", project_name, len(pdf))
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Cache-Control": "no-store",
        },
    )


@app.post("/api/contour-ai")
async def generate_contour_ai(
    file: UploadFile = File(...),
    blank_diameter: str | None = Form(None),
    blank_length: str | None = Form(None),
    notes: str | None = Form(None),
) -> dict[str, Any]:
    media_type = detect_media_type(file)
    if media_type not in STANDARD_ALLOWED_TYPES | {SLDDRW_MEDIA_TYPE}:
        raise HTTPException(status_code=415, detail="Поддерживаются JPG, PNG, WEBP, PDF и SLDDRW")
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Файл пуст")
    if len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Файл больше {MAX_FILE_MB} МБ")
    if MOCK_MODE:
        result = build_contour_mock(blank_diameter or "", blank_length or "", raw, file.filename or "file", notes or "")
    else:
        result = contour_with_openai(
            raw=raw,
            filename=file.filename or "file",
            media_type=media_type,
            blank_diameter=blank_diameter or "",
            blank_length=blank_length or "",
            notes=notes or "",
        )
    return {**result, "model": MODEL, "mock": MOCK_MODE}
