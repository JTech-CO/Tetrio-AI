'use strict';
// Production entry point: ensure the app is up + debuggable, apply focus spoof + ad
// blocking, wait until a ZEN game is on screen, then play continuously.
//
// Usage:
//   node src/run.js [--mode basic|rapid] [--pieces N] [--port 9222] [--restart]
//                   [--no-adblock] [--quality 85] [--postdrop N]
//
// By default it REUSES an already-running TETR.IO (preserving your ZEN session). Enter
// ZEN mode yourself first; the bot detects the board and starts playing.
//
// MODES are selected/switched from THIS console window (no in-game overlay):
// a menu is shown once the ZEN field is detected, and during play you can type
// `1`/`basic` or `2`/`rapid` + Enter at any time to switch live.

const readline = require('readline');
const { ensureTetrio } = require('./runtime/launch-app.js');
const { Tetrio, sleep } = require('./runtime/cdp.js');
const { applyFocusSpoof } = require('./runtime/focus.js');
const { applyAdblock, applyCosmetics, sweepAds } = require('./runtime/adblock.js');
const { Vision } = require('./vision/vision.js');
const { ZenBot } = require('./bot.js');
const { MODES, resolveMode } = require('./modes.js');
const { enterZen } = require('./runtime/navigate.js');

function parseArgs(argv) {
  // Proactive "pit-stop": over very long sessions the app's renderer degrades (content
  // shrinks inside the window, then it stalls). We pre-empt that by cleanly restarting +
  // re-entering ZEN every `restartEvery` pieces OR `restartMins` minutes, whichever first.
  // ZEN is account-saved and auto-resumes on relaunch, so a restart loses nothing.
  const a = { port: 9222, pieces: Infinity, restart: false, adblock: true, quality: 85,
              postdrop: null, mode: 'BASIC', restartEvery: 2500, restartMins: 20 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.port = parseInt(argv[++i], 10);
    else if (k === '--pieces') a.pieces = parseInt(argv[++i], 10);
    else if (k === '--restart') a.restart = true;
    else if (k === '--no-adblock') a.adblock = false;
    else if (k === '--quality') a.quality = parseInt(argv[++i], 10);
    else if (k === '--postdrop') a.postdrop = parseInt(argv[++i], 10); // lower = faster, ~120 min
    else if (k === '--mode') a.mode = resolveMode(argv[++i]) || 'BASIC';
    else if (k === '--restart-every') a.restartEvery = parseInt(argv[++i], 10); // 0 disables
    else if (k === '--restart-mins') a.restartMins = parseInt(argv[++i], 10);    // 0 disables
  }
  return a;
}

// Is a ZEN field visible right now? Capture is timeout-guarded, and BOTH a capture timeout
// (cold/wedged compositor) and a missing field count as "not visible" so the caller just
// keeps polling — the screencast warming should make frames flow within a few tries.
async function zenVisible(t) {
  try { Vision.detectFrame(await t.screenshot(null, { timeoutMs: 6000 })); return true; }
  catch { return false; }
}

// Try to get a ZEN game on screen. Returns true on success, false if it couldn't.
//
// Two-tier recovery: (1) a clean relaunch AUTO-RESUMES the in-progress ZEN board when the
// graceful close saved the session — poll for the field first. (2) Otherwise the app is on
// HOME, so enterZen() drives the menus (SOLO -> ZEN -> START) by stable element ids. If even
// that fails (a rare dialog/announcement race), return false so the supervisor restarts and
// rolls again. Only `allowManualWait` (the very first launch, human present) waits
// indefinitely for the user to open ZEN instead of returning false.
async function reachZen(t, { allowManualWait = false } = {}) {
  // Keep the compositor producing frames during recovery: on a static/backgrounded screen
  // captureScreenshot yields no frames and (without this) would hang — the guard turns that
  // into a fast timeout, and the screencast makes real frames flow for detection. Once a ZEN
  // game is up the falling pieces keep it warm, so we stop it before returning.
  await t.keepCompositorAwake();
  try {
    const deadline = Date.now() + 16000;
    while (Date.now() < deadline) {
      if (await zenVisible(t)) return true;   // auto-resumed into ZEN
      await sleep(1200);
    }
    // Didn't auto-resume (landed on HOME). Drive the menus SOLO -> ZEN -> START automatically.
    console.log('  ZEN 자동 복귀 안 됨 — 메뉴에서 ZEN 자동 진입을 시도합니다…');
    if (await enterZen(t, { log: console.log, timeoutMs: 45000 })) return true;
    if (allowManualWait) {
      console.log('  ⏳ ZEN 화면을 기다립니다 — TETR.IO에서 Solo → ZEN 으로 진입해 주세요.');
      for (;;) { if (await zenVisible(t)) return true; await sleep(1500); }
    }
    return false; // caller restarts + retries
  } finally {
    try { await t.stopKeepAwake(); } catch {}
  }
}

