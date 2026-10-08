import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProject, validateTrace } from '../bin/demo-studio.mjs';

const trace = {
  schema: 'nava.demo-trace.v1',
  durationMs: 12000,
  viewport: { width: 1920, height: 1080 },
  events: [
    { atMs: 1000, kind: 'click', x: 0.8, y: 0.6, label: 'Start' },
    { atMs: 9000, kind: 'milestone', label: 'Ready' },
  ],
};

test('creates a bounded zoom around clicks', () => {
  const project = buildProject(trace);
  assert.equal(project.zooms.length, 1);
  assert.equal(project.zooms[0].x, 0.8);
  assert.ok(project.zooms[0].startMs < 1000);
  assert.ok(project.zooms[0].endMs > 1000);
});

test('compresses long unprotected spans', () => {
  const project = buildProject(trace);
  assert.ok(project.speed.some((span) => span.rate > 1));
});

test('rejects unsafe coordinate ranges', () => {
  assert.throws(() => validateTrace({ ...trace, events: [{ atMs: 1, kind: 'click', x: 2, y: 0 }] }), /normalized/);
});

test('rejects typed values and other fields outside the trace contract', () => {
  const typed = { atMs: 1000, endMs: 1500, kind: 'type', x: 0.4, y: 0.4, label: 'Enter name', value: 'Celeste' };
  assert.throws(() => validateTrace({ ...trace, events: [typed] }), /field "value"/);
  const narratedClick = { atMs: 1000, kind: 'click', x: 0.4, y: 0.4, text: 'secret' };
  assert.throws(() => validateTrace({ ...trace, events: [narratedClick] }), /field "text"/);
});

test('ramps into and out of each fast-forward span', () => {
  const { speed } = buildProject(trace);
  const fastest = Math.max(...speed.map((span) => span.rate));
  const index = speed.findIndex((span) => span.rate === fastest);
  assert.ok(speed[index - 1].rate > 1 && speed[index - 1].rate < fastest);
  assert.ok(speed[index + 1].rate > 1 && speed[index + 1].rate < fastest);
  for (let cursor = 1; cursor < speed.length; cursor += 1) assert.equal(speed[cursor].startMs, speed[cursor - 1].endMs);
  assert.equal(speed[0].startMs, 0);
  assert.equal(speed[speed.length - 1].endMs, trace.durationMs);
});

test('never fast-forwards while narration is playing', () => {
  const narrated = {
    ...trace,
    durationMs: 20000,
    events: [
      { atMs: 1000, kind: 'click', x: 0.5, y: 0.5 },
      { atMs: 4000, endMs: 15000, kind: 'narration', text: 'A long explanation.', clip: 'line-01' },
    ],
  };
  const { speed } = buildProject(narrated);
  for (const span of speed.filter((candidate) => candidate.rate > 1)) {
    assert.ok(span.endMs <= 4000 - 300 || span.startMs >= 15000 + 600, `span ${span.startMs}-${span.endMs} overlaps narration`);
  }
});

test('plans camera keyframes in increasing output time with a minimum pan', () => {
  const busy = {
    ...trace,
    durationMs: 10000,
    events: [
      { atMs: 2000, kind: 'click', x: 0.2, y: 0.4 },
      { atMs: 2300, endMs: 2600, kind: 'type', x: 0.3, y: 0.4 },
      { atMs: 2750, endMs: 3000, kind: 'type', x: 0.7, y: 0.4 },
    ],
  };
  const project = buildProject(busy, { settings: { intro: false } });
  const keys = project.camera;
  for (let index = 1; index < keys.length; index += 1) assert.ok(keys[index].outMs > keys[index - 1].outMs);
  assert.equal(keys[0].scale, 1);
  assert.equal(keys[keys.length - 1].scale, 1);
  assert.ok(keys.some((key) => key.scale > 1.5));
  const arrivals = keys.filter((key) => key.scale > 1.5 && [0.3, 0.7].includes(key.x));
  const finalPan = keys.indexOf(arrivals[arrivals.length - 1]);
  assert.ok(keys[finalPan].outMs - keys[finalPan - 1].outMs >= 250, 'pans should not snap');
});

