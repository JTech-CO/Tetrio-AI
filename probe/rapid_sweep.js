'use strict';
// Live sweep for RAPID mode: run N pieces per config, measure pps + mispredicts + resyncs.
// The app must already be in ZEN gameplay. Usage: node probe/rapid_sweep.js [piecesPerConfig]
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');

const N = parseInt(process.argv[2] || '40', 10);

// Sweep order: safe -> aggressive, with a BASIC control first.
const CONFIGS = [
  { name: 'BASIC-ctl', opts: { ...MODES.BASIC.opts } },
  { name: 'R-pd145', opts: { ...MODES.RAPID.opts, postDropMs: 145 } },
  { name: 'R-pd130', opts: { ...MODES.RAPID.opts, postDropMs: 130 } },
  { name: 'R-pd120', opts: { ...MODES.RAPID.opts, postDropMs: 120 } },
  { name: 'R-pd110', opts: { ...MODES.RAPID.opts, postDropMs: 110 } },
  { name: 'R-pd100', opts: { ...MODES.RAPID.opts, postDropMs: 100 } },
];

(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}

  const bot = new ZenBot(t, { ...MODES.RAPID.opts });
  await bot.calibrate(); // throws if no ZEN field -> abort (never send keys into menus)
  console.log('calibrated:', JSON.stringify(bot.absCal));

  const results = [];
  for (const cfg of CONFIGS) {
    Object.assign(bot.opts, cfg.opts);
    const p0 = bot.piecesPlaced, m0 = bot.mispredicts, r0 = bot.resyncs;
    const t0 = Date.now();
    await bot.run({ maxPieces: p0 + N });
    const dt = (Date.now() - t0) / 1000;
    const placed = bot.piecesPlaced - p0;
    const row = {
      name: cfg.name, placed,
      pps: +(placed / dt).toFixed(2),
      mispredicts: bot.mispredicts - m0,
      resyncs: bot.resyncs - r0,
      secs: +dt.toFixed(1),
    };
    results.push(row);
    console.log(`${row.name}: ${row.placed}pc in ${row.secs}s -> ${row.pps} pps, ` +
                `mispredict ${row.mispredicts}, resync ${row.resyncs}`);
    await sleep(800); // settle between configs
  }
  console.log('\nRESULT ' + JSON.stringify(results));
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('sweep failed:', e.message); process.exit(1); });
