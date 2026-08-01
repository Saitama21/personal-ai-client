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
    assert body["version"] == "2.3.6-pro"
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


def test_history_project_snapshot_roundtrip():
    import json
    project = {
        "fileName": "history-part.png",
        "contourPoints": [{"x": 40, "z": 0, "type": "start"}, {"x": 30, "z": -10, "type": "lineX"}],
        "operationRoute": [{"operation": "face", "toolT": "1", "toolD": "1"}],
        "projectThreads": [{"designation": "M8", "pitch": 1.25}],
    }
    response = client.post(
        "/api/analyze",
        data={"prompt": "Проверь проект", "project_json": json.dumps(project, ensure_ascii=False)},
        files={"file": ("history-part.png", make_png(), "image/png")},
    )
    assert response.status_code == 200
    analysis_id = response.json()["id"]
    listing = client.get("/api/history").json()
    row = next(item for item in listing if item["id"] == analysis_id)
    assert row["has_project"] is True
    detail = client.get(f"/api/history/{analysis_id}")
    assert detail.status_code == 200
    body = detail.json()
    assert body["project"]["fileName"] == "history-part.png"
    assert body["project"]["projectThreads"][0]["pitch"] == 1.25


def test_history_entry_without_snapshot_is_still_readable():
    response = client.post(
        "/api/analyze",
        data={"prompt": "Старая запись без снимка"},
        files={"file": ("legacy.png", make_png(), "image/png")},
    )
    assert response.status_code == 200
    detail = client.get(f"/api/history/{response.json()['id']}").json()
    assert detail["has_project"] is False
    assert detail["project"] is None


def test_general_tolerance_rules_are_case_sensitive_and_interpreted():
    from app.main import interpret_general_tolerance_rules

    rules = interpret_general_tolerance_rules('Неуказанные отклонения: отверстий H14, валов h14, прочих ±IT14/2.')
    by_name = {item['designation']: item for item in rules}

    assert by_name['H14']['lower_deviation'] == '0'
    assert by_name['H14']['upper_deviation'] == '+IT14'
    assert by_name['h14']['lower_deviation'] == '−IT14'
    assert by_name['h14']['upper_deviation'] == '0'
    assert by_name['±IT14/2']['lower_deviation'] == '−IT14/2'
    assert by_name['±IT14/2']['upper_deviation'] == '+IT14/2'


def test_drawing_intelligence_returns_general_tolerance_interpretations():
    from app.main import build_drawing_intelligence

    intel = build_drawing_intelligence('H14 h14 ±IT14/2')
    names = [item['designation'] for item in intel['tolerance_interpretations']]
    assert names == ['H14', 'h14', '±IT14/2']


def test_health_reports_general_tolerance_rule_feature():
    body = client.get('/api/health').json()
    assert 'general_tolerance_h14_rule' in body['features']


def test_tolerance_token_extraction_keeps_H14_and_h14_separate():
    from app.main import extract_tolerance_tokens
    tokens = extract_tolerance_tokens('H14 h14 ±IT14/2')
    assert 'H14' in tokens
    assert 'h14' in tokens
    assert '±IT14/2' in tokens


def test_stock_removal_accepts_hybrid_mode_and_multi_options():
    response = client.post(
        "/api/stock-removal",
        data={
            "stock_mode": "hybrid",
            "blank_diameter": "140",
            "blank_length": "58",
            "blank_width": "180",
            "blank_height": "120",
            "blank_mill_length": "12",
            "zero_reference": "X0 по оси детали; Z0 по правому торцу",
            "first_side": "Торец A; Обработка с двух сторон",
            "notes": "Комбинированная обработка",
        },
        files={"file": ("part.png", make_png(), "image/png")},
    )
    assert response.status_code == 200
    body = response.json()
    assert "Токарный X/Z + фрезерный" in body["response"]
    assert "X0 по оси детали; Z0 по правому торцу" in body["response"]
    assert "Торец A; Обработка с двух сторон" in body["response"]


def test_chat_image_region_mock_and_attachment_history():
    analysis = client.post("/api/analyze", data={"prompt":"Проверь чертёж"}, files={"file":("base.png", make_png(), "image/png")})
    assert analysis.status_code == 200
    analysis_id = analysis.json()["id"]
    response = client.post("/api/chat-image", data={"question":"Что указано в выделенной области?","analysis_id":str(analysis_id),"context_text":analysis.json()["response"],"conversation_json":"[]","crop_json":'{"x":0.25,"y":0.25,"width":0.5,"height":0.5}'}, files={"file":("detail.png", make_png(), "image/png")})
    assert response.status_code == 200
    body=response.json()
    assert body["mock"] is True
    assert "изображение" in body["response"].lower()
    attachment=client.get(body["attachment_url"])
    assert attachment.status_code == 200
    image=Image.open(io.BytesIO(attachment.content))
    assert image.size == (60,40)
    history=client.get(f"/api/chat/{analysis_id}").json()
    user=[x for x in history if x["role"]=="user" and x.get("attachment_url")]
    assert user and user[-1]["crop"]["width"] == 0.5
    assert user[-1]["attachment_filename"] == "detail.png"

def test_chat_image_rejects_non_image():
    response=client.post("/api/chat-image",data={"question":"Проверь"},files={"file":("bad.txt",b"not image","text/plain")})
    assert response.status_code == 415

def test_health_reports_chat_image_features():
    body=client.get('/api/health').json()
    assert 'chat_image_upload' in body['features']
    assert 'chat_region_selection' in body['features']


def test_chat_does_not_reuse_previous_response_file_chain(monkeypatch):
    """A deleted upload in the original response must not break later chat turns."""
    import sys
    import types
    from app import main as main_module

    calls = []

    class FakeResponse:
        output_text = "Ответ без повторного использования временного file_id"
        id = "resp_new"

    class FakeResponses:
        def create(self, **kwargs):
            calls.append(kwargs)
            assert "previous_response_id" not in kwargs
            return FakeResponse()

    class FakeClient:
        def __init__(self, api_key):
            self.responses = FakeResponses()

    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setitem(sys.modules, "openai", types.SimpleNamespace(OpenAI=FakeClient))

    text, response_id = main_module.chat_with_openai(
        question="M8 1.25",
        previous_response_id="resp_with_deleted_file",
        context_text="Исходный анализ чертежа",
        conversation=[{"role": "user", "content": "Уточнение"}],
    )

    assert "временного file_id" in text
    assert response_id == "resp_new"
    assert calls
    assert calls[0]["input"][-1]["content"] == "M8 1.25"
