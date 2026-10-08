import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import JSZip from 'jszip';
import { validatePresentation } from '../lib/presentation-model.mjs';
import { exportPowerPoint } from '../lib/presentation-build.mjs';

const manifest = {
  schema: 'nava.presentation.v1', title: 'Product evidence', audience: 'Product team', purpose: 'Explain a prototype',
  demos: [{ id: 'workflow', file: 'workflow.mp4' }],
  slides: [{ id: 'product', layout: 'demo', title: 'The prototype in use', demo: 'workflow' }],
};

test('rejects missing or unused media and conflicting recording sources', () => {
  assert.equal(validatePresentation(manifest).slides.length, 1);
  assert.throws(() => validatePresentation({ ...manifest, demos: [] }), /unknown demo/);
  assert.throws(() => validatePresentation({ ...manifest, slides: [{ id: 'cover', layout: 'cover', title: 'A prototype' }] }), /unused media/);
  assert.throws(() => validatePresentation({ ...manifest, demos: [{ ...manifest.demos[0], script: 'capture.json' }] }), /exactly one/);
  assert.throws(() => validatePresentation({ ...manifest, demos: [{ id: '../outside', file: 'video.mp4' }] }), /IDs/);
  assert.throws(() => validatePresentation({ ...manifest, demos: [...manifest.demos, manifest.demos[0]] }), /unique/);
});

test('quantitative claims keep evidence sources and scope', () => {
  const slide = { id: 'result', layout: 'statement', title: '34 entries were verified', body: ['A synthetic prototype run'] };
  const doc = { ...manifest, demos: [], slides: [slide] };
  assert.throws(() => validatePresentation(doc), /sources and scope/);
  assert.equal(validatePresentation({ ...doc, slides: [{ ...slide, sources: ['run audit'], scope: 'One synthetic run; no submission' }] }).slides[0].title, slide.title);
});

test('tables preserve complete rows and local assets have valid formats', () => {
  const slide = { id: 'formats', layout: 'table', title: 'Presentation formats', columns: ['Format', 'Use'], rows: [['PowerPoint', 'Editable']] };
  assert.equal(validatePresentation({ ...manifest, demos: [], slides: [slide] }).slides[0].rows.length, 1);
  assert.throws(() => validatePresentation({ ...manifest, demos: [], slides: [{ ...slide, rows: [['PowerPoint']] }] }), /match the columns/);
  assert.throws(() => validatePresentation({ ...manifest, demos: [{ id: 'workflow', file: 'https://example.org/video.mp4' }] }), /local/);
  assert.throws(() => validatePresentation({ ...manifest, theme: { background: 'red;display:none' } }), /hex color/);
});

test('PowerPoint text, evidence tables and speaker notes stay native and complete', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'presentation-native-'));
  try {
    await exportPowerPoint({ ...manifest, demos: [], slides: [
      { id: 'cover', layout: 'cover', title: 'Editable product evidence', body: ['A short introduction'], notes: 'Keep this context in notes.', sources: ['Prototype record'], scope: 'Fictional example' },
      { id: 'formats', layout: 'table', title: 'Presentation formats', columns: ['Format', 'Use'], rows: [['PowerPoint', 'Editable'], ['Browser', 'Playable video']] },
    ] }, [], dir);
    const zip = await JSZip.loadAsync(await readFile(join(dir, 'presentation.pptx')));
    const cover = await zip.file('ppt/slides/slide1.xml').async('string');
    const table = await zip.file('ppt/slides/slide2.xml').async('string');
    const notes = await zip.file('ppt/notesSlides/notesSlide1.xml').async('string');
    assert.ok(cover.includes('Editable product evidence') && cover.includes('<a:t>'));
    assert.ok(table.includes('<a:tbl>') && table.includes('Playable video') && table.includes('Editable'));
    assert.ok(notes.includes('Keep this context in notes.') && notes.includes('Prototype record') && notes.includes('Fictional example'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
