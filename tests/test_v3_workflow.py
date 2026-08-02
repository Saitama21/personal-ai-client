from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
HTML=(ROOT/'app/static/index.html').read_text()
JS=(ROOT/'app/static/app.js').read_text()
SIM=(ROOT/'app/static/simulation3d.js').read_text()

def test_v3_workflow_present():
    assert 'stockWorkflowStepper' in HTML
    assert HTML.count('data-stock-stage=') >= 8

def test_v3_sim_telemetry_present():
    for item in ['simCurrentOperation','simCurrentTool','simRemaining','simNextOperation']:
        assert item in HTML and item in SIM

def test_v3_single_workflow_logic():
    assert 'Unified CAM Workflow' in JS
