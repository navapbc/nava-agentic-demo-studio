import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FrameCapture } from '../lib/recorder.mjs';
import { frameIndexAt, createTimeMap, sourceToOutput } from '../lib/timeline.mjs';
import { planSpeed } from '../lib/planner.mjs';

test('late background capture keeps its position on the shared clock', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'demo-clock-'));
  try {
    const capture = new FrameCapture({}, { screenshot: async () => Buffer.from('frame') }, dir, { quality: 88 });
    const start = Date.now() - 15000;
    await capture.begin(start);
    await Promise.all(capture.writes);
    assert.equal(capture.t0, start);
    assert.ok(capture.frames[0].t >= 15000);
    assert.ok(capture.frames[0].t <= Date.now() - start);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a shared clock never reveals a future frame from another tab', () => {
  const early = [{ t: 4000 }, { t: 7000 }, { t: 12000 }];
  const late = [{ t: 9000 }, { t: 11000 }, { t: 14000 }];
  assert.equal(frameIndexAt([], 10000), -1);
  assert.equal(frameIndexAt(early, 0), -1);
  assert.equal(frameIndexAt(early, 4000), 0);
  assert.equal(frameIndexAt(early, 10000), 1);
  assert.equal(frameIndexAt(late, 8000), -1);
  assert.equal(frameIndexAt(late, 10000), 0);
  assert.equal(frameIndexAt(late, 15000), 2);
});

test('the simultaneous-write window remains at real speed inside a compressed recording', () => {
  const events = [{ kind: 'pause', atMs: 60000, endMs: 78000, label: 'Real-time parallel field entry' }];
  const spans = planSpeed(events, 120000, { minIdleMs: 1500, maxRate: 6 });
  assert.ok(spans.some(span => span.rate > 1));
  assert.ok(spans.filter(span => span.startMs < 78000 && span.endMs > 60000).every(span => span.rate === 1));
  const map = createTimeMap(spans, 120000);
  assert.equal(sourceToOutput(map, 78000) - sourceToOutput(map, 60000), 18000);
});
