// Detailed per-piece profiler at the CURRENT window size. Breaks down read/decide/keys/wait,
// splits by line-clear vs not, and separately measures a downscaled capture.
const { ZenBot } = require('../src/bot.js');
const { Board } = require('../src/board.js');
const { pickMove } = require('../src/ai.js');
const jpeg = require('jpeg-js');
const now = () => Number(process.hrtime.bigint() / 1000000n);
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const N = parseInt(process.argv[2] || '25', 10);
  const bot = await ZenBot.launch();
  console.log('window clip:', JSON.stringify(bot.clip), 'cellW', bot.vision.colW.toFixed(1));

  // measure capture+decode at current scale (1) vs downscaled
  const measCap = async (scale) => {
    const clip = { ...bot.clip, scale };
    const s = now();
    const r = await bot.t.client.Page.captureScreenshot({ format: 'jpeg', quality: 85, clip: { x: clip.x, y: clip.y, width: clip.w, height: clip.h, scale } });
    const cap = now() - s;
    const s2 = now(); const raw = jpeg.decode(Buffer.from(r.data, 'base64'), { useTArray: true, formatAsRGBA: true }); const dec = now() - s2;
    return { cap, dec, dim: raw.width + 'x' + raw.height };
  };
  for (const sc of [1, 0.6, 0.4]) { const m = await measCap(sc); console.log(`capture scale=${sc}: ${m.dim} cap=${m.cap}ms dec=${m.dec}ms total=${m.cap+m.dec}ms`); }

  const rows = { read: [], decide: [], keys: [], wait: [], nkeys: [], cleared: [] };
  for (let p = 0; p < N; p++) {
    // read (retry until piece)
    let st, tR = now();
    for (;;) { st = await bot.readState(); if (st.hasPiece && st.current) break; await sleep(40); }
    rows.read.push(now() - tR);
    const tD = now();
    const sim = Board.fromMatrix(st.stackFilled);
    const mv = pickMove({ board: sim, current: st.current, queue: st.queue.filter(Boolean), hold: st.hold, canHold: true });
    rows.decide.push(now() - tD);
    if (!mv) break;
    const tK = now(); await bot.runKeys(mv.keys); rows.keys.push(now() - tK);
    rows.nkeys.push(mv.keys.length);
    rows.cleared.push(mv.expectedResult.linesCleared > 0 ? 1 : 0);
    // wait for next piece detectable
    const tW = now();
    let tries = 0;
    for (;;) { const s = await bot.readState(); tries++; if (s.hasPiece && s.currentCells && Math.min(...s.currentCells.map(c=>c[1])) <= 12) break; if (now()-tW > 3000) break; await sleep(25); }
    rows.wait.push(now() - tW);
    bot.advanceCurrent(st.queue.filter(Boolean), mv.useHold, st.hold);
    bot.piecesPlaced++;
  }
  const avg = a => a.length ? (a.reduce((x,y)=>x+y,0)/a.length).toFixed(0) : '-';
  const avgWhere = (a, mask, want) => { const f = a.filter((_,i)=>mask[i]===want); return f.length ? (f.reduce((x,y)=>x+y,0)/f.length).toFixed(0) : '-'; };
  console.log(`\n== per-piece (${rows.read.length} pieces) ==`);
  console.log(`read=${avg(rows.read)}ms decide=${avg(rows.decide)}ms keys=${avg(rows.keys)}ms wait=${avg(rows.wait)}ms nkeys=${avg(rows.nkeys)}`);
  console.log(`wait (no clear)=${avgWhere(rows.wait, rows.cleared, 0)}ms | wait (line clear)=${avgWhere(rows.wait, rows.cleared, 1)}ms`);
  console.log(`clear fraction=${(rows.cleared.reduce((a,b)=>a+b,0)/rows.cleared.length).toFixed(2)}`);
  const total = ['read','decide','keys','wait'].reduce((s,k)=>s+ +avg(rows[k]),0);
  console.log(`approx total/piece=${total}ms -> ${(1000/total).toFixed(2)} pieces/sec`);
  await bot.t.close();
}
main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
