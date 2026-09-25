'use strict';

// Board model: SRS piece shapes and spawn positions, hard drop, line clears, and the features
// the AI scores. Pure and deterministic.

const WIDTH = 10;
const HEIGHT = 24; // internal rows; top HIDDEN rows are the spawn area
const HIDDEN = 4;  // rows 0..3 hidden, rows 4..23 = visible 20 rows
const FULL_ROW = (1 << WIDTH) - 1; // 0b1111111111
// Pieces spawn in the two rows just above the visible field.
const SPAWN_ROW = HIDDEN - 2;

const PIECE_NAMES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

// Spawn shapes as [x, y] offsets in the bounding box (y = 0 is its top row). spawnCol is the
// board column of the box's left edge at spawn.
const SPAWN_DATA = {
  I: { size: 4, cells: [[0, 1], [1, 1], [2, 1], [3, 1]], spawnCol: 3 },
  O: { size: 3, cells: [[1, 0], [2, 0], [1, 1], [2, 1]], spawnCol: 3 },
  T: { size: 3, cells: [[1, 0], [0, 1], [1, 1], [2, 1]], spawnCol: 3 },
  S: { size: 3, cells: [[1, 0], [2, 0], [0, 1], [1, 1]], spawnCol: 3 },
  Z: { size: 3, cells: [[0, 0], [1, 0], [1, 1], [2, 1]], spawnCol: 3 },
  J: { size: 3, cells: [[0, 0], [0, 1], [1, 1], [2, 1]], spawnCol: 3 },
  L: { size: 3, cells: [[2, 0], [0, 1], [1, 1], [2, 1]], spawnCol: 3 },
};

// Rotate bbox contents clockwise: (x, y) -> (N-1-y, x).
function rotateCellsCW(cells, size) {
  return cells.map(([x, y]) => [size - 1 - y, x]);
}

function sortCells(cells) {
  return cells
    .slice()
    .sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
}

// The four SRS rotation states of each piece (state r = r clockwise turns from spawn).
// https://tetris.wiki/Super_Rotation_System
const PIECES = {};
for (const name of PIECE_NAMES) {
  const { size, cells, spawnCol } = SPAWN_DATA[name];
  const rotations = [sortCells(cells)];
  for (let r = 1; r < 4; r++) {
    if (name === 'O') {
      rotations.push(sortCells(cells));
    } else {
      rotations.push(sortCells(rotateCellsCW(rotations[r - 1], size)));
    }
  }
  // Precompute per-rotation metadata used by the movement/drop code.
  const meta = rotations.map((rc) => {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x, y] of rc) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    // Lowest cell of each occupied column in the box.
    const bottomByX = new Map();
    for (const [x, y] of rc) {
      const cur = bottomByX.get(x);
      if (cur === undefined || y > cur) bottomByX.set(x, y);
    }
    return { minX, maxX, minY, maxY, bottomByX };
  });
  PIECES[name] = { size, cells: rotations, spawnCol, meta };
}

// Distinct rotation states per piece after deduplicating identical
// (translation-normalized) cell sets: O -> 1, I/S/Z -> 2, T/J/L -> 4.
const DISTINCT_ROTS = {};
for (const name of PIECE_NAMES) {
  const seen = new Set();
  const rots = [];
  for (let r = 0; r < 4; r++) {
    const cells = PIECES[name].cells[r];
    const { minX, minY } = PIECES[name].meta[r];
    const key = sortCells(cells.map(([x, y]) => [x - minX, y - minY]))
      .map((c) => c.join(','))
      .join(';');
    if (!seen.has(key)) {
      seen.add(key);
      rots.push(r);
    }
  }
  DISTINCT_ROTS[name] = rots;
}

class Board {
  constructor(rows) {
    // Bitrow representation: rows[r] is a 10-bit int, bit c set = filled.
    // r = 0 is the TOP (hidden) row, r = HEIGHT-1 the floor row.
    this.rows = rows ? rows.slice() : new Array(HEIGHT).fill(0);
  }

  static get WIDTH() { return WIDTH; }
  static get HEIGHT() { return HEIGHT; }
  static get HIDDEN() { return HIDDEN; }
  static get SPAWN_ROW() { return SPAWN_ROW; }

