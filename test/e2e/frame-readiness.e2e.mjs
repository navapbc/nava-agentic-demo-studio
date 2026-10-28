import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../lib/browser.mjs';
import { buildProject } from '../../lib/planner.mjs';
import { startServer } from '../../lib/server.mjs';

test('accelerated and cut shutters retain every decoded sample until drawing', { timeout: 120000 }, async (t) => {
  let server, browser;
  const cleanup = async () => {
    try { await browser?.close(); }
    finally { await server?.close(); }
  };
  // Node cancels the test at its deadline without entering an in-flight body's
  // finally. The hook closes Chrome and interrupts a pending page operation.
  t.after(cleanup);
  try {
    server = await startServer({ root: fileURLToPath(new URL('../..', import.meta.url)) });
    t.signal.throwIfAborted();
    browser = await launchBrowser();
    t.signal.throwIfAborted();
    const page = await browser.newPage();
    await page.goto(server.origin + '/web/render.html?inspect=1');
    const png = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 64; canvas.height = 36;
      const context = canvas.getContext('2d'); context.fillStyle = '#3cbd85'; context.fillRect(0, 0, 64, 36);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const frames = Array.from({ length: 501 }, (_, index) => ({ t: index * 10, src: `/frame-readiness-${index}.png` }));
    await page.route('**/frame-readiness-frames.json', route => route.fulfill({ json: { width: 64, height: 36, frames } }));
    await page.route('**/frame-readiness-layered.json', route => route.fulfill({ json: {
      width: 64, height: 36, viewport: { width: 64, height: 36 },
      layers: [
        { name: 'page', rect: { x: 0, y: 0, w: 48, h: 36 }, frames },
        { name: 'sidepanel', rect: { x: 48, y: 0, w: 16, h: 36 }, frames },
      ],
      parallelLayers: [{ name: 'background', width: 64, height: 36, frames }],
    } }));
    await page.route('**/frame-readiness-*.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64') }));
    const project = buildProject({
      schema: 'nava.demo-trace.v1', title: 'Frame readiness', durationMs: 5000,
      viewport: { width: 64, height: 36 }, source: { kind: 'frames', manifest: '/frame-readiness-frames.json' }, events: [],
    }, { settings: { intro: false, outroMs: 0, music: false, presenter: false, frame: false, output: { width: 320, height: 180, fps: 12 } } });
    const results = await page.evaluate(async project => {
      const { Compositor } = await import('/web/compositor.js');
      const { frameIndexAt } = await import('/lib/timeline.mjs');
      const results = [];
      const scenarios = ['frames', 'layered'].flatMap(sourceKind => [
        { sourceKind, speed: [{ startMs: 0, endMs: 5000, rate: 120 }] },
        { sourceKind, speed: [{ startMs: 0, endMs: 10, rate: 1 }, { startMs: 10, endMs: 4990, rate: 1, cut: true }, { startMs: 4990, endMs: 5000, rate: 1 }] },
      ]);
      for (const { sourceKind, speed } of scenarios) {
        const compositor = await Compositor.create({ ...project, speed,
          source: { kind: 'frames', manifest: `/frame-readiness-${sourceKind}.json` },
          ...(sourceKind === 'layered' ? { parallel: { startMs: 0, endMs: 1000, freezeSourceMs: 1250, readyMs: 9999, launchedSourceMs: 0, cards: [{ name: 'background', title: 'Background' }] } } : {}),
        });
        const canvas = document.createElement('canvas'); canvas.width = 320; canvas.height = 180;
        const context = canvas.getContext('2d');
        let placeholders = 0;
        const fillText = context.fillText.bind(context);
        context.fillText = (text, ...args) => { if (text === 'No recording loaded') placeholders += 1; return fillText(text, ...args); };
        for (const motion of [0, 30]) {
          // Exercise both the static one-sample draw and the maximum shutter.
          compositor.motionAt = () => motion;
          const outMs = speed.length === 1 ? 20 : 10;
          await compositor.prepare(outMs, { motionBlur: true });
          const times = [outMs, ...compositor.sceneSampleTimes(outMs)];
          const sequences = sourceKind === 'layered' ? compositor.source.layers.map(layer => layer.sequence) : [compositor.source];
          const exact = (sequence, sourceMs) => {
            const expected = sequence.ready.get(frameIndexAt(sequence.frames, sourceMs));
            return expected && expected.width > 0 && sequence.current(sourceMs) === expected;
          };
          const ready = sequences.every(sequence => times.every(time => exact(sequence, compositor.sourceTime(time))));
          const parallelReady = (compositor.source.parallelLayers || []).every(layer => exact(layer.sequence, Math.min(compositor.sourceTime(outMs), 1250)));
          compositor.draw(context, outMs, { motionBlur: true });
          results.push({ sourceKind, kind: speed.length === 1 ? 'accelerated' : 'cut', motion, ready, parallelReady, cached: Math.max(...sequences.map(sequence => sequence.pending.size)), placeholders });
        }
        const displayMs = speed.length === 1 ? 20 : 5;
        await compositor.prepare(displayMs);
        const sequences = sourceKind === 'layered' ? compositor.source.layers.map(layer => layer.sequence) : [compositor.source];
        const displayed = sequences.map(sequence => sequence.current(compositor.sourceTime(displayMs)));
        compositor.prefetch(displayMs + 50, displayMs);
        results.push({ sourceKind, kind: 'preview-lookahead', ready: sequences.every((sequence, index) => sequence.current(compositor.sourceTime(displayMs)) === displayed[index] && displayed[index]?.width > 0), parallelReady: true, cached: Math.max(...sequences.map(sequence => sequence.pending.size)), placeholders });
      }
      return results;
    }, project);
    assert.equal(results.length, 12);
    for (const result of results) {
      assert.equal(result.ready, true, JSON.stringify(result));
      assert.equal(result.parallelReady, true, JSON.stringify(result));
      assert.equal(result.placeholders, 0, JSON.stringify(result));
      assert.ok(result.cached <= 13, 'cache stays bounded to shutter samples and immediate neighbors');
    }
  } finally {
    await cleanup();
  }
});
