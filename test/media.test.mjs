import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { narrationLines, slugFor, validateScript } from '../lib/script.mjs';
import { resolveInside, safeExportName, startServer } from '../lib/server.mjs';
import { analyzeMouth, encodeWav, loudnessEnvelope, normalizeSpeech, parseWav } from '../lib/voice.mjs';

function wav(samples, sampleRate = 24000) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => data.writeInt16LE(Math.round(sample * 32767), index * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

test('parses PCM WAV and derives a mouth envelope from loudness', () => {
  const sampleRate = 24000;
  const samples = Array.from({ length: sampleRate }, (_, index) => (index < sampleRate / 2 ? 0 : 0.5 * Math.sin(index / 5)));
  const parsed = parseWav(wav(samples, sampleRate));
  assert.equal(parsed.sampleRate, sampleRate);
  assert.equal(Math.round(parsed.durationMs), 1000);
  const envelope = loudnessEnvelope(parsed.samples, parsed.sampleRate, 60);
  assert.equal(envelope.length, 60);
  assert.equal(envelope[5], 0, 'silence keeps the mouth closed');
  assert.ok(envelope[45] > 80, 'speech opens the mouth');
  assert.throws(() => parseWav(Buffer.from('not a wav file at all, definitely')), /RIFF/);
});

const script = {
  schema: 'nava.demo-script.v1',
  title: 'Parallel Apps: Demo!',
  startUrl: 'examples/fixtures/benefits-portal/index.html',
  steps: [
    { do: 'click', target: '#start', say: 'Start here.' },
    { do: 'type', target: { label: 'First name' }, text: 'Celeste' },
    { do: 'wait', for: '#review' },
    { do: 'hover', target: '#ready', say: 'All done.' },
  ],
};

test('validates demo scripts and assigns stable narration ids', () => {
  assert.equal(validateScript(script), script);
  assert.deepEqual(narrationLines(script).map((line) => [line.id, line.stepIndex]), [['line-01', 0], ['line-04', 3]]);
  assert.equal(slugFor(script), 'parallel-apps-demo');
  assert.throws(() => validateScript({ ...script, steps: [{ do: 'submit' }] }), /unknown step/);
  assert.throws(() => validateScript({ ...script, steps: [{ do: 'type', target: '#x' }] }), /needs "text"/);
  assert.throws(() => validateScript({ ...script, steps: [{ do: 'click', target: '#x', value: 'x' }] }), /unexpected field "value"/);
  assert.throws(() => validateScript({ ...script, steps: [{ do: 'wait' }] }), /"ms" or "for"/);
});

test('confines static paths to the root and export names to safe files', () => {
  assert.equal(resolveInside('/srv/studio', '/web/index.html'), '/srv/studio/web/index.html');
  assert.equal(resolveInside('/srv/studio', '/../studio-evil/secret.txt'), null);
  assert.equal(resolveInside('/srv/studio', '/../../etc/passwd'), null);
  assert.equal(safeExportName('../../demo.mp4'), 'demo.mp4');
  assert.equal(safeExportName('.hidden.mp4'), 'hidden.mp4');
  assert.equal(safeExportName('payload.sh'), null);
  assert.equal(safeExportName('music-lofi.wav'), 'music-lofi.wav');
});

test('serves byte ranges and accepts exports into the exports folder', async () => {
  const root = await mkdtemp(join(tmpdir(), 'demo-studio-'));
  await writeFile(join(root, 'clip.mp4'), Buffer.from('0123456789'));
  await mkdir(join(root, 'web'));
  await writeFile(join(root, 'web', 'index.html'), '<h1>preview</h1>');
  const server = await startServer({ root });
  try {
    assert.equal(await (await fetch(`${server.origin}/web/?project=/x.json`)).text(), '<h1>preview</h1>');
    const partial = await fetch(`${server.origin}/clip.mp4`, { headers: { Range: 'bytes=2-5' } });
    assert.equal(partial.status, 206);
    assert.equal(await partial.text(), '2345');
    assert.equal((await fetch(`${server.origin}/..%2F..%2Fetc%2Fpasswd`)).status, 404);
    const upload = await fetch(`${server.origin}/api/export?name=../out.mp4`, { method: 'POST', body: 'video-bytes' });
    const { path } = await upload.json();
    assert.equal(path, join(root, 'exports', 'out.mp4'));
    assert.equal(await readFile(path, 'utf8'), 'video-bytes');
    assert.equal((await fetch(`${server.origin}/api/export?name=run.sh`, { method: 'POST', body: 'x' })).status, 400);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('spreads the lips for high second formants and rounds them for low ones', () => {
  const sampleRate = 24000;
  const tone = (hz, seconds) => Array.from({ length: sampleRate * seconds }, (_, index) => (0.35 * Math.sin((2 * Math.PI * 180 * index) / sampleRate)) + (0.25 * Math.sin((2 * Math.PI * hz * index) / sampleRate)));
  const samples = Float32Array.from([...tone(2500, 0.5), ...tone(950, 0.5)]);
  const mouth = analyzeMouth(samples, sampleRate, 60);
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  assert.equal(mouth.open.length, 60);
  assert.ok(average(mouth.wide.slice(8, 22)) > 20, 'an "ee"-like spectrum spreads the lips');
  assert.ok(average(mouth.wide.slice(38, 52)) < -20, 'an "oo"-like spectrum rounds them');
  const roundTrip = parseWav(encodeWav(samples, sampleRate));
  assert.equal(roundTrip.samples.length, samples.length);
});

test('normalizes narration to one speech level without clipping', () => {
  const quiet = Float32Array.from({ length: 24000 }, (_, index) => 0.05 * Math.sin(index / 7));
  const { samples, gainDb } = normalizeSpeech(quiet, -16);
  assert.ok(gainDb > 8);
  const voiced = samples.filter((sample) => Math.abs(sample) > 0.02);
  const rmsDb = 10 * Math.log10(voiced.reduce((sum, sample) => sum + (sample * sample), 0) / voiced.length);
  assert.ok(Math.abs(rmsDb + 16) < 1.5);
  const loud = Float32Array.from({ length: 2400 }, (_, index) => (index === 100 ? 1 : 0.3 * Math.sin(index / 5)));
  assert.ok(Math.max(...normalizeSpeech(loud, -3).samples.map(Math.abs)) <= 0.891);
});

test('validates setup steps, secret text from the environment, and waiting for an agent', () => {
  const base = { schema: 'nava.demo-script.v1', startUrl: 'x.html', steps: [{ do: 'wait', for: '#phone', until: 'filled' }] };
  assert.equal(validateScript({ ...base, setup: [{ do: 'type', target: '#token', text: { env: 'PAIRING_TOKEN' } }] }).setup.length, 1);
  assert.throws(() => validateScript({ ...base, setup: [{ do: 'pause', say: 'hello' }] }), /cannot narrate/);
  assert.throws(() => validateScript({ ...base, steps: [{ do: 'type', target: '#x', text: { env: 'lower-case' } }] }), /env/);
  assert.throws(() => validateScript({ ...base, steps: [{ do: 'wait', for: '#x', until: 'gone' }] }), /until/);
  assert.equal(validateScript({ ...base, steps: [{ do: 'focus', target: '#form' }] }).steps[0].do, 'focus');
});
