// Names a tetromino from the shape of its cells, in any rotation. Colour alone can't tell
// I from S: both are green-ish in TETR.IO's default skin.

const CANON = {
  I: [[0,0],[1,0],[2,0],[3,0]],
  O: [[0,0],[1,0],[0,1],[1,1]],
  T: [[1,0],[0,1],[1,1],[2,1]],
  S: [[1,0],[2,0],[0,1],[1,1]],
  Z: [[0,0],[1,0],[1,1],[2,1]],
  J: [[0,0],[0,1],[1,1],[2,1]],
  L: [[2,0],[0,1],[1,1],[2,1]],
};

function normalize(cells) {
  const minC = Math.min(...cells.map(c => c[0]));
  const minR = Math.min(...cells.map(c => c[1]));
  return cells.map(([c, r]) => [c - minC, r - minR]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}
function key(cells) { return normalize(cells).map(c => c.join(',')).join(';'); }

// rotate a normalized cell set 90deg CW: (c,r) -> (maxR - r, c)
function rotCW(cells) {
  const maxR = Math.max(...cells.map(c => c[1]));
  return cells.map(([c, r]) => [maxR - r, c]);
}

// Precompute every rotation footprint -> letter
const SHAPE_TABLE = (() => {
  const table = new Map();
  for (const [letter, base] of Object.entries(CANON)) {
    let cur = base;
    for (let i = 0; i < 4; i++) {
      table.set(key(cur), letter);
      cur = rotCW(cur);
    }
  }
  return table;
})();

// Identify a 4-cell blob. cells: array of [col,row]. Returns letter or null.
function identifyPiece(cells) {
  if (!cells || cells.length !== 4) return null;
  return SHAPE_TABLE.get(key(cells)) || null;
}

// 4-connected components of a boolean grid (rows[y][x]); returns array of {cells:[[x,y]..], size}
function connectedComponents(filled) {
  const H = filled.length, W = filled[0].length;
  const seen = Array.from({ length: H }, () => new Array(W).fill(false));
  const comps = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!filled[y][x] || seen[y][x]) continue;
    const stack = [[x, y]], cells = [];
    seen[y][x] = true;
    while (stack.length) {
      const [cx, cy] = stack.pop();
      cells.push([cx, cy]);
      for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx>=0&&ny>=0&&nx<W&&ny<H&&filled[ny][nx]&&!seen[ny][nx]) { seen[ny][nx]=true; stack.push([nx,ny]); }
      }
    }
    comps.push({ cells, size: cells.length, minRow: Math.min(...cells.map(c=>c[1])) });
  }
  return comps;
}

// Separates the falling piece from the locked stack: the topmost group of cells, if it floats
// above everything else. Right after spawn only part of it is visible, so 1-4 cells count; the
// letter is named only when all 4 are visible (otherwise the caller relies on queue tracking).
// Returns { piece: {letter|null, cells, partial}|null, stackFilled }.
function extractCurrentPiece(filled) {
  const comps = connectedComponents(filled);
  if (!comps.length) return { piece: null, stackFilled: filled };
  const sorted = comps.slice().sort((a, b) => a.minRow - b.minRow);
  const top = sorted[0];
  const maxRowOfTop = Math.max(...top.cells.map(c => c[1]));
  // Is the top component floating above everything else?
  let restMinRow = Infinity;
  for (let i = 1; i < sorted.length; i++) restMinRow = Math.min(restMinRow, sorted[i].minRow);
  const floating = sorted.length === 1 ? true : (restMinRow - maxRowOfTop >= 1);
  // Small, floating, and in the upper part of the field: the AI keeps the stack low, so
  // nothing else floats up there.
  if (top.size <= 4 && floating && top.minRow <= 12) {
    const letter = top.size === 4 ? identifyPiece(top.cells) : null;
    const stackFilled = filled.map(r => r.slice());
    for (const [x, y] of top.cells) stackFilled[y][x] = false;
    return { piece: { letter, cells: top.cells, partial: top.size < 4 }, stackFilled };
  }
  return { piece: null, stackFilled: filled };
}

module.exports = { identifyPiece, connectedComponents, extractCurrentPiece, CANON, key, normalize };
