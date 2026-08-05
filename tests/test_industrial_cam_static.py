from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_three_is_vendored_and_cdn_is_removed():
    html = (ROOT / "app/static/index.html").read_text(encoding="utf-8")
    vendor = ROOT / "app/static/vendor/three.module.min.js"
    license_file = ROOT / "app/static/vendor/THREE-LICENSE.txt"
    assert vendor.stat().st_size > 500_000
    assert "The MIT License" in license_file.read_text(encoding="utf-8")
    assert "/static/vendor/three.module.min.js" in html
    assert "cdnjs.cloudflare.com" not in html


def test_cam_modules_and_honest_capabilities_are_wired():
    app = (ROOT / "app/static/app.js").read_text(encoding="utf-8")
    engine = (ROOT / "app/static/cam/cam-engine.mjs").read_text(encoding="utf-8")
    contracts = (ROOT / "app/static/cam/contracts.mjs").read_text(encoding="utf-8")
    visualizer = (ROOT / "app/static/simulation3d.js").read_text(encoding="utf-8")
    assert "CNC_CAM_getInput" in app
    assert "CNC_CAM_setSummary" in app
    assert "buildCamPlan" in engine
    assert "NOT_IMPLEMENTED" in contracts
    assert "EVALUATED_LIMITED" in contracts
    assert "SUPPORTED_INDEXED" in contracts
    assert "Sinumerik828DPostprocessor" in engine
    assert "planDrilling" in engine
    assert "planThreading" in engine
    assert "planAfMilling" in engine
    assert "simulateMaterial" in visualizer
    assert "toolPointAt" in visualizer
    assert "LineSegments" in visualizer


def test_no_default_geometry_is_used_for_cam_execution():
    visualizer = (ROOT / "app/static/simulation3d.js").read_text(encoding="utf-8")
    planner = (ROOT / "app/static/cam/turning-planner.mjs").read_text(encoding="utf-8")
    assert "defaultContour" not in visualizer
    assert "CONTOUR_REQUIRED" in planner
    assert "CAM-план заблокирован" in visualizer