  // Build from a 20-row x 10-col matrix (vision module output), placed at
  // the bottom of the internal grid; the top HIDDEN rows stay empty.
  static fromMatrix(rows20) {
    if (!Array.isArray(rows20) || rows20.length !== HEIGHT - HIDDEN) {
      throw new Error(`fromMatrix expects ${HEIGHT - HIDDEN} rows`);
    }
    const rows = new Array(HEIGHT).fill(0);
    for (let r = 0; r < rows20.length; r++) {
      const src = rows20[r];
      let bits = 0;
      for (let c = 0; c < WIDTH; c++) {
        if (src[c]) bits |= 1 << c;
      }
      rows[HIDDEN + r] = bits;
    }
    return new Board(rows);
  }

  clone() {
    return new Board(this.rows);
  }

  get(col, row) {
    return (this.rows[row] >> col) & 1;
  }

  set(col, row) {
    this.rows[row] |= 1 << col;
  }

  // True if the piece at (bboxCol, bboxRow) overlaps walls, floor, the
  // (closed) top of the grid, or filled cells.
  collides(pieceName, rot, bboxCol, bboxRow) {
    const cells = PIECES[pieceName].cells[rot & 3];
    const rows = this.rows;
    for (let i = 0; i < 4; i++) {
      const col = bboxCol + cells[i][0];
      const row = bboxRow + cells[i][1];
      if (col < 0 || col >= WIDTH || row < 0 || row >= HEIGHT) return true;
      if ((rows[row] >> col) & 1) return true;
    }
    return false;
  }

  // bboxRow where the piece rests after a hard drop from the top of the
  // grid, or null if even the topmost in-grid position collides.
  dropRow(pieceName, rot, bboxCol) {
    const r = rot & 3;
    const { minY } = PIECES[pieceName].meta[r];
    let row = -minY; // topmost position with every cell inside the grid
    if (this.collides(pieceName, r, bboxCol, row)) return null;
    while (!this.collides(pieceName, r, bboxCol, row + 1)) row++;
    return row;
  }

  // Hard-drop + lock + clear. Returns a NEW board (this is untouched):
  // { board, linesCleared, landingRow, lockedCells, clearedRows } or null.
  place(pieceName, rot, bboxCol) {
    const r = rot & 3;
    const landingRow = this.dropRow(pieceName, r, bboxCol);
    if (landingRow === null) return null;

    const cells = PIECES[pieceName].cells[r];
    const next = this.clone();
    const lockedCells = [];
    for (let i = 0; i < 4; i++) {
      const col = bboxCol + cells[i][0];
      const row = landingRow + cells[i][1];
      next.rows[row] |= 1 << col;
      lockedCells.push([col, row]);
    }

    const clearedRows = [];
    for (let row = 0; row < HEIGHT; row++) {
      if (next.rows[row] === FULL_ROW) clearedRows.push(row);
    }
    if (clearedRows.length > 0) {
      const kept = [];
      for (let row = 0; row < HEIGHT; row++) {
        if (next.rows[row] !== FULL_ROW) kept.push(next.rows[row]);
      }
      while (kept.length < HEIGHT) kept.unshift(0);
      next.rows = kept;
    }

    // lockOut: the piece locked entirely above the field (game over in TETR.IO).
    // toppedOut: part of it locked in the hidden spawn rows (close to game over).
    let hiddenCells = 0;
    for (let i = 0; i < lockedCells.length; i++) {
      if (lockedCells[i][1] < HIDDEN) hiddenCells++;
    }

    return {
      board: next,
      linesCleared: clearedRows.length,
      landingRow,
      lockedCells,
      clearedRows,
      toppedOut: hiddenCells > 0,
      lockOut: hiddenCells === lockedCells.length,
    };
  }

  // Per-column stack height above the floor (0 = empty column).
  heights() {
    const h = new Array(WIDTH).fill(0);
    for (let c = 0; c < WIDTH; c++) {
      for (let r = 0; r < HEIGHT; r++) {
        if ((this.rows[r] >> c) & 1) {
          h[c] = HEIGHT - r;
          break;
        }
      }
    }
    return h;
  }

  // Empty cells with at least one filled cell above in the same column.
  holes() {
    let count = 0;
    for (let c = 0; c < WIDTH; c++) {
      let roof = false;
      for (let r = 0; r < HEIGHT; r++) {
        const filled = (this.rows[r] >> c) & 1;
        if (filled) roof = true;
        else if (roof) count++;
      }
    }
    return count;
  }

  aggregateHeight() {
    const h = this.heights();
    let sum = 0;
    for (let c = 0; c < WIDTH; c++) sum += h[c];
    return sum;
  }

  bumpiness() {
    const h = this.heights();
    let sum = 0;
    for (let c = 0; c < WIDTH - 1; c++) sum += Math.abs(h[c] - h[c + 1]);
    return sum;
  }

