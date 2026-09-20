// Measure the true spawn delay (ARE): time from hard-drop until the next piece is first
// visible, with tight fast polling (downscaled reads).
const { ZenBot } = require('../src/bot.js');
const { Board } = require('../src/board.js');
const { pickMove } = require('../src/ai.js');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const bot = await ZenBot.launch();
  const results = [];
  for (let trial = 0; trial < 12; trial++) {
    let st;
    for (;;) { st = await bot.readState(); if (st.hasPiece && st.current) break; await sleep(30); }
    const sim = Board.fromMatrix(st.stackFilled);
    const mv = pickMove({ board: sim, current: st.current, queue: st.queue.filter(Boolean), hold: st.hold, canHold: true });
    if (!mv) break;
    await bot.runKeys(mv.keys);
    bot.advanceCurrent(st.queue.filter(Boolean), mv.useHold, st.hold);
    const tDrop = now();
    // tight poll: minimal sleep, measure first-visible
    let firstVisible = null, readMs = [];
    while (now() - tDrop < 2000) {
      const t0 = now(); const s = await bot.readState(); readMs.push(now() - t0);
      if (s.hasPiece && s.currentCells) { firstVisible = now() - tDrop; break; }
      // no sleep — poll as fast as possible
    }
    results.push({ firstVisible, cleared: mv.expectedResult.linesCleared, avgRead: readMs.reduce((a,b)=>a+b,0)/readMs.length, polls: readMs.length });
    bot.piecesPlaced++;
  }
  console.log('per-trial firstVisible (ms), cleared, polls:');
  results.forEach((r,i) => console.log(`  ${i}: firstVisible=${r.firstVisible}ms cleared=${r.cleared} polls=${r.polls} avgRead=${r.avgRead.toFixed(0)}ms`));
  const fv = results.map(r=>r.firstVisible).filter(x=>x!=null);
  console.log(`\nARE (first-visible after drop): min=${Math.min(...fv)}ms avg=${(fv.reduce((a,b)=>a+b,0)/fv.length).toFixed(0)}ms max=${Math.max(...fv)}ms`);
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
