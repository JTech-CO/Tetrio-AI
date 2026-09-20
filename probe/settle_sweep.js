'use strict';
// Sweep settle + capture size + quality: the read is now the binding constraint.
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');

const N = parseInt(process.argv[2] || '40', 10);

const CONFIGS = [
  { name: 's35-c22', settleMs: 35, captureCell: 22 },
  { name: 's25-c22', settleMs: 25, captureCell: 22 },
  { name: 's25-c17', settleMs: 25, captureCell: 17 },
  { name: 's25-c17-q75', settleMs: 25, captureCell: 17, jpegQuality: 75 },
  { name: 's15-c17-q75', settleMs: 15, captureCell: 17, jpegQuality: 75 },
];

(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}

  const bot = new ZenBot(t, { ...MODES.RAPID.opts, postDropMs: 95 });
  await bot.calibrate();

  const readT = [];
  const or = bot.readState.bind(bot);
  bot.readState = async (buf) => { const t0 = Date.now(); const r = await or(buf); readT.push(Date.now() - t0); return r; };

  for (const cfg of CONFIGS) {
    Object.assign(bot.opts, { ...MODES.RAPID.opts, postDropMs: 95 }, cfg);
    await bot.calibrate(); // captureCell affects the clip -> recalibrate per config
    readT.length = 0;
    const p0 = bot.piecesPlaced, m0 = bot.mispredicts, r0 = bot.resyncs;
    const t0 = Date.now();
    await bot.run({ maxPieces: p0 + N });
    const dt = (Date.now() - t0) / 1000;
    const placed = bot.piecesPlaced - p0;
    const avgRead = readT.length ? (readT.reduce((p, c) => p + c, 0) / readT.length).toFixed(0) : 'n/a';
    console.log(`${cfg.name}: ${placed}pc in ${dt.toFixed(1)}s -> ${(placed / dt).toFixed(2)} pps, ` +
                `mispredict ${bot.mispredicts - m0}/${placed}, resync ${bot.resyncs - r0}, read ${avgRead}ms`);
    await sleep(600);
  }
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
