'use strict';
const { performance } = require('node:perf_hooks');
const { Vision } = require('./vision/vision');
const { extractCurrentPiece } = require('./vision/pieces');
const { fromObservation, applyMove, knownQueue } = require('./state');
const { pickMove } = require('./ai');
const { planInput } = require('./input/planner');
const { InputExecutor } = require('./input/executor');
const { loadCalibration, validateCalibration, calibrationStatus, viewportKey } = require('./input/calibration');
const { preciseSleep, sleep } = require('./runtime/cdp');
const { HIDDEN, HEIGHT, WIDTH } = require('./board');

function visible(board) {
  return Array.from({ length: HEIGHT - HIDDEN }, (_, y) =>
    Array.from({ length: WIDTH }, (_, x) => !!(board.rows[y + HIDDEN] & (1 << x))));
}
function matches(state, observation) {
  if (observation.transition) return false;
  if (state.sequence !== observation.sequence) return false;
  const expected = visible(state.board);
  if (expected.some((r, y) => r.some((v, x) => v !== !!observation.stackFilled[y]?.[x]))) return false;
  if (observation.current && observation.current !== state.current) return false;
  if (observation.full) {
    if (observation.hold !== state.hold) return false;
    if (observation.queue.length < state.queue.length) return false;
    if (state.queue.some((p, i) => p !== observation.queue[i])) return false;
  }
  return true;
}

function fieldView(bot) {
  const a = bot.absCal, d = bot.dpr, s = bot.captureScale;
  const top = a.fieldBottom - (a.fieldRight - a.fieldLeft) * 2;
  const clip = { x: Math.floor(a.fieldLeft / d), y: Math.floor(top / d),
    w: Math.ceil(a.fieldRight / d) - Math.floor(a.fieldLeft / d),
    h: Math.ceil(a.fieldBottom / d) - Math.floor(top / d), scale: s };
  const vision = new Vision({ ...bot.cal,
    fieldLeft: (a.fieldLeft - clip.x * d) * s,
    fieldRight: (a.fieldRight - clip.x * d) * s,
    fieldBottom: (a.fieldBottom - clip.y * d) * s,
    screenshotW: Math.round(clip.w * d * s), screenshotH: Math.round(clip.h * d * s) });
  return { clip, vision };
}

async function observe(bot, capture, sequence, full) {
  const started = performance.now();
  const view = full ? { clip: bot.clip, vision: bot.vision } : fieldView(bot);
  let image;
  try {
    image = await capture.captureRegion(view.clip, bot.opts.jpegQuality, { timeoutMs: bot.opts.verifyTimeoutMs });
  } catch (e) {
    // One slow frame (renderer jitter) must not end TURBO for the whole session. bot.js backs
    // the hand-back off each time, so a persistently slow window mostly stays in RAPID.
    if (/timeout/.test(e.message)) Object.assign(e, { resumable: true, slowCapture: true });
    throw e;
  }
  const extracted = extractCurrentPiece(view.vision.readBoard(image).filled);
  return { sequence, full, stackFilled: extracted.stackFilled,
    transition: full && !!view.vision.readLevelTransition?.(image),
    current: extracted.piece?.letter || (full && view.vision.readSpawnPiece?.(image)) || null,
    queue: full ? knownQueue(view.vision.readQueue(image)) : null,
    hold: full ? view.vision.readHold(image) : null,
    latencyMs: performance.now() - started };
}

async function verifyObservation(bot, capture, state, full) {
  const start = performance.now();
  let observation, transientFrames = 0;
  // Line-clear flashes can temporarily desaturate occupied cells. Keep the input
  // fence closed and re-read; never repair the observation from the prediction.
  do {
    const remaining = bot.opts.verifyTimeoutMs - (performance.now() - start);
    if (remaining <= 0) break;
    if (observation && remaining < observation.latencyMs + 20) break;
    const viewBot = { ...bot, opts: { ...bot.opts, verifyTimeoutMs: Math.max(1, remaining) } };
    observation = await observe(viewBot, capture, state.sequence, full);
    if (observation.transition || matches(state, observation)) break;
    transientFrames++;
    full = true; // A narrow board clip cannot see LEVEL COMPLETE in the margins.
    await preciseSleep(20);
  } while (performance.now() - start < bot.opts.verifyTimeoutMs);
  if (!observation) throw new Error('verification deadline exceeded');
  return { ...observation, latencyMs: performance.now() - start, transientFrames };
}

