import os
from pathlib import Path

os.environ['MOCK_MODE'] = 'true'
os.environ['DATA_DIR'] = str(Path(__file__).parent / 'test_data')

from fastapi.testclient import TestClient
from app.main import app

client = TestClient(app)
IMAGE = Path(__file__).parent / 'test_data' / 'palec_control.jpeg'


def test_control_drawing_analysis_recognizes_dimensions():
    with IMAGE.open('rb') as stream:
        response = client.post(
            '/api/analyze',
            data={'prompt': 'Проведи полный технический анализ чертежа'},
            files={'file': ('palec.jpeg', stream, 'image/jpeg')},
        )
    assert response.status_code == 200
    body = response.json()
    text = body['response']
    assert 'M8×1.25' in text
    assert 'Ø10 × 12' in text
    assert 'AF13' in text
    assert '15 + 12 + 4 = 31' in text
    intelligence = body['drawing_intelligence']
    assert intelligence['recommended_stock_mode'] == 'hybrid'


def test_control_drawing_stock_removal_has_real_contour():
    with IMAGE.open('rb') as stream:
        response = client.post(
            '/api/stock-removal',
            data={
                'stock_mode': 'hybrid',
                'blank_diameter': '16',
                'blank_length': '31',
                'blank_width': '16',
                'blank_height': '16',
                'blank_mill_length': '4',
                'zero_reference': 'Z0 по правому торцу',
                'first_side': 'торец головки',
                'notes': 'AISI 304, проверить M8, Ø10, AF13 и фаску',
            },
            files={'file': ('palec.jpeg', stream, 'image/jpeg')},
        )
    assert response.status_code == 200
    text = response.json()['response']
    for expected in ['Ø16 × 31', 'Ø10 × 12', 'M8×1.25', 'AF13', '| P6 | Ø8 | -31 |']:
        assert expected in text
    assert 'Ø140' not in text
    assert 'Ø130' not in text


def test_control_drawing_ai_contour_excludes_af_from_xz():
    with IMAGE.open('rb') as stream:
        response = client.post(
            '/api/contour-ai',
            data={'blank_diameter': '16', 'blank_length': '31', 'notes': 'Палец AISI 304 M8 AF13'},
            files={'file': ('palec.jpeg', stream, 'image/jpeg')},
        )
    assert response.status_code == 200
    body = response.json()
    assert body['recommended_mode'] == 'hybrid'
    assert body['points'] == [
        {'x': 16.0, 'z': 0.0, 'type': 'start', 'rv': '—', 'direction': '—'},
        {'x': 16.0, 'z': -4.0, 'type': 'lineZ', 'rv': '—', 'direction': 'по Z'},
        {'x': 10.0, 'z': -4.0, 'type': 'lineX', 'rv': '—', 'direction': 'по X'},
        {'x': 10.0, 'z': -16.0, 'type': 'lineZ', 'rv': '—', 'direction': 'по Z'},
        {'x': 8.0, 'z': -16.0, 'type': 'lineX', 'rv': '—', 'direction': 'по X'},
        {'x': 8.0, 'z': -31.0, 'type': 'lineZ', 'rv': '0.5×45° на левом торце', 'direction': 'по Z'},
    ]
    assert body['secondary_features'][0]['designation'] == 'AF13'
