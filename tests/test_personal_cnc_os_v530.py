from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
def test_personal_os_ui_present():
    html=(ROOT/'app/static/index.html').read_text()
    assert 'PERSONAL CNC OS' in html
    assert 'id="osDashboard"' in html
    assert 'data-os-action="simulation"' in html
    assert 'патрон слева / револьвер справа' in html
def test_personal_os_controller_present():
    js=(ROOT/'app/static/app.js').read_text()
    assert 'initPersonalCncOs' in js
    assert "document.body.classList.add('os-home-open')" in js
    assert "openSupport('aiAssistant')" in js
def test_version_v530():
    assert '6.0.0-professional' in (ROOT/'app/main.py').read_text()
    assert 'v6.0.0 Professional' in (ROOT/'app/static/index.html').read_text()
