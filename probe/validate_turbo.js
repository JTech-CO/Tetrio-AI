'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Tetrio } = require('../src/runtime/cdp');
const { applyFocusSpoof } = require('../src/runtime/focus');
const { ZenBot } = require('../src/bot');
const { MODES } = require('../src/modes');
const { loadCalibration } = require('../src/input/calibration');

async function segment(t, mode, pieces, calibration, lifecycle) {
  const bot = new ZenBot(t, { ...MODES[mode].opts, mode, calibration,
    diagnosticsDir: path.join(__dirname, 'turbo-diagnostics') });
  lifecycle.track(bot); lifecycle.checkpoint();
  await bot.calibrate();
  const start = performance.now();
  let error = null;
  try { await bot.run({ maxPieces: pieces, maxMs: pieces * 2000, onTurn: r => {
    // A fallback cannot pass TURBO acceptance. Stop at the next completed input
    // boundary instead of spending the remaining benchmark in a different mode.
    if (mode === 'TURBO' && bot.mode !== 'TURBO') bot.stop = true;
    if (r.piecesPlaced % 50 === 0) console.log(mode, r.piecesPlaced, 'pieces', bot.mode,
      bot.turboStats ? JSON.stringify(bot.turboStats) : '');
  } }); } catch (e) { error = e.message; }
  const seconds = (performance.now() - start) / 1000;
  return { requestedMode: mode, finalMode: bot.mode, pieces: bot.piecesPlaced, seconds,
    pps: bot.piecesPlaced / seconds,
    conservativePps: (bot.piecesPlaced - (bot.turboStats?.suspectPieces || 0)) / seconds,
    resyncs: bot.resyncs, mispredicts: bot.mispredicts,
    lines: bot.linesEstimate, error, turbo: bot.turboStats || null };
}

function acceptance(r, requestedPieces) {
  const s = r.turbo;
  return !!s && requestedPieces >= 500 && r.pieces === requestedPieces && r.finalMode === 'TURBO' &&
    !r.error && !s.fallbackReason && r.pps * (1 - s.suspectPieces / r.pieces) >= 5 && s.suspectPieces / r.pieces <= 0.03 &&
    s.forcedResyncs / r.pieces <= 0.01 && s.inputErrors === 0;
}

async function main() {
  const pieces = Number(process.argv[2] || 500);
  if (!Number.isInteger(pieces) || pieces < 500) throw new Error('Acceptance requires 500 or more pieces');
  const c = loadCalibration();
  let t, visual;
  const lifecycle = require('./lifecycle').probeLifecycle();
  const report = { measuredAt: new Date().toISOString(), jev: 'disabled', calibration: c,
    note: 'Sequential live segments; independent bags/boards, not identical-input A/B. Input counts are estimates; sparse mismatch windows count all affected pieces as suspect.', segments: [] };
  try {
    t = await Tetrio.connect({ port: Number(process.env.TETRIO_PORT || 9222) });
    await applyFocusSpoof(t);
    if (c.environment.visualProfile) {
      visual = await require('../src/runtime/turbo-environment').acquireTurboEnvironment(t);
      report.visualProfile = visual.applied;
    }
    if (process.argv.includes('--warmup')) {
      const b = new ZenBot(t, { ...MODES.BASIC.opts });
      lifecycle.track(b); lifecycle.checkpoint();
      await b.calibrate(); await b.run({ maxPieces: 60, maxMs: 40000 });
      lifecycle.checkpoint();
      report.warmupPieces = b.piecesPlaced;
      console.log('Warmup complete:', b.piecesPlaced);
    }
    if (!process.argv.includes('--turbo-only')) report.segments.push(await segment(t, 'RAPID', pieces, c, lifecycle));
    else report.note = 'TURBO-only live segment. Prior RAPID results are recorded separately. No warmup pieces enter the measured count or time.';
    lifecycle.checkpoint();
    const turbo = await segment(t, 'TURBO', pieces, c, lifecycle);
    report.segments.push(turbo);
    report.passed = acceptance(turbo, pieces);
    // 1000-piece endurance remains a separate required live result.
    report.enduranceRun = pieces >= 1000;
    console.log(JSON.stringify(report, null, 2));
    if (!report.passed) process.exitCode = 1;
  } catch (e) { report.error = e.message; report.passed = false; throw e; }
  finally {
    fs.writeFileSync(path.join(__dirname, `turbo-validation-${pieces}.json`), JSON.stringify(report, null, 2));
    try { if (visual) await visual.restore(); }
    finally { try { if (t) await t.close(); } finally { lifecycle.dispose(); } }
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { acceptance };
