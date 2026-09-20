// Probe 7: verify vision (ASCII board) + test gravity (does piece auto-fall?)
const fs = require('fs');
const path = require('path');
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { Vision } = require('../src/vision/vision.js');

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);

  // Auto-detect frame from a live screenshot, compare to default.
  const buf0 = await t.screenshot();
  let cal;
  try { cal = Vision.detectFrame(buf0); console.log('detected cal:', JSON.stringify(cal)); }
  catch (e) { console.log('detectFrame failed, using default:', e.message); cal = undefined; }
  const v = new Vision(cal);
  console.log('colW=', v.colW.toFixed(1), 'rowH=', v.rowH.toFixed(1), 'fieldTop=', v.fieldTop.toFixed(0));

  const b1 = v.readBoard(buf0);
  console.log('--- board t=0 ---');
  console.log(Vision.asciiBoard(b1.filled, b1.grid));

  await sleep(700);
  const buf1 = await t.screenshot();
  const b2 = v.readBoard(buf1);
  console.log('--- board t=0.7s (no input) ---');
  console.log(Vision.asciiBoard(b2.filled, b2.grid));

  // Gravity check: did any column's top filled row move down?
  const topRow = (b) => b.filled.map(row => row).findIndex(row => row.some(Boolean));
  console.log('top filled row t0:', topRow(b1), 'top filled row t0.7:', topRow(b2));
  const same = JSON.stringify(b1.filled) === JSON.stringify(b2.filled);
  console.log('board identical after 0.7s idle?', same, '(if false, gravity is ON)');

  await t.close();
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
