'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Use the game's existing settings controls, not its internal board/queue state.
// Only visual effects that invalidate fixed pixel coordinates are changed. Restore
// the user's settings when leaving TURBO, including on failed calibration.
const VIDEO_PROFILE = { bounciness: 0, shakiness: 0, actiontext: 'off' };
// While the effects are pinned, the user's own values are journaled here and a completed restore
// deletes the journal. Finding the game pinned WITH a journal means a restore was lost (a dropped
// connection, a killed process) and the journal holds the user's values — reading the game then
// would take the PINNED values for the user's own and "restore" those for good. Pinned WITHOUT a
// journal means the user chose these values themselves.
const JOURNAL = path.resolve(__dirname, '../../probe/video-original.json');
const isPinned = v => Object.keys(VIDEO_PROFILE).every(k => v[k] === VIDEO_PROFILE[k]);

async function readVideo(t) {
  return t.eval(`(() => {
    const v = JSON.parse(localStorage.getItem('userConfig')).video;
    return { bounciness: Number(v.bounciness), shakiness: Number(v.shakiness), actiontext: v.actiontext };
  })()`);
}

async function writeVideo(t, values) {
  return t.eval(`(() => {
    const values = ${JSON.stringify(values)};
    for (const [key, value] of Object.entries(values)) {
      const id = 'video_' + key + (key === 'actiontext' ? '_' + value : '');
      const el = document.getElementById(id);
      if (!el) throw new Error('Missing video setting: ' + id);
      if (key === 'actiontext') el.click();
      else {
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    const v = JSON.parse(localStorage.getItem('userConfig')).video;
    return { bounciness: Number(v.bounciness), shakiness: Number(v.shakiness), actiontext: v.actiontext };
  })()`);
}

async function acquireTurboEnvironment(t, { journal = JOURNAL } = {}) {
  let before = await readVideo(t);
  if (isPinned(before)) { try { before = JSON.parse(fs.readFileSync(journal, 'utf8')); } catch (e) {} }
  else { try { fs.writeFileSync(journal, JSON.stringify(before)); } catch (e) {} }
  let restored = false;
  const restore = async () => {
    if (restored) return;
    await writeVideo(t, before); restored = true;
    try { fs.unlinkSync(journal); } catch (e) {}
  };
  try {
    const after = await writeVideo(t, VIDEO_PROFILE);
    if (Object.keys(VIDEO_PROFILE).some(k => after[k] !== VIDEO_PROFILE[k])) {
      throw new Error('Game did not apply the TURBO visual profile');
    }
    return { before, applied: after, restore };
  } catch (e) { await restore(); throw e; }
}

module.exports = { VIDEO_PROFILE, acquireTurboEnvironment, readVideo, writeVideo };
