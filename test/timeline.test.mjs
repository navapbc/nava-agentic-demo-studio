import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cameraAt,
  createTimeMap,
  cursorAt,
  cursorVisibility,
  layoutFor,
  mouthAt,
  outputToSource,
  presenterSwapAt,
  sourceToOutput,
  viewWindow,
  voiceLevelAt,
} from '../lib/timeline.mjs';

const speed = [
  { startMs: 0, endMs: 2000, rate: 1 },
  { startMs: 2000, endMs: 10000, rate: 4 },
  { startMs: 10000, endMs: 12000, rate: 1 },
];

test('maps source time to output time and back', () => {
  const map = createTimeMap(speed, 12000);
  assert.equal(map.outDurationMs, 2000 + 2000 + 2000);
  assert.equal(sourceToOutput(map, 6000), 3000);
  for (const sourceMs of [0, 1500, 2000, 5321, 10000, 11999, 12000]) {
    assert.ok(Math.abs(outputToSource(map, sourceToOutput(map, sourceMs)) - sourceMs) < 1e-6);
  }
  assert.equal(outputToSource(map, -50), 0);
  assert.equal(outputToSource(map, 99999), 12000);
});

test('interpolates the camera between keyframes and clamps at the ends', () => {
  const keys = [{ outMs: 0, x: 0.5, y: 0.5, scale: 1 }, { outMs: 1000, x: 0.8, y: 0.2, scale: 2 }];
  assert.deepEqual(cameraAt(keys, -10), keys[0]);
  assert.deepEqual(cameraAt(keys, 5000), keys[1]);
  const middle = cameraAt(keys, 500);
  assert.ok(Math.abs(middle.scale - Math.SQRT2) < 1e-9, 'scale interpolates in log space');
  assert.ok(Math.abs(middle.x - 0.65) < 1e-9);
});

test('keeps a zoomed view inside the recording and a wide view on the scene', () => {
  const layout = layoutFor({ output: { width: 1920, height: 1080 }, viewport: { width: 1280, height: 800 }, style: { padding: 72 } });
  const wide = viewWindow(layout, { x: 0.5, y: 0.5, scale: 1 });
  assert.deepEqual([wide.x, wide.y, wide.w, wide.h], [0, 0, 1920, 1080]);
  const zoomed = viewWindow(layout, { x: 0.99, y: 0.99, scale: 2.2 });
  assert.ok(zoomed.x + zoomed.w <= layout.inset.x + layout.inset.w + 1e-6);
  assert.ok(zoomed.y + zoomed.h <= layout.inset.y + layout.inset.h + 1e-6);
  assert.ok(zoomed.x >= layout.inset.x - 1e-6);
});

test('eases the cursor along recorded moves and switches its shape on arrival', () => {
  const moves = [{ atMs: 0, endMs: 0, x: 0.1, y: 0.1 }, { atMs: 1000, endMs: 2000, x: 0.9, y: 0.5, cursor: 'pointer' }];
  assert.deepEqual(cursorAt(moves, 500), { x: 0.1, y: 0.1, kind: 'default' });
  const halfway = cursorAt(moves, 1500);
  assert.ok(Math.abs(halfway.x - 0.5) < 1e-9);
  assert.equal(halfway.kind, 'default');
  assert.equal(cursorAt(moves, 1800).kind, 'pointer');
  assert.deepEqual(cursorAt(moves, 2500), { x: 0.9, y: 0.5, kind: 'pointer' });
});

test('hides an idle cursor and brings it back before the next move', () => {
  const moves = [{ atMs: 0, endMs: 500, x: 0.1, y: 0.1 }, { atMs: 8000, endMs: 8600, x: 0.5, y: 0.5 }];
  assert.equal(cursorVisibility(moves, 1000), 1);
  assert.equal(cursorVisibility(moves, 5000), 0);
  assert.equal(cursorVisibility(moves, 8000), 1);
});

test('chains pans without stopping at intermediate camera targets', () => {
  const keys = [
    { outMs: 0, x: 0.2, y: 0.5, scale: 2 },
    { outMs: 1000, x: 0.5, y: 0.5, scale: 2 },
    { outMs: 2000, x: 0.8, y: 0.5, scale: 2 },
  ];
  const before = cameraAt(keys, 990).x;
  const after = cameraAt(keys, 1010).x;
  assert.ok(after - before > 0.004, 'the camera keeps moving through the middle target');
  const hold = [{ outMs: 0, x: 0.3, y: 0.5, scale: 2 }, { outMs: 1000, x: 0.3, y: 0.5, scale: 2 }, { outMs: 2000, x: 0.7, y: 0.5, scale: 2 }];
  assert.equal(cameraAt(hold, 600).x, 0.3, 'holds stay perfectly still');
});

test('follows the cursor while zoomed', () => {
  const layout = layoutFor({ output: { width: 1920, height: 1080 }, viewport: { width: 1280, height: 800 }, style: { padding: 72 } });
  const camera = { x: 0.3, y: 0.5, scale: 2 };
  const still = viewWindow(layout, camera);
  const followed = viewWindow(layout, camera, { x: 0.75, y: 0.5 });
  assert.ok(followed.x > still.x, 'the view shifts toward a cursor outside the comfort margin');
  assert.deepEqual(viewWindow(layout, camera, { x: 0.31, y: 0.5 }), still);
});

test('reserves room for browser chrome above the recording', () => {
  const layout = layoutFor({ output: { width: 1920, height: 1080 }, viewport: { width: 1280, height: 800 }, style: { padding: 72, frame: { kind: 'browser' } } });
  assert.ok(layout.bar > 30);
  assert.equal(layout.inset.y, layout.frame.y + layout.bar);
  assert.ok(layout.frame.y + layout.frame.h <= 1080 - 72 + 1e-6);
});

test('smooths presenter swaps and voice level deterministically', () => {
  const swaps = [{ startMs: 1000, endMs: 3000 }];
  assert.equal(presenterSwapAt(swaps, 500), 0);
  assert.equal(presenterSwapAt(swaps, 2000), 1);
  assert.ok(presenterSwapAt(swaps, 1200) > 0 && presenterSwapAt(swaps, 1200) < 1);
  const clips = [{ outMs: 1000, outEndMs: 2000, envelopeHz: 10, envelope: [0, 100, 100, 0, 0, 0, 0, 0, 0, 0] }];
  assert.equal(voiceLevelAt(clips, 500), 0);
  assert.ok(voiceLevelAt(clips, 1250) > 0.5);
  assert.equal(voiceLevelAt(clips, 1250), voiceLevelAt(clips, 1250));
});

test('samples mouth shape ahead of the audio and nods after stressed syllables', () => {
  const open = Array.from({ length: 60 }, (_, index) => (index >= 10 ? 80 : 0));
  const accent = Array.from({ length: 60 }, (_, index) => (index === 10 ? 100 : 0));
  const wide = Array.from({ length: 60 }, () => 50);
  const clips = [{ outMs: 1000, outEndMs: 2000, envelopeHz: 60, envelope: open, mouth: { hz: 60, open, wide, accent } }];
  const early = mouthAt(clips, 1000 + (10 * (1000 / 60)) - 40);
  assert.ok(early.open > 0.5, 'lips lead the sound');
  assert.equal(early.wide, 0.5);
  assert.ok(mouthAt(clips, 1000 + 170 + 200).nod > 0.3);
  assert.equal(mouthAt(clips, 4000).open, 0);
});
