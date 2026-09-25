'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { calibrationPath, calibrationStatus, listCalibrations, loadCalibration } = require('../src/input/calibration');
const { calibrateInputs } = require('../src/input/autocalibrate');

const profile = (viewport, spawnMs) => ({ version: 1, scope: 'ZEN', validated: true,
  tapHoldMs: 17, tapGapMs: 5, afterRotateMs: 10, spawnMs, settleMs: 15, settleClearMs: 70,
  wallHoldMs: null, environment: { viewport }, evidence: { pieces: 120, mismatches: 0 } });
const WINDOWED = { w: 1295, h: 999, dpr: 2 }, MAXIMIZED = { w: 1920, h: 1010, dpr: 2 };

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turbo-cal-'));
  const put = (vp, body) => fs.writeFileSync(calibrationPath(vp, dir), JSON.stringify(body));
  return { dir, put };
}

test('each window size keeps its own measured profile and TURBO loads the one it is running at', () => {
  const { dir, put } = tempDir();
  put(WINDOWED, profile(WINDOWED, 120));
  put(MAXIMIZED, profile(MAXIMIZED, 95));
  assert.equal(loadCalibration(null, WINDOWED, dir).spawnMs, 120);
  assert.equal(loadCalibration(null, MAXIMIZED, dir).spawnMs, 95);
  assert.equal(listCalibrations(dir).length, 2);
});

test('an in-progress re-calibration of one size neither hides nor destroys the other size', () => {
  const { dir, put } = tempDir();
  put(WINDOWED, profile(WINDOWED, 120));
  put(MAXIMIZED, { version: 1, validated: false, reason: 'calibration in progress' });
  assert.equal(loadCalibration(null, WINDOWED, dir).spawnMs, 120);
  assert.throws(() => loadCalibration(null, MAXIMIZED, dir), /1920x1010@2.*보정된 크기: 1295x999@2/);
});

test('without a viewport any valid profile answers the pre-flight check; an explicit file is used as-is', () => {
  const { dir, put } = tempDir();
  assert.throws(() => loadCalibration(null, null, dir), /보정값이 없습니다/);
  put(WINDOWED, profile(WINDOWED, 120));
  assert.equal(loadCalibration(null, null, dir).spawnMs, 120);
  const explicit = path.join(dir, 'custom.json');
  fs.writeFileSync(explicit, JSON.stringify(profile(MAXIMIZED, 80)));
  assert.equal(loadCalibration(explicit, WINDOWED, dir).spawnMs, 80);
});

// Automatic calibration: a fake measurement per rung so the ladder's decisions are testable.
const passing = { pieces: 120, mismatches: 0, overlapped: 30, wallLeft: 0, wallRight: 0 };
function ladder(outcome) {
  const bot = { t: { viewport: async () => WINDOWED }, stop: false };
  const measured = [];
  const measureFn = async (b, c) => {
    measured.push(c.wallHoldMs ? 'wall' : c.overlap ? 'overlap' : c.spawnMs);
    return outcome(c, b);
  };
  return { bot, measured, measureFn };
}

test('automatic calibration keeps the fastest passing rung and saves it for this size only', async () => {
  const { dir, put } = tempDir();
  put(MAXIMIZED, profile(MAXIMIZED, 120));
  const { bot, measured, measureFn } = ladder(() => passing);
  const { best } = await calibrateInputs(bot, { dir, measureFn, log: () => {} });
  assert.deepEqual(measured, [120, 95, 80, 65, 'overlap', 'wall']);
  assert.equal(best.spawnMs, 65);
  assert.equal(best.overlap, true);
  assert.equal(calibrationStatus(WINDOWED, dir).state, 'valid');
  assert.equal(loadCalibration(null, MAXIMIZED, dir).spawnMs, 120, 'the other size is untouched');
});

test('a failed faster rung keeps the last passing one instead of discarding the calibration', async () => {
  const { dir } = tempDir();
  const { bot, measureFn } = ladder(c => c.spawnMs === 95 ? { ...passing, pieces: 42, mismatches: 1 } : passing);
  const { best } = await calibrateInputs(bot, { dir, measureFn, log: () => {} });
  assert.equal(best.spawnMs, 120);
});

test('a misprediction at the most conservative rung marks the size failed so it is not retried', async () => {
  const { dir } = tempDir();
  const { bot, measured, measureFn } = ladder(() => ({ ...passing, pieces: 64, mismatches: 1 }));
  await assert.rejects(calibrateInputs(bot, { dir, measureFn, log: () => {} }), /예측 불일치/);
  assert.deepEqual(measured, [120]);
  assert.equal(calibrationStatus(WINDOWED, dir).state, 'failed');
});

test('an unsafe stack, capture stall or interruption says nothing about the size and stays retryable', async () => {
  const { dir } = tempDir();
  const stall = ladder(() => ({ ...passing, pieces: 7, error: 'Unsafe stack during input calibration' }));
  await assert.rejects(calibrateInputs(stall.bot, { dir, measureFn: stall.measureFn, log: () => {} }), /판정 불가/);
  assert.equal(calibrationStatus(WINDOWED, dir).state, 'missing');
  const stopped = ladder((c, b) => { b.stop = true; return { ...passing, pieces: 3 }; });
  await assert.rejects(calibrateInputs(stopped.bot, { dir, measureFn: stopped.measureFn, log: () => {} }), /interrupted/);
  assert.equal(calibrationStatus(WINDOWED, dir).state, 'missing');
});

test('a viewport the page reports can only name a calibration file inside the profile folder', async () => {
  const { dir } = tempDir();
  assert.equal(path.dirname(calibrationPath({ w: 1278, h: 1002, dpr: 1.25 }, dir)), dir);
  // A page script can redefine innerWidth or devicePixelRatio to return any string.
  for (const vp of [{ w: '/../../x', h: 1, dpr: 2 }, { w: 1, h: 1, dpr: '/../../../settings' },
    { w: '1\\..\\x', h: 1, dpr: 2 }, { w: 1e21, h: 1, dpr: 2 }, { w: 1, h: 1, dpr: 'NaN' }]) {
    assert.throws(() => calibrationPath(vp, dir), /Invalid viewport/, JSON.stringify(vp));
    assert.equal(calibrationStatus(vp, dir).state, 'missing');
    const bot = { t: { viewport: async () => vp } };
    await assert.rejects(calibrateInputs(bot, { dir, measureFn: () => assert.fail('measured'), log: () => {} }),
      /Invalid viewport/);
  }
  assert.deepEqual(fs.readdirSync(dir), [], 'nothing was written');
});
