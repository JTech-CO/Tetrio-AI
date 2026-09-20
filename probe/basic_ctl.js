'use strict';
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');
(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}
  const bot = new ZenBot(t, { ...MODES.BASIC.opts });
  await bot.calibrate();
  const t0 = Date.now();
  await bot.run({ maxPieces: 60 });
  const dt = (Date.now() - t0) / 1000;
  console.log(`BASIC: ${bot.piecesPlaced}pc in ${dt.toFixed(1)}s -> ${(bot.piecesPlaced / dt).toFixed(2)} pps, mispredict ${bot.mispredicts}, resync ${bot.resyncs}`);
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
