'use strict';
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('../src/runtime/adblock.js');
const { ZenBot } = require('../src/bot.js');
const { MODES } = require('../src/modes.js');
function stats(a){if(!a.length)return 'n/a';const s=a.slice().sort((x,y)=>x-y);const avg=a.reduce((p,c)=>p+c,0)/a.length;return `avg ${avg.toFixed(0)} p50 ${s[Math.floor(s.length/2)]} p90 ${s[Math.floor(s.length*0.9)]} max ${s[s.length-1]}`;}
(async () => {
  const t = await Tetrio.connect({ port: 9222 });
  await applyFocusSpoof(t);
  try { await applyAdblock(t); await applyCosmetics(t); await sweepAds(t); } catch {}
  const bot = new ZenBot(t, { ...MODES.RAPID.opts });
  await bot.calibrate();
  const readT = [], keysT = [], capT = [];
  const or = bot.readState.bind(bot);
  bot.readState = async (buf) => { const t0 = Date.now(); const r = await or(buf); readT.push(Date.now() - t0); return r; };
  const ok = bot.runKeys.bind(bot);
  bot.runKeys = async (keys) => { const t0 = Date.now(); await ok(keys); keysT.push(Date.now() - t0); };
  const oc = t.captureRegion.bind(t);
  t.captureRegion = async (clip, q) => { const t0 = Date.now(); const r = await oc(clip, q); capT.push(Date.now() - t0); return r; };
  const t0 = Date.now();
  await bot.run({ maxPieces: 60 });
  const dt = Date.now() - t0;
  console.log(`${bot.piecesPlaced}pc in ${(dt/1000).toFixed(1)}s -> ${(bot.piecesPlaced/(dt/1000)).toFixed(2)} pps | wall/piece ${(dt/bot.piecesPlaced).toFixed(0)}ms`);
  console.log(`capture: ${stats(capT)}`);
  console.log(`read:    ${stats(readT)}`);
  console.log(`keys:    ${stats(keysT)}`);
  console.log(`mispredict ${bot.mispredicts} resync ${bot.resyncs}`);
  await t.close();
  process.exit(0);
})().catch((e) => { console.error('failed:', e.message); process.exit(1); });
