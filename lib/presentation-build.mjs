import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, parse, resolve } from 'node:path';
import { promisify } from 'node:util';
import PptxGenJS from 'pptxgenjs';
import JSZip from 'jszip';
import { launchBrowser } from './browser.mjs';
import { makeDemo } from './pipeline.mjs';
import { startServer } from './server.mjs';
import { inputPath, presentationTheme, speakerNotes, validatePresentation } from './presentation-model.mjs';
import { presentationHtml } from './presentation-html.mjs';

const run = promisify(execFile);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export async function exportPowerPoint(manifest, media, outDir, measuredSlides) {
  const theme = presentationTheme(manifest);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.title = manifest.title;
  pptx.subject = manifest.purpose;
  pptx.author = 'Nava Presentation Studio';
  pptx.lang = 'en-US';
  pptx.theme = { headFontFace: theme.font, bodyFontFace: theme.font, lang: 'en-US' };
  const common = { fontFace: theme.font, margin: 0, breakLine: false, valign: 'top' };
  for (const [index, item] of manifest.slides.entries()) {
    const slide = pptx.addSlide();
    const dark = ['cover', 'closing', 'demo'].includes(item.layout);
    const foreground = dark ? theme.foreground : theme.ink;
    slide.background = { color: dark ? theme.background : theme.paper };
    // Use the same measured composition for the browser and editable deck.
    // Text remains native PowerPoint text; screenshots are only QA previews.
    if (measuredSlides?.[index]?.objects) {
      for (const object of measuredSlides[index].objects) {
        const box = { x: object.x / 96, y: object.y / 96, w: object.w / 96, h: object.h / 96 };
        if (object.kind === 'video') {
          const demo = media.find(entry => entry.id === item.demo);
          const poster = await readFile(join(outDir, demo.poster));
          slide.addMedia({ type: 'video', path: join(outDir, demo.file), cover: `image/${/\.png$/i.test(demo.poster) ? 'png' : 'jpeg'};base64,${poster.toString('base64')}`, ...box });
        } else if (object.kind === 'image') {
          slide.addImage({ path: join(outDir, item.image), ...box, sizing: { type: 'contain', w: box.w, h: box.h } });
        } else if (object.kind === 'table') {
          const rows = [item.columns.map(text => ({ text, options: { bold: true } })), ...item.rows.map(row => row.map((text, column) => ({ text, options: { bold: column === 0 } })))];
          slide.addTable(rows, { ...box, colW: object.colWidths.map(width => width / 96), rowH: object.rowHeights.map(height => height / 96),
            fontFace: theme.font, fontSize: object.fontSize * .75, color: foreground, fill: theme.paper,
            border: { type: 'solid', color: 'C9CED5', pt: .5 }, margin: [.16, .2, .16, .2], autoPage: false });
        } else {
          slide.addText(object.text, { ...common, ...box, w: Math.min(box.w + .18, 12.65 - box.x), h: box.h + .025, fontSize: object.fontSize * .75,
            color: object.color, bold: object.bold, charSpacing: object.letterSpacing * .75,
            ...(object.lineHeight ? { lineSpacing: object.lineHeight * .75 } : {}),
            transparency: (1 - (object.opacity ?? 1)) * 100,
            ...(object.kind === 'bullet' ? { bullet: { indent: 18 } } : {}) });
        }
      }
      if (speakerNotes(item)) slide.addNotes(speakerNotes(item));
      continue;
    }
    let titleY = item.layout === 'cover' || item.layout === 'closing' ? 1.15 : 0.55;
    if (item.eyebrow) {
      slide.addText(item.eyebrow.toUpperCase(), { ...common, x: .71, y: titleY, w: 11.9, h: .3, fontSize: 13.5, bold: true, color: theme.accent, charSpacing: 1.7 });
      titleY += .57;
    }
    const titleSize = item.layout === 'cover' ? 55.5 : item.layout === 'closing' ? 40.5 : item.layout === 'demo' ? 32 : 36;
    slide.addText(item.title, { ...common, x: .71, y: titleY, w: 11.9, h: item.layout === 'cover' ? 2.25 : item.layout === 'closing' ? 1.35 : .9, fontSize: titleSize, color: foreground, bold: true });
    const body = (item.body || []).join('\n\n');
    if (item.layout === 'demo') {
      const demo = media.find(entry => entry.id === item.demo);
      const poster = await readFile(join(outDir, demo.poster));
      const mime = /\.png$/i.test(demo.poster) ? 'png' : 'jpeg';
      slide.addMedia({ type: 'video', path: join(outDir, demo.file), cover: `image/${mime};base64,${poster.toString('base64')}`, x: 1.6667, y: 1.05, w: 10, h: 5.625 });
    } else if (item.layout === 'table') {
      const widths = item.columns.map((_, i) => i ? 11.9 * .62 / (item.columns.length - 1) : 11.9 * .38);
      const rows = [item.columns.map(text => ({ text, options: { bold: true } })), ...item.rows];
      slide.addTable(rows, { x: .71, y: 1.6, w: 11.9, colW: widths, fontFace: theme.font, fontSize: 21, color: foreground,
        fill: theme.paper, border: { type: 'solid', color: 'C9CED5', pt: .5 }, margin: [.18, .2, .18, .2], autoPage: false });
    } else if (item.layout === 'split') {
      slide.addText(body, { ...common, x: .71, y: 1.7, w: 5.1, h: 4.5, fontSize: 22, color: foreground, paraSpaceAfterPt: 15 });
      slide.addImage({ path: join(outDir, item.image), x: 6.35, y: 1.6, w: 6.25, h: 4.65, sizing: { type: 'contain', w: 6.25, h: 4.65 } });
    } else if (item.layout === 'bullets') {
      slide.addText(item.body.map(text => ({ text, options: { bullet: { indent: 21 }, breakLine: true } })),
        { ...common, x: .9, y: 1.8, w: 11.3, h: 4.8, fontSize: 24, color: foreground, paraSpaceAfterPt: 16 });
    } else {
      const bodyY = item.layout === 'cover' ? titleY + 2.65 : item.layout === 'closing' ? titleY + 1.8 : 2.1;
      slide.addText(body, { ...common, x: .71, y: bodyY, w: 11.6, h: Math.min(4.4, 6.7 - bodyY),
        fontSize: item.layout === 'statement' ? 38 : item.layout === 'closing' ? 28.5 : 24,
        color: foreground, paraSpaceAfterPt: 16 });
    }
    if (item.caption) slide.addText(item.caption, { ...common, x: .71, y: 6.84, w: 11.9, h: .28, fontSize: 13.5, color: foreground });
    slide.addText(manifest.title, { ...common, x: .71, y: 7.18, w: 11, h: .2, fontSize: 10.5, color: foreground, transparency: 45 });
    slide.addText(String(index + 1), { ...common, x: 12, y: 7.18, w: .6, h: .2, fontSize: 10.5, align: 'right', color: foreground, transparency: 45 });
    if (speakerNotes(item)) slide.addNotes(speakerNotes(item));
  }
  const target = join(outDir, 'presentation.pptx');
  await pptx.writeFile({ fileName: target });
  return target;
}

