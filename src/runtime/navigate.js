'use strict';
// Auto-navigate the TETR.IO menus into a ZEN game, hands-off. Needed for autonomous recovery:
// a clean relaunch AUTO-RESUMES the in-progress ZEN board most of the time, but when it doesn't
// (a force-kill lost the session, or an intermittent boot-to-HOME) the app sits on the HOME
// menu and something has to drive HOME -> SOLO -> ZEN -> START. ZEN progress is account-saved,
// so starting a fresh ZEN game just continues from the saved stage.
//
// Uses DOM to locate menu tiles by their STABLE ids (verified live 2026-07-18) then dispatches
// a real CDP mouse click at the element center (TETR.IO's custom UI reacts to synthesized mouse
// events; DOM lookup makes it window-size-independent, unlike fixed pixel coords):
//   HOME SOLO tile = #play_solo ; SOLO->ZEN tile = #game_zen ; ZEN START = #start_zen
//   (avoid #zen_destroy = RESET, which wipes ZEN progress); announcement popup = #ban_skip_button.

const { sleep } = require('./cdp.js');
const { Vision } = require('../vision/vision.js');

// Is a ZEN playfield on screen? Capture is timeout-guarded; any failure => not visible.
async function zenFieldVisible(t) {
  try { Vision.detectFrame(await t.screenshot(null, { timeoutMs: 6000 })); return true; }
  catch { return false; }
}

// Center {x,y} of a visible element by id, or null (rejects hidden/offscreen template nodes).
async function centerOfId(t, id) {
  return t.eval(
    '(() => { const el=document.getElementById(' + JSON.stringify(id) + ');' +
    ' if(!el) return null; const r=el.getBoundingClientRect(); const st=getComputedStyle(el);' +
    " if(r.width<8||r.height<8||st.display==='none'||st.visibility==='hidden'||parseFloat(st.opacity)<0.1) return null;" +
    ' if(r.y<0||r.y>innerHeight||r.x<0||r.x>innerWidth) return null;' +
    ' return {x:Math.round(r.x+r.width/2), y:Math.round(r.y+r.height/2)}; })()'
  );
}

async function clickId(t, id) {
  const c = await centerOfId(t, id);
  if (!c) return false;
  await t.click(c.x, c.y);
  return true;
}

// Drive the menus into a live ZEN game. State-tolerant: each pass clicks the MOST-ADVANCED
// reachable step (START if we're already on the ZEN screen, else the ZEN tile, else SOLO), so
// it recovers from whatever screen the app happens to be on. Returns true iff a ZEN field is
// visible before the deadline.
async function enterZen(t, { log = () => {}, timeoutMs = 45000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await zenFieldVisible(t)) return true;
    let step = null;
    if (await clickId(t, 'start_zen')) step = 'START';            // ZEN pre-game screen
    else if (await clickId(t, 'game_zen')) step = 'ZEN';          // SOLO submenu
    else if (await clickId(t, 'play_solo')) step = 'SOLO';        // HOME
    else { await clickId(t, 'ban_skip_button'); await sleep(500); } // dismiss announcement overlay
    if (step) { log(`  ↪ 메뉴: ${step}`); await sleep(1700); }
  }
  return zenFieldVisible(t);
}

module.exports = { enterZen, zenFieldVisible };
