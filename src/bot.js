'use strict';
// The BASIC/RAPID play loop: read the screen, pick a move, send the keys over CDP.
// TURBO's loop is in src/turbo.js.

const { Tetrio, sleep, preciseSleep } = require('./runtime/cdp.js');
const { applyFocusSpoof } = require('./runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('./runtime/adblock.js');
const { Vision } = require('./vision/vision.js');
const { extractCurrentPiece } = require('./vision/pieces.js');
const { Board } = require('./board.js');
const { pickMove } = require('./ai.js');
const { knownQueue } = require('./state.js');

const DEFAULTS = {
  // BASIC values (presets in src/modes.js). Shorter tapHoldMs or postDropMs make the game
  // miss keys.
  tapHoldMs: 14,     // keydown duration for a single tap
  tapGapMs: 10,      // gap between taps
  afterRotateMs: 14, // extra settle after a rotate
  postDropMs: 120,   // wait after a hard drop until the next piece can be moved
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
  strategy: 'SINGLE',  // line-clear strategy, orthogonal to the mode (src/modes.js STRATEGIES)
  aiBeam: 0,           // depth-2 child search only for top-N placements (0 = full search)
};

// TURBO hands high stacks and stage transitions to RAPID, and takes over again after a few
// clean pieces with a stack of 6 rows or less, so the two don't flap at the boundary.
const TURBO_RESUME_HEIGHT = 6;
const TURBO_RESUME_AFTER = 3;
// Each fallback for a slow capture doubles that wait (3, 6, 12, ... pieces).
const resumeBridge = slowCaptures => Math.min(200, TURBO_RESUME_AFTER * 2 ** Math.max(0, slowCaptures - 1));
const stackHeight = rows => { const top = rows.findIndex(r => r.some(Boolean)); return top < 0 ? 0 : rows.length - top; };

class ZenBot {
  constructor(t, opts = {}) {
    this.t = t;
    this.opts = { ...DEFAULTS, ...opts };
    this.modeOverrides = { ...(opts.modeOverrides || {}) };
    this.vision = null;
    this.cal = null;
    this.piecesPlaced = 0;
    this.linesEstimate = 0;
    this.quads = 0;
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
    // Only an explicit profile file can be checked up front; without one TURBO measures the
    // window size it finds itself at (turbo.js ensureCalibration).
    if (m.key === 'TURBO' && this.opts.calibrationPath) {
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
    // Retry: an ad or an animation can hide the field in a single frame.
    let abs = null, lastErr = null;
    for (let attempt = 0; attempt < 5 && !abs; attempt++) {
      try { abs = Vision.detectFrame(await this.t.screenshot()); }
      catch (e) { lastErr = e; await sleep(600); }
    }
    if (!abs) {
      // A stage-up animation can hide the borders for seconds; keep the last good calibration.
      if (this.absCal) {
        console.warn('[calibrate] frame detect failed, keeping previous calibration:', lastErr && lastErr.message);
        return this.cal;
      }
      throw new Error('Field calibration failed: ' + (lastErr && lastErr.message));
    }
    // Over long sessions the game can start rendering smaller inside the window. The field's
    // height as a share of the window height survives window resizes, so a drop means that shrink.
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
    this.calViewport = vp;
    const dpr = Math.max(1, Math.round(abs.screenshotW / vp.w)); // usually 2
    const cw = (abs.fieldRight - abs.fieldLeft) / abs.cols;
    const fieldTop = abs.fieldBottom - abs.rows * cw;
    // Device-pixel bounds of everything we read.
    const xMinD = Math.max(0, Math.floor(abs.fieldLeft - 5.6 * cw));
    const xMaxD = Math.min(abs.screenshotW, Math.ceil(abs.fieldRight + 7.2 * cw));
    const yMinD = Math.max(0, Math.floor(fieldTop - 2.5 * cw));
    const yMaxD = Math.min(abs.screenshotH, Math.ceil(abs.fieldBottom + 2.8 * cw));
    // Scale the capture to ~TARGET_CELL px per cell, so decode time doesn't depend on window size.
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

  // An interrupted capture can leave the page view stuck at clip size (see cdp.js captureChain).
  // Report it as degradation so the supervisor restarts the app right away.
  async assertViewport() {
    if (!this.calViewport) return;
    let vp;
    try { vp = await this.t.viewport(); } catch (e) { return; }
    if (vp.w < this.calViewport.w * 0.7 || vp.h < this.calViewport.h * 0.7) {
      const e = new Error(`DEGRADED: 페이지 화면이 ${vp.w}x${vp.h}로 줄어듦 `
        + `(보정 시 ${this.calViewport.w}x${this.calViewport.h}) — 앱 재시작 필요`);
      e.degraded = true;
      throw e;
    }
  }

  // The frame a counted misprediction was decided on, next to the prediction. Off unless
  // opts.diagnosticsDir is set; capped so a bad stretch cannot fill the disk.
  dumpMismatch(predicted, st) {
    const dir = this.opts.diagnosticsDir;
    if (!dir || (this.dumps = (this.dumps || 0) + 1) > 60) return;
    try {
      const fs = require('node:fs'), path = require('node:path');
      fs.mkdirSync(dir, { recursive: true });
      const stem = path.join(dir, `rapid-mismatch-${this.piecesPlaced}`);
      const rows = m => m.map(r => r.map(v => (v ? '#' : '.')).join(''));
      fs.writeFileSync(stem + '.json', JSON.stringify({ piece: this.piecesPlaced, at: new Date().toISOString(),
        stageUps: this.stageUps, predicted: rows(predicted), actual: rows(st.stackFilled),
        current: st.current, queue: st.queue, hold: st.hold }, null, 1));
      if (st.buf && st.buf.data) fs.writeFileSync(stem + '.jpg', require('jpeg-js').encode(
        { data: st.buf.data, width: st.buf.width, height: st.buf.height }, 90).data);
    } catch (e) {}
  }

  // Fast per-turn capture (clipped JPEG) decoded to a pngjs-like image.
  async grab() {
    return this.t.captureRegion(this.clip, this.opts.jpegQuality);
  }

  // Reads the game state. The current piece comes from tracking; a clean 4-cell view of the
  // piece on the board overrides it.
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

    // Count a stage-up when the stage number under the field changes and stays changed for
    // two reads.
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

    // Only a clean 4-cell view may override tracking. The strip above the field shows a cut-off
    // piece that can be misread (J as I), so it is used only when tracking has nothing.
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

  // Switch the line-clear strategy live. Unlike a mode it needs no turn boundary: every
  // pickMove reads it, so the next decision already uses it.
  setStrategy(name) {
    const { STRATEGIES } = require('./modes.js');
    const s = STRATEGIES[name && String(name).toUpperCase()];
    if (!s) return null;
    this.opts.strategy = s.key;
    return s;
  }

  countClear(lines) {
    this.linesEstimate += lines;
    if (lines === 4) this.quads++;
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
      // Precise timing (RAPID). Holds under ~17ms (one frame) or gaps under ~5ms drop taps.
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
                          canHold: holdBefore ? true : queueBefore.length >= 2, strategy: this.opts.strategy });
    if (!mv) return { skipped: true, reason: 'pickMove returned null (topout?)' };

    const predicted = mv.expectedResult.board; // Board after placement (stack incl. clears)
    if (await this.runKeys(mv.keys) === false) return { skipped: true, reason: 'stopped' };
    await sleep(this.opts.postDropMs);
    this.piecesPlaced++;
    this.countClear(mv.expectedResult.linesCleared);
    this.advanceCurrent(queueBefore, mv.useHold, holdBefore);

    if (!verify) return { mv };

    // Verify: read the new stack, compare to prediction (ignore top 4 rows = spawn area).
    const after = await this.readState();
    const predMatrix = boardToVisibleMatrix(predicted);
    const actualMatrix = after.stackFilled.map(r => r.map(Boolean));
    const match = matricesEqual(predMatrix.slice(4), actualMatrix.slice(4));
    return { mv, predicted: predMatrix, actual: actualMatrix, match, after, current: st.current };
  }

  // ZEN's gravity is slow and a new piece can be moved as soon as it spawns, so the loop doesn't
  // wait to see it: its identity comes from the NEXT queue and the read shows the stack. A clean
  // view of the piece corrects tracking if it drifts. maxMs ends the segment so the supervisor
  // can restart the app before its renderer degrades.
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
        // Remove ad iframes now and then (they pile up and crash the renderer); don't wait.
        if (Date.now() - lastSweep >= this.opts.sweepEveryMs) {
          lastSweep = Date.now();
          try { sweepAds(this.t).catch(() => {}); } catch (e) {}
        }
        // In RAPID this read and move were already made during the previous piece's wait.
        let st = null, mv = null, mvReady = false;
        if (pending) {
          const p = await pending; pending = null;
          if (p && p.st) { st = p.st; mv = p.mv; mvReady = p.mvReady; }
        }
        if (!st) st = await this.readState();
        // Does the screen match the last prediction? A mismatch may be a half-drawn frame, so
        // read once more and drop any move based on it. A lasting mismatch is played as seen.
        if (this.lastPredicted) {
          const predicted = this.lastPredicted;
          for (let retry = 0; !st.transition && !this.stop; retry++) {
            const actual = st.stackFilled.map(r => r.map(Boolean));
            if (matricesEqual(predicted.slice(4), actual.slice(4))) break;
            if (retry === 1) { this.mispredicts++; this.dumpMismatch(predicted, st); break; }
            this.transientReads++;
            st = await this.readState(); mvReady = false;
          }
          this.lastPredicted = null;
        }
        // TURBO handed a stretch to RAPID (turbo.js); give it back once it is over.
        if (this.resumeTurbo && !st.transition
            && this.piecesPlaced - (this.fellBackAt || 0) >= resumeBridge(this.slowCaptures || 0)
            && stackHeight(st.stackFilled) <= TURBO_RESUME_HEIGHT) {
          console.warn(`[RAPID → TURBO] 스택 ${stackHeight(st.stackFilled)}줄 — TURBO로 복귀`);
          this.resumeTurbo = false; this.pendingMode = 'TURBO';
          break;
        }
        const cur = st.current;
        const queueBefore = knownQueue(st.queue);
        if (!cur || !queueBefore.length) { // wait for a trustworthy current/NEXT prefix
          idle++;
          if (idle === 1) await this.assertViewport();
          if (!idleSince) idleSince = Date.now();
          // No readable piece for a minute: the screen is stuck in a way reads won't fix, so
          // throw and let the supervisor restart.
          if (Date.now() - idleSince > IDLE_MAX_MS) {
            throw new Error(`IDLE: ${Math.round((Date.now() - idleSince) / 1000)}초간 피스를 읽지 못함 — 앱 재시작 필요`);
          }
          if (idle > 60) {
            if (onTurn) onTurn({ idleWarning: true, piecesPlaced: this.piecesPlaced });
            // Long idling often means a stale calibration: recalibrate, but let a degradation
            // error through so the app restarts now.
            try { await this.calibrate(); lastRecal = this.piecesPlaced; }
            catch (e) { if (e && e.degraded) throw e; }
            idle = 0;
          }
          await sleep(this.opts.idleSleepMs);
          continue;
        }
        idle = 0;
        const holdBefore = st.hold;
        // One known NEXT piece is enough, except to hold into an empty slot, which uses up
        // queue[0] as well.
        const canHold = holdBefore ? true : queueBefore.length >= 2;
        if (!mvReady) {
          const sim = Board.fromMatrix(st.stackFilled);
          mv = pickMove({ board: sim, current: cur, queue: queueBefore, hold: holdBefore,
                          canHold, keyPenalty: this.opts.keyPenalty || 0, beam: this.opts.aiBeam || 0,
                          strategy: this.opts.strategy });
        }
        if (!mv) {
          if (!idleSince) idleSince = Date.now();
          if (Date.now() - idleSince > IDLE_MAX_MS) throw new Error('IDLE: no executable placement');
          await sleep(120); continue;
        }
        idleSince = 0;
        if (await this.runKeys(mv.keys) === false) break;
        this.piecesPlaced++;
        this.countClear(mv.expectedResult.linesCleared);
        this.advanceCurrent(queueBefore, mv.useHold, holdBefore);
        this.lastPredicted = boardToVisibleMatrix(mv.expectedResult.board);
        if (onTurn) onTurn({ mv, piecesPlaced: this.piecesPlaced, linesEstimate: this.linesEstimate,
                             stageUps: this.stageUps, resyncs: this.resyncs, mispredicts: this.mispredicts });
        if (this.opts.pipelineRead) {
          // RAPID: read the board and pick the next move while waiting after the drop, after a
          // short settle (longer after a line clear). A failure gives null and the next turn
          // reads again.
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
                                   keyPenalty: this.opts.keyPenalty || 0, beam: this.opts.aiBeam || 0,
                                   strategy: this.opts.strategy });
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
