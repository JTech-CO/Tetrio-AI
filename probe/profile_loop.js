// Profile the play loop: per piece, count captures and time each phase.
const { ZenBot } = require('../src/bot.js');
const { Board } = require('../src/board.js');
const { pickMove } = require('../src/ai.js');
const now = () => Number(process.hrtime.bigint() / 1000000n);

async function main() {
  const N = parseInt(process.argv[2] || '20', 10);
  const bot = await ZenBot.launch();
  let captures = 0;
  const origGrab = bot.grab.bind(bot);
  bot.grab = async () => { captures++; return origGrab(); };

  const stats = [];
  for (let p = 0; p < N; p++) {
    const tPieceStart = now();
    captures = 0;
    // read (retry until piece)
    let st, tReadStart = now(), reads = 0;
    for (;;) {
      st = await bot.readState(); reads++;
      if (st.hasPiece && st.current) break;
      await new Promise(r => setTimeout(r, 60));
    }
    const tRead = now() - tReadStart;
    // decide
    const tDec = now();
    const sim = Board.fromMatrix(st.stackFilled);
    const mv = pickMove({ board: sim, current: st.current, queue: st.queue.filter(Boolean), hold: st.hold, canHold: true });
    const decMs = now() - tDec;
    if (!mv) { console.log('null move'); break; }
    // execute
    const tKeys = now();
    await bot.runKeys(mv.keys);
    const keysMs = now() - tKeys;
    const tWait = now();
    await new Promise(r => setTimeout(r, bot.opts.postDropMs));
    const waitMs = now() - tWait;
    bot.advanceCurrent(st.queue.filter(Boolean), mv.useHold, st.hold);
    bot.piecesPlaced++;
    stats.push({ total: now() - tPieceStart, reads, captures, readMs: tRead, decMs, keysMs, waitMs, nkeys: mv.keys.length });
  }
  const avg = k => (stats.reduce((a, b) => a + b[k], 0) / stats.length).toFixed(0);
  console.log(`\n== per-piece averages over ${stats.length} ==`);
  console.log(`total ${avg('total')}ms | reads ${avg('reads')} | captures ${avg('captures')} | readMs ${avg('readMs')} | decMs ${avg('decMs')} | keysMs ${avg('keysMs')} | waitMs ${avg('waitMs')} | nkeys ${avg('nkeys')}`);
  console.log('samples:', JSON.stringify(stats.slice(0, 8)));
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
