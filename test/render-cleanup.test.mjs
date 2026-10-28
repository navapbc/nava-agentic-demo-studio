import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('render tools close their local servers when no browser can launch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-render-cleanup-'));
  try {
    // Both launch paths fail without starting a browser: an unknown channel,
    // then an empty, isolated Playwright browser cache. The child must exit
    // naturally; a listening server left behind causes this test to time out.
    const child = await run(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { renderProject, runToolPage, contactSheet } from ${JSON.stringify(new URL('../lib/render.mjs', import.meta.url).href)};
      const root = process.env.STUDIO_RENDER_TEST_ROOT;
      for (const call of [
        () => renderProject({ root, projectUrl: '/project.json', outName: 'test.mp4' }),
        () => runToolPage({ root, path: '/web/music.html' }),
        () => contactSheet({ root, videoUrl: '/test.mp4', outName: 'test.png' }),
      ]) await assert.rejects(call, /Could not launch Chrome/);
      console.log('all launch failures cleaned up');
    `], {
      env: { ...process.env, DEMO_STUDIO_CHANNEL: 'studio-missing-browser', PLAYWRIGHT_BROWSERS_PATH: join(root, 'empty-browser-cache'), STUDIO_RENDER_TEST_ROOT: root },
      timeout: 10000,
    });
    assert.match(child.stdout, /all launch failures cleaned up/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
