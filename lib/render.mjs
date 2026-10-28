import { launchBrowser } from './browser.mjs';
import { startServer } from './server.mjs';

// Renders a project to MP4 by driving web/render.html in headless Chrome. The
// page posts the finished file back to the local server, which writes it into
// `exportsDir`; nothing leaves the machine.
export async function renderProject({ root, projectUrl, outName, exportsDir, orb, headless = true, timeoutMs = 30 * 60 * 1000, log = () => {} }) {
  const server = await startServer({ root, exportsDir });
  let browser;
  try {
    browser = await launchBrowser({ headless, args: ['--autoplay-policy=no-user-gesture-required'] });
    const page = await browser.newPage({ viewport: { width: 1280, height: 760 } });
    let lastProgress = '';
    page.on('console', (message) => {
      const text = message.text();
      if (text.startsWith('[render]')) {
        const progress = text.slice(9);
        if (progress !== lastProgress) log(progress);
        lastProgress = progress;
      } else if (message.type() === 'error') {
        log(`browser: ${text}`);
      }
    });
    page.on('pageerror', (error) => log(`page error: ${error.message}`));
    const query = new URLSearchParams({ project: projectUrl, out: outName });
    if (orb !== undefined) query.set('orb', orb ? 'on' : 'off');
    await page.goto(`${server.origin}/web/render.html?${query}`);
    await page.waitForFunction(() => ['done', 'error'].includes(window.__demoStudio?.status), null, { timeout: timeoutMs, polling: 500 });
    const state = await page.evaluate(() => window.__demoStudio);
    if (state.status === 'error') throw new Error(`Render failed: ${state.error}`);
    return state;
  } finally {
    try { await browser?.close(); }
    finally { await server.close(); }
  }
}

// Opens a self-reporting tool page (it sets window.__demoStudio.status) and
// waits for it to finish, e.g. web/rig.html writing a rig preview sheet.
export async function runToolPage({ root, path, exportsDir, timeoutMs = 120000 }) {
  const server = await startServer({ root, exportsDir });
  let browser;
  try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${server.origin}${path}`);
    await page.waitForFunction(() => ['done', 'error'].includes(window.__demoStudio?.status), null, { timeout: timeoutMs, polling: 200 });
    const state = await page.evaluate(() => window.__demoStudio);
    if (state.status === 'error') throw new Error(state.error);
    return state;
  } finally {
    try { await browser?.close(); }
    finally { await server.close(); }
  }
}

// Seeks an exported video in Chrome and writes a contact sheet PNG, so an agent
// can look at its own output before sharing it. Pass `times` (seconds) to grab
// specific moments at full resolution instead of an evenly spaced grid.
export async function contactSheet({ root, videoUrl, outName, exportsDir, columns = 4, count = 12, times: requested = null }) {
  const server = await startServer({ root, exportsDir });
  let browser;
  try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    await page.goto(`${server.origin}/web/render.html?inspect=1`);
    return await page.evaluate(async ({ src, name, columns: gridColumns, count: gridCount, requested: moments }) => {
      const video = document.createElement('video');
      video.muted = true;
      video.src = src;
      await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = () => reject(new Error('video failed to load')); });
      const total = moments ? moments.length : gridCount;
      const cols = moments ? Math.min(2, total) : gridColumns;
      const tileWidth = moments ? Math.min(video.videoWidth, total === 1 ? 1920 : 960) : 480;
      const tileHeight = Math.round((tileWidth * video.videoHeight) / video.videoWidth);
      const rows = Math.ceil(total / cols);
      const canvas = document.createElement('canvas');
      canvas.width = cols * tileWidth;
      canvas.height = rows * (tileHeight + 28);
      const context = canvas.getContext('2d');
      context.fillStyle = '#111';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const times = [];
      for (let index = 0; index < total; index += 1) {
        const at = moments ? Math.min(moments[index], video.duration - 0.01) : ((index + 0.5) / total) * video.duration;
        video.currentTime = at;
        await new Promise((resolve) => { video.onseeked = resolve; });
        const x = (index % cols) * tileWidth;
        const y = Math.floor(index / cols) * (tileHeight + 28);
        context.drawImage(video, x, y, tileWidth, tileHeight);
        context.fillStyle = '#ddd';
        context.font = '600 16px system-ui';
        context.fillText(`${at.toFixed(1)}s`, x + 8, y + tileHeight + 20);
        times.push(at);
      }
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      const upload = await fetch(`/api/export?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob });
      return { path: (await upload.json()).path, duration: video.duration, width: video.videoWidth, height: video.videoHeight, times };
    }, { src: videoUrl, name: outName, columns, count, requested });
  } finally {
    try { await browser?.close(); }
    finally { await server.close(); }
  }
}
