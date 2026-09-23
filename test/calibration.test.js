'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { calibrationPath, listCalibrations, loadCalibration } = require('../src/input/calibration');

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
