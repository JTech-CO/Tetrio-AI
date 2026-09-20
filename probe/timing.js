// Measure per-stage timing to find the bottleneck.
const { Tetrio } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { Vision } = require('../src/vision/vision.js');
const { PNG } = require('pngjs');

const now = () => Number(process.hrtime.bigint() / 1000000n);

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);
  const buf0 = await t.screenshot();
  const cal = Vision.detectFrame(buf0);
  const v = new Vision(cal);

  const clip = { x: 500, y: 120, w: 640, h: 590, scale: 1 }; // CSS px region (viewport is 1603x803)

  const times = { fullShot: [], clipShot: [], decode: [], readBoard: [], readQueue: [] };
  for (let i = 0; i < 6; i++) {
    let s = now(); const full = await t.screenshot(); times.fullShot.push(now() - s);
    s = now(); const clipped = await t.screenshot(clip); times.clipShot.push(now() - s);
    s = now(); const png = PNG.sync.read(full); times.decode.push(now() - s);
    s = now(); v.readBoard(png); times.readBoard.push(now() - s);
    s = now(); v.readQueue(png); times.readQueue.push(now() - s);
  }
  const avg = a => (a.reduce((x,y)=>x+y,0)/a.length).toFixed(0);
  console.log('full screenshot (capture+b64):', avg(times.fullShot), 'ms', JSON.stringify(times.fullShot));
  console.log('clipped screenshot:', avg(times.clipShot), 'ms', JSON.stringify(times.clipShot));
  console.log('PNG decode (full):', avg(times.decode), 'ms');
  console.log('readBoard:', avg(times.readBoard), 'ms');
  console.log('readQueue:', avg(times.readQueue), 'ms');
  console.log('clip size bytes:', (await t.screenshot(clip)).length, 'vs full', (await t.screenshot()).length);
  await t.close();
}
main().catch(e=>{console.error('FAIL:',e);process.exit(1);});
