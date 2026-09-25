// Reads the 10x20 board, NEXT queue and HOLD from a screenshot, in device pixels. The default
// geometry below is replaced by Vision.detectFrame() for the real window.
const { PNG } = require('pngjs');
const { identifyPiece } = require('./pieces.js');

const DEFAULT_CAL = {
  screenshotW: 3206, screenshotH: 1606,
  fieldLeft: 1323, fieldRight: 1882,   // inner edges of the frame
  fieldBottom: 1360,                    // inner edge just above the bottom border
  cols: 10, rows: 20,
  // NEXT queue: 5 vertical slots to the right of the field. y-centers + x scan window.
  nextSlotY: [380, 547, 714, 881, 1048],
  nextX0: 1955, nextX1: 2245,
  // HOLD preview box (top-left of field).
  holdX0: 1035, holdX1: 1300, holdY0: 300, holdY1: 545,
};

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d + 6) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

// Classify a mino colour into a piece letter by hue. Returns null if not a solid mino.
function classifyMino({ h, s, v }) {
  if (v < 0.30 || s < 0.42) return null; // empty / grid / ghost / watermark
  if (h >= 45 && h < 70) return 'O';   // yellow
  if (h >= 70 && h < 165) return 'S';  // green
  if (h >= 165 && h < 205) return 'I'; // cyan
  if (h >= 205 && h < 255) return 'J'; // blue
  if (h >= 255 && h < 320) return 'T'; // purple/magenta
  if (h >= 320 || h < 15) return 'Z';  // red
  if (h >= 15 && h < 45) return 'L';   // orange
  return null;
}

class Vision {
  constructor(cal = DEFAULT_CAL) { this.setCal(cal); }

  setCal(cal) {
    this.cal = cal;
    this.colW = (cal.fieldRight - cal.fieldLeft) / cal.cols;
    this.rowH = this.colW; // square cells
    this.fieldTop = cal.fieldBottom - cal.rows * this.rowH;
    // Derive NEXT/HOLD regions from field geometry when not explicitly provided,
    // so they scale automatically with a re-detected frame.
    const cw = this.colW, L = cal.fieldLeft, R = cal.fieldRight, T = this.fieldTop;
    this.next = {
      x0: cal.nextX0 ?? Math.round(R + 1.3 * cw),
      x1: cal.nextX1 ?? Math.round(R + 6.5 * cw),
      slotY: cal.nextSlotY ?? [0,1,2,3,4].map(i => Math.round(T + (2.34 + i * 2.97) * cw)),
      slotH: Math.round(2.6 * cw),
    };
    this.hold = {
      x0: cal.holdX0 ?? Math.round(L - 4.9 * cw),
      x1: cal.holdX1 ?? Math.round(L - 0.7 * cw),
      y0: cal.holdY0 ?? Math.round(T + 1.2 * cw),
      y1: cal.holdY1 ?? Math.round(T + 3.9 * cw),
    };
  }

  cellCenter(col, row) {
    return {
      x: Math.round(this.cal.fieldLeft + (col + 0.5) * this.colW),
      y: Math.round(this.fieldTop + (row + 0.5) * this.rowH),
    };
  }

  // Sample a small patch and return the dominant HSV (median of brightness-sorted samples).
  _samplePatch(png, cx, cy, rad = 6) {
    const { width: W, height: H, data } = png;
    const px = [];
    for (let dy = -rad; dy <= rad; dy += 3) {
      for (let dx = -rad; dx <= rad; dx += 3) {
        const x = cx + dx, y = cy + dy;
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4;
        px.push([data[i], data[i + 1], data[i + 2]]);
      }
    }
    if (!px.length) return { h: 0, s: 0, v: 0 };
    // Average the middle brightness band (40..75%): a mino is evenly bright, while an empty
    // cell over the starfield is dark with a few bright specks.
    px.sort((a, b) => (b[0] + b[1] + b[2]) - (a[0] + a[1] + a[2]));
    const lo = Math.floor(px.length * 0.25), hi = Math.max(lo + 1, Math.ceil(px.length * 0.6));
    let r = 0, g = 0, b = 0, n = 0;
    for (let k = lo; k < hi; k++) { r += px[k][0]; g += px[k][1]; b += px[k][2]; n++; }
    return rgbToHsv(r / n, g / n, b / n);
  }

