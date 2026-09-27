'use strict';
const { computeKeySequence, PIECES, WIDTH } = require('../board');

// Offsets are relative to the first event; dropAt is the hard-drop KEY DOWN time.
function planInput({ piece, rot, col, useHold = false }, c) {
  if (!PIECES[piece] || !Number.isInteger(rot) || rot < 0 || rot > 3 || !Number.isInteger(col)) {
    throw new Error('Invalid placement');
  }
  const meta = PIECES[piece].meta[rot];
  if (col < -meta.minX || col > WIDTH - 1 - meta.maxX) throw new Error('Column out of bounds');
  const keys = computeKeySequence(piece, rot, col);
  if (useHold) keys.unshift('hold');
  return scheduleKeys(keys, c, { left: col === -meta.minX, right: col === WIDTH - 1 - meta.maxX });
}

// One tap per key (BASIC/RAPID). Simultaneous rotate+move and holding to the wall need a
// measured TURBO profile, so they are never used here.
function planTaps(keys, c) {
  return scheduleKeys(keys, { ...c, overlap: false, wallHoldMs: null }, {});
}

function scheduleKeys(keys, c, wall) {
  const events = [];
  let at = 0, dropAt = 0;
  const tap = (key, duration) => {
    events.push({ at, key, down: true });
    if (key === 'hard') dropAt = at;
    at += duration;
    events.push({ at, key, down: false });
    if (key !== 'hard') at += c.tapGapMs;
    if (['cw', 'ccw', '180', 'hold'].includes(key)) at += c.afterRotateMs;
  };
  let wallUsed = null, overlapUsed = false;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const next = keys[i + 1];
    if (c.overlap && ['cw', 'ccw', '180'].includes(k) && ['left', 'right'].includes(next)) {
      events.push({ at, key: k, down: true }, { at, key: next, down: true });
      at += c.tapHoldMs;
      events.push({ at, key: k, down: false }, { at, key: next, down: false });
      at += c.tapGapMs + c.afterRotateMs;
      overlapUsed = true; i++; continue;
    }
    if (wall[k] && c.wallHoldMs != null) {
      let n = 1;
      while (keys[i + n] === k) n++;
      if (c.wallHoldMs < n * c.tapHoldMs + (n - 1) * c.tapGapMs) {
        tap(k, c.wallHoldMs); i += n - 1; wallUsed = k; continue;
      }
    }
    tap(k, c.tapHoldMs);
  }
  return { events, dropAt, durationMs: at, estimatedInputMs: at, wallUsed, overlapUsed };
}

module.exports = { planInput, planTaps };
