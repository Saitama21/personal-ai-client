from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def test_tablet_controls_exist():
    html=(ROOT/'app/static/index.html').read_text()
    assert 'tabletMenuBtn' in html
    assert 'tabletInspectorBtn' in html
    assert 'tabletBackdrop' in html

def test_tablet_breakpoint_and_drawers():
    css=(ROOT/'app/static/styles.css').read_text()
    assert 'min-width:721px' in css
    assert 'max-width:1199px' in css
    assert 'tablet-sidebar-open' in css
    assert 'tablet-inspector-open' in css

def test_tablet_js_controls():
    js=(ROOT/'app/static/app.js').read_text()
    assert 'isResponsiveDrawerViewport' in js
    assert 'toggleResponsivePanel' in js
    assert 'orientationchange' in js
