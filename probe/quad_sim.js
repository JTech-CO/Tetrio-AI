'use strict';
// Offline comparison of the SINGLE and QUAD strategies: 7-bag, 5 NEXT previews and hold, the
// same pickMove call the bot makes. No game needed.
//
//   node probe/quad_sim.js [--pieces 3000] [--seeds 5] [--beam 12] [--key-penalty 1]
//
// Per strategy it reports lines per piece, clears by size, the share of lines cleared as quads,
// guideline score (100/300/500/800, back-to-back quad x1.5), stack height, and how often the
// stack reaches TURBO's per-piece verification (10) and RAPID hand-off (12) heights.

const { Board, PIECE_NAMES } = require('../src/board');
const { pickMove } = require('../src/ai');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i < 0 ? def : Number(process.argv[i + 1]);
}
const PIECES = arg('--pieces', 3000), SEEDS = arg('--seeds', 5);
const BEAM = arg('--beam', 12), KEY_PENALTY = arg('--key-penalty', 1);

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function bagStream(seed) {
  const rand = rng(seed); let bag = [];
  return () => {
    if (!bag.length) {
      bag = PIECE_NAMES.slice();
      for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; }
    }
    return bag.pop();
  };
}
const maxH = b => Math.max(...b.heights());

function play(strategy, seed) {
  const next = bagStream(seed);
  let board = new Board(), current = next(), hold = null, b2b = false;
  const queue = [next(), next(), next(), next(), next()];
  const s = { pieces: 0, lines: 0, clears: [0, 0, 0, 0, 0], score: 0, topouts: 0, heightSum: 0,
    maxHeight: 0, at10: 0, at12: 0 };
  while (s.pieces < PIECES) {
    const mv = pickMove({ board, current, queue, hold, canHold: hold ? true : queue.length >= 2,
      keyPenalty: KEY_PENALTY, beam: BEAM, strategy });
    if (!mv || mv.expectedResult.lockOut) { s.topouts++; board = new Board(); continue; }
    if (mv.useHold) {
      if (hold) { hold = current; }
      else { hold = current; queue.shift(); queue.push(next()); }
    }
    board = mv.expectedResult.board;
    current = queue.shift(); queue.push(next());
    const n = mv.expectedResult.linesCleared;
    s.pieces++; s.lines += n; s.clears[n]++;
    if (n) {
      const base = [0, 100, 300, 500, 800][n];
      s.score += n === 4 && b2b ? base * 1.5 : base;
      b2b = n === 4;
    }
    const h = maxH(board);
    s.heightSum += h; s.maxHeight = Math.max(s.maxHeight, h);
    if (h >= 10) s.at10++;
    if (h >= 12) s.at12++;
  }
  return s;
}

for (const strategy of ['SINGLE', 'QUAD']) {
  const t0 = Date.now();
  const all = [];
  for (let seed = 1; seed <= SEEDS; seed++) all.push(play(strategy, seed));
  const sum = k => all.reduce((a, s) => a + s[k], 0);
  const pieces = sum('pieces'), lines = sum('lines');
  const clears = [1, 2, 3, 4].map(n => all.reduce((a, s) => a + s.clears[n], 0));
  console.log(`${strategy.padEnd(6)} 라인/피스 ${(lines / pieces).toFixed(3)} | 1/2/3/4줄 ${clears.join('/')} | `
    + `쿼드 라인 비율 ${(100 * clears[3] * 4 / Math.max(1, lines)).toFixed(1)}% | 점수/피스 ${(sum('score') / pieces).toFixed(1)} | `
    + `평균 높이 ${(sum('heightSum') / pieces).toFixed(2)} 최대 ${Math.max(...all.map(s => s.maxHeight))} | `
    + `≥10 ${(100 * sum('at10') / pieces).toFixed(2)}% ≥12 ${(100 * sum('at12') / pieces).toFixed(2)}% | `
    + `탑아웃 ${sum('topouts')} | ${((Date.now() - t0) / pieces).toFixed(2)}ms/피스`);
}
