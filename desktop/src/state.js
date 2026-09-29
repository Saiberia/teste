'use strict';
// Tiny persisted desktop state (panel position, last UI language).
// Lives in userData/desktop-state.json; corrupted files are ignored.

const fs = require('node:fs');
const path = require('node:path');

class DesktopState {
  constructor(file) {
    this.file = file;
    this.data = {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed;
    } catch {
      this.data = {};
    }
    this._timer = null;
  }

  get(key, fallback) {
    return key in this.data ? this.data[key] : fallback;
  }

  set(key, value) {
    this.data[key] = value;
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.flush(), 500);
    if (this._timer.unref) this._timer.unref();
  }

  flush() {
    clearTimeout(this._timer);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch {
      /* best effort */
    }
  }
}

/**
 * Returns `bounds` if at least 80x40 px of it is visible on one of the
 * displays' work areas, otherwise null (e.g. a monitor was unplugged).
 */
function visibleBounds(bounds, workAreas) {
  if (!bounds || !['x', 'y', 'width', 'height'].every((k) => Number.isFinite(bounds[k]))) return null;
  if (bounds.width < 200 || bounds.height < 200) return null;
  for (const a of workAreas || []) {
    const w = Math.min(bounds.x + bounds.width, a.x + a.width) - Math.max(bounds.x, a.x);
    const h = Math.min(bounds.y + bounds.height, a.y + a.height) - Math.max(bounds.y, a.y);
    if (w >= 80 && h >= 40) return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
  }
  return null;
}

/** Default panel position: top-right corner of the primary work area. */
function defaultPanelBounds(workArea, width = 380, height = 560, margin = 16) {
  return {
    x: Math.round(workArea.x + workArea.width - width - margin),
    y: Math.round(workArea.y + margin),
    width,
    height,
  };
}

module.exports = { DesktopState, visibleBounds, defaultPanelBounds };
