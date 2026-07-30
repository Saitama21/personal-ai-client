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
