// Calibrate NEXT queue + HOLD preview regions by scanning for saturated blobs.
const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { Tetrio } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { rgbToHsv } = require('../src/vision/vision.js');

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);
  const buf = await t.screenshot();
  fs.writeFileSync(path.join(__dirname, 'cal.png'), buf);
  const png = PNG.sync.read(buf);
  const { width: W, height: H, data } = png;
  const at = (x,y)=>{const i=(y*W+x)*4;return rgbToHsv(data[i],data[i+1],data[i+2]);};
  const isMino=(x,y)=>{const {s,v}=at(x,y);return v>0.33&&s>0.45;};

  // NEXT box is right of field frame (~x 1924+). Scan region x in [1924, 2200], y [250,1250].
  // Build row-density to find the 5 vertical piece slots.
  const NX0=1924, NX1=2240, NY0=250, NY1=1260;
  const rowDen=[];
  for (let y=NY0;y<NY1;y++){let c=0;for(let x=NX0;x<NX1;x++)if(isMino(x,y))c++;rowDen.push([y,c]);}
  // find bands (runs of rows with c>0)
  const bands=[]; let cur=null;
  for(const [y,c] of rowDen){ if(c>3){ if(!cur)cur={y0:y,y1:y}; else cur.y1=y; } else { if(cur){bands.push(cur);cur=null;} } }
  if(cur)bands.push(cur);
  console.log('NEXT vertical bands (y0-y1, height):');
  bands.forEach(b=>console.log(`  ${b.y0}-${b.y1} h=${b.y1-b.y0}`));

  // For each band, find x extent
  bands.forEach((b,i)=>{
    const my=Math.floor((b.y0+b.y1)/2);
    let xa=NX1,xb=NX0;
    for(let y=b.y0;y<=b.y1;y++)for(let x=NX0;x<NX1;x++)if(isMino(x,y)){if(x<xa)xa=x;if(x>xb)xb=x;}
    console.log(`  band ${i}: x ${xa}-${xb} (w=${xb-xa}), y ${b.y0}-${b.y1}`);
  });

  // HOLD box: left of field (~x 1030-1290 ish). Scan.
  const HX0=1030,HX1=1300,HY0=250,HY1=520;
  let hxa=HX1,hxb=HX0,hya=HY1,hyb=HY0,cnt=0;
  for(let y=HY0;y<HY1;y++)for(let x=HX0;x<HX1;x++)if(isMino(x,y)){cnt++;if(x<hxa)hxa=x;if(x>hxb)hxb=x;if(y<hya)hya=y;if(y>hyb)hyb=y;}
  console.log(`HOLD: saturated count=${cnt}, bbox x ${hxa}-${hxb} y ${hya}-${hyb} (empty if count~0)`);

  await t.close();
}
main().catch(e=>{console.error('FAIL:',e);process.exit(1);});
