// Probe 8: full read — board + current piece + NEXT queue + HOLD, verified against screenshot.
const fs = require('fs');
const path = require('path');
const { Tetrio } = require('../src/runtime/cdp.js');
const { applyFocusSpoof } = require('../src/runtime/focus.js');
const { Vision } = require('../src/vision/vision.js');
const { extractCurrentPiece } = require('../src/vision/pieces.js');

async function main() {
  const t = await Tetrio.connect();
  await applyFocusSpoof(t);
  const buf = await t.screenshot();
  fs.writeFileSync(path.join(__dirname, 'shot_read.png'), buf);

  let cal; try { cal = Vision.detectFrame(buf); } catch(e){ console.log('detect fail', e.message); }
  const v = new Vision(cal);
  const { filled, grid } = v.readBoard(buf);
  const { piece, stackFilled } = extractCurrentPiece(filled);

  console.log('=== FULL BOARD (current piece + stack) ===');
  console.log(Vision.asciiBoard(filled, grid));
  console.log('\n=== CURRENT PIECE:', piece ? piece.letter : 'none', piece ? JSON.stringify(piece.cells) : '');
  console.log('\n=== STACK ONLY ===');
  console.log(Vision.asciiBoard(stackFilled));
  console.log('\n=== NEXT QUEUE:', JSON.stringify(v.readQueue(buf)));
  console.log('=== HOLD:', v.readHold(buf));

  await t.close();
}
main().catch(e=>{console.error('FAIL:',e);process.exit(1);});
