'use strict';
// Live ZEN calibration: consecutive two-piece bursts expose spawn timing errors that
// a capture after EVERY piece would mask. No timing profile is saved as valid on failure.
const fs = require('node:fs');
const { performance } = require('node:perf_hooks');
const { Tetrio, preciseSleep } = require('../src/runtime/cdp');
const { applyFocusSpoof } = require('../src/runtime/focus');
const { ZenBot } = require('../src/bot');
const { MODES } = require('../src/modes');
const { pickMove } = require('../src/ai');
const { applyMove } = require('../src/state');
const { planInput } = require('../src/input/planner');
const { InputExecutor } = require('../src/input/executor');
const { calibrationPath, validateCalibration } = require('../src/input/calibration');
const { bootstrap, observe, verifyObservation, matches } = require('../src/turbo');

async function measure(bot, c, pieces) {
  const executor = new InputExecutor(bot.t);
  const evidence = { pieces: 0, mismatches: 0, wallLeft: 0, wallRight: 0, keys: {}, bursts: 0,
    transientFrames: 0, maxVerificationMs: 0, overlapped: 0 };
  const started = performance.now();
  let state = await bootstrap(bot, 0), lastDrop = performance.now() - c.spawnMs;
  try {
    while (!bot.stop && evidence.pieces < pieces) {
      let clear = false;
      for (let i = 0; i < 2 && evidence.pieces < pieces; i++) {
        const mv = pickMove({ ...state, beam: 12,
          estimateInput: m => planInput(m, c).estimatedInputMs, inputPenalty: 0.01 });
        if (!mv || mv.expectedResult.toppedOut || Math.max(...state.board.heights()) >= 12) {
          throw new Error('Unsafe stack during input calibration');
        }
        const plan = planInput(mv, c);
        const result = await executor.execute(plan, { startAt: lastDrop + c.spawnMs, shouldStop: () => bot.stop });
        lastDrop = result.dropAt;
        state = applyMove(state, mv); evidence.pieces++;
        for (const e of plan.events.filter(e => e.down)) evidence.keys[e.key] = (evidence.keys[e.key] || 0) + 1;
        if (plan.wallUsed === 'left') evidence.wallLeft++;
        if (plan.wallUsed === 'right') evidence.wallRight++;
        if (plan.overlapUsed) evidence.overlapped++;
        clear = mv.expectedResult.linesCleared > 0;
        // A clear is always a barrier, even in the calibration probe.
        if (clear || state.queue.length < 2) break;
      }
      await preciseSleep(Math.max(0, lastDrop + Math.max(c.spawnMs, clear ? c.settleClearMs : c.settleMs) - performance.now()));
      const obs = await verifyObservation(bot, bot.t, state, true);
      evidence.transientFrames += obs.transientFrames;
      evidence.maxVerificationMs = Math.max(evidence.maxVerificationMs, obs.latencyMs);
      evidence.bursts++;
      if (!matches(state, obs)) {
        evidence.mismatches++;
        fs.writeFileSync(require('node:path').join(__dirname, 'turbo-mismatch.png'), await bot.t.screenshot());
        const { visible } = require('../src/turbo');
        evidence.lastMismatch = { sequence: state.sequence, clear, predicted: visible(state.board),
          actual: obs.stackFilled };
        await preciseSleep(250);
        const late = await observe(bot, bot.t, state.sequence, true);
        evidence.lastMismatch.matchesAfter250Ms = matches(state, late);
        evidence.lastMismatch.late = late.stackFilled;
        console.log('  mismatch', JSON.stringify({ sequence: state.sequence, expectedCurrent: state.current,
          actualCurrent: obs.current, expectedHold: state.hold, actualHold: obs.hold,
          expectedQueue: state.queue, actualQueue: obs.queue }));
        break;
      }
      if (obs.queue.length < 2) throw new Error('Incomplete NEXT preview during calibration');
      state = { ...state, queue: obs.queue };
    }
    return { ...evidence, seconds: (performance.now() - started) / 1000 };
  } catch (e) {
    return { ...evidence, error: e.message, seconds: (performance.now() - started) / 1000 };
  } finally { await executor.releaseAll(); }
}

