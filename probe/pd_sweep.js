'use strict';
// Sweep postDropMs (+settle) for RAPID with the real production code path.
// Usage: node probe/pd_sweep.js [piecesPerConfig]
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');

const N = parseInt(process.argv[2] || '40', 10);

const CONFIGS = [
  { name: 'pd120', postDropMs: 120 },
  { name: 'pd110', postDropMs: 110 },
  { name: 'pd100', postDropMs: 100 },
  { name: 'pd90', postDropMs: 90 },
  { name: 'pd100-s40', postDropMs: 100, settleMs: 40 },
];

(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}

  const bot = new ZenBot(t, { ...MODES.RAPID.opts });
  await bot.calibrate();
  console.log('calibrated. base opts:', JSON.stringify({ hold: bot.opts.tapHoldMs, gap: bot.opts.tapGapMs, kp: bot.opts.keyPenalty }));

  for (const cfg of CONFIGS) {
    Object.assign(bot.opts, { ...MODES.RAPID.opts }, cfg);
    const p0 = bot.piecesPlaced, m0 = bot.mispredicts, r0 = bot.resyncs;
    const t0 = Date.now();
    await bot.run({ maxPieces: p0 + N });
    const dt = (Date.now() - t0) / 1000;
    const placed = bot.piecesPlaced - p0;
    console.log(`${cfg.name}: ${placed}pc in ${dt.toFixed(1)}s -> ${(placed / dt).toFixed(2)} pps, ` +
                `mispredict ${bot.mispredicts - m0}/${placed}, resync ${bot.resyncs - r0}`);
    await sleep(600);
  }
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