// Each window size needs its own measured input profile; a size without one is measured here,
// once. A size whose safest setting already failed is not retried automatically (the probe
// can still re-measure it). Returns true when it calibrated.
async function ensureCalibration(bot) {
  if (bot.opts.calibration || bot.opts.calibrationPath) return false;
  const vp = await bot.t.viewport();
  const status = calibrationStatus(vp);
  if (status.state === 'valid') return false;
  if (status.state === 'failed') {
    throw new Error(`이 창 크기(${viewportKey(vp)})는 자동 보정에서 TURBO 타이밍이 맞지 않았습니다 `
      + `(${status.record.lastError}). 창 크기를 바꾸거나, 이 크기로 다시 재려면 npm run turbo:calibrate`);
  }
  console.log(`  ⚙ 이 창 크기(${viewportKey(vp)})의 TURBO 보정이 없어 자동 보정합니다 — 2~4분, 창을 가리지 마세요.`);
  const { best, attempts } = await require('./input/autocalibrate').calibrateInputs(bot, {
    visualProfile: bot.visualEnv?.applied, log: line => console.log('    ' + line) });
  const placed = attempts.reduce((n, a) => n + (a.evidence?.pieces || 0), 0);
  console.log(`  ✓ 자동 보정 완료: spawn ${best.spawnMs}ms${best.overlap ? ' + 회전·이동 동시 입력' : ''}`
    + ` (보정 중 놓은 ${placed}피스는 통계에 넣지 않음)`);
  return true;
}

async function bootstrap(bot, sequence) {
  bot.current = null;
  const deadline = performance.now() + 15000;
  while (!bot.stop && performance.now() < deadline) {
    const st = await bot.readState();
    if (st.buf && bot.vision.readLevelTransition?.(st.buf)) {
      bot.current = null; await sleep(100); continue;
    }
    if (st.current && knownQueue(st.queue).length >= 2) return fromObservation(st, sequence);
    await sleep(60);
  }
  throw new Error('TURBO could not identify current/NEXT from pixels');
}

async function waitForStableState(bot, capture, sequence) {
  const deadline = performance.now() + (bot.opts.settleTimeoutMs || 10000);
  let previous = null, stableReads = 0;
  while (!bot.stop && performance.now() < deadline) {
    const obs = await observe(bot, capture, sequence, true);
    if (!obs.transition && obs.current && obs.queue.length >= 2) {
      const signature = JSON.stringify([obs.stackFilled, obs.current, obs.hold, obs.queue]);
      stableReads = signature === previous ? stableReads + 1 : 1;
      if (stableReads >= 3) return fromObservation(obs, sequence);
      previous = signature;
    } else { previous = null; stableReads = 0; }
    await sleep(100);
  }
  // A new stage can take tens of seconds to become readable again. TURBO sends nothing while
  // it waits, whereas RAPID keeps playing through it — so let RAPID bridge it and come back.
  throw Object.assign(new Error('ZEN level transition did not settle'), { resumable: true });
}

