'use strict';

// Move selection. Pure logic, no I/O.
//
// SINGLE scores a placement with Dellacherie's hand-tuned heuristic (Thiery & Scherrer,
// "Building Controllers for Tetris", 2009): landing height, eroded cells, row and column
// transitions, holes and wells, weighted as below.

const { Board, computeKeySequence, HEIGHT, WIDTH, PIECES } = require('./board');

const W_LANDING = -4.500;
const W_ERODED = 3.418;
const W_ROW_TRANS = -3.217;
const W_COL_TRANS = -9.348;
const W_HOLES = -7.899;
const W_WELLS = -3.386;

// placeResult: output of Board#place(); boardAfter: the resulting board.
function evaluate(placeResult, boardAfter) {
  const { lockedCells, linesCleared, clearedRows } = placeResult;

  // Average height of the placed cells above the floor, before any clear.
  let sumH = 0;
  for (let i = 0; i < lockedCells.length; i++) {
    sumH += (HEIGHT - 1) - lockedCells[i][1];
  }
  const landingHeight = sumH / lockedCells.length;

  // Eroded piece cells: linesCleared * (locked cells inside cleared rows).
  let inCleared = 0;
  if (linesCleared > 0) {
    for (let i = 0; i < lockedCells.length; i++) {
      if (clearedRows.indexOf(lockedCells[i][1]) !== -1) inCleared++;
    }
  }
  const eroded = linesCleared * inCleared;

  return (
    W_LANDING * landingHeight +
    W_ERODED * eroded +
    W_ROW_TRANS * boardAfter.rowTransitions() +
    W_COL_TRANS * boardAfter.colTransitions() +
    W_HOLES * boardAfter.holes() +
    W_WELLS * boardAfter.wells()
  );
}

// QUAD: keep the right column (the well) empty, stack the rest flat and hole-free, and clear
// four rows at once with a vertical I. Stack terms as above, with the well treated as a wall.
// Weights tuned with probe/quad_sim.js.
const WELL = WIDTH - 1;
const Q_WELL_CELL = -20;  // per filled well cell: it caps the well until those rows clear
const Q_QUAD = 60;        // a four-row clear
const Q_BURN = -10;       // per row cleared one to three at a time
const Q_HOLD_I = 30;      // an I kept in hold: the quad is one swap away when the well is ready
// At this stack height QUAD stops waiting for an I and plays single-clear until it is low again.
const QUAD_DANGER_HEIGHT = 10;

function evaluateQuad(placeResult, board) {
  const { lockedCells, linesCleared } = placeResult;
  let sumH = 0;
  for (let i = 0; i < lockedCells.length; i++) sumH += (HEIGHT - 1) - lockedCells[i][1];
  const landingHeight = sumH / lockedCells.length;

  const rows = board.rows;
  let rowTrans = 0, colTrans = 0, holes = 0, wells = 0, wellCells = 0;
  for (let r = 0; r < HEIGHT; r++) {
    const bits = rows[r] | (1 << WELL); // the well is a wall to the stack
    let prev = 1;
    for (let c = 0; c < WIDTH; c++) {
      const cur = (bits >> c) & 1;
      if (cur !== prev) rowTrans++;
      prev = cur;
    }
    if ((rows[r] >> WELL) & 1) wellCells++;
  }
  for (let c = 0; c < WELL; c++) {
    let prev = 0, roof = false;
    for (let r = 0; r < HEIGHT; r++) {
      const cur = (rows[r] >> c) & 1;
      if (cur !== prev) colTrans++;
      prev = cur;
      if (cur) { roof = true; continue; }
      if (roof) holes++;
      const left = c === 0 ? 1 : (rows[r] >> (c - 1)) & 1;
      const right = c === WELL - 1 ? 1 : (rows[r] >> (c + 1)) & 1;
      if (left && right) {
        for (let r2 = r; r2 < HEIGHT && !((rows[r2] >> c) & 1); r2++) wells++;
      }
    }
    if (prev !== 1) colTrans++;
  }

  return (
    W_LANDING * landingHeight +
    W_ROW_TRANS * rowTrans +
    W_COL_TRANS * colTrans +
    W_HOLES * holes +
    W_WELLS * wells +
    Q_WELL_CELL * wellCells +
    (linesCleared === 4 ? Q_QUAD : Q_BURN * linesCleared)
  );
}

const DEAD_CHILD = -1e6; // next piece cannot be placed at all
const LOCK_OUT = -1e9;   // the piece locks entirely above the field: game over

