'use strict';
// Play-mode presets. Selected/switched from the CONSOLE (run.js) — no in-game overlay.
//
// BASIC — the proven stable profile: serial read-every-turn loop, ~2.4-2.6 pieces/sec,
//         ~0% misplacement (live-swept 2026-07).
// RAPID — speed profile: sustained ~3.4-3.7 pps, clean-stretch bursts up to 4.2 pps at
//         0% miss (measured 2026-07-18). Four levers on top of BASIC:
//   1. pipelineRead: the post-drop board capture AND the next pickMove run DURING the
//      spawn-margin wait (postDropMs) instead of after it — read (~58ms) + pick (~12ms)
//      leave the critical path. Self-correction (fresh read every turn) is preserved.
//   2. preciseKeys: unquantized key timing (Windows setTimeout rounds every short sleep
//      up to ~15.6ms — that alone cost ~15ms/tap).
//   3. aiBeam: depth-2 child search only for the top-N placements (offline-verified
//      quality-neutral at N=12).
//   4. keyPenalty: the AI mildly prefers placements needing fewer keystrokes.
// Measured floors (live): with preciseKeys, tapHold >= ~17 (span a 60fps frame) and
// tapGap >= ~5 (gap 1 -> ~30% dropped taps); postDrop >= ~95 spawn margin. Per-piece
// wall = keys(~105ms) + max(postDrop, settle+read+pick) + ~15ms loop overhead, so the
// structural ceiling of this input method is ~4.2-4.5 pps; the sustained average is
// dragged by line-clear settle turns, stage-up animations, and renderer/capture jitter.

const MODES = {
  BASIC: {
    key: 'BASIC',
    label: 'BASIC — 안정 우선: ~2.6 피스/초, 오배치 ~0% (검증됨)',
    opts: {
      preciseKeys: false,  // proven quantized timing — do not change BASIC
      tapHoldMs: 14,
      tapGapMs: 10,
      afterRotateMs: 14,
      postDropMs: 120,
      pipelineRead: false,
      settleMs: 60,        // unused while pipelineRead is off
      settleClearMs: 160,
      keyPenalty: 0,
    },
  },
  RAPID: {
    key: 'RAPID',
    label: 'RAPID — 속도 우선: 지속 ~3.5 · 순간 ~4.2 피스/초, 오배치 ~3% (자가 교정됨)',
    opts: {
      preciseKeys: true,   // unquantized key timing (see cdp.js preciseSleep)
      tapHoldMs: 17,       // REAL ms: span a 60fps frame (16.7ms)
      tapGapMs: 5,         // REAL ms floor — gap 1 drops ~30% of taps (measured live)
      afterRotateMs: 10,
      postDropMs: 95,      // keys go out max(postDropMs, settleMs+read+pick) after the drop
      pipelineRead: true,
      settleMs: 15,        // wait before the pipelined capture (stack must be rendered)
      settleClearMs: 70,   // longer when the drop cleared lines (clear animation)
      captureCell: 17,     // smaller capture -> ~58ms reads (22 -> ~72ms)
      keyPenalty: 1.0,     // Dellacherie scale: ~7.9/hole — offline-checked quality-neutral
      aiBeam: 12,          // prune depth-2 search to top-12 placements (~35ms -> ~12ms)
    },
  },
};

// '1' | 'basic' | 'BASIC' -> 'BASIC'; '2' | 'rapid' -> 'RAPID'; else null.
function resolveMode(input) {
  if (!input) return null;
  const s = String(input).trim().toUpperCase();
  if (s === '1' || s === 'B' || s === 'BASIC') return 'BASIC';
  if (s === '2' || s === 'R' || s === 'RAPID') return 'RAPID';
  return MODES[s] ? s : null;
}

module.exports = { MODES, resolveMode };
