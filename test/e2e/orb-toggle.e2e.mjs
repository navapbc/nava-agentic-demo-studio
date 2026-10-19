import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launchBrowser } from '../../lib/browser.mjs';
import { buildProject } from '../../lib/planner.mjs';
import { startServer } from '../../lib/server.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

function voiceClip() {
  const rate = 48000;
  const samples = rate * 3;
  const wav = Buffer.alloc(44 + (samples * 2));
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) wav.writeInt16LE(Math.round(Math.sin(index * 220 * 2 * Math.PI / rate) * 4000), 44 + (index * 2));
  return wav;
}

const pixels = page => page.locator('#stage').evaluate(canvas => {
  const context = canvas.getContext('2d');
  // The corner contains the orb; the top left is recording content only.
  return {
    corner: [...context.getImageData(510, 235, 100, 100).data],
    recording: [...context.getImageData(80, 80, 100, 100).data],
  };
});

async function seek(page, milliseconds) {
  await page.locator('#scrubber').evaluate((input, value) => {
    input.value = String(value / 3);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }, milliseconds);
  await page.waitForTimeout(80);
}

async function exportedPixels(page, download) {
  const bytes = await readFile(await download.path());
  assert.ok(bytes.includes(Buffer.from('avc1')), 'download has a real H.264 video track');
  return page.evaluate(async encoded => {
    const blob = new Blob([Uint8Array.from(atob(encoded), character => character.charCodeAt(0))], { type: 'video/mp4' });
    const url = URL.createObjectURL(blob);
    const video = document.createElement('video');
    video.muted = true;
    video.src = url;
    await new Promise((resolve, reject) => { video.onloadeddata = resolve; video.onerror = reject; });
    video.currentTime = 1.25;
    await new Promise(resolve => { video.onseeked = resolve; });
    const canvas = document.createElement('canvas');
    canvas.width = 640; canvas.height = 360;
    const context = canvas.getContext('2d');
    context.drawImage(video, 0, 0);
    const corner = [...context.getImageData(510, 235, 100, 100).data];
    const audio = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
    const signal = [...audio.getChannelData(0).subarray(24000, 25000)];
    URL.revokeObjectURL(url);
    return { corner, signal };
  }, bytes.toString('base64'));
}

function averageDifference(first, second) {
  return first.reduce((sum, value, index) => sum + Math.abs(value - second[index]), 0) / first.length;
}

async function bounded(promise, milliseconds, message) {
  let timeout;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), milliseconds); })]);
  } finally {
    clearTimeout(timeout);
  }
}

