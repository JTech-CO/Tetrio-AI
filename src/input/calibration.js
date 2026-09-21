'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DEFAULT_PATH = path.resolve(__dirname, '../../probe/turbo-calibration.json');

function validateCalibration(c) {
  if (!c || c.version !== 1 || c.validated !== true || c.scope !== 'ZEN') {
    throw new Error('TURBO requires a successful ZEN input calibration');
  }
  for (const [key, min, max] of [
    ['tapHoldMs', 17, 100], ['tapGapMs', 5, 100], ['afterRotateMs', 0, 200],
    ['spawnMs', 17, 300], ['settleMs', 15, 300], ['settleClearMs', 70, 1000],
  ]) {
    if (!Number.isFinite(c[key]) || c[key] < min || c[key] > max) {
      throw new Error('Invalid calibration: ' + key);
    }
  }
  if (!Number.isInteger(c.evidence?.pieces) || c.evidence.pieces < 100 ||
      c.evidence.mismatches !== 0 || c.evidence.error || !c.environment?.viewport) {
    throw new Error('Calibration requires at least 100 matching measured placements');
  }
  if (c.environment.visualProfile) {
    const expected = require('../runtime/turbo-environment').VIDEO_PROFILE;
    if (Object.keys(expected).some(k => c.environment.visualProfile[k] !== expected[k])) {
      throw new Error('Unsupported calibrated visual profile');
    }
  }
  // Untested simultaneous input / precharge is deliberately not inferred from timings.
  if (c.precharge) throw new Error('Precharge has no validated input model');
  if (c.overlap && !(c.evidence.overlapped >= 20)) throw new Error('Overlap requires measured evidence');
  if (c.wallHoldMs != null && (!Number.isFinite(c.wallHoldMs) || c.wallHoldMs < 17 ||
      c.wallHoldMs > 500 || !(c.evidence.wallLeft > 0 && c.evidence.wallRight > 0))) {
    throw new Error('Wall movement requires measured left and right evidence');
  }
  return c;
}

function loadCalibration(file = DEFAULT_PATH) {
  try { return validateCalibration(JSON.parse(fs.readFileSync(file, 'utf8'))); }
  catch (e) { throw new Error(`TURBO 보정값을 사용할 수 없습니다 (${file}): ${e.message}. node probe/turbo_calibrate.js 를 실행하세요.`); }
}

module.exports = { DEFAULT_PATH, validateCalibration, loadCalibration };
