import os
from pathlib import Path

os.environ["MOCK_MODE"] = "true"
os.environ["DATA_DIR"] = str(Path(__file__).parent / "test_data")

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)


def test_digital_twin_endpoints():
    summary = client.get("/api/digital-twin/summary")
    assert summary.status_code == 200
    assert summary.json()["counts"]["manual_pages"] == 4973

    search = client.get("/api/digital-twin/search", params={"q": "TRACYL", "manual_id": "siemens_nc_495"})
    assert search.status_code == 200
    assert search.json()["items"]

    photos = client.get("/api/digital-twin/photos", params={"category": "tooling"})
    assert photos.status_code == 200
    assert photos.json()["count"] >= 2


def test_translation_requires_live_api_when_not_cached():
    response = client.post("/api/digital-twin/translate", json={"manual_id": "siemens_nc_495", "pages": [1]})
    assert response.status_code == 503
