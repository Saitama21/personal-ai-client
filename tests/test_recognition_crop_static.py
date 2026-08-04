from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def test_recognition_crop_is_wired_through_analysis_and_geometry():
    app = (ROOT / "app/static/app.js").read_text(encoding="utf-8")
    html = (ROOT / "app/static/index.html").read_text(encoding="utf-8")
    styles = (ROOT / "app/static/styles.css").read_text(encoding="utf-8")

    assert "recognition-crop.mjs" in html
    assert "RecognitionCropController" in app
    assert "appendRecognitionCrop(fd)" in app
    assert "formData.append('crop_json'" in app
    assert "recognitionCrop:state.recognitionCrop" in app
    assert "recognition-crop-surface" in styles
    assert "touch-action:none" in styles


def test_crop_module_and_three_are_local_assets():
    html = (ROOT / "app/static/index.html").read_text(encoding="utf-8")
    assert 'import("/static/recognition-crop.mjs' in html
    assert 'import("/static/vendor/three.module.min.js")' in html
    assert "cdn.jsdelivr.net" not in html
    assert "unpkg.com" not in html
