from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def test_professional_cockpit_markup():
    html=(ROOT/'app/static/index.html').read_text()
    for token in ['professional-cockpit','cockpit-machine-view','scene-headstock','scene-turret','professional-bottom-grid','AI АССИСТЕНТ']:
        assert token in html

def test_v600_version():
    assert '6.0.0' in (ROOT/'app/main.py').read_text()
    assert 'v6.0.0 Professional' in (ROOT/'app/static/index.html').read_text()
