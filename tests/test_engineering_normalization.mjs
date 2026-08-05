import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../app/static/app.js', import.meta.url), 'utf8');
const prefix = src.slice(0, src.indexOf('\nasync function buildDynamicGeometry'));
const classList = { toggle() {}, add() {}, remove() {} };
const sandbox = {
  console,
  Blob,
  URL,
  window: { addEventListener() {} },
  document: {
    documentElement: { dataset: {} },
    body: { classList, appendChild() {} },
    getElementById() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    addEventListener() {},
  },
  localStorage: { getItem() { return null; }, setItem() {} },
  matchMedia() { return { matches: false, addEventListener() {} }; },
  setTimeout,
  clearTimeout,
  fetch: async () => ({}),
  alert() {},
};
vm.createContext(sandbox);
vm.runInContext(prefix, sandbox);
const intelligence = {
  part_name: 'Ролик', quantity: 28, material: 'PE 500', blank_diameter: 60, blank_diameter_exact: true, blank_diameter_source: 'drawing_profile', radial_stock_allowance: 0, overall_length: 30,
  thread_applicable: false, drilling_applicable: true, drilling_diameter: 12.2, drilling_depth: 30, af_applicable: false,
  chamfers: [{ designation: '1×45°' }],
  tolerance_summary: 'H14 — внутренние размеры/отверстия; h14 — наружные размеры/валы; ±IT14/2 — остальные линейные размеры.',
  recommended_stock_mode: 'lathe',
  recognized_dimensions: { body_diameter: 50, through_bore: 12.2, counterbore_diameter: 30, counterbore_depth: 8, small_bore_length: 22, outer_radius: 3.5 },
  axial_segments: [
    { key: 'counterboreDepth', name: 'Расточка Ø30', length: 8 },
    { key: 'smallBoreLength', name: 'Отверстие Ø12,2 до уступа', length: 22 },
  ],
  dimension_chain: { overall: 30, matches: true },
};
vm.runInContext(`applyIntelligence(${JSON.stringify(intelligence)}, '')`, sandbox);
const result = vm.runInContext('({fields:state.fields,chain:chainData()})', sandbox);
assert.equal(result.fields.material, 'PE 500');
assert.equal(result.fields.thread, 'Не применяется');
assert.equal(result.fields.af, 'Не применяется');
assert.equal(result.fields.chamfer, '1×45°');
assert.equal(result.chain.label, '8 + 22 = 30 мм');
assert.equal(result.chain.matches, true);
console.log('PASS engineering normalization: DPK-5.02.103');
const safety = vm.runInContext('({stock:state.stock,applicability:state.applicability,camFeatures:state.camFeatures,stockHtml:stockStage(),camHtml:(state.step=4,afStage())})', sandbox);
assert.equal(safety.stock.allowanceD, '0');
assert.equal(safety.stock.blankDiameterExact, true);
assert.equal(safety.stock.drawingBlankDiameter, '60');
assert.equal(safety.applicability.thread, false);
assert.equal(safety.applicability.af, false);
assert.equal(safety.applicability.drilling, true);
assert.equal(safety.camFeatures.threading.enabled, false);
assert.equal(safety.camFeatures.millingAf.enabled, false);
assert.equal(safety.camFeatures.drilling.enabled, false);
assert.equal(safety.camFeatures.drilling.suggestedDiameter, '12.2');
assert.equal(safety.camFeatures.drilling.suggestedDepth, '30');
assert.match(safety.stockHtml, /Ø60/);
assert.match(safety.stockHtml, /readonly/);
assert.match(safety.camHtml, /На текущем чертеже резьба отсутствует/);
assert.match(safety.camHtml, /На чертеже нет AF/);
assert.doesNotMatch(safety.camHtml, /AF13/);
console.log('PASS CAM safety: exact stock, no phantom thread/AF, drilling suggestion only');
