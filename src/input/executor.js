'use strict';
const { performance } = require('node:perf_hooks');
const { preciseSleep } = require('../runtime/cdp');
const INPUT_KEYS = ['left', 'right', 'cw', 'ccw', '180', 'hold', 'hard'];

class InputExecutor {
  constructor(t, { now = () => performance.now(), wait = preciseSleep } = {}) {
    this.t = t; this.now = now; this.wait = wait; this.cancelled = false;
    this.held = new Set(); this.busy = false; this.error = null;
  }
  cancel() { this.cancelled = true; }
  async releaseAll() {
    const results = await Promise.allSettled(INPUT_KEYS.map(k => this.t.dispatchKeyEventFast(k, false)));
    results.forEach((r, i) => { if (r.status === 'fulfilled') this.held.delete(INPUT_KEYS[i]); });
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw new Error('Key release failed: ' + failed.reason.message);
  }
  async execute(plan, { startAt = this.now(), shouldStop = () => false } = {}) {
    if (this.busy) throw new Error('Concurrent input plans are forbidden');
    this.busy = true;
    const pending = [];
    let dropAt = null, lastActual = null, lastScheduled = null;
    try {
      for (const event of plan.events) {
        // Late scheduling must stretch subsequent events, never compress a key pulse.
        const target = Math.max(startAt + event.at,
          lastActual == null ? -Infinity : lastActual + event.at - lastScheduled);
        while (this.now() < target) {
          if (this.cancelled || shouldStop() || this.error) throw this.error || new Error('Input cancelled');
          await this.wait(Math.min(10, target - this.now()));
        }
        if (this.cancelled || shouldStop() || this.error) throw this.error || new Error('Input cancelled');
        lastActual = this.now(); lastScheduled = event.at;
        if (event.down) this.held.add(event.key);
        else this.held.delete(event.key);
        // CDP sends on one ordered WebSocket. Do not serialize on round-trip replies.
        const sent = this.t.dispatchKeyEventFast(event.key, event.down);
        pending.push(Promise.resolve(sent).catch(e => { this.error = e; }));
        if (event.key === 'hard' && event.down) dropAt = lastActual;
      }
      await Promise.all(pending);
      if (this.error) throw this.error;
      return { dropAt, finishedAt: this.now() };
    } catch (e) {
      // Commands already sent precede these releases on the same socket.
      await this.releaseAll();
      await Promise.all(pending);
      throw e;
    } finally { this.busy = false; }
  }
}
module.exports = { InputExecutor, INPUT_KEYS };
