'use strict';
// Manual TURBO input calibration for the window size the app is running at right now.
// TURBO also runs this automatically for a size it has no profile for; use this probe to
// re-measure a size, including one whose automatic calibration was recorded as failed.
const { Tetrio } = require('../src/runtime/cdp');
const { applyFocusSpoof } = require('../src/runtime/focus');
const { ZenBot } = require('../src/bot');
const { MODES } = require('../src/modes');
const { calibrateInputs } = require('../src/input/autocalibrate');

async function main() {
  const pieces = Number(process.argv[2] || 120);
  if (!Number.isInteger(pieces) || pieces < 100) throw new Error('Use at least 100 calibration pieces');
  const port = Number(process.env.TETRIO_PORT || 9222);
  let t, visual;
  const lifecycle = require('./lifecycle').probeLifecycle();
  try {
    t = await Tetrio.connect({ port });
    await applyFocusSpoof(t);
    visual = await require('../src/runtime/turbo-environment').acquireTurboEnvironment(t);
    const bot = new ZenBot(t, { ...MODES.RAPID.opts, verifyTimeoutMs: 400 });
    lifecycle.track(bot); lifecycle.checkpoint();
    await bot.calibrate();
    await calibrateInputs(bot, { pieces, port, visualProfile: visual.applied,
      checkpoint: () => lifecycle.checkpoint() });
  } finally {
    try { if (visual) await visual.restore(); }
    finally { try { if (t) await t.close(); } finally { lifecycle.dispose(); } }
  }
}
if (require.main === module) main().catch(e => { console.error(e.message); process.exitCode = 1; });
