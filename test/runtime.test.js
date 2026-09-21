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
test('ordinary play waits for missing NEXT instead of shifting later identities forward', async () => {
  const bot = new ZenBot({ tap() { throw new Error('must not send input'); } });
  const result = await bot.playOnce({ hasPiece: true, current: 'T', stackFilled: empty(),
    queue: ['I', null, 'O', 'S'], hold: null });
  assert.equal(result.skipped, true);
  assert.equal(bot.piecesPlaced, 0);
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
        stopKeepAwake: async () => {}, screenshot: async () => ({}), close: async () => {} });
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
