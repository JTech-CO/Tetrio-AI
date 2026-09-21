'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, PIECES, DISTINCT_ROTS, computeKeySequence } = require('../src/board');
const { pickMove } = require('../src/ai');
const { applyMove, knownQueue } = require('../src/state');
const { planInput } = require('../src/input/planner');
const { InputExecutor, INPUT_KEYS } = require('../src/input/executor');
const { validateCalibration } = require('../src/input/calibration');
const { matches, visible, runTurbo, waitForStableState } = require('../src/turbo');
const { ZenBot } = require('../src/bot');
const { MODES, resolveMode } = require('../src/modes');
const { acceptance } = require('../probe/validate_turbo');

const calibration = { version: 1, scope: 'ZEN', validated: true,
  tapHoldMs: 17, tapGapMs: 5, afterRotateMs: 10, spawnMs: 65,
  settleMs: 15, settleClearMs: 70, wallHoldMs: null,
  environment: { viewport: { w: 800, h: 600, dpr: 1 } },
  evidence: { pieces: 100, mismatches: 0 } };

test('predicted state consumes NEXT correctly for no hold, empty hold and swap', () => {
  for (const [hold, useHold, consumed, placed] of [[null, false, 1, 'T'], [null, true, 2, 'I'], ['O', true, 1, 'O']]) {
    const s = { board: new Board(), current: 'T', hold, queue: ['I', 'S', 'Z', 'J', 'L'], sequence: 12 };
    const mv = { piece: placed, useHold, expectedResult: s.board.place(placed, 0, 3) };
    const after = applyMove(s, mv);
    assert.equal(after.current, s.queue[consumed - 1]);
    assert.deepEqual(after.queue, s.queue.slice(consumed));
    assert.equal(after.hold, useHold ? 'T' : hold);
    assert.equal(after.sequence, 13);
    assert.deepEqual(s.board.rows, new Board().rows);
    assert.notEqual(after.board, mv.expectedResult.board);
  }
});
test('unknown NEXT stays unknown and prediction refuses exhausted or wrong-piece plans', () => {
  assert.deepEqual(knownQueue(['I', null, 'T']), ['I']);
  const s = { board: new Board(), current: 'T', hold: null, queue: ['I'], sequence: 0 };
  assert.throws(() => applyMove(s, { useHold: true, piece: 'I' }), /exhausted/);
  assert.throws(() => applyMove(s, { useHold: false, piece: 'O' }), /does not match/);
});
test('calibration fails closed for fabricated floors, insufficient evidence and untested overlap', () => {
  assert.equal(validateCalibration(calibration), calibration);
  for (const change of [{ validated: false }, { tapHoldMs: 12 }, { spawnMs: NaN },
    { overlap: true }, { evidence: { pieces: 99, mismatches: 0 } }, { wallHoldMs: 70 }]) {
    assert.throws(() => validateCalibration({ ...calibration, ...change }));
  }
});
test('tap timelines preserve the legacy reachable move for every piece/rotation/column', () => {
  for (const piece of Object.keys(PIECES)) for (const rot of DISTINCT_ROTS[piece]) {
    const { minX, maxX } = PIECES[piece].meta[rot];
    for (let col = -minX; col <= 9 - maxX; col++) for (const useHold of [false, true]) {
      const p = planInput({ piece, rot, col, useHold }, calibration);
      const expected = computeKeySequence(piece, rot, col);
      if (useHold) expected.unshift('hold');
      assert.deepEqual(p.events.filter(e => e.down).map(e => e.key), expected);
      for (let i = 0; i < p.events.length; i += 2) {
        assert.equal(p.events[i + 1].at - p.events[i].at, 17);
      }
      assert.equal(p.events.at(-2).at, p.dropAt);
      assert.equal(p.events.at(-1).at, p.durationMs);
    }
  }
});
test('measured DAS is used only at walls when cheaper, including vertical I offset', () => {
  const c = { ...calibration, wallHoldMs: 70 };
  const left = planInput({ piece: 'I', rot: 1, col: -2 }, c);
  assert.equal(left.wallUsed, 'left');
  assert.equal(left.events.filter(e => e.down && e.key === 'left').length, 1);
  const middle = planInput({ piece: 'I', rot: 1, col: 0 }, c);
  assert.equal(middle.wallUsed, null);
  const slow = planInput({ piece: 'I', rot: 1, col: -2 }, { ...c, wallHoldMs: 300 });
  assert.equal(slow.wallUsed, null);
});
test('overlap preserves each pulse and removes one movement cycle only with measured opt-in', () => {
  const move = { piece: 'T', rot: 1, col: 0, useHold: true };
  const serial = planInput(move, calibration);
  const overlap = planInput(move, { ...calibration, overlap: true });
  assert.equal(overlap.overlapUsed, true);
  assert.equal(serial.durationMs - overlap.durationMs, 22);
  const firstMove = overlap.events.find(e => e.key === 'left' && e.down);
  const rotation = overlap.events.find(e => e.key === 'cw' && e.down);
  assert.equal(firstMove.at, rotation.at);
  assert.ok(rotation.at >= 32); // HOLD must complete first
  assert.ok(validateCalibration({ ...calibration, overlap: true,
    evidence: { ...calibration.evidence, overlapped: 20 } }));
});
test('executor pipelines CDP replies and never compresses pulses after scheduler lateness', async () => {
  let now = 0;
  const sent = [], replies = [];
  const ex = new InputExecutor({ dispatchKeyEventFast(key, down) {
    sent.push({ key, down, at: now });
    return new Promise(resolve => { replies.push(resolve); if (sent.length === 4) replies.forEach(r => r()); });
  } }, { now: () => now, wait: async ms => { now += ms + 8; } });
  const plan = { events: [{ at: 0, key: 'left', down: true }, { at: 17, key: 'left', down: false },
    { at: 22, key: 'hard', down: true }, { at: 39, key: 'hard', down: false }] };
  const result = await ex.execute(plan);
  assert.equal(sent.length, 4);
  assert.ok(sent[1].at - sent[0].at >= 17);
  assert.ok(sent[2].at - sent[1].at >= 5);
  assert.ok(sent[3].at - sent[2].at >= 17);
  assert.equal(result.dropAt, sent[2].at);
});
test('dispatch error releases every key and blocks subsequent plans', async () => {
  const sent = [];
  const ex = new InputExecutor({ dispatchKeyEventFast(key, down) {
    sent.push([key, down]); return down ? Promise.reject(new Error('disconnected')) : Promise.resolve();
  } }, { now: () => 0, wait: async () => {} });
  await assert.rejects(ex.execute({ events: [{ at: 0, key: 'left', down: true }] }), /disconnected/);
  for (const k of INPUT_KEYS) assert.ok(sent.some(([key, down]) => key === k && !down));
  await assert.rejects(ex.execute({ events: [{ at: 0, key: 'hard', down: true }] }), /disconnected/);
});
test('cancel during a held key releases keys before returning', async () => {
  let now = 0;
  const sent = [];
  const ex = new InputExecutor({ dispatchKeyEventFast: async (key, down) => { sent.push([key, down]); } },
    { now: () => now, wait: async ms => { now += ms; ex.cancel(); } });
  await assert.rejects(ex.execute({ events: [{ at: 0, key: 'left', down: true },
    { at: 17, key: 'left', down: false }] }), /cancelled/);
  assert.equal(ex.held.size, 0);
  assert.ok(sent.some(([key, down]) => key === 'left' && !down));
});
test('observer rejects stale sequences, board drift, queue shifts and wrong HOLD', () => {
  const state = { board: new Board(), current: 'T', hold: 'I', queue: ['S', 'O'], sequence: 4 };
  const good = { sequence: 4, full: true, current: null, stackFilled: visible(state.board), hold: 'I', queue: ['S', 'O', 'Z'] };
  assert.ok(matches(state, good));
  for (const change of [{ sequence: 3 }, { hold: 'T' }, { current: 'O' }, { queue: ['O', 'Z'] }]) {
    assert.equal(matches(state, { ...good, ...change }), false);
  }
  good.stackFilled[0][0] = true;
  assert.equal(matches(state, good), false); // top rows are NOT blindly ignored
});

