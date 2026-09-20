// Calibration: detect the ZEN playfield rectangle from a screenshot via pixel analysis.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');

function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60; if (h < 0) h += 360;
  }
  return { h, s: mx ? d / mx : 0, v: mx };
}

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);
  const buf = await t.screenshot();
  fs.writeFileSync(path.join(__dirname, 'cal.png'), buf);
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data } = png;
  console.log('screenshot', W, 'x', H);
  const at = (x, y) => { const i = (y * W + x) * 4; return { r: data[i], g: data[i+1], b: data[i+2] }; };

  // Saturated mino detector: minos are bright + saturated. Starfield stars are bright but
  // near-white (low saturation); nebula is dim. Grid lines are gray.
  const isMino = (x, y) => {
    const { r, g, b } = at(x, y);
    const { s, v } = rgbToHsv(r, g, b);
    return v > 0.33 && s > 0.45;
  };

  // Count saturated pixels per column and per row to find the field cluster.
  const colCount = new Array(W).fill(0);
  const rowCount = new Array(H).fill(0);
  for (let y = 0; y < H; y += 2) {
    for (let x = 0; x < W; x += 2) {
      if (isMino(x, y)) { colCount[x] += 1; rowCount[y] += 1; }
    }
  }
  // The field is the densest contiguous band of saturated pixels near the horizontal center.
  const cx = Math.floor(W / 2);
  // find peak column near center
  let bestCol = cx, bestVal = -1;
  for (let x = Math.floor(W*0.35); x < Math.floor(W*0.65); x++) if (colCount[x] > bestVal) { bestVal = colCount[x]; bestCol = x; }
  console.log('densest saturated column near center at x=', bestCol, 'count', bestVal);

  // Print a coarse density profile so we can eyeball the field span.
  const prof = [];
  for (let x = Math.floor(W*0.35); x < Math.floor(W*0.66); x += 8) prof.push(x + ':' + colCount[x]);
  console.log('col density (x:count):\n' + prof.join(' '));

  await t.close();
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
