import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { buildPresentation } from '../../lib/presentation-build.mjs';
import { launchBrowser } from '../../lib/browser.mjs';
import { startServer } from '../../lib/server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('one build records a demo, embeds its bytes, and presents without leaking source paths', { timeout: 300000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'presentation-e2e-'));
  const slug = basename(dir).toLowerCase();
  let server, browser;
  try {
    await writeFile(join(dir, 'record.json'), JSON.stringify({
      schema: 'nava.demo-script.v1', title: 'Fictional product test', slug,
      startUrl: 'examples/fixtures/benefits-portal/index.html', voice: { provider: 'none' }, music: false, presenter: false,
      intro: false, outroMs: 0, output: { width: 1280, height: 720, fps: 30, motionBlur: false },
      steps: [{ do: 'click', target: '#start', label: 'Start application' }, { do: 'type', target: '#first-name', text: 'Demo', label: 'Enter first name' }, { do: 'pause', ms: 300 }],
    }));
    await writeFile(join(dir, 'presentation.json'), JSON.stringify({
      schema: 'nava.presentation.v1', title: 'Product <script>window.injected=true</script>', audience: 'Test team', purpose: 'Validate recording and assembly',
      demos: [{ id: 'workflow', script: 'record.json' }],
      slides: [
        { id: 'cover', layout: 'cover', eyebrow: 'Product evidence', title: 'Product\nevidence', body: ['A fictional workflow'] },
        { id: 'demo', layout: 'demo', title: 'The workflow in use', demo: 'workflow' },
        { id: 'close', layout: 'closing', title: 'Review comes next', body: ['Keep the decision with the user'] },
        { id: 'formats', layout: 'table', title: 'Presentation formats', columns: ['Format', 'Use'], rows: [['PowerPoint', 'Edit the presentation'], ['Browser', 'Play the local video']] },
      ],
    }));
    const out = join(dir, 'build');
    await buildPresentation(join(dir, 'presentation.json'), { root, outDir: out, log: () => {} });
    const portable = JSON.parse(await readFile(join(out, 'presentation.json'), 'utf8'));
    assert.ok(!JSON.stringify(portable).includes(dir));
    assert.equal(portable.demos[0].script, undefined);
    const movie = await readFile(join(out, 'media/workflow.mp4'));
    const report = JSON.parse(await readFile(join(out, 'build-report.json'), 'utf8'));
    assert.ok(report.renderedSlides[0].objects.some(object => object.text === 'PRODUCT EVIDENCE'));
    assert.ok(report.renderedSlides[0].objects.some(object => object.text === 'Product\nevidence' && object.h > 100));
    const deck = await JSZip.loadAsync(await readFile(join(out, 'presentation.pptx')));
    const table = await deck.file('ppt/slides/slide4.xml').async('string');
    assert.ok(table.includes('<a:tbl>') && table.includes('Play the local video'));
    const embedded = Object.values(deck.files).filter(file => /^ppt\/media\/.*\.mp4$/.test(file.name));
    assert.ok(embedded.length > 0);
    assert.ok((await Promise.all(embedded.map(file => file.async('nodebuffer')))).every(bytes => hash(bytes) === hash(movie)));
    const bundle = await JSZip.loadAsync(await readFile(join(out, 'presentation.zip')));
    assert.equal(hash(await bundle.file('media/workflow.mp4').async('nodebuffer')), hash(movie));
    assert.ok(bundle.file('index.html') && bundle.file('presentation.pptx') && bundle.file('presentation.pdf'));
    assert.equal(bundle.file('record.json'), null);
    server = await startServer({ root: out });
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1304, height: 800 } });
    await page.goto(server.origin + '/index.html');
    assert.equal(await page.evaluate(() => window.injected), undefined);
    await page.locator('#next').click();
    await page.locator('video').evaluate(async video => { video.muted = true; await video.play(); });
    await page.waitForFunction(() => document.querySelector('video').currentTime > 0);
    await page.locator('#next').click();
    assert.equal(await page.locator('video').evaluate(video => video.paused), true);
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.evaluate(() => window.presentationStudio.currentSlide()), 1);
    assert.ok(await page.locator('video').isVisible());
    assert.ok((await readFile(join(out, 'presentation.pdf'))).subarray(0, 5).equals(Buffer.from('%PDF-')));
  } finally {
    await browser?.close(); await server?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(join(root, 'recordings', slug), { recursive: true, force: true });
  }
});
