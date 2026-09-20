// Probe 5: recover from EXIT dialog, then DEEP-probe gamera for readable game state.
const fs = require('fs');
const path = require('path');
const { Tetrio, sleep } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);

  // Recover: press Escape to dismiss the EXIT dialog (CANCEL), then screenshot
  await t.tap('esc');
  await sleep(800);
  fs.writeFileSync(path.join(__dirname, 'shot_recover.png'), await t.screenshot());
  console.log('shot_recover saved');

  // ---- Deep probe gamera ----
  const dump = await t.eval(`(() => {
    const out = {};
    try { out.typeofGamera = typeof gamera; } catch(e){ out.err = String(e); return out; }
    const g = window.gamera;
    if (!g) return out;
    const own = (o) => { try { return Object.keys(o); } catch(e){ return ['<err ' + e + '>']; } };
    out.gameraKeys = own(g);
    // Walk a couple levels to find things that look like the game/board
    const interesting = {};
    for (const k of out.gameraKeys) {
      let v; try { v = g[k]; } catch(e){ continue; }
      const ty = typeof v;
      if (ty === 'function') { interesting[k] = 'fn'; continue; }
      if (v && ty === 'object') {
        interesting[k] = { ctor: v.constructor && v.constructor.name, keys: own(v).slice(0, 40) };
      } else {
        interesting[k] = v;
      }
    }
    out.gamera = interesting;
    return out;
  })()`);
  fs.writeFileSync(path.join(__dirname, 'gamera_dump.json'), JSON.stringify(dump, null, 2));
  console.log('gameraKeys:', JSON.stringify(dump.gameraKeys));
  console.log('typeofGamera:', dump.typeofGamera);

  await t.close();
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
