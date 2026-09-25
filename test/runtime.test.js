'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { Tetrio } = require('../src/runtime/cdp');
const { ZenBot } = require('../src/bot');
const { MODES } = require('../src/modes');
const { parseArgs } = require('../src/run');
const empty = () => Array.from({ length: 20 }, () => Array(10).fill(null));

function transport(failDown = false) {
  const events = [];
  const t = new Tetrio({ Input: { async dispatchKeyEvent(e) {
    events.push(e.type + ':' + e.code);
    if (failDown && e.type !== 'keyUp') throw new Error('lost reply');
  } }, async close() { events.push('close'); } });
  return { t, events };
}

test('ordinary tap releases a possibly delivered key after a rejected keydown', async () => {
  const { t, events } = transport(true);
  await assert.rejects(t.tap('left'), /lost reply/);
  assert.deepEqual(events, ['rawKeyDown:ArrowLeft', 'keyUp:ArrowLeft']);
  assert.equal(t.pressedKeys.size, 0);
});
test('CDP close releases held keys, closes once and rejects subsequent presses', async () => {
  const { t, events } = transport();
  await t.keyDown('left');
  await Promise.all([t.close(), t.close()]);
  await assert.rejects(t.keyDown('hard'), /closing/);
  assert.deepEqual(events, ['rawKeyDown:ArrowLeft', 'keyUp:ArrowLeft', 'close']);
});
test('RAPID releases on input error and never sends the remaining hard drop', async () => {
  const { t, events } = transport(true);
  const bot = new ZenBot(t, { preciseKeys: true });
  await assert.rejects(bot.runKeys(['left', 'hard']), /lost reply/);
  assert.deepEqual(events, ['rawKeyDown:ArrowLeft', 'keyUp:ArrowLeft']);
});
test('stopping during a key pulse prevents the remaining keys in both ordinary modes', async () => {
  for (const preciseKeys of [false, true]) {
    const { t, events } = transport();
    const bot = new ZenBot(t, { preciseKeys, tapHoldMs: 0, tapGapMs: 0 });
    const down = t.keyDown.bind(t);
    t.keyDown = async name => { await down(name); bot.stop = true; };
    assert.equal(await bot.runKeys(['left', 'hard']), false);
    assert.deepEqual(events, ['rawKeyDown:ArrowLeft', 'keyUp:ArrowLeft']);
  }
});
test('mode switches preserve capture quality and explicit postdrop override but clear mode-only flags', () => {
  const bot = new ZenBot({}, { ...MODES.RAPID.opts, jpegQuality: 71,
    modeOverrides: { postDropMs: 145 } });
  bot.setMode('BASIC');
  assert.equal(bot.opts.captureCell, undefined);
  assert.equal(bot.opts.aiBeam, 0);
  assert.equal(bot.opts.jpegQuality, 71);
  assert.equal(bot.opts.postDropMs, 145);
  bot.setMode('RAPID');
  assert.equal(bot.opts.postDropMs, 145);
  assert.equal(bot.opts.captureCell, 17);
});
test('play uses the known NEXT prefix only and never shifts later identities forward', async () => {
  const bot = new ZenBot({ async tap() {} }, { postDropMs: 0 });
  // queue[0] unreadable: tracking cannot name the next piece, so nothing may be played.
  const blocked = await bot.playOnce({ hasPiece: true, current: 'T', stackFilled: empty(),
    queue: [null, 'O', 'S'], hold: null });
  assert.equal(blocked.skipped, true);
  assert.equal(bot.piecesPlaced, 0);
  // One known NEXT is enough to play, but an EMPTY hold must not consume it: that would make
  // the following piece queue[1], which is exactly the identity we cannot read.
  const played = await bot.playOnce({ hasPiece: true, current: 'T', stackFilled: empty(),
    queue: ['I', null, 'O'], hold: null });
  assert.equal(played.skipped, undefined);
  assert.equal(played.mv.useHold, false);
  assert.equal(bot.current, 'I');
});
test('stage changes count once only after a stable new fingerprint; transient changes reset', async () => {
  const bot = new ZenBot({});
  let signature = 0;
  bot.vision = { readBoard: () => ({ filled: empty(), grid: empty() }),
    readQueue: () => [], readHold: () => null,
    stageFingerprint: () => ({ bits: Array(100).fill(signature) }) };
  await bot.readState({});
  signature = 1; await bot.readState({});
  signature = 0; await bot.readState({});
  assert.equal(bot.stageUps, 0);
  signature = 1;
  for (let i = 0; i < 5; i++) await bot.readState({});
  assert.equal(bot.stageUps, 1);
});
test('level-complete text invalidates legacy tracking before board parsing or input', async () => {
  const bot = new ZenBot({});
  bot.current = 'T'; bot.lastPredicted = empty();
  bot.vision = { readLevelTransition: () => true, readBoard() { throw new Error('overlay is not a board'); } };
  const state = await bot.readState({});
  assert.equal(state.transition, true);
  assert.equal(state.current, null);
  assert.equal(bot.current, null);
  assert.equal(bot.lastPredicted, null);
});
test('the clipped spawn strip bootstraps a missing piece but never overrides tracking', async () => {
  const vision = { readBoard: () => ({ filled: empty(), grid: empty() }),
    readQueue: () => ['I', 'O'], readHold: () => null, readSpawnPiece: () => 'I' };
  const tracked = new ZenBot({});
  tracked.vision = vision; tracked.current = 'T';
  assert.equal((await tracked.readState({})).current, 'T');
  assert.equal(tracked.resyncs, 0);
  const bootstrapping = new ZenBot({});
  bootstrapping.vision = vision;
  assert.equal((await bootstrapping.readState({})).current, 'I');
});
test('CLI rejects invalid, missing and unknown arguments before connecting to the app', () => {
  for (const args of [['--mode', 'typo'], ['--pieces', '-1'], ['--pieces', '1.5'],
    ['--pieces', '4oops'], ['--pieces'], ['--quality', '101'], ['--port', '0'],
    ['--restart-mins', 'NaN'], ['--unknown'], ['--calibration', '--restart']]) {
    assert.throws(() => parseArgs(['node', 'run.js', ...args]));
  }
  const args = parseArgs(['node', 'run.js', '--restart-mins', '0.5', '--postdrop', '0', '--mode', 'rapid']);
  assert.equal(args.restartMins, 0.5);
  assert.equal(args.postdrop, 0);
  assert.equal(args.mode, 'RAPID');
});
test('supervisor stops with failure after eight no-progress gameplay errors, including degradation', () => {
  for (const degraded of [false, true]) {
    const script = `
      const timer = global.setTimeout;
      global.setTimeout = (f, ms, ...args) => timer(f, Math.min(ms, 1), ...args);
      require('./src/runtime/launch-app').ensureTetrio = async () => ({ reused: true, version: { Browser: 'fake' } });
      require('./src/runtime/cdp').Tetrio.connect = async () => ({ keepCompositorAwake: async () => {},
        stopKeepAwake: async () => {}, screenshot: async () => ({}), close: async () => {},
        viewport: async () => ({ w: 1295, h: 997, dpr: 2 }), releaseAllKeys: async () => {} });
      require('./src/runtime/focus').applyFocusSpoof = async () => {};
      require('./src/vision/vision').Vision.detectFrame = () => ({});
      const Bot = require('./src/bot').ZenBot;
      Bot.prototype.calibrate = async () => {};
      Bot.prototype.run = async () => { console.log('ATTEMPT'); const e = new Error('simulated failure'); e.degraded = ${degraded}; throw e; };
      process.argv = ['node', 'run.js', '--pieces', '1', '--no-adblock'];
      const Module = require('module');
      Module.runMain(require('path').resolve('src/run.js'));
    `;
    const child = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 10000,
      cwd: require('path').join(__dirname, '..') });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1, child.stdout + child.stderr);
    assert.equal((child.stdout.match(/ATTEMPT/g) || []).length, 8, child.stdout + child.stderr);
  }
});

