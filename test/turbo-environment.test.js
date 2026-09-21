'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { acquireTurboEnvironment, readVideo } = require('../src/runtime/turbo-environment');
const { validateCalibration } = require('../src/input/calibration');

function fakeSettings() {
  const config = { video: { bounciness: '1', shakiness: '1', actiontext: 'all', background: 0.7 },
    handling: { arr: 2, das: 9 } };
  let writes = 0;
  const controls = {};
  for (const key of ['bounciness', 'shakiness']) controls['video_' + key] = {
    value: '1', dispatchEvent(event) {
      if (event.type === 'input') { config.video[key] = String(this.value); writes++; }
    },
  };
  for (const v of ['off', 'some', 'all']) controls['video_actiontext_' + v] = {
    click() { config.video.actiontext = v; writes++; },
  };
  const context = vm.createContext({ localStorage: { getItem: () => JSON.stringify(config) },
    document: { getElementById: id => controls[id] }, Event: class { constructor(type) { this.type = type; } } });
  return { config, controls, writes: () => writes, t: { eval: async code => JSON.parse(JSON.stringify(vm.runInContext(code, context))) } };
}

test('visual lease handles string-valued sliders and restores the original settings exactly once', async () => {
  const f = fakeSettings();
  const original = JSON.stringify(f.config);
  const lease = await acquireTurboEnvironment(f.t);
  assert.deepEqual(await readVideo(f.t), { bounciness: 0, shakiness: 0, actiontext: 'off' });
  assert.equal(f.config.video.background, 0.7);
  assert.deepEqual(f.config.handling, { arr: 2, das: 9 });
  await lease.restore();
  assert.equal(JSON.stringify(f.config), original);
  const writes = f.writes();
  await lease.restore();
  assert.equal(f.writes(), writes);
});

test('a partially applied visual profile is rolled back if a later control is unavailable', async () => {
  const f = fakeSettings();
  delete f.controls.video_actiontext_off;
  await assert.rejects(acquireTurboEnvironment(f.t), /Missing video setting/);
  assert.deepEqual(await readVideo(f.t), { bounciness: 1, shakiness: 1, actiontext: 'all' });
});

test('calibration rejects a visual profile that the runtime cannot reproduce', () => {
  const c = { version: 1, validated: true, scope: 'ZEN', tapHoldMs: 17, tapGapMs: 5,
    afterRotateMs: 10, spawnMs: 65, settleMs: 15, settleClearMs: 100,
    evidence: { pieces: 120, mismatches: 0 },
    environment: { viewport: { w: 800, h: 600, dpr: 1 },
      visualProfile: { bounciness: 1, shakiness: 0, actiontext: 'off' } } };
  assert.throws(() => validateCalibration(c), /Unsupported calibrated visual/);
});
test('probe interruption cancels input and leaves cleanup to finally blocks', () => {
  const events = new (require('node:events').EventEmitter)();
  const lifecycle = require('../probe/lifecycle').probeLifecycle(events);
  let cancelled = false;
  const bot = { stop: false, inputExecutor: { cancel() { cancelled = true; } } };
  lifecycle.track(bot);
  events.emit('SIGINT');
  assert.equal(bot.stop, true);
  assert.equal(cancelled, true);
  assert.throws(() => lifecycle.checkpoint(), /interrupted/);
  lifecycle.dispose();
  assert.equal(events.listenerCount('SIGINT'), 0);
  assert.equal(events.listenerCount('SIGTERM'), 0);
});
