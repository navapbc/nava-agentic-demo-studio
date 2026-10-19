import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { buildProject } from './planner.mjs';
import { orbPresenterOptions, presenterOptions, resolvePresenter } from './presenter-config.mjs';
import { recordScript } from './recorder.mjs';
import { readPointerLog, ScreenCapture, screenTrace } from './screen.mjs';
import { renderProject } from './render.mjs';
import { narrationLines, slugFor, validateScript } from './script.mjs';
import { startServer } from './server.mjs';
import { createTimeMap, sourceToOutput } from './timeline.mjs';
import { synthesizeNarration } from './voice.mjs';

// Extension folders in a script are relative to the script file.
// Music files are served from the repository root, so they must live inside it.
export function checkMusicFile(root, script) {
  const file = script.music?.file;
  if (!file) return;
  const path = resolve(root, String(file).replace(/^\//, ''));
  if (!path.startsWith(resolve(root) + sep)) throw new Error(`music.file ${file} must be inside ${root} (for example assets/music/track.mp3).`);
  if (!existsSync(path)) throw new Error(`music.file ${file} does not exist.`);
}

// Chrome shows a blocking dialog for a missing extension, so check first.
export function resolveScriptPaths(script, scriptPath) {
  if (!script.extensions?.length) return script;
  const extensions = script.extensions.map((path) => resolve(dirname(resolve(scriptPath)), path));
  for (const folder of extensions) {
    if (!existsSync(join(folder, 'manifest.json'))) throw new Error(`Extension folder ${folder} has no manifest.json (paths are relative to the script file).`);
  }
  return { ...script, extensions };
}

export async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

// Files are served from the repository root, so every media path in a project
// is a root-relative URL. Recordings must therefore live inside the root.
export function urlFor(root, path) {
  const relativePath = relative(root, resolve(path));
  if (relativePath.startsWith('..') || relativePath.startsWith(sep)) throw new Error(`${path} must be inside ${root} so the renderer can serve it.`);
  return `/${relativePath.split(sep).join('/')}`;
}

export async function loadRig(root, script) {
  if (resolvePresenter(script.presenter)?.kind !== 'portrait') return null;
  const rigPath = script.presenter?.rig;
  return rigPath ? readJson(join(root, rigPath)).catch(() => null) : null;
}

export function settingsFrom(script) {
  return {
    output: script.output,
    zoom: script.zoom,
    speed: script.speed,
    style: script.style,
    music: script.music,
    intro: script.intro,
    introMs: script.introMs,
    frame: script.frame,
    outro: script.outro,
    outroMs: script.outroMs,
    presenter: presenterOptions(script.presenter),
    duckingDb: script.duckingDb,
  };
}

function withoutUndefined(value) {
  return JSON.parse(JSON.stringify(value));
}

export async function voiceStep({ root, script, recordingDir, log }) {
  const lines = narrationLines(script);
  const voiceDir = join(recordingDir, 'voice');
  const manifest = await synthesizeNarration(lines, voiceDir, script.voice || {});
  for (const clip of Object.values(manifest.clips)) {
    clip.src = urlFor(root, clip.file);
    delete clip.file;
  }
  if (lines.length) log(`voice: ${lines.length} lines, ${(Object.values(manifest.clips).reduce((sum, clip) => sum + clip.durationMs, 0) / 1000).toFixed(1)}s of narration (${manifest.provider}${manifest.voice ? `:${manifest.voice}` : ''})`);
  await writeJson(join(voiceDir, 'manifest.json'), manifest);
  return manifest;
}

export async function recordStep({ root, script, recordingDir, voice, headless, dryRun, log }) {
  const server = await startServer({ root });
  try {
    await rm(join(recordingDir, 'frames'), { recursive: true, force: true });
    return await recordScript(script, { outDir: recordingDir, origin: server.origin, urlPrefix: urlFor(root, recordingDir), voice, headless, dryRun, log });
  } finally {
    await server.close();
  }
}

export async function planStep({ root, script, recordingDir, trace, voice, output }) {
  const settings = withoutUndefined(settingsFrom(script));
  if (output) settings.output = { ...(settings.output || {}), ...output };
  const project = buildProject(trace, { voice, rig: await loadRig(root, script), settings });
  if (script.captureParallel) {
    const map = createTimeMap(project.speed, project.durationMs);
    const toOut = sourceMs => project.timeline.introMs + sourceToOutput(map, sourceMs);
    const start = trace.events.find(event => event.kind === 'milestone' && event.label === 'parallel-start');
    const end = trace.events.find(event => event.kind === 'milestone' && event.label === 'parallel-end');
    if (!start || !end) throw new Error('captureParallel needs parallel-start and parallel-end milestones.');
    const reveal = trace.events.find(event => event.kind === 'click' && event.label === 'Reveal filled CalFresh application');
    project.parallel = { startMs: toOut(start.atMs), endMs: reveal ? toOut(reveal.atMs) - 450 : project.timeline.outDurationMs, readyMs: toOut(end.atMs) };
  }
  const projectPath = join(recordingDir, 'project.json');
  await writeJson(projectPath, project);
  return { project, projectPath };
}

// voice -> record -> plan -> render, with no human steps in between.
export async function makeDemo(scriptPath, { root, out, headless = true, output, orb, log = console.log } = {}) {
  let script = resolveScriptPaths(validateScript(await readJson(scriptPath)), scriptPath);
  if (orb !== undefined) script = { ...script, presenter: orb ? orbPresenterOptions(script.presenter) : false };
  checkMusicFile(root, script);
  const slug = slugFor(script);
  const recordingDir = join(root, 'recordings', slug);
  await mkdir(recordingDir, { recursive: true });
  const voice = await voiceStep({ root, script, recordingDir, log });
  const { trace } = await recordStep({ root, script, recordingDir, voice, headless, log });
  const { project, projectPath } = await planStep({ root, script, recordingDir, trace, voice, output });
  log(`plan: ${(project.timeline.outDurationMs / 1000).toFixed(1)}s output from ${(project.durationMs / 1000).toFixed(1)}s recorded, ${project.camera.length} camera keys, ${project.speed.filter((span) => span.rate > 1).length} fast-forward spans`);
  const outPath = resolve(out || join(root, 'exports', `${slug}.mp4`));
  const state = await renderProject({ root, projectUrl: urlFor(root, projectPath), outName: outPath.split(sep).pop(), exportsDir: dirname(outPath), log: (line) => log(`render: ${line}`) });
  return { slug, recordingDir, projectPath, outPath: state.path, state };
}

// Records a window or display that a person or a computer-use agent drives,
// then plans and renders it. Stops after `seconds`, or on Ctrl-C.
export async function recordScreenDemo({ root, target, seconds, slug = 'screen-recording', title, style, music, presenter = false, render = true, output, log = console.log }) {
  const recordingDir = join(root, 'recordings', slug);
  await rm(join(recordingDir, 'frames'), { recursive: true, force: true });
  const urlPrefix = urlFor(root, recordingDir);
  const capture = new ScreenCapture({ outDir: recordingDir, urlPrefix, target, log });
  await capture.start();
  await capture.begin();
  log(seconds ? `screen: recording for ${seconds}s` : 'screen: recording; press Ctrl-C to stop');
  await new Promise((done) => {
    const timer = seconds ? setTimeout(done, seconds * 1000) : null;
    process.once('SIGINT', () => { clearTimeout(timer); done(); });
  });
  const { manifest, summary } = await capture.stop();
  log(`screen: ${manifest.frames.length} frames over ${(manifest.durationMs / 1000).toFixed(1)}s${summary?.dropped ? `, ${summary.dropped} dropped` : ''}`);
  const samples = await readPointerLog(join(recordingDir, 'pointer.jsonl'));
  const trace = screenTrace({ manifest, samples, title, urlPrefix, presenter });
  await writeJson(join(recordingDir, 'trace.json'), trace);
  const settings = withoutUndefined({ style, music, output, intro: title ? { title } : false, outro: undefined });
  const project = buildProject(trace, { settings, rig: await loadRig(root, { presenter }) });
  const projectPath = join(recordingDir, 'project.json');
  await writeJson(projectPath, project);
  log(`plan: ${trace.events.filter((event) => event.kind === 'click').length} clicks, ${project.camera.length} camera keys`);
  if (!render) return { recordingDir, projectPath };
  const outPath = join(root, 'exports', `${slug}.mp4`);
  const state = await renderProject({ root, projectUrl: urlFor(root, projectPath), outName: `${slug}.mp4`, exportsDir: dirname(outPath), log: (line) => log(`render: ${line}`) });
  return { recordingDir, projectPath, outPath: state.path, state };
}