export async function inspectPresentationPage(page, count, outDir) {
  const results = [];
  await mkdir(join(outDir, 'slides'), { recursive: true });
  for (let i = 0; i < count; i += 1) {
    await page.evaluate(index => window.presentationStudio.goTo(index), i);
    await page.evaluate(() => document.fonts.ready);
    // Wait for a decoded frame, then hide player chrome in the QA preview.
    // The presentation itself keeps the native playback controls.
    const videos = page.locator('.slide:not([hidden]) video');
    for (const video of await videos.all()) {
      await video.evaluate(async element => {
        if (element.readyState < 2) await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Preview video timed out')), 20000);
          element.addEventListener('loadeddata', () => { clearTimeout(timer); resolve(); }, { once: true });
          element.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Preview video could not decode')); }, { once: true });
          element.preload = 'auto';
          element.load();
        });
        element.controls = false;
      });
    }
    const errors = await page.evaluate(() => {
      const slide = document.querySelector('.slide:not([hidden])');
      const edge = slide.getBoundingClientRect();
      const footer = slide.querySelector('footer').getBoundingClientRect();
      return [...slide.querySelectorAll('h1,.content p,.content li,table,video,img:not(.print-poster),.caption')].flatMap(node => {
        const rect = node.getBoundingClientRect();
        if (!rect.width || !rect.height) return [];
        const problems = [];
        if (rect.bottom > footer.top - 3) problems.push(`${node.tagName} extends into the footer`);
        if (rect.left < edge.left || rect.right > edge.right || node.scrollWidth > node.clientWidth + 2) problems.push(`${node.tagName} extends outside its width`);
        return problems;
      });
    });
    if (errors.length) throw new Error(`Slide ${i + 1} does not fit: ${errors.join('; ')}. Shorten the copy or choose another layout.`);
    const file = `slides/slide-${String(i + 1).padStart(2, '0')}.png`;
    await page.locator('.slide:not([hidden])').screenshot({ path: join(outDir, file) });
    await videos.evaluateAll(elements => elements.forEach(element => { element.controls = true; }));
    const objects = await page.evaluate(() => {
      const slide = document.querySelector('.slide:not([hidden])');
      const frame = slide.getBoundingClientRect();
      const colorHex = color => color.match(/\d+/g).slice(0, 3).map(value => Number(value).toString(16).padStart(2, '0')).join('');
      return [...slide.querySelectorAll('h1,.eyebrow,.content p,.content li,table,video,img:not(.print-poster),.caption,footer span')].map(node => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        const kind = ({ TABLE: 'table', VIDEO: 'video', IMG: 'image', LI: 'bullet' })[node.tagName] || 'text';
        let opacity = 1;
        for (let ancestor = node; ancestor; ancestor = ancestor.parentElement) opacity *= Number(getComputedStyle(ancestor).opacity);
        const text = style.textTransform === 'uppercase' ? node.textContent.toUpperCase() : style.textTransform === 'lowercase' ? node.textContent.toLowerCase() : node.textContent;
        return { kind, x: rect.left - frame.left, y: rect.top - frame.top, w: rect.width, h: rect.height,
          text, opacity, fontSize: parseFloat(style.fontSize), lineHeight: parseFloat(style.lineHeight) || 0, bold: Number(style.fontWeight) >= 600,
          color: colorHex(style.color), letterSpacing: parseFloat(style.letterSpacing) || 0,
          ...(kind === 'table' ? { colWidths: [...node.querySelectorAll('thead th')].map(cell => cell.getBoundingClientRect().width), rowHeights: [...node.rows].map(row => row.getBoundingClientRect().height) } : {}) };
      }).filter(object => object.w && object.h);
    });
    results.push({ slide: i + 1, file, objects });
  }
  await page.evaluate(() => window.presentationStudio.goTo(0));
  return results;
}

