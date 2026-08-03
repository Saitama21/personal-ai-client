from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

def test_frontend_single_source_dimension_model():
    js = (ROOT / "app/static/app.js").read_text(encoding="utf-8")
    assert "axialSegments" in js
    assert "function chainData()" in js
    assert "Размерная цепь должна быть полностью задана" in js
    assert "15+0+0" not in js

def test_operator_pdf_uses_canonical_dimensions():
    source = (ROOT / "app/operator_pdf.py").read_text(encoding="utf-8")
    assert 'dimensions = snapshot.get("dimensions")' in source
    assert '["Размерная цепь", dimension_chain_text' in source

def test_backend_exposes_axial_segments():
    source = (ROOT / "app/main.py").read_text(encoding="utf-8")
    assert '"axial_segments": axial_segments' in source
    assert "4.6.1-engineering-normalization" in source
