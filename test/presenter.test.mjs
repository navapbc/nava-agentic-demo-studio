import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProject } from '../lib/planner.mjs';
import { loadRig, planStep, settingsFrom } from '../lib/pipeline.mjs';
import { resolvePresenter } from '../lib/presenter-config.mjs';

const trace = {
  schema: 'nava.demo-trace.v1',
  durationMs: 5000,
  viewport: { width: 1280, height: 800 },
  events: [{ atMs: 500, endMs: 3000, kind: 'narration', text: 'Voiceover stays on the original timeline.', clip: 'line-01' }],
};

test('recording defaults produce an asset-free purple orb and preserve explicit voiceover-only mode', () => {
  const recorded = { ...trace, presenter: resolvePresenter(undefined) };
  const project = buildProject(recorded);
  assert.equal(project.presenter.kind, 'orb');
  assert.equal(project.presenter.color, '#8b5cf6');
  assert.equal(project.presenter.image, undefined);
  assert.equal(project.presenter.rig, null);
  assert.equal(buildProject(trace).presenter.kind, 'orb', 'planning a trace without a presenter also uses an orb');

  const voiceoverOnly = { ...trace, presenter: resolvePresenter(false) };
  assert.equal(buildProject(JSON.parse(JSON.stringify(voiceoverOnly))).presenter, null, 'replanning the trace retains the opt-out');
  assert.equal(buildProject(recorded, { settings: { presenter: false } }).presenter, null);
});

test('page, window, and screen script planning keep voiceover-only mode through serialization', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-presenter-'));
  try {
    for (const recorder of ['page', 'window', 'screen']) {
      const script = { recorder, presenter: false };
      const { projectPath } = await planStep({ root, recordingDir: join(root, recorder), script, trace });
      const project = JSON.parse(await readFile(projectPath, 'utf8'));
      assert.equal(project.presenter, null);
      assert.equal(project.voice[0].atMs, trace.events[0].atMs);
      assert.equal(project.voice[0].text, trace.events[0].text);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('styling-only remix overrides preserve an explicitly authored local portrait', () => {
  const portraitTrace = { ...trace, presenter: '/assets/local-presenter.png' };
  const overrides = [{ size: 180, margin: 24 }, { kind: 'portrait', size: 180, margin: 24 }];
  for (const settings of overrides.flatMap(presenter => [{ presenter }, settingsFrom({ presenter })])) {
    const project = buildProject(portraitTrace, { settings });
    assert.equal(project.presenter.kind, 'portrait');
    assert.equal(project.presenter.image, portraitTrace.presenter);
    assert.equal(project.presenter.size, 180);
    assert.equal(project.presenter.margin, 24);
  }
  const explicitImage = buildProject({ ...trace, presenter: { kind: 'orb' } }, { settings: { presenter: { image: 'assets/local-presenter.png' } } });
  assert.equal(explicitImage.presenter.kind, 'portrait');
});

test('an explicit local image and rig remain available while an orb override drops portrait media', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-local-rig-'));
  const rig = { schema: 'nava.presenter-rig.v1', image: 'local-presenter.png', mouth: {} };
  try {
    await writeFile(join(root, 'local.rig.json'), JSON.stringify(rig));
    const script = { presenter: { image: 'assets/local-presenter.png', rig: 'local.rig.json', size: 240 } };
    const loaded = await loadRig(root, script);
    assert.deepEqual(loaded, rig);
    const project = buildProject(trace, { settings: settingsFrom(script), rig: loaded });
    assert.equal(project.presenter.kind, 'portrait');
    assert.equal(project.presenter.image, '/assets/local-presenter.png');
    assert.deepEqual(project.presenter.rig, rig);
    assert.equal(project.presenter.size, 240);
    assert.equal(await loadRig(root, {}), null);
    assert.equal(await loadRig(root, { presenter: { image: 'assets/local-presenter.png' } }), null, 'a portrait never infers a rig path');
    assert.equal(await loadRig(root, { presenter: { kind: 'orb', rig: 'local.rig.json' } }), null);

    const orb = buildProject({ ...trace, presenter: project.presenter }, { settings: { presenter: { kind: 'orb' } }, rig });
    assert.equal(orb.presenter.kind, 'orb');
    assert.equal(orb.presenter.image, undefined);
    assert.equal(orb.presenter.rig, null);
    assert.deepEqual(orb.voice, project.voice, 'changing the presenter does not alter narration timing');
    assert.deepEqual(orb.timeline, project.timeline);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
