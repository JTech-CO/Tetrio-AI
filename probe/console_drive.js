'use strict';
// Drive src/run.js through its console the way a person would: type a command when the log
// reaches a piece count. Used to check live mode/strategy switching end to end.
//
//   node probe/console_drive.js <log> <at>:<cmd> ... -- <run.js options>
//   node probe/console_drive.js quad.log 150:quad 500:1 650:3 -- --mode rapid --pieces 1300 --restart-every 0
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const argv = process.argv.slice(2);
const split = argv.indexOf('--');
const [log, ...steps] = split < 0 ? argv : argv.slice(0, split);
const runArgs = split < 0 ? [] : argv.slice(split + 1);
const plan = steps.map(s => { const i = s.indexOf(':'); return { at: Number(s.slice(0, i)), cmd: s.slice(i + 1) }; });

const out = fs.createWriteStream(log);
const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'run.js'), ...runArgs],
  { cwd: path.join(__dirname, '..') });
let buf = '';
child.stdout.on('data', (d) => {
  out.write(d); buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const m = buf.slice(0, i).match(/피스 (\d+) \|/);
    buf = buf.slice(i + 1);
    while (m && plan.length && Number(m[1]) >= plan[0].at) {
      const { cmd } = plan.shift();
      out.write(`>>> [driver] 입력: ${cmd}\n`);
      child.stdin.write(cmd + '\n');
    }
  }
});
child.stderr.on('data', d => out.write(d));
child.on('exit', (code) => { out.write(`>>> [driver] run.js 종료 code=${code}\n`); out.end(() => process.exit(code || 0)); });
