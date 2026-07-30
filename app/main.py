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
MAX_FILE_MB = int(os.getenv("MAX_FILE_MB", "20"))
MODEL = os.getenv("OPENAI_MODEL", "gpt-5-mini")
MOCK_MODE = os.getenv("MOCK_MODE", "false").lower() in {"1", "true", "yes"}
KEEP_OPENAI_FILES = os.getenv("KEEP_OPENAI_FILES", "false").lower() in {"1", "true", "yes"}

ALLOWED_IMAGE_TYPES = {"image/jpeg", "image/png", "image/webp"}
STANDARD_ALLOWED_TYPES = ALLOWED_IMAGE_TYPES | {"application/pdf"}
SLDDRW_SUFFIXES = {".slddrw"}
SLDDRW_MEDIA_TYPE = "application/slddrw"

SYSTEM_INSTRUCTIONS = """Ты персональный AI-ассистент для анализа фотографий, документов, технических изображений и PDF.
Отвечай на русском языке, если пользователь не попросил иначе. Будь конкретным: сначала краткий вывод, затем найденные детали,
риски или неопределенности, после этого практические действия. Не выдумывай текст или размеры, которых невозможно уверенно увидеть.
Для опасных технических операций обязательно указывай, что результат нужно проверить специалистом и по исходной документации.
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


app = FastAPI(title="Personal AI Client", version="2.0.0-pro", lifespan=lifespan)
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
                mock INTEGER NOT NULL DEFAULT 0
            )
            """
        )
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