test('voice orb toggle changes preview and downloaded MP4 while narration keeps playing', { timeout: 120000 }, async () => {
  let server, browser;
  try {
    server = await startServer({ root });
    browser = await launchBrowser();
    const page = await browser.newPage({ acceptDownloads: true });
    await page.addInitScript(() => {
      window.audioActivity = { mixes: 0, starts: 0, stops: 0 };
      const render = OfflineAudioContext.prototype.startRendering;
      OfflineAudioContext.prototype.startRendering = function (...args) { window.audioActivity.mixes += 1; return render.apply(this, args); };
      for (const method of ['start', 'stop']) {
        const original = AudioBufferSourceNode.prototype[method];
        AudioBufferSourceNode.prototype[method] = function (...args) {
          if (this.context instanceof AudioContext) window.audioActivity[method === 'start' ? 'starts' : 'stops'] += 1;
          return original.apply(this, args);
        };
      }
    });
    const frame = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
      const context = canvas.getContext('2d'); context.fillStyle = '#f4f6fa'; context.fillRect(0, 0, 640, 360);
      context.fillStyle = '#17345d'; context.fillRect(0, 0, 640, 56);
      context.fillStyle = '#fff'; context.font = 'bold 22px sans-serif'; context.fillText('Application workspace', 24, 36);
      context.fillStyle = '#d9e2ef'; context.fillRect(24, 80, 592, 250);
      return canvas.toDataURL('image/png').split(',')[1];
    });
    const project = buildProject({
      schema: 'nava.demo-trace.v1', title: 'Orb visibility', durationMs: 3000,
      viewport: { width: 640, height: 360 }, source: { kind: 'frames', manifest: '/orb-toggle-frames.json' },
      events: [{ kind: 'narration', atMs: 0, endMs: 3000, text: 'The workflow stays visible.', clip: 'voice' }],
    }, {
      settings: { intro: false, outroMs: 0, music: false, frame: false, style: { padding: 0 }, output: { width: 640, height: 360, fps: 12, motionBlur: false }, presenter: { kind: 'orb', color: '#8b5cf6', size: 130, margin: 16 } },
      voice: { clips: { voice: { src: '/orb-toggle-voice.wav', durationMs: 3000 } } },
    });
    let loadedProject = project;
    let holdVoice = false;
    let releaseVoice;
    let signalVoiceRequested;
    await page.route(url => url.pathname === '/orb-toggle-project.json', route => route.fulfill({ json: loadedProject }));
    await page.route('**/orb-toggle-frames.json', route => route.fulfill({ json: { width: 640, height: 360, frames: [{ t: 0, src: '/orb-toggle-frame.png' }] } }));
    await page.route('**/orb-toggle-frame.png', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(frame, 'base64') }));
    await page.route('**/orb-toggle-voice.wav', async route => {
      if (holdVoice) await new Promise(resolve => { releaseVoice = resolve; signalVoiceRequested(); });
      await route.fulfill({ contentType: 'audio/wav', body: voiceClip() });
    });
    await page.goto(`${server.origin}/web/index.html?project=/orb-toggle-project.json`);
    const toggle = page.getByRole('switch', { name: 'Show voice orb' });
    await page.getByRole('button', { name: 'Play preview' }).waitFor({ state: 'visible' });
    await page.waitForFunction(() => !document.querySelector('#play').disabled || document.querySelector('#status').textContent.startsWith('Could not load'), null, { timeout: 10000 }).catch(async error => {
      error.message += ` Status: ${await page.locator('#status').textContent()}; audio: ${JSON.stringify(await page.evaluate(() => window.audioActivity))}`;
      throw error;
    });
    assert.equal(await page.locator('#play').isDisabled(), false, await page.locator('#status').textContent());
    assert.equal(await toggle.isChecked(), true);
    assert.equal(await page.locator('#orb-help').textContent(), 'Voiceover stays on. Exports use this setting.');
    await seek(page, 1250);
    const shown = await pixels(page);
    await toggle.uncheck();
    const hidden = await pixels(page);
    assert.ok(averageDifference(shown.corner, hidden.corner) > 15, 'switch visibly removes the orb from the canvas');
    assert.deepEqual(shown.recording, hidden.recording, 'recording pixels stay in place');
    assert.equal(await page.locator('#scrubber').inputValue(), '417', 'paused playback position stays put');
    await toggle.check();
    assert.deepEqual((await pixels(page)).corner, shown.corner, 'turning back on restores authored size, margin and color');

    await seek(page, 200);
    await page.getByRole('button', { name: 'Play preview' }).click();
    await page.waitForFunction(() => Number(document.querySelector('#scrubber').value) > 140);
    const beforeToggle = Number(await page.locator('#scrubber').inputValue());
    await toggle.uncheck();
    await toggle.check();
    await page.waitForFunction(value => Number(document.querySelector('#scrubber').value) > value + 60, beforeToggle);
    assert.equal(await page.getByRole('button', { name: 'Pause', exact: true }).isVisible(), true);
    assert.deepEqual(await page.evaluate(() => window.audioActivity), { mixes: 1, starts: 1, stops: 0 }, 'toggle neither remixes nor restarts active narration');
    await page.getByRole('button', { name: 'Pause', exact: true }).click();
    await seek(page, 1250);
    await toggle.uncheck();

    holdVoice = true;
    const voiceRequested = new Promise(resolve => { signalVoiceRequested = resolve; });
    const [hiddenDownload] = await Promise.all([
      page.waitForEvent('download'),
      (async () => {
        await page.getByRole('button', { name: 'Export MP4' }).click();
        await page.waitForFunction(() => ['#show-orb', '#play', '#scrubber', '#export'].every(selector => document.querySelector(selector).disabled));
        await bounded(voiceRequested, 10000, 'the export must request narration while controls are frozen');
        holdVoice = false; releaseVoice();
      })(),
    ]);
    const hiddenExport = await exportedPixels(page, hiddenDownload);
    await page.waitForFunction(() => !document.querySelector('#show-orb').disabled);
    assert.ok(averageDifference(hiddenExport.corner, hidden.corner) < 6, 'MP4 matches the preview with the orb hidden');
    assert.ok(hiddenExport.signal.some(sample => Math.abs(sample) > 0.01), 'voiceover audio remains in the orb-free export');

    await toggle.check();
    const [shownDownload] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export MP4' }).click()]);
    const shownExport = await exportedPixels(page, shownDownload);
    assert.ok(averageDifference(shownExport.corner, shown.corner) < 6, 'MP4 matches the restored orb preview');
    assert.ok(averageDifference(shownExport.corner, hiddenExport.corner) > 15, 'downloaded videos visibly honor different selections');
    assert.deepEqual(shownExport.signal, hiddenExport.signal, 'both MP4s retain identical voiceover samples');

    for (const presenter of [null, false]) {
      loadedProject = { ...project, presenter };
      await page.reload();
      await page.waitForFunction(() => !document.querySelector('#show-orb').disabled);
      assert.equal(await toggle.isChecked(), false, 'voiceover-only projects load with the switch off');
      await seek(page, 1250);
      const before = await pixels(page);
      await toggle.check();
      assert.ok(averageDifference(before.corner, (await pixels(page)).corner) > 2, 'voiceover-only projects can enable a new orb');
    }
    assert.equal(project.presenter.size, 130, 'session changes do not mutate the source project');
  } finally {
    await browser?.close();
    await server?.close();
  }
});