function bestChildScore(board, pieceName, score = evaluate) {
  const placements = board.enumeratePlacements(pieceName);
  if (placements.length === 0) return null;
  let best = -Infinity;
  let sawLive = false;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.result.lockOut) continue; // game-ending, not a real option
    sawLive = true;
    const s = score(p.result, p.result.board);
    if (s > best) best = s;
  }
  return sawLive ? best : null;
}

function maxHeight(board) {
  const h = board.heights();
  let m = 0;
  for (let i = 0; i < h.length; i++) if (h[i] > m) m = h[i];
  return m;
}

function locksInHiddenRows(placeResult) {
  return placeResult.toppedOut === true;
}

// pickMove({ board, current, queue, hold, canHold, ... })
//  -> { useHold, piece, rot, col, keys, expectedResult }, or null when nothing fits.
// Looks one piece ahead: queue[0], or queue[1] when holding into an empty slot uses queue[0].
// keyPenalty: score cost per key press, so near-equal placements prefer fewer keys.
// beam: look ahead only from the best N placements (0 = from all of them).
// strategy: 'SINGLE' or 'QUAD'; QUAD scores like SINGLE at QUAD_DANGER_HEIGHT and above.
function pickMove({ board, current, queue = [], hold = null, canHold = true, keyPenalty = 0, beam = 0,
                    estimateInput = null, inputPenalty = 0, strategy = 'SINGLE' }) {
  const scoreFn = strategy === 'QUAD' && maxHeight(board) < QUAD_DANGER_HEIGHT ? evaluateQuad : evaluate;
  const candidates = [
    { useHold: false, piece: current, next: queue[0] },
  ];
  if (canHold) {
    const heldPiece = hold || queue[0];
    if (heldPiece && !(hold === null && queue.length === 0)) {
      candidates.push({
        useHold: true,
        piece: heldPiece,
        next: hold ? queue[0] : queue[1],
      });
    }
  }

  let entries = [];
  for (let ci = 0; ci < candidates.length; ci++) {
    const cand = candidates[ci];
    if (!cand.piece) continue;
    const placements = board.enumeratePlacements(cand.piece);
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i];
      let score = scoreFn(p.result, p.result.board);
      if (scoreFn === evaluateQuad && (cand.useHold ? current : hold) === 'I') score += Q_HOLD_I;
      const estimatedInputMs = estimateInput
        ? estimateInput({ piece: cand.piece, rot: p.rot, col: p.col, useHold: cand.useHold }) : null;
      if (estimatedInputMs != null) score -= Math.min(0.02, Math.max(0, inputPenalty)) * estimatedInputMs;
      // A lock-out ends the game: only pick it when every placement does.
      if (p.result.lockOut) score += LOCK_OUT;
      if (keyPenalty > 0) {
        const nKeys = (p.rot % 4 !== 0 ? 1 : 0) +
                      Math.abs(p.col - PIECES[cand.piece].spawnCol) +
                      (cand.useHold ? 1 : 0);
        score -= keyPenalty * nKeys;
      }
      entries.push({
        useHold: cand.useHold,
        estimatedInputMs,
        piece: cand.piece,
        rot: p.rot,
        col: p.col,
        score,
        next: cand.next,
        result: p.result,
      });
    }
  }

  if (entries.length === 0) return null;

  // Look ahead only from the best `beam` placements.
  if (beam > 0 && entries.length > beam) {
    entries = entries.slice().sort((a, b) => b.score - a.score).slice(0, beam);
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.next) {
      const child = bestChildScore(e.result.board, e.next, scoreFn);
      e.score += child === null ? DEAD_CHILD : child;
    }
  }

  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].score > best.score) best = entries[i];
  }

  // If the best move reaches into the hidden spawn rows, take the lowest resulting stack instead.
  if (locksInHiddenRows(best.result)) {
    let safest = best;
    let safestH = maxHeight(best.result.board);
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].result.lockOut && !best.result.lockOut) continue;
      const h = maxHeight(entries[i].result.board);
      if (h < safestH || (h === safestH && entries[i].score > safest.score)) {
        safest = entries[i];
        safestH = h;
      }
    }
    best = safest;
  }

  const keys = computeKeySequence(best.piece, best.rot, best.col);
  if (best.useHold) keys.unshift('hold');

  return {
    useHold: best.useHold,
    piece: best.piece,
    estimatedInputMs: best.estimatedInputMs,
    rot: best.rot,
    col: best.col,
    keys,
    expectedResult: best.result,
  };
}

module.exports = { evaluate, evaluateQuad, pickMove, QUAD_DANGER_HEIGHT };
