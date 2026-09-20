'use strict';
// Long validation of the FINAL RAPID preset (production MODES.RAPID, no overrides).
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');
const N = parseInt(process.argv[2] || '150', 10);
(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}
  const bot = new ZenBot(t, { ...MODES.RAPID.opts });
  await bot.calibrate();
  const t0 = Date.now();
  let last = t0;
  await bot.run({ maxPieces: N, onTurn: (r) => {
    if (r.piecesPlaced % 30 === 0) {
      const now = Date.now();
      console.log(`  ${r.piecesPlaced}pc | recent ${(30 / ((now - last) / 1000)).toFixed(2)} pps | mispredict ${r.mispredicts} | resync ${bot.resyncs} | stageup ${r.stageUps}`);
      last = now;
    }
  }});
  const dt = (Date.now() - t0) / 1000;
  console.log(`TOTAL: ${bot.piecesPlaced}pc in ${dt.toFixed(1)}s -> ${(bot.piecesPlaced / dt).toFixed(2)} pps, ` +
              `mispredict ${bot.mispredicts}, resync ${bot.resyncs}, lines ${bot.linesEstimate}, stageups ${bot.stageUps}`);
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
