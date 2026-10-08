import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeWav16, levels } from '../lib/audio-analysis.mjs';
import { alignTempo, auditionProject, describeMusic, MUSIC_STYLES, planMusic, resolveMusicSettings, stitchLoop } from '../lib/music-plan.mjs';
import { checkMusicFile } from '../lib/pipeline.mjs';
import { buildProject } from '../lib/planner.mjs';

test('resolves music settings with per-style tempos and legacy projects', () => {
  assert.equal(resolveMusicSettings({ style: 'lofi' }).bpm, MUSIC_STYLES.lofi.bpm);
  assert.deepEqual(resolveMusicSettings({ bpm: 92 }), { style: 'warm-pop', bpm: 92, volume: 0.7, seed: 7 });
  assert.throws(() => resolveMusicSettings({ style: 'polka' }), /Unknown music style/);
  assert.equal(resolveMusicSettings({ file: 'assets/music/track.mp3' }).file, '/assets/music/track.mp3');
  assert.throws(() => resolveMusicSettings({ file: 'https://example.org/track.mp3' }), /not a URL/);
  assert.throws(() => resolveMusicSettings({ style: 'lofi', volume: 9 }), /volume/);
  assert.equal(describeMusic(resolveMusicSettings({ file: 'a.mp3' })), 'file:/a.mp3');
});

test('bends the tempo slightly so the reveal and the outro land on bar lines', () => {
  const { bpm, bars } = alignTempo({ bpm: 120, revealS: 2.4, resolveS: 31.7 });
  assert.ok(Math.abs(bpm - 120) / 120 <= 0.08);
  const barS = (60 / bpm) * 4;
  assert.ok(Math.abs(((31.7 - 2.4) / barS) - bars) < 1e-9);
  assert.deepEqual(alignTempo({ bpm: 120, revealS: 2, resolveS: 2 }), { bpm: 120, bars: null });
});

test('arranges an intro, a groove from the reveal, a lift over fast-forward, and a resolving outro', () => {
  for (const style of Object.keys(MUSIC_STYLES)) {
    const project = auditionProject({ style, seconds: 30 });
    const plan = planMusic(project);
    assert.equal(plan.kind, 'generated');
    for (let index = 1; index < plan.bars.length; index += 1) assert.ok(plan.bars[index].startS > plan.bars[index - 1].startS);
    assert.ok(Math.abs(plan.grooveS - 2.4) < 1e-9, `${style}: the groove starts at the reveal`);
    const last = plan.bars[plan.bars.length - 1];
    assert.equal(last.section, 'outro');
    assert.equal(last.chord, MUSIC_STYLES[style].tonic, `${style}: the outro resolves on the tonic`);
    assert.ok(plan.bars.some((bar) => bar.section === 'lift'), `${style}: the fast-forward gets a lift`);
    assert.ok(plan.bars.some((bar) => bar.section === 'intro'));
    for (const riser of plan.risers) {
      const offset = (riser.endS - plan.originS) / plan.barS;
      assert.ok(Math.abs(offset - Math.round(offset)) < 1e-6, `${style}: risers end on a bar line`);
    }
  }
});

test('thins the arrangement under narration', () => {
  const project = auditionProject({ style: 'upbeat', seconds: 30 });
  project.voice = [{ src: '/v.wav', outMs: 6000, durationMs: 6000 }];
  const plan = planMusic(project);
  assert.ok(plan.bars.some((bar) => bar.underVoice));
  assert.ok(plan.bars.filter((bar) => bar.startS > 14).every((bar) => !bar.underVoice));
});

test('loops a music file to length with an equal-power crossfade', () => {
  const sampleRate = 1000;
  const tone = Float32Array.from({ length: 3000 }, () => 0.5);
  const [looped] = stitchLoop([tone], sampleRate, { lengthS: 7, loop: true, crossfadeS: 0.5 });
  assert.equal(looped.length, 7000);
  const middle = looped.slice(2000, 3500);
  const { rms } = levels([middle]);
  assert.ok(Math.abs(rms - 0.5) < 0.12, 'the seam stays close to the original level');
  const [trimmed] = stitchLoop([tone], sampleRate, { lengthS: 5, loop: false });
  assert.equal(trimmed[4500], 0, 'without looping, the track simply ends');
});

test('plans generated and file music into projects', () => {
  const trace = { schema: 'nava.demo-trace.v1', durationMs: 10000, viewport: { width: 1280, height: 800 }, events: [] };
  const lofi = buildProject(trace, { settings: { music: { style: 'lofi' } } });
  assert.equal(lofi.music.bpm, MUSIC_STYLES.lofi.bpm);
  assert.equal(lofi.audio.backgroundMusic, 'generated:lofi');
  const file = buildProject(trace, { settings: { music: { file: 'assets/music/theme.mp3', volume: 0.5 } } });
  assert.equal(file.music.file, '/assets/music/theme.mp3');
  assert.equal(file.audio.backgroundMusic, 'file:/assets/music/theme.mp3');
  assert.equal(buildProject(trace, { settings: { music: false } }).music, null);
});

test('only accepts music files inside the repository', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-music-'));
  try {
    await writeFile(join(root, 'theme.wav'), encodeWav16([new Float32Array(10)], 8000));
    assert.doesNotThrow(() => checkMusicFile(root, { music: { file: 'theme.wav' } }));
    assert.throws(() => checkMusicFile(root, { music: { file: 'missing.mp3' } }), /does not exist/);
    assert.throws(() => checkMusicFile(root, { music: { file: '../outside.mp3' } }), /must be inside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
