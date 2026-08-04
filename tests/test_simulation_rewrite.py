from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def test_shopturn_orientation_and_complete_controls():
    app=(ROOT/'app/static/app.js').read_text(encoding='utf-8')
    sim=(ROOT/'app/static/simulation3d.js').read_text(encoding='utf-8')
    css=(ROOT/'app/static/styles.css').read_text(encoding='utf-8')
    for token in ['simShopTurnView','simOrbitView','simXrayView','Патрон справа','Сверление','Фрезерование C/Y']:
        assert token in app
    assert 'sim.chuck.position.x = plan.input.blankLength / 2 + 11' in sim
    assert "move.cutKind === 'drill_axial'" in sim
    assert "move.cutKind === 'mill_af'" in sim
    assert "setViewMode('xray')" in sim
    assert '.sim-toolbar' in css
    assert '.sim-axis-overlay' in css
