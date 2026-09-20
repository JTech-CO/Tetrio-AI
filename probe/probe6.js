// Probe 6: click CANCEL on exit dialog, confirm back in ZEN
const fs = require('fs');
const path = require('path');
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);
  const vp = await t.viewport();
  console.log('viewport:', JSON.stringify(vp));

  // CANCEL button center in viewport (CSS) pixels — dialog is centered.
  // From screenshot: cancel center ~ 42.5% width, 53% height of a 1603x803 viewport.
  const cx = Math.round(vp.w * 0.425);
  const cy = Math.round(vp.h * 0.53);
  console.log('clicking CANCEL at', cx, cy);
  await t.click(cx, cy);
  await sleep(1000);

  fs.writeFileSync(path.join(__dirname, 'shot_afterCancel.png'), await t.screenshot());
  console.log('shot_afterCancel saved');

  // If still not in game, click play field to focus/resume
  await t.click(Math.round(vp.w * 0.30), Math.round(vp.h * 0.45));
  await sleep(600);
  fs.writeFileSync(path.join(__dirname, 'shot_afterCancel2.png'), await t.screenshot());
  console.log('shot_afterCancel2 saved');

  await t.close();
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
