// End-to-end smoke test: records the fixture in headless Chrome, renders an
// MP4, and checks the privacy contract on the real trace. Needs Google Chrome
// (and macOS `say` for the voiceover), so it runs via `npm run e2e`, not `npm test`.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDemo } from '../../lib/pipeline.mjs';
import { listSayVoices } from '../../lib/voice.mjs';

const root = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const TYPED = ['Celeste', 'Rivera', '(555) 014-2231'];

function boxes(buffer, start = 0, end = buffer.length) {
  const found = [];
  for (let offset = start; offset + 8 <= end;) {
    const size = buffer.readUInt32BE(offset);
    found.push({ type: buffer.toString('ascii', offset + 4, offset + 8), offset, size });
    if (size < 8) break;
    offset += size;
  }
  return found;
}

test('records, plans, and renders a narrated demo without leaking typed values', { timeout: 300000 }, async () => {
  const hasVoice = (await listSayVoices()).some((voice) => voice.name === 'Samantha');
  const script = {
    schema: 'nava.demo-script.v1',
    title: 'E2E smoke',
    slug: 'e2e-smoke',
    startUrl: 'examples/fixtures/benefits-portal/index.html?delay=1200',
    viewport: { width: 1024, height: 640 },
    deviceScaleFactor: 1,
    voice: hasVoice ? { provider: 'say', voice: 'Samantha' } : { provider: 'none' },
    output: { width: 1280, height: 720, fps: 30 },
    intro: { title: 'E2E smoke' },
    steps: [
      { do: 'click', target: '#start', label: 'Start application', say: 'Starting a test application.' },
      { do: 'type', target: '#first-name', text: TYPED[0], label: 'Enter first name' },
      { do: 'type', target: '#last-name', text: TYPED[1], label: 'Enter last name' },
      { do: 'type', target: '#phone', text: TYPED[2], label: 'Enter phone number' },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), 'demo-studio-e2e-'));
  const scriptPath = join(dir, 'e2e.script.json');
  await writeFile(scriptPath, JSON.stringify(script));
  const out = join(root, 'exports', 'e2e-smoke.mp4');
  try {
    const result = await makeDemo(scriptPath, { root, out, log: () => {} });
    const trace = await readFile(join(result.recordingDir, 'trace.json'), 'utf8');
    const project = await readFile(result.projectPath, 'utf8');
    for (const value of TYPED) {
      assert.ok(!trace.includes(value), `trace must not contain "${value}"`);
      assert.ok(!project.includes(value), `project must not contain "${value}"`);
    }
    const kinds = JSON.parse(trace).events.map((event) => event.kind);
    assert.equal(kinds.filter((kind) => kind === 'type').length, 3);
    assert.ok(kinds.includes('click'));

    const mp4 = await readFile(out);
    const top = boxes(mp4).map((box) => box.type);
    assert.deepEqual(top.filter((type) => ['ftyp', 'moov', 'mdat'].includes(type)), ['ftyp', 'moov', 'mdat'], 'fast-start layout');
    assert.ok(mp4.includes(Buffer.from('avc1')), 'H.264 video track');
    if (result.state.audioCodec === 'mp4a.40.2') assert.ok(mp4.includes(Buffer.from('mp4a')), 'AAC audio track');
    const expectedFrames = Math.ceil((JSON.parse(project).timeline.outDurationMs / 1000) * 30);
    assert.equal(result.state.frames, expectedFrames);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(join(root, 'recordings', 'e2e-smoke'), { recursive: true, force: true });
    await rm(out, { force: true });
  }
});
