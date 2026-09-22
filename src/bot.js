'use strict';
// TETR.IO ZEN bot: read the screen each turn, decide with the Dellacherie AI,
// execute keystrokes over CDP. Full-vision-per-turn so there is no simulator drift.

const { Tetrio, sleep, preciseSleep } = require('./runtime/cdp.js');
const { applyFocusSpoof } = require('./runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('./runtime/adblock.js');
const { Vision } = require('./vision/vision.js');
const { extractCurrentPiece } = require('./vision/pieces.js');
const { Board } = require('./board.js');
const { pickMove } = require('./ai.js');
const { knownQueue } = require('./state.js');

const DEFAULTS = {
  // BASIC-mode values (see src/modes.js for the presets). Tuned on live ZEN (sweep):
  // 2.61 pps at 0% misplacement. Do NOT lower tapHoldMs below ~14 (a 60fps frame is
  // 16.7ms; a shorter keydown can fall between frame samples and be dropped —
  // measured 43% misplacement at tapHold=12). postDropMs below ~120 shrinks the spawn margin.
  tapHoldMs: 14,     // keydown duration for a single tap
  tapGapMs: 10,      // gap between taps
  afterRotateMs: 14, // extra settle after a rotate
  postDropMs: 120,   // after hard drop: lets the piece lock AND the next piece become
                     // controllable before the next read (too short -> dropped keys/misplacements)
  idleSleepMs: 60,   // sleep between polls while waiting to (re)bootstrap the current piece
  jpegQuality: 85,   // clip capture quality
  recalibrateEvery: 80, // re-detect the field frame every N pieces
  sweepEveryMs: 6000,   // remove accumulating ad iframes this often
  // RAPID-mode levers (inert in BASIC):
  pipelineRead: false, // capture the post-drop board DURING postDropMs instead of after it
  preciseKeys: false,  // unquantized key timing (Windows setTimeout rounds to ~15.6ms)
  settleMs: 60,        // pipelined: wait before capturing (stack must be rendered)
  settleClearMs: 160,  // pipelined: longer wait when the drop cleared lines (clear animation)
  keyPenalty: 0,       // AI score penalty per keystroke (prefers cheaper placements)
  aiBeam: 0,           // depth-2 child search only for top-N placements (0 = full search)
};

class ZenBot {
  constructor(t, opts = {}) {
    this.t = t;
    this.opts = { ...DEFAULTS, ...opts };
    this.modeOverrides = { ...(opts.modeOverrides || {}) };
    this.vision = null;
    this.cal = null;
    this.piecesPlaced = 0;
    this.linesEstimate = 0;
    this.stop = false;
    this.current = null;   // tracked identity of the falling piece
    this.resyncs = 0;
    this.stageUps = 0;
    this.lastStageSig = null;
    this.stageStableFrames = 0;
    this.mode = opts.mode || 'BASIC';
    this.mispredicts = 0;      // turns where the screen didn't match the previous prediction
    this.transientReads = 0;   // mismatching frames discarded before deciding the next move
    this.lastPredicted = null; // 20x10 matrix predicted by the previous placement
  }

  // Switch play-mode preset live (safe between turns — opts are re-read every iteration).
  setMode(name) {
    const { MODES } = require('./modes.js');
    const m = MODES[name && String(name).toUpperCase()];
    if (!m) return null;
    if (m.key === 'TURBO') {
      require('./input/calibration').loadCalibration(this.opts.calibrationPath);
    }
    if (this.running) { this.pendingMode = m.key; return m; }
    // Remove mode-only values when returning from TURBO/RAPID to BASIC.
    for (const preset of Object.values(MODES)) {
      for (const key of Object.keys(preset.opts)) delete this.opts[key];
    }
    for (const [key, value] of Object.entries(DEFAULTS)) {
      if (!(key in this.opts)) this.opts[key] = value;
    }
    Object.assign(this.opts, m.opts, this.modeOverrides);
    this.mode = m.key;
    return m;
  }

  static async launch(opts = {}) {
    const t = await Tetrio.connect(opts);
    try {
      await applyFocusSpoof(t);
      await applyAdblock(t);
      try { await applyCosmetics(t); await sweepAds(t); } catch (e) {}
      const bot = new ZenBot(t, opts);
      await bot.calibrate();
      return bot;
    } catch (e) {
      try { await t.close(); } catch {}
      throw e;
    }
  }

  // Calibrate from a full PNG frame-detect, then set up a tight JPEG clip around the
  // play area (HOLD..NEXT, top..stage) so the per-turn capture+decode stays fast.
  async calibrate() {
    // Retry a few times — a transient bad frame (ad still fading, mid-refresh) can defeat
    // detection; do not invent coordinates if no frame has ever been calibrated.
    let abs = null, lastErr = null;
    for (let attempt = 0; attempt < 5 && !abs; attempt++) {
      try { abs = Vision.detectFrame(await this.t.screenshot()); }
      catch (e) { lastErr = e; await sleep(600); }
    }
    if (!abs) {
      // A stage-up / line-clear animation can hide the field borders for several seconds.
      // KEEP the previous working calibration in that case — falling back to the static
      // default (a different window size) would brick every subsequent read.
      if (this.absCal) {
        console.warn('[calibrate] frame detect failed, keeping previous calibration:', lastErr && lastErr.message);
        return this.cal;
      }
      throw new Error('Field calibration failed: ' + (lastErr && lastErr.message));
    }
    // Renderer-degradation guard. Over very long sessions the app's render resolution can
    // collapse (the game content shrinks inside an unchanged window — TETR.IO/Chromium
    // downscaling under accumulated GPU/memory pressure), which quietly wrecks vision.
    // Metric = field HEIGHT as a fraction of window height. TETR.IO sizes the (square) cells to
    // the window HEIGHT and pillarboxes the sides, so this fraction is invariant to BOTH width
    // and height resizes (unlike a width fraction, which drops on an aspect-ratio change and
    // would false-fire a restart); only a real content downscale lowers it.
    const cellW0 = (abs.fieldRight - abs.fieldLeft) / abs.cols;
    const fieldFrac = (abs.rows * cellW0) / abs.screenshotH;
    if (this.fieldFracBaseline == null) this.fieldFracBaseline = fieldFrac;
    else if (fieldFrac < this.fieldFracBaseline * 0.7) {
      const e = new Error('DEGRADED: 렌더러 화면 축소 감지 (필드 높이 비율 '
        + fieldFrac.toFixed(3) + ' < 기준 ' + this.fieldFracBaseline.toFixed(3) + ') — 앱 재시작 필요');
      e.degraded = true;
      throw e;
    }
    this.absCal = abs;

    const vp = await this.t.viewport();
    const dpr = Math.max(1, Math.round(abs.screenshotW / vp.w)); // usually 2
    const cw = (abs.fieldRight - abs.fieldLeft) / abs.cols;
    const fieldTop = abs.fieldBottom - abs.rows * cw;
    // Device-pixel bounds of everything we read.
    const xMinD = Math.max(0, Math.floor(abs.fieldLeft - 5.6 * cw));
    const xMaxD = Math.min(abs.screenshotW, Math.ceil(abs.fieldRight + 7.2 * cw));
    const yMinD = Math.max(0, Math.floor(fieldTop - 2.5 * cw));
    const yMaxD = Math.min(abs.screenshotH, Math.ceil(abs.fieldBottom + 2.8 * cw));
    // Downscale the per-turn capture so the decoded image size (and decode time) is
    // independent of the window size: target ~TARGET_CELL device px per cell. Chrome's clip
    // `scale` multiplies on top of DPR, so scale=1 gives device resolution; we go below 1.
    const TARGET_CELL = this.opts.captureCell || 22; // smaller = faster decode, riskier queue ID
    const captureScale = Math.min(1, Math.max(0.28, TARGET_CELL / cw));
    this.captureScale = captureScale;
    this.clip = { x: Math.floor(xMinD / dpr), y: Math.floor(yMinD / dpr),
                  w: Math.ceil((xMaxD - xMinD) / dpr), h: Math.ceil((yMaxD - yMinD) / dpr), scale: captureScale };
    const ox = this.clip.x * dpr, oy = this.clip.y * dpr; // device origin of the clip image
    const s = captureScale; // clip-image coords are (device - origin) * captureScale
    this.cal = {
      screenshotW: Math.round(this.clip.w * dpr * s), screenshotH: Math.round(this.clip.h * dpr * s),
      fieldLeft: (abs.fieldLeft - ox) * s, fieldRight: (abs.fieldRight - ox) * s,
      fieldBottom: (abs.fieldBottom - oy) * s, cols: abs.cols, rows: abs.rows,
    };
    this.vision = new Vision(this.cal);
    this.dpr = dpr;
    return this.cal;
  }

  // Fast per-turn capture (clipped JPEG) decoded to a pngjs-like image.
  async grab() {
    return this.t.captureRegion(this.clip, this.opts.jpegQuality);
  }

  // Read the full game state from a screenshot.
  // `current` is resolved from tracking (this.current) with the board's clean 4-cell
  // read as an override/resync when they disagree.
  //  -> { filled, grid, current, currentCells, partial, stackFilled, queue, hold, hasPiece }
  async readState(buf) {
    if (!buf) buf = await this.grab();
    if (this.vision.readLevelTransition?.(buf)) {
      this.current = null;
      this.lastPredicted = null;
      return { buf, current: null, hasPiece: false, queue: [], hold: null,
        stackFilled: Array.from({ length: 20 }, () => Array(10).fill(false)), transition: true };
    }
    const { filled, grid } = this.vision.readBoard(buf);
    const { piece, stackFilled } = extractCurrentPiece(filled);
    const queue = this.vision.readQueue(buf);
    const hold = this.vision.readHold(buf);

    // Stage-change detection (the big number below the field changes when a stage clears).
    // Debounced: only count a change once the new fingerprint has settled for a couple of
    // reads, so transient animation/score jitter does not inflate the count.
    try {
      const fp = this.vision.stageFingerprint(buf);
      if (this.lastStageSig) {
        if (!Vision.stageChanged(this.lastStageSig, fp)) {
          this.stagePendingSig = null; this.stageStableFrames = 0;
        } else if (!this.stagePendingSig || Vision.stageChanged(this.stagePendingSig, fp)) {
          this.stagePendingSig = fp; this.stageStableFrames = 0;
        } else {
          // pending change persisting
          if (++this.stageStableFrames === 2) { this.stageUps++; this.lastStageSig = fp; this.stagePendingSig = null; }
        }
      } else {
        this.lastStageSig = fp;
      }
    } catch (e) {}

    // Only a CLEAN 4-cell in-field read may override tracking. The spawn strip cuts the piece
    // at the field boundary, and at RAPID's ~17px capture cells a clipped piece quantizes to a
    // different tetromino (measured: J read as I), so it may only BOOTSTRAP a missing identity.
    const boardLetter = piece?.letter
      || (this.current ? null : this.vision.readSpawnPiece?.(buf)) || null;
    let current = this.current;
    if (boardLetter) {
      if (current && current !== boardLetter) this.resyncs++; // tracking drifted; trust the screen
      current = boardLetter;
      this.current = boardLetter;
    } else if (!current && boardLetter) {
      current = boardLetter; this.current = boardLetter;
    }
    return {
      buf, filled, grid,
      current,
      currentCells: piece ? piece.cells : null,
      partial: piece ? piece.partial : false,
      stackFilled, queue, hold,
      hasPiece: piece !== null || !!boardLetter,
    };
  }

  // Advance the tracked current piece after a placement, per TETR.IO hold semantics.
  advanceCurrent(queueBefore, useHold, holdBefore) {
    if (!useHold) { this.current = queueBefore[0] || null; return; }
    // hold used this turn:
    if (holdBefore) this.current = queueBefore[0] || null;      // swap: next spawn = queue[0]
    else this.current = queueBefore[1] || null;                 // empty hold consumed queue[0]
  }

  async runKeys(keys) {
    const o = this.opts;
    if (o.preciseKeys) {
      // RAPID: precise (unquantized) timing — Windows setTimeout rounds every short sleep
      // up to ~15.6ms, which alone costs ~15ms per tap. With real timing the floors are:
      // hold >=~17 (span a 60fps frame), gap >=~5 (gap 1 -> ~30% dropped taps, measured).
      for (let i = 0; i < keys.length; i++) {
        if (this.stop) return false;
        const k = keys[i];
        try {
          await this.t.keyDown(k);
          await preciseSleep(o.tapHoldMs);
        } finally { await this.t.keyUp(k); }
        if (i === keys.length - 1) break; // no trailing gap — postDrop covers it
        await preciseSleep(o.tapGapMs);
        if (k === 'cw' || k === 'ccw' || k === '180' || k === 'hold') await preciseSleep(o.afterRotateMs);
      }
      return true;
    }
    for (const k of keys) {
      if (this.stop) return false;
      await this.t.tap(k, { holdMs: o.tapHoldMs, gapMs: o.tapGapMs });
      if (k === 'cw' || k === 'ccw' || k === '180' || k === 'hold') await sleep(o.afterRotateMs);
    }
    return true;
  }

  // Play a single piece. If verify=true, returns { predicted, actualStack, match }.
  async playOnce(state, { verify = false } = {}) {
    const st = state || await this.readState();
    if (!st.hasPiece || !st.current) {
      return { skipped: true, reason: 'no current piece detected' };
    }
    const sim = Board.fromMatrix(st.stackFilled);
    const queueBefore = knownQueue(st.queue);
    if (!queueBefore.length) return { skipped: true, reason: 'NEXT prefix incomplete' };
    const holdBefore = st.hold;
    const mv = pickMove({ board: sim, current: st.current, queue: queueBefore, hold: holdBefore,
                          canHold: holdBefore ? true : queueBefore.length >= 2 });
    if (!mv) return { skipped: true, reason: 'pickMove returned null (topout?)' };

    const predicted = mv.expectedResult.board; // Board after placement (stack incl. clears)
    if (await this.runKeys(mv.keys) === false) return { skipped: true, reason: 'stopped' };
    await sleep(this.opts.postDropMs);
    this.piecesPlaced++;
    this.linesEstimate += mv.expectedResult.linesCleared;
    this.advanceCurrent(queueBefore, mv.useHold, holdBefore);

    if (!verify) return { mv };

    // Verify: read the new stack, compare to prediction (ignore top 4 rows = spawn area).
    const after = await this.readState();
    const predMatrix = boardToVisibleMatrix(predicted);
    const actualMatrix = after.stackFilled.map(r => r.map(Boolean));
    const match = matricesEqual(predMatrix.slice(4), actualMatrix.slice(4));
    return { mv, predicted: predMatrix, actual: actualMatrix, match, after, current: st.current };
  }

  // Tracking-driven loop. TETR.IO's ZEN gravity is "relaxed" (slow), so a newly spawned piece
  // takes ~1s to fall from the hidden spawn area into the visible field — but it is controllable
  // from spawn. So we do NOT wait to SEE the piece: its identity comes from queue-tracking, the
  // per-turn board read gives the clean stack (the new piece is still hidden/entering and is
  // stripped out), and we place immediately. readState cross-checks tracking against any clean
  // visible piece (passive resync), so a rare mis-timed placement self-corrects on the next read.
  // maxMs: stop the segment after this wall-clock budget so the supervisor can do a
  // proactive "pit-stop" restart that refreshes the renderer before it degrades.
  async run({ maxPieces = Infinity, maxMs = Infinity, onTurn = null } = {}) {
    const start = Date.now();
    this.running = true;
    try {
      while (!this.stop && this.piecesPlaced < maxPieces && Date.now() - start < maxMs) {
        if (this.pendingMode) {
          const next = this.pendingMode; this.pendingMode = null;
          this.running = false;
          try { this.setMode(next); } finally { this.running = true; }
        }
        const options = { maxPieces, maxMs: Math.max(0, maxMs - (Date.now() - start)), onTurn };
        if (this.mode === 'TURBO') await require('./turbo').runTurbo(this, options);
        else await this.runLegacy(options);
        if (!this.pendingMode) break;
      }
    } finally { this.running = false; }
  }

  async runLegacy({ maxPieces = Infinity, maxMs = Infinity, onTurn = null } = {}) {
    let idle = 0, lastRecal = 0, lastSweep = Date.now();
    const runStart = Date.now();
    let idleSince = 0; // wall-clock start of the CURRENT continuous no-piece stretch (0 = playing)
    const IDLE_MAX_MS = 60000; // independent deadline: a stuck no-piece screen throws -> restart
    let pending = null; // RAPID: pipelined read promise, captured during the postDrop wait
    try {
      while (!this.stop && this.piecesPlaced < maxPieces && Date.now() - runStart < maxMs) {
        if (this.pendingMode) break;
        if (this.piecesPlaced > 0 && this.piecesPlaced - lastRecal >= this.opts.recalibrateEvery) {
          if (pending) { try { await pending; } catch (e) {} pending = null; } // used the old cal — discard
          await this.calibrate(); lastRecal = this.piecesPlaced;
        }
        // Periodically remove accumulating ad iframes (they crash the renderer over time).
        // Fire-and-forget: DOM cleanup latency (~30-100ms) must not stall the play loop.
        if (Date.now() - lastSweep >= this.opts.sweepEveryMs) {
          lastSweep = Date.now();
          try { sweepAds(this.t).catch(() => {}); } catch (e) {}
        }
        // Clean stack + queue + hold; current = tracked|visible. In RAPID the read AND the
        // move computation already ran during the previous piece's postDrop wait
        // (null on failure -> fresh read here).
        let st = null, mv = null, mvReady = false;
        if (pending) {
          const p = await pending; pending = null;
          if (p && p.st) { st = p.st; mv = p.mv; mvReady = p.mvReady; }
        }
        if (!st) st = await this.readState();
        // Prediction check: does the screen match what the previous placement predicted?
        // A mismatch may be a half-rendered frame — the pipelined read fires only settleMs after
        // the drop — so reobserve ONCE and discard any move computed from that frame. The re-read
        // is itself ~60ms of settling, so it needs no sleep of its own; further retries only added
        // latency to the critical path. Persistent drift still uses the real board (self-correcting).
        if (this.lastPredicted) {
          const predicted = this.lastPredicted;
          for (let retry = 0; !st.transition && !this.stop; retry++) {
            const actual = st.stackFilled.map(r => r.map(Boolean));
            if (matricesEqual(predicted.slice(4), actual.slice(4))) break;
            if (retry === 1) { this.mispredicts++; break; }
            this.transientReads++;
            st = await this.readState(); mvReady = false;
          }
          this.lastPredicted = null;
        }
        const cur = st.current;
        const queueBefore = knownQueue(st.queue);
        if (!cur || !queueBefore.length) { // wait for a trustworthy current/NEXT prefix
          idle++;
          if (!idleSince) idleSince = Date.now();
          // Independent liveness deadline: if we can't read a piece for this long straight, the
          // screen is stuck in a way per-turn reads won't fix (a warm-but-unreadable overlay,
          // shrunken content that still passes detectFrame, etc.) — throw so the supervisor
          // restarts. This does NOT rely on the caller's maxMs (which may be disabled).
          if (Date.now() - idleSince > IDLE_MAX_MS) {
            throw new Error(`IDLE: ${Math.round((Date.now() - idleSince) / 1000)}초간 피스를 읽지 못함 — 앱 재시작 필요`);
          }
          if (idle > 60) {
            if (onTurn) onTurn({ idleWarning: true, piecesPlaced: this.piecesPlaced });
            // Prolonged idling often means the calibration went stale (window resized,
            // animation during the last recalibrate). Self-heal with a fresh attempt — but a
            // {degraded} verdict must PROPAGATE (don't swallow it, or a real shrink would only
            // restart at the segment time-cap, up to ~20 min late).
            try { await this.calibrate(); lastRecal = this.piecesPlaced; }
            catch (e) { if (e && e.degraded) throw e; }
            idle = 0;
          }
          await sleep(this.opts.idleSleepMs);
          continue;
        }
        idle = 0;
        const holdBefore = st.hold;
        // Tracking only needs queue[0] to name the next piece, so ONE known NEXT is enough to
        // play. The exception is a hold move off an EMPTY hold: it consumes queue[0] as well, so
        // the piece after it is queue[1]. Demanding two previews unconditionally threw away whole
        // turns whenever one preview read badly, while the real piece kept falling.
        const canHold = holdBefore ? true : queueBefore.length >= 2;
        if (!mvReady) {
          const sim = Board.fromMatrix(st.stackFilled);
          mv = pickMove({ board: sim, current: cur, queue: queueBefore, hold: holdBefore,
                          canHold, keyPenalty: this.opts.keyPenalty || 0, beam: this.opts.aiBeam || 0 });
        }
        if (!mv) {
          if (!idleSince) idleSince = Date.now();
          if (Date.now() - idleSince > IDLE_MAX_MS) throw new Error('IDLE: no executable placement');
          await sleep(120); continue;
        }
        idleSince = 0;
        if (await this.runKeys(mv.keys) === false) break;
        this.piecesPlaced++;
        this.linesEstimate += mv.expectedResult.linesCleared;
        this.advanceCurrent(queueBefore, mv.useHold, holdBefore);
        this.lastPredicted = boardToVisibleMatrix(mv.expectedResult.board);
        if (onTurn) onTurn({ mv, piecesPlaced: this.piecesPlaced, linesEstimate: this.linesEstimate,
                             stageUps: this.stageUps, resyncs: this.resyncs, mispredicts: this.mispredicts });
        if (this.opts.pipelineRead) {
          // RAPID: run the board capture AND the next move computation DURING the
          // spawn-margin wait instead of after it, taking read (~60ms) + pickMove (~35ms)
          // off the critical path. Wait a short settle first so the locked stack is
          // rendered — longer when this drop cleared lines, so the clear animation has
          // collapsed before we look. Errors resolve to null (fresh read next iteration);
          // the catch is inside the async fn so nothing rejects unhandled.
          const settle = mv.expectedResult.linesCleared > 0 ? this.opts.settleClearMs : this.opts.settleMs;
          pending = (async () => {
            try {
              await sleep(settle);
              const st2 = await this.readState();
              let mv2 = null, ready = false;
              try {
                const q2 = st2 ? knownQueue(st2.queue) : [];
                if (st2 && st2.current && q2.length) {
                  mv2 = pickMove({ board: Board.fromMatrix(st2.stackFilled), current: st2.current,
                                   queue: q2, hold: st2.hold,
                                   canHold: st2.hold ? true : q2.length >= 2,
                                   keyPenalty: this.opts.keyPenalty || 0, beam: this.opts.aiBeam || 0 });
                  ready = true; // mv2===null with ready=true means a real topout verdict
                }
              } catch (e) {}
              return { st: st2, mv: mv2, mvReady: ready };
            } catch (e) { return null; }
          })();
          await sleep(this.opts.postDropMs);
        } else {
          await sleep(this.opts.postDropMs); // let the piece lock + the next piece become controllable
        }
      }
    } finally {
      if (pending) { try { await pending; } catch (e) {} } // don't leave a capture in flight
    }
  }
}

function nowMs() { return Number(process.hrtime.bigint() / 1000000n); }

// Convert an internal Board (24 rows) to a visible 20x10 boolean matrix.
function boardToVisibleMatrix(board) {
  const { HIDDEN, HEIGHT, WIDTH } = Board;
  const out = [];
  for (let r = HIDDEN; r < HEIGHT; r++) {
    const row = [];
    for (let c = 0; c < WIDTH; c++) row.push(((board.rows[r] >> c) & 1) === 1);
    out.push(row);
  }
  return out;
}

function matricesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let y = 0; y < a.length; y++)
    for (let x = 0; x < a[y].length; x++)
      if (!!a[y][x] !== !!b[y][x]) return false;
  return true;
}

module.exports = { ZenBot, boardToVisibleMatrix, matricesEqual };
