#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildProject, validateTrace } from '../lib/planner.mjs';

export { buildProject, validateTrace };

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

const USAGE = `Nava Agentic Demo Studio

  demo-studio make SCRIPT.json [--out OUT.mp4] [--4k] [--fps 30] [--headed]
      Voice, record, plan, and render a demo script end to end.
  demo-studio voice SCRIPT.json          Synthesize narration only.
  demo-studio record SCRIPT.json [--headed] [--dry-run]
      Synthesize narration and record the script (writes recordings/<slug>/).
  demo-studio plan TRACE.json PROJECT.json [--voice MANIFEST.json] [--script SCRIPT.json]
  demo-studio render PROJECT.json [OUT.mp4]
  demo-studio inspect VIDEO.mp4 [SHEET.png] [--at 4.5,12]
      Contact sheet (or full-size frames at given seconds) for reviewing an export.
  demo-studio rig RIG.json [OUT.png]          Preview an explicitly supplied local presenter rig.
  demo-studio music [--style NAME|all|list] [--seconds 30]
      Audition generated music styles (WAV/M4A, spectrogram, levels).
  demo-studio screen access | list | record  Record any window or display (see: demo-studio screen)
  demo-studio serve [PORT]                    Preview UI at /web/?project=...
  demo-studio doctor                          Check Chrome, codecs, and voices.`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) positional.push(value);
    else if (['--headed', '--4k', '--dry-run', '--presenter', '--no-render', '--json'].includes(value)) flags[value.slice(2)] = true;
    else flags[value.slice(2)] = argv[++index];
  }
  return { positional, flags };
}

