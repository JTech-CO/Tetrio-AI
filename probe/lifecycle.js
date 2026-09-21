'use strict';

// Let probe finally blocks release keys, restore video settings and close CDP on
// Ctrl+C. Installing a handler without cancelling the active bot would keep playing.
function probeLifecycle(events = process) {
  let stopped = false, active = null;
  const stop = () => {
    stopped = true;
    if (active) { active.stop = true; active.inputExecutor?.cancel(); }
  };
  events.on('SIGINT', stop); events.on('SIGTERM', stop);
  return {
    track(bot) { active = bot; if (stopped) bot.stop = true; },
    checkpoint() { if (stopped) throw new Error('Probe interrupted'); },
    dispose() { events.removeListener('SIGINT', stop); events.removeListener('SIGTERM', stop); },
  };
}
module.exports = { probeLifecycle };
