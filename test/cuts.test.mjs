import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProject, planSpeed } from '../lib/planner.mjs';
import { settingsFrom } from '../lib/pipeline.mjs';
import { createTimeMap, outputToSource, projectSourceTime, sourceToOutput } from '../lib/timeline.mjs';

const spans = [
  { startMs: 0, endMs: 2000, rate: 1 },
  { startMs: 2000, endMs: 8000, rate: 1, cut: true },
  { startMs: 8000, endMs: 10000, rate: 1 },
  { startMs: 10000, endMs: 12000, rate: 1, cut: true },
];

test('cuts are JSON-safe, skip exactly at the edit, and clamp at both ends', () => {
  const map = createTimeMap(JSON.parse(JSON.stringify(spans)), 12000);
  assert.equal(map.outDurationMs, 4000);
  assert.equal(sourceToOutput(map, 5000), 2000);
  assert.equal(outputToSource(map, 1999), 1999);
  assert.equal(outputToSource(map, 2000), 8000);
  assert.equal(outputToSource(map, 2001), 8001);
  assert.equal(outputToSource(map, -1), 0);
  assert.equal(outputToSource(map, 4000), 12000);
  assert.equal(outputToSource(map, 99999), 12000);
  for (const sourceMs of [0, 1999, 8000, 9999]) {
    assert.equal(outputToSource(map, sourceToOutput(map, sourceMs)), sourceMs);
  }
});

test('leading and consecutive cuts jump to the first retained frame', () => {
  const map = createTimeMap([
    { startMs: 0, endMs: 1000, cut: true },
    { startMs: 1000, endMs: 3000, cut: true },
    { startMs: 3000, endMs: 5000, rate: 2 },
  ], 5000);
  assert.equal(outputToSource(map, 0), 3000);
  assert.equal(outputToSource(map, 500), 4000);
  assert.equal(map.outDurationMs, 1000);
});

test('authored cuts remove waits while preserving a real-speed work interval', () => {
  const speed = planSpeed([
    { kind: 'wait', atMs: 2000, endMs: 20000 },
    { kind: 'pause', atMs: 8000, endMs: 10000, label: 'Actual work' },
  ], 22000, { cuts: [{ startMs: 2000, endMs: 8000 }, { startMs: 10000, endMs: 20000 }] });
  const map = createTimeMap(speed, 22000);
  assert.equal(map.outDurationMs, 6000);
  assert.equal(outputToSource(map, 2000), 8000);
  assert.equal(sourceToOutput(map, 10000) - sourceToOutput(map, 8000), 2000);
  assert.equal(speed.filter(span => span.cut).length, 2);
  assert.ok(speed.filter(span => !span.cut).every(span => span.rate === 1));
});

test('cuts reject invalid bounds, overlaps, narration and recorded actions', () => {
  for (const cuts of [null, {}, [{ startMs: -1, endMs: 500 }], [{ startMs: 10, endMs: 10 }],
    [{ startMs: 2000, endMs: 10001 }], [{ startMs: 0, endMs: 2000 }, { startMs: 1000, endMs: 3000 }]]) {
    // null selects the documented default, just like an omitted setting.
    if (cuts === null) continue;
    assert.throws(() => planSpeed([], 10000, { cuts }), /speed.cuts/);
  }
  for (const kind of ['narration', 'type', 'scroll', 'pause', 'move', 'click']) {
    assert.throws(() => planSpeed([{ kind, atMs: 2000, ...(kind === 'click' ? {} : { endMs: 3500 }) }],
      10000, { cuts: [{ startMs: 2000, endMs: 4000 }] }), /protected/);
  }
});

test('the same cut shifts voice, subtitles, effects and source frames together', () => {
  const cuts = [{ startMs: 2000, endMs: 8000 }];
  const trace = {
    schema: 'nava.demo-trace.v1', durationMs: 12000, viewport: { width: 1280, height: 800 },
    events: [
      { kind: 'narration', atMs: 0, endMs: 1000, text: 'Before.', clip: 'before' },
      { kind: 'wait', atMs: 2000, endMs: 8000 },
      { kind: 'narration', atMs: 8500, endMs: 9500, text: 'After.', clip: 'after' },
      { kind: 'click', atMs: 9000, x: 0.5, y: 0.5 },
    ],
  };
  const project = buildProject(trace, { settings: { intro: false, outroMs: 0, speed: { cuts, minIdleMs: 99999 } } });
  assert.equal(project.timeline.outDurationMs, 6000);
  assert.deepEqual(project.voice.map(line => [line.outMs, line.outEndMs]), [[0, 1000], [2500, 3500]]);
  assert.equal(project.subtitles.at(-1).endMs, 3500);
  assert.equal(project.sfx[0].outMs, 3000);
  const map = createTimeMap(project.speed, project.durationMs);
  for (const outputMs of [1999, 2000, 2001, 3000]) {
    const sourceMs = projectSourceTime(project, map, outputMs);
    assert.equal(sourceMs, outputMs < 2000 ? outputMs : outputMs + 6000);
  }
  assert.deepEqual(settingsFrom({ speed: { cuts } }).speed.cuts, cuts);
});

test('cut protection uses the actual voice clip duration', () => {
  const trace = { schema: 'nava.demo-trace.v1', durationMs: 10000,
    viewport: { width: 1280, height: 800 },
    events: [{ kind: 'narration', atMs: 1000, endMs: 2000, clip: 'line', text: 'A longer cached clip.' }],
  };
  assert.throws(() => buildProject(trace, {
    voice: { clips: { line: { durationMs: 3000 } } },
    settings: { speed: { cuts: [{ startMs: 2500, endMs: 5000 }] } },
  }), /protected narration/);
});
