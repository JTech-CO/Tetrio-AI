'use strict';
// Drives the menus HOME -> SOLO -> ZEN -> START when a relaunch lands on HOME instead of
// resuming ZEN (ZEN progress is saved on the account, so a new game continues it).
// Tiles are found by DOM id and clicked with real mouse events. Never click #zen_destroy:
// it resets ZEN progress.

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

// Clicks the furthest menu step visible, so it works from any screen. True once a ZEN field
// is visible.
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