test('ordinary loop discards transient board reads before selecting the next placement', async () => {
  const bot = new ZenBot({}, { postDropMs: 0 });
  bot.lastPredicted = empty();
  let reads = 0, inputs = 0;
  bot.readState = async () => ({ current: 'T', queue: ['I', 'O'], hold: null,
    stackFilled: ++reads === 1 ? Array.from({ length: 20 }, () => Array(10).fill('I')) : empty() });
  bot.runKeys = async () => { inputs++; return true; };
  await bot.run({ maxPieces: 1, maxMs: 1000 });
  assert.equal(reads, 2);
  assert.equal(inputs, 1);
  assert.equal(bot.mispredicts, 0);
  assert.equal(bot.transientReads, 1);
});

test('a persistent mismatch costs one re-read, not a retry chain on the critical path', async () => {
  const bot = new ZenBot({}, { postDropMs: 0 });
  bot.lastPredicted = empty();
  let reads = 0;
  bot.readState = async () => { reads++; return { current: 'T', queue: ['I', 'O'], hold: null,
    stackFilled: Array.from({ length: 20 }, () => Array(10).fill('I')) }; };
  bot.runKeys = async () => true;
  await bot.run({ maxPieces: 1, maxMs: 1000 });
  assert.equal(reads, 2);
  assert.equal(bot.mispredicts, 1);
  assert.equal(bot.transientReads, 1);
});

