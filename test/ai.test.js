'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { Board } = require('../src/board');
const { evaluate, pickMove, QUAD_DANGER_HEIGHT } = require('../src/ai');
const { applyMove } = require('../src/state');

function matrix20(fn) {
  const m = [];
  for (let r = 0; r < 20; r++) m.push(new Array(10).fill(0));
  if (fn) fn(m);
  return m;
}

test('evaluate rewards line clears (eroded cells) over stacking', () => {
  // 9 columns filled 1 high, col 9 open on the bottom row.
  const m = matrix20((mat) => {
    for (let c = 0; c < 9; c++) mat[19][c] = 1;
  });
  const b = Board.fromMatrix(m);
  // I flat cannot fit the single-cell gap; compare vertical I in col 9
  // (clears 1 line) vs vertical I stacked in col 0 (clears nothing).
  const clear = b.place('I', 1, 7);
  const stack = b.place('I', 1, -2);
  assert.strictEqual(clear.linesCleared, 1);
  assert.strictEqual(stack.linesCleared, 0);
  assert.ok(
    evaluate(clear, clear.board) > evaluate(stack, stack.board),
    'clearing placement must score higher'
  );
});

test('empty board + I: picks a flat placement with 0 holes', () => {
  const move = pickMove({
    board: new Board(),
    current: 'I',
    queue: [],
    hold: null,
    canHold: false,
  });
  assert.ok(move);
  assert.strictEqual(move.rot, 0, 'flat I preferred');
  assert.strictEqual(move.expectedResult.board.holes(), 0);
  assert.strictEqual(move.useHold, false);
  assert.strictEqual(move.keys[move.keys.length - 1], 'hard');
});

test('9 columns height 4, col 9 empty, current I: takes the tetris', () => {
  const m = matrix20((mat) => {
    for (let r = 16; r < 20; r++) {
      for (let c = 0; c < 9; c++) mat[r][c] = 1;
    }
  });
  const move = pickMove({
    board: Board.fromMatrix(m),
    current: 'I',
    queue: ['T', 'O'],
    hold: null,
    canHold: true,
  });
  assert.ok(move);
  assert.strictEqual(move.useHold, false);
  assert.strictEqual(move.rot, 1, 'vertical I');
  assert.strictEqual(move.col, 7, 'bboxCol 7 = board column 9');
  assert.strictEqual(move.expectedResult.linesCleared, 4);
  assert.deepStrictEqual(move.keys, [
    'cw', 'right', 'right', 'right', 'right', 'hard',
  ]);
});

test('flat board, S with depth-2 lookahead: never creates more than 1 hole', () => {
  const move = pickMove({
    board: new Board(),
    current: 'S',
    queue: ['S'],
    hold: null,
    canHold: false,
  });
  assert.ok(move);
  assert.ok(
    move.expectedResult.board.holes() <= 1,
    `S placement made ${move.expectedResult.board.holes()} holes`
  );
});

test('hold semantics: empty hold consumes queue[0] and prepends the hold key', () => {
  // Make holding strictly better: current S on a board where only an I in
  // the col-9 well clears 4 lines. hold is empty, queue[0] = I.
  const m = matrix20((mat) => {
    for (let r = 16; r < 20; r++) {
      for (let c = 0; c < 9; c++) mat[r][c] = 1;
    }
  });
  const move = pickMove({
    board: Board.fromMatrix(m),
    current: 'S',
    queue: ['I', 'T'],
    hold: null,
    canHold: true,
  });
  assert.ok(move);
  assert.strictEqual(move.useHold, true, 'should hold S and play the I');
  assert.strictEqual(move.keys[0], 'hold');
  assert.strictEqual(move.expectedResult.linesCleared, 4);
});

test('hold swap: filled hold slot offers the held piece', () => {
  const m = matrix20((mat) => {
    for (let r = 16; r < 20; r++) {
      for (let c = 0; c < 9; c++) mat[r][c] = 1;
    }
  });
  const move = pickMove({
    board: Board.fromMatrix(m),
    current: 'S',
    queue: ['T', 'O'],
    hold: 'I',
    canHold: true,
  });
  assert.ok(move);
  assert.strictEqual(move.useHold, true);
  assert.strictEqual(move.expectedResult.linesCleared, 4);
});

test('pickMove never returns null on sane inputs', () => {
  const boards = [
    new Board(),
    Board.fromMatrix(matrix20((mat) => {
      for (let c = 0; c < 9; c++) mat[19][c] = 1;
    })),
    Board.fromMatrix(matrix20((mat) => {
      for (let r = 10; r < 20; r++) {
        for (let c = 0; c < 10; c++) mat[r][c] = (r + c) % 3 !== 0 ? 1 : 0;
      }
    })),
  ];
  for (const board of boards) {
    for (const piece of ['I', 'O', 'T', 'S', 'Z', 'J', 'L']) {
      const move = pickMove({
        board,
        current: piece,
        queue: ['T', 'I'],
        hold: 'L',
        canHold: true,
      });
      assert.ok(move, `null move for ${piece}`);
      assert.strictEqual(move.keys[move.keys.length - 1], 'hard');
    }
  }
});

