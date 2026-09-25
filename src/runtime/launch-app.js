'use strict';
// Makes sure TETR.IO runs with the CDP debug port open: reuses it if it does, else (re)launches
// it. The port can only be set at launch and the app allows a single instance, so an app opened
// normally must be closed first, every child process included (a leftover one keeps the
// single-instance lock and blocks every relaunch).
const http = require('http');
const { spawn, execSync } = require('child_process');
const path = require('path');
const CDP = require('chrome-remote-interface');

const DEFAULT_EXE = path.join(process.env.LOCALAPPDATA || '', 'Programs', 'tetrio-desktop', 'TETR.IO.exe');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Browser.close() or attaching can hang on a wedged app; after the timeout the force-kill runs.
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

// Quits the app through CDP, which releases the single-instance lock cleanly (a force-kill can
// leave a zombie process holding it). True if the app exited.
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

// Force-kills every TETR.IO process. A killed process can stay in the process list for a while,
// so waiting ends once the count stops falling; ensureTetrio confirms the relaunch.
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

// Keep rendering at full speed with the window in the background. Without
// CalculateNativeWinOcclusion disabled, a hidden window makes each screenshot take seconds.
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

// Returns { reused, version, note? } once the app is debuggable on `port`. The close-and-
// relaunch cycle is retried a few times.
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
    // A real launch stays up as several processes; one blocked by the single-instance lock
    // quits at once, so fail fast instead of waiting.
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