  // Horizontal filled/empty transitions; the side walls count as filled.
  rowTransitions() {
    let t = 0;
    for (let r = 0; r < HEIGHT; r++) {
      const bits = this.rows[r];
      let prev = 1; // left wall
      for (let c = 0; c < WIDTH; c++) {
        const cur = (bits >> c) & 1;
        if (cur !== prev) t++;
        prev = cur;
      }
      if (prev !== 1) t++; // right wall
    }
    return t;
  }

  // Vertical transitions; above the grid counts as empty, the floor filled.
  colTransitions() {
    let t = 0;
    for (let c = 0; c < WIDTH; c++) {
      let prev = 0; // above the top: empty
      for (let r = 0; r < HEIGHT; r++) {
        const cur = (this.rows[r] >> c) & 1;
        if (cur !== prev) t++;
        prev = cur;
      }
      if (prev !== 1) t++; // floor: filled
    }
    return t;
  }

  // Dellacherie's cumulative wells: a well d cells deep adds 1 + 2 + ... + d.
  wells() {
    let sum = 0;
    for (let c = 0; c < WIDTH; c++) {
      for (let r = 0; r < HEIGHT; r++) {
        const cur = (this.rows[r] >> c) & 1;
        if (cur) continue;
        const left = c === 0 ? 1 : (this.rows[r] >> (c - 1)) & 1;
        const right = c === WIDTH - 1 ? 1 : (this.rows[r] >> (c + 1)) & 1;
        if (left && right) {
          for (let r2 = r; r2 < HEIGHT && !((this.rows[r2] >> c) & 1); r2++) {
            sum++;
          }
        }
      }
    }
    return sum;
  }

  // Whether the bot's keys can reach this placement: rotate at the spawn position (no wall
  // kicks), slide sideways at spawn height, hard drop. Mirrors computeKeySequence.
  isReachable(pieceName, rot, targetCol) {
    const spawnCol = PIECES[pieceName].spawnCol;
    if (this.collides(pieceName, 0, spawnCol, SPAWN_ROW)) return false;
    const r = rot & 3;
    if (r !== 0 && this.collides(pieceName, r, spawnCol, SPAWN_ROW)) {
      return false;
    }
    const step = targetCol < spawnCol ? -1 : 1;
    for (let col = spawnCol + step;
         step > 0 ? col <= targetCol : col >= targetCol;
         col += step) {
      if (this.collides(pieceName, r, col, SPAWN_ROW)) return false;
    }
    return true;
  }

  // Every distinct placement the keys can reach (see isReachable).
  enumeratePlacements(pieceName) {
    const out = [];
    const piece = PIECES[pieceName];
    if (this.collides(pieceName, 0, piece.spawnCol, SPAWN_ROW)) {
      return out; // real game tops out on spawn: nothing is placeable
    }
    for (const rot of DISTINCT_ROTS[pieceName]) {
      const { minX, maxX } = piece.meta[rot];
      const colMin = -minX;
      const colMax = WIDTH - 1 - maxX;
      for (let col = colMin; col <= colMax; col++) {
        if (!this.isReachable(pieceName, rot, col)) continue;
        const result = this.place(pieceName, rot, col);
        if (result) out.push({ rot, col, result });
      }
    }
    return out;
  }

  toString() {
    const lines = [];
    for (let r = 0; r < HEIGHT; r++) {
      let line = '';
      for (let c = 0; c < WIDTH; c++) {
        line += (this.rows[r] >> c) & 1 ? '#' : '.';
      }
      lines.push(line + (r === HIDDEN - 1 ? ' --' : ''));
    }
    return lines.join('\n');
  }
}

// Keys for a placement: rotate at spawn, tap sideways, hard drop.
function computeKeySequence(pieceName, rot, targetCol) {
  const keys = [];
  const r = ((rot % 4) + 4) % 4;
  if (r === 1) keys.push('cw');
  else if (r === 2) keys.push('180');
  else if (r === 3) keys.push('ccw');
  const delta = targetCol - PIECES[pieceName].spawnCol;
  const tap = delta < 0 ? 'left' : 'right';
  for (let i = 0; i < Math.abs(delta); i++) keys.push(tap);
  keys.push('hard');
  return keys;
}

module.exports = {
  PIECE_NAMES,
  PIECES,
  DISTINCT_ROTS,
  Board,
  computeKeySequence,
  WIDTH,
  HEIGHT,
  HIDDEN,
  SPAWN_ROW,
};
