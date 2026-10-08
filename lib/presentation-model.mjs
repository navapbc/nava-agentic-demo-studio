import { resolve } from 'node:path';

export const PRESENTATION_SCHEMA = 'nava.presentation.v1';
export const LAYOUTS = new Set(['cover', 'statement', 'bullets', 'split', 'demo', 'table', 'closing']);
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const text = value => typeof value === 'string' && value.trim().length > 0;
const fail = message => { throw new Error(message); };

export function validatePresentation(manifest) {
  if (manifest?.schema !== PRESENTATION_SCHEMA) fail(`Expected ${PRESENTATION_SCHEMA}.`);
  for (const key of ['title', 'audience', 'purpose']) if (!text(manifest[key])) fail(`${key} is required.`);
  if (!Array.isArray(manifest.slides) || !manifest.slides.length) fail('slides must contain at least one slide.');
  if (manifest.demos !== undefined && !Array.isArray(manifest.demos)) fail('demos must be a list.');
  const demos = manifest.demos || [];
  const demoIds = new Set();
  for (const demo of demos) {
    if (!ID.test(demo.id) || demoIds.has(demo.id)) fail('Demo IDs must be unique lowercase names.');
    if (Number(Boolean(demo.file)) + Number(Boolean(demo.script)) !== 1) fail(`Demo ${demo.id} needs exactly one of file or script.`);
    if (!text(demo.file || demo.script) || /^https?:/i.test(demo.file || demo.script)) fail(`Demo ${demo.id} must use a local file or script.`);
    if (demo.file && !/\.mp4$/i.test(demo.file)) fail(`Demo ${demo.id} must be an MP4.`);
    if (demo.poster && (!text(demo.poster) || !/\.(png|jpe?g)$/i.test(demo.poster))) fail(`Demo ${demo.id} poster must be PNG or JPEG.`);
    if (demo.posterAtSeconds !== undefined && !(Number.isFinite(demo.posterAtSeconds) && demo.posterAtSeconds >= 0)) fail('posterAtSeconds must be nonnegative.');
    demoIds.add(demo.id);
  }
  const slideIds = new Set();
  const used = new Set();
  for (const [index, slide] of manifest.slides.entries()) {
    const label = `Slide ${index + 1}`;
    if (!ID.test(slide.id) || slideIds.has(slide.id)) fail(`${label} needs a unique lowercase id.`);
    if (!LAYOUTS.has(slide.layout)) fail(`${label} has an unsupported layout.`);
    if (!text(slide.title) || slide.title.length > 140) fail(`${label} needs a title of at most 140 characters.`);
    if (slide.body !== undefined && (!Array.isArray(slide.body) || slide.body.some(item => !text(item)))) fail(`${label} body must contain nonempty strings.`);
    if (slide.sources !== undefined && (!Array.isArray(slide.sources) || slide.sources.some(item => !text(item)))) fail(`${label} sources must be strings.`);
    if (slide.notes !== undefined && typeof slide.notes !== 'string') fail(`${label} notes must be text.`);
    if (slide.layout === 'demo') {
      if (!demoIds.has(slide.demo)) fail(`${label} references an unknown demo.`);
      used.add(slide.demo);
    }
    if (slide.layout === 'split' && !text(slide.image)) fail(`${label} split layout needs an image.`);
    if (slide.image && !/\.(png|jpe?g)$/i.test(slide.image)) fail(`${label} image must be PNG or JPEG.`);
    if (slide.layout === 'table') {
      if (!Array.isArray(slide.columns) || slide.columns.length < 2 || slide.columns.some(item => !text(item))) fail(`${label} table needs column labels.`);
      if (!Array.isArray(slide.rows) || !slide.rows.length || slide.rows.some(row => !Array.isArray(row) || row.length !== slide.columns.length || row.some(cell => !text(cell)))) fail(`${label} table rows must match the columns.`);
    }
    const copy = [slide.title, ...(slide.body || []), ...(slide.rows || []).flat()].join(' ');
    if (/\b\d+(?:\.\d+)?\s*(?:%|seconds?|entries|writes?|applications?|tests?)\b/i.test(copy)
      && (!(slide.sources?.length) || !text(slide.scope))) fail(`${label} quantified evidence needs sources and scope.`);
    slideIds.add(slide.id);
  }
  if (demos.some(demo => !used.has(demo.id))) fail('Every demo must be used by a slide; unused media is not packaged.');
  for (const key of ['background', 'foreground', 'accent', 'paper', 'ink']) {
    if (manifest.theme?.[key] !== undefined && !/^[0-9a-f]{6}$/i.test(manifest.theme[key])) fail(`theme.${key} must be a six-digit hex color without #.`);
  }
  if (manifest.theme?.font !== undefined && !/^[\w -]{1,60}$/.test(manifest.theme.font)) fail('theme.font must be a font name.');
  return manifest;
}

export const inputPath = (baseDir, file) => resolve(baseDir, file);
export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
export function presentationTheme(manifest) {
  return { background: '111E30', foreground: 'FFFFFF', accent: 'B7A2FF', paper: 'F6F4EF', ink: '172537', font: 'Arial', ...(manifest.theme || {}) };
}

export function speakerNotes(slide) {
  return [slide.notes, slide.scope ? `Evidence scope: ${slide.scope}` : '', ...(slide.sources || []).map(source => `Source: ${source}`)].filter(Boolean).join('\n\n');
}
