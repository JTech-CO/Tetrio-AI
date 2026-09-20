// Verify: play N pieces one at a time, compare simulator prediction vs actual screen.
const { ZenBot } = require('../src/bot.js');
const { Vision } = require('../src/vision/vision.js');

function showMatrix(m) {
  return m.map(r => r.map(c => c ? '#' : '.').join('')).join('\n');
}

async function main() {
  const N = parseInt(process.argv[2] || '6', 10);
  const bot = await ZenBot.launch();
  console.log('calibrated:', JSON.stringify(bot.cal || 'default'));

  let matches = 0, total = 0;
  for (let i = 0; i < N; i++) {
    const st = await bot.readState();
    if (!st.hasPiece) { console.log(`[piece ${i}] no current piece; waiting`); await bot.waitForSpawn(); continue; }
    console.log(`\n===== piece ${i}: current=${st.current} queue=${JSON.stringify(st.queue)} hold=${st.hold} =====`);
    const res = await bot.playOnce(st, { verify: true });
    if (res.skipped) { console.log('  skipped:', res.reason); continue; }
    total++;
    if (res.match) { matches++; console.log(`  keys=${JSON.stringify(res.mv.keys)}  -> MATCH (lines predicted ${res.mv.expectedResult.linesCleared})`); }
    else {
      console.log(`  keys=${JSON.stringify(res.mv.keys)}  -> MISMATCH`);
      console.log('  --- predicted stack ---'); console.log(showMatrix(res.predicted));
      console.log('  --- actual stack ---'); console.log(showMatrix(res.actual));
    }
  }
  console.log(`\n==== ${matches}/${total} predictions matched. pieces placed=${bot.piecesPlaced}, lines(est)=${bot.linesEstimate} ====`);
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
