from pathlib import Path
ROOT=Path(__file__).parents[1]
HTML=(ROOT/'app/static/index.html').read_text(encoding='utf-8')
JS=(ROOT/'app/static/app.js').read_text(encoding='utf-8')
CSS=(ROOT/'app/static/styles.css').read_text(encoding='utf-8')

def test_v4_workflow_present():
    assert 'ПОСЛЕДОВАТЕЛЬНЫЙ МАСТЕР ПРОЕКТА' in HTML
    assert 'const STEPS=' in JS
    for step in ['Анализ','Проверка','Заготовка','Контур X/Z','AF-контур','Инструменты','Техпроцесс','Stock Removal','Симуляция','Экспорт']:
        assert step in JS

def test_v4_sequential_dependency_logic():
    assert 'resetDependents' in JS
    assert 'state.done[i-1]' in JS
    assert 'complete(' in JS

def test_v4_af_and_simulation_present():
    assert 'buildAf' in JS
    assert 'af-canvas' in CSS
    assert 'playSimulation' in JS
    assert 'simulationReviewed' in JS

def test_v4_responsive_single_dom():
    assert '@media(max-width:1100px)' in CSS
    assert '@media(max-width:720px)' in CSS
    assert 'userAgent' not in JS
    assert 'maxTouchPoints' not in JS
