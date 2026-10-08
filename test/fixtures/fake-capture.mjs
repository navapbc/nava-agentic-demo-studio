#!/usr/bin/env node
// Stands in for native/demo-capture in tests: speaks the same stdout protocol
// and writes a frames manifest and pointer log, without Screen Recording
// permission.
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => args[args.indexOf(name) + 1];
const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
if (args[0] !== 'record') {
  say({ event: 'targets', displays: [], windows: [] });
  process.exit(0);
}
const out = option('--out');
const prefix = option('--url-prefix');
mkdirSync(join(out, 'frames'), { recursive: true });
writeFileSync(join(out, 'pointer.jsonl'), '');
let t0 = null;
const frames = [];
const path = [[0.2, 0.2, false], [0.3, 0.25, false], [0.45, 0.35, false], [0.6, 0.5, false], [0.6, 0.5, true], [0.6, 0.5, false]];
let step = 0;
say({ event: 'target', window: { id: 1, app: 'Fake', title: 'Fake window' } });
say({ event: 'ready', width: 2880, height: 1800 });
function start() {
  t0 = Date.now();
  frames.push({ t: 0, src: `${prefix}/frames/000001.jpg` });
  writeFileSync(join(out, 'frames', '000001.jpg'), 'jpeg');
  say({ event: 'started' });
  const timer = setInterval(() => {
    if (step >= path.length) return clearInterval(timer);
    const [x, y, down] = path[step];
    step += 1;
    appendFileSync(join(out, 'pointer.jsonl'), `${JSON.stringify({ t: Date.now() - t0, x, y, down })}\n`);
  }, 40);
}
function stop() {
  const durationMs = Date.now() - t0;
  writeFileSync(join(out, 'frames.json'), JSON.stringify({ schema: 'nava.demo-frames.v1', origin: 'screen', width: 2880, height: 1800, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, durationMs, frames }));
  say({ event: 'stopped', frames: frames.length, dropped: 0, durationMs });
  process.exit(0);
}
// Same control channel as the real helper: "start" / "stop" lines on stdin.
let buffered = '';
process.stdin.on('data', (chunk) => {
  buffered += chunk;
  const lines = buffered.split('\n');
  buffered = lines.pop();
  for (const line of lines) {
    if (line.trim() === 'start') start();
    if (line.trim() === 'stop') stop();
  }
});
process.stdin.on('end', () => stop());
setInterval(() => {}, 1000);
