import io
import zlib
import os
from pathlib import Path

os.environ["MOCK_MODE"] = "true"
os.environ["DATA_DIR"] = str(Path(__file__).parent / "test_data")

from fastapi.testclient import TestClient
from PIL import Image
from app.main import app

client = TestClient(app)


def make_png() -> bytes:
    output = io.BytesIO()
    Image.new("RGB", (120, 80), "white").save(output, format="PNG")
    return output.getvalue()


def test_health():
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json()["ok"] is True
    assert response.json()["mock_mode"] is True


def test_analyze_image_and_history():
    response = client.post(
        "/api/analyze",
        data={
            "prompt": "Опиши изображение",
            "crop_json": '{"x":0.1,"y":0.1,"width":0.5,"height":0.5}',
        },
        files={"file": ("test.png", make_png(), "image/png")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mock"] is True
    assert "Тестовый анализ" in body["response"]

    history = client.get("/api/history").json()
    assert any(item["id"] == body["id"] for item in history)


def test_reject_unsupported_type():
    response = client.post(
        "/api/analyze",
        data={"prompt": "Проверь файл"},
        files={"file": ("bad.txt", b"text", "text/plain")},
    )
    assert response.status_code == 415



def test_accept_slddrw_with_embedded_preview():
    png = make_png()
    raw = b"prefix" + png + b"suffix"
    response = client.post(
        "/api/analyze",
        data={"prompt": "Разбери чертёж"},
        files={"file": ("sample.SLDDRW", raw, "application/octet-stream")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mock"] is True
    assert "SLDDRW" in body["response"]



def test_stock_removal_mock():
    response = client.post(
        "/api/stock-removal",
        data={
            "stock_mode": "lathe",
            "blank_diameter": "140",
            "blank_length": "58",
            "zero_reference": "Z0 по правому торцу",
            "first_side": "торец А",
            "notes": "Проверить наружный контур",
        },
        files={"file": ("sample.SLDDRW", make_png(), "image/png")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mock"] is True
    assert "Stock Removal" in body["response"]



def test_extract_compressed_slddrw_preview():
    from app.main import extract_slddrw_preview

    png = make_png()
    compressor = zlib.compressobj(level=9, wbits=-15)
    compressed = compressor.compress(png) + compressor.flush()
    magic = b"\x14\x00\x06\x00\x08\x00\x31\x39\xed\x19"
    header = (
        magic
        + b"\x00\x00\x00\x00"
        + len(compressed).to_bytes(4, "little")
        + len(png).to_bytes(4, "little")
        + (14).to_bytes(4, "little")
        + b"metadata-12345"
    )
    raw = b"prefix" + header + compressed + b"suffix"
    preview = extract_slddrw_preview(raw)
    assert preview is not None
    blob, media_type = preview
    assert media_type == "image/png"
    image = Image.open(io.BytesIO(blob))
    assert image.size == (120, 80)


def test_slddrw_preview_endpoint():
    response = client.post(
        "/api/slddrw-preview",
        files={"file": ("preview.SLDDRW", b"prefix" + make_png() + b"suffix", "application/octet-stream")},
    )
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("image/png")


def test_project_crud():
    created = client.post(
        "/api/projects",
        json={"name": "Test project", "data": {"contourPoints": [{"x": 10, "z": 0}, {"x": 8, "z": -5}]}},
    )
    assert created.status_code == 200
    project = created.json()
    project_id = project["id"]
    fetched = client.get(f"/api/projects/{project_id}")
    assert fetched.status_code == 200
    assert fetched.json()["name"] == "Test project"
    updated = client.put(f"/api/projects/{project_id}", json={"name": "Updated", "data": {"value": 2}})
    assert updated.status_code == 200
    assert updated.json()["data"]["value"] == 2
    deleted = client.delete(f"/api/projects/{project_id}")
    assert deleted.status_code == 200


def test_ai_contour_mock():
    response = client.post(
        "/api/contour-ai",
        data={"blank_diameter": "140", "blank_length": "58", "notes": "test"},
        files={"file": ("drawing.png", make_png(), "image/png")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["mock"] is True
    assert len(body["points"]) >= 2
    assert body["points"][0]["type"] == "start"


def test_follow_up_chat_mock_and_history():
    analysis = client.post(
        "/api/analyze",
        data={"prompt": "Проверь чертёж"},
        files={"file": ("chat.png", make_png(), "image/png")},
    )
    assert analysis.status_code == 200
    initial = analysis.json()

    follow_up = client.post(
        "/api/chat",
        json={
            "question": "Материал AISI 304. Что меняется?",
            "analysis_id": initial["id"],
            "previous_response_id": initial.get("response_id"),
            "context_text": initial["response"],
            "conversation": [],
        },
    )
    assert follow_up.status_code == 200
    body = follow_up.json()
    assert body["mock"] is True
    assert "Тестовый ответ диалога" in body["response"]

    history = client.get(f"/api/chat/{initial['id']}")
    assert history.status_code == 200
    messages = history.json()
    assert any(m["role"] == "user" and "AISI 304" in m["content"] for m in messages)
    assert any(m["role"] == "assistant" and "Тестовый ответ диалога" in m["content"] for m in messages)


def test_follow_up_chat_rejects_empty_message():
    response = client.post("/api/chat", json={"question": ""})
    assert response.status_code == 400


def test_stock_removal_accepts_shopturn_tool_flow():
    shopturn = {
        "machineProfile": "tengyue_ck52pty",
        "operation": "od_turn",
        "toolT": "1",
        "toolD": "1",
        "toolName": "Наружный проходной",
        "holder": "PCLNR 2525M12",
        "insert": "CNMG 120408",
        "speed": "650",
        "feed": "0.18",
        "depth": "1.5",
        "machining": "Longitudinal",
        "position": "Outside",
        "x0": "140.000",
        "z0": "0.000",
        "x1": "130.000",
        "z1": "-55.000",
        "fs1": "0.000",
        "fs2": "0.000",
        "fs3": "0.000",
        "ux": "0.100",
        "uz": "0.100",
        "coolant": True,
        "driven": False,
    }
    import json
    response = client.post(
        "/api/stock-removal",
        data={
            "stock_mode": "lathe",
            "blank_diameter": "140",
            "blank_length": "58",
            "zero_reference": "Z0 по правому торцу",
            "first_side": "торец А",
            "notes": "AISI 304",
            "shopturn_json": json.dumps(shopturn, ensure_ascii=False),
        },
        files={"file": ("part.png", make_png(), "image/png")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["shopturn"]["toolT"] == "1"
    assert body["shopturn"]["operation"] == "od_turn"
    assert "Tengyue CK52PT-Y" in body["response"]


def test_health_reports_shopturn_feature():
    body = client.get("/api/health").json()
    assert body["version"] == "2.3.1-pro"
    assert "shopturn_tool_flow" in body["features"]


def test_metric_thread_catalog_and_m8_default_pitch():
    body = client.get('/api/thread-catalog').json()
    m8 = next(item for item in body['items'] if item['designation'] == 'M8')
    assert m8['coarse'] == 1.25
    assert 1.25 in m8['pitches']


def test_thread_inference_uses_coarse_pitch_when_omitted():
    from app.main import infer_metric_threads
    inferred = infer_metric_threads('Резьба М8, класс 6H')
    assert inferred[0]['designation'] == 'M8'
    assert inferred[0]['pitch'] == 1.25
    assert inferred[0]['pitch_source'] == 'iso_coarse_default'
    explicit = infer_metric_threads('M8x1.0')
    assert explicit[0]['pitch'] == 1.0
    assert explicit[0]['pitch_source'] == 'explicit'


def test_analyze_returns_drawing_intelligence():
    response = client.post(
        '/api/analyze',
        data={'prompt': 'Проверь Ø30 +0.2/0 и резьбу M8'},
        files={'file': ('drawing.png', make_png(), 'image/png')},
    )
    assert response.status_code == 200
    intel = response.json()['drawing_intelligence']
    assert any(item['designation'] == 'M8' and item['pitch'] == 1.25 for item in intel['threads'])
    assert any('+0.2/0' in item.replace(' ', '') for item in intel['tolerances'])


def test_stock_removal_accepts_operation_route():
    import json
    route = [
        {'id': '1', 'enabled': True, 'operation': 'face', 'label': 'Face · Торцовка', 'toolT': '1', 'toolD': '1', 'toolName': 'Подрезной', 'speed': '650', 'feed': '0.12', 'depth': '1.0'},
        {'id': '2', 'enabled': True, 'operation': 'thread_int', 'label': 'Thread ID', 'toolT': '7', 'toolD': '7', 'toolName': 'Резьбовой', 'speed': '220', 'feed': '1.25', 'depth': '0.12', 'thread': {'designation': 'M8', 'pitch': 1.25}},
        {'id': '3', 'enabled': True, 'operation': 'partoff', 'label': 'Part-off', 'toolT': '5', 'toolD': '5', 'toolName': 'Отрезной', 'speed': '350', 'feed': '0.05', 'depth': '1.0'},
    ]
    payload = {
        'machineProfile': 'tengyue_ck52pty',
        'operation': 'face',
        'toolT': '1', 'toolD': '1', 'toolName': 'Подрезной',
        'speed': '650', 'feed': '0.12', 'depth': '1.0',
        'machining': 'Face', 'position': 'Face',
        'x0': '140', 'z0': '0', 'x1': '0', 'z1': '-1',
        'operations': route,
        'chamfers': [{'x': 0.5, 'y': 0.5, 'mode': 'chamfer', 'notation': '1×45°'}],
    }
    response = client.post(
        '/api/stock-removal',
        data={'stock_mode': 'lathe', 'blank_diameter': '140', 'blank_length': '58', 'shopturn_json': json.dumps(payload, ensure_ascii=False)},
        files={'file': ('route.png', make_png(), 'image/png')},
    )
    assert response.status_code == 200
    body = response.json()
    assert len(body['shopturn']['operations']) == 3
    assert 'Маршрут обработки' in body['response']


def test_generic_chamfer_question_is_not_treated_as_explicit_chamfer():
    from app.main import build_drawing_intelligence
    intel = build_drawing_intelligence('Проверь фаски и уточни, нужны ли они.')
    assert intel['chamfers_detected'] == []
    assert intel['requires_chamfer_decision'] is True


def test_binary_like_n1_is_not_treated_as_fit_tolerance():
    from app.main import extract_tolerance_tokens
    assert 'n1' not in [item.lower() for item in extract_tolerance_tokens('stream n1 internal data')]



def test_stale_openai_file_reference_is_detected():
    from app.main import is_stale_openai_reference_error

    class FakeNotFoundError(Exception):
        status_code = 404

    error = FakeNotFoundError(
        "Error code: 404 - Files [file-old] were not found"
    )
    assert is_stale_openai_reference_error(error) is True
    assert is_stale_openai_reference_error(RuntimeError("network timeout")) is False


def test_chat_rebuilds_context_after_deleted_openai_file(monkeypatch):
    import sys
    from types import SimpleNamespace
    from app.main import chat_with_openai

    calls = []

    class FakeNotFoundError(Exception):
        status_code = 404

    class FakeResponses:
        def create(self, **kwargs):
            calls.append(kwargs)
            if kwargs.get("previous_response_id"):
                raise FakeNotFoundError(
                    "Error code: 404 - Files [file-deleted] were not found"
                )
            return SimpleNamespace(
                output_text="Контекст восстановлен без повторной загрузки файла.",
                id="resp-recovered",
            )

    class FakeOpenAI:
        def __init__(self, api_key):
            self.responses = FakeResponses()

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", SimpleNamespace(OpenAI=FakeOpenAI))

    text, response_id = chat_with_openai(
        question="Куда применяется IT14/2?",
        previous_response_id="resp-with-deleted-file",
        context_text="На чертеже указаны H14, h14 и ±IT14/2.",
        conversation=[
            {"role": "user", "content": "Проверь допуски"},
            {"role": "assistant", "content": "Вижу общие допуски."},
        ],
    )

    assert text.startswith("Контекст восстановлен")
    assert response_id == "resp-recovered"
    assert len(calls) == 2
    assert calls[0]["previous_response_id"] == "resp-with-deleted-file"
    assert "previous_response_id" not in calls[1]
    rebuilt = calls[1]["input"]
    assert any("H14, h14" in item.get("content", "") for item in rebuilt)
    assert rebuilt[-1]["content"] == "Куда применяется IT14/2?"


def test_pdf_follow_up_does_not_reuse_deleted_file_chain():
    from app.main import safe_follow_up_response_id

    assert safe_follow_up_response_id("application/pdf", "resp-pdf") is None
    assert safe_follow_up_response_id("image/png", "resp-image") == "resp-image"