test('depth-1 fallback when the queue is empty', () => {
  const move = pickMove({
    board: new Board(),
    current: 'T',
    queue: [],
    hold: null,
    canHold: true,
  });
  assert.ok(move);
  assert.strictEqual(move.useHold, false, 'nothing to hold-swap with');
});

test('safety rule: near top-out still returns a move', () => {
  // Stack almost to the hidden rows: 19 of 20 visible rows filled except
  // column 9 (kept as a well so placements exist).
  const m = matrix20((mat) => {
    for (let r = 1; r < 20; r++) {
      for (let c = 0; c < 9; c++) mat[r][c] = 1;
    }
  });
  const move = pickMove({
    board: Board.fromMatrix(m),
    current: 'T',
    queue: ['I'],
    hold: null,
    canHold: true,
  });
  assert.ok(move, 'must still return a move near top-out');
});

test('performance: pickMove under 50ms on a rough mid-game board', () => {
  const m = matrix20((mat) => {
    // Jagged mid-game stack, ~8 rows tall with holes.
    const heights = [6, 4, 7, 5, 3, 6, 8, 4, 5, 2];
    for (let c = 0; c < 10; c++) {
      for (let h = 0; h < heights[c]; h++) {
        if ((c * 7 + h) % 5 !== 0) mat[19 - h][c] = 1;
      }
    }
  });
  const board = Board.fromMatrix(m);
  const input = {
    board,
    current: 'T',
    queue: ['I', 'S'],
    hold: 'Z',
    canHold: true,
  };
  pickMove(input); // warm-up (JIT)
  pickMove(input);
  const t0 = process.hrtime.bigint();
  const move = pickMove(input);
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(move);
  assert.ok(elapsedMs < 50, `pickMove took ${elapsedMs.toFixed(2)}ms`);
});

// Columns 0-8 filled for the bottom n rows, the right column (QUAD's well) open.
function readyRows(n) {
  return matrix20((mat) => {
    for (let r = 20 - n; r < 20; r++) for (let c = 0; c < 9; c++) mat[r][c] = 1;
  });
}

test('QUAD keeps an I for the well until four rows are ready, where SINGLE burns them', () => {
  for (let n = 1; n <= 3; n++) {
    const state = { board: Board.fromMatrix(readyRows(n)), current: 'I', queue: ['T', 'O', 'S'],
      hold: null, canHold: true };
    assert.strictEqual(pickMove(state).expectedResult.linesCleared, n, 'SINGLE clears what it can');
    const move = pickMove({ ...state, strategy: 'QUAD' });
    assert.strictEqual(move.expectedResult.linesCleared, 0);
    assert.strictEqual(move.useHold, true, 'the I goes to hold');
    assert.strictEqual(move.expectedResult.board.heights()[9], 0, 'the well stays open');
  }
  const quad = pickMove({ board: Board.fromMatrix(readyRows(4)), current: 'I', queue: ['T', 'O', 'S'],
    hold: null, canHold: true, strategy: 'QUAD' });
  assert.strictEqual(quad.expectedResult.linesCleared, 4);
  assert.strictEqual(quad.col, 7, 'vertical I into the right column');
});

test('QUAD builds on columns 0-8 and clears only by quads over two bags', () => {
  const seq = ['T', 'S', 'O', 'L', 'I', 'Z', 'J', 'O', 'J', 'T', 'L', 'S', 'Z', 'I', 'T', 'O', 'L', 'J', 'S'];
  let state = { board: new Board(), current: seq[0], hold: null, queue: seq.slice(1, 6), sequence: 0 };
  let fed = 6;
  for (let i = 0; i < 14; i++) {
    const move = pickMove({ ...state, canHold: true, strategy: 'QUAD' });
    const lines = move.expectedResult.linesCleared;
    assert.ok(lines === 0 || lines === 4, `piece ${i} cleared ${lines}`);
    if (!lines) assert.strictEqual(move.expectedResult.board.heights()[9], 0, `piece ${i} filled the well`);
    state = applyMove(state, move);
    while (state.queue.length < 5) state.queue.push(seq[fed++]);
  }
});

test('above the danger height QUAD plays exactly like SINGLE', () => {
  const m = matrix20((mat) => {
    for (let r = 20 - QUAD_DANGER_HEIGHT - 1; r < 20; r++) for (let c = 0; c < 4; c++) mat[r][c] = 1;
  });
  const state = { board: Board.fromMatrix(m), current: 'T', queue: ['I', 'S'], hold: 'Z', canHold: true };
  const single = pickMove(state), quad = pickMove({ ...state, strategy: 'QUAD' });
  assert.deepStrictEqual([quad.useHold, quad.piece, quad.rot, quad.col], [single.useHold, single.piece, single.rot, single.col]);
});
