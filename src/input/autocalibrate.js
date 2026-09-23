'use strict';
// Measured TURBO input calibration, shared by probe/turbo_calibrate.js and by TURBO itself when
// it starts at a window size that has no profile yet. Consecutive two-piece bursts expose spawn
// timing errors that a capture after EVERY piece would mask. Nothing is saved as valid unless
// it passed.
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { preciseSleep } = require('../runtime/cdp');
const { pickMove } = require('../ai');
const { applyMove } = require('../state');
const { planInput } = require('./planner');
const { InputExecutor } = require('./executor');
const { DIR, calibrationPath, validateCalibration } = require('./calibration');

const SPAWN_RUNGS = [120, 95, 80, 65];

async function measure(bot, c, pieces, { dir = DIR, log = console.log } = {}) {
  const { bootstrap, observe, verifyObservation, matches, visible } = require('../turbo');
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
        fs.writeFileSync(path.join(dir, 'turbo-mismatch.png'), await bot.t.screenshot());
        evidence.lastMismatch = { sequence: state.sequence, clear, predicted: visible(state.board),
          actual: obs.stackFilled };
        await preciseSleep(250);
        const late = await observe(bot, bot.t, state.sequence, true);
        evidence.lastMismatch.matchesAfter250Ms = matches(state, late);
        evidence.lastMismatch.late = late.stackFilled;
        log('  mismatch ' + JSON.stringify({ sequence: state.sequence, expectedCurrent: state.current,
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

// Measure the size `bot` is running at (its field must already be calibrated) and save the
// fastest passing profile to that size's file. Throws when nothing passed. Only a measured
// misprediction at the most conservative rung is recorded as a FAILED size — that is evidence
// TURBO timing does not hold there. An unsafe stack, an unreadable frame, a capture stall or an
// interruption says nothing about the size, so it is recorded as inconclusive and retried later.
async function calibrateInputs(bot, { pieces = 120, visualProfile, port, dir = DIR, log = console.log,
                                      checkpoint = () => {}, measureFn = measure } = {}) {
  const environment = { viewport: await bot.t.viewport(), measuredAt: new Date().toISOString(), port, visualProfile };
  const target = calibrationPath(environment.viewport, dir);
  const record = (reason, lastError) => fs.writeFileSync(target, JSON.stringify({ version: 1, validated: false,
    reason, viewport: environment.viewport, at: new Date().toISOString(), lastError }, null, 2));
  // Invalidate old evidence for THIS size before measuring it again; other sizes keep theirs.
  record('calibration in progress');
  log(`Calibrating viewport ${JSON.stringify(environment.viewport)} -> ${target}`);
  const attempts = [];
  const run = async (c, label) => {
    log(label);
    c.evidence = await measureFn(bot, c, pieces, { dir, log });
    checkpoint();
    if (bot.stop) throw new Error('calibration interrupted');
    attempts.push(c);
    const m = c.evidence.lastMismatch;
    log(JSON.stringify({ ...c.evidence, lastMismatch: m ? { sequence: m.sequence, clear: m.clear,
      matchesAfter250Ms: m.matchesAfter250Ms } : undefined }));
    return c.evidence;
  };
  try {
    let best = null;
    for (const spawnMs of SPAWN_RUNGS) {
      const c = { version: 1, scope: 'ZEN', validated: false, tapHoldMs: 17, tapGapMs: 5,
        afterRotateMs: 10, spawnMs, settleMs: 15, settleClearMs: 100,
        wallHoldMs: null, precharge: false, overlap: false, environment };
      const ev = await run(c, `Measuring ${pieces} pieces: spawn=${spawnMs}ms, taps=17/5ms`);
      c.validated = ev.pieces >= pieces && ev.mismatches === 0 && !ev.error;
      if (c.validated) { best = c; continue; }
      if (best) break; // do not become more aggressive after a failed floor
      if (ev.mismatches > 0) {
        throw Object.assign(new Error(`가장 보수적인 spawn ${spawnMs}ms 에서도 예측 불일치`), { verdict: true });
      }
      throw new Error(`판정 불가 — ${ev.error || '측정 미완료'}`);
    }
    const overlap = { ...best, overlap: true, validated: false };
    const ov = await run(overlap, 'Measuring rotation + first movement overlap');
    overlap.validated = !ov.error && ov.pieces >= pieces && ov.mismatches === 0 && ov.overlapped >= 20;
    if (overlap.validated) best = overlap;
    // Wall/ARR=0-style movement is a measured candidate, never an assumed setting.
    const wall = { ...best, wallHoldMs: 70, validated: false };
    const wv = await run(wall, 'Measuring wall hold candidate: 70ms');
    wall.validated = !wv.error && wv.pieces >= pieces && wv.mismatches === 0 && wv.wallLeft > 0 && wv.wallRight > 0;
    if (wall.validated) best = wall;
    validateCalibration(best);
    fs.writeFileSync(target, JSON.stringify(best, null, 2));
    log(`Saved measured profile: ${target}`);
    return { best, attempts };
  } catch (e) {
    record(e.verdict ? 'calibration failed' : 'calibration inconclusive', e.message);
    throw e;
  } finally {
    fs.writeFileSync(path.join(dir, 'turbo-calibration-attempts.json'), JSON.stringify(attempts, null, 2));
  }
}

module.exports = { measure, calibrateInputs, SPAWN_RUNGS };
