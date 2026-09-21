'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const jpeg = require('jpeg-js');
const { Vision } = require('../src/vision/vision');

test('actual tilted LEVEL COMPLETE pixels are distinguished from the normal ZEN field', () => {
  const cal = require('./fixtures/level-calibration.json');
  const vision = new Vision(cal);
  for (const [file, expected] of [['level-complete.jpg', true], ['normal-field.jpg', false]]) {
    const im = jpeg.decode(fs.readFileSync(path.join(__dirname, 'fixtures', file)), { useTArray: true });
    assert.equal(vision.readLevelTransition(im), expected);
  }
});
test('yellow O pieces and wide yellow stacks inside the field are not level-completion text', () => {
  const vision = new Vision({ fieldLeft: 20, fieldRight: 220, fieldBottom: 400, rows: 20, cols: 10 });
  const im = { width: 240, height: 400, data: Buffer.alloc(240 * 400 * 4) };
  for (let y = 130; y < 240; y++) for (let x = 20; x < 220; x++) {
    const i = (y * im.width + x) * 4; im.data[i] = 255; im.data[i + 1] = 240; im.data[i + 3] = 255;
  }
  assert.equal(vision.readLevelTransition(im), false);
});

test('actual pale-yellow level-complete text is detected before the board disappears', () => {
  const vision = new Vision(require('./fixtures/level-pale-calibration.json'));
  const im = jpeg.decode(fs.readFileSync(path.join(__dirname, 'fixtures', 'level-complete-pale.jpg')), { useTArray: true });
  assert.equal(vision.readLevelTransition(im), true);
});

test('actual J in the hidden spawn rows is identified without waiting for gravity', () => {
  const vision = new Vision(require('./fixtures/spawn-calibration.json'));
  const im = jpeg.decode(fs.readFileSync(path.join(__dirname, 'fixtures', 'spawn-j.jpg')), { useTArray: true });
  assert.equal(vision.readSpawnPiece(im), 'J');
  assert.equal(vision.readSpawnPiece({ ...im, data: Buffer.alloc(im.data.length) }), null);
});
