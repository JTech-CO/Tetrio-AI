'use strict';
// Find the game's real tap-cycle floor: replace runKeys with a PRECISE-timed version
// (hybrid setTimeout+setImmediate spin, beating Windows' ~15.6ms timer quantization)
// and sweep the per-tap cycle. mispredicts tell us when taps start getting dropped.
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');

const N = parseInt(process.argv[2] || '30', 10);

function preciseSleep(ms) {
  return new Promise((res) => {
    const target = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
    const spin = () => { if (process.hrtime.bigint() >= target) res(); else setImmediate(spin); };
    const coarse = ms - 18; // leave up to one 15.6ms timer tick for the spin phase
    if (coarse > 0) setTimeout(spin, coarse); else setImmediate(spin);
  });
}

// hold/gap in REAL ms now (not quantized).
const CONFIGS = [
  { name: 'h17g15', hold: 17, gap: 15 }, // ~cycle 36 (like today) — control
  { name: 'h17g9', hold: 17, gap: 9 },   // ~30
  { name: 'h17g5', hold: 17, gap: 5 },   // ~26
  { name: 'h17g1', hold: 17, gap: 1 },   // ~22
  { name: 'h14g1', hold: 14, gap: 1 },   // ~19
];

(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}

  const bot = new ZenBot(t, { ...MODES.RAPID.opts, postDropMs: 130 });
  await bot.calibrate();

  let HOLD = 17, GAP = 15;
  const keysT = [];
  bot.runKeys = async (keys) => {
    const t0 = Date.now();
    for (const k of keys) {
      await t.keyDown(k);
      await preciseSleep(HOLD);
      await t.keyUp(k);
      await preciseSleep(GAP);
      if (k === 'cw' || k === 'ccw' || k === '180' || k === 'hold') await preciseSleep(10);
    }
    keysT.push(Date.now() - t0);
  };

  for (const cfg of CONFIGS) {
    HOLD = cfg.hold; GAP = cfg.gap;
    keysT.length = 0;
    const p0 = bot.piecesPlaced, m0 = bot.mispredicts;
    const t0 = Date.now();
    await bot.run({ maxPieces: p0 + N });
    const dt = (Date.now() - t0) / 1000;
    const placed = bot.piecesPlaced - p0;
    const avgKeys = keysT.length ? (keysT.reduce((p, c) => p + c, 0) / keysT.length).toFixed(0) : 'n/a';
    console.log(`${cfg.name}: ${placed}pc in ${dt.toFixed(1)}s -> ${(placed / dt).toFixed(2)} pps, ` +
                `mispredict ${bot.mispredicts - m0}/${placed}, avg runKeys ${avgKeys}ms`);
    await sleep(600);
  }
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
