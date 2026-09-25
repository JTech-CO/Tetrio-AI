'use strict';
// Speed presets (modes) and line-clear strategies, chosen from the console (run.js).
// BASIC reads the screen before every piece. RAPID reads and decides while it waits for the
// next piece, with precise key timing. TURBO plans pieces ahead (src/turbo.js).

const MODES = {
  BASIC: {
    key: 'BASIC',
    label: 'BASIC — 안정 우선: ~2.6 피스/초, 오배치 ~0% (검증됨)',
    opts: {
      preciseKeys: false,  // BASIC keeps plain setTimeout timing
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
      preciseKeys: true,   // see cdp.js preciseSleep
      tapHoldMs: 17,       // at least one 60fps frame, or the game can miss the key
      tapGapMs: 5,         // shorter gaps drop taps
      afterRotateMs: 10,
      postDropMs: 95,      // earliest next input after a hard drop
      pipelineRead: true,
      settleMs: 15,        // wait before reading, so the dropped piece is drawn
      settleClearMs: 70,   // longer when the drop cleared lines (clear animation)
      captureCell: 17,     // capture pixels per cell; smaller reads faster
      keyPenalty: 1.0,     // prefer placements that need fewer key presses
      aiBeam: 12,          // look ahead only from the best 12 placements
    },
  },
};

MODES.TURBO = {
  key: 'TURBO',
  label: 'TURBO — 실험용 예측 실행 (입력 보정 필수, 목표 5.0+ PPS)',
  opts: { ...MODES.RAPID.opts, predictDepth: 2, verifyEvery: 4, inputPenalty: 0.01,
    turboFallback: 'RAPID', verifyTimeoutMs: 400, maxMismatchStreak: 2 },
};

// Line-clear strategy, independent of the mode. SINGLE clears lines as soon as it can; QUAD
// keeps the right column open and clears four rows at once with an I (src/ai.js).
const STRATEGIES = {
  SINGLE: { key: 'SINGLE', label: 'SINGLE — 줄이 차는 대로 바로 클리어 (대부분 1줄)' },
  QUAD: { key: 'QUAD', label: 'QUAD — 오른쪽 끝 열을 비워 두고 I 미노로 4줄 한 번에 클리어' },
};

// 's' | 'single' -> 'SINGLE'; 'q' | 'quad' -> 'QUAD'; else null.
function resolveStrategy(input) {
  if (!input) return null;
  const s = String(input).trim().toUpperCase();
  if (s === 'S' || s === 'SINGLE') return 'SINGLE';
  if (s === 'Q' || s === 'QUAD') return 'QUAD';
  return null;
}

// '1' | 'basic' | 'BASIC' -> 'BASIC'; '2' | 'rapid' -> 'RAPID'; else null.
function resolveMode(input) {
  if (!input) return null;
  const s = String(input).trim().toUpperCase();
  if (s === '1' || s === 'B' || s === 'BASIC') return 'BASIC';
  if (s === '2' || s === 'R' || s === 'RAPID') return 'RAPID';
  if (s === '3' || s === 'T' || s === 'TURBO') return 'TURBO';
  return MODES[s] ? s : null;
}

// Console command: [speed]-[strategy], both always given. '1-s' -> BASIC + SINGLE,
// '2-q' -> RAPID + QUAD, 'turbo-quad' also works; anything else -> null.
function resolveCommand(input) {
  const parts = String(input || '').split('-');
  if (parts.length !== 2) return null;
  const mode = resolveMode(parts[0]), strategy = resolveStrategy(parts[1]);
  return mode && strategy ? { mode, strategy } : null;
}

// The short command that selects this pair, e.g. ('RAPID', 'QUAD') -> '2-q'.
function commandCode(mode, strategy) {
  return `${Object.keys(MODES).indexOf(mode) + 1}-${strategy[0].toLowerCase()}`;
}

module.exports = { MODES, resolveMode, STRATEGIES, resolveStrategy, resolveCommand, commandCode };