test('RAPID bridges a few clean pieces, then hands back to TURBO only once the stack is low', async () => {
  // Rows with a hole in column 0 so none is complete.
  const stack = h => Array.from({ length: 20 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => (y >= 20 - h && x > 0) ? 'I' : null));
  const run = async (height, maxPieces, slowCaptures = 0) => {
    const bot = new ZenBot({}, { postDropMs: 0 });
    bot.resumeTurbo = true; bot.fellBackAt = 0; bot.slowCaptures = slowCaptures;
    let inputs = 0;
    bot.readState = async () => ({ current: 'T', queue: ['I', 'O'], hold: null, stackFilled: stack(height) });
    bot.runKeys = async () => { inputs++; return true; };
    await bot.runLegacy({ maxPieces, maxMs: 2000 });
    return { bot, inputs };
  };
  const high = await run(10, 6);
  assert.equal(high.inputs, 6, 'still high: RAPID keeps playing');
  assert.ok(!high.bot.pendingMode);
  assert.equal(high.bot.resumeTurbo, true);
  const low = await run(4, 10);
  assert.equal(low.inputs, 3, 'RAPID bridges three pieces, then TURBO plays the next one');
  assert.equal(low.bot.pendingMode, 'TURBO');
  assert.equal(low.bot.resumeTurbo, false);
  // Repeated slow captures double the bridge so a slow window does not flap.
  assert.equal((await run(4, 20, 1)).inputs, 3);
  assert.equal((await run(4, 20, 2)).inputs, 6);
  assert.equal((await run(4, 20, 3)).inputs, 12);
});

// Chromium resizes the page for a clipped capture; overlapping or abandoned captures leave it
// stuck at the clip size. Captures must be answered one at a time across connections.
function captureClient(name, ms, log) {
  return { Page: { async captureScreenshot() {
    log.push(name + '+'); await new Promise(r => setTimeout(r, ms)); log.push(name + '-'); return { data: '' };
  } }, Input: { async dispatchKeyEvent() {} }, async close() { log.push(name + ' close'); } };
}
test('captures from different connections never overlap, even after one timed out on our side', async () => {
  const log = [];
  const a = new Tetrio(captureClient('a', 40, log)), b = new Tetrio(captureClient('b', 5, log));
  await assert.rejects(a.screenshot(null, { timeoutMs: 10 }), /timeout/);
  await b.screenshot();
  assert.deepEqual(log, ['a+', 'a-', 'b+', 'b-']);
});
test('closing a connection waits for its unanswered capture before dropping the socket', async () => {
  const log = [];
  const t = new Tetrio(captureClient('t', 30, log));
  t.screenshot().catch(() => {});
  await new Promise(r => setTimeout(r, 1));
  await t.close();
  assert.deepEqual(log, ['t+', 't-', 't close']);
});
test('a page view stuck at the capture size is reported as degradation for an immediate restart', async () => {
  const bot = new ZenBot({ viewport: async () => ({ w: 194, h: 215, dpr: 2 }) });
  bot.calViewport = { w: 1295, h: 997, dpr: 2 };
  await assert.rejects(bot.assertViewport(), e => e.degraded === true);
  bot.t.viewport = async () => ({ w: 1295, h: 997, dpr: 2 });
  await bot.assertViewport();
});

test('mismatch diagnostics are written only when enabled, and capped', () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diag-'));
  const st = { stackFilled: empty(), current: 'T', queue: ['I'], hold: null,
    buf: { width: 2, height: 1, data: Buffer.alloc(8) } };
  const bot = new ZenBot({}, { diagnosticsDir: dir });
  for (let i = 0; i < 65; i++) { bot.piecesPlaced = i; bot.dumpMismatch(empty(), st); }
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.json')).length, 60);
  assert.equal(fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length, 60);
  new ZenBot({}).dumpMismatch(empty(), st); // disabled: nothing to write, nothing thrown
});

test('a fresh connection releases every key a dead one might have left held in the game', async () => {
  const { t, events } = transport();
  await t.releaseAllKeys();
  const { KEYS } = require('../src/runtime/cdp');
  assert.equal(events.length, Object.keys(KEYS).length);
  assert.ok(events.every(e => e.startsWith('keyUp:')));
  assert.ok(events.includes('keyUp:Space'), 'a held Space swallows every later hard drop');
});
