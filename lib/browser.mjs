import { chromium } from 'playwright-core';

// Uses the installed Google Chrome so H.264/AAC encoding and proprietary video
// decoding are available without downloading a separate browser build.
export async function launchBrowser({ headless = true, args = [] } = {}) {
  const channel = process.env.DEMO_STUDIO_CHANNEL || 'chrome';
  try {
    return await chromium.launch({ channel, headless, args });
  } catch (channelError) {
    try {
      return await chromium.launch({ headless, args });
    } catch {
      throw new Error(`Could not launch Chrome (${channel}). Install Google Chrome or set DEMO_STUDIO_CHANNEL. ${channelError.message.split('\n')[0]}`);
    }
  }
}

// Chrome for Testing (installed by Playwright) still accepts --load-extension,
// which branded Chrome ignores since version 137.
export async function chromeForTesting() {
  const { access, readdir } = await import('node:fs/promises');
  const { homedir } = await import('node:os');
  const { join } = await import('node:path');
  const candidates = [process.env.DEMO_STUDIO_CHROMIUM, chromium.executablePath()].filter(Boolean);
  const cache = join(homedir(), 'Library', 'Caches', 'ms-playwright');
  const builds = (await readdir(cache).catch(() => [])).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const arch of ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64']) {
      candidates.push(join(cache, build, arch, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'));
    }
  }
  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next location.
    }
  }
  throw new Error('Loading an extension needs Chrome for Testing. Install it with `npx playwright install chromium`, or set DEMO_STUDIO_CHROMIUM.');
}

export async function freePort() {
  const { createServer } = await import('node:net');
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}
