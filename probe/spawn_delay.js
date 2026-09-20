// Measure spawn timing: after a hard drop, how soon is the new piece cleanly readable,
// and does the current piece detection stabilize? Uses cheap full readState timestamps.
const { ZenBot } = require('../src/bot.js');
const { Board } = require('../src/board.js');
const { pickMove } = require('../src/ai.js');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const bot = await ZenBot.launch();
  for (let trial = 0; trial < 6; trial++) {
    // get a clean current piece
    let st;
    for (;;) { st = await bot.readState(); if (st.hasPiece && st.current) break; await sleep(50); }
    const sim = Board.fromMatrix(st.stackFilled);
    const mv = pickMove({ board: sim, current: st.current, queue: st.queue.filter(Boolean), hold: st.hold, canHold: true });
    if (!mv) break;
    await bot.runKeys(mv.keys);
    bot.advanceCurrent(st.queue.filter(Boolean), mv.useHold, st.hold);
    const tDrop = now();
    // poll rapidly for the new piece
    let firstSeen = null, firstStable = null, stableCount = 0, polls = 0;
    while (now() - tDrop < 1500) {
      const s = await bot.readState(); polls++;
      const t = now() - tDrop;
      if (s.hasPiece && s.currentCells) {
        if (firstSeen === null) firstSeen = t;
        stableCount++;
        if (stableCount >= 2 && firstStable === null) firstStable = t;
      } else { stableCount = 0; }
      if (firstStable) break;
    }
    console.log(`trial ${trial}: firstSeen=${firstSeen}ms firstStable=${firstStable}ms polls=${polls} keys=${JSON.stringify(mv.keys)}`);
  }
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
