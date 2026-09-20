// Probe 3: focus spoof -> resume game -> test key input moves the piece
const fs = require('fs');
const path = require('path');
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');

async function main() {
  const t = await Tetrio.connect();
  console.log('spoof:', await applyFocusSpoof(t));
  await sleep(1000);

  fs.writeFileSync(path.join(__dirname, 'shot_a.png'), await t.screenshot());
  console.log('shot_a saved (after spoof, before click)');

  // Click over the play field (left-center, far from the ad panel on the right)
  await t.click(500, 400);
  await sleep(700);
  fs.writeFileSync(path.join(__dirname, 'shot_b.png'), await t.screenshot());
  console.log('shot_b saved (after click)');

  // Test input: tap left twice, then screenshot
  await t.tap('left');
  await t.tap('left');
  await sleep(400);
  fs.writeFileSync(path.join(__dirname, 'shot_c.png'), await t.screenshot());
  console.log('shot_c saved (after 2x ArrowLeft)');

  await t.close();
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
