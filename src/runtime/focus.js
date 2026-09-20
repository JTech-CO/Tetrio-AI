// Focus/visibility spoofing: make TETR.IO believe it always has focus,
// so it never pauses with the "OUT OF FOCUS" overlay while the window is backgrounded.
// (Proven bypass from the browser-era attempts; combined with CDP focus emulation.)

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
  // For the current document
  const now = await tetrio.eval(SPOOF_SCRIPT);
  // And for any future reload/navigation
  await tetrio.client.Page.addScriptToEvaluateOnNewDocument({ source: SPOOF_SCRIPT });
  return now;
}

module.exports = { applyFocusSpoof, SPOOF_SCRIPT };
