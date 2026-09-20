'use strict';
// Ensure TETR.IO desktop is running with the CDP remote-debugging port open.
// If it is already reachable on the port, reuse it; otherwise (re)launch the app.
//
// IMPORTANT: TETR.IO is a single-instance app. To attach over CDP it MUST be launched with
// --remote-debugging-port, which can only be set at launch. So if the app is already running
// WITHOUT the port (e.g. the user opened it normally), we have to restart it. A force-kill
// must fully terminate every child process before relaunching — otherwise a lingering process
// keeps the single-instance lock and BOTH our relaunch and the user's manual relaunch fail.
const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const CDP = require('chrome-remote-interface');

const DEFAULT_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'tetrio-desktop', 'TETR.IO.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reject if a promise doesn't settle in time. CDP Browser.close() / connect can HANG when the
// app is on a wedged/blocked screen and doesn't close cleanly — without this the whole restart
// stalls for minutes. On timeout we fall through to the force-kill, which always works.
function withTimeout(promise, ms, label = 'op') {
  let timer;
  const t = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(label + ' timeout')), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

function probePort(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitForPort(port, maxMs = 40000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const v = await probePort(port);
    if (v) return v;
    await sleep(500);
  }
  return null;
}

// GET /json/list and resolve the parsed array (or null).
function listTargets(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/list', timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// Wait until the tetr.io PAGE target exists and is loaded (the browser port comes up before
// the page has navigated to tetr.io, so attaching too early fails).
async function waitForPageTarget(port, maxMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const list = await listTargets(port);
    if (Array.isArray(list) && list.some((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith('https://tetr.io'))) return true;
    await sleep(500);
  }
  return false;
}

// Number of running TETR.IO.exe processes (Windows).
function countTetrio() {
  if (process.platform !== 'win32') {
    try { return execSync('pgrep -c -f TETR.IO', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() | 0; } catch { return 0; }
  }
  try {
    const out = execSync('tasklist /FI "IMAGENAME eq TETR.IO.exe" /NH', { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return (out.match(/TETR\.IO\.exe/gi) || []).length;
  } catch { return 0; }
}

// Gracefully quit a debug-enabled app via CDP Browser.close(). This closes all sockets and
// releases the single-instance lock cleanly — unlike a force-kill, which can leave a stuck
// "zombie" (dead process still holding an open CDP socket + the lock) that blocks reopening.
// Returns true if the app went away.
async function gracefulCloseViaPort(port, maxMs = 8000) {
  if (!(await probePort(port))) return false;
  let client = null;
  try {
    client = await withTimeout(CDP({ port }), 4000, 'CDP connect');
    await withTimeout(client.Browser.close(), 4000, 'Browser.close');
  } catch { /* hang or error -> fall through to the force-kill, which always works */ }
  finally { if (client) try { await client.close(); } catch {} }
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (countTetrio() === 0) return true;
    await sleep(400);
  }
  return countTetrio() === 0;
}

// Force-kill every TETR.IO process and wait for the LIVE processes to exit, releasing the
// single-instance lock before relaunch. A killed process can leave a short-lived "zombie"
// table entry (already exited, handle not yet released) that never reaches 0 — so we stop
// once the count stops decreasing (stable), not only at 0. ensureTetrio's port/page check is
// the real confirmation that the relaunch took, and it retries if a genuine instance lingers.
async function killTetrio({ maxMs = 10000 } = {}) {
  const doKill = () => {
    try {
      if (process.platform === 'win32') execSync('taskkill /IM "TETR.IO.exe" /F /T', { stdio: 'ignore' });
      else execSync('pkill -9 -f TETR.IO', { stdio: 'ignore' });
    } catch { /* none running */ }
  };
  if (countTetrio() === 0) return;
  const start = Date.now();
  doKill();
  let prev = countTetrio(), stable = 0;
  while (Date.now() - start < maxMs) {
    await sleep(400);
    const n = countTetrio();
    if (n === 0) break;
    if (n >= prev) { if (++stable >= 4) break; } // count no longer dropping: remainder is zombie/stuck
    else { stable = 0; doKill(); }
    prev = n;
  }
  await sleep(1500); // settle so the OS releases the single-instance lock/mutex
}

// Chromium flags that keep the renderer AND the compositor running at full speed while the
// window is backgrounded/occluded. Without CalculateNativeWinOcclusion disabled, Chrome
// throttles the compositor when the window is hidden, making Page.captureScreenshot take
// several seconds per frame — even though the game's rAF loop keeps running.
const PERF_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--disable-features=CalculateNativeWinOcclusion',
];

function launch(exe, port) {
  const child = spawn(exe, [`--remote-debugging-port=${port}`, ...PERF_FLAGS], { detached: true, stdio: 'ignore' });
  child.unref();
}

// Returns { reused, version, note? } once the app is debuggable on `port`.
// - If already debuggable: reuse (no restart).
// - Otherwise: fully terminate any running instance, relaunch WITH the debug port, and wait.
//   Retries the whole cycle so a stuck single-instance lock can't wedge us permanently.
async function ensureTetrio({ port = 9222, exe = DEFAULT_EXE, forceRestart = false } = {}) {
  if (!forceRestart) {
    const existing = await probePort(port);
    if (existing && await waitForPageTarget(port, 8000)) return { reused: true, version: existing };
  }
  const wasRunning = countTetrio() > 0;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    // Prefer a graceful quit (clean sockets, no zombie); force-kill anything left over.
    await gracefulCloseViaPort(port);
    await killTetrio();          // fully terminate; releases the single-instance lock
    const preCount = countTetrio(); // usually 0; may be >0 if a stuck zombie lingers
    launch(exe, port);
    // Wait for the debug port. A real launch brings up a multi-process app (main + GPU +
    // renderers) that STAYS; a single-instance-locked launch spawns one main that quits
    // immediately, so the count never sustains above preCount. Detect that and fail fast —
    // no wait will help until the stuck instance is cleared.
    let version = null, realApp = false;
    const start = Date.now();
    while (Date.now() - start < 30000) {
      version = await probePort(port);
      if (version) break;
      if (countTetrio() >= preCount + 3) realApp = true; // a genuine app is running
      if (Date.now() - start > 12000 && !realApp) break; // nothing real ever started -> wedged
      await sleep(600);
    }
    // The browser port opens before the page navigates to tetr.io — wait for the page too.
    if (version && await waitForPageTarget(port, 30000)) {
      return { reused: false, version, note: wasRunning ? 'restarted-with-debug-port' : 'launched' };
    }
    if (!version && !realApp) { lastErr = 'single-instance-locked'; break; }
    lastErr = version ? 'page target (tetr.io) did not appear' : `no debug port after attempt ${attempt + 1}`;
    await sleep(1000);
  }
  if (lastErr === 'single-instance-locked') {
    throw new Error('TETR.IO가 비정상 종료 상태(멈춘 프로세스)로 남아 새 창을 열 수 없습니다. '
      + '작업 관리자에서 TETR.IO를 모두 종료하거나, 그래도 안 되면 PC를 재부팅한 뒤 다시 실행해 주세요.');
  }
  throw new Error(`TETR.IO를 디버그 포트(${port})로 열지 못했습니다 (${lastErr}). 앱을 완전히 종료한 뒤 다시 시도해 주세요.`);
}

module.exports = { ensureTetrio, probePort, killTetrio, countTetrio, DEFAULT_EXE };