function printModeMenu(current) {
  console.log('\n── 모드 선택 ─────────────────────────────────────────────');
  Object.values(MODES).forEach((m, i) => {
    const mark = m.key === current ? '▶' : ' ';
    console.log(` ${mark} [${i + 1}] ${m.label}`);
  });
  console.log('   플레이 중에도 이 창에 번호/이름 + Enter 로 언제든 전환됩니다.');
  console.log('──────────────────────────────────────────────────────────');
}

async function main() {
  const args = parseArgs(process.argv);
  console.log(`▶ TETR.IO ZEN 봇 시작 (port=${args.port}, pieces=${args.pieces === Infinity ? '∞' : args.pieces})`);

  const t0 = Date.now();
  let stop = false;
  let totalPieces = 0, totalLines = 0, totalStageUps = 0, totalResyncs = 0, totalMispredicts = 0;
  let currentBot = null;
  let activeT = null;         // the live CDP connection, visible to shutdown() BEFORE a bot
                              // exists (waitForZen / mode menu window) — zombie-app hazard
  let modeName = args.mode;   // chosen mode (updated from the console)
  let modeAsked = false;      // startup menu is shown only once, on first ZEN detection
  let selectResolve = null;   // set while the startup menu is waiting for input

  // Recent-window speed so mode switches are visible immediately in the logs.
  let recentTimes = [];
  const noteTurn = () => { recentTimes.push(Date.now()); if (recentTimes.length > 26) recentTimes.shift(); };
  const recentPps = () => recentTimes.length >= 6
    ? ((recentTimes.length - 1) / ((recentTimes[recentTimes.length - 1] - recentTimes[0]) / 1000)).toFixed(2)
    : null;

  const summary = () => {
    const secs = (Date.now() - t0) / 1000;
    const live = currentBot || { piecesPlaced: 0, linesEstimate: 0, stageUps: 0, resyncs: 0, mispredicts: 0 };
    return `${totalPieces + live.piecesPlaced} 피스, 라인(추정) ${totalLines + live.linesEstimate}, ` +
           `스테이지업 ${totalStageUps + live.stageUps}, 리싱크 ${totalResyncs + live.resyncs}, ` +
           `오배치(추정) ${totalMispredicts + live.mispredicts}, ${secs.toFixed(0)}s, ` +
           `${((totalPieces + live.piecesPlaced) / Math.max(1, secs)).toFixed(2)} 피스/초`;
  };

  // Apply a mode to the running bot (re-applies an explicit --postdrop override on top).
  const applyMode = (name) => {
    modeName = name;
    if (currentBot) {
      currentBot.setMode(name);
      if (args.postdrop) currentBot.opts.postDropMs = Math.max(90, args.postdrop);
    }
    recentTimes = [];
    console.log(`⇒ 모드 전환: ${MODES[name].label}`);
  };

  // Clean shutdown: ALWAYS close the CDP connection before exiting. Force-killing the app
  // (or the bot dying) while a CDP socket is still open can leave a stuck "zombie" process
  // that holds the single-instance lock and blocks the app from reopening. Closing the
  // socket first prevents that.
  let shuttingDown = false;
  const shutdown = async (code = 0) => {
    if (shuttingDown) return; shuttingDown = true; stop = true;
    if (currentBot) currentBot.stop = true;
    try { rl.close(); } catch {}
    try { const tt = (currentBot && currentBot.t) || activeT; if (tt) await tt.close(); } catch {}
    console.log(`\n⏹ 종료: ${summary()}`);
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));
  process.on('uncaughtException', (e) => { console.error('예기치 못한 오류:', e && e.message); shutdown(1); });
  process.on('unhandledRejection', (e) => { console.error('처리되지 않은 거부:', e && (e.message || e)); shutdown(1); });

  // Console UI: one line handler serves both the startup menu and live switching.
  // terminal:false = cooked mode: the console host handles echo/editing, and Ctrl+C
  // stays a real SIGINT (caught by the process handler above).
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const cmd = String(line).trim();
    if (!cmd) return;
    const m = resolveMode(cmd);
    if (m) {
      if (selectResolve) { const r = selectResolve; selectResolve = null; r(m); }
      else if (m !== modeName) applyMode(m);
      else console.log(`  (이미 ${m} 모드입니다)`);
    } else if (cmd.toLowerCase() === 'status') {
      console.log('  ' + summary());
    } else {
      console.log('  ? 명령: 1|basic, 2|rapid, status');
    }
  });
  rl.on('SIGINT', () => shutdown(0));

  // Startup menu: wait for a choice; default to `def` after timeoutMs of silence.
  const askMode = (def, timeoutMs = 8000) => new Promise((resolve) => {
    console.log(`모드 번호/이름 + Enter — 입력 없이 ${Math.round(timeoutMs / 1000)}초 지나면 ${def} 로 시작:`);
    const tm = setTimeout(() => {
      if (selectResolve) { selectResolve = null; console.log(`  (입력 없음 — ${def} 모드로 시작합니다)`); resolve(def); }
    }, timeoutMs);
    selectResolve = (m) => { clearTimeout(tm); resolve(m); };
  });

  // Supervisor loop: play until done; on any error (renderer crash, disconnect, degradation)
  // recover and resume. Two restart triggers keep an unattended session alive indefinitely:
  //  - reactive: after repeated errors, or immediately on a DEGRADED signal;
  //  - proactive "pit-stop": every restartEvery pieces / restartMins minutes, restart the app
  //    BEFORE the renderer degrades. The app auto-resumes ZEN, so reachZen() gets us back in.
  let consecutiveFailures = 0;
  let pitStopDue = false;   // last segment ended at its cap -> refresh the renderer next
  let degradedDue = false;  // last error was a renderer-shrink signal -> restart now
  let everPlayed = false;   // once true, recovery is fully hands-off (no manual-wait fallback)
  let reachFailStreak = 0;  // consecutive restarts that failed to reach ZEN -> bail after 8
  while (!stop && totalPieces < args.pieces) {
    let t = null;
    try {
      const forceRestart = (args.restart && totalPieces === 0) || consecutiveFailures >= 2
        || pitStopDue || degradedDue;
      pitStopDue = false; degradedDue = false;
      const { reused, version, note } = await ensureTetrio({ port: args.port, forceRestart });
      const how = reused ? '기존 인스턴스 재사용'
        : note === 'restarted-with-debug-port' ? '실행 중이던 앱을 디버그 모드로 재시작(부착 위해 필요)'
        : '새로 실행';
      console.log(`  앱: ${how} — ${version.Browser}`);

      t = await Tetrio.connect({ port: args.port });
      activeT = t;
      await applyFocusSpoof(t);
      if (args.adblock) {
        await applyAdblock(t);
        try { await applyCosmetics(t); await sweepAds(t); } catch {}
        console.log('  광고 차단: 적용됨 (네트워크 + DOM 제거)');
      }

      // Only the very first entry waits for the user if auto-nav fails; later (recovery)
      // entries return false so we restart + retry hands-off (relaunch auto-resumes ZEN
      // ~2/3 of the time). Give up only after many consecutive failures (needs a human).
      const reached = await reachZen(t, { allowManualWait: totalPieces === 0 && !everPlayed });
      if (!reached) {
        try { await t.close(); } catch {}
        activeT = null;
        reachFailStreak++;
        if (reachFailStreak >= 8) {
          console.log('  ✖ ZEN 진입을 여러 번 재시도했으나 실패했습니다. 앱이 차단/오류 화면에 '
            + '머물러 있을 수 있으니, TETR.IO에서 직접 Solo → ZEN에 진입한 뒤 다시 실행해 주세요.');
          break;
        }
        console.log(`  ↻ ZEN 진입 실패 — 앱을 재시작해 재시도합니다 (${reachFailStreak}/8)`);
        degradedDue = true; // force a clean restart next iteration
        await sleep(1500);
        continue;
      }
      reachFailStreak = 0;
      everPlayed = true;
      recentTimes = []; // fresh rolling window so "최근 pps" isn't skewed by the restart gap
      console.log('  ✓ ZEN 화면 감지됨.');
      if (!modeAsked) {
        modeAsked = true;
        printModeMenu(modeName);
        modeName = await askMode(modeName);
      }
      console.log(`  ▶ 플레이 시작 — 모드: ${MODES[modeName].label}`);

      const botOpts = { ...MODES[modeName].opts, mode: modeName, jpegQuality: args.quality };
      if (args.postdrop) botOpts.postDropMs = Math.max(90, args.postdrop);
      const bot = new ZenBot(t, botOpts);
      currentBot = bot;
      await bot.calibrate();
      console.log('  ✓ 필드 보정 완료:', JSON.stringify(bot.absCal));
      consecutiveFailures = 0;

      const base = totalPieces;
      const remaining = args.pieces - totalPieces;
      const segCap = args.restartEvery > 0 ? Math.min(remaining, args.restartEvery) : remaining;
      const segMs = args.restartMins > 0 ? args.restartMins * 60000 : Infinity;
      await bot.run({
        maxPieces: segCap,
        maxMs: segMs,
        onTurn: (r) => {
          if (r.idleWarning) { console.log(`  … 피스 미검출 (일시정지/탑아웃?) — 대기 중`); return; }
          noteTurn();
          if ((base + r.piecesPlaced) % 20 === 0) {
            const secs = (Date.now() - t0) / 1000;
            const recent = recentPps();
            console.log(`  [${bot.mode}] 피스 ${base + r.piecesPlaced} | 라인(추정) ${totalLines + r.linesEstimate} | ` +
                        `스테이지업 ${totalStageUps + r.stageUps} | 리싱크 ${totalResyncs + bot.resyncs} | ` +
                        `오배치(추정) ${totalMispredicts + r.mispredicts} | ` +
                        `평균 ${((base + r.piecesPlaced) / Math.max(1, secs)).toFixed(2)}/초` +
                        (recent ? ` | 최근 ${recent}/초` : ''));
          }
        },
      });

      // Segment ended: accumulate. If we've hit the piece target (or user stopped) we're done;
      // otherwise this was a pit-stop cap -> restart to refresh the renderer, then continue.
      totalPieces += bot.piecesPlaced; totalLines += bot.linesEstimate;
      totalStageUps += bot.stageUps; totalResyncs += bot.resyncs; totalMispredicts += bot.mispredicts;
      currentBot = null;
      try { await t.close(); } catch {}
      activeT = null;
      if (stop || totalPieces >= args.pieces) break;
      pitStopDue = true;
      console.log(`  ♻ 정기 재시작(pit-stop): 렌더러 열화 예방 — 지금까지 ${totalPieces} 피스`);
    } catch (e) {
      if (currentBot) {
        totalPieces += currentBot.piecesPlaced; totalLines += currentBot.linesEstimate;
        totalStageUps += currentBot.stageUps; totalResyncs += currentBot.resyncs;
        totalMispredicts += currentBot.mispredicts; currentBot = null;
      }
      try { if (t) await t.close(); } catch {}
      activeT = null;
      if (e && e.degraded) {
        degradedDue = true; consecutiveFailures = 0; // known cause; restart immediately, don't escalate
        console.log(`  ⚠ 렌더러 열화 감지 — 앱 재시작으로 복구: ${e.message}`);
      } else {
        consecutiveFailures++;
        // Give up after many consecutive UNRECOVERABLE errors (e.g. a stuck single-instance
        // lock that no restart can clear) instead of spamming "복구 시도" every 2s forever.
        if (consecutiveFailures >= 8) {
          console.log(`  ✖ 복구 불가(연속 ${consecutiveFailures}회): ${e.message}`);
          console.log('     작업 관리자에서 TETR.IO.exe를 모두 종료하고, 그래도 안 되면 PC를 재부팅한 뒤 다시 실행해 주세요.');
          break;
        }
        console.log(`  ⚠ 오류(${consecutiveFailures}/8회) — 복구 시도: ${e.message}`);
      }
      if (stop) break;
      await sleep(2000);
    }
  }
  try { rl.close(); } catch {}
  console.log(`\n⏹ 종료: ${summary()}`);
  process.exit(0);
}

main().catch((e) => { console.error('치명적 오류:', e); process.exit(1); });
