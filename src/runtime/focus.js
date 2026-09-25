// Makes the page believe it always has focus, so TETR.IO never pauses with "OUT OF FOCUS"
// while the window is in the background.

const SPOOF_SCRIPT = `(() => {
  if (window.__focusSpoofed) return 'already';
  window.__focusSpoofed = true;
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  } catch (e) {}
  document.hasFocus = () => true;
  // Swallow blur/visibilitychange before the game sees them
  const swallow = (e) => { e.stopImmediatePropagation(); };
  window.addEventListener('blur', swallow, true);
  document.addEventListener('visibilitychange', swallow, true);
  // Periodically re-assert focus
  setInterval(() => {
    try { window.dispatchEvent(new FocusEvent('focus')); } catch (e) {}
  }, 400);
  return 'spoofed';
})()`;

async function applyFocusSpoof(tetrio) {
  // Now, and again on every page load.
  const now = await tetrio.eval(SPOOF_SCRIPT);
  await tetrio.client.Page.addScriptToEvaluateOnNewDocument({ source: SPOOF_SCRIPT });
  return now;
}

module.exports = { applyFocusSpoof, SPOOF_SCRIPT };
