'use strict';
// Instrument the RAPID loop: where does the per-piece wall time actually go?
// Measures readState, runKeys (and inside it: per-dispatch await time), and wall/piece.
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');

const N = parseInt(process.argv[2] || '30', 10);

function stats(a) {
  if (!a.length) return 'n/a';
  const s = a.slice().sort((x, y) => x - y);
  const avg = a.reduce((p, c) => p + c, 0) / a.length;
  return `avg ${avg.toFixed(0)} p50 ${s[Math.floor(s.length / 2)]} p90 ${s[Math.floor(s.length * 0.9)]} max ${s[s.length - 1]}`;
}

(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}

  const bot = new ZenBot(t, { ...MODES.RAPID.opts, postDropMs: 130 });
  await bot.calibrate();

  const readT = [], keysT = [], keysN = [], dispatchT = [];
  const or = bot.readState.bind(bot);
  bot.readState = async (buf) => { const t0 = Date.now(); const r = await or(buf); readT.push(Date.now() - t0); return r; };
  const ok = bot.runKeys.bind(bot);
  bot.runKeys = async (keys) => { const t0 = Date.now(); await ok(keys); keysT.push(Date.now() - t0); keysN.push(keys.length); };
  const od = t.keyDown.bind(t), ou = t.keyUp.bind(t);
  t.keyDown = async (n) => { const t0 = Date.now(); await od(n); dispatchT.push(Date.now() - t0); };
  t.keyUp = async (n) => { const t0 = Date.now(); await ou(n); dispatchT.push(Date.now() - t0); };

  const t0 = Date.now();
  await bot.run({ maxPieces: N });
  const dt = Date.now() - t0;

  console.log(`pieces ${bot.piecesPlaced} in ${(dt / 1000).toFixed(1)}s -> ${(bot.piecesPlaced / (dt / 1000)).toFixed(2)} pps`);
  console.log(`wall/piece: ${(dt / Math.max(1, bot.piecesPlaced)).toFixed(0)}ms`);
  console.log(`readState ms: ${stats(readT)}  (n=${readT.length})`);
  console.log(`runKeys ms:   ${stats(keysT)}  (n=${keysT.length}, avg keys ${(keysN.reduce((p, c) => p + c, 0) / Math.max(1, keysN.length)).toFixed(2)})`);
  console.log(`per-dispatch await ms: ${stats(dispatchT)}  (n=${dispatchT.length})`);
  console.log(`mispredicts ${bot.mispredicts}, resyncs ${bot.resyncs}`);
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
