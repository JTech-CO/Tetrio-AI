// Diagnose the ~5min crash: track JS heap, DOM node count, ad-iframe count, and renderer
// crash events while the bot plays. Also snapshot for the "bounce".
const { ZenBot } = require('../src/bot.js');
const fs = require('fs');
const path = require('path');

async function main() {
  const bot = await ZenBot.launch();

  // Listen for renderer crash / target gone.
  bot.t.client.Inspector && bot.t.client.Inspector.targetCrashed(() => console.log('!!! Inspector.targetCrashed'));
  bot.t.client.Runtime.exceptionThrown && bot.t.client.Runtime.exceptionThrown((p) => {
    console.log('exception:', (p.exceptionDetails && p.exceptionDetails.text) || '?');
  });

  const stats = async () => {
    try {
      return await bot.t.eval(`(() => ({
        heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1,
        heapLimitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit/1048576) : -1,
        nodes: document.getElementsByTagName('*').length,
        iframes: document.getElementsByTagName('iframe').length,
        win: window.innerWidth + 'x' + window.innerHeight,
      }))`);
    } catch (e) { return { err: e.message }; }
  };

  console.log('start:', JSON.stringify(await stats()));
  const t0 = Date.now();
  let lastLog = 0;

  bot.run({
    maxPieces: 100000,
    onTurn: async (r) => {
      const secs = (Date.now() - t0) / 1000;
      if (secs - lastLog >= 15) {
        lastLog = secs;
        const s = await stats();
        console.log(`t=${secs.toFixed(0)}s pieces=${bot.piecesPlaced} lines=${bot.linesEstimate} | ${JSON.stringify(s)}`);
      }
    },
  }).catch(e => console.log('run() threw:', e.message));

  // Stop after 6 minutes
  setTimeout(async () => { bot.stop = true; console.log('final:', JSON.stringify(await stats())); await bot.t.close(); process.exit(0); }, 360000);
}
main().catch(e => { console.error('FAIL:', e); process.exit(1); });
