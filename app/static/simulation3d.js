(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const fmt = (v, d = 1) => Number(v || 0).toLocaleString('ru-RU', { minimumFractionDigits: d, maximumFractionDigits: d });
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const sim = {
    renderer: null, scene: null, camera: null, host: null, plan: null,
    materialMesh: null, targetMesh: null, boreMesh: null, pathRapid: null, pathCut: null,
    chuck: null, clampZoneMesh: null, turret: null, turretDisk: null, activeTool: null, collisionGroup: null,
    resizeObserver: null, running: false, progress: 0, speed: 1, lastFrame: 0,
    lastGeometryProgress: -1, initialVolume: 0, finalVolume: 0, currentVolume: 0,
    view: 'sinumerik', loopGeneration: 0, selectedTool: null, fallbackCanvas: null, fallbackState: null, collisionLatched: false,
  };

  const api = () => window.CNC_CAM_API || null;
  const input = () => window.CNC_CAM_getInput?.() || window.CNC3D_getData?.() || {};

  function statusLabel(status) {
    return ({ SUPPORTED: 'Работает', PARTIAL: 'Частично готово', BLOCKED: 'Заблокировано', NOT_IMPLEMENTED: 'Не включено', NOT_EVALUATED: 'Не проверено', SUPPORTED_INDEXED: 'Индексируемая C', EVALUATED_LIMITED: 'Проверено по оболочкам', GENERATED: 'Сформировано' })[status] || String(status || '—');
  }
  function setBadge(el, status) { if (el) { el.textContent = statusLabel(status); el.dataset.status = status || 'UNKNOWN'; } }

  function rebuildPlan() {
    if (!api()) return null;
    sim.plan = api().buildCamPlan(input());
    if (sim.plan.materialModel) {
      const a = api().simulateMaterial(sim.plan, 0), b = api().simulateMaterial(sim.plan, 1);
      sim.initialVolume = api().materialVolume(a); sim.finalVolume = api().materialVolume(b); sim.currentVolume = sim.initialVolume;
    }
    window.CNC_CAM_setSummary?.(api().planSummary(sim.plan));
    renderPlanStatus();
    return sim.plan;
  }

  function capabilityMarkup(plan) {
    const rows = [
      ['Точение X/Z', plan.capabilities.turningXZ], ['Stock Removal', plan.capabilities.materialRemoval],
      ['Осевое сверление', plan.capabilities.drilling], ['Радиальное сверление', plan.capabilities.radialDrilling],
      ['AF / шестигранник', plan.capabilities.millingAf], ['Карманы и пазы X/Y/Z', plan.capabilities.millingPocket],
      ['15-позиционный револьвер', plan.capabilities.turret], ['Коллизии', { status: plan.collision.status, scope: plan.collision.message }],
      ['MPF 828D', { status: plan.postprocessor.status, scope: plan.postprocessor.errors?.map(e => e.message).join(' ') || plan.capabilities.postprocessor.scope }],
    ];
    return rows.map(([name, item]) => `<div class="cam-capability"><b>${esc(name)}</b><span>${esc(statusLabel(item?.status))}</span><small>${esc(item?.scope || '')}</small></div>`).join('');
  }
  function renderPlanStatus() {
    const p = sim.plan; if (!p) return;
    setBadge($('camPlanBadge'), p.status); setBadge($('simPlanBadge'), p.executable ? 'SUPPORTED' : p.status);
    if ($('camPlanDetails')) $('camPlanDetails').innerHTML = p.executable ? `<div class="cam-metrics"><b>${p.operations.length}</b><span>операций</span><b>${p.moves.length}</b><span>движений XYZC</span><b>${fmt(p.estimatedMinutes, 2)}</b><span>мин</span></div>` : '<div class="check-card warning">CAM-план заблокирован. Исправьте отмеченные параметры.</div>';
    if ($('camIssueList')) $('camIssueList').innerHTML = [...p.errors, ...p.warnings].map(i => `<div class="cam-issue ${i.severity === 'error' ? 'error' : 'warning'}"><b>${esc(i.code)}</b><span>${esc(i.message)}</span></div>`).join('');
    if ($('camCapabilityList')) $('camCapabilityList').innerHTML = capabilityMarkup(p);
    if ($('stockRemovalBtn')) $('stockRemovalBtn').disabled = !p.executable;
    if ($('simScopeNotice')) $('simScopeNotice').innerHTML = `<div class="check-card ${p.executable ? 'good' : 'warning'}"><b>CK52PT-Y · XYZC</b><span>Патрон слева зажимает подтверждённый участок Ø${esc(p.input.setup?.clampDiameter || p.input.blankDiameter)} × ${esc(p.input.setup?.clampLength || '—')} мм. Зона зажима защищена. Обработка идёт от границы патрона к свободному торцу; револьвер T1–T15 расположен справа.</span></div>`;
    if ($('simBuildBtn')) $('simBuildBtn').disabled = !p.executable;
    if ($('simPlayBtn')) $('simPlayBtn').disabled = !p.executable;
  }

  function centerZ(plan) { return (Number(plan.input.axialAllowance || 0) - Number(plan.input.blankLength || 0)) / 2; }
  function setupOf(plan) { return plan?.input?.setup || plan?.setup || {}; }
  function isMirrored(plan) { return setupOf(plan).visualMirror !== false && setupOf(plan).clampSide === 'left'; }
  function worldXForZ(plan, z = 0) { return isMirrored(plan) ? centerZ(plan) - Number(z || 0) : Number(z || 0) - centerZ(plan); }
  function clampZone(plan) {
    const setup = setupOf(plan);
    if (!setup.enabled || !setup.protectClampZone || !(Number(setup.clampLength) > 0)) return null;
    const length = Number(setup.clampLength);
    return setup.clampSide === 'left' ? { z0: 0, z1: -length, boundaryZ: -length } : { z0: -Number(plan.input.blankLength), z1: -Number(plan.input.blankLength) + length, boundaryZ: -Number(plan.input.blankLength) + length };
  }
  function worldPoint(plan, point = {}, radialOffset = 0) {
    const c = Number(point.c || 0) * Math.PI / 180, radius = Number(point.x || 0) / 2 + radialOffset, y = Number(point.y || 0);
    return new THREE.Vector3(worldXForZ(plan, point.z), radius * Math.cos(c) - y * Math.sin(c), radius * Math.sin(c) + y * Math.cos(c));
  }
  function outerRadius(profile, z) {
    if (!profile.length) return 1;
    if (z >= profile[0].z) return profile[0].radius;
    if (z <= profile.at(-1).z) return profile.at(-1).radius;
    for (let i = 0; i < profile.length - 1; i++) { const a = profile[i], b = profile[i + 1]; if (z <= a.z && z >= b.z) { const t = (z - a.z) / (b.z - a.z || 1); return a.radius + (b.radius - a.radius) * t; } }
    return profile.at(-1).radius;
  }

  function surfaceGeometry(state, radialSegments = 88, axialSegments = 128) {
    const profile = api().materialProfile(state).sort((a, b) => b.z - a.z);
    const zStart = profile[0]?.z ?? 0, zEnd = profile.at(-1)?.z ?? -1;
    const positions = [], normals = [], uvs = [], indices = [];
    for (let zi = 0; zi <= axialSegments; zi++) {
      const z = zStart + (zEnd - zStart) * zi / axialSegments, base = outerRadius(profile, z);
      for (let ai = 0; ai <= radialSegments; ai++) {
        const angle = Math.PI * 2 * ai / radialSegments, r = api().radialBoundaryAt(state.features || {}, z, angle, base);
        positions.push(worldXForZ(sim.plan, z), r * Math.cos(angle), r * Math.sin(angle));
        normals.push(0, Math.cos(angle), Math.sin(angle)); uvs.push(zi / axialSegments, ai / radialSegments);
      }
    }
    const row = radialSegments + 1;
    for (let zi = 0; zi < axialSegments; zi++) for (let ai = 0; ai < radialSegments; ai++) { const a = zi * row + ai, b = a + row; indices.push(a, b, a + 1, b, b + 1, a + 1); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2)); g.setIndex(indices); g.computeVertexNormals(); return g;
  }

  function disposeObject(obj) {
    if (!obj) return; obj.traverse?.(node => { node.geometry?.dispose?.(); if (Array.isArray(node.material)) node.material.forEach(m => m.dispose?.()); else node.material?.dispose?.(); }); obj.parent?.remove(obj);
  }
  function cylinder(radius, length, material, segments = 48) { const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material); mesh.rotation.z = Math.PI / 2; return mesh; }
  function metal(color = 0x697886, roughness = .38, metalness = .72) { return new THREE.MeshStandardMaterial({ color, roughness, metalness }); }

  function createThreeJawChuck() {
    const group = new THREE.Group(); group.name = 'REALISTIC_THREE_JAW_CHUCK_LEFT';
    const plan = sim.plan, setup = setupOf(plan), stockD = Number(plan.input.blankDiameter || 60), clampD = Number(setup.clampDiameter || stockD), zone = clampZone(plan);
    const partLeft = worldXForZ(plan, setup.clampSide === 'left' ? 0 : -plan.input.blankLength);
    const bodyR = Math.max(31, stockD * .72), bodyLength = 25;
    const body = cylinder(bodyR, bodyLength, metal(0x3e4b55)); body.position.x = partLeft - bodyLength / 2 - 4; group.add(body);
    const face = cylinder(Math.max(29, stockD * .68), 5, metal(0x8a969f)); face.position.x = partLeft - 3; group.add(face);
    const bore = cylinder(Math.max(8, stockD * .16), bodyLength + 8, new THREE.MeshStandardMaterial({ color: 0x061018, roughness: .85 })); bore.position.x = body.position.x; group.add(bore);
    const jawRadius = Math.max(clampD / 2 + 7, stockD * .42), gripCenter = zone ? (worldXForZ(plan, zone.z0) + worldXForZ(plan, zone.z1)) / 2 : partLeft + 3;
    for (let i = 0; i < 3; i++) {
      const a = i * Math.PI * 2 / 3;
      const jaw = new THREE.Group(); jaw.name = `CHUCK_JAW_${i + 1}`;
      const base = new THREE.Mesh(new THREE.BoxGeometry(18, 10, 17), metal(0x78858f)); base.position.set(partLeft - 2, jawRadius * Math.cos(a), jawRadius * Math.sin(a)); base.rotation.x = a; jaw.add(base);
      const soft = new THREE.Mesh(new THREE.BoxGeometry(Math.max(8, Number(setup.clampLength || 5) + 3), 8, 12), metal(0xb9c2c8)); soft.position.set(gripCenter, (clampD / 2 + 3.5) * Math.cos(a), (clampD / 2 + 3.5) * Math.sin(a)); soft.rotation.x = a; jaw.add(soft);
      group.add(jaw);
    }
    return group;
  }

  function createProtectedClampZone() {
    const zone = clampZone(sim.plan); if (!zone) return null;
    const setup = setupOf(sim.plan), x0 = worldXForZ(sim.plan, zone.z0), x1 = worldXForZ(sim.plan, zone.z1), length = Math.abs(x1 - x0);
    const mesh = cylinder(Number(setup.clampDiameter || sim.plan.input.blankDiameter) / 2 + .8, length + .3, new THREE.MeshStandardMaterial({ color: 0xffb12b, transparent: true, opacity: .2, roughness: .8, side: THREE.DoubleSide }));
    mesh.position.x = (x0 + x1) / 2; mesh.name = 'PROTECTED_CLAMP_ZONE_NO_MACHINING'; return mesh;
  }

  function makeTurningTool() {
    const g = new THREE.Group(); g.name = 'TURNING_TOOL';
    const holder = new THREE.Mesh(new THREE.BoxGeometry(34, 8, 8), metal(0x29343c)); holder.position.x = 17; g.add(holder);
    const insert = new THREE.Mesh(new THREE.ConeGeometry(5.2, 2.4, 3), new THREE.MeshStandardMaterial({ color: 0xe5b341, metalness: .8, roughness: .25 })); insert.rotation.z = Math.PI / 2; insert.rotation.x = Math.PI / 2; insert.position.x = 0; g.add(insert); return g;
  }
  function makeDrill(radial = false) {
    const g = new THREE.Group(); g.name = radial ? 'REALISTIC_RADIAL_TWIST_DRILL' : 'REALISTIC_AXIAL_TWIST_DRILL';
    const d = Math.max(3, Number((radial ? sim.plan.radialDrilling?.feature.diameter : sim.plan.drilling?.feature.diameter) || 8));
    const shank = cylinder(d / 2, 30, metal(0x9daab2)); shank.position.x = 17; g.add(shank);
    const tip = new THREE.Mesh(new THREE.ConeGeometry(d / 2, d * .8, 28), metal(0xc9d2d8)); tip.rotation.z = -Math.PI / 2; tip.position.x = 1; g.add(tip);
    const fluteMat = new THREE.LineBasicMaterial({ color: 0x24313b });
    for (let f = 0; f < 2; f++) { const pts = []; for (let i = 0; i < 34; i++) { const x = 4 + i * .75, a = f * Math.PI + i * .42; pts.push(new THREE.Vector3(x, d * .52 * Math.cos(a), d * .52 * Math.sin(a))); } g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), fluteMat)); }
    if (radial) g.rotation.z = Math.PI / 2; return g;
  }
  function makeEndMill() {
    const g = new THREE.Group(); g.name = 'REALISTIC_END_MILL_Y_AXIS';
    const d = Math.max(4, Number(sim.plan.millingPocket?.feature.toolDiameter || sim.plan.millingAf?.feature.toolDiameter || 8));
    const body = cylinder(d / 2, 28, metal(0xb5c0c7)); body.position.x = 15; g.add(body);
    for (let i = 0; i < 4; i++) { const tooth = new THREE.Mesh(new THREE.BoxGeometry(13, 1.1, d * .75), metal(0xd7dfe3)); tooth.position.x = 6; tooth.rotation.x = i * Math.PI / 2; g.add(tooth); }
    return g;
  }
  function makeCutoff() { const g = new THREE.Group(); g.name = 'CUTOFF_BLADE'; const holder = new THREE.Mesh(new THREE.BoxGeometry(35, 8, 9), metal(0x2c353c)); holder.position.x = 18; g.add(holder); const blade = new THREE.Mesh(new THREE.BoxGeometry(12, 2.2, 15), metal(0xbfc8ce)); blade.position.x = 2; g.add(blade); return g; }

  function toolForMove(move) {
    const kind = move?.toolKind || 'turning';
    if (kind === 'drilling') return makeDrill(false);
    if (kind === 'radialDrilling') return makeDrill(true);
    if (kind === 'millingAf' || kind === 'millingPocket') return makeEndMill();
    if (kind === 'cutoff') return makeCutoff();
    return makeTurningTool();
  }
  function toolNumberForMove(move) {
    const kind = move?.toolKind || 'turning';
    const map = { turning: sim.plan.turning?.operations?.[0]?.kind === 'finish_turning' ? 'T2' : 'T1', threading: sim.plan.threading?.feature?.toolId || 'T3', drilling: sim.plan.drilling?.feature?.toolId || 'T6', radialDrilling: sim.plan.radialDrilling?.feature?.toolId || 'T10', millingAf: sim.plan.millingAf?.feature?.toolId || 'T4', millingPocket: sim.plan.millingPocket?.feature?.toolId || 'T8', cutoff: sim.plan.cutoff?.feature?.toolId || 'T15' };
    return map[kind] || 'T1';
  }

  function createTurret() {
    const slide = new THREE.Group(); slide.name = 'CK52PT_Y_15_POSITION_TURRET_RIGHT';
    const disk = new THREE.Mesh(new THREE.CylinderGeometry(23, 23, 13, 15), metal(0x46545e)); disk.rotation.x = Math.PI / 2; disk.name = 'TURRET_15_STATIONS'; slide.add(disk); sim.turretDisk = disk;
    for (let i = 0; i < 15; i++) {
      const a = i * Math.PI * 2 / 15, station = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 8), metal(i % 3 === 0 ? 0x788894 : 0x596873));
      station.position.set(0, 31 * Math.cos(a), 31 * Math.sin(a)); station.rotation.x = a; station.userData.station = i + 1; slide.add(station);
    }
    const labelCanvas = document.createElement('canvas'); labelCanvas.width = 256; labelCanvas.height = 64; const ctx = labelCanvas.getContext('2d'); ctx.fillStyle = '#0a2336'; ctx.fillRect(0, 0, 256, 64); ctx.fillStyle = '#d9f4ff'; ctx.font = 'bold 28px sans-serif'; ctx.fillText('15 POS TURRET', 18, 42);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(labelCanvas) })); sprite.scale.set(33, 8, 1); sprite.position.set(0, -38, 0); slide.add(sprite);
    slide.position.set(sim.plan.input.blankLength / 2 + 45, 35, 0); return slide;
  }

  function updateTool(move, point) {
    if (!sim.turret || !window.THREE) return;
    const toolId = toolNumberForMove(move), key = `${move?.toolKind || 'turning'}:${toolId}`;
    if (sim.selectedTool !== key) {
      disposeObject(sim.activeTool); sim.activeTool = toolForMove(move); sim.activeTool.name += `_${toolId}`; sim.turret.add(sim.activeTool); sim.selectedTool = key;
      const n = Number(toolId.match(/\d+/)?.[0] || 1); sim.turretDisk.rotation.z = -2 * Math.PI * (n - 1) / 15;
    }
    const wp = worldPoint(sim.plan, point);
    const kind = move?.toolKind || 'turning';
    if (kind === 'radialDrilling' || kind === 'millingAf' || kind === 'millingPocket') {
      sim.activeTool.rotation.z = Math.PI / 2;
      sim.activeTool.position.set(-28, -28, 0);
      sim.turret.position.set(wp.x + 28, wp.y + 28, wp.z);
    } else {
      sim.activeTool.rotation.set(0, 0, 0); sim.activeTool.position.set(-28, 0, 0); sim.turret.position.set(wp.x + 28, wp.y, wp.z);
    }
  }

  function createPath(cutting) {
    const points = [];
    for (const move of sim.plan.moves) if (Boolean(move.cutting) === cutting && move.motion !== 'index') { points.push(worldPoint(sim.plan, move.from, cutting ? .2 : 0), worldPoint(sim.plan, move.to, cutting ? .2 : 0)); }
    const geom = new THREE.BufferGeometry().setFromPoints(points); return new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ color: cutting ? 0xffb347 : 0x3f8cff, transparent: true, opacity: cutting ? .95 : .45 }));
  }

  function updateMaterial(force = false) {
    if (!sim.plan?.executable || (!force && Math.abs(sim.progress - sim.lastGeometryProgress) < .004)) return;
    sim.lastGeometryProgress = sim.progress; const state = api().simulateMaterial(sim.plan, sim.progress); sim.fallbackState = state; sim.currentVolume = api().materialVolume(state);
    if (sim.scene && window.THREE) {
      const geometry = surfaceGeometry(state); if (sim.materialMesh) { sim.materialMesh.geometry.dispose(); sim.materialMesh.geometry = geometry; } else { sim.materialMesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: 0xaab6be, metalness: .72, roughness: .36, side: THREE.DoubleSide })); sim.materialMesh.name = 'PROGRESSIVE_STOCK_REMOVAL'; sim.scene.add(sim.materialMesh); }
      disposeObject(sim.boreMesh); sim.boreMesh = null;
      if (state.features?.drilling?.currentDepth > .01) {
        const hole = state.features.drilling, r = hole.diameter / 2, len = hole.currentDepth;
        sim.boreMesh = cylinder(r, len + .6, new THREE.MeshStandardMaterial({ color: 0x081018, roughness: .9, side: THREE.DoubleSide })); const startZ=Number(hole.startZ||0),direction=Number(hole.direction||-1),boreStart=worldXForZ(sim.plan,startZ),boreEnd=worldXForZ(sim.plan,startZ+direction*len); sim.boreMesh.position.x=(boreStart+boreEnd)/2; sim.scene.add(sim.boreMesh);
      }
    }
    const removed = Math.max(0, sim.initialVolume - sim.currentVolume); if ($('simRemovedLabel')) $('simRemovedLabel').textContent = `Снято: ${fmt(removed, 0)} мм³`; if ($('simVolumeMetric')) $('simVolumeMetric').textContent = `${fmt(Math.max(0, sim.initialVolume - sim.finalVolume), 0)} мм³`;
    drawFallbackMachine();
  }

  function currentMove(progress = sim.progress) {
    if (!sim.plan?.moves?.length) return null;
    return sim.plan.moves.find(m => progress >= m.startProgress && progress <= m.endProgress + 1e-9) || sim.plan.moves.at(-1);
  }
  function currentOperation(move) { return move ? sim.plan.operations.find(o => o.id === move.operationId) : null; }
  function pointAt(move, progress) {
    if (!move) return { x: 0, y: 0, z: 0, c: 0 };
    const f = clamp((progress - move.startProgress) / Math.max(1e-9, move.endProgress - move.startProgress), 0, 1);
    return { x: (move.from.x || 0) + ((move.to.x || 0) - (move.from.x || 0)) * f, y: (move.from.y || 0) + ((move.to.y || 0) - (move.from.y || 0)) * f, z: (move.from.z || 0) + ((move.to.z || 0) - (move.from.z || 0)) * f, c: (move.from.c || 0) + ((move.to.c || 0) - (move.from.c || 0)) * f };
  }

  function updateTelemetry() {
    const timelinePoint = api()?.toolPointAt?.(sim.plan, sim.progress);
    const move = timelinePoint?.move || currentMove();
    const op = timelinePoint?.operation || currentOperation(move);
    const pt = timelinePoint ? { x: timelinePoint.x, y: timelinePoint.y, z: timelinePoint.z, c: timelinePoint.c } : pointAt(move, sim.progress);
    const toolId = toolNumberForMove(move);
    updateTool(move, pt);
    if ($('simCurrentOperation')) $('simCurrentOperation').textContent = op?.name || '—';
    if ($('simCurrentTool')) $('simCurrentTool').textContent = `${toolId} · ${move?.role || '—'}`;
    if ($('simVc')) $('simVc').textContent = fmt(pt.x, 3); if ($('simRpm')) $('simRpm').textContent = fmt(pt.z, 3);
    if ($('simY')) $('simY').textContent = fmt(pt.y, 3); if ($('simC')) $('simC').textContent = `${fmt(pt.c, 2)}°`; if ($('simT')) $('simT').textContent = toolId;
    if ($('simFeed')) $('simFeed').textContent = move?.feedRate ? `${fmt(move.feedRate, 1)} мм/мин` : move?.motion === 'rapid' ? 'G0' : '—';
    const spindle = Number(move?.spindleRpm || op?.spindleRpm || op?.rpm || sim.plan?.input?.spindleRpm || 0);
    if ($('simSpindle')) $('simSpindle').textContent = spindle > 0 ? `S${Math.round(spindle)}` : (move?.toolKind === 'drilling' || move?.toolKind === 'radialDrilling' || move?.toolKind === 'millingAf' || move?.toolKind === 'millingPocket' ? 'S LIVE' : 'S0');
    if ($('simDepth')) $('simDepth').textContent = move?.passIndex ? `${move.passIndex}` : '—'; if ($('simOperationLabel')) $('simOperationLabel').textContent = op?.name || '—';
    const collisionNow = (sim.plan.collision?.collisions || []).some(col => col.moveId === move?.id);
    const banner = $('simCollisionBanner');
    if (collisionNow) { sim.running = false; sim.collisionLatched = true; if (banner) banner.hidden = false; }
    else if (!sim.collisionLatched && banner) banner.hidden = true;
    if (sim.view === 'follow' || sim.view === 'tool') setView(sim.view, pt);
    if ($('simProgressValue')) $('simProgressValue').textContent = `${Math.round(sim.progress * 100)}%`; if ($('simRemaining')) $('simRemaining').textContent = `${Math.round((1 - sim.progress) * 100)}%`;
    if ($('simProgressRange')) $('simProgressRange').value = Math.round(sim.progress * 1000);
    const opIndex = op ? sim.plan.operations.findIndex(o => o.id === op.id) : -1; if ($('simNextOperation')) $('simNextOperation').textContent = sim.plan.operations[opIndex + 1]?.name || 'Финиш';
  }

  function setView(name, toolPoint = null) {
    sim.view = name; if (!sim.camera || !sim.plan) return;
    const span = Math.max(95, sim.plan.input.blankLength + 90), aspect = Math.max(1, sim.host.clientWidth / Math.max(1, sim.host.clientHeight));
    sim.camera.left = -span * aspect / 2; sim.camera.right = span * aspect / 2; sim.camera.top = span / 2; sim.camera.bottom = -span / 2;
    const wp = toolPoint ? worldPoint(sim.plan, toolPoint) : new THREE.Vector3(0,0,0);
    if (name === 'top') sim.camera.position.set(0, 150, 0.001);
    else if (name === 'iso') sim.camera.position.set(120, 90, 150);
    else if (name === 'front') sim.camera.position.set(0, 0, 180);
    else if (name === 'tool') sim.camera.position.set(wp.x + 42, wp.y + 20, wp.z + 52);
    else if (name === 'follow') sim.camera.position.set(wp.x + 70, wp.y + 45, wp.z + 95);
    else sim.camera.position.set(0, 0, 180);
    sim.camera.lookAt((name === 'tool' || name === 'follow') ? wp : new THREE.Vector3(0, 0, 0));
    sim.camera.updateProjectionMatrix(); document.querySelectorAll('[data-sim-view]').forEach(b => b.classList.toggle('active', b.dataset.simView === name));
  }

  function fallbackToolShape(ctx, kind, x, y) {
    ctx.save(); ctx.translate(x, y); ctx.fillStyle = '#27343e'; ctx.strokeStyle = '#07131b'; ctx.lineWidth = 2;
    if (kind === 'drilling' || kind === 'radialDrilling') {
      ctx.fillRect(-8, -5, 52, 10); ctx.fillStyle = '#d7e0e5'; ctx.beginPath(); ctx.moveTo(-20, 0); ctx.lineTo(-8, -6); ctx.lineTo(-8, 6); ctx.closePath(); ctx.fill();
      for (let i=0;i<4;i++){ctx.strokeStyle='#607782';ctx.beginPath();ctx.moveTo(-5+i*10,-5);ctx.lineTo(4+i*10,5);ctx.stroke();}
    } else if (kind === 'millingAf' || kind === 'millingPocket') {
      ctx.fillRect(-5,-7,42,14); ctx.fillStyle='#c9d4da'; for(let i=0;i<5;i++){ctx.fillRect(-15+i*3,-9,2,18);}
    } else if (kind === 'cutoff') {
      ctx.fillRect(-3,-16,7,32); ctx.fillRect(4,-5,38,10);
    } else {
      ctx.fillRect(-4,-5,46,10); ctx.fillStyle='#e4b33f';ctx.beginPath();ctx.moveTo(-12,0);ctx.lineTo(-2,-7);ctx.lineTo(-2,7);ctx.closePath();ctx.fill();
    }
    ctx.restore();
  }

  function drawFallbackMachine() {
    const canvas = sim.fallbackCanvas; if (!canvas || !sim.plan) return;
    const ctx = canvas.getContext('2d'), w = canvas.width = Math.max(760, sim.host.clientWidth || 760), h = canvas.height = Math.max(420, sim.host.clientHeight || 420);
    ctx.clearRect(0, 0, w, h); const bg = ctx.createLinearGradient(0, 0, 0, h); bg.addColorStop(0, '#e6eef2'); bg.addColorStop(1, '#b9c6cd'); ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = 'rgba(91,120,137,.28)'; ctx.lineWidth = 1; for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); } for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }
    const cy = h * .53, bodyR = Math.min(82, h * .22), partLeft = Math.max(180, bodyR + 105), partRight = w * .61, span = Math.max(1, partRight - partLeft), turretX = w * .82, turretR = Math.min(94, h * .25), setup = setupOf(sim.plan), blankL = Math.max(1, Number(sim.plan.input.blankLength || 1));
    const mapZ = z => isMirrored(sim.plan) ? partLeft + (-Number(z || 0) / blankL) * span : partRight + (Number(z || 0) / blankL) * span;
    const state = sim.fallbackState || api().simulateMaterial(sim.plan, sim.progress), profile = api().materialProfile(state).sort((a, b) => b.z - a.z), maxR = Math.max(1, sim.plan.input.blankDiameter / 2), sy = (h * .34) / maxR;
    const chuckX = partLeft - 72; ctx.fillStyle = '#35434d'; ctx.beginPath(); ctx.arc(chuckX, cy, bodyR, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#7a8993'; ctx.beginPath(); ctx.arc(chuckX, cy, bodyR * .76, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#0c161d'; ctx.beginPath(); ctx.arc(chuckX, cy, bodyR * .2, 0, Math.PI * 2); ctx.fill();
    const clampD = Number(setup.clampDiameter || sim.plan.input.blankDiameter), clampL = Number(setup.clampLength || 0), clampEnd = mapZ(-clampL);
    for (let i = 0; i < 3; i++) { const a = i * Math.PI * 2 / 3; ctx.save(); ctx.translate(chuckX + Math.cos(a) * bodyR * .47, cy + Math.sin(a) * bodyR * .47); ctx.rotate(a); ctx.fillStyle = '#bac4ca'; ctx.fillRect(-9, -10, Math.max(34, partLeft - chuckX + clampL / blankL * span), 20); ctx.restore(); }
    ctx.beginPath(); profile.forEach((pt, i) => { const px = mapZ(pt.z), py = cy - pt.radius * sy; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); [...profile].reverse().forEach(pt => ctx.lineTo(mapZ(pt.z), cy + pt.radius * sy)); ctx.closePath(); const steel = ctx.createLinearGradient(0, cy - h * .2, 0, cy + h * .2); steel.addColorStop(0, '#eef3f5'); steel.addColorStop(.48, '#98a8b1'); steel.addColorStop(.55, '#667a85'); steel.addColorStop(1, '#d9e1e5'); ctx.fillStyle = steel; ctx.fill(); ctx.strokeStyle = '#344852'; ctx.lineWidth = 2; ctx.stroke();
    if (setup.protectClampZone && clampL > 0) { const zx0 = mapZ(0), zx1 = clampEnd, left = Math.min(zx0, zx1), width = Math.abs(zx1 - zx0); ctx.fillStyle = 'rgba(255,169,35,.24)'; ctx.fillRect(left, cy - clampD / 2 * sy - 3, width, clampD * sy + 6); ctx.strokeStyle = '#e88700'; ctx.lineWidth = 2; ctx.strokeRect(left, cy - clampD / 2 * sy - 3, width, clampD * sy + 6); ctx.fillStyle = '#8a4a00'; ctx.font = 'bold 12px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`ЗАЖИМ Ø${fmt(clampD, 1)} × ${fmt(clampL, 1)} · НЕ ОБРАБАТЫВАТЬ`, left + width / 2, cy + clampD / 2 * sy + 22); }
    ctx.fillStyle = '#3c4a53'; ctx.beginPath(); ctx.arc(turretX, cy, turretR, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#6d7d87'; ctx.beginPath(); ctx.arc(turretX, cy, turretR * .72, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#27343c'; ctx.beginPath(); ctx.arc(turretX, cy, turretR * .28, 0, Math.PI * 2); ctx.fill();
    const move = currentMove(), tool = toolNumberForMove(move), n = Number(tool.match(/\d+/)?.[0] || 1); for (let i = 0; i < 15; i++) { const a = (i - 3) * Math.PI * 2 / 15, x = turretX + Math.cos(a) * turretR * .83, y = cy + Math.sin(a) * turretR * .83; ctx.fillStyle = i === n - 1 ? '#f6c34a' : '#d5dde1'; ctx.strokeStyle = '#1b2a32'; ctx.beginPath(); ctx.roundRect(x - 13, y - 10, 26, 20, 3); ctx.fill(); ctx.stroke(); ctx.fillStyle = '#10202a'; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'center'; ctx.fillText(`T${i + 1}`, x, y + 3); }
    const timeline = api()?.toolPointAt?.(sim.plan, sim.progress), pt = timeline ? { x: timeline.x, y: timeline.y, z: timeline.z, c: timeline.c } : null, px = pt ? mapZ(pt.z) : partRight + 15, py = pt ? cy - Number(pt.x || 0) / 2 * sy : cy - bodyR; fallbackToolShape(ctx, move?.toolKind || 'turning', Math.min(turretX - turretR - 10, px + 15), py);
    ctx.fillStyle = '#09283a'; ctx.font = 'bold 16px sans-serif'; ctx.textAlign = 'left'; ctx.fillText('← ТРЁХКУЛАЧКОВЫЙ ПАТРОН · Ø60 В ЗАЖИМЕ', 22, 28); ctx.textAlign = 'right'; ctx.fillText('РЕВОЛЬВЕР T1–T15 →', w - 22, 28); ctx.fillStyle = '#0d5f8e'; ctx.textAlign = 'left'; ctx.font = 'bold 13px sans-serif'; ctx.fillText('НАПРАВЛЕНИЕ ЦИКЛА: ОТ ГРАНИЦЫ ЗАЖИМА → К СВОБОДНОМУ ТОРЦУ', partLeft, h - 42); ctx.fillStyle = '#09283a'; ctx.font = '13px monospace'; ctx.fillText(`${tool} · ${move?.role || '—'} · X${fmt(pt?.x, 2)} Y${fmt(pt?.y, 2)} Z${fmt(pt?.z, 2)} C${fmt(pt?.c, 1)}°`, 22, h - 18);
  }

  function setupFallback2D(reason='WebGL unavailable') {
    sim.host.innerHTML=''; const canvas=document.createElement('canvas');canvas.className='sim-fallback-canvas';canvas.setAttribute('aria-label','2D machine simulation fallback');sim.host.appendChild(canvas);sim.fallbackCanvas=canvas;updateMaterial(true);drawFallbackMachine();
    if ($('simEngineBadge')) { $('simEngineBadge').textContent='SINUMERIK VIEW · 2D FALLBACK · XYZC'; $('simEngineBadge').dataset.status='SUPPORTED'; }
    if ($('simScopeNotice')) $('simScopeNotice').insertAdjacentHTML('beforeend',`<div class="check-card warning"><b>WebGL недоступен</b><span>${esc(reason)}. Включён функциональный 2D-вид: патрон слева, револьвер T1–T15 справа, траектория и снятие материала продолжают работать.</span></div>`);
    return true;
  }

  function setupScene() {
    if (!window.THREE || !sim.host || !sim.plan?.executable) return false;
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2') && !probe.getContext('webgl')) return false;
    sim.scene = new THREE.Scene(); sim.scene.background = new THREE.Color(0xdde6eb);
    sim.camera = new THREE.OrthographicCamera(-100, 100, 60, -60, .1, 1000);
    sim.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false }); sim.renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1)); sim.renderer.shadowMap.enabled = true; sim.host.innerHTML = ''; sim.host.appendChild(sim.renderer.domElement);
    sim.scene.add(new THREE.HemisphereLight(0xffffff, 0x203040, 1.4)); const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(60, 100, 120); sim.scene.add(key);
    const grid = new THREE.GridHelper(240, 24, 0x7b9bad, 0xb7c6ce); grid.rotation.x = Math.PI / 2; grid.position.z = -30; sim.scene.add(grid);
    const axis = new THREE.AxesHelper(35); axis.position.set(sim.plan.input.blankLength / 2 + 6, -sim.plan.input.blankDiameter / 2 - 12, 0); sim.scene.add(axis);
    sim.chuck = createThreeJawChuck(); sim.scene.add(sim.chuck);
    sim.clampZoneMesh = createProtectedClampZone(); if (sim.clampZoneMesh) sim.scene.add(sim.clampZoneMesh);
    sim.turret = createTurret(); sim.scene.add(sim.turret);
    const targetState = api().simulateMaterial(sim.plan, 1); sim.targetMesh = new THREE.LineSegments(new THREE.WireframeGeometry(surfaceGeometry(targetState, 56, 80)), new THREE.LineBasicMaterial({ color: 0x00a7d8, transparent: true, opacity: .35 })); sim.targetMesh.name = 'TARGET_SURFACE'; sim.scene.add(sim.targetMesh);
    sim.pathRapid = createPath(false); sim.pathCut = createPath(true); sim.scene.add(sim.pathRapid, sim.pathCut);
    sim.collisionGroup = new THREE.Group(); sim.collisionGroup.name = 'COLLISION_MARKERS'; for (const col of sim.plan.collision?.collisions || []) { const marker = new THREE.Mesh(new THREE.SphereGeometry(2.5, 12, 8), new THREE.MeshBasicMaterial({ color: 0xff2c2c })); marker.position.copy(worldPoint(sim.plan, col.point)); sim.collisionGroup.add(marker); } sim.scene.add(sim.collisionGroup);
    updateMaterial(true); setView('sinumerik'); resize(); sim.resizeObserver = new ResizeObserver(resize); sim.resizeObserver.observe(sim.host);
    if ($('simEngineBadge')) { $('simEngineBadge').textContent = 'SINUMERIK VIEW · XYZC · 15 POS'; $('simEngineBadge').dataset.status = 'SUPPORTED'; }
    return true;
  }
  function resize() { if (!sim.renderer || !sim.host) return; const w = Math.max(320, sim.host.clientWidth), h = Math.max(260, sim.host.clientHeight); sim.renderer.setSize(w, h, false); setView(sim.view); }
  function renderFrame() { if (sim.renderer && sim.scene && sim.camera) sim.renderer.render(sim.scene, sim.camera); else drawFallbackMachine(); }

  function animate(ts) {
    const generation = sim.loopGeneration; if (!sim.lastFrame) sim.lastFrame = ts; const dt = Math.min(.08, (ts - sim.lastFrame) / 1000); sim.lastFrame = ts;
    if (sim.running && sim.plan?.executable) { sim.progress = clamp(sim.progress + dt * .055 * sim.speed, 0, 1); if (sim.progress >= 1) sim.running = false; updateMaterial(); updateTelemetry(); }
    const move = currentMove();
    if (sim.running && sim.chuck && !['radialDrilling','millingAf','millingPocket'].includes(move?.toolKind)) sim.chuck.rotation.x += dt * 2.8;
    if (sim.running && sim.activeTool && ['drilling','radialDrilling','millingAf','millingPocket'].includes(move?.toolKind)) sim.activeTool.rotation.x += dt * 8;
    renderFrame(); if (generation === sim.loopGeneration) requestAnimationFrame(animate);
  }

  function bindControls() {
    const setProgress = v => { sim.progress = clamp(v, 0, 1); updateMaterial(true); updateTelemetry(); renderFrame(); };
    $('simProgressRange')?.addEventListener('input', e => setProgress(Number(e.target.value) / 1000));
    $('simSpeedRange')?.addEventListener('input', e => { sim.speed = Number(e.target.value); if ($('simSpeedValue')) $('simSpeedValue').textContent = `${sim.speed}×`; });
    $('simPlayBtn')?.addEventListener('click', () => { if (sim.progress >= 1) setProgress(0); sim.collisionLatched = false; const b=$('simCollisionBanner'); if(b)b.hidden=true; sim.running = true; }); $('simPauseBtn')?.addEventListener('click', () => { sim.running = false; }); $('simResetBtn')?.addEventListener('click', () => { sim.running = false; sim.collisionLatched=false; const b=$('simCollisionBanner'); if(b)b.hidden=true; setProgress(0); });
    $('simBuildBtn')?.addEventListener('click', () => init3D(true));
    $('simPrevStepBtn')?.addEventListener('click', () => { const candidates = sim.plan.moves.map(m => m.startProgress).filter(p => p < sim.progress - .001); setProgress(candidates.length ? candidates.at(-1) : 0); });
    $('simNextStepBtn')?.addEventListener('click', () => { const next = sim.plan.moves.map(m => m.endProgress).find(p => p > sim.progress + .001); setProgress(next ?? 1); });
    document.querySelectorAll('[data-sim-view]').forEach(b => b.addEventListener('click', () => setView(b.dataset.simView)));
  }

  function init3D(force = false) {
    const host = $('stock3dViewport'); if (!host) return false;
    if (!force && sim.host === host && sim.renderer && host.contains(sim.renderer.domElement)) return true;
    sim.loopGeneration++; sim.resizeObserver?.disconnect?.(); disposeObject(sim.scene); sim.renderer?.dispose?.(); Object.assign(sim, { renderer: null, scene: null, camera: null, materialMesh: null, targetMesh: null, boreMesh: null, chuck: null, clampZoneMesh: null, turret: null, activeTool: null, selectedTool: null, progress: Number($('simProgressRange')?.value || 0) / 1000, lastGeometryProgress: -1, running: false, lastFrame: 0, host, fallbackCanvas: null, fallbackState: null, collisionLatched: false });
    rebuildPlan();
    if (!sim.plan?.executable) { host.innerHTML = '<div class="sim-fallback warning">CAM-план заблокирован. Откройте CAM-функции и исправьте параметры.</div>'; return false; }
    let sceneReady = false;
    try { sceneReady = setupScene(); } catch (error) { console.warn('WebGL setup failed; using 2D fallback', error); sceneReady = setupFallback2D(error?.message || 'WebGL/Three.js недоступен'); }
    if (!sceneReady) sceneReady = setupFallback2D(window.THREE ? 'WebGL-контекст недоступен' : 'Three.js не загружен');
    if ($('simBlankMetric')) $('simBlankMetric').textContent = `Ø${fmt(sim.plan.input.blankDiameter, 1)} × ${fmt(sim.plan.input.blankLength, 1)}`;
    if ($('simOpsMetric')) $('simOpsMetric').textContent = String(sim.plan.operations.length); if ($('simTimeMetric')) $('simTimeMetric').textContent = `${fmt(sim.plan.estimatedMinutes, 2)} мин`;
    bindControls(); updateTelemetry(); sim.loopGeneration++; requestAnimationFrame(animate); return true;
  }

  function renderStockPreview() {
    const canvas = $('stockCanvas'); if (!canvas || !sim.plan) return; const ctx = canvas.getContext('2d'), p = sim.plan; ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = '#dce7ed'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (!p.executable) { ctx.fillStyle = '#8d3b1e'; ctx.font = '600 18px sans-serif'; ctx.fillText('CAM-план заблокирован', 36, 60); return; }
    const initial = api().materialProfile(api().simulateMaterial(p, 0)).sort((a,b)=>b.z-a.z), target = api().materialProfile(api().simulateMaterial(p, 1)).sort((a,b)=>b.z-a.z), setup = setupOf(p), zone = clampZone(p);
    const maxR = Math.max(p.input.blankDiameter / 2 + 12, 40), cy = canvas.height / 2, partLeft = 190, partRight = canvas.width - 145, span = partRight - partLeft, blankL = Math.max(1, p.input.blankLength), mapZ = z => isMirrored(p) ? partLeft + (-Number(z || 0) / blankL) * span : partRight + (Number(z || 0) / blankL) * span, mapR = r => cy - r / maxR * (canvas.height * .38);
    const poly = (profile, fill, stroke) => { ctx.beginPath(); profile.forEach((pt, i) => ctx[i ? 'lineTo' : 'moveTo'](mapZ(pt.z), mapR(pt.radius))); [...profile].reverse().forEach(pt => ctx.lineTo(mapZ(pt.z), canvas.height - mapR(pt.radius))); ctx.closePath(); ctx.fillStyle = fill; ctx.fill(); ctx.strokeStyle = stroke; ctx.lineWidth = 2; ctx.stroke(); };
    const chuckX = 88, chuckR = Math.min(72, canvas.height * .28); ctx.fillStyle = '#414f59'; ctx.beginPath(); ctx.arc(chuckX, cy, chuckR, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#87949d'; ctx.beginPath(); ctx.arc(chuckX, cy, chuckR * .72, 0, Math.PI * 2); ctx.fill(); ctx.fillStyle = '#0a151c'; ctx.beginPath(); ctx.arc(chuckX, cy, chuckR * .2, 0, Math.PI * 2); ctx.fill();
    for(let i=0;i<3;i++){const a=i*Math.PI*2/3;ctx.save();ctx.translate(chuckX+Math.cos(a)*chuckR*.46,cy+Math.sin(a)*chuckR*.46);ctx.rotate(a);ctx.fillStyle='#bac4ca';ctx.fillRect(-8,-8,partLeft-chuckX+20,16);ctx.restore();}
    poly(initial, '#a4b0b8', '#5f707b'); poly(target, 'rgba(26,166,205,.28)', '#009dcc');
    if(zone){const x0=mapZ(zone.z0),x1=mapZ(zone.z1),left=Math.min(x0,x1),width=Math.abs(x1-x0),r=Number(setup.clampDiameter||p.input.blankDiameter)/2;ctx.fillStyle='rgba(255,169,35,.28)';ctx.fillRect(left,mapR(r)-3,width,(cy-mapR(r))*2+6);ctx.strokeStyle='#e78400';ctx.lineWidth=2;ctx.strokeRect(left,mapR(r)-3,width,(cy-mapR(r))*2+6);ctx.fillStyle='#6f3d00';ctx.font='bold 12px sans-serif';ctx.textAlign='center';ctx.fillText(`ЗАЩИЩЁННЫЙ ЗАЖИМ Ø${fmt(setup.clampDiameter,1)} × ${fmt(setup.clampLength,1)}`,left+width/2,canvas.height-18);}
    for (const move of p.moves) { if(move.motion==='index')continue; ctx.beginPath(); ctx.moveTo(mapZ(move.from.z), mapR((move.from.x || 0) / 2)); ctx.lineTo(mapZ(move.to.z), mapR((move.to.x || 0) / 2)); ctx.strokeStyle = move.cutting ? '#f19a24' : 'rgba(27,100,180,.42)'; ctx.lineWidth = move.cutting ? 2 : 1; ctx.stroke(); }
    ctx.fillStyle = '#15374b'; ctx.font = 'bold 14px sans-serif'; ctx.textAlign='left'; ctx.fillText('ПАТРОН + Ø60 В КУЛАЧКАХ — СЛЕВА', 18, 22); ctx.textAlign='right'; ctx.fillText('РЕВОЛЬВЕР / ИНСТРУМЕНТ — СПРАВА', canvas.width - 18, 22); ctx.fillStyle='#0b6f9e';ctx.textAlign='center';ctx.fillText('ЦИКЛ: ОТ ГРАНИЦЫ ЗАЖИМА → К СВОБОДНОМУ ТОРЦУ', (partLeft+partRight)/2, 42);
  }

  function initCamStage() { rebuildPlan(); renderStockPreview(); }
  function canConfirm() { return Boolean(sim.plan?.executable && sim.progress >= .999 && !sim.running); }
  window.CNC3D_init = init3D; window.CNC3D_canConfirm = canConfirm; window.CNC_CAM_currentPlan = () => sim.plan || rebuildPlan(); window.CNC_CAM_renderPreflight = initCamStage;
  window.addEventListener('cnc-cam-stage-ready', initCamStage); window.addEventListener('cnc-simulation-stage-ready', () => setTimeout(() => init3D(true), 0)); window.addEventListener('cnc-cam-engine-ready', () => { initCamStage(); if ($('stock3dViewport')) init3D(true); });
})();