async function main() {
  const pieces = Number(process.argv[2] || 120);
  if (!Number.isInteger(pieces) || pieces < 100) throw new Error('Use at least 100 calibration pieces');
  const port = Number(process.env.TETRIO_PORT || 9222);
  let t, visual, target;
  const lifecycle = require('./lifecycle').probeLifecycle();
  const attempts = [];
  try {
    t = await Tetrio.connect({ port });
    await applyFocusSpoof(t);
    visual = await require('../src/runtime/turbo-environment').acquireTurboEnvironment(t);
    const bot = new ZenBot(t, { ...MODES.RAPID.opts, verifyTimeoutMs: 400 });
    lifecycle.track(bot); lifecycle.checkpoint();
    await bot.calibrate();
    const environment = { viewport: await t.viewport(), measuredAt: new Date().toISOString(), port,
      visualProfile: visual.applied };
    // Invalidate old evidence for THIS size before measuring it again; other sizes keep theirs.
    target = calibrationPath(environment.viewport);
    fs.writeFileSync(target, JSON.stringify({ version: 1, validated: false, reason: 'calibration in progress' }, null, 2));
    console.log('Calibrating viewport', JSON.stringify(environment.viewport), '->', target);
    let best = null;
    for (const spawnMs of [120, 95, 80, 65]) {
      const c = { version: 1, scope: 'ZEN', validated: false, tapHoldMs: 17, tapGapMs: 5,
        afterRotateMs: 10, spawnMs, settleMs: 15, settleClearMs: 100,
        wallHoldMs: null, precharge: false, overlap: false, environment };
      console.log(`Measuring ${pieces} pieces: spawn=${spawnMs}ms, taps=17/5ms`);
      c.evidence = await measure(bot, c, pieces);
      lifecycle.checkpoint();
      c.validated = c.evidence.pieces >= pieces && c.evidence.mismatches === 0 && !c.evidence.error;
      attempts.push(c);
      console.log(JSON.stringify({ ...c.evidence, lastMismatch: c.evidence.lastMismatch ?
        { sequence: c.evidence.lastMismatch.sequence, clear: c.evidence.lastMismatch.clear,
          matchesAfter250Ms: c.evidence.lastMismatch.matchesAfter250Ms } : undefined }));
      if (c.validated) best = c;
      else break; // do not become more aggressive after a failed floor
    }
    if (best) {
      const overlap = { ...best, overlap: true, validated: false };
      console.log('Measuring rotation + first movement overlap');
      overlap.evidence = await measure(bot, overlap, pieces);
      lifecycle.checkpoint();
      overlap.validated = !overlap.evidence.error && overlap.evidence.pieces >= pieces &&
        overlap.evidence.mismatches === 0 && overlap.evidence.overlapped >= 20;
      attempts.push(overlap);
      console.log(JSON.stringify({ ...overlap.evidence, lastMismatch: undefined }));
      if (overlap.validated) best = overlap;
      // Wall/ARR=0-style movement is a measured candidate, never an assumed setting.
      const wall = { ...best, wallHoldMs: 70, validated: false };
      console.log('Measuring wall hold candidate: 70ms');
      wall.evidence = await measure(bot, wall, pieces);
      lifecycle.checkpoint();
      wall.validated = !wall.evidence.error && wall.evidence.pieces >= pieces && wall.evidence.mismatches === 0 &&
        wall.evidence.wallLeft > 0 && wall.evidence.wallRight > 0;
      attempts.push(wall);
      if (wall.validated) best = wall;
      validateCalibration(best);
      fs.writeFileSync(target, JSON.stringify(best, null, 2));
      console.log('Saved measured profile:', target);
    } else throw new Error('No input profile passed; TURBO remains disabled');
  } finally {
    fs.writeFileSync(require('node:path').join(__dirname, 'turbo-calibration-attempts.json'), JSON.stringify(attempts, null, 2));
    try { if (visual) await visual.restore(); }
    finally { try { if (t) await t.close(); } finally { lifecycle.dispose(); } }
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
module.exports = { measure };
