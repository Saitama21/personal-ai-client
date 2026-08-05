const clamp = value => Math.max(0, Math.min(1, Number(value) || 0));

export function normalizeRecognitionCrop(value) {
  if (!value || value.active === false) return null;
  const x = clamp(value.x);
  const y = clamp(value.y);
  const width = Math.max(0, Math.min(1 - x, Number(value.width) || 0));
  const height = Math.max(0, Math.min(1 - y, Number(value.height) || 0));
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

export function recognitionCropFromPoints(start, end) {
  const ax = clamp(start?.x);
  const ay = clamp(start?.y);
  const bx = clamp(end?.x);
  const by = clamp(end?.y);
  return {
    x: Math.min(ax, bx),
    y: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

export function renderedImageRect(frameWidth, frameHeight, naturalWidth, naturalHeight) {
  const fw = Math.max(0, Number(frameWidth) || 0);
  const fh = Math.max(0, Number(frameHeight) || 0);
  const nw = Math.max(0, Number(naturalWidth) || 0);
  const nh = Math.max(0, Number(naturalHeight) || 0);
  if (!fw || !fh || !nw || !nh) return { left: 0, top: 0, width: fw, height: fh };
  const scale = Math.min(fw / nw, fh / nh);
  const width = nw * scale;
  const height = nh * scale;
  return { left: (fw - width) / 2, top: (fh - height) / 2, width, height };
}

export function recognitionCropLabel(crop, naturalWidth = 0, naturalHeight = 0) {
  const normalized = normalizeRecognitionCrop(crop);
  if (!normalized) return 'Распознаётся весь чертёж';
  const widthPercent = Math.round(normalized.width * 100);
  const heightPercent = Math.round(normalized.height * 100);
  const pixelWidth = Math.round(normalized.width * naturalWidth);
  const pixelHeight = Math.round(normalized.height * naturalHeight);
  const pixels = pixelWidth > 0 && pixelHeight > 0 ? ` · ${pixelWidth}×${pixelHeight} px` : '';
  return `Выделенная область ${widthPercent}×${heightPercent}%${pixels}`;
}

export class RecognitionCropController {
  constructor({ frame, image, surface, selection, status, initialCrop, onCommit, onClear }) {
    this.frame = frame;
    this.image = image;
    this.surface = surface;
    this.selection = selection;
    this.status = status;
    this.onCommit = onCommit;
    this.onClear = onClear;
    this.crop = normalizeRecognitionCrop(initialCrop);
    this.draft = null;
    this.start = null;
    this.pointerId = null;
    this.layout = this.layout.bind(this);
    this.pointerDown = this.pointerDown.bind(this);
    this.pointerMove = this.pointerMove.bind(this);
    this.pointerUp = this.pointerUp.bind(this);
    this.image.addEventListener('load', this.layout);
    this.surface.addEventListener('pointerdown', this.pointerDown);
    this.surface.addEventListener('pointermove', this.pointerMove);
    this.surface.addEventListener('pointerup', this.pointerUp);
    this.surface.addEventListener('pointercancel', this.pointerUp);
    this.resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(this.layout) : null;
    this.resizeObserver?.observe(this.frame);
    this.layout();
  }

  layout() {
    const rect = renderedImageRect(
      this.frame.clientWidth,
      this.frame.clientHeight,
      this.image.naturalWidth,
      this.image.naturalHeight,
    );
    Object.assign(this.surface.style, {
      left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`,
    });
    this.render(this.draft || this.crop);
  }

  point(event) {
    const rect = this.surface.getBoundingClientRect();
    return {
      x: clamp((event.clientX - rect.left) / Math.max(1, rect.width)),
      y: clamp((event.clientY - rect.top) / Math.max(1, rect.height)),
    };
  }

  pointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    event.preventDefault();
    this.pointerId = event.pointerId;
    this.surface.setPointerCapture?.(event.pointerId);
    this.start = this.point(event);
    this.draft = { x: this.start.x, y: this.start.y, width: 0, height: 0 };
    this.render(this.draft);
  }

  pointerMove(event) {
    if (this.pointerId !== event.pointerId || !this.start) return;
    event.preventDefault();
    this.draft = recognitionCropFromPoints(this.start, this.point(event));
    this.render(this.draft);
  }

  pointerUp(event) {
    if (this.pointerId !== event.pointerId || !this.start) return;
    event.preventDefault();
    const candidate = recognitionCropFromPoints(this.start, this.point(event));
    this.surface.releasePointerCapture?.(event.pointerId);
    this.pointerId = null;
    this.start = null;
    this.draft = null;
    const pixelWidth = candidate.width * this.image.naturalWidth;
    const pixelHeight = candidate.height * this.image.naturalHeight;
    if (candidate.width < 0.02 || candidate.height < 0.02 || pixelWidth < 8 || pixelHeight < 8) {
      this.render(this.crop);
      if (this.status) this.status.textContent = 'Область слишком мала — выделите рамку крупнее';
      return;
    }
    this.crop = candidate;
    this.render(this.crop);
    this.onCommit?.({
      active: true,
      ...candidate,
      sourceWidth: this.image.naturalWidth,
      sourceHeight: this.image.naturalHeight,
    });
  }

  render(crop) {
    const normalized = normalizeRecognitionCrop(crop);
    if (!normalized) {
      this.selection.hidden = true;
      if (this.status) this.status.textContent = recognitionCropLabel(null);
      return;
    }
    this.selection.hidden = false;
    Object.assign(this.selection.style, {
      left: `${normalized.x * 100}%`, top: `${normalized.y * 100}%`,
      width: `${normalized.width * 100}%`, height: `${normalized.height * 100}%`,
    });
    if (this.status) this.status.textContent = recognitionCropLabel(normalized, this.image.naturalWidth, this.image.naturalHeight);
  }

  clear() {
    this.crop = null;
    this.draft = null;
    this.render(null);
    this.onClear?.();
  }

  destroy() {
    this.resizeObserver?.disconnect();
    this.image.removeEventListener('load', this.layout);
    this.surface.removeEventListener('pointerdown', this.pointerDown);
    this.surface.removeEventListener('pointermove', this.pointerMove);
    this.surface.removeEventListener('pointerup', this.pointerUp);
    this.surface.removeEventListener('pointercancel', this.pointerUp);
  }
}