  // Read the full 10x20 board. Returns { grid: rows[20][10] of letter|null, filled: bool[20][10] }
  readBoard(pngBuf) {
    const png = Buffer.isBuffer(pngBuf) ? PNG.sync.read(pngBuf) : pngBuf;
    const grid = [], filled = [];
    for (let row = 0; row < this.cal.rows; row++) {
      const gRow = [], fRow = [];
      for (let col = 0; col < this.cal.cols; col++) {
        const { x, y } = this.cellCenter(col, row);
        const hsv = this._samplePatch(png, x, y);
        const letter = classifyMino(hsv);
        gRow.push(letter);
        fRow.push(letter !== null);
      }
      grid.push(gRow); filled.push(fRow);
    }
    return { grid, filled };
  }

  static asciiBoard(filled, grid) {
    return filled.map((r, y) => r.map((f, x) => f ? (grid ? grid[y][x] : '#') : '.').join('')).join('\n');
  }

  // ZEN's LEVEL COMPLETE effect rotates the entire field even with shake/bounce
  // disabled. Its large bright-yellow text spans the center AND the field margins.
  // Requiring pixels outside the field excludes ordinary O minos and yellow stacks.
  readLevelTransition(pngBuf) {
    const im = Buffer.isBuffer(pngBuf) ? PNG.sync.read(pngBuf) : pngBuf;
    const cw = this.colW, step = Math.max(1, Math.floor(cw / 8));
    const left = this.cal.fieldLeft, right = this.cal.fieldRight;
    let count = 0, outside = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (let y = Math.max(0, Math.round(this.fieldTop + 6 * cw)); y < Math.min(im.height, this.fieldTop + 13 * cw); y += step) {
      for (let x = Math.max(0, Math.round(left - cw)); x < Math.min(im.width, right + cw); x += step) {
        const i = (y * im.width + x) * 4;
        const h = rgbToHsv(im.data[i], im.data[i + 1], im.data[i + 2]);
          // The text fades to pale yellow (measured saturation ~0.45) before the
          // board rotates away. Spatial coverage outside the field rejects O minos.
          if (h.h < 40 || h.h > 70 || h.s < 0.35 || h.v < 0.75) continue;
        count++;
        if (x < left || x > right) outside++;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    const samplesPerCell = (cw / step) ** 2;
    return count >= samplesPerCell * 2 && outside >= Math.max(4, samplesPerCell * 0.1) &&
      maxX - minX >= cw * 7 && maxY - minY >= cw * 1.5;
  }

  // Identify a single piece inside a rectangular region. Builds a coarse saturated mask,
  // isolates the LARGEST connected blob (rejecting stray nebula pixels), quantizes it to a
  // grid at the local cell size, and shape-matches. Returns letter|null.
  _readPieceInRegion(png, x0, x1, y0, y1) {
    const { width: W, data } = png;
    const isSat = (x, y) => { const i=(y*W+x)*4; const {s,v}=rgbToHsv(data[i],data[i+1],data[i+2]); return v>0.30 && s>0.32; };
    x0 = Math.max(0, x0|0); y0 = Math.max(0, y0|0);
    const STEP = 3;
    const gw = Math.ceil((x1 - x0) / STEP), gh = Math.ceil((y1 - y0) / STEP);
    if (gw <= 0 || gh <= 0) return null;
    const mask = new Uint8Array(gw * gh);
    let any = 0;
    for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
      const x = x0 + gx * STEP, y = y0 + gy * STEP;
      if (x < W && isSat(x, y)) { mask[gy * gw + gx] = 1; any++; }
    }
    if (any < 15) return null; // empty region
    // Largest 4-connected blob in the mask.
    const seen = new Uint8Array(gw * gh);
    let best = null;
    for (let s = 0; s < mask.length; s++) {
      if (!mask[s] || seen[s]) continue;
      const stack = [s]; seen[s] = 1; const cells = [];
      let mnx = gw, mxx = 0, mny = gh, mxy = 0;
      while (stack.length) {
        const p = stack.pop(); const px = p % gw, py = (p / gw) | 0;
        cells.push(p);
        if (px < mnx) mnx = px; if (px > mxx) mxx = px; if (py < mny) mny = py; if (py > mxy) mxy = py;
        const nb = [p-1, p+1, p-gw, p+gw];
        if (px > 0 && mask[p-1] && !seen[p-1]) { seen[p-1]=1; stack.push(p-1); }
        if (px < gw-1 && mask[p+1] && !seen[p+1]) { seen[p+1]=1; stack.push(p+1); }
        if (py > 0 && mask[p-gw] && !seen[p-gw]) { seen[p-gw]=1; stack.push(p-gw); }
        if (py < gh-1 && mask[p+gw] && !seen[p+gw]) { seen[p+gw]=1; stack.push(p+gw); }
      }
      if (!best || cells.length > best.cells.length) best = { cells, mnx, mxx, mny, mxy };
    }
    if (!best || best.cells.length < 6) return null;
    // Blob bbox in screenshot pixels.
    const bx0 = x0 + best.mnx * STEP, bx1 = x0 + best.mxx * STEP;
    const by0 = y0 + best.mny * STEP, by1 = y0 + best.mxy * STEP;
    const bw = bx1 - bx0, bh = by1 - by0;
    // Local cell size: preview minos are ~field cell size; derive robustly from bbox.
    const cell = this.colW;
    let nCols = Math.min(4, Math.max(1, Math.round(bw / cell)));
    let nRows = Math.min(4, Math.max(1, Math.round(bh / cell)));
    // Sample each subcell centre against the blob mask.
    const cw = bw / nCols, ch = bh / nRows;
    const cells = [];
    for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) {
      const scx = Math.round(bx0 + (c + 0.5) * cw), scy = Math.round(by0 + (r + 0.5) * ch);
      let hit = 0, tot = 0;
      for (let dy = -5; dy <= 5; dy += 2) for (let dx = -5; dx <= 5; dx += 2) {
        const xx = scx + dx, yy = scy + dy; if (xx < 0 || yy < 0 || xx >= W) continue; tot++; if (isSat(xx, yy)) hit++;
      }
      if (tot && hit / tot > 0.45) cells.push([c, r]);
    }
    return identifyPiece(cells);
  }

