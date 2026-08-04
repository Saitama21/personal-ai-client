from pathlib import Path

from app.digital_twin import get_manual_page, search_manuals, twin_summary


def test_digital_twin_summary_and_assets():
    summary = twin_summary()
    assert summary["ok"] is True
    assert summary["counts"]["manuals"] == 6
    assert summary["counts"]["manual_pages"] == 4973
    assert summary["counts"]["photos"] == 36
    assert summary["profile"]["configuration"]["turret"]["positions"] == 15
    assert summary["profile"]["release_policy"]["automatic_mpf"] is False


def test_russian_query_expands_to_english_manual_terms():
    results = search_manuals("задняя бабка", limit=10)
    assert any("turning" in item["manual_id"] or "tengyue" in item["manual_id"] for item in results)
    assert any("tailstock" in item["snippet"].lower() or "quill" in item["snippet"].lower() for item in results)


def test_exact_v495_tracyl_page_is_retrievable():
    results = search_manuals("TRACYL", manual_id="siemens_nc_495", limit=5)
    assert results
    assert any(item["page"] in {620, 621, 622, 623} for item in results)
    page = get_manual_page("siemens_nc_495", results[0]["page"])
    assert page and "TRACYL" in page["text"]


def test_static_photo_gallery_bundled():
    root = Path(__file__).resolve().parents[1]
    photos = root / "app" / "static" / "digital_twin" / "photos"
    assert len(list(photos.glob("*.jpg"))) == 36