// TURBO loop: plans pieces ahead and checks the screen in the background. At most one check is
// in flight, and no input goes out past a check that hasn't finished.
async function runTurbo(bot, { maxPieces = Infinity, maxMs = Infinity, onTurn = null } = {}) {
  let c;
  const viewportMatches = vp => ['w', 'h', 'dpr'].every(k => vp[k] === c.environment.viewport[k]);
  const executor = new InputExecutor(bot.t);
  bot.inputExecutor = executor;
  let start = performance.now();
  const initialPieces = bot.piecesPlaced;
  const metrics = bot.turboStats = { verified: 0, fullReads: 0, boardReads: 0, mismatchWindows: 0,
    suspectPieces: 0, forcedResyncs: 0, inputErrors: 0, verificationLatencyMs: 0,
    effectivePps: 0, transientFrames: 0, stageTransitions: 0, fallbackReason: null, sequence: bot.piecesPlaced };
  let capture, visual, pending = null, plans = [], state, readyAt = start;
  let sinceVerify = 0, sinceFull = 0, mismatchStreak = 0, lastRecal = bot.piecesPlaced;
  let lastSweep = performance.now();
  const remainingMs = () => Math.max(0, maxMs - (performance.now() - start));
  const recoverLevel = async () => {
    plans = []; await executor.releaseAll();
    // The verification window may include ignored inputs during the transition.
    // Count the ENTIRE window as uncertain rather than inflating confirmed PPS.
    metrics.suspectPieces += sinceVerify;
    metrics.stageTransitions++; bot.stageUps++; bot.resyncs++; metrics.forcedResyncs++;
    state = await waitForStableState(bot, capture, state.sequence);
    bot.current = state.current;
    sinceVerify = 0; sinceFull = 0; mismatchStreak = 0;
  };
  try {
    // Measuring a new window size takes minutes; that is not TURBO play time.
    if (await ensureCalibration(bot)) start = readyAt = performance.now();
    const vp = await bot.t.viewport();
    c = validateCalibration(bot.opts.calibration || loadCalibration(bot.opts.calibrationPath, vp));
    if (!viewportMatches(vp)) throw new Error('TURBO viewport changed; recalibrate inputs');
    // When the session already pinned the profile for every mode, reuse it: acquiring again
    // would capture the ALREADY-PINNED values as the user's originals and lose them, and
    // restoring at the end of this segment would un-pin a session that is still playing.
    if (c.environment.visualProfile && !bot.visualEnv) {
      visual = await require('./runtime/turbo-environment').acquireTurboEnvironment(bot.t);
      bot.turboVisual = visual;
      await sleep(50);
      await bot.calibrate();
    }
    capture = await bot.t.captureSession();
    state = await bootstrap(bot, bot.piecesPlaced);
    while (!bot.stop && !bot.pendingMode && bot.piecesPlaced < maxPieces && remainingMs() > 0) {
      if (pending) {
        const result = await pending; pending = null;
        if (result.error) throw result.error;
        const obs = result.observation;
        metrics.verificationLatencyMs = obs.latencyMs;
        metrics.transientFrames += obs.transientFrames || 0;
        if (obs.transition) { await recoverLevel(); continue; }
        if (!matches(state, obs)) {
          if (bot.opts.diagnosticsDir) {
            const fs = require('node:fs'), path = require('node:path');
            fs.mkdirSync(bot.opts.diagnosticsDir, { recursive: true });
            const stem = path.join(bot.opts.diagnosticsDir, `mismatch-${state.sequence}`);
            fs.writeFileSync(stem + '.json', JSON.stringify({ expected: { ...state, board: visible(state.board) },
              observed: obs, calibration: bot.absCal }, null, 2));
            fs.writeFileSync(stem + '.png', await bot.t.screenshot());
          }
          metrics.mismatchWindows++; metrics.suspectPieces += sinceVerify;
          bot.mispredicts++; bot.resyncs++; metrics.forcedResyncs++;
          plans = []; await executor.releaseAll();
          if (++mismatchStreak >= bot.opts.maxMismatchStreak) throw new Error('consecutive verification mismatches');
          // A delayed transition can appear after the verification deadline. A
          // single bootstrap frame may contain a half-faded HOLD/queue and a false
          // current mino. Require stable full observations for every resync.
          state = await waitForStableState(bot, capture, state.sequence);
          bot.current = state.current;
          sinceFull = 0;
        } else {
          metrics.verified++; mismatchStreak = 0;
          if (obs.full) {
            state = { ...state, queue: obs.queue.slice() };
            // Refreshed lookahead can change the optimal move. Discard old plans.
            plans = []; sinceFull = 0;
          }
        }
        sinceVerify = 0;
      }
      if (bot.piecesPlaced - lastRecal >= bot.opts.recalibrateEvery) {
        lastRecal = bot.piecesPlaced;
        if (!viewportMatches(await bot.t.viewport())) {
          throw new Error('viewport changed during TURBO');
        }
        // Successful pixel checks already validate this geometry. Re-detecting white
        // borders mid-animation can select a transient smaller frame and discards a
        // known current piece. Refresh the preview without replacing verified state.
        const obs = await verifyObservation(bot, capture, state, true);
        if (obs.transition) { await recoverLevel(); continue; }
        if (!matches(state, obs)) throw new Error('periodic geometry/state verification failed');
        state = { ...state, queue: obs.queue.slice() };
        plans = []; sinceFull = 0; sinceVerify = 0;
        metrics.verified++; metrics.fullReads++;
      }
      if (performance.now() - lastSweep >= bot.opts.sweepEveryMs) {
        lastSweep = performance.now();
        require('./runtime/adblock').sweepAds(bot.t).catch(() => {});
      }
      let future = plans.length ? plans[plans.length - 1].after : state;
      while (plans.length < Math.min(2, bot.opts.predictDepth) && future.queue.length >= 2) {
        const mv = pickMove({ ...future, beam: bot.opts.aiBeam,
          estimateInput: m => planInput(m, c).estimatedInputMs, inputPenalty: bot.opts.inputPenalty,
          strategy: bot.opts.strategy });
        if (!mv || mv.expectedResult.toppedOut) throw new Error('unsafe predicted stack');
        const after = applyMove(future, mv);
        plans.push({ sequence: future.sequence, mv, after, plan: planInput(mv, c) });
        future = after;
      }
      const entry = plans.shift();
      if (!entry || entry.sequence !== state.sequence) throw new Error('prediction queue exhausted or stale');
      if (Math.max(...state.board.heights()) >= 12) {
        // Not a timing failure: RAPID takes the stretch where every piece needs a fresh look,
        // and hands back once the stack is low again (bot.js TURBO_RESUME_HEIGHT).
        throw Object.assign(new Error('high stack requires RAPID observation'), { resumable: true });
      }
      if (bot.stop || bot.pendingMode || remainingMs() <= 0) break;
      let executed;
      try { executed = await executor.execute(entry.plan, { startAt: readyAt, shouldStop: () => bot.stop }); }
      catch (e) { if (!bot.stop) metrics.inputErrors++; throw e; }
      state = entry.after;
      bot.current = state.current; bot.piecesPlaced++; bot.linesEstimate += entry.mv.expectedResult.linesCleared;
      if (entry.mv.expectedResult.linesCleared === 4) bot.quads = (bot.quads || 0) + 1;
      metrics.sequence = state.sequence; sinceVerify++; sinceFull++;
      // Spawn margin starts at hard-drop keydown, not after the hard-drop keyup/RTT.
      readyAt = executed.dropAt + c.spawnMs;
      const clear = entry.mv.expectedResult.linesCleared > 0;
      const full = sinceFull >= bot.opts.verifyEvery || state.queue.length < 2;
      if (full || clear || entry.mv.useHold || Math.max(...state.board.heights()) >= 10 || bot.opts.verifyEvery === 1) {
        if (full) metrics.fullReads++; else metrics.boardReads++;
        const snapshotSequence = state.sequence;
        const snapshotState = state;
        const settleAt = executed.dropAt + (clear ? c.settleClearMs : c.settleMs);
        pending = (async () => {
          await preciseSleep(Math.max(0, settleAt - performance.now()));
          const observation = await verifyObservation(bot, capture, snapshotState, full);
          if (observation.sequence !== snapshotSequence) throw new Error('stale observation');
          return { observation };
        })().catch(error => ({ error }));
        if (clear) { plans = []; readyAt = Math.max(readyAt, settleAt); }
      }
      metrics.effectivePps = (bot.piecesPlaced - initialPieces) * 1000 / (performance.now() - start);
      if (onTurn) onTurn({ mv: entry.mv, piecesPlaced: bot.piecesPlaced, linesEstimate: bot.linesEstimate,
        stageUps: bot.stageUps, resyncs: bot.resyncs, mispredicts: bot.mispredicts, turbo: { ...metrics } });
      // Fill at most one successor while capture/spawn are pending. Do not carry a
      // plan over a clear, and never invent unseen NEXT pieces.
      if (!clear && !plans.length && state.queue.length >= 2 && !bot.stop && !bot.pendingMode && bot.piecesPlaced < maxPieces) {
        const mv = pickMove({ ...state, beam: bot.opts.aiBeam,
          estimateInput: m => planInput(m, c).estimatedInputMs, inputPenalty: bot.opts.inputPenalty,
          strategy: bot.opts.strategy });
        if (mv && !mv.expectedResult.toppedOut) plans.push({ sequence: state.sequence,
          mv, after: applyMove(state, mv), plan: planInput(mv, c) });
      }
    }
    if (pending) {
      const result = await pending; pending = null;
      if (result.error) throw result.error;
      if (result.observation.transition) await recoverLevel();
      else if (!matches(state, result.observation)) {
        metrics.mismatchWindows++; metrics.suspectPieces += sinceVerify; bot.mispredicts++;
        throw new Error('final verification mismatch');
      }
      metrics.verified++; sinceVerify = 0;
    }
    // Always verify the tail; otherwise a finite 500-piece run could hide its last errors.
    if (state && sinceVerify > 0 && !bot.stop) {
      await preciseSleep(Math.max(0, readyAt - performance.now()));
      const obs = await verifyObservation(bot, capture, state, true);
      if (obs.transition) await recoverLevel();
      else if (!matches(state, obs)) {
        metrics.mismatchWindows++; metrics.suspectPieces += sinceVerify; bot.mispredicts++;
        throw new Error('final verification mismatch');
      }
      metrics.verified++;
    }
  } catch (e) {
    if (!bot.stop) {
      metrics.fallbackReason = e.message;
      console.warn('[TURBO → RAPID]', e.message);
      // Only an automatic handoff comes back; a mode the user picked meanwhile stays picked.
      bot.resumeTurbo = !!e.resumable && !bot.pendingMode;
      bot.fellBackAt = bot.piecesPlaced;
      if (e.slowCapture) bot.slowCaptures = (bot.slowCaptures || 0) + 1;
      bot.pendingMode = bot.pendingMode || bot.opts.turboFallback;
      bot.current = null; bot.lastPredicted = null;
    }
  } finally {
    executor.cancel();
    try { await executor.releaseAll(); }
    finally {
      if (pending) await pending;
      try { if (capture) await capture.close(); }
      finally {
        try { if (visual) await visual.restore(); }
        finally {
          bot.turboVisual = null;
          bot.inputExecutor = null;
          metrics.effectivePps = (bot.piecesPlaced - initialPieces) * 1000 / (performance.now() - start);
        }
      }
    }
  }
}

module.exports = { runTurbo, observe, verifyObservation, matches, visible, bootstrap, waitForStableState };
