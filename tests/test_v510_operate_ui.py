from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/"app/static/index.html").read_text(encoding="utf-8")
CSS=(ROOT/"app/static/styles.css").read_text(encoding="utf-8")
APP=(ROOT/"app/static/app.js").read_text(encoding="utf-8")

def test_operate_shell_sections():
    for label in ["PROGRAM","DRAWING AI","CAM","TOOLS","STOCK","SIMULATION","MACHINE","DIAGNOSTICS","AI ASSISTANT","LIBRARY","EXPORT"]:
        assert label in HTML

def test_operator_navigation_and_softkeys():
    assert "PROGRAM MANAGER" in HTML
    assert "VERTICAL SOFTKEYS" in HTML
    assert "STOCK REMOVAL" in HTML
    assert "actual-values-bar" in HTML

def test_ai_assistant_support_is_bound():
    assert "aiAssistant" in APP
    assert "AI ASSISTANT · CK52PT-Y" in APP

def test_operate_responsive_styles():
    assert ".operate-app-tabs" in CSS
    assert ".operate-right-softkeys" in CSS
    assert "@media(max-width:1199px)" in CSS
