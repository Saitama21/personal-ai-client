from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]

def test_mobile_version():
    main=(ROOT/'app/main.py').read_text(encoding='utf-8')
    html=(ROOT/'app/static/index.html').read_text(encoding='utf-8')
    assert '4.5.1-dpk-roller-test' in main
    assert 'v=4.5.1-dpk-roller-test' in html

def test_mobile_layout_contract():
    css=(ROOT/'app/static/styles.css').read_text(encoding='utf-8')
    js=(ROOT/'app/static/app.js').read_text(encoding='utf-8')
    for token in ['Mobile Optimized','body.tablet-sidebar-open .sidebar','body.tablet-inspector-open .inspector','mobile-progress','safe-area-inset-bottom','height:58dvh']:
        assert token in css
    assert "function isResponsiveDrawerViewport()" in js
    assert "(max-width:1199px)" in js

def test_mobile_no_user_agent_branching():
    js=(ROOT/'app/static/app.js').read_text(encoding='utf-8').lower()
    assert 'useragent' not in js
    assert 'macintel' not in js
