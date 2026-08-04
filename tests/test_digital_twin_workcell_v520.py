from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def test_v520_workcell_geometry_and_ui():
    sim=(ROOT/'app/static/simulation3d.js').read_text()
    app=(ROOT/'app/static/app.js').read_text()
    assert 'CK52PT_Y_MACHINE_INTERIOR' in sim
    assert 'HYDRAULIC_TAILSTOCK_REFERENCE' in sim
    assert 'TURRET_15_STATIONS' in sim
    assert 'operation-timeline' in app
    assert 'THREE_JAW_CHUCK_LEFT' in sim
