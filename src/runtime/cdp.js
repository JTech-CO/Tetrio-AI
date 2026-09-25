// CDP connection layer for the TETR.IO desktop app (Electron, --remote-debugging-port=9222)
const CDP = require('chrome-remote-interface');
const jpeg = require('jpeg-js');

const KEYS = {
  left:  { key: 'ArrowLeft',  code: 'ArrowLeft',  keyCode: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  up:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 }, // rotate CW (TETR.IO default)
  down:  { key: 'ArrowDown',  code: 'ArrowDown',  keyCode: 40 }, // soft drop
  hard:  { key: ' ',          code: 'Space',      keyCode: 32, text: ' ' }, // hard drop
  cw:    { key: 'ArrowUp',    code: 'ArrowUp',    keyCode: 38 },
  ccw:   { key: 'z',          code: 'KeyZ',       keyCode: 90 },
  '180': { key: 'a',          code: 'KeyA',       keyCode: 65 },
  hold:  { key: 'c',          code: 'KeyC',       keyCode: 67 },
  retry: { key: 'r',          code: 'KeyR',       keyCode: 82 },
  esc:   { key: 'Escape',     code: 'Escape',     keyCode: 27 },
};

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Rejects if the promise takes longer than ms (the CDP command may still finish; its result is
// ignored). A capture of a static screen in a hidden window can otherwise never return.
function withTimeout(promise, ms, label = 'op') {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + ' timeout after ' + ms + 'ms')), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

// Accurate short sleep for key timing: Windows rounds setTimeout up to ~15.6ms. Sleeps coarsely,
// then spins on setImmediate for the last ~18ms.
const preciseSleep = (ms) => new Promise((res) => {
  const target = process.hrtime.bigint() + BigInt(Math.round(ms * 1e6));
  const spin = () => { if (process.hrtime.bigint() >= target) res(); else setImmediate(spin); };
  const coarse = ms - 18; // leave up to one timer tick for the spin phase
  if (coarse > 0) setTimeout(spin, coarse); else setImmediate(spin);
});

// Chromium takes a clipped screenshot by resizing the page view during the capture. If that
// capture is abandoned or overlaps one from another connection, the view can stay at the clip's
// size until the app restarts. So every capture in this process runs one at a time, each
// waiting until Chromium has answered the previous one.
let captureChain = Promise.resolve();

// Logs why a connection dropped (1006 = the socket died). close() removes the listener first,
// so only unexpected drops are logged.
function reportDrops(client, label) {
  try {
    client._ws.on('close', (code, reason) => console.warn(`[CDP] ${label} 연결 끊김 code=${code}`
      + (reason && reason.length ? ` reason=${reason}` : '') + ` @ ${new Date().toISOString()}`));
  } catch (e) {}
}

class Tetrio {
  constructor(client) {
    this.client = client;
    this.c = client; // shorthand
    this.pressedKeys = new Set();
    this.closing = false;
  }

  static async connect({ port = 9222, keepAwake = false } = {}) {
    // Retry briefly — right after a (re)launch the page can take a moment to appear.
    let page = null;
    for (let i = 0; i < 20 && !page; i++) {
      try {
        const targets = await CDP.List({ port });
        page = targets.find(t => t.type === 'page' && t.url.startsWith('https://tetr.io'));
      } catch (e) { /* port not ready yet */ }
      if (!page) await sleep(500);
    }
    if (!page) throw new Error('tetr.io page target not found — is the app running with --remote-debugging-port?');
    const client = await withTimeout(CDP({ target: page.id, port }), 10000, 'CDP attach');
    // On failure, close the socket before rethrowing: a leaked socket can become a zombie that
    // holds the app's single-instance lock.
    try {
      await withTimeout(client.Runtime.enable(), 8000, 'Runtime.enable');
      await withTimeout(client.Page.enable(), 8000, 'Page.enable');
      await withTimeout(client.Network.enable(), 8000, 'Network.enable');
      // Make the renderer believe it is focused even when the OS window is not.
      try { await withTimeout(client.Emulation.setFocusEmulationEnabled({ enabled: true }), 8000, 'focusEmu'); } catch (e) { /* older protocol */ }
    } catch (e) {
      try { await client.close(); } catch {}
      throw e;
    }
    const t = new Tetrio(client);
    t.targetId = page.id;
    t.port = port;
    reportDrops(client, 'main');
    if (keepAwake) await t.keepCompositorAwake();
    return t;
  }

