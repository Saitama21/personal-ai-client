(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const fmt = (value, digits = 0) => Number(value || 0).toLocaleString('ru-RU', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, symbol => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[symbol]);

  const sim = {
    renderer: null,
    scene: null,
    camera: null,
    materialMesh: null,
    targetMesh: null,
    rapidPath: null,
    cutPath: null,
    collisionMarkers: null,
    tool: null,
    chuck: null,
    grid: null,
    host: null,
    resizeObserver: null,
    plan: null,
    running: false,
    progress: 0,
    speed: 1,
    lastFrame: 0,
    lastGeometryProgress: -1,
    dragging: false,
    pointerX: 0,
    pointerY: 0,
    yaw: -0.72,
    pitch: 0.36,
    distance: 145,
    initialVolume: 0,
    finalVolume: 0,
    currentVolume: 0,
    loopGeneration: 0,
  };

  function camApi() {
    return window.CNC_CAM_API || null;
  }

  function currentInput() {
    return window.CNC_CAM_getInput?.() || window.CNC3D_getData?.() || {};
  }

  function rebuildPlan() {
    const api = camApi();
    if (!api) return null;
    sim.plan = api.buildCamPlan(currentInput());
    if (sim.plan.materialModel) {
      const initial = api.simulateMaterial(sim.plan, 0);
      const final = api.simulateMaterial(sim.plan, 1);
      sim.initialVolume = api.materialVolume(initial);
      sim.finalVolume = api.materialVolume(final);
      sim.currentVolume = sim.initialVolume;
    } else {
      sim.initialVolume = 0;
      sim.finalVolume = 0;
      sim.currentVolume = 0;
    }
    window.CNC_CAM_setSummary?.(api.planSummary(sim.plan));
    renderPlanStatus();
    return sim.plan;
  }

  function statusLabel(status) {
    return ({
      SUPPORTED: 'X/Z поддержан',
      PARTIAL: 'Геометрия готова, выпуск ограничен',
      BLOCKED: 'Расчёт заблокирован',
      NOT_IMPLEMENTED: 'Не реализовано',
      INTERFACE_ONLY: 'Только интерфейс',
      NOT_EVALUATED: 'Не проверено',
      SUPPORTED_INDEXED: 'Поддержана индексация',
      EVALUATED_LIMITED: 'Проверено по оболочкам',
      GENERATED: 'Сформировано',
    })[status] || String(status || 'Нет статуса');
  }

  function setStatusBadge(element, status) {
    if (!element) return;
    element.textContent = statusLabel(status);
    element.dataset.status = status || 'UNKNOWN';
  }

  function issueMarkup(items) {
    return items.map(item => `<div class="cam-issue ${item.severity === 'error' ? 'error' : 'warning'}"><b>${escapeHtml(item.code)}</b><span>${escapeHtml(item.message)}</span></div>`).join('');
  }

  function capabilityMarkup(plan) {
    const axes = plan.capabilities.axes;
    return [
      ['Токарное наружное X/Z', plan.capabilities.turningXZ.status, plan.capabilities.turningXZ.scope],
      ['Съём материала', plan.capabilities.materialRemoval.status, plan.capabilities.materialRemoval.scope],
      ['Оси X / Z', `${axes.X} / ${axes.Z}`, 'X в диаметрах, Z0 по правому торцу'],
      ['Оси C / Y', `${axes.C} / ${axes.Y}`, 'Не участвуют в исполняемом плане'],
      ['Наружная резьба', plan.capabilities.threading.status, plan.capabilities.threading.scope],
      ['Осевое сверление', plan.capabilities.drilling.status, plan.capabilities.drilling.scope],
      ['Отрезка / Cutoff', plan.capabilities.cutoff.status, plan.capabilities.cutoff.scope],
      ['Фрезерование / AF', plan.capabilities.milling.status, plan.capabilities.milling.scope],
      ['Коллизии', plan.collision.status, plan.collision.message],
      ['SINUMERIK 828D MPF', plan.postprocessor.status, plan.postprocessor.errors?.map(item => item.message).join(' ') || plan.capabilities.postprocessor.scope],
    ].map(([name, status, scope]) => `<div class="cam-capability"><b>${escapeHtml(name)}</b><span>${escapeHtml(statusLabel(status))}</span><small>${escapeHtml(scope)}</small></div>`).join('');
  }

  function renderPlanStatus() {
    const plan = sim.plan;
    if (!plan) return;
    setStatusBadge($('camPlanBadge'), plan.status);
    setStatusBadge($('simPlanBadge'), plan.status);
    const details = $('camPlanDetails');
    if (details) {
      details.innerHTML = plan.executable
        ? `<div class="cam-metrics"><b>${plan.operations.length}</b><span>исполняемых операций</span><b>${plan.moves.length}</b><span>ходов</span><b>${plan.turning.parameters.roughPassCount}</b><span>черновых проходов</span><b>${fmt(plan.estimatedMinutes, 2)}</b><span>мин расчётного движения</span></div>`
        : '<div class="check-card warning">Исполняемый план не создан. Визуальная подмена контура не применяется.</div>';
    }
    const issues = $('camIssueList');
    if (issues) issues.innerHTML = issueMarkup([...plan.errors, ...plan.warnings]);
    const capabilities = $('camCapabilityList');
    if (capabilities) capabilities.innerHTML = capabilityMarkup(plan);
    const stockButton = $('stockRemovalBtn');
    if (stockButton) stockButton.disabled = !plan.executable;
    const simScope = $('simScopeNotice');
    if (simScope) {
      const excluded = plan.unsupportedOperations.length
        ? `<b>Исключено из исполнения:</b> ${plan.unsupportedOperations.map(item => escapeHtml(item.name)).join(', ')}.`
        : '<b>Исполняется:</b> весь валидированный CAM-маршрут.';
      simScope.innerHTML = `<div class="check-card ${plan.releaseReady ? 'good' : 'warning'}"><span>${excluded}<br>Коллизии: ${escapeHtml(statusLabel(plan.collision.status))}. MPF: ${escapeHtml(statusLabel(plan.postprocessor.status))}. C: ${escapeHtml(statusLabel(plan.capabilities.axes.C))}; Y: ${escapeHtml(statusLabel(plan.capabilities.axes.Y))}.</span></div>`;
    }
    const buildButton = $('simBuildBtn');
    const playButton = $('simPlayBtn');
    if (buildButton) buildButton.disabled = !plan.executable;
    if (playButton) playButton.disabled = !plan.executable;
  }

  function boundsForPlan(plan) {
    const zValues = [0, -plan.input.blankLength, ...plan.moves.flatMap(move => [move.from.z, move.to.z])];
    const xValues = [plan.input.blankDiameter, ...plan.moves.flatMap(move => [move.from.x, move.to.x])];
    return {
      zMin: Math.min(...zValues),
      zMax: Math.max(...zValues),
      xMax: Math.max(...xValues),
    };
  }

  function renderStockPreview() {
    const canvas = $('stockCanvas');
    if (!canvas || !sim.plan) return;
    const context = canvas.getContext('2d');
    const plan = sim.plan;
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = '#07131f';
    context.fillRect(0, 0, canvas.width, canvas.height);
    if (!plan.executable) {
      context.fillStyle = '#ffcf72';
      context.font = '600 18px system-ui';
      context.fillText('Расчёт заблокирован — исправьте исходные данные', 38, 58);
      plan.errors.slice(0, 6).forEach((item, index) => {
        context.font = '14px system-ui';
        context.fillText(`• ${item.message}`, 38, 94 + index * 26);
      });
      return;
    }
    const api = camApi();
    const initial = api.materialProfile(api.simulateMaterial(plan, 0));
    const target = api.materialProfile(api.simulateMaterial(plan, 1));
    const bounds = boundsForPlan(plan);
    const pad = { left: 48, right: 28, top: 34, bottom: 34 };
    const drawW = canvas.width - pad.left - pad.right;
    const drawH = canvas.height - pad.top - pad.bottom;
    const mapZ = z => pad.left + ((z - bounds.zMin) / Math.max(1e-6, bounds.zMax - bounds.zMin)) * drawW;
    const mapY = radius => canvas.height / 2 - (radius / Math.max(1, bounds.xMax / 2)) * drawH / 2;
    const polygon = (profile, fill, stroke, width = 2) => {
      context.beginPath();
      profile.forEach((point, index) => context[index ? 'lineTo' : 'moveTo'](mapZ(point.z), mapY(point.radius)));
      [...profile].reverse().forEach(point => context.lineTo(mapZ(point.z), canvas.height - mapY(point.radius)));
      context.closePath();
      context.fillStyle = fill;
      context.fill();
      context.strokeStyle = stroke;
      context.lineWidth = width;
      context.stroke();
    };
    polygon(initial, 'rgba(111,128,146,.65)', '#8294a7');
    polygon(target, 'rgba(24,186,215,.28)', '#37dcff', 3);
    context.lineWidth = 1.4;
    for (const move of plan.moves) {
      context.beginPath();
      context.moveTo(mapZ(move.from.z), mapY(move.from.x / 2));
      context.lineTo(mapZ(move.to.z), mapY(move.to.x / 2));
      context.strokeStyle = move.cutting ? 'rgba(255,184,72,.9)' : 'rgba(81,145,255,.48)';
      context.stroke();
    }
    context.strokeStyle = '#4d657b';
    context.beginPath();
    context.moveTo(pad.left, canvas.height / 2);
    context.lineTo(canvas.width - pad.right, canvas.height / 2);
    context.stroke();
  }

  function worldCenter(plan) {
    return (plan.input.axialAllowance - plan.input.blankLength) / 2;
  }

  function worldPoint(plan, point, radialOffset = 0) {
    const angle = Number.isFinite(Number(point.c)) ? Number(point.c) * Math.PI / 180 : 0;
    const radius = (Number(point.x) || 0) / 2 + radialOffset;
    return new THREE.Vector3((Number(point.z) || 0) - worldCenter(plan), radius * Math.cos(angle), radius * Math.sin(angle));
  }

  function outerRadiusAtProfile(profile, z) {
    const ordered = [...profile].sort((a, b) => b.z - a.z);
    if (!ordered.length) return 0;
    if (z >= ordered[0].z) return ordered[0].radius;
    if (z <= ordered.at(-1).z) return ordered.at(-1).radius;
    for (let index = 0; index < ordered.length - 1; index += 1) {
      const a = ordered[index], b = ordered[index + 1];
      if (z <= a.z && z >= b.z) {
        const t = (z - a.z) / (b.z - a.z || 1);
        return a.radius + (b.radius - a.radius) * t;
      }
    }
    return ordered.at(-1).radius;
  }

  function materialSurfaceGeometry(materialState) {
    const api = camApi();
    const profile = api.materialProfile(materialState).filter(point => Number.isFinite(point.z) && Number.isFinite(point.radius));
    if (profile.length < 2) return null;
    const zStart = Math.max(...profile.map(point => point.z)), zEnd = Math.min(...profile.map(point => point.z));
    const zSteps = Math.max(72, Math.ceil(Math.abs(zStart - zEnd) / 0.45));
    const angleSteps = 112, vertices = [], indices = [];
    for (let zi = 0; zi <= zSteps; zi += 1) {
      const z = zStart + (zEnd - zStart) * zi / zSteps;
      const outer = outerRadiusAtProfile(profile, z);
      for (let ai = 0; ai <= angleSteps; ai += 1) {
        const angle = Math.PI * 2 * ai / angleSteps;
        const radius = api.radialBoundaryAt(materialState.features, z, angle, outer);
        vertices.push(z - worldCenter(sim.plan), radius * Math.cos(angle), radius * Math.sin(angle));
      }
    }
    for (let zi = 0; zi < zSteps; zi += 1) for (let ai = 0; ai < angleSteps; ai += 1) {
      const a = zi * (angleSteps + 1) + ai, b = a + angleSteps + 1;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setIndex(indices); geometry.computeVertexNormals();
    return geometry;
  }

  function buildThreadHelix(materialState, group) {
    const thread = materialState.features?.thread;
    if (!thread) return;
    const points = [], turns = Math.max(1, (thread.zStart - thread.zEnd) / thread.pitch), count = Math.ceil(turns * 36);
    for (let index = 0; index <= count; index += 1) {
      const t = index / count, z = thread.zStart + (thread.zEnd - thread.zStart) * t;
      const depth = thread.depthSamples[Math.min(thread.depthSamples.length - 1, Math.floor(t * thread.depthSamples.length))]?.value || 0;
      if (depth <= 1e-5) continue;
      const angle = Math.PI * 2 * turns * t, radius = thread.majorRadius - depth + 0.12;
      points.push(new THREE.Vector3(z - worldCenter(sim.plan), radius * Math.cos(angle), radius * Math.sin(angle)));
    }
    if (points.length > 1) group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), new THREE.LineBasicMaterial({ color: 0xff9a35 })));
  }

  function profileGeometry(profile, opacity = 1) {
    const points = profile
      .filter(point => Number.isFinite(point.radius) && Number.isFinite(point.z))
      .map(point => new THREE.Vector2(Math.max(0.001, point.radius), worldCenter(sim.plan) - point.z));
    if (points.length < 2) return null;
    const geometry = new THREE.LatheGeometry(points, 96);
    geometry.computeVertexNormals();
    return geometry;
  }

  function disposeObject(object) {
    if (!object) return;
    object.traverse?.(child => {
      child.geometry?.dispose?.();
      const materials = Array.isArray(child.material) ? child.material : [child.material];
      materials.filter(Boolean).forEach(material => material.dispose?.());
    });
    object.parent?.remove(object);
  }

  function rebuildMaterialGeometry(force = false) {
    if (!sim.scene || !sim.plan?.executable) return;
    if (!force && Math.abs(sim.progress - sim.lastGeometryProgress) < 0.002) return;
    sim.lastGeometryProgress = sim.progress;
    const api = camApi();
    const materialState = api.simulateMaterial(sim.plan, sim.progress);
    sim.currentVolume = api.materialVolume(materialState);
    const geometry = materialSurfaceGeometry(materialState);
    disposeObject(sim.materialMesh);
    if (geometry) {
      sim.materialMesh = new THREE.Group();
      sim.materialMesh.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0x98a7b5,
        metalness: 0.86,
        roughness: 0.3,
        side: THREE.DoubleSide,
      })));
      const hole = materialState.features?.drilling;
      if (hole?.currentDepth > 1e-5) {
        const wall = new THREE.Mesh(
          new THREE.CylinderGeometry(hole.diameter / 2, hole.diameter / 2, hole.currentDepth, 64, 1, true),
          new THREE.MeshStandardMaterial({ color: 0x46525d, metalness: 0.72, roughness: 0.46, side: THREE.DoubleSide }),
        );
        wall.rotation.z = Math.PI / 2;
        wall.position.x = hole.startZ - hole.currentDepth / 2 - worldCenter(sim.plan);
        sim.materialMesh.add(wall);
      }
      buildThreadHelix(materialState, sim.materialMesh);
      sim.scene.add(sim.materialMesh);
    }
    updateToolAndTelemetry();
  }

  function buildTargetMesh() {
    disposeObject(sim.targetMesh);
    const api = camApi();
    const geometry = materialSurfaceGeometry(api.simulateMaterial(sim.plan, 1));
    if (!geometry) return;
    sim.targetMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({
      color: 0x20d8ff,
      wireframe: true,
      transparent: true,
      opacity: 0.16,
      depthWrite: false,
    }));
    sim.scene.add(sim.targetMesh);
  }

  function lineSegmentsForMoves(moves, color, opacity) {
    const vertices = [];
    for (const move of moves) {
      const from = worldPoint(sim.plan, move.from, 0.45);
      const to = worldPoint(sim.plan, move.to, 0.45);
      vertices.push(from.x, from.y, from.z, to.x, to.y, to.z);
    }
    if (!vertices.length) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  }

  function buildToolpaths() {
    disposeObject(sim.rapidPath);
    disposeObject(sim.cutPath);
    sim.rapidPath = lineSegmentsForMoves(sim.plan.moves.filter(move => !move.cutting), 0x568fff, 0.5);
    sim.cutPath = lineSegmentsForMoves(sim.plan.moves.filter(move => move.cutting), 0xffbd54, 0.95);
    if (sim.rapidPath) sim.scene.add(sim.rapidPath);
    if (sim.cutPath) sim.scene.add(sim.cutPath);
  }

  function buildCollisionMarkers() {
    disposeObject(sim.collisionMarkers);
    sim.collisionMarkers = new THREE.Group();
    for (const collision of sim.plan.collision?.collisions || []) {
      const point = worldPoint(sim.plan, collision.point, 0);
      const marker = new THREE.Mesh(new THREE.SphereGeometry(1.4, 16, 10), new THREE.MeshBasicMaterial({ color: 0xff3d55 }));
      marker.position.copy(point); sim.collisionMarkers.add(marker);
    }
    if (sim.collisionMarkers.children.length) sim.scene.add(sim.collisionMarkers);
  }

  function buildMachineScene() {
    const plan = sim.plan;
    const chuckMaterial = new THREE.MeshStandardMaterial({ color: 0x283743, metalness: 0.85, roughness: 0.34 });
    sim.chuck = new THREE.Mesh(new THREE.CylinderGeometry(plan.input.blankDiameter * 0.62, plan.input.blankDiameter * 0.62, 16, 48), chuckMaterial);
    sim.chuck.rotation.z = Math.PI / 2;
    sim.chuck.position.x = -plan.input.blankLength / 2 - 11;
    sim.scene.add(sim.chuck);
    const toolGroup = new THREE.Group();
    const holder = new THREE.Mesh(new THREE.BoxGeometry(25, 6, 7), new THREE.MeshStandardMaterial({ color: 0x354650, metalness: 0.75, roughness: 0.32 }));
    holder.position.x = 12;
    const insert = new THREE.Mesh(new THREE.ConeGeometry(3.8, 6.4, 3), new THREE.MeshStandardMaterial({ color: 0xf2b84a, metalness: 0.45, roughness: 0.24 }));
    insert.rotation.z = Math.PI / 2;
    insert.position.x = -2.5;
    toolGroup.add(holder, insert);
    toolGroup.rotation.z = Math.PI;
    sim.tool = toolGroup;
    sim.scene.add(toolGroup);
  }

  function clearSceneRuntime() {
    [sim.materialMesh, sim.targetMesh, sim.rapidPath, sim.cutPath, sim.collisionMarkers, sim.tool, sim.chuck, sim.grid].forEach(disposeObject);
    sim.materialMesh = null;
    sim.targetMesh = null;
    sim.rapidPath = null;
    sim.cutPath = null;
    sim.collisionMarkers = null;
    sim.tool = null;
    sim.chuck = null;
    sim.grid = null;
  }

  function setupScene() {
    const host = $('stock3dViewport');
    if (!host || !sim.plan?.executable) return false;
    if (sim.renderer && !host.contains(sim.renderer.domElement)) sim.host = host;
    if (!window.THREE) {
      const fallback = $('simFallback');
      if (fallback) fallback.textContent = 'Локальный 3D-движок не загружен.';
      setStatusBadge($('simEngineBadge'), 'BLOCKED');
      return false;
    }
    const probe = document.createElement('canvas');
    if (!(probe.getContext('webgl2') || probe.getContext('webgl') || probe.getContext('experimental-webgl'))) {
      const fallback = $('simFallback');
      if (fallback) fallback.textContent = 'WebGL недоступен. CAM-план рассчитан, но 3D-визуализация не может быть показана.';
      setStatusBadge($('simEngineBadge'), 'BLOCKED');
      return false;
    }
    if (sim.renderer) {
      clearSceneRuntime();
      sim.resizeObserver?.disconnect();
      sim.renderer.dispose();
    }
    host.innerHTML = '';
    sim.host = host;
    sim.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    sim.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    sim.renderer.shadowMap.enabled = true;
    host.appendChild(sim.renderer.domElement);
    sim.scene = new THREE.Scene();
    sim.scene.background = new THREE.Color(0x07121e);
    sim.camera = new THREE.PerspectiveCamera(38, 1, 0.1, 2000);
    sim.scene.add(new THREE.HemisphereLight(0xc4efff, 0x11202d, 2.15));
    const key = new THREE.DirectionalLight(0xffffff, 3.1);
    key.position.set(70, 90, 80);
    sim.scene.add(key);
    const rim = new THREE.DirectionalLight(0x35d9ff, 2.2);
    rim.position.set(-60, 25, -70);
    sim.scene.add(rim);
    sim.grid = new THREE.GridHelper(180, 18, 0x1a6c82, 0x163746);
    sim.grid.rotation.z = Math.PI / 2;
    sim.grid.position.y = -Math.max(24, sim.plan.input.blankDiameter * 0.65);
    sim.scene.add(sim.grid);
    buildMachineScene();
    buildTargetMesh();
    buildToolpaths();
    buildCollisionMarkers();
    rebuildMaterialGeometry(true);
    const resize = () => {
      const width = Math.max(300, host.clientWidth);
      const height = Math.max(300, host.clientHeight);
      sim.renderer.setSize(width, height, false);
      sim.camera.aspect = width / height;
      sim.camera.updateProjectionMatrix();
    };
    sim.resizeObserver = new ResizeObserver(resize);
    sim.resizeObserver.observe(host);
    resize();
    bindViewportControls(sim.renderer.domElement);
    setStatusBadge($('simEngineBadge'), sim.plan.status);
    sim.lastFrame = 0;
    sim.loopGeneration += 1;
    const generation = sim.loopGeneration;
    requestAnimationFrame(timestamp => loop(timestamp, generation));
    return true;
  }

  function bindViewportControls(canvas) {
    canvas.addEventListener('pointerdown', event => {
      sim.dragging = true;
      sim.pointerX = event.clientX;
      sim.pointerY = event.clientY;
      canvas.setPointerCapture?.(event.pointerId);
    });
    canvas.addEventListener('pointermove', event => {
      if (!sim.dragging) return;
      sim.yaw -= (event.clientX - sim.pointerX) * 0.006;
      sim.pitch = clamp(sim.pitch + (event.clientY - sim.pointerY) * 0.006, -1.05, 1.05);
      sim.pointerX = event.clientX;
      sim.pointerY = event.clientY;
    });
    canvas.addEventListener('pointerup', () => { sim.dragging = false; });
    canvas.addEventListener('pointercancel', () => { sim.dragging = false; });
    canvas.addEventListener('wheel', event => {
      event.preventDefault();
      sim.distance = clamp(sim.distance + event.deltaY * 0.08, 55, 320);
    }, { passive: false });
  }

  function cameraUpdate() {
    if (!sim.camera) return;
    const cp = Math.cos(sim.pitch);
    sim.camera.position.set(Math.cos(sim.yaw) * cp * sim.distance, Math.sin(sim.pitch) * sim.distance, Math.sin(sim.yaw) * cp * sim.distance);
    sim.camera.lookAt(0, 0, 0);
  }

  function loop(timestamp, generation) {
    if (generation !== sim.loopGeneration || !sim.renderer || !sim.scene || !sim.camera) return;
    requestAnimationFrame(nextTimestamp => loop(nextTimestamp, generation));
    const delta = Math.min(0.05, (timestamp - (sim.lastFrame || timestamp)) / 1000);
    sim.lastFrame = timestamp;
    if (sim.running && sim.plan?.executable) {
      const playbackSeconds = Math.max(14, Math.min(90, sim.plan.estimatedMinutes * 10));
      sim.progress = clamp(sim.progress + (delta * sim.speed) / playbackSeconds, 0, 1);
      if (sim.progress >= 1) sim.running = false;
      rebuildMaterialGeometry();
    }
    cameraUpdate();
    sim.renderer.render(sim.scene, sim.camera);
  }

  function updateToolAndTelemetry() {
    if (!sim.plan?.executable) return;
    const api = camApi();
    const point = api.toolPointAt(sim.plan, sim.progress);
    if (point && sim.tool) sim.tool.position.copy(worldPoint(sim.plan, point, 0.55));
    const operationIndex = point?.operation ? sim.plan.operations.findIndex(operation => operation.id === point.operation.id) : -1;
    const next = operationIndex >= 0 ? sim.plan.operations[operationIndex + 1] : sim.plan.operations[0];
    const removed = Math.max(0, sim.initialVolume - sim.currentVolume);
    const totalRemoved = Math.max(0, sim.initialVolume - sim.finalVolume);
    const set = (id, value) => { const element = $(id); if (element) element.textContent = value; };
    set('simCurrentOperation', point?.operation?.name || 'Подготовка');
    set('simCurrentTool', point?.move ? `${point.move.motion === 'rapid' ? 'G0' : 'G1'} · ${point.move.role}` : '—');
    set('simVc', point ? fmt(point.x, 2) : '—');
    set('simRpm', point ? fmt(point.z, 2) : '—');
    set('simFeed', point?.move?.feedRate ? `${fmt(point.move.feedRate, 1)} мм/мин` : 'быстрый ход');
    set('simDepth', point?.move?.passIndex ? String(point.move.passIndex) : '—');
    set('simOperationLabel', point?.operation ? `${Math.max(1, operationIndex + 1)}/${sim.plan.operations.length} · ${point.operation.name}` : 'Подготовка');
    set('simProgressValue', `${Math.round(sim.progress * 100)}%`);
    set('simRemovedLabel', `Снято: ${fmt(removed)} мм³`);
    set('simBlankMetric', `Ø${fmt(sim.plan.input.blankDiameter, 2)} × ${fmt(sim.plan.input.blankLength, 2)} мм`);
    set('simOpsMetric', String(sim.plan.operations.length));
    set('simVolumeMetric', `${fmt(totalRemoved)} мм³`);
    set('simTimeMetric', `${fmt(sim.plan.estimatedMinutes, 2)} мин`);
    set('simRemaining', `${Math.max(0, Math.round((1 - sim.progress) * 100))}%`);
    set('simNextOperation', next?.name || 'Готовая X/Z геометрия');
    const range = $('simProgressRange');
    if (range) range.value = String(Math.round(sim.progress * 1000));
  }

  function resetSimulation(progress = 0) {
    sim.progress = clamp(progress, 0, 1);
    sim.running = false;
    sim.lastGeometryProgress = -1;
    rebuildMaterialGeometry(true);
  }

  function operationStep(direction) {
    if (!sim.plan?.operations.length) return;
    const point = camApi().toolPointAt(sim.plan, sim.progress);
    let index = point?.operation ? sim.plan.operations.findIndex(operation => operation.id === point.operation.id) : 0;
    index = clamp(index + direction, 0, sim.plan.operations.length - 1);
    const operation = sim.plan.operations[index];
    const move = sim.plan.moves[operation.moveStart];
    resetSimulation(direction > 0 ? move.endProgress : move.startProgress);
  }

  function bindSimulationControls() {
    const buildButton = $('simBuildBtn');
    if (buildButton) buildButton.onclick = () => {
      rebuildPlan();
      if (sim.plan?.executable) {
        resetSimulation(0);
        setupScene();
      }
    };
    const playButton = $('simPlayBtn');
    if (playButton) playButton.onclick = () => {
      if (!sim.plan?.executable) return;
      if (sim.progress >= 1) resetSimulation(0);
      sim.running = true;
    };
    const pauseButton = $('simPauseBtn');
    if (pauseButton) pauseButton.onclick = () => { sim.running = false; updateToolAndTelemetry(); };
    const resetButton = $('simResetBtn');
    if (resetButton) resetButton.onclick = () => resetSimulation(0);
    const progress = $('simProgressRange');
    if (progress) progress.oninput = event => resetSimulation(Number(event.target.value) / 1000);
    const speed = $('simSpeedRange');
    if (speed) speed.oninput = event => {
      sim.speed = Number(event.target.value);
      if ($('simSpeedValue')) $('simSpeedValue').textContent = `${sim.speed}×`;
    };
    if ($('simPrevStepBtn')) $('simPrevStepBtn').onclick = () => operationStep(-1);
    if ($('simNextStepBtn')) $('simNextStepBtn').onclick = () => operationStep(1);
  }

  function renderPreflight() {
    rebuildPlan();
    renderStockPreview();
  }

  function init3D() {
    if (!$('stock3dViewport')) return;
    rebuildPlan();
    bindSimulationControls();
    if (!sim.plan?.executable) {
      const fallback = $('simFallback');
      if (fallback) fallback.textContent = '3D не запускается: CAM-план заблокирован проверками входных данных.';
      return;
    }
    sim.progress = Number($('simProgressRange')?.value || 0) / 1000;
    if (setupScene()) {
      const fallback = $('simFallback');
      fallback?.classList.add('hidden');
      updateToolAndTelemetry();
    }
  }

  window.CNC_CAM_currentPlan = () => sim.plan;
  window.CNC_CAM_renderPreflight = renderPreflight;
  window.CNC3D_init = init3D;
  window.CNC3D_canConfirm = () => Boolean(sim.plan?.executable && sim.progress >= 1);
  window.CNC3D_diagnostics = () => ({
    planStatus: sim.plan?.status || null,
    executable: Boolean(sim.plan?.executable),
    operations: sim.plan?.operations.length || 0,
    moves: sim.plan?.moves.length || 0,
    rapidSegments: sim.plan?.moves.filter(move => !move.cutting).length || 0,
    cuttingSegments: sim.plan?.moves.filter(move => move.cutting).length || 0,
    progress: sim.progress,
    materialVolume: sim.currentVolume,
    renderer: Boolean(sim.renderer),
    collisionStatus: sim.plan?.collision.status || null,
    collisionCount: sim.plan?.collision.collisions?.length || 0,
    postprocessorStatus: sim.plan?.postprocessor.status || null,
    threadSegments: sim.plan?.moves.filter(move => move.cutKind === 'thread_external').length || 0,
    drillSegments: sim.plan?.moves.filter(move => move.cutKind === 'drill_axial').length || 0,
    afSegments: sim.plan?.moves.filter(move => move.cutKind === 'mill_af').length || 0,
    cIndexSegments: sim.plan?.moves.filter(move => move.motion === 'index').length || 0,
  });

  window.addEventListener('cnc-cam-stage-ready', () => setTimeout(renderPreflight, 0));
  window.addEventListener('cnc-simulation-stage-ready', () => setTimeout(init3D, 0));
  window.addEventListener('cnc-cam-engine-ready', () => {
    if ($('stockCanvas')) renderPreflight();
    if ($('stock3dViewport')) init3D();
  });
})();
