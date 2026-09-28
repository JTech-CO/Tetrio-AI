'use strict';
// Kept in its own file: the fallback test switches the WASM decoder off for the whole process.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const turbo = require('@cwasm/jpeg-turbo');
const { decodeJpeg } = require('../src/runtime/cdp');
const { Vision } = require('../src/vision/vision');
const { extractCurrentPiece } = require('../src/vision/pieces');

const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const reads = (vision, im) => {
  const { filled } = vision.readBoard(im);
  return JSON.stringify({ stack: extractCurrentPiece(filled).stackFilled, queue: vision.readQueue(im),
    hold: vision.readHold(im), spawn: vision.readSpawnPiece(im), transition: vision.readLevelTransition(im) });
};

test('the WASM decoder gives the same vision reads as jpeg-js on real captures', () => {
  for (const [file, cal] of [['normal-field.jpg', 'level-calibration.json'], ['level-complete.jpg', 'level-calibration.json'],
    ['level-complete-pale.jpg', 'level-pale-calibration.json'], ['spawn-j.jpg', 'spawn-calibration.json']]) {
    const vision = new Vision(require('./fixtures/' + cal));
    const fast = decodeJpeg(fixture(file));
    const reference = jpeg.decode(fixture(file), { useTArray: true, formatAsRGBA: true });
    assert.deepEqual([fast.width, fast.height], [reference.width, reference.height], file);
    assert.equal(reads(vision, fast), reads(vision, reference), file);
  }
});

test('after a WASM decoder error, captures fall back to jpeg-js for the rest of the session', () => {
  const original = turbo.decode;
  let calls = 0;
  turbo.decode = () => { calls++; throw new Error('simulated libjpeg-turbo failure'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const first = decodeJpeg(fixture('normal-field.jpg'));
    const second = decodeJpeg(fixture('normal-field.jpg'));
    const reference = jpeg.decode(fixture('normal-field.jpg'), { useTArray: true, formatAsRGBA: true });
    assert.deepEqual(Buffer.from(first.data), Buffer.from(reference.data));
    assert.deepEqual(Buffer.from(second.data), Buffer.from(reference.data));
    assert.equal(calls, 1, 'the failed decoder is not tried again');
  } finally { turbo.decode = original; console.warn = warn; }
});
