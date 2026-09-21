'use strict';

// Use the game's existing settings controls, not its internal board/queue state.
// Only visual effects that invalidate fixed pixel coordinates are changed. Restore
// the user's settings when leaving TURBO, including on failed calibration.
const VIDEO_PROFILE = { bounciness: 0, shakiness: 0, actiontext: 'off' };

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

async function acquireTurboEnvironment(t) {
  const before = await readVideo(t);
  let restored = false;
  const restore = async () => {
    if (!restored) { await writeVideo(t, before); restored = true; }
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
