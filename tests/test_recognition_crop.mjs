import {
  normalizeRecognitionCrop,
  recognitionCropFromPoints,
  recognitionCropLabel,
  renderedImageRect,
} from '../app/static/recognition-crop.mjs';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const tests = [];
function run(name, fn) { fn(); tests.push(name); }

run('normalizes and clamps recognition coordinates', () => {
  const crop = normalizeRecognitionCrop({ active: true, x: 0.8, y: 0.7, width: 0.5, height: 0.6 });
  assert(crop.x === 0.8 && crop.y === 0.7, JSON.stringify(crop));
  assert(Math.abs(crop.width - 0.2) < 1e-9 && Math.abs(crop.height - 0.3) < 1e-9, JSON.stringify(crop));
});

run('builds the same crop for reverse drag direction', () => {
  const crop = recognitionCropFromPoints({ x: 0.75, y: 0.8 }, { x: 0.2, y: 0.1 });
  assert(Math.abs(crop.x - 0.2) < 1e-9 && Math.abs(crop.y - 0.1) < 1e-9, JSON.stringify(crop));
  assert(Math.abs(crop.width - 0.55) < 1e-9 && Math.abs(crop.height - 0.7) < 1e-9, JSON.stringify(crop));
});

run('maps the crop surface to the object-fit contain image', () => {
  const wide = renderedImageRect(800, 600, 1024, 768);
  assert(wide.left === 0 && wide.top === 0 && wide.width === 800 && wide.height === 600, JSON.stringify(wide));
  const letterboxed = renderedImageRect(800, 600, 1600, 600);
  assert(letterboxed.left === 0 && letterboxed.top === 150 && letterboxed.width === 800 && letterboxed.height === 300, JSON.stringify(letterboxed));
});

run('reports pixel dimensions for operator feedback', () => {
  const label = recognitionCropLabel({ active: true, x: 0.1, y: 0.2, width: 0.5, height: 0.25 }, 1024, 768);
  assert(label.includes('50×25%') && label.includes('512×192 px'), label);
});

run('full drawing produces no crop payload', () => {
  assert(normalizeRecognitionCrop({ active: false, x: 0, y: 0, width: 1, height: 1 }) === null, 'full drawing should not be cropped');
});

console.log(JSON.stringify({ passed: tests.length, tests }, null, 2));
