'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  PIECE_NAMES,
  PIECES,
  Board,
  computeKeySequence,
} = require('../src/board');

// ---------------------------------------------------------------------------
// Independent source of truth: SRS true-rotation cell tables, hand-written
// from https://tetris.wiki/Super_Rotation_System (y = 0 is the TOP bbox row,
// rotation state r = r clockwise rotations from spawn). NOT imported from
// board.js.
// ---------------------------------------------------------------------------
const SRS_TABLES = {
  I: [
    [[0, 1], [1, 1], [2, 1], [3, 1]],
    [[2, 0], [2, 1], [2, 2], [2, 3]],
    [[0, 2], [1, 2], [2, 2], [3, 2]],
    [[1, 0], [1, 1], [1, 2], [1, 3]],
  ],
  O: [
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [2, 1]],
  ],
  T: [
    [[1, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [1, 2]],
    [[1, 0], [0, 1], [1, 1], [1, 2]],
  ],
  S: [
    [[1, 0], [2, 0], [0, 1], [1, 1]],
    [[1, 0], [1, 1], [2, 1], [2, 2]],
    [[1, 1], [2, 1], [0, 2], [1, 2]],
    [[0, 0], [0, 1], [1, 1], [1, 2]],
  ],
  Z: [
    [[0, 0], [1, 0], [1, 1], [2, 1]],
    [[2, 0], [1, 1], [2, 1], [1, 2]],
    [[0, 1], [1, 1], [1, 2], [2, 2]],
    [[1, 0], [0, 1], [1, 1], [0, 2]],
  ],
  J: [
    [[0, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [2, 0], [1, 1], [1, 2]],
    [[0, 1], [1, 1], [2, 1], [2, 2]],
    [[1, 0], [1, 1], [0, 2], [1, 2]],
  ],
  L: [
    [[2, 0], [0, 1], [1, 1], [2, 1]],
    [[1, 0], [1, 1], [1, 2], [2, 2]],
    [[0, 1], [1, 1], [2, 1], [0, 2]],
    [[0, 0], [1, 0], [1, 1], [1, 2]],
  ],
};

function normalize(cells) {
  return cells
    .map((c) => [c[0], c[1]])
    .sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]));
}

// Build an empty 20x10 visible matrix, optionally mutated by fn(matrix).
function matrix20(fn) {
  const m = [];
  for (let r = 0; r < 20; r++) m.push(new Array(10).fill(0));
  if (fn) fn(m);
  return m;
}

test('SRS cell tables: every piece x rotation matches hand-written tables', () => {
  for (const name of PIECE_NAMES) {
    for (let rot = 0; rot < 4; rot++) {
      assert.deepStrictEqual(
        normalize(PIECES[name].cells[rot]),
        normalize(SRS_TABLES[name][rot]),
        `${name} rot ${rot}`
      );
    }
    assert.strictEqual(PIECES[name].spawnCol, 3, `${name} spawn column`);
  }
});

test('dropRow on empty board lands every piece on the floor', () => {
  const b = new Board();
  // bboxRow such that the lowest cell (max dy) sits on row 23.
  assert.strictEqual(b.dropRow('I', 0, 3), 22); // cells on bbox row 1
  assert.strictEqual(b.dropRow('I', 1, 3), 20); // vertical, rows 0..3
  assert.strictEqual(b.dropRow('O', 0, 3), 22);
  assert.strictEqual(b.dropRow('T', 0, 3), 22);
  assert.strictEqual(b.dropRow('T', 2, 3), 21); // cells on bbox rows 1..2
  assert.strictEqual(b.dropRow('S', 0, 3), 22);
  assert.strictEqual(b.dropRow('Z', 0, 3), 22);
  assert.strictEqual(b.dropRow('J', 0, 3), 22);
  assert.strictEqual(b.dropRow('L', 0, 3), 22);
  assert.strictEqual(b.dropRow('S', 1, 3), 21); // rows 0..2
});

