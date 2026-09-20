// Sustained play test: run the bot for N pieces, log progress + occasional board.
const { ZenBot } = require('../src/bot.js');
const { Vision } = require('../src/vision/vision.js');

async function main() {
  const N = parseInt(process.argv[2] || '80', 10);
  const bot = await ZenBot.launch();
  const t0 = Date.now();
  await bot.run({
    maxPieces: N,
    onTurn: (r) => {
      if (r.idleWarning || !r.mv) return;
      if (r.piecesPlaced % 10 === 0 || r.mv.expectedResult.linesCleared) {
        const secs = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`piece ${r.piecesPlaced} | lines(est)=${r.linesEstimate} | resyncs=${bot.resyncs} | ${secs}s | keys=${JSON.stringify(r.mv.keys)}`);
      }
    },
  });
  const secs = (Date.now() - t0) / 1000;
  console.log(`\nDONE: ${bot.piecesPlaced} pieces, ${bot.linesEstimate} lines(est), ${bot.resyncs} resyncs in ${secs.toFixed(1)}s`);
  console.log(`rate: ${(bot.piecesPlaced / secs).toFixed(2)} pieces/sec`);

  // Final board snapshot
  const st = await bot.readState();
  console.log('final stack:\n' + Vision.asciiBoard(st.stackFilled));
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