def save_history(
    *, filename: str, media_type: str, prompt: str, crop: dict[str, float] | None,
    response: str, model: str, mock: bool
) -> int:
    with db_conn() as db:
        cursor = db.execute(
            """INSERT INTO analyses
            (created_at, filename, media_type, prompt, crop_json, response, model, mock)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (
                int(time.time()), filename, media_type, prompt,
                json.dumps(crop, ensure_ascii=False) if crop else None,
                response, model, int(mock),
            ),
        )
        db.commit()
        return int(cursor.lastrowid)


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
) -> str:
    api_key = os.getenv("OPENAI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="OPENAI_API_KEY не настроен. Включите MOCK_MODE=true для проверки интерфейса.",
        )

    from openai import OpenAI

    client = OpenAI(api_key=api_key)
    user_text = prompt.strip()
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
        return text
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


def create_stock_removal_prompt(*, stock_mode: str, blank_summary: str, zero_reference: str, first_side: str, notes: str) -> str:
    mode_text = "токарная обработка X/Z" if stock_mode == "lathe" else "фрезерная обработка"
    return f"""Ты CNC-assistant. На основе чертежа и параметров заготовки составь заготовительный план Stock Removal.
Режим: {mode_text}.
Параметры заготовки: {blank_summary}.
База/ноль детали: {zero_reference or 'не указано'}.
Первая сторона обработки: {first_side or 'не указано'}.
Дополнительные замечания пользователя: {notes or 'нет'}.

Сделай ответ на русском и строго по структуре:
1. Краткий вывод.
2. Извлечённые размеры детали, которые видны уверенно.
3. Что ещё нужно уточнить.
4. Предлагаемый план Stock Removal по шагам.
5. Если режим токарный: таблица координат X/Z для ориентировочного контура. X указывай в диаметрах.
6. Если режим фрезерный: список поверхностей/карманов/уступов и съёма материала.
7. Отдельно блок 'Важно проверить'.

Нельзя выдумывать скрытые размеры. Если данных мало — так и скажи. Если на чертеже есть повторы или спорные места, перечисли допущения явно.
"""


def build_stock_removal_mock(filename: str, media_type: str, stock_mode: str, blank_summary: str, zero_reference: str, first_side: str, notes: str, raw: bytes | None = None) -> str:
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
    if stock_mode == "lathe":
        coord_table = "| Точка | X | Z | Комментарий |\n|---|---:|---:|---|\n| P1 | Ø140 | 0 | Старт по заготовке |\n| P2 | Ø130 | -5 | Наружный диаметр |\n| P3 | Ø92 | -20 | Первая ступень |\n| P4 | Ø70 | -40 | Вторая ступень |\n| P5 | Ø30 | -55 | Отверстие/конечная зона |"
    else:
        coord_table = "- Снять плоскость до базовой высоты\n- Обработать центральную ступень\n- Обработать периферию и карманы по подтверждённому контуру"
    extra = "Да" if preview else "Нет"
    extracted_text = "\n".join(f"- {item}" for item in extracted)
    plan_text = "\n".join(f"{i+1}. {item}" for i, item in enumerate(plan))
    return f"""## Stock Removal · тестовый режим

**Файл:** {filename} ({file_kind})  
**Встроенное превью для SLDDRW:** {extra}  
**Режим:** {'Токарный X/Z' if stock_mode == 'lathe' else 'Фрезерный'}  
**Заготовка:** {blank_summary}  
**Ноль детали:** {zero_reference or 'не указан'}  
**Первая сторона:** {first_side or 'не указана'}

### Извлечённые размеры
{extracted_text}

### Предлагаемый план
{plan_text}

### Ориентировочная схема
{coord_table}

### Дополнительно
- Замечания пользователя: {notes or 'нет'}
- Это демонстрационный расчёт. Для живого результата отключи `MOCK_MODE`.
- Перед вводом в стойку обязательно сверить контур с исходным чертежом и фактической заготовкой.
"""


def stock_removal_with_openai(*, raw: bytes, filename: str, media_type: str, stock_mode: str, blank_summary: str, zero_reference: str, first_side: str, notes: str) -> str:
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
        return text
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
        "version": "2.0.0-pro",
        "features": ["projects", "contour_editor", "slddrw_preview", "ai_contour", "sinumerik_export"],
    }


@app.get("/api/history")
def history(limit: int = 30) -> list[dict[str, Any]]:
    limit = max(1, min(limit, 100))
    with db_conn() as db:
        rows = db.execute(
            "SELECT * FROM analyses ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    result = []
    for row in rows:
        item = dict(row)
        item["crop"] = json.loads(item.pop("crop_json")) if item.get("crop_json") else None
        item["mock"] = bool(item["mock"])
        result.append(item)
    return result


@app.delete("/api/history/{analysis_id}")
def delete_history(analysis_id: int) -> dict[str, bool]:
    with db_conn() as db:
        cursor = db.execute("DELETE FROM analyses WHERE id = ?", (analysis_id,))
        db.commit()
    if cursor.rowcount == 0:
        raise HTTPException(status_code=404, detail="Запись не найдена")
    return {"ok": True}


@app.post("/api/analyze")
async def analyze(
    file: UploadFile = File(...),
    prompt: str = Form(...),
    crop_json: str | None = Form(None),
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
    if media_type in {"application/pdf", SLDDRW_MEDIA_TYPE} and crop:
        crop = None

    if MOCK_MODE:
        response_text = build_mock_response(file.filename or "file", media_type, prompt.strip(), crop, raw)
    else:
        response_text = analyze_with_openai(
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
    )
    return {
        "id": analysis_id,
        "response": response_text,
        "model": MODEL,
        "mock": MOCK_MODE,
        "crop": crop,
    }


@app.post("/api/stock-removal")
async def stock_removal(
    file: UploadFile = File(...),
    stock_mode: str = Form(...),
    blank_diameter: str | None = Form(None),
    blank_length: str | None = Form(None),
    blank_width: str | None = Form(None),
    blank_height: str | None = Form(None),
    zero_reference: str | None = Form(None),
    first_side: str | None = Form(None),
    notes: str | None = Form(None),
) -> dict[str, Any]:
    media_type = detect_media_type(file)
    if media_type not in STANDARD_ALLOWED_TYPES | {SLDDRW_MEDIA_TYPE}:
        raise HTTPException(status_code=415, detail="Поддерживаются JPG, PNG, WEBP, PDF и SLDDRW")
    if stock_mode not in {"lathe", "mill"}:
        raise HTTPException(status_code=400, detail="Некорректный режим обработки")

    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Файл пуст")
    if len(raw) > MAX_FILE_MB * 1024 * 1024:
        raise HTTPException(status_code=413, detail=f"Файл больше {MAX_FILE_MB} МБ")

    if stock_mode == "lathe":
        blank_summary = f"Ø{blank_diameter or '?'} × {blank_length or '?'} мм"
    else:
        blank_summary = f"{blank_width or '?'} × {blank_height or '?'} × {blank_length or '?'} мм"

    response_text = build_stock_removal_mock(
        file.filename or "file", media_type, stock_mode, blank_summary, zero_reference or "", first_side or "", notes or "", raw
    ) if MOCK_MODE else stock_removal_with_openai(
        raw=raw, filename=file.filename or "file", media_type=media_type, stock_mode=stock_mode, blank_summary=blank_summary,
        zero_reference=zero_reference or "", first_side=first_side or "", notes=notes or ""
    )

    analysis_id = save_history(
        filename=file.filename or "file", media_type=media_type, prompt=f"Stock Removal | {blank_summary}", crop=None,
        response=response_text, model=MODEL, mock=MOCK_MODE,
    )
    return {"id": analysis_id, "response": response_text, "model": MODEL, "mock": MOCK_MODE}


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
