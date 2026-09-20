// Long-run stability test: play for N minutes, log rate + window size + heap + slow captures.
const { ZenBot } = require('../src/bot.js');
const now = () => Number(process.hrtime.bigint() / 1000000n);

async function main() {
  const mins = parseFloat(process.argv[2] || '6');
  const bot = await ZenBot.launch();

  if (bot.t.client.Inspector) bot.t.client.Inspector.targetCrashed(() => console.log('!!! RENDERER CRASHED (targetCrashed)'));

  // Instrument grab() to catch slow captures.
  let slowCaptures = 0, maxCap = 0;
  const origGrab = bot.grab.bind(bot);
  bot.grab = async () => { const s = now(); const r = await origGrab(); const d = now() - s; if (d > maxCap) maxCap = d; if (d > 1000) { slowCaptures++; console.log(`  slow capture: ${d}ms (piece ${bot.piecesPlaced})`); } return r; };

  const stat = async () => {
    try { return await bot.t.eval(`(function(){return {heapMB: performance.memory?Math.round(performance.memory.usedJSHeapSize/1048576):-1, iframes: document.getElementsByTagName('iframe').length, win: window.innerWidth+'x'+window.innerHeight};})()`); }
    catch (e) { return { err: e.message }; }
  };

  console.log('start:', JSON.stringify(await stat()));
  const t0 = now();
  let lastLog = 0;
  const runP = bot.run({
    maxPieces: 100000,
    onTurn: async () => {
      const secs = (now() - t0) / 1000;
      if (secs - lastLog >= 20) {
        lastLog = secs;
        const s = await stat();
        console.log(`t=${secs.toFixed(0)}s pieces=${bot.piecesPlaced} lines=${bot.linesEstimate} rate=${(bot.piecesPlaced/secs).toFixed(2)}/s resyncs=${bot.resyncs} maxCap=${maxCap}ms slow=${slowCaptures} | ${JSON.stringify(s)}`);
      }
    },
  }).catch(e => console.log('!!! run() threw:', e.message));

  setTimeout(async () => {
    bot.stop = true;
    console.log('FINAL:', JSON.stringify(await stat()), `pieces=${bot.piecesPlaced} lines=${bot.linesEstimate} rate=${(bot.piecesPlaced/((now()-t0)/1000)).toFixed(2)}/s resyncs=${bot.resyncs} slowCaptures=${slowCaptures} maxCap=${maxCap}ms`);
    try { await bot.t.close(); } catch (e) {}
    process.exit(0);
  }, mins * 60000);
  await runP;
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