const log = (line) => console.log(line);

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);
  const pipeline = () => import('../lib/pipeline.mjs');

  if (command === 'plan') {
    const { readJson } = await pipeline();
    const [inputPath = 'examples/parallel-apps.trace.json', outputPath = 'examples/parallel-apps.project.json'] = positional;
    const trace = await readJson(resolve(inputPath));
    const voice = flags.voice ? await readJson(resolve(flags.voice)) : undefined;
    let options = { voice };
    if (flags.script) {
      const { loadRig, settingsFrom } = await pipeline();
      const script = await readJson(resolve(flags.script));
      options = { voice, rig: await loadRig(root, script), settings: JSON.parse(JSON.stringify(settingsFrom(script))) };
    }
    const project = buildProject(trace, options);
    await writeFile(resolve(outputPath), `${JSON.stringify(project, null, 2)}\n`);
    log(`Wrote ${resolve(outputPath)}`);
    return;
  }

  if (command === 'serve') {
    const { startServer } = await import('../lib/server.mjs');
    const server = await startServer({ root, port: Number(positional[0]) || 4310 });
    log(`Demo Studio: ${server.origin}/web/`);
    return;
  }

  if (command === 'make') {
    const { makeDemo } = await pipeline();
    const output = {
      ...(flags['4k'] ? { width: 3840, height: 2160 } : {}),
      ...(flags.fps ? { fps: Number(flags.fps) } : {}),
    };
    const result = await makeDemo(resolve(positional[0] || 'examples/benefits-portal.script.json'), { root, out: flags.out, headless: !flags.headed, output: Object.keys(output).length ? output : undefined, log });
    log(`Done: ${result.outPath} (${(result.state.bytes / 1024 / 1024).toFixed(1)} MB, ${result.state.frames} frames, ${result.state.videoCodec}${result.state.audioCodec ? ` + ${result.state.audioCodec}` : ''})`);
    log(`Preview: npm run serve, then open /web/?project=/recordings/${result.slug}/project.json`);
    return;
  }

  if (command === 'voice' || command === 'record') {
    const { readJson, recordStep, planStep, resolveScriptPaths, voiceStep } = await pipeline();
    const { slugFor, validateScript } = await import('../lib/script.mjs');
    const script = resolveScriptPaths(validateScript(await readJson(resolve(positional[0]))), resolve(positional[0]));
    const recordingDir = join(root, 'recordings', slugFor(script));
    const voice = await voiceStep({ root, script, recordingDir, log });
    if (command === 'voice') return;
    const { trace } = await recordStep({ root, script, recordingDir, voice, headless: !flags.headed, dryRun: flags['dry-run'], log });
    if (flags['dry-run']) {
      log(`Dry run: ${script.steps.length} steps ran, ${trace.events.length} trace events. Nothing was captured.`);
      return;
    }
    const { projectPath } = await planStep({ root, script, recordingDir, trace, voice });
    log(`Wrote ${projectPath}`);
    return;
  }

  if (command === 'render') {
    const { urlFor } = await pipeline();
    const { renderProject } = await import('../lib/render.mjs');
    const projectPath = resolve(positional[0]);
    const outPath = resolve(positional[1] || join(root, 'exports', `${basename(dirname(projectPath))}.mp4`));
    const state = await renderProject({ root, projectUrl: urlFor(root, projectPath), outName: basename(outPath), exportsDir: dirname(outPath), log });
    log(`Done: ${state.path}`);
    return;
  }

  if (command === 'inspect') {
    const { urlFor } = await pipeline();
    const { contactSheet } = await import('../lib/render.mjs');
    const videoPath = resolve(positional[0]);
    const sheetPath = resolve(positional[1] || videoPath.replace(/\.[a-z0-9]+$/i, '.sheet.png'));
    const times = flags.at ? flags.at.split(',').map(Number).filter(Number.isFinite) : null;
    const result = await contactSheet({ root, videoUrl: urlFor(root, videoPath), outName: basename(sheetPath), exportsDir: dirname(sheetPath), times });
    log(`${result.width}x${result.height}, ${result.duration.toFixed(2)}s -> ${result.path}`);
    return;
  }

  if (command === 'screen') {
    const [action = 'help'] = positional;
    const screen = await import('../lib/screen.mjs');
    if (action === 'access') {
      const { execFile } = await import('node:child_process');
      const helper = await screen.captureHelper();
      execFile(helper, ['request-access'], (error, stdout) => {
        const granted = /"granted":true/.test(stdout || '');
        log(granted ? 'Screen Recording permission is granted.' : 'Screen Recording is not granted yet. Approve the prompt (or enable this app in System Settings > Privacy & Security > Screen & System Audio Recording), then quit and reopen the app.');
      });
      return;
    }
    if (action === 'list') {
      const targets = await screen.listTargets();
      if (flags.json) return log(JSON.stringify(targets, null, 2));
      for (const display of targets.displays) log(`display ${display.id}  ${display.width}x${display.height}`);
      for (const window of targets.windows) log(`window  ${String(window.id).padEnd(6)} ${window.app.padEnd(24)} ${Math.round(window.frame.width)}x${Math.round(window.frame.height)}  ${window.title}`);
      return;
    }
    if (action === 'record') {
      const { recordScreenDemo } = await pipeline();
      const target = flags.window ? { window: flags.window } : flags.app ? { app: flags.app, title: flags.title } : flags.display ? { display: flags.display } : {};
      const result = await recordScreenDemo({
        root,
        target,
        seconds: flags.seconds ? Number(flags.seconds) : undefined,
        slug: flags.name || 'screen-recording',
        title: flags.caption,
        style: flags.wallpaper ? { background: flags.wallpaper } : undefined,
        music: flags.music === 'none' ? false : (flags.music ? { style: flags.music } : undefined),
        presenter: Boolean(flags.presenter),
        render: !flags['no-render'],
        output: flags['4k'] ? { width: 3840, height: 2160 } : undefined,
        log,
      });
      log(result.outPath ? `Done: ${result.outPath}` : `Wrote ${result.projectPath}`);
      return;
    }
    log(`Usage:
  demo-studio screen access                Request Screen Recording permission
  demo-studio screen list [--json]         Windows and displays you can record
  demo-studio screen record [--app NAME [--title TEXT] | --window ID | --display ID]
                            [--seconds N] [--name SLUG] [--caption TITLE] [--music STYLE|none]
                            [--wallpaper NAME] [--presenter] [--4k] [--no-render]
  --presenter adds the purple voice orb; screen recordings otherwise use no presenter.`);
    return;
  }

  if (command === 'music') {
    const { MUSIC_STYLES } = await import('../lib/music-plan.mjs');
    const { runToolPage } = await import('../lib/render.mjs');
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const requested = flags.style || 'all';
    if (requested === 'list') {
      for (const [name, style] of Object.entries(MUSIC_STYLES)) log(`${name.padEnd(10)} ${String(style.bpm).padStart(3)} bpm  ${style.description}`);
      return;
    }
    const styles = requested === 'all' ? Object.keys(MUSIC_STYLES) : requested.split(',');
    const exportsDir = flags.out ? dirname(resolve(flags.out)) : join(root, 'exports');
    for (const style of styles) {
      if (!MUSIC_STYLES[style]) throw new Error(`Unknown style "${style}". Try: ${Object.keys(MUSIC_STYLES).join(', ')}.`);
      const name = flags.out && styles.length === 1 ? basename(resolve(flags.out)).replace(/\.(wav|m4a)$/i, '') : `music-${style}`;
      const query = new URLSearchParams({ style, seconds: flags.seconds || '30', out: `${name}.wav`, sheet: `${name}.spectrogram.png` });
      const state = await runToolPage({ root, path: `/web/music.html?${query}`, exportsDir, timeoutMs: 300000 });
      const report = state.report;
      let listen = state.wav;
      try {
        await promisify(execFile)('afconvert', ['-f', 'm4af', '-d', 'aac', '-b', '192000', state.wav, state.wav.replace(/\.wav$/, '.m4a')]);
        listen = state.wav.replace(/\.wav$/, '.m4a');
      } catch {
        // afconvert is macOS-only; the WAV is still there.
      }
      log(`${style}: ${report.bpm} bpm, ${report.rmsDb} dB RMS, peak ${report.peakDb} dB${report.clipped ? `, ${report.clipped} clipped samples` : ''}`);
      log(`  sections: ${Object.entries(report.sections).map(([section, value]) => `${section} ${value.rmsDb} dB`).join(', ')}`);
      log(`  listen: ${listen}`);
      log(`  spectrogram: ${state.sheet}`);
    }
    return;
  }

  if (command === 'rig') {
    if (!positional[0]) throw new Error('Supply a local rig path: demo-studio rig RIG.json [OUT.png].');
    const { urlFor } = await pipeline();
    const { runToolPage } = await import('../lib/render.mjs');
    const rigPath = resolve(positional[0]);
    const outPath = resolve(positional[1] || join(root, 'exports', `${basename(rigPath, '.json')}.png`));
    const query = new URLSearchParams({ rig: urlFor(root, rigPath), out: basename(outPath), size: flags.size || '420' });
    const state = await runToolPage({ root, path: `/web/rig.html?${query}`, exportsDir: dirname(outPath) });
    log(`Rig preview: ${state.path}`);
    return;
  }

  if (command === 'doctor') {
    const { launchBrowser } = await import('../lib/browser.mjs');
    const { listSayVoices } = await import('../lib/voice.mjs');
    const { startServer } = await import('../lib/server.mjs');
    const voices = await listSayVoices();
    log(`voices: ${voices.length ? voices.filter((voice) => voice.locale.startsWith('en_')).map((voice) => voice.name).join(', ') : 'none (macOS say unavailable; use "voice": { "provider": "none" })'}`);
    const server = await startServer({ root });
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage();
      await page.goto(`${server.origin}/web/render.html`);
      const caps = await page.evaluate(async () => ({
        browser: navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0],
        h264: (await VideoEncoder.isConfigSupported({ codec: 'avc1.64002A', width: 1920, height: 1080, framerate: 60, bitrate: 12e6, avc: { format: 'avc' } })).supported,
        aac: (await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2, bitrate: 192000 })).supported,
      }));
      log(`chrome: ${caps.browser}; H.264 encode: ${caps.h264 ? 'yes' : 'no'}; AAC encode: ${caps.aac ? 'yes' : 'no'}`);
    } finally {
      await browser.close();
      await server.close();
    }
    return;
  }

  log(USAGE);
}

if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`demo-studio: ${error.message}`);
    process.exitCode = 1;
  });
}
