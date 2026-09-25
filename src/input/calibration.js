'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DIR = path.resolve(__dirname, '../../probe');
const FILE_RE = /^turbo-calibration-\d+x\d+@[\d.]+\.json$/;
const viewportKey = vp => `${vp.w}x${vp.h}@${vp.dpr}`;

// One profile per viewport. Timing measured at one window size is not evidence for another,
// and a single shared file let every calibration overwrite — or, by invalidating it before
// measuring, destroy on a failed run — the profile of the other size the app launches at.
function calibrationPath(viewport, dir = DIR) {
  const name = `turbo-calibration-${viewportKey(viewport)}.json`;
  // The viewport comes from the page; it must never name a file outside `dir`.
  if (!FILE_RE.test(name)) throw new Error('Invalid viewport for a calibration file: ' + viewportKey(viewport));
  return path.join(dir, name);
}

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

// Every valid profile on disk. An in-progress or failed measurement is simply not listed.
function listCalibrations(dir = DIR) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => FILE_RE.test(f)); } catch (e) { return []; }
  return files.flatMap(f => {
    try { return [validateCalibration(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))]; }
    catch (e) { return []; }
  });
}

// An explicit file is used as-is. Otherwise pick the profile measured at `viewport`; without a
// viewport (a pre-flight "is TURBO available at all?" check) any valid profile will do.
function loadCalibration(file = null, viewport = null, dir = DIR) {
  if (file) {
    try { return validateCalibration(JSON.parse(fs.readFileSync(file, 'utf8'))); }
    catch (e) { throw new Error(`TURBO 보정값을 사용할 수 없습니다 (${file}): ${e.message}. node probe/turbo_calibrate.js 를 실행하세요.`); }
  }
  const all = listCalibrations(dir);
  const hit = viewport ? all.find(c => viewportKey(c.environment.viewport) === viewportKey(viewport)) : all[0];
  if (hit) return hit;
  const have = all.map(c => viewportKey(c.environment.viewport)).join(', ') || '없음';
  throw new Error(viewport
    ? `이 창 크기(${viewportKey(viewport)})에서 측정한 TURBO 보정이 없습니다 (보정된 크기: ${have}). `
      + '창 크기를 그대로 두고 node probe/turbo_calibrate.js 를 실행하세요.'
    : 'TURBO 보정값이 없습니다. node probe/turbo_calibrate.js 를 실행하세요.');
}

// What is on disk for one size: a usable profile; a measured verdict that TURBO timing does
// not hold there; or nothing conclusive (no file, an interrupted run, an inconclusive one).
function calibrationStatus(viewport, dir = DIR) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(calibrationPath(viewport, dir), 'utf8')); }
  catch (e) { return { state: 'missing' }; }
  try { return { state: 'valid', calibration: validateCalibration(raw) }; }
  catch (e) { return raw && raw.reason === 'calibration failed' ? { state: 'failed', record: raw } : { state: 'missing' }; }
}

module.exports = { DIR, calibrationPath, calibrationStatus, listCalibrations, validateCalibration,
  loadCalibration, viewportKey };
