// Test a tracking-driven, no-visibility-wait loop for correctness + speed.
// Each turn: read board (clean stack, new piece still hidden), use TRACKED current piece,
// decide, send keys, advance tracking. Verify each placement matched the sim prediction by
// comparing the predicted stack to the next turn's read.
const { ZenBot } = require('../src/bot.js');
const { Board } = require('../src/board.js');
const { pickMove } = require('../src/ai.js');
const { boardToVisibleMatrix, matricesEqual } = require('../src/bot.js');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const N = parseInt(process.argv[2] || '40', 10);
  const postDrop = parseInt(process.argv[3] || '60', 10);
  const bot = await ZenBot.launch();

  // bootstrap: wait for a visible current piece
  let st;
  for (;;) { st = await bot.readState(); if (st.hasPiece && st.current) break; await sleep(30); }
  bot.current = st.current;

  const t0 = now();
  let prevPredicted = null, mismatches = 0, placed = 0, lines = 0;
  for (let p = 0; p < N; p++) {
    st = await bot.readState(); // clean stack (new piece hidden or removed by extractor)
    // verify previous prediction against this read (ignore top 4 rows)
    if (prevPredicted) {
      const actual = st.stackFilled.map(r => r.map(Boolean));
      if (!matricesEqual(prevPredicted.slice(4), actual.slice(4))) mismatches++;
    }
    const cur = bot.current || st.current;
    if (!cur) { await sleep(30); continue; }
    const sim = Board.fromMatrix(st.stackFilled);
    const mv = pickMove({ board: sim, current: cur, queue: st.queue.filter(Boolean), hold: st.hold, canHold: true });
    if (!mv) { console.log('pickMove null at', p); break; }
    await bot.runKeys(mv.keys);
    prevPredicted = boardToVisibleMatrix(mv.expectedResult.board);
    bot.advanceCurrent(st.queue.filter(Boolean), mv.useHold, st.hold);
    placed++; lines += mv.expectedResult.linesCleared;
    if (postDrop) await sleep(postDrop);
  }
  const secs = (now() - t0) / 1000;
  console.log(`postDrop=${postDrop}ms placed=${placed} lines=${lines} mismatches=${mismatches} in ${secs.toFixed(1)}s -> ${(placed/secs).toFixed(2)} pieces/sec`);
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
