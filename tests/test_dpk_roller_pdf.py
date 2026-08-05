import io
import os
from pathlib import Path

os.environ['MOCK_MODE'] = 'true'
os.environ['DATA_DIR'] = str(Path(__file__).parent / 'test_data' / 'runtime_dpk')

from fastapi.testclient import TestClient
from reportlab.pdfgen import canvas
from app.main import app

client = TestClient(app)


def make_drawing_pdf() -> io.BytesIO:
    output = io.BytesIO()
    pdf = canvas.Canvas(output)
    lines = [
        'ROZFOOD DPK-5.02.103 Roller',
        'Round PE 500 diameter 60',
        'Dimensions: 60 50 30 25 22 8 12.2',
        'R3.5 1x45 H14 h14 IT14/2 quantity 28',
    ]
    y = 800
    for line in lines:
        pdf.drawString(72, y, line)
        y -= 24
    pdf.save()
    output.seek(0)
    return output


def post_file(endpoint: str, data: dict[str, str]):
    stream = make_drawing_pdf()
    return client.post(endpoint, data=data, files={'file': ('control-roller.pdf', stream, 'application/pdf')})


def test_dpk_pdf_analysis_extracts_geometry():
    response = post_file('/api/analyze', {'prompt': 'Проведи полный технический анализ чертежа и предложи маршрут ShopTurn'})
    assert response.status_code == 200
    body = response.json()
    text = body['response']
    for expected in ['Ролик', 'PE 500', 'Ø60', 'Ø50', 'Ø30 × 8', 'Ø12.2', 'R3.5', '1×45°', '8 + 22 = 30']:
        assert expected in text
    intel = body['drawing_intelligence']
    assert intel['recommended_stock_mode'] == 'lathe'
    assert 'H14' in intel['tolerances']
    assert 'h14' in intel['tolerances']
    assert 'R3' not in intel['tolerances']
    assert intel['part_name'] == 'Ролик'
    assert intel['material'] == 'PE 500'
    assert intel['blank_diameter'] == 60.0
    assert intel['blank_diameter_exact'] is True
    assert intel['blank_diameter_source'] == 'drawing_profile'
    assert intel['radial_stock_allowance'] == 0.0
    assert intel['overall_length'] == 30.0
    assert intel['thread_applicable'] is False
    assert intel['af_applicable'] is False
    assert intel['drilling_applicable'] is True
    assert intel['drilling_diameter'] == 12.2
    assert intel['drilling_depth'] == 30.0
    assert [item['length'] for item in intel['axial_segments']] == [8.0, 22.0]
    assert [item['name'] for item in intel['axial_segments']] == ['Расточка Ø30', 'Отверстие Ø12,2 до уступа']
    assert intel['dimension_chain']['matches'] is True
    assert intel['tolerance_summary'].startswith('H14 — внутренние')


def test_dpk_stock_removal_has_outer_and_inner_coordinates():
    response = post_file('/api/stock-removal', {
        'stock_mode': 'lathe',
        'blank_diameter': '60',
        'blank_length': '30',
        'zero_reference': 'Z0 по правому торцу',
        'first_side': 'правый торец',
        'notes': 'PE 500, проверить R3,5 и расточку Ø30',
    })
    assert response.status_code == 200
    text = response.json()['response']
    for expected in ['X57/Z−5', 'X50/Z−8.5', 'Ø14.2', 'Ø12.2', 'Ø30', 'две установки']:
        assert expected in text


def test_dpk_contour_ai_returns_outer_inner_and_holes():
    response = post_file('/api/contour-ai', {'blank_diameter': '60', 'blank_length': '30', 'notes': 'Ролик PE 500'})
    assert response.status_code == 200
    body = response.json()
    assert body['recommended_mode'] == 'lathe'
    assert body['confidence'] == 0.99
    assert body['points'] == [
        {'x': 60.0, 'z': 0.0, 'type': 'start', 'rv': '—', 'direction': '—'},
        {'x': 60.0, 'z': -5.0, 'type': 'lineZ', 'rv': '—', 'direction': 'по Z'},
        {'x': 57.0, 'z': -5.0, 'type': 'lineX', 'rv': '—', 'direction': 'по X'},
        {'x': 50.0, 'z': -8.5, 'type': 'arcCW', 'rv': 'R3.5', 'direction': 'CW'},
        {'x': 50.0, 'z': -30.0, 'type': 'lineZ', 'rv': '—', 'direction': 'по Z'},
    ]
    assert body['inner_contours'][0][1]['rv'] == '1×45°'
    assert body['holes'][0]['diameter'] == 12.2
    assert body['holes'][1]['diameter'] == 30.0


def test_dpk_contour_uses_drawing_profile_even_when_live(monkeypatch):
    import app.main as main_module
    monkeypatch.setattr(main_module, 'MOCK_MODE', False)
    response = post_file('/api/contour-ai', {'blank_diameter': '70', 'blank_length': '30', 'notes': 'live mode must not replace known drawing geometry'})
    assert response.status_code == 200
    body = response.json()
    assert body['source'] == 'drawing_profile'
    assert body['confidence'] == 0.99
    assert body['secondary_features'] == []
    assert body['outer_contour'][2] == {'x': 57.0, 'z': -5.0, 'type': 'lineX', 'rv': '—', 'direction': 'по X'}
    assert body['outer_contour'][3] == {'x': 50.0, 'z': -8.5, 'type': 'arcCW', 'rv': 'R3.5', 'direction': 'CW'}