test('embeds voice clips, subtitles, and click effects in output time', () => {
  const narrated = {
    ...trace,
    events: [
      { atMs: 500, endMs: 3500, kind: 'narration', text: 'It starts a new application for the family.', clip: 'line-01' },
      { atMs: 2000, kind: 'click', x: 0.5, y: 0.5 },
    ],
  };
  const voice = { provider: 'say', clips: { 'line-01': { src: '/recordings/x/voice/line-01.wav', durationMs: 3000, envelopeHz: 60, envelope: [0, 50, 100] } } };
  const project = buildProject(narrated, { voice });
  const [line] = project.voice;
  assert.equal(line.outMs, project.timeline.introMs + 500);
  assert.equal(line.outEndMs, line.outMs + 3000);
  assert.equal(project.subtitles[0].startMs, line.outMs);
  assert.equal(project.subtitles.at(-1).endMs, line.outEndMs);
  assert.equal(project.sfx[0].outMs, project.timeline.introMs + 2000);
  assert.equal(project.audio.voiceover, 'say');
  const recordedOutMs = project.speed.reduce((sum, span) => sum + ((span.endMs - span.startMs) / span.rate), 0);
  assert.ok(Math.abs(project.timeline.outDurationMs - (project.timeline.introMs + recordedOutMs + project.timeline.outroMs)) <= 1);
});

test('moves the presenter away from actions under its corner', () => {
  const corner = { ...trace, presenter: '/assets/fictional-presenter.png', events: [{ atMs: 3000, kind: 'click', x: 0.97, y: 0.96 }] };
  const project = buildProject(corner);
  assert.equal(project.presenter.swaps.length, 1);
  assert.ok(project.presenter.swaps[0].startMs < project.sfx[0].outMs);
  const center = buildProject({ ...corner, events: [{ atMs: 3000, kind: 'click', x: 0.4, y: 0.4 }] });
  assert.equal(center.presenter.swaps.length, 0);
});

test('plans a code-rendered voice orb without a portrait asset', () => {
  const project = buildProject(trace, { settings: { presenter: { kind: 'orb', color: '#8b5cf6', size: 220 } } });
  assert.equal(project.presenter.kind, 'orb');
  assert.equal(project.presenter.color, '#8b5cf6');
  assert.equal(project.presenter.size, 220);
  assert.equal(project.presenter.image, undefined);
});

test('accepts target sizes and cursor shapes but rejects unknown cursors', () => {
  const sized = { ...trace, events: [{ atMs: 1000, kind: 'click', x: 0.5, y: 0.5, w: 0.1, h: 0.05 }, { atMs: 1200, endMs: 1500, kind: 'move', x: 0.6, y: 0.5, cursor: 'pointer' }] };
  assert.equal(validateTrace(sized).events.length, 2);
  assert.throws(() => validateTrace({ ...trace, events: [{ atMs: 1, endMs: 2, kind: 'move', x: 0.5, y: 0.5, cursor: 'grab' }] }), /cursor must be one of/);
  assert.throws(() => validateTrace({ ...trace, events: [{ atMs: 1, kind: 'click', x: 0.5, y: 0.5, w: 3, h: 0.1 }] }), /target size/);
});

test('zooms closer on small targets than on wide ones', () => {
  const depth = (w) => Math.max(...buildProject({ ...trace, events: [{ atMs: 3000, kind: 'click', x: 0.5, y: 0.5, w, h: 0.05 }] }).camera.map((key) => key.scale));
  assert.ok(depth(0.08) > depth(0.6));
  assert.ok(depth(0.08) <= 2.1 && depth(0.6) >= 1.45);
});

test('adds a typing sound cue for every typing span and keeps the arrival cursor on clicks', () => {
  const typed = {
    ...trace,
    events: [
      { atMs: 800, endMs: 1400, kind: 'move', x: 0.3, y: 0.4, cursor: 'text' },
      { atMs: 1400, kind: 'click', x: 0.3, y: 0.4 },
      { atMs: 1500, endMs: 2600, kind: 'type', x: 0.3, y: 0.4 },
      { atMs: 2900, endMs: 2900, kind: 'move', x: 0.3, y: 0.4 },
    ],
  };
  const project = buildProject(typed);
  const typing = project.sfx.filter((effect) => effect.kind === 'typing');
  assert.equal(typing.length, 1);
  assert.ok(typing[0].outEndMs > typing[0].outMs);
  assert.deepEqual(project.cursor.moves.map((move) => move.cursor), ['text', 'text', 'text', undefined]);
});

test('camera focus holds drive the zoom but still fast-forward the agent wait', () => {
  const focused = {
    ...trace,
    durationMs: 30000,
    events: [
      { atMs: 1000, kind: 'click', x: 0.8, y: 0.5 },
      { atMs: 2000, endMs: 26000, kind: 'focus', x: 0.3, y: 0.4, w: 0.5, h: 0.3, label: 'The form' },
      { atMs: 2500, endMs: 25500, kind: 'wait', label: 'Agents fill the form' },
    ],
  };
  const project = buildProject(focused);
  assert.equal(project.focusHolds.length, 1);
  assert.ok(project.speed.some((span) => span.rate > 1), 'the long wait under the focus is compressed');
  assert.ok(project.camera.some((key) => key.x === 0.3 && key.scale > 1.2), 'the camera zooms onto the focused region');
});
