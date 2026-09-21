'use strict';

// Move selection for the TETR.IO ZEN bot. Pure logic, no I/O.
//
// Evaluation is the Dellacherie (2003) hand-tuned linear heuristic, the
// classic one-piece controller that clears ~660,000 lines on average
// (weights as published in Pierre Dellacherie's original agent; see
// Thiery & Scherrer, "Building Controllers for Tetris" (2009), Table 1,
// and Colin Fahey's tetris page — https://colinfahey.com/tetris/):
//   score = -4.500 * landingHeight
//         +  3.418 * erodedPieceCells
//         + -3.217 * rowTransitions
//         + -9.348 * colTransitions
//         + -7.899 * holes
//         + -3.386 * cumulativeWells

const { Board, computeKeySequence, HEIGHT, PIECES } = require('./board');

const W_LANDING = -4.500;
const W_ERODED = 3.418;
const W_ROW_TRANS = -3.217;
const W_COL_TRANS = -9.348;
const W_HOLES = -7.899;
const W_WELLS = -3.386;

// placeResult: output of Board#place(); boardAfter: the resulting board.
function evaluate(placeResult, boardAfter) {
  const { lockedCells, linesCleared, clearedRows } = placeResult;

  // Landing height: height of the locked piece's center of mass above the
  // floor (floor row => 0), measured before line clears.
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

const DEAD_CHILD = -1e6; // next piece cannot be placed at all
const LOCK_OUT = -1e9;   // placement locks fully above the visible field:
                         // game over in TETR.IO — worse than any live move

function bestChildScore(board, pieceName) {
  const placements = board.enumeratePlacements(pieceName);
  if (placements.length === 0) return null;
  let best = -Infinity;
  let sawLive = false;
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    if (p.result.lockOut) continue; // game-ending, not a real option
    sawLive = true;
    const s = evaluate(p.result, p.result.board);
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

// pickMove({ board, current, queue, hold, canHold })
//  -> { useHold, rot, col, keys, expectedResult } or null if no piece can
//     be placed at all (hard top-out).
//
// TETR.IO hold semantics: pressing hold with an empty hold slot stores the
// current piece and makes queue[0] the new current (so the depth-2
// lookahead piece becomes queue[1]); with a filled slot it swaps, leaving
// the queue untouched (lookahead piece stays queue[0]).
// keyPenalty (>= 0): score penalty per keystroke the placement needs (rotation +
// horizontal taps + hold). 0 disables it. RAPID mode uses a small value so the AI
// prefers cheaper key sequences among near-equal placements (shorter sequences =
// faster pieces), without overriding real stack-quality differences.
// beam (0 = off): evaluate the expensive depth-2 child search only for the top-N
// placements by parent-only score. Cuts pickMove ~35ms -> ~12ms; with beam=0 the
// behavior (including tie-break order) is EXACTLY the original full search.
function pickMove({ board, current, queue = [], hold = null, canHold = true, keyPenalty = 0, beam = 0,
                    estimateInput = null, inputPenalty = 0 }) {
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
      let score = evaluate(p.result, p.result.board);
      const estimatedInputMs = estimateInput
        ? estimateInput({ piece: cand.piece, rot: p.rot, col: p.col, useHold: cand.useHold }) : null;
      if (estimatedInputMs != null) score -= Math.min(0.02, Math.max(0, inputPenalty)) * estimatedInputMs;
      // A lock-out ends the game: only ever pick it when literally every
      // available placement ends the game.
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

  // Beam pruning: keep only the top-N by parent score before the depth-2 child search.
  // (stable slice — with beam=0 the original entry order and full search are preserved)
  if (beam > 0 && entries.length > beam) {
    entries = entries.slice().sort((a, b) => b.score - a.score).slice(0, beam);
  }
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.next) {
      const child = bestChildScore(e.result.board, e.next);
      e.score += child === null ? DEAD_CHILD : child;
    }
  }

  let best = entries[0];
  for (let i = 1; i < entries.length; i++) {
    if (entries[i].score > best.score) best = entries[i];
  }

  // Safety rule: if the best move locks any cell in the hidden spawn rows
  // (imminent top-out), fall back to the move minimizing the resulting max
  // stack height (ties broken by score).
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

module.exports = { evaluate, pickMove };
