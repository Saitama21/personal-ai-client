import io
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
