// Probe 4: apply adblock -> reload -> observe post-reload state (ads gone? auto-resume ZEN?)
const fs = require('fs');
const path = require('path');
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { applyAdblock, applyCosmetics } = require('../src/runtime/adblock.js');

async function main() {
  const t = await Tetrio.connect();
  await applyAdblock(t);
  console.log('adblock: blocked URL patterns set');
  console.log('spoof:', await applyFocusSpoof(t)); // also registers on-new-document script

  await t.client.Page.reload({ ignoreCache: false });
  console.log('reloading...');
  await sleep(12000);

  fs.writeFileSync(path.join(__dirname, 'shot_reload1.png'), await t.screenshot());
  console.log('shot_reload1 saved (t+12s)');

  await sleep(10000);
  fs.writeFileSync(path.join(__dirname, 'shot_reload2.png'), await t.screenshot());
  console.log('shot_reload2 saved (t+22s)');

  try { await applyCosmetics(t); } catch (e) { console.log('cosmetics skipped:', e.message); }

  // Visible top-level ids for state detection
  const ids = await t.eval(`[...document.querySelectorAll('[id]')].filter(e => {
    const r = e.getBoundingClientRect(); const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  }).map(e => e.id).slice(0, 80)`);
  console.log('visible ids:', JSON.stringify(ids));

  await t.close();
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
