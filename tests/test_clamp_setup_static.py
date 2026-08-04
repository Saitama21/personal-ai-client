from pathlib import Path

ROOT = Path(__file__).parents[1]


def test_clamp_setup_controls_and_version_are_shipped():
    app = (ROOT / 'app/static/app.js').read_text()
    html = (ROOT / 'app/static/index.html').read_text()
    sim = (ROOT / 'app/static/simulation3d.js').read_text()
    assert '6.0.0-professional' in app
    assert 'v6.0.0 Professional' in html
    for token in ['clampDiameter', 'clampLength', 'protectClampZone', 'from_clamp_to_free', 'visualMirror']:
        assert token in app
    assert 'REALISTIC_THREE_JAW_CHUCK_LEFT' in sim
    assert 'PROTECTED_CLAMP_ZONE_NO_MACHINING' in sim
    assert 'worldXForZ' in sim
    assert 'ЦИКЛ: ОТ ГРАНИЦЫ ЗАЖИМА' in sim
    assert 'ПАТРОН + Ø60 В КУЛАЧКАХ — СЛЕВА' in sim


def test_clamp_setup_is_forwarded_to_cam_and_protected():
    app = (ROOT / 'app/static/app.js').read_text()
    contracts = (ROOT / 'app/static/cam/contracts.mjs').read_text()
    turning = (ROOT / 'app/static/cam/turning-planner.mjs').read_text()
    drilling = (ROOT / 'app/static/cam/drilling-planner.mjs').read_text()
    assert 'setup:{clampSide:state.stock.clampSide' in app
    assert 'normalizeSetup(raw.setup || {}' in contracts
    assert 'MACHINING_REQUIRED_INSIDE_CLAMP' in turning
    assert 'lead_in_at_clamp_boundary' in turning
    assert 'DRILL_FROM_FREE_END' in drilling
    assert "entrySide: fromFreeEnd ? 'free_right' : 'z0'" in drilling