test('place on empty board locks the exact expected cells', () => {
  const b = new Board();
  const res = b.place('T', 0, 3);
  assert.ok(res);
  assert.strictEqual(res.linesCleared, 0);
  assert.strictEqual(res.landingRow, 22);
  assert.deepStrictEqual(
    normalize(res.lockedCells),
    normalize([[4, 22], [3, 23], [4, 23], [5, 23]])
  );
  // original board untouched
  assert.strictEqual(b.heights().reduce((a, x) => a + x, 0), 0);
  assert.deepStrictEqual(res.board.heights(), [0, 0, 0, 1, 2, 1, 0, 0, 0, 0]);
});

test('walls: vertical I reaches columns 0 and 9 via negative/positive bboxCol', () => {
  const b = new Board();
  // vertical I (rot 1) occupies bbox x = 2, so bboxCol range is -2..7
  assert.strictEqual(b.collides('I', 1, -2, 0), false);
  assert.strictEqual(b.collides('I', 1, -3, 0), true); // col -1: wall
  assert.strictEqual(b.collides('I', 1, 7, 0), false);
  assert.strictEqual(b.collides('I', 1, 8, 0), true); // col 10: wall
  assert.strictEqual(b.dropRow('I', 1, -2), 20);
  const left = b.place('I', 1, -2);
  assert.deepStrictEqual(
    normalize(left.lockedCells),
    normalize([[0, 20], [0, 21], [0, 22], [0, 23]])
  );
  const right = b.place('I', 1, 7);
  assert.deepStrictEqual(
    normalize(right.lockedCells),
    normalize([[9, 20], [9, 21], [9, 22], [9, 23]])
  );
});

test('floor collision counts as collision', () => {
  const b = new Board();
  assert.strictEqual(b.collides('I', 0, 3, 23), true); // cells on row 24
  assert.strictEqual(b.collides('I', 0, 3, 22), false);
});

test('enumeratePlacements counts and dedup across rotation states', () => {
  const b = new Board();
  assert.strictEqual(b.enumeratePlacements('O').length, 9);  // 1 rot x 9 cols
  assert.strictEqual(b.enumeratePlacements('I').length, 17); // 7 + 10
  assert.strictEqual(b.enumeratePlacements('S').length, 17); // 8 + 9
  assert.strictEqual(b.enumeratePlacements('Z').length, 17);
  assert.strictEqual(b.enumeratePlacements('T').length, 34); // 8+9+8+9
  assert.strictEqual(b.enumeratePlacements('J').length, 34);
  assert.strictEqual(b.enumeratePlacements('L').length, 34);
  const iCols = b.enumeratePlacements('I')
    .filter((p) => p.rot === 1)
    .map((p) => p.col);
  assert.deepStrictEqual(iCols, [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7]);
});

test('fromMatrix places the 20 visible rows at the bottom', () => {
  const m = matrix20((mat) => {
    mat[19][0] = 1; // bottom-left visible cell
    mat[0][9] = 1;  // top-right visible cell
  });
  const b = Board.fromMatrix(m);
  assert.strictEqual(b.get(0, 23), 1);
  assert.strictEqual(b.get(9, 4), 1);
  assert.strictEqual(b.get(9, 3), 0); // hidden rows empty
  assert.deepStrictEqual(b.heights(), [1, 0, 0, 0, 0, 0, 0, 0, 0, 20]);
});

test('single line clear: I completes the bottom row', () => {
  const m = matrix20((mat) => {
    for (let c = 4; c < 10; c++) mat[19][c] = 1;
  });
  const b = Board.fromMatrix(m);
  const res = b.place('I', 0, 0); // fills cols 0..3 of the bottom row
  assert.strictEqual(res.linesCleared, 1);
  assert.deepStrictEqual(res.clearedRows, [23]);
  assert.strictEqual(res.board.aggregateHeight(), 0); // board empty again
});

