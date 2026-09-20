// Parameter sweep: for each (postDrop, tapHold, tapGap), run the tracking loop and measure
// pieces/sec AND misplacement rate (sim prediction vs next read). Finds the fastest RELIABLE config.
const { ZenBot } = require('../src/bot.js');
const { Board } = require('../src/board.js');
const { pickMove } = require('../src/ai.js');
const { boardToVisibleMatrix, matricesEqual } = require('../src/bot.js');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function runConfig(bot, { postDrop, tapHold, tapGap, afterRotate, N }) {
  bot.opts.postDropMs = postDrop; bot.opts.tapHoldMs = tapHold; bot.opts.tapGapMs = tapGap;
  bot.opts.afterRotateMs = afterRotate;
  // bootstrap current
  let st;
  for (;;) { st = await bot.readState(); if (st.hasPiece && st.current) break; await sleep(30); }
  bot.current = st.current;
  const t0 = now();
  let prevPredicted = null, mismatches = 0, placed = 0;
  for (let p = 0; p < N; p++) {
    st = await bot.readState();
    if (prevPredicted) {
      const actual = st.stackFilled.map(r => r.map(Boolean));
      if (!matricesEqual(prevPredicted.slice(4), actual.slice(4))) mismatches++;
    }
    const cur = bot.current || st.current;
    if (!cur) { await sleep(30); prevPredicted = null; continue; }
    const sim = Board.fromMatrix(st.stackFilled);
    const mv = pickMove({ board: sim, current: cur, queue: st.queue.filter(Boolean), hold: st.hold, canHold: true });
    if (!mv) { prevPredicted = null; await sleep(80); continue; }
    await bot.runKeys(mv.keys);
    prevPredicted = boardToVisibleMatrix(mv.expectedResult.board);
    bot.advanceCurrent(st.queue.filter(Boolean), mv.useHold, st.hold);
    placed++;
    await sleep(postDrop);
  }
  const secs = (now() - t0) / 1000;
  return { postDrop, tapHold, tapGap, afterRotate, placed, mismatches, pps: placed / secs, missPct: 100 * mismatches / placed };
}

async function main() {
  const N = parseInt(process.argv[2] || '35', 10);
  const bot = await ZenBot.launch();
  // Safety: only proceed if the field was really detected (else stray keys navigate menus).
  const { DEFAULT_CAL } = require('../src/vision/vision.js');
  if (!bot.absCal || bot.absCal.fieldLeft === DEFAULT_CAL.fieldLeft) {
    console.error('ABORT: field not detected (not in ZEN?). No keys sent.');
    await bot.t.close(); process.exit(2);
  }
  const configs = [
    { postDrop: 140, tapHold: 16, tapGap: 12, afterRotate: 18 }, // current baseline
    { postDrop: 120, tapHold: 14, tapGap: 10, afterRotate: 14 },
    { postDrop: 110, tapHold: 12, tapGap: 9,  afterRotate: 12 },
    { postDrop: 95,  tapHold: 12, tapGap: 8,  afterRotate: 10 },
    { postDrop: 80,  tapHold: 10, tapGap: 7,  afterRotate: 9 },
  ];
  for (const c of configs) {
    const r = await runConfig(bot, { ...c, N });
    console.log(`postDrop=${r.postDrop} tap=${r.tapHold}/${r.tapGap} rot=${r.afterRotate} -> ${r.pps.toFixed(2)} pps, miss=${r.mismatches}/${r.placed} (${r.missPct.toFixed(1)}%)`);
  }
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