  // Read the 5-piece NEXT queue (index 0 = next to spawn). Returns array of letter|null.
  readQueue(pngBuf) {
    const png = Buffer.isBuffer(pngBuf) ? PNG.sync.read(pngBuf) : pngBuf;
    const half = Math.round(this.next.slotH / 2);
    return this.next.slotY.map(cy =>
      this._readPieceInRegion(png, this.next.x0, this.next.x1, cy - half, cy + half));
  }

  // Read the HOLD piece. Returns letter|null (null = empty hold).
  readSpawnPiece(pngBuf) {
    const png = Buffer.isBuffer(pngBuf) ? PNG.sync.read(pngBuf) : pngBuf;
    // ZEN can keep a fresh piece entirely ABOVE the visible 20 rows after a
    // level transition. Do not mistake an absent visible piece for a stuck game.
    return this._readPieceInRegion(png, this.cal.fieldLeft + 2.5 * this.colW,
      this.cal.fieldLeft + 7.5 * this.colW, this.fieldTop - 2.5 * this.colW, this.fieldTop);
  }

  readHold(pngBuf) {
    const png = Buffer.isBuffer(pngBuf) ? PNG.sync.read(pngBuf) : pngBuf;
    return this._readPieceInRegion(png, this.hold.x0, this.hold.x1, this.hold.y0, this.hold.y1);
  }

  // Fingerprint of the big stage number under the field (thresholded pixels, not OCR).
  // Compare two with stageChanged().
  stageFingerprint(pngBuf) {
    const png = Buffer.isBuffer(pngBuf) ? PNG.sync.read(pngBuf) : pngBuf;
    const { width: W, height: H, data } = png;
    const cw = this.colW;
    const cx = (this.cal.fieldLeft + this.cal.fieldRight) / 2;
    // Tight box around the big stage number only (below the score line, above the icons).
    const y0 = this.cal.fieldBottom + 1.05 * cw;
    const y1 = this.cal.fieldBottom + 2.0 * cw;
    const x0 = cx - 1.9 * cw, x1 = cx + 1.9 * cw;
    const GX = 48, GY = 12;
    const bits = new Uint8Array(GX * GY);
    let white = 0;
    for (let gy = 0; gy < GY; gy++) for (let gx = 0; gx < GX; gx++) {
      const x = Math.round(x0 + (gx + 0.5) * (x1 - x0) / GX);
      const y = Math.round(y0 + (gy + 0.5) * (y1 - y0) / GY);
      if (x < 0 || y < 0 || x >= W || y >= H) continue;
      const i = (y * W + x) * 4;
      // Pure-white glyph threshold (>=225 on all channels) — the number is solid white;
      // background stars/nebula are dimmer/coloured and are rejected.
      const b = data[i] >= 225 && data[i+1] >= 225 && data[i+2] >= 225 ? 1 : 0;
      bits[gy * GX + gx] = b; white += b;
    }
    return { bits, white };
  }

