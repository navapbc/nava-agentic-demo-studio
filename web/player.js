import { renderMix } from './audio.js';
import { Compositor } from './compositor.js';
import { renderToMp4 } from './render.js';

const canvas = document.querySelector('#stage');
const context = canvas.getContext('2d');
const playButton = document.querySelector('#play');
const exportButton = document.querySelector('#export');
const scrubber = document.querySelector('#scrubber');
const time = document.querySelector('#time');
const status = document.querySelector('#status');

let project;
let compositor;
let mix;
let audioContext;
let voice;
let playing = false;
let startedAt = 0;
let startOffset = 0;
let pausedAt = 0;
let frame;

const format = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms / 1000) % 60)).padStart(2, '0')}`;
const now = () => (playing ? startOffset + ((audioContext.currentTime - startedAt) * 1000) : pausedAt);

function paint(outMs) {
  compositor.prefetch(outMs + 50);
  compositor.draw(context, outMs);
  scrubber.value = String(Math.round((outMs / compositor.duration) * 1000));
  time.value = `${format(outMs)} / ${format(compositor.duration)}`;
}

function tick() {
  const outMs = now();
  if (outMs >= compositor.duration) {
    stop(compositor.duration);
    return;
  }
  paint(outMs);
  frame = requestAnimationFrame(tick);
}

function stop(atMs = now()) {
  playing = false;
  pausedAt = atMs;
  voice?.stop();
  voice = null;
  cancelAnimationFrame(frame);
  playButton.textContent = 'Play preview';
  paint(pausedAt);
}

async function play() {
  audioContext ||= new AudioContext();
  await audioContext.resume();
  if (pausedAt >= compositor.duration) pausedAt = 0;
  voice = audioContext.createBufferSource();
  voice.buffer = mix;
  voice.connect(audioContext.destination);
  startedAt = audioContext.currentTime + 0.05;
  startOffset = pausedAt;
  voice.start(startedAt, pausedAt / 1000);
  playing = true;
  playButton.textContent = 'Pause';
  tick();
}

async function load() {
  const path = new URLSearchParams(location.search).get('project');
  if (!path) return;
  project = await fetch(path).then((response) => response.json());
  document.querySelector('#title').textContent = project.title;
  document.title = `${project.title} · Demo Studio`;
  canvas.width = project.output?.width || 1920;
  canvas.height = project.output?.height || 1080;
  status.textContent = 'Loading recording…';
  compositor = await Compositor.create(project);
  await compositor.prepare(0);
  paint(0);
  status.textContent = 'Mixing voiceover and music…';
  mix = await renderMix(project);
  status.textContent = `Ready · ${format(compositor.duration)} · ${project.voice?.length || 0} narration lines · source ${project.source?.kind || 'none'}`;
  for (const control of [playButton, exportButton, scrubber]) control.disabled = false;
}

playButton.addEventListener('click', () => (playing ? stop() : play()));
scrubber.addEventListener('input', async () => {
  const target = (Number(scrubber.value) / 1000) * compositor.duration;
  if (playing) stop(target);
  pausedAt = target;
  await compositor.prepare(target);
  paint(target);
});

exportButton.addEventListener('click', async () => {
  if (playing) stop();
  exportButton.disabled = true;
  const offscreen = document.createElement('canvas');
  try {
    const result = await renderToMp4(project, {
      canvas: offscreen,
      onProgress: ({ stage, progress }) => { status.textContent = `Exporting (${stage}) ${Math.round(progress * 100)}%`; },
    });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(result.blob);
    anchor.download = `${project.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.mp4`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 5000);
    status.textContent = `Exported ${result.frames} frames (${result.videoCodec}${result.audioCodec ? ` + ${result.audioCodec}` : ''}).`;
  } catch (error) {
    status.textContent = `Export failed: ${error.message}`;
  } finally {
    exportButton.disabled = false;
  }
});

load().catch((error) => { status.textContent = `Could not load project: ${error.message}`; });
