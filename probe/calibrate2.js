// Calibration 2: locate the playfield frame via near-white UI lines + grid detection.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { Tetrio } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);
  const buf = await t.screenshot();
  fs.writeFileSync(path.join(__dirname, 'cal.png'), buf);
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data } = png;
  const at = (x, y) => { const i = (y * W + x) * 4; return [data[i], data[i+1], data[i+2]]; };
  const isWhite = (x, y) => { const [r,g,b]=at(x,y); return r>190&&g>190&&b>190&&Math.abs(r-g)<30&&Math.abs(g-b)<30; };

  // For each column, count near-white pixels over the vertical band where the field lives (y 250..1350)
  const y0 = 250, y1 = 1360;
  const whiteCol = new Array(W).fill(0);
  for (let x = 0; x < W; x++) { let c=0; for (let y=y0;y<y1;y+=1) if (isWhite(x,y)) c++; whiteCol[x]=c; }

  // Find vertical lines: columns with many white pixels (frame borders are tall thin white lines)
  const tallCols = [];
  for (let x = Math.floor(W*0.38); x < Math.floor(W*0.62); x++) {
    if (whiteCol[x] > 300) tallCols.push([x, whiteCol[x]]);
  }
  console.log('tall white columns (field frame candidates), x:count:');
  console.log(tallCols.map(([x,c])=>x+':'+c).join(' '));

  // Horizontal white lines: rows with many white pixels across the field x-span
  const x0 = Math.floor(W*0.40), x1 = Math.floor(W*0.60);
  const whiteRow = new Array(H).fill(0);
  for (let y = 0; y < H; y++) { let c=0; for (let x=x0;x<x1;x+=1) if (isWhite(x,y)) c++; whiteRow[y]=c; }
  const tallRows = [];
  for (let y = 150; y < 1500; y++) if (whiteRow[y] > 200) tallRows.push([y, whiteRow[y]]);
  console.log('strong white rows (top/bottom frame candidates), y:count:');
  console.log(tallRows.map(([y,c])=>y+':'+c).join(' '));

  await t.close();
}

main().catch(e => { console.error('FAIL:', e); process.exit(1); });