test('double line clear: O fills a 2x2 notch', () => {
  const m = matrix20((mat) => {
    for (let r = 18; r < 20; r++) {
      for (let c = 0; c < 8; c++) mat[r][c] = 1;
    }
  });
  const b = Board.fromMatrix(m);
  const res = b.place('O', 0, 7); // O cells at bbox x=1,2 -> cols 8,9
  assert.strictEqual(res.linesCleared, 2);
  assert.strictEqual(res.board.aggregateHeight(), 0);
});

test('triple line clear + cascade shift: vertical I in a depth-3 well', () => {
  const m = matrix20((mat) => {
    for (let r = 17; r < 20; r++) {
      for (let c = 0; c < 9; c++) mat[r][c] = 1;
    }
  });
  const b = Board.fromMatrix(m);
  const res = b.place('I', 1, 7); // vertical I in column 9
  assert.strictEqual(res.linesCleared, 3);
  // 4th (topmost) I cell survives and must shift down to the floor row.
  assert.strictEqual(res.board.get(9, 23), 1);
  assert.strictEqual(res.board.aggregateHeight(), 1);
  assert.deepStrictEqual(res.board.heights(), [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
});

test('tetris: vertical I clears 4 lines', () => {
  const m = matrix20((mat) => {
    for (let r = 16; r < 20; r++) {
      for (let c = 0; c < 9; c++) mat[r][c] = 1;
    }
  });
  const b = Board.fromMatrix(m);
  const res = b.place('I', 1, 7);
  assert.strictEqual(res.linesCleared, 4);
  assert.strictEqual(res.board.aggregateHeight(), 0);
});

test('S and Z on flat ground each create exactly 1 hole', () => {
  for (const name of ['S', 'Z']) {
    const b = new Board();
    const res = b.place(name, 0, 3);
    assert.strictEqual(res.linesCleared, 0);
    assert.strictEqual(res.board.holes(), 1, `${name} holes`);
  }
});

test('feature helpers on a known board', () => {
  // Visible board (bottom 3 rows):
  //   row17: . . . . . . . . . .
  //   row18: # . . . . . . . . .
  //   row19: # # . . . . . . . #
  const m = matrix20((mat) => {
    mat[18][0] = 1;
    mat[19][0] = 1;
    mat[19][1] = 1;
    mat[19][9] = 1;
  });
  const b = Board.fromMatrix(m);
  assert.deepStrictEqual(b.heights(), [2, 1, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.strictEqual(b.holes(), 0);
  assert.strictEqual(b.aggregateHeight(), 4);
  assert.strictEqual(b.bumpiness(), 1 + 1 + 0 + 0 + 0 + 0 + 0 + 0 + 1);
  // rowTransitions: 22 empty rows x 2, row 22: (#.........) -> 2,
  // row 23: (##.......#) -> wall#|..|#wall -> 2. Total 48.
  assert.strictEqual(b.rowTransitions(), 22 * 2 + 2 + 2);
  // colTransitions: col0 1, col1 1, cols2..8 1 each (empty->floor), col9 1.
  assert.strictEqual(b.colTransitions(), 10);
});

test('wells: cumulative Dellacherie well depth', () => {
  // Column 0 well of depth 3: col1 filled 3 high, col0 empty (left wall).
  const m = matrix20((mat) => {
    for (let r = 17; r < 20; r++) mat[r][1] = 1;
  });
  const b = Board.fromMatrix(m);
  assert.strictEqual(b.wells(), 3 + 2 + 1);

  // Interior well of depth 2 between two height-2 towers.
  const m2 = matrix20((mat) => {
    for (let r = 18; r < 20; r++) {
      mat[r][3] = 1;
      mat[r][5] = 1;
    }
  });
  const b2 = Board.fromMatrix(m2);
  assert.strictEqual(b2.wells(), 2 + 1);
});

test('holes counted below any filled cell in the column', () => {
  const m = matrix20((mat) => {
    mat[15][4] = 1; // roof
    // rows 16..19 at col 4 empty -> 4 holes
  });
  const b = Board.fromMatrix(m);
  assert.strictEqual(b.holes(), 4);
});

test('computeKeySequence exactness', () => {
  assert.deepStrictEqual(computeKeySequence('T', 0, 3), ['hard']);
  assert.deepStrictEqual(
    computeKeySequence('T', 2, 5),
    ['180', 'right', 'right', 'hard']
  );
  assert.deepStrictEqual(
    computeKeySequence('I', 1, -2),
    ['cw', 'left', 'left', 'left', 'left', 'left', 'hard']
  );
  assert.deepStrictEqual(
    computeKeySequence('I', 1, 7),
    ['cw', 'right', 'right', 'right', 'right', 'hard']
  );
  assert.deepStrictEqual(
    computeKeySequence('L', 3, 0),
    ['ccw', 'left', 'left', 'left', 'hard']
  );
  assert.deepStrictEqual(computeKeySequence('O', 0, -1), ['left', 'left', 'left', 'left', 'hard']);
  assert.deepStrictEqual(computeKeySequence('J', 1, 3), ['cw', 'hard']);
});

test('reachability: full-height wall through the spawn area yields no placements', () => {
  // Column 4 filled all the way up, including the hidden spawn rows: a real
  // piece collides on spawn (top-out), so nothing is placeable at all.
  const b = new Board();
  for (let r = 0; r < Board.HEIGHT; r++) b.set(4, r);
  assert.strictEqual(b.enumeratePlacements('T').length, 0);
  assert.strictEqual(b.enumeratePlacements('I').length, 0);
  assert.strictEqual(b.enumeratePlacements('O').length, 0);
});

test('reachability: wall outside the spawn bbox blocks only the far side', () => {
  // Column 7 filled through the spawn rows; spawn (cols 3-5) is clear, so
  // pieces can play — but only placements whose lateral walk at spawn
  // height never crosses column 7 are reachable.
  const b = new Board();
  for (let r = 0; r < Board.HEIGHT; r++) b.set(7, r);
  const placements = b.enumeratePlacements('T');
  assert.ok(placements.length > 0, 'left side must remain playable');
  for (const p of placements) {
    for (const [col] of p.result.lockedCells) {
      assert.ok(col < 7, `unreachable cell at col ${col} (rot ${p.rot})`);
    }
  }
});

test('reachability: open field keeps every placement (isReachable true)', () => {
  const b = new Board();
  for (const name of PIECE_NAMES) {
    for (const p of b.enumeratePlacements(name)) {
      assert.strictEqual(b.isReachable(name, p.rot, p.col), true);
    }
  }
});

test('lockOut / toppedOut flags on place()', () => {
  // Columns 4-5 filled from internal row 2 down: an O dropped there locks
  // entirely within the hidden rows -> lockOut (game over in TETR.IO).
  const b = new Board();
  for (let r = 2; r < Board.HEIGHT; r++) { b.set(4, r); b.set(5, r); }
  const res = b.place('O', 0, 3);
  assert.ok(res);
  assert.strictEqual(res.lockOut, true);
  assert.strictEqual(res.toppedOut, true);
  assert.ok(res.lockedCells.every(([, row]) => row < Board.HIDDEN));
  // ...and such a placement is never offered as reachable.
  assert.strictEqual(b.isReachable('O', 0, 3), false);

  // Straddling the hidden boundary: toppedOut but NOT lockOut.
  const b2 = new Board();
  for (let r = 5; r < Board.HEIGHT; r++) { b2.set(4, r); b2.set(5, r); }
  const res2 = b2.place('O', 0, 3); // locks at rows 3 (hidden) and 4 (visible)
  assert.ok(res2);
  assert.strictEqual(res2.toppedOut, true);
  assert.strictEqual(res2.lockOut, false);

  // Ordinary placement: both flags false.
  const res3 = new Board().place('T', 0, 3);
  assert.strictEqual(res3.toppedOut, false);
  assert.strictEqual(res3.lockOut, false);
});

test('clone is independent of the original', () => {
  const b = new Board();
  const c = b.clone();
  c.set(0, 23);
  assert.strictEqual(b.get(0, 23), 0);
  assert.strictEqual(c.get(0, 23), 1);
});