  // A running screencast keeps Chromium drawing frames while the window is hidden (otherwise a
  // screenshot can take seconds). The frames themselves are discarded.
  async keepCompositorAwake() {
    if (this._screencasting) return;
    this.client.Page.screencastFrame(({ sessionId }) => {
      this.client.Page.screencastFrameAck({ sessionId }).catch(() => {});
    });
    // A start that timed out may still begin later, so stop it explicitly; an orphaned
    // screencast would keep rendering for the whole session.
    try {
      await withTimeout(this.client.Page.startScreencast({ format: 'jpeg', quality: 15, everyNthFrame: 2 }), 5000, 'startScreencast');
      this._screencasting = true;
    } catch (e) {
      this._screencasting = false;
      try { await withTimeout(this.client.Page.stopScreencast(), 3000, 'stopScreencast'); } catch (e2) {}
    }
  }

  async stopKeepAwake() {
    if (!this._screencasting) return;
    this._screencasting = false;
    // Timeout-guarded: on a wedged renderer stopScreencast can hang like any Page command.
    try { await withTimeout(this.client.Page.stopScreencast(), 3000, 'stopScreencast'); } catch (e) {}
  }

  async eval(expression, { awaitPromise = false, timeout = 15000 } = {}) {
    // `timeout` limits the script; withTimeout limits the round-trip, in case the renderer hangs.
    const r = await withTimeout(
      this.client.Runtime.evaluate({ expression, returnByValue: true, awaitPromise, timeout }),
      timeout + 3000, 'eval');
    if (r.exceptionDetails) {
      throw new Error('page eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
    }
    return r.result.value;
  }

  // One capture through the shared queue (see captureChain). The timeout includes the wait in
  // the queue; a capture whose caller already gave up is skipped.
  _capture(opts, timeoutMs) {
    let abandoned = false;
    const answered = captureChain.then(() => {
      if (abandoned || this.closing) throw new Error('capture abandoned');
      return this.client.Page.captureScreenshot(opts);
    });
    captureChain = this.pendingCapture = answered.catch(() => {});
    return withTimeout(answered, timeoutMs, 'captureScreenshot').catch(e => { abandoned = true; throw e; });
  }

  // Full-viewport or clipped screenshot -> PNG Buffer
  async screenshot(clip = null, { timeoutMs = 8000 } = {}) {
    const opts = { format: 'png', optimizeForSpeed: true };
    if (clip) opts.clip = { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: clip.scale || 1 };
    const shot = await this._capture(opts, timeoutMs);
    return Buffer.from(shot.data, 'base64');
  }

  // Fast path for the play loop: JPEG capture (small payload) + jpeg-js decode.
  // Returns a pngjs-compatible image object { width, height, data(RGBA) }.
  // `clip` is in CSS pixels with a `scale` (use scale = DPR to keep device resolution).
  async captureRegion(clip = null, quality = 85, { timeoutMs = 8000 } = {}) {
    const opts = { format: 'jpeg', quality };
    if (clip) opts.clip = { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale: clip.scale || 1 };
    const shot = await this._capture(opts, timeoutMs);
    const raw = jpeg.decode(Buffer.from(shot.data, 'base64'), { useTArray: true, formatAsRGBA: true });
    return { width: raw.width, height: raw.height, data: raw.data };
  }

  async keyDown(name) {
    if (this.closing) throw new Error('CDP connection is closing');
    const k = KEYS[name];
    if (!k) throw new Error('unknown key: ' + name);
    this.pressedKeys.add(name); // A rejected reply may still have delivered the key.
    await withTimeout(this.client.Input.dispatchKeyEvent({
      type: k.text ? 'keyDown' : 'rawKeyDown',
      key: k.key, code: k.code,
      windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
      text: k.text,
    }), 8000, 'keyDown');
  }

  dispatchKeyEventFast(name, down) {
    const k = KEYS[name];
    if (!k) throw new Error('unknown key: ' + name);
    return withTimeout(this.client.Input.dispatchKeyEvent({
      type: down ? (k.text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
      key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode, ...(down && k.text ? { text: k.text } : {}),
    }), 1000, 'fast key dispatch');
  }

  async captureSession() {
    if (!this.targetId) throw new Error('Missing CDP target identity');
    const client = await withTimeout(CDP({ target: this.targetId, port: this.port }), 5000, 'capture attach');
    try { await withTimeout(client.Page.enable(), 3000, 'capture Page.enable'); }
    catch (e) { await client.close(); throw e; }
    reportDrops(client, 'capture');
    return new Tetrio(client);
  }

  async keyUp(name) {
    const k = KEYS[name];
    if (!k) throw new Error('unknown key: ' + name);
    await withTimeout(this.client.Input.dispatchKeyEvent({
      type: 'keyUp',
      key: k.key, code: k.code,
      windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode,
    }), 8000, 'keyUp');
    this.pressedKeys.delete(name);
  }

  // A connection that dropped mid-press leaves that key held in the game, which then ignores
  // new presses of it (a held Space swallows every hard drop). A new connection releases all.
  async releaseAllKeys() {
    await Promise.allSettled(Object.keys(KEYS).map(name => this.keyUp(name)));
  }

  // One tap: keydown, short hold, keyup
  async tap(name, { holdMs = 18, gapMs = 15 } = {}) {
    try {
      await this.keyDown(name);
      await sleep(holdMs);
    } finally {
      await this.keyUp(name);
    }
    await sleep(gapMs);
  }

  async taps(names, opts) {
    for (const n of names) await this.tap(n, opts);
  }

  async click(x, y) {
    const base = { x, y, button: 'left', clickCount: 1, pointerType: 'mouse' };
    await withTimeout(this.client.Input.dispatchMouseEvent({ type: 'mousePressed', ...base }), 8000, 'mouseDown');
    await sleep(30);
    await withTimeout(this.client.Input.dispatchMouseEvent({ type: 'mouseReleased', ...base }), 8000, 'mouseUp');
  }

  async viewport() {
    return this.eval('({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})');
  }

  // Lock the app window to a known size so the field lands at stable, well-tested
  // coordinates. Uses the browser-level endpoint (the page target lacks the Browser domain).
  async setWindowSize(width, height, port = 9222) {
    let browser;
    try {
      browser = await CDP({ port }); // no target => browser-level session
      const { targetInfos } = await browser.Target.getTargets();
      const page = targetInfos.find(t => t.type === 'page' && t.url.startsWith('https://tetr.io'));
      if (!page) return false;
      const { windowId } = await browser.Browser.getWindowForTarget({ targetId: page.targetId });
      // Leave fullscreen/maximized first, then set an explicit content size.
      await browser.Browser.setWindowBounds({ windowId, bounds: { windowState: 'normal' } });
      await browser.Browser.setWindowBounds({ windowId, bounds: { width, height, windowState: 'normal' } });
      return true;
    } catch (e) {
      return false;
    } finally {
      if (browser) try { await browser.close(); } catch (e) {}
    }
  }

  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = (async () => {
      try {
        await Promise.allSettled([...this.pressedKeys].map(name => this.keyUp(name)));
        await this.stopKeepAwake();
        // Never close with a capture unanswered (see captureChain); bounded for a wedged renderer.
        await withTimeout(this.pendingCapture || Promise.resolve(), 10000, 'capture drain').catch(() => {});
      } finally { await this.client.close(); }
    })();
    return this.closePromise;
  }
}

module.exports = { Tetrio, KEYS, sleep, preciseSleep };
