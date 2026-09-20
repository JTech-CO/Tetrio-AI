// Probe 1: connect to TETR.IO page target, inspect globals and page state
const CDP = require('chrome-remote-interface');

async function main() {
  const targets = await CDP.List({ port: 9222 });
  const page = targets.find(t => t.type === 'page' && t.url.startsWith('https://tetr.io'));
  if (!page) throw new Error('No tetr.io page target found');
  console.log('TARGET:', page.id, page.url);

  const client = await CDP({ target: page.id, port: 9222 });
  const { Runtime } = client;
  await Runtime.enable();

  const evalJS = async (expr) => {
    const r = await Runtime.evaluate({ expression: expr, returnByValue: true });
    if (r.exceptionDetails) return { error: r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception?.description || '') };
    return r.result.value;
  };

  console.log('readyState:', await evalJS('document.readyState'));
  console.log('canvases:', await evalJS(`[...document.querySelectorAll('canvas')].map(c => ({id: c.id, w: c.width, h: c.height, cw: c.clientWidth, ch: c.clientHeight}))`));
  console.log('DEVHOOK keys:', await evalJS(`Object.keys(window).filter(k => k.toUpperCase().includes('DEVHOOK'))`));
  console.log('interesting globals:', await evalJS(`Object.keys(window).filter(k => /^(GAME|game|tetrio|TETRIO|IS_ELECTRON|CLIENT|PIXI|app)/.test(k)).slice(0, 40)`));
  console.log('visibilityState:', await evalJS('document.visibilityState'), 'hasFocus:', await evalJS('document.hasFocus()'));
  console.log('viewport:', await evalJS('({w: window.innerWidth, h: window.innerHeight, dpr: window.devicePixelRatio})'));
  // What menu/screen is currently visible? TETR.IO uses #menus with various divs
  console.log('visible menu ids:', await evalJS(`[...document.querySelectorAll('[id]')].filter(e => e.offsetParent !== null && e.id).map(e => e.id).slice(0, 60)`));

  await client.close();
}

main().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
