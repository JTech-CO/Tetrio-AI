const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');
const { Vision, rgbToHsv } = require('../src/vision/vision.js');

const buf = fs.readFileSync(path.join(__dirname, 'shot_read.png'));
const png = PNG.sync.read(buf);
const { width: W, height: H, data } = png;
const cal = Vision.detectFrame(buf);
const v = new Vision(cal);
console.log('cal', JSON.stringify(cal));
console.log('next region', JSON.stringify(v.next));
console.log('hold region', JSON.stringify(v.hold));

const isSat = (x,y)=>{const i=(y*W+x)*4;const {s,v}=rgbToHsv(data[i],data[i+1],data[i+2]);return v>0.33&&s>0.45;};

// Scan the whole NEXT column strip and report saturated bands (y) with x-extent + sample hue
const NX0=v.next.x0, NX1=v.next.x1;
let cur=null; const bands=[];
for(let y=250;y<1300;y++){
  let c=0,xa=NX1,xb=NX0; for(let x=NX0;x<NX1;x++) if(isSat(x,y)){c++; if(x<xa)xa=x; if(x>xb)xb=x;}
  if(c>2){ if(!cur)cur={y0:y,y1:y,xa,xb}; else {cur.y1=y; cur.xa=Math.min(cur.xa,xa); cur.xb=Math.max(cur.xb,xb);} }
  else { if(cur && y-cur.y1>15){bands.push(cur);cur=null;} }
}
if(cur)bands.push(cur);
console.log('\nNEXT saturated bands:');
bands.forEach((b,i)=>{
  const mx=Math.floor((b.xa+b.xb)/2), my=Math.floor((b.y0+b.y1)/2);
  const idx=(my*W+mx)*4; const hsv=rgbToHsv(data[idx],data[idx+1],data[idx+2]);
  console.log(`  band${i}: y ${b.y0}-${b.y1} (h=${b.y1-b.y0}) x ${b.xa}-${b.xb} (w=${b.xb-b.xa}) midHue=${hsv.h.toFixed(0)} s=${hsv.s.toFixed(2)} v=${hsv.v.toFixed(2)}`);
});

// HOLD region saturated count
let hc=0; for(let y=v.hold.y0;y<v.hold.y1;y++)for(let x=v.hold.x0;x<v.hold.x1;x++)if(isSat(x,y))hc++;
console.log('\nHOLD saturated count:', hc, '(region', JSON.stringify(v.hold)+')');
