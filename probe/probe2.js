// Probe 2: screenshot + rAF rate measurement (window in background)
const CDP = require('chrome-remote-interface');
const fs = require('fs');
const path = require('path');

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('https://tetr.io'));
  const client = await CDP({ target: page.id, port: 9222 });
  const { Runtime, Page } = client;
  await Runtime.enable();
  await Page.enable();

  // Measure rAF frequency over 2 seconds
  const rafTest = await Runtime.evaluate({
    expression: `new Promise(res => {
      let count = 0;
      const start = performance.now();
      function tick() { count++; if (performance.now() - start < 2000) requestAnimationFrame(tick); else res({count, elapsed: performance.now() - start}); }
      requestAnimationFrame(tick);
      setTimeout(() => res({count, elapsed: performance.now() - start, timedOut: true}), 5000);
    })`,
    awaitPromise: true, returnByValue: true, timeout: 10000,
  });
  console.log('rAF test (background):', JSON.stringify(rafTest.result.value));

  console.log('gamera:', (await Runtime.evaluate({ expression: 'typeof gamera', returnByValue: true })).result.value);

  // Screenshot
  const shot = await Page.captureScreenshot({ format: 'png' });
  const out = path.join(__dirname, 'shot1.png');
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log('screenshot saved:', out, fs.statSync(out).size, 'bytes');

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
