'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { Tetrio } = require('../src/runtime/cdp');
const { applyFocusSpoof } = require('../src/runtime/focus');
const { ZenBot } = require('../src/bot');
const { MODES } = require('../src/modes');
const { loadCalibration, validateCalibration, DEFAULT_PATH } = require('../src/input/calibration');
const { measure } = require('./turbo_calibrate');

async function main() {
  const spawnMs = Number(process.argv[2] || 95);
  const pieces = Number(process.argv[3] || 120);
  const c = { ...loadCalibration(), spawnMs, overlap: process.argv.includes('--overlap') };
  let t, visual;
  const lifecycle = require('./lifecycle').probeLifecycle();
  try {
    t = await Tetrio.connect();
    await applyFocusSpoof(t);
    visual = await require('../src/runtime/turbo-environment').acquireTurboEnvironment(t);
    c.environment = { ...c.environment, visualProfile: visual.applied };
    if (process.argv.includes('--warmup')) {
      const warmup = new ZenBot(t, { ...MODES.BASIC.opts });
      lifecycle.track(warmup); lifecycle.checkpoint();
      await warmup.calibrate();
      await warmup.run({ maxPieces: 60, maxMs: 40000 });
      lifecycle.checkpoint();
      console.log('Warmup complete:', warmup.piecesPlaced, 'pieces');
    }
    const bot = new ZenBot(t, { ...MODES.TURBO.opts });
    lifecycle.track(bot); lifecycle.checkpoint();
    await bot.calibrate();
    c.environment = { ...c.environment, viewport: await t.viewport(), measuredAt: new Date().toISOString() };
    c.evidence = await measure(bot, c, pieces);
    lifecycle.checkpoint();
    c.validated = !c.evidence.error && c.evidence.pieces >= 100 && c.evidence.mismatches === 0 &&
      (!c.overlap || c.evidence.overlapped >= 20);
    fs.writeFileSync(path.join(__dirname, 'turbo-trial.json'), JSON.stringify(c, null, 2));
    console.log(JSON.stringify({ ...c, evidence: { ...c.evidence, lastMismatch: c.evidence.lastMismatch ?
      { sequence: c.evidence.lastMismatch.sequence, clear: c.evidence.lastMismatch.clear,
        matchesAfter250Ms: c.evidence.lastMismatch.matchesAfter250Ms } : undefined } }, null, 2));
    if (c.validated && process.argv.includes('--save')) {
      validateCalibration(c); fs.writeFileSync(DEFAULT_PATH, JSON.stringify(c, null, 2));
    }
    if (!c.validated) process.exitCode = 1;
  } finally {
    try { if (visual) await visual.restore(); }
    finally { try { if (t) await t.close(); } finally { lifecycle.dispose(); } }
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
