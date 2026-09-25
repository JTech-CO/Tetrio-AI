'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Turns off the game's bounce, shake and action text (they move the field) through its own
// settings controls, in every mode, and restores the user's values afterwards.
const VIDEO_PROFILE = { bounciness: 0, shakiness: 0, actiontext: 'off' };
// The user's values are saved here while the effects are off, and the file is deleted after a
// restore. Finding the effects off with the file present means a restore was lost, so the file
// wins; without the file, the user chose these values.
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
