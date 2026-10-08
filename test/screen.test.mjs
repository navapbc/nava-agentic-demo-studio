import test from 'node:test';
import assert from 'node:assert/strict';
import { buildProject, validateTrace } from '../lib/planner.mjs';
import { pointerEvents, screenTrace, targetArgs } from '../lib/screen.mjs';
import { validateScript } from '../lib/script.mjs';

// A pointer that rests, travels an L-shaped path, rests, then clicks.
function samples() {
  const log = [{ t: 0, x: 0.1, y: 0.1, down: false }];
  for (let t = 400; t <= 600; t += 8) log.push({ t, x: 0.1 + (0.4 * ((t - 400) / 200)), y: 0.1, down: false });
  for (let t = 608; t <= 800; t += 8) log.push({ t, x: 0.5, y: 0.1 + (0.4 * ((t - 600) / 200)), down: false, cursor: 'pointer' });
  log.push({ t: 1300, x: 0.5, y: 0.5, down: true, cursor: 'pointer' });
  log.push({ t: 1380, x: 0.5, y: 0.5, down: false, cursor: 'pointer' });
  return log;
}

test('turns a pointer log into eased move segments and clicks', () => {
  const events = pointerEvents(samples());
  const clicks = events.filter((event) => event.kind === 'click');
  assert.equal(clicks.length, 1);
  assert.deepEqual([clicks[0].atMs, clicks[0].x, clicks[0].y], [1300, 0.5, 0.5]);
  const moves = events.filter((event) => event.kind === 'move' && event.endMs > event.atMs);
  assert.equal(moves.length, 2, 'the L-shaped path keeps its corner');
  assert.deepEqual(moves.map((move) => move.ease), ['in', 'out']);
  assert.equal(moves[1].cursor, 'pointer');
  for (let index = 1; index < events.length; index += 1) assert.ok(events[index].atMs >= events[index - 1].atMs);
});

test('builds a valid screen trace that plans without drawn browser chrome', () => {
  const manifest = { durationMs: 2000, viewport: { width: 1440, height: 900 }, frames: [{ t: 0, src: '/recordings/x/frames/000001.jpg' }] };
  const trace = screenTrace({ manifest, samples: samples(), title: 'Screen', urlPrefix: '/recordings/x' });
  assert.equal(validateTrace(trace).events.length, trace.events.length);
  assert.equal(trace.source.origin, 'screen');
  const project = buildProject(trace);
  assert.equal(project.style.frame.kind, 'none');
  assert.ok(project.camera.some((key) => key.scale > 1.3), 'clicks still drive the zoom');
});

test('maps capture targets to helper arguments', () => {
  assert.deepEqual(targetArgs({ window: 42 }), ['--window', '42']);
  assert.deepEqual(targetArgs({ app: 'Google Chrome', title: 'Benefits' }), ['--app', 'Google Chrome', '--title', 'Benefits']);
  assert.deepEqual(targetArgs({ pid: 7 }), ['--pid', '7']);
  assert.deepEqual(targetArgs({}), []);
});

test('only a visible-browser recorder can see extensions and side panels', () => {
  const base = { schema: 'nava.demo-script.v1', startUrl: 'x.html', steps: [{ do: 'click', in: 'sidepanel', target: '#go' }] };
  assert.throws(() => validateScript({ ...base, sidePanel: true }), /visible browser/);
  assert.equal(validateScript({ ...base, recorder: 'window', sidePanel: true, extensions: ['../ext'] }).recorder, 'window');
  assert.throws(() => validateScript({ ...base, recorder: 'desktop' }), /recorder must be/);
  assert.throws(() => validateScript({ ...base, recorder: 'screen' }), /sidePanel/);
  assert.equal(validateScript({ ...base, recorder: 'screen', sidePanel: true, extensions: ['../ext'] }).steps.length, 1);
  assert.throws(() => validateScript({ ...base, recorder: 'screen', sidePanel: true, steps: [{ do: 'click', in: 'popup', target: '#go' }] }), /"in" must be/);
});

test('records a driven window end to end through the helper protocol', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { recordScreenDemo } = await import('../lib/pipeline.mjs');
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-screen-'));
  process.env.DEMO_STUDIO_CAPTURE_HELPER = fileURLToPath(new URL('./fixtures/fake-capture.mjs', import.meta.url));
  try {
    const result = await recordScreenDemo({ root, target: { app: 'Fake' }, seconds: 0.6, slug: 'fake', title: 'Fake demo', render: false, log: () => {} });
    const trace = JSON.parse(await readFile(join(result.recordingDir, 'trace.json'), 'utf8'));
    assert.equal(trace.source.origin, 'screen');
    assert.equal(trace.events.filter((event) => event.kind === 'click').length, 1);
    const project = JSON.parse(await readFile(result.projectPath, 'utf8'));
    assert.equal(project.intro.title, 'Fake demo');
    assert.equal(project.style.frame.kind, 'none');
  } finally {
    delete process.env.DEMO_STUDIO_CAPTURE_HELPER;
    await rm(root, { recursive: true, force: true });
  }
});
