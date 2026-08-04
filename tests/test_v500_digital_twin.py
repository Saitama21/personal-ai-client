from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def test_v500_camera_and_collision_controls():
    app=(ROOT/'app/static/app.js').read_text(encoding='utf-8')
    sim=(ROOT/'app/static/simulation3d.js').read_text(encoding='utf-8')
    css=(ROOT/'app/static/styles.css').read_text(encoding='utf-8')
    for view in ['front','iso','top','tool','follow']:
        assert f'data-sim-view="{view}"' in app
    assert 'simCollisionBanner' in app
    assert "sim.running = false; sim.collisionLatched = true" in sim
    assert 'simSpindle' in app and 'simSpindle' in sim
    assert 'collision-banner' in css

def test_v500_machine_orientation_and_clamp_protection():
    sim=(ROOT/'app/static/simulation3d.js').read_text(encoding='utf-8')
    main=(ROOT/'app/main.py').read_text(encoding='utf-8')
    assert 'REALISTIC_THREE_JAW_CHUCK_LEFT' in sim
    assert 'CK52PT_Y_15_POSITION_TURRET_RIGHT' in sim
    assert 'protect_clamp_zone' in main
    assert 'from_clamp_to_free' in main
    assert 'clamp_diameter": 60.0' in main
