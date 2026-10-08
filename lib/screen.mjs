// Screen recording backend: builds and drives the native ScreenCaptureKit
// helper (native/demo-capture.swift) and turns its pointer log into trace
// events, so a real window (browser chrome, extension side panels, native
// apps) gets the same auto-zoom, cursor, and click treatment as a page capture.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TRACE_SCHEMA } from './planner.mjs';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SOURCE = join(root, 'native', 'demo-capture.swift');

// Compiles the helper once per source revision into the user cache.
export async function captureHelper() {
  if (process.env.DEMO_STUDIO_CAPTURE_HELPER) return process.env.DEMO_STUDIO_CAPTURE_HELPER;
  const source = await readFile(SOURCE);
  const digest = createHash('sha256').update(source).digest('hex').slice(0, 12);
  const binary = join(process.env.DEMO_STUDIO_CACHE || join(homedir(), '.cache', 'nava-demo-studio'), 'bin', `demo-capture-${digest}`);
  try {
    await access(binary);
    return binary;
  } catch {
    // Not built yet for this revision.
  }
  if (process.platform !== 'darwin') throw new Error('Screen recording uses ScreenCaptureKit and needs macOS 13 or newer.');
  await mkdir(dirname(binary), { recursive: true });
  try {
    await run('swiftc', ['-O', SOURCE, '-o', binary], { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    throw new Error(`Could not build the screen capture helper. Install the Xcode Command Line Tools (xcode-select --install). ${String(error.stderr || error.message).split('\n')[0]}`);
  }
  return binary;
}

function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export async function listTargets() {
  const helper = await captureHelper();
  const { stdout } = await run(helper, ['list']).catch((error) => ({ stdout: error.stdout || '' }));
  const result = stdout.split('\n').map(parseLine).find(Boolean);
  if (!result || result.event === 'error') throw new Error(result?.message || 'The capture helper did not respond.');
  return result;
}

export function targetArgs(target = {}) {
  if (target.window) return ['--window', String(target.window)];
  if (target.pid) return ['--pid', String(target.pid)];
  if (target.app) return ['--app', target.app, ...(target.title ? ['--title', target.title] : [])];
  if (target.display) return ['--display', String(target.display)];
  return [];
}

// One running capture. start() resolves once frames are flowing; begin()
// marks t = 0; stop() finalizes and resolves with the frames manifest.
export class ScreenCapture {
  constructor({ outDir, urlPrefix, target, fps = 60, scale = 2, quality = 0.85, activate = false, log = () => {} }) {
    Object.assign(this, { outDir, urlPrefix, target, fps, scale, quality, activate, log });
    this.waiters = [];
  }

  async start() {
    const helper = await captureHelper();
    await mkdir(this.outDir, { recursive: true });
    const args = ['record', '--out', this.outDir, '--url-prefix', this.urlPrefix, '--fps', String(this.fps), '--scale', String(this.scale), '--quality', String(this.quality), ...targetArgs(this.target), ...(this.activate ? ['--activate'] : [])];
    this.child = spawn(helper, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.exited = new Promise((done) => this.child.once('exit', (code) => done(code)));
    let stderr = '';
    this.child.stderr.on('data', (chunk) => { stderr += chunk; });
    createInterface({ input: this.child.stdout }).on('line', (line) => {
      const message = parseLine(line);
      if (!message) return;
      if (message.event === 'target') this.targetInfo = message.window || { display: message.display };
      for (const waiter of [...this.waiters]) {
        if (waiter.events.includes(message.event)) {
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
    });
    const ready = await Promise.race([
      this.next(['ready', 'error']),
      this.exited.then((code) => ({ event: 'error', message: `capture helper exited (${code}). ${stderr.trim()}` })),
    ]);
    if (ready.event === 'error') throw new Error(ready.message);
    this.log(`screen: capturing ${this.targetInfo?.app ? `${this.targetInfo.app} window "${this.targetInfo.title}"` : 'display'} at ${ready.width}x${ready.height}`);
    return ready;
  }

  next(events) {
    return new Promise((resolvePromise) => this.waiters.push({ events, resolve: resolvePromise }));
  }

  async begin() {
    const started = this.next(['started']);
    this.child.stdin.write('start\n');
    await started;
  }

  async stop() {
    const stopped = this.next(['stopped', 'error']);
    this.child.stdin.end('stop\n');
    const summary = await Promise.race([stopped, this.exited.then(() => ({ event: 'stopped' }))]);
    await this.exited;
    const manifest = JSON.parse(await readFile(join(this.outDir, 'frames.json'), 'utf8'));
    return { summary, manifest };
  }
}

// Ramer-Douglas-Peucker simplification of a pointer path.
function simplify(points, epsilon) {
  if (points.length < 3) return points;
  const [first, last] = [points[0], points[points.length - 1]];
  let farthest = 0;
  let index = 0;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy) || 1e-9;
  for (let cursor = 1; cursor < points.length - 1; cursor += 1) {
    const distance = Math.abs((dy * points[cursor].x) - (dx * points[cursor].y) + (last.x * first.y) - (last.y * first.x)) / length;
    if (distance > farthest) {
      farthest = distance;
      index = cursor;
    }
  }
  if (farthest <= epsilon) return [first, last];
  return [...simplify(points.slice(0, index + 1), epsilon).slice(0, -1), ...simplify(points.slice(index), epsilon)];
}

const round = (value) => Number(Math.min(1, Math.max(0, value)).toFixed(4));

// Converts the helper's pointer log into trace events: a click at every
// button press, and movement bursts simplified into move segments. Chained
// segments carry `ease` so the drawn cursor glides through corners instead of
// stopping at each one.
export function pointerEvents(samples, { stillMs = 140, epsilon = 0.006 } = {}) {
  const events = [];
  if (!samples.length) return events;
  const sorted = [...samples].sort((left, right) => left.t - right.t);
  events.push({ atMs: Math.max(0, sorted[0].t), endMs: Math.max(0, sorted[0].t), kind: 'move', x: round(sorted[0].x), y: round(sorted[0].y), ...(sorted[0].cursor ? { cursor: sorted[0].cursor } : {}) });
  let burst = [sorted[0]];
  const flush = () => {
    if (burst.length < 2) return;
    const path = simplify(burst, epsilon);
    for (let index = 1; index < path.length; index += 1) {
      const from = path[index - 1];
      const to = path[index];
      if (to.t <= from.t) continue;
      const ease = path.length === 2 ? undefined : (index === 1 ? 'in' : (index === path.length - 1 ? 'out' : 'linear'));
      if (Math.hypot(to.x - from.x, to.y - from.y) < 0.0008 && to.cursor === from.cursor) continue;
      events.push({ atMs: from.t, endMs: to.t, kind: 'move', x: round(to.x), y: round(to.y), ...(to.cursor ? { cursor: to.cursor } : {}), ...(ease ? { ease } : {}) });
    }
  };
  // The helper logs only changes, so a gap between samples means the pointer
  // was still. A new burst starts where the pointer rested, just before it
  // moved again, so rests never stretch a move.
  for (let index = 1; index < sorted.length; index += 1) {
    const sample = sorted[index];
    const previous = sorted[index - 1];
    if (sample.t - previous.t > stillMs) {
      flush();
      burst = [{ ...previous, t: Math.max(previous.t, sample.t - 16) }];
    }
    burst.push(sample);
    if (sample.down && !previous.down) {
      flush();
      burst = [sample];
      events.push({ atMs: sample.t, kind: 'click', x: round(sample.x), y: round(sample.y) });
    }
  }
  flush();
  return events.sort((left, right) => left.atMs - right.atMs);
}

export async function readPointerLog(path) {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text.split('\n').map(parseLine).filter((entry) => entry && Number.isFinite(entry.t));
}

// Trace for a recording driven by a person or a computer-use agent: the
// pointer log is the only source of events.
export function screenTrace({ manifest, samples, title, urlPrefix, presenter = null }) {
  const durationMs = Math.max(1, Math.round(manifest.durationMs));
  const events = pointerEvents(samples)
    .filter((event) => event.atMs <= durationMs)
    .map((event) => ('endMs' in event ? { ...event, endMs: Math.min(event.endMs, durationMs) } : event));
  return {
    schema: TRACE_SCHEMA,
    title: title || 'Screen recording',
    durationMs,
    viewport: manifest.viewport,
    source: { kind: 'frames', origin: 'screen', manifest: `${urlPrefix}/frames.json` },
    ...(presenter ? { presenter } : {}),
    events,
  };
}

// Finds the main browser process for a Chromium user-data dir so the helper
// can capture exactly that browser's window.
export async function browserPid(userDataDir) {
  const { stdout } = await run('ps', ['-ax', '-o', 'pid=,command=']);
  const line = stdout.split('\n').find((entry) => entry.includes(userDataDir) && !entry.includes('--type='));
  return line ? Number(line.trim().split(/\s+/)[0]) : null;
}