function fakeBot({ captureError = false, mismatch = false, transitionAt = null } = {}) {
  let board = new Board(), current = 'T', hold = null, rot = 0, col = PIECES.T.spawnCol;
  let queue = ['I', 'S', 'Z', 'J', 'L'], n = 0;
  const bag = ['T', 'I', 'S', 'Z', 'J', 'L', 'O'];
  const held = new Set(), captures = [];
  let captureActive = false;
  let showCurrent = !!mismatch;
  const spawn = () => { rot = 0; col = PIECES[current].spawnCol; };
  const consume = () => { const p = queue.shift(); queue.push(bag[n++ % 7]); return p; };
  const t = { viewport: async () => calibration.environment.viewport,
    dispatchKeyEventFast: async (key, down) => {
      if (!down) { held.delete(key); return; }
      assert.equal(captureActive, false, 'No input may race a capture across its sequence fence');
      held.add(key);
      if (key === 'left') col--;
      if (key === 'right') col++;
      if (key === 'cw') rot = (rot + 1) % 4;
      if (key === 'ccw') rot = (rot + 3) % 4;
      if (key === '180') rot = (rot + 2) % 4;
      if (key === 'hold') { const old = current; current = hold || consume(); hold = old; spawn(); }
      if (key === 'hard') { board = board.place(current, rot, col).board; current = consume(); spawn(); }
    },
    captureSession: async () => ({ captureRegion: async () => {
      captureActive = true;
      try {
        await new Promise(r => setTimeout(r, 5));
        if (captureError) throw new Error('capture timeout');
        const transition = transitionAt != null && captures.length === transitionAt;
        if (transition) { board = new Board(); current = consume(); hold = null; spawn(); showCurrent = true; }
        const matrix = visible(board);
        if (showCurrent) for (const [x, y] of require('../src/vision/pieces').CANON[current]) matrix[y + 1][x + 3] = true;
        matrix.transition = transition;
        if (mismatch) matrix[19][0] = !matrix[19][0];
        captures.push(matrix); return matrix;
      } finally { captureActive = false; }
    }, close: async () => {} }) };
  const bot = new ZenBot(t, { ...MODES.TURBO.opts, mode: 'TURBO', verifyEvery: 1, calibration });
  bot.readState = async () => ({ current, hold, queue: queue.slice(), stackFilled: visible(board) });
  bot.vision = { readBoard: matrix => ({ filled: matrix }), readQueue: () => queue.slice(), readHold: () => hold,
    readLevelTransition: matrix => !!matrix.transition };
  return { bot, held, captures };
}
test('TURBO executes pixel-verified simulated input, refreshes NEXT, and verifies finite tail', async () => {
  const { bot, held, captures } = fakeBot();
  await runTurbo(bot, { maxPieces: 6, maxMs: 5000 });
  assert.equal(bot.piecesPlaced, 6);
  assert.equal(bot.turboStats.fallbackReason, null);
  assert.equal(bot.turboStats.verified, 6);
  assert.equal(captures.length, 6);
  assert.equal(held.size, 0);
});
test('periodic checks preserve known piece identity instead of bootstrapping from an animated frame', async () => {
  const { bot } = fakeBot();
  bot.opts.recalibrateEvery = 2;
  let reads = 0;
  const read = bot.readState;
  bot.readState = async () => { reads++; return read(); };
  bot.calibrate = async () => { throw new Error('Unnecessary border re-detection'); };
  await runTurbo(bot, { maxPieces: 6, maxMs: 5000 });
  assert.equal(bot.piecesPlaced, 6);
  assert.equal(reads, 1);
  assert.equal(bot.turboStats.fallbackReason, null);
});
test('ZEN level completion pauses input and resumes from three matching full pixel observations', async () => {
  const { bot, held } = fakeBot({ transitionAt: 1 });
  await runTurbo(bot, { maxPieces: 6, maxMs: 5000 });
  assert.equal(bot.piecesPlaced, 6);
  assert.equal(bot.turboStats.stageTransitions, 1);
  assert.equal(bot.turboStats.suspectPieces, 1);
  assert.equal(bot.turboStats.forcedResyncs, 1);
  assert.equal(bot.turboStats.fallbackReason, null);
  assert.equal(held.size, 0);
});
test('a level transition at the finite run boundary is settled and counted as uncertain', async () => {
  const { bot } = fakeBot({ transitionAt: 2 });
  await runTurbo(bot, { maxPieces: 3, maxMs: 5000 });
  assert.equal(bot.piecesPlaced, 3);
  assert.equal(bot.turboStats.stageTransitions, 1);
  assert.equal(bot.turboStats.suspectPieces, 1);
  assert.equal(bot.turboStats.fallbackReason, null);
});
test('capture failure and consecutive mismatches queue RAPID fallback and release keys', async () => {
  for (const scenario of [{ captureError: true }, { mismatch: true }]) {
    const { bot, held } = fakeBot(scenario);
    await runTurbo(bot, { maxPieces: 6, maxMs: 5000 });
    assert.equal(bot.pendingMode, 'RAPID');
    assert.ok(bot.piecesPlaced < 6);
    assert.ok(bot.turboStats.fallbackReason);
    assert.equal(held.size, 0);
    if (scenario.mismatch) {
      assert.equal(bot.turboStats.fallbackReason, 'consecutive verification mismatches');
      assert.ok(bot.turboStats.forcedResyncs >= 2);
    }
  }
});
test('resync rejects a transient missing HOLD until three full observations agree', async () => {
  const { bot, captures } = fakeBot({ mismatch: true });
  bot.vision.readHold = () => captures.length === 1 ? null : 'I';
  const capture = await bot.t.captureSession();
  const state = await waitForStableState(bot, capture, 0);
  assert.equal(state.hold, 'I');
  assert.equal(captures.length, 4);
  assert.equal(bot.piecesPlaced, 0);
});
test('changed viewport fails before the first input and requests RAPID instead of app restart', async () => {
  const { bot, held } = fakeBot();
  bot.t.viewport = async () => ({ w: 900, h: 600, dpr: 1 });
  await runTurbo(bot, { maxPieces: 2 });
  assert.equal(bot.piecesPlaced, 0);
  assert.equal(bot.pendingMode, 'RAPID');
  assert.match(bot.turboStats.fallbackReason, /viewport changed/);
  assert.equal(held.size, 0);
});
test('live mode change takes effect only after the complete input boundary', async () => {
  const { bot, held } = fakeBot();
  await bot.run({ maxPieces: 2, maxMs: 5000, onTurn: () => { bot.setMode('RAPID'); bot.stop = true; } });
  assert.equal(bot.mode, 'TURBO');
  assert.equal(bot.pendingMode, 'RAPID');
  assert.equal(held.size, 0);
  assert.equal(resolveMode('3'), 'TURBO');
  assert.equal(resolveMode('t'), 'TURBO');
});
test('acceptance cannot pass a short run, fallback, unverified mismatch window or input error', () => {
  const r = { pieces: 500, finalMode: 'TURBO', pps: 5.1,
    turbo: { fallbackReason: null, suspectPieces: 0, forcedResyncs: 0, inputErrors: 0 } };
  assert.ok(acceptance(r, 500));
  assert.equal(acceptance(r, 100), false);
  for (const delta of [{ fallbackReason: 'timeout' }, { suspectPieces: 10 }, { suspectPieces: 16 }, { forcedResyncs: 6 }, { inputErrors: 1 }]) {
    assert.equal(acceptance({ ...r, turbo: { ...r.turbo, ...delta } }, 500), false);
  }
});
test('1000-piece deterministic simulation exercises prediction and input-cost AI without drift', () => {
  const bag = ['T', 'S', 'I', 'L', 'O', 'J', 'Z'];
  let seed = 123456;
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return bag[seed % 7]; };
  let s = { board: new Board(), current: next(), hold: null, queue: Array.from({ length: 5 }, next), sequence: 0 };
  let lines = 0;
  for (let i = 0; i < 1000; i++) {
    const mv = pickMove({ ...s, beam: 12, estimateInput: m => planInput(m, calibration).estimatedInputMs, inputPenalty: 0.01 });
    assert.ok(mv && !mv.expectedResult.toppedOut);
    assert.deepEqual(s.board.place(mv.piece, mv.rot, mv.col).board.rows, mv.expectedResult.board.rows);
    s = applyMove(s, mv); lines += mv.expectedResult.linesCleared;
    while (s.queue.length < 5) s.queue.push(next());
  }
  assert.equal(s.sequence, 1000);
  assert.ok(lines > 300);
  assert.ok(s.board.holes() < 10);
});