async function bundleFiles(dir, zip, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = `${prefix}${entry.name}`;
    if (entry.isDirectory()) await bundleFiles(join(dir, entry.name), zip, relative + '/');
    else if (entry.name !== 'presentation.zip') zip.file(relative, await readFile(join(dir, entry.name)));
  }
}

export async function buildPresentation(manifestPath, { root, outDir, log = console.log } = {}) {
  root = resolve(root);
  manifestPath = resolve(manifestPath);
  const baseDir = dirname(manifestPath);
  const manifest = validatePresentation(JSON.parse(await readFile(manifestPath, 'utf8')));
  outDir = resolve(outDir || join(root, 'exports', 'presentation'));
  if ([root, baseDir, parse(outDir).root].includes(outDir)) throw new Error('Choose a separate output directory.');
  // Check all declared inputs before recording or writing any outputs.
  for (const demo of manifest.demos || []) {
    await access(inputPath(baseDir, demo.file || demo.script));
    if (demo.poster) await access(inputPath(baseDir, demo.poster));
  }
  for (const slide of manifest.slides) if (slide.image) await access(inputPath(baseDir, slide.image));
  if (manifest.storyPlan) {
    const storyPath = inputPath(baseDir, manifest.storyPlan);
    const story = JSON.parse(await readFile(storyPath, 'utf8'));
    if (story.slides?.length !== manifest.slides.length || story.slides.some((slide, i) => slide.title !== manifest.slides[i].title)) throw new Error('The story plan and presentation slide titles must match.');
    const auditor = join(root, 'plugins/nava-presentation-studio/skills/nava-presentation-studio/scripts/audit_slide_plan.mjs');
    const audit = await run(process.execPath, [auditor, storyPath]);
    log(audit.stdout.trim());
    if (audit.stderr) log(audit.stderr.trim());
  }
  await mkdir(dirname(outDir), { recursive: true });
  const stage = await mkdtemp(join(dirname(outDir), '.presentation-'));
  let server;
  let browser;
  try {
    await mkdir(join(stage, 'media'));
    const media = [];
    for (const demo of manifest.demos || []) {
      const file = `media/${demo.id}.mp4`;
      if (demo.script) {
        log(`demo: recording ${demo.id}`);
        await makeDemo(inputPath(baseDir, demo.script), { root, out: join(stage, file), log });
      } else await copyFile(inputPath(baseDir, demo.file), join(stage, file));
      const poster = `media/${demo.id}${demo.poster ? extname(demo.poster).toLowerCase() : '.png'}`;
      if (demo.poster) await copyFile(inputPath(baseDir, demo.poster), join(stage, poster));
      media.push({ id: demo.id, file, poster, sha256: sha256(await readFile(join(stage, file))) });
    }
    const slides = [];
    for (const slide of manifest.slides) {
      const item = { ...slide };
      if (slide.image) {
        item.image = `media/slide-${slide.id}${extname(slide.image).toLowerCase()}`;
        await copyFile(inputPath(baseDir, slide.image), join(stage, item.image));
      }
      slides.push(item);
    }
    const portable = { schema: manifest.schema, title: manifest.title, audience: manifest.audience, purpose: manifest.purpose, theme: manifest.theme, slides, demos: media };
    server = await startServer({ root: stage });
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1304, height: 800 }, deviceScaleFactor: 1 });
    // Establish the local origin before setContent loads same-origin media.
    // The staged index is written after decoding, so this initial page is 404.
    await page.goto(server.origin);
    // Validate every clip by decoding a frame in Chrome, even when a poster
    // was supplied; an extension alone cannot prove a usable video.
    for (const [index, demo] of (manifest.demos || []).entries()) {
      const entry = media[index];
      await page.setContent('<video style="width:1280px;height:720px;object-fit:contain;background:black" muted playsinline></video>');
      const state = await page.evaluate(async ({ url, seekTo }) => {
        const video = document.querySelector('video');
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Video decoding timed out')), 20000);
          video.onloadeddata = () => { clearTimeout(timer); resolve(); };
          video.onerror = () => { clearTimeout(timer); reject(new Error('Video could not be decoded')); };
          video.src = url;
        });
        const at = Math.min(seekTo, Math.max(0, video.duration - .1));
        if (at > 0) await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Video seeking timed out')), 20000);
          video.onseeked = () => { clearTimeout(timer); resolve(); };
          video.onerror = () => { clearTimeout(timer); reject(new Error('Video could not seek')); };
          video.currentTime = at;
        });
        return { durationSeconds: video.duration, width: video.videoWidth, height: video.videoHeight };
      }, { url: `${server.origin}/${entry.file}`, seekTo: demo.posterAtSeconds ?? 2 });
      if (!(Number.isFinite(state.durationSeconds) && state.durationSeconds > 0 && state.width > 0 && state.height > 0)) throw new Error(`Demo ${demo.id} is not a decodable video.`);
      Object.assign(entry, state);
      if (!demo.poster) await page.locator('video').screenshot({ path: join(stage, entry.poster) });
      log(`demo: ${demo.id}, ${state.durationSeconds.toFixed(1)} seconds`);
    }
    await writeFile(join(stage, 'index.html'), presentationHtml(portable, media));
    await writeFile(join(stage, 'presentation.json'), JSON.stringify(portable, null, 2));
    await page.goto(server.origin + '/index.html');
    await page.waitForFunction(() => window.presentationStudio);
    await page.evaluate(() => Promise.all([...document.images].map(image => image.decode())));
    const renderedSlides = await inspectPresentationPage(page, slides.length, stage);
    await page.pdf({ path: join(stage, 'presentation.pdf'), printBackground: true, preferCSSPageSize: true });
    await exportPowerPoint(portable, media, stage, renderedSlides);
    await writeFile(join(stage, 'README.txt'), `${manifest.title}\n\nOpen index.html in Chrome to present with video playback. Use Left/Right arrow keys or the navigation buttons. Videos play when clicked and pause when you leave the slide.\n\nThe editable PowerPoint includes the MP4 files. Playback support depends on the presentation app. The PDF shows video posters. Keep the media folder beside index.html. No network service is required to present this package.\n`);
    const report = { schema: 'nava.presentation-build.v1', slideCount: slides.length, renderedSlides, media, editablePowerPoint: true, videosEmbedded: media.length, uploads: 0 };
    await writeFile(join(stage, 'build-report.json'), JSON.stringify(report, null, 2));
    const zip = new JSZip();
    await bundleFiles(stage, zip);
    await writeFile(join(stage, 'presentation.zip'), await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 1 } }));
    await mkdir(outDir, { recursive: true });
    await cp(stage, outDir, { recursive: true });
    log(`presentation: ${slides.length} slides, ${media.length} demos → ${outDir}`);
    return { outDir, ...report };
  } finally {
    await browser?.close();
    await server?.close();
    await rm(stage, { recursive: true, force: true });
  }
}