  static stageChanged(a, b, frac = 0.12) {
    if (!a || !b) return false;
    let diff = 0;
    for (let i = 0; i < a.bits.length; i++) if (a.bits[i] !== b.bits[i]) diff++;
    return diff / a.bits.length > frac;
  }

  // Finds the field in a screenshot of any size: its borders are the tallest vertical white lines.
  static detectFrame(pngBuf) {
    const png = Buffer.isBuffer(pngBuf) ? PNG.sync.read(pngBuf) : pngBuf;
    const { width: W, height: H, data } = png;
    const isWhite = (x, y) => { const i = (y * W + x) * 4; const r = data[i], g = data[i+1], b = data[i+2]; return r>185&&g>185&&b>185&&Math.abs(r-g)<32&&Math.abs(g-b)<32; };
    // Longest contiguous vertical white run per column, in the central band.
    const cx0 = Math.floor(W * 0.28), cx1 = Math.ceil(W * 0.72);
    const runLen = new Int32Array(W), runTop = new Int32Array(W), runBot = new Int32Array(W);
    for (let x = cx0; x < cx1; x++) {
      let cur = 0, curTop = 0, best = 0, bTop = 0, bBot = 0;
      for (let y = 0; y < H; y++) {
        if (isWhite(x, y)) { if (cur === 0) curTop = y; cur++; if (cur > best) { best = cur; bTop = curTop; bBot = y; } }
        else cur = 0;
      }
      runLen[x] = best; runTop[x] = bTop; runBot[x] = bBot;
    }
    let maxRun = 0; for (let x = cx0; x < cx1; x++) if (runLen[x] > maxRun) maxRun = runLen[x];
    if (maxRun < H * 0.12) throw new Error('frame detect failed: no tall vertical border (maxRun ' + maxRun + ')');
    // Cluster adjacent tall columns into border candidates.
    const thr = maxRun * 0.85;
    const clusters = [];
    for (let x = cx0; x < cx1; x++) {
      if (runLen[x] >= thr) {
        const last = clusters[clusters.length - 1];
        if (last && x - last.end <= 4) { last.end = x; if (runLen[x] > last.run) { last.run = runLen[x]; last.rep = x; } }
        else clusters.push({ start: x, end: x, run: runLen[x], rep: x });
      }
    }
    if (clusters.length < 2) throw new Error('frame detect failed: found ' + clusters.length + ' border cluster(s)');
    // NEXT/HOLD boxes have borders too; pick the pair that makes square 10x20 cells.
    let best = null;
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) {
      const L = clusters[i], R = clusters[j];
      const width = (R.start - 1) - (L.end + 1);
      if (width < 40) continue;
      const cellW = width / 10;
      const cellH = Math.min(L.run, R.run) / 20;
      const err = Math.abs(cellW - cellH) / cellH;
      if (!best || err < best.err) best = { L, R, err };
    }
    if (!best || best.err > 0.25) throw new Error('frame detect failed: no square-cell border pair (err ' + (best ? best.err.toFixed(2) : 'n/a') + ')');
    const fieldLeft = best.L.end + 1;
    const fieldRight = best.R.start - 1;
    const fieldBottom = Math.min(runBot[best.L.rep], runBot[best.R.rep]); // inner bottom of the frame
    return { screenshotW: W, screenshotH: H, fieldLeft, fieldRight, fieldBottom, cols: 10, rows: 20 };
  }
}

module.exports = { Vision, classifyMino, rgbToHsv, DEFAULT_CAL };
