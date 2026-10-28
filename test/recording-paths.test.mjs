import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordScreenDemo, recordStep } from '../lib/pipeline.mjs';

test('recording path validation precedes removal of any existing frames', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-recording-paths-'));
  const root = join(directory, 'studio');
  const sibling = join(directory, 'victim');
  const inRoot = join(root, 'assets');
  try {
    for (const folder of [sibling, inRoot]) {
      await mkdir(join(folder, 'frames'), { recursive: true });
      await writeFile(join(folder, 'frames', 'sentinel.txt'), 'keep');
    }
    for (const slug of ['../../victim', '../assets', '/tmp/elsewhere', '..', '', '.hidden', 'bad/name']) {
      await assert.rejects(recordScreenDemo({ root, slug, target: {}, render: false }), /lowercase slug/);
    }
    await assert.rejects(recordStep({ root, script: {}, recordingDir: sibling }), /must be inside/);
    assert.equal(await readFile(join(sibling, 'frames', 'sentinel.txt'), 'utf8'), 'keep');
    assert.equal(await readFile(join(inRoot, 'frames', 'sentinel.txt'), 'utf8'), 'keep');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
