from __future__ import annotations

import base64
import io
import json
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

BASE_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = BASE_DIR / "app" / "static"
DATA_DIR = Path(os.getenv("DATA_DIR", BASE_DIR / "data"))
DB_PATH = DATA_DIR / "history.db"
UPLOAD_DIR = DATA_DIR / "uploads"
CHAT_UPLOAD_DIR = DATA_DIR / "chat_uploads"
MAX_FILE_MB = int(os.getenv("MAX_FILE_MB", "20"))
MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini")
MOCK_MODE = os.getenv("MOCK_MODE", "false").lower() in {"1", "true", "yes"}
KEEP_OPENAI_FILES = os.getenv("KEEP_OPENAI_FILES", "false").lower() in {"1", "true", "yes"}

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


def build_drawing_intelligence(text: str) -> dict[str, Any]:
    threads = infer_metric_threads(text)
    tolerances = extract_tolerance_tokens(text)
    tolerance_interpretations = interpret_general_tolerance_rules(text)
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
    return {
        "threads": threads,
        "tolerances": tolerances,
        "tolerance_interpretations": tolerance_interpretations,
        "chamfers_detected": chamfer_tokens[:20],
        "requires_chamfer_decision": not bool(chamfer_tokens),
        "notes": [
            "Шаг резьбы без явного указания принимается по стандартному крупному ряду и помечается как предположение.",
            "Неуказанные фаски не создаются автоматически: оператор отмечает их на мини-чертёже.",
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


app = FastAPI(title="Personal AI Client", version="2.3.5-pro", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
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


def build_mock_response(filename: str, media_type: str, prompt: str, crop: dict[str, float] | None, raw: bytes | None = None) -> str:
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
        "Сейчас включён `MOCK_MODE`, поэтому запрос не отправлялся в OpenAI. "
        "После добавления `OPENAI_API_KEY` и отключения тестового режима здесь появится настоящий анализ."
    )


def analyze_with_openai(
    *, raw: bytes, filename: str, media_type: str, prompt: str, crop: dict[str, float] | None
) -> tuple[str, str]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY не настроен. Включите MOCK_MODE=true для проверки интерфейса.",
        )

    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    user_text = augment_drawing_prompt(prompt)
    if crop:
        user_text += "\n\nПользователь специально выделил область. Сосредоточь анализ прежде всего на ней."

    uploaded_file_id: str | None = None
    try:
        if media_type == "application/pdf":
            uploaded = client.files.create(
                file=(filename, raw, "application/pdf"),
                purpose="user_data",
            )
            uploaded_file_id = uploaded.id
            content: list[dict[str, Any]] = [
                {"type": "input_text", "text": user_text},
                {"type": "input_file", "file_id": uploaded.id},
            ]
        elif media_type == SLDDRW_MEDIA_TYPE:
            slddrw_context, preview = build_slddrw_context(raw, filename)
            content = [
                {"type": "input_text", "text": user_text + "\n\n" + slddrw_context},
            ]
            if preview:
                preview_raw, preview_type = preview
                content.append({"type": "input_image", "image_url": image_data_url(preview_raw, preview_type), "detail": "high"})
        else:
            processed, processed_type = crop_image(raw, crop)
            content = [
                {"type": "input_text", "text": user_text},
                {"type": "input_image", "image_url": image_data_url(processed, processed_type), "detail": "high"},
            ]

        response = client.responses.create(
            model=MODEL,
            instructions=SYSTEM_INSTRUCTIONS,
            input=[{"role": "user", "content": content}],
        )
        text = response.output_text.strip()
        if not text:
            raise HTTPException(status_code=502, detail="Модель вернула пустой ответ")
        return text, response.id
    except HTTPException:
        raise
    except Exception as exc:  # SDK exceptions differ by installed version
        raise HTTPException(status_code=502, detail=f"Ошибка OpenAI API: {exc}") from exc
    finally:
        if uploaded_file_id and not KEEP_OPENAI_FILES:
            try:
                client.files.delete(uploaded_file_id)
            except Exception:
                pass




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

Нельзя выдумывать скрытые размеры. Если данных мало — так и скажи. Если на чертеже есть повторы или спорные места, перечисли допущения явно.
"""


def build_stock_removal_mock(filename: str, media_type: str, stock_mode: str, blank_summary: str, zero_reference: str, first_side: str, notes: str, raw: bytes | None = None, tool_summary: str = "") -> str:
    file_kind = "SLDDRW" if media_type == SLDDRW_MEDIA_TYPE else ("PDF" if media_type == "application/pdf" else "изображение")
    preview = extract_slddrw_preview(raw or b"") if media_type == SLDDRW_MEDIA_TYPE and raw is not None else None
    extracted = [
        "наружный Ø130 мм",
        "центральное отверстие Ø30 мм (+0.2/0)",
        "ступень Ø92 мм",
        "ступень Ø70 мм",
        "общая длина/высота 55 мм",
    ] if media_type == SLDDRW_MEDIA_TYPE else ["Размеры будут извлечены моделью из загруженного файла."]
    plan = [
        "Проверить базу и сторону установки.",
        "Снять наружный припуск до ближайшего безопасного диаметра.",
        "Вывести ступени по размерам чертежа.",
        "Проконтролировать отверстие и сопряжения.",
        "Оставить чистовой припуск под финальный проход.",
    ]
    lathe_table = "| Точка | X | Z | Комментарий |\n|---|---:|---:|---|\n| P1 | Ø140 | 0 | Старт по заготовке |\n| P2 | Ø130 | -5 | Наружный диаметр |\n| P3 | Ø92 | -20 | Первая ступень |\n| P4 | Ø70 | -40 | Вторая ступень |\n| P5 | Ø30 | -55 | Отверстие/конечная зона |"
    mill_list = "- Снять плоскость до базовой высоты\n- Обработать центральную ступень\n- Обработать периферию, карманы и отверстия по подтверждённому контуру"
    if stock_mode == "lathe":
        coord_table = lathe_table
    elif stock_mode == "mill":
        coord_table = mill_list
    else:
        coord_table = f"#### Токарная часть\n{lathe_table}\n\n#### Фрезерная часть\n{mill_list}"
    extra = "Да" if preview else "Нет"
    extracted_text = "\n".join(f"- {item}" for item in extracted)
    plan_text = "\n".join(f"{i+1}. {item}" for i, item in enumerate(plan))
    mode_label = {
        "lathe": "Токарный X/Z",
        "mill": "Фрезерный",
        "hybrid": "Токарный X/Z + фрезерный",
    }.get(stock_mode, stock_mode)
    return f"""## Stock Removal · тестовый режим

**Файл:** {filename} ({file_kind})  
**Встроенное превью для SLDDRW:** {extra}  
**Режим:** {mode_label}  
**Заготовка:** {blank_summary}  
**Ноль детали:** {zero_reference or 'не указан'}  
**Первая сторона:** {first_side or 'не указана'}

### Извлечённые размеры
{extracted_text}

### Предлагаемый план
{plan_text}

### Ориентировочная схема
{coord_table}

### Инструмент и ShopTurn 828D
{tool_summary or "Не заполнено"}

### Дополнительно
- Замечания пользователя: {notes or 'нет'}
- Это демонстрационный расчёт. Для живого результата отключи `MOCK_MODE`.
- Перед вводом в стойку обязательно сверить контур с исходным чертежом и фактической заготовкой.
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
        if previous_response_id:
            response = client.responses.create(
                model=MODEL, instructions=chat_instructions,
                previous_response_id=previous_response_id,
                input=[{"role": "user", "content": user_content}],
            )
        else:
            input_messages: list[dict[str, Any]] = []
            if context_text.strip():
                input_messages.append({"role": "assistant", "content": "Предыдущий ответ ассистента:\n" + context_text.strip()[:16000]})
            input_messages.extend(conversation[-16:])
            input_messages.append({"role": "user", "content": user_content})
            response = client.responses.create(model=MODEL, instructions=chat_instructions, input=input_messages)
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


def build_contour_mock(blank_diameter: str, blank_length: str) -> dict[str, Any]:
    try:
        diameter = float(str(blank_diameter or 140).replace(",", "."))
    except ValueError:
        diameter = 140.0
    try:
        length = float(str(blank_length or 58).replace(",", "."))
    except ValueError:
        length = 58.0
    points = [
        {"x": diameter, "z": 0.0, "type": "start", "rv": "—", "direction": "—"},
        {"x": 130.0, "z": -3.0, "type": "lineX", "rv": "—", "direction": "по X"},
        {"x": 130.0, "z": -20.0, "type": "lineZ", "rv": "—", "direction": "по Z"},
        {"x": 92.0, "z": -20.0, "type": "chamfer", "rv": "2×45°", "direction": "—"},
        {"x": 92.0, "z": -40.0, "type": "lineZ", "rv": "—", "direction": "по Z"},
        {"x": 70.0, "z": -40.0, "type": "lineX", "rv": "—", "direction": "по X"},
        {"x": 70.0, "z": -min(length, 55.0), "type": "lineZ", "rv": "—", "direction": "по Z"},
    ]
    return {
        "name": "AI-контур (тест)",
        "confidence": 0.72,
        "assumptions": ["Контур ориентировочный", "X задан в диаметрах", "Z0 расположен на правом торце"],
        "points": points,
    }


def contour_with_openai(*, raw: bytes, filename: str, media_type: str, blank_diameter: str, blank_length: str, notes: str) -> dict[str, Any]:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="OPENAI_API_KEY не настроен")
    from openai import OpenAI
    client = OpenAI(api_key=api_key)
    uploaded_file_id: str | None = None
    prompt = f"""Проанализируй технический чертёж и предложи ориентировочный наружный токарный контур X/Z для Stock Removal.
Заготовка: диаметр {blank_diameter or 'не указан'} мм, длина {blank_length or 'не указана'} мм.
Примечания: {notes or 'нет'}.
X указывай в диаметрах. Z0 считать на правом торце, рабочее направление Z отрицательное.
Возвращай ТОЛЬКО JSON без markdown:
{{"name":"...","confidence":0.0,"assumptions":["..."],"points":[{{"x":140,"z":0,"type":"start","rv":"—","direction":"—"}},{{"x":130,"z":-3,"type":"lineX","rv":"—","direction":"по X"}}]}}
Допустимые type: start, lineX, lineZ, arcCW, arcCCW, chamfer. Не выдумывай невидимые размеры; сомнительные места перечисли в assumptions.
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
        return {
            "name": str(value.get("name") or "AI-контур")[:120],
            "confidence": max(0.0, min(1.0, float(value.get("confidence") or 0.0))),
            "assumptions": [str(x)[:300] for x in value.get("assumptions", []) if isinstance(x, (str, int, float))][:20],
            "points": validate_contour_points(value.get("points")),
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
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "model": MODEL,
        "mock_mode": MOCK_MODE,
        "api_key_configured": bool(os.getenv("OPENAI_API_KEY")),
        "max_file_mb": MAX_FILE_MB,
        "supported_types": ["JPG", "PNG", "WEBP", "PDF", "SLDDRW"],
        "version": "2.3.5-pro",
        "features": ["projects", "contour_editor", "slddrw_preview", "ai_contour", "sinumerik_export", "follow_up_chat", "shopturn_tool_flow", "tengyue_ck52pty_profile", "drawing_intelligence", "tolerance_detection", "metric_thread_catalog", "chamfer_marker", "multi_operation_route", "contour_mirroring", "history_project_restore", "mobile_history", "multi_operation_picker", "general_tolerance_h14_rule", "stock_mode_radio", "multi_checkbox_setup", "hybrid_turn_mill_mode", "chat_image_upload", "chat_region_selection"],
    }


@app.get("/api/thread-catalog")
def thread_catalog() -> dict[str, Any]:
    return {
        "standard": "ISO metric",
        "items": [
            {"designation": key, **value}
            for key, value in sorted(METRIC_THREAD_CATALOG.items(), key=lambda item: item[1]["diameter"])
        ],
        "note": "Фактическая возможность обработки зависит от установочной схемы, патрона, державки, пластины и машинных ограничений.",
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
    if not raw:
        raise HTTPException(status_code=400, detail="Файл пуст")
    if len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Файл больше {MAX_FILE_MB} МБ")

    crop = parse_crop(crop_json)
    project_snapshot = parse_history_project_snapshot(project_json)
    if media_type in {"application/pdf", SLDDRW_MEDIA_TYPE} and crop:
        crop = None

    openai_response_id: str | None = None
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
    file: UploadFile = File(...),
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
    media_type = detect_media_type(file)
    if media_type not in STANDARD_ALLOWED_TYPES | {SLDDRW_MEDIA_TYPE}:
        raise HTTPException(status_code=415, detail="Поддерживаются JPG, PNG, WEBP, PDF и SLDDRW")
    if stock_mode not in {"lathe", "mill", "hybrid"}:
        raise HTTPException(status_code=400, detail="Некорректный режим обработки")

    raw = await file.read()
    if not raw:
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
            file.filename or "file", media_type, stock_mode, blank_summary,
            zero_reference or "", first_side or "", notes or "", raw, tool_summary
        )
    else:
        response_text, openai_response_id = stock_removal_with_openai(
            raw=raw, filename=file.filename or "file", media_type=media_type,
            stock_mode=stock_mode, blank_summary=blank_summary,
            zero_reference=zero_reference or "", first_side=first_side or "", notes=notes or "",
            tool_summary=tool_summary
        )

    stock_prompt = f"Stock Removal | {blank_summary} | {shopturn_data.get('operation', 'operation not set')} | T{shopturn_data.get('toolT', '?')} D{shopturn_data.get('toolD', '?')}"
    analysis_id = save_history(
        filename=file.filename or "file", media_type=media_type, prompt=stock_prompt, crop=None,
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
        result = build_contour_mock(blank_diameter or "", blank_length or "")
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
