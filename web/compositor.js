// Draws one output frame of a demo project. `draw(context, outMs)` is a pure
// function of output time plus decoded source frames, so the live preview and
// the frame-by-frame exporter produce the same picture.
//
// A frame is two layers: the scene (wallpaper, window, recording, cursor),
// which the camera zooms and pans and which can be motion blurred, and the
// overlays (subtitles, badges, cards, presenter), which stay in screen space.

import {
  activeAt,
  cameraAt,
  clamp,
  createTimeMap,
  cursorAt,
  cursorVisibility,
  easeOutCubic,
  frameIndexAt,
  layoutFor,
  lerp,
  mouthAt,
  presenterSwapAt,
  projectSourceTime,
  rateAtSource,
  recordingToScreen,
  smoothstep,
  viewWindow,
} from '/lib/timeline.mjs';
import { Presenter, VoiceOrb } from './presenter.js';

const FONT = '"Inter", "SF Pro Display", -apple-system, system-ui, sans-serif';

// Mesh-gradient wallpapers: a base gradient plus large blurred colour blobs.
export const WALLPAPERS = {
  nava: { base: ['#1a1030', '#3c1a4a', '#7a2c64'], blobs: ['#e05bbf', '#7b5cff', '#ff8a70', '#3b2a8f', '#c04cd0'] },
  aurora: { base: ['#07131f', '#0d2a3a', '#123d4a'], blobs: ['#35d0ba', '#6b7cff', '#1fa2ff', '#a66cff', '#2de2a6'] },
  sunset: { base: ['#2a0f2e', '#6b1f3f', '#c2464f'], blobs: ['#ff9a5a', '#ff5f8a', '#ffd166', '#b8327a', '#ff7b54'] },
  ocean: { base: ['#061a33', '#0b3a66', '#125b8f'], blobs: ['#3fb4ff', '#6ee7ff', '#2f6bff', '#5a9dff', '#00c2d1'] },
  midnight: { base: ['#0b0d14', '#141827', '#1c2238'], blobs: ['#3a4a8f', '#5b3a8f', '#1f6f8b', '#2d2f6b', '#4b5bd0'] },
  paper: { base: ['#f4f1ec', '#ece6f5', '#e3eef6'], blobs: ['#f7c6d9', '#c9d8ff', '#ffe3b3', '#d7c8ff', '#bfe7e1'] },
};

function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

async function loadFrames(manifestUrl) {
  const manifest = await fetch(manifestUrl).then((response) => {
    if (!response.ok) throw new Error(`Frame manifest ${manifestUrl} returned ${response.status}.`);
    return response.json();
  });
  return manifest.layers ? new LayeredFrames(manifest) : new FrameSequence(manifest);
}

// Damage-driven JPEG frames written by the recorder.
class FrameSequence {

  constructor(manifest) {
    this.frames = manifest.frames;
    this.width = manifest.width;
    this.height = manifest.height;
    this.pending = new Map();
    this.ready = new Map();
  }

  decode(index) {
    if (!this.pending.has(index)) {
      const promise = fetch(this.frames[index].src)
        .then((response) => response.blob())
        .then((blob) => createImageBitmap(blob))
        .then((bitmap) => {
          if (this.pending.get(index) === promise) this.ready.set(index, bitmap);
          else bitmap.close();
          return bitmap;
        });
      this.pending.set(index, promise);
    }
    return this.pending.get(index);
  }

  evictBefore(index, retained) {
    for (const key of [...this.pending.keys()]) {
      if ((key >= index - 1 && key <= index + 1) || retained.has(key)) continue;
      this.ready.get(key)?.close();
      this.ready.delete(key);
      this.pending.delete(key);
    }
  }

  async prepare(sourceMs, exact, retainedTimes = []) {
    const index = frameIndexAt(this.frames, sourceMs);
    if (index < 0) return;
    const retained = new Set(retainedTimes.map((time) => frameIndexAt(this.frames, time)));
    if (!exact) {
      // Preview decoding is asynchronous: keep the eligible displayed bitmap
      // while its replacement/lookahead loads, using current()'s same bounds.
      for (const target of [index, ...retained]) {
        for (let cursor = target; cursor >= Math.max(0, target - 30); cursor -= 1) {
          if (this.ready.has(cursor)) { retained.add(cursor); break; }
        }
      }
    }
    this.evictBefore(index, retained);
    for (let ahead = 1; ahead <= 1 && index + ahead < this.frames.length; ahead += 1) this.decode(index + ahead);
    const current = this.decode(index);
    if (exact) await current;
  }

  current(sourceMs) {
    const index = frameIndexAt(this.frames, sourceMs);
    if (index < 0) return null;
    for (let cursor = index; cursor >= Math.max(0, index - 30); cursor -= 1) {
      if (this.ready.has(cursor)) return this.ready.get(cursor);
    }
    return null;
  }
}

// A window recorded surface by surface (the page and an extension side panel,
// each from its own DevTools screencast). Each frame is assembled into the
// window layout the recorder measured, with a Chrome-style side panel header.
class LayeredFrames {
  constructor(manifest) {
    this.width = manifest.width;
    this.height = manifest.height;
    this.scale = manifest.width / manifest.viewport.width;
    this.panel = manifest.chrome?.sidePanel || null;
    this.layers = manifest.layers.map((layer) => ({ ...layer, sequence: new FrameSequence({ frames: layer.frames }) }));
    this.parallelLayers = (manifest.parallelLayers || []).map((layer) => ({ ...layer, sequence: new FrameSequence(layer) }));
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.width;
    this.canvas.height = this.height;
    this.drawn = [];
  }

  async prepare(sourceMs, exact, retainedTimes = []) {
    await Promise.all(this.layers.map((layer) => layer.sequence.prepare(sourceMs, exact, retainedTimes)));
    if(this.parallelEnabled) await Promise.all(this.parallelLayers.map((layer) => layer.sequence.prepare(this.parallelSourceMs ?? sourceMs, exact)));
  }

  drawPanelHeader(context, rect) {
    const scale = this.scale;
    const height = (this.panel.headerHeight || 40) * scale;
    const x = rect.x * scale;
    const width = rect.w * scale;
    context.fillStyle = '#ffffff';
    context.fillRect(x, 0, width, height);
    context.fillStyle = '#e3e3e8';
    context.fillRect(x, height - scale, width, scale);
    context.fillStyle = '#dcdce2';
    context.fillRect(x - scale, 0, scale, this.height);
    context.fillStyle = '#1f1f24';
    context.font = `600 ${13 * scale}px -apple-system, system-ui, sans-serif`;
    context.textBaseline = 'middle';
    context.fillText(this.panel.title, x + (16 * scale), height / 2);
    context.strokeStyle = '#5f5f68';
    context.lineWidth = 1.6 * scale;
    const cx = x + width - (22 * scale);
    const cy = height / 2;
    const arm = 4.5 * scale;
    context.beginPath();
    context.moveTo(cx - arm, cy - arm);
    context.lineTo(cx + arm, cy + arm);
    context.moveTo(cx + arm, cy - arm);
    context.lineTo(cx - arm, cy + arm);
    context.stroke();
    context.textBaseline = 'alphabetic';
  }

  current(sourceMs) {
    const images = this.layers.map((layer) => layer.sequence.current(sourceMs));
    if (images.every((image, index) => image === this.drawn[index])) return this.canvas;
    const context = this.canvas.getContext('2d');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, this.width, this.height);
    this.layers.forEach((layer, index) => {
      const image = images[index];
      const { x, y, w, h } = layer.rect;
      if (image) context.drawImage(image, x * this.scale, y * this.scale, w * this.scale, h * this.scale);
      if (layer.name === 'sidepanel' && this.panel) this.drawPanelHeader(context, layer.rect);
    });
    this.drawn = images;
    return this.canvas;
  }
}

// A raw screen recording (e.g. from QuickTime or ScreenCaptureKit).
class VideoSource {
  static async load(src) {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.src = src;
    await new Promise((resolve, reject) => {
      video.addEventListener('loadeddata', resolve, { once: true });
      video.addEventListener('error', () => reject(new Error(`Could not load ${src}.`)), { once: true });
    });
    return new VideoSource(video);
  }

  constructor(video) {
    this.video = video;
    this.width = video.videoWidth;
    this.height = video.videoHeight;
  }

  async prepare(sourceMs, exact) {
    const target = sourceMs / 1000;
    if (Math.abs(this.video.currentTime - target) < (exact ? 0.004 : 0.12) || (!exact && this.video.seeking)) return;
    this.video.currentTime = target;
    if (exact) await new Promise((resolve) => this.video.addEventListener('seeked', resolve, { once: true }));
  }

  current() {
    return this.video.readyState >= 2 ? this.video : null;
  }
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.roundRect(x, y, width, height, radius);
}

function wrapLines(context, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = [];
  for (const word of words) {
    const next = [...line, word].join(' ');
    if (context.measureText(next).width > maxWidth && line.length) {
      lines.push(line);
      line = [word];
    } else {
      line.push(word);
    }
  }
  if (line.length) lines.push(line);
  return lines;
}

// Cursor artwork in a 24-unit box, drawn white with a dark outline.
function drawArrow(context) {
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(0, 17.5);
  context.lineTo(4.4, 13.6);
  context.lineTo(7.6, 20.6);
  context.lineTo(10.6, 19.3);
  context.lineTo(7.5, 12.4);
  context.lineTo(13.2, 12.4);
  context.closePath();
  context.fillStyle = '#111';
  context.fill();
  context.shadowColor = 'transparent';
  context.lineJoin = 'round';
  context.lineWidth = 1.6;
  context.strokeStyle = '#fff';
  context.stroke();
}

const HAND = {
  hotspot: [9.5, 0.6],
  capsules: [[9.5, 2.6, 9.5, 12.5, 4], [13.4, 9.6, 13.4, 13.5, 3.8], [17, 10.4, 17, 14, 3.6], [20.3, 11.8, 20.3, 15, 3.2], [7.2, 16.4, 3.9, 12.8, 3.4]],
  palm: [7.3, 11.6, 14.8, 10.6, 4.6],
};

function drawHand(context) {
  context.translate(-HAND.hotspot[0], -HAND.hotspot[1]);
  context.lineCap = 'round';
  const shapes = (extra) => {
    for (const [x1, y1, x2, y2, width] of HAND.capsules) {
      context.lineWidth = width + extra;
      context.beginPath();
      context.moveTo(x1, y1);
      context.lineTo(x2, y2);
      context.stroke();
    }
    const [x, y, w, h, r] = HAND.palm;
    context.lineWidth = extra;
    roundedRect(context, x, y, w, h, r);
    if (extra) context.stroke();
    else context.fill();
  };
  context.strokeStyle = '#111';
  context.fillStyle = '#111';
  shapes(3);
  context.shadowColor = 'transparent';
  context.strokeStyle = '#fff';
  context.fillStyle = '#fff';
  shapes(0);
  context.strokeStyle = 'rgba(17, 17, 17, 0.55)';
  context.lineWidth = 0.9;
  for (const x of [11.4, 15.2, 18.7]) {
    context.beginPath();
    context.moveTo(x, 13);
    context.lineTo(x, 15.6);
    context.stroke();
  }
}

function drawBeam(context) {
  context.lineCap = 'round';
  for (const [color, width] of [['#fff', 3.6], ['#111', 1.5]]) {
    context.strokeStyle = color;
    context.lineWidth = width;
    context.beginPath();
    context.moveTo(0, -8.5);
    context.lineTo(0, 8.5);
    context.moveTo(-3.2, -9.5);
    context.quadraticCurveTo(0, -8.4, 3.2, -9.5);
    context.moveTo(-3.2, 9.5);
    context.quadraticCurveTo(0, 8.4, 3.2, 9.5);
    context.stroke();
    context.shadowColor = 'transparent';
  }
}

function drawCursor(context, x, y, size, press, kind, alpha) {
  if (alpha <= 0.01) return;
  const scale = size / 24;
  context.save();
  context.globalAlpha *= alpha;
  context.translate(x, y);
  context.scale(scale * press, scale * press);
  context.shadowColor = 'rgba(0, 0, 0, 0.35)';
  context.shadowBlur = 6;
  context.shadowOffsetY = 2;
  if (kind === 'pointer') drawHand(context);
  else if (kind === 'text') drawBeam(context);
  else drawArrow(context);
  context.restore();
}

export class Compositor {
  static async create(project) {
    let source = null;
    if (project.source?.kind === 'frames') source = await loadFrames(project.source.manifest);
    else if (project.source?.kind === 'video' && project.source.src) source = await VideoSource.load(project.source.src).catch(() => null);
    let presenter = null;
    const speech = (project.voice || []).map((line) => ({ start: line.outMs, end: line.outEndMs }));
    if (project.presenter?.kind === 'orb') presenter = new VoiceOrb({ speech });
    else if (project.presenter?.image) presenter = await Presenter.load(project.presenter.image, project.presenter.rig, { speech }).catch(() => null);
    await document.fonts?.ready;
    return new Compositor(project, source, presenter);
  }

  constructor(project, source, presenter) {
    this.project = project;
    this.source = source;
    this.presenter = presenter;
    this.map = createTimeMap(project.speed, project.durationMs);
    this.layout = layoutFor(project);
    // Overlay sizes are authored for 1080p and scale with the output height.
    this.ui = this.layout.height / 1080;
    this.duration = project.timeline?.outDurationMs ?? this.map.outDurationMs;
    this.recordingEnd = (project.timeline?.introMs || 0) + this.map.outDurationMs;
    this.shutterMs = 500 / (project.output?.fps || 60);
    this.backdrop = this.paintBackdrop();
  }

  sourceTime(outMs) {
    return projectSourceTime(this.project, this.map, outMs);
  }

  async prepare(outMs, { motionBlur = false } = {}) {
    if (!this.source) return;
    this.source.parallelSourceMs=Math.min(this.sourceTime(outMs),this.project.parallel?.freezeSourceMs ?? Infinity);
    this.source.parallelEnabled=Boolean(this.project.parallel&&outMs>=this.project.parallel.startMs-100&&outMs<=this.project.parallel.endMs+100);
    // Keep every bitmap this draw will sample alive until drawing finishes.
    // A shutter can cross many frame indices during acceleration or a cut.
    const sourceTimes = [...new Set([outMs, ...this.sceneSampleTimes(outMs, motionBlur)].map((time) => this.sourceTime(time)))];
    for (const sourceMs of sourceTimes) await this.source.prepare(sourceMs, true, sourceTimes);
  }

  prefetch(outMs, displayMs = outMs) {
    if (!this.source) return;
    this.source.parallelSourceMs = Math.min(this.sourceTime(displayMs), this.project.parallel?.freezeSourceMs ?? Infinity);
    this.source.parallelEnabled = Boolean(this.project.parallel && displayMs >= this.project.parallel.startMs - 100 && displayMs <= this.project.parallel.endMs + 100);
    this.source.prepare(this.sourceTime(outMs), false, [this.sourceTime(displayMs)]).catch(() => {});
  }

  paintBackdrop() {
    const { width, height } = this.layout;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    const background = this.project.style.background;
    const preset = Array.isArray(background) ? { base: background, blobs: [] } : (WALLPAPERS[background] || WALLPAPERS.nava);
    const gradient = context.createLinearGradient(0, 0, width, height);
    preset.base.forEach((color, index) => gradient.addColorStop(index / Math.max(1, preset.base.length - 1), color));
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    if (preset.blobs.length) {
      const small = document.createElement('canvas');
      small.width = Math.ceil(width / 4);
      small.height = Math.ceil(height / 4);
      const blobs = small.getContext('2d');
      blobs.filter = `blur(${Math.round(small.width * 0.07)}px)`;
      const random = seeded(this.project.style.seed ?? 3);
      preset.blobs.forEach((color, index) => {
        blobs.globalAlpha = 0.55 + (random() * 0.3);
        blobs.fillStyle = color;
        blobs.beginPath();
        const x = ((index + 0.5) / preset.blobs.length) * small.width + ((random() - 0.5) * small.width * 0.25);
        const y = random() * small.height;
        blobs.ellipse(x, y, small.width * (0.18 + (random() * 0.14)), small.height * (0.25 + (random() * 0.2)), random() * Math.PI, 0, Math.PI * 2);
        blobs.fill();
      });
      context.globalAlpha = 0.85;
      context.imageSmoothingQuality = 'high';
      context.drawImage(small, 0, 0, width, height);
      context.globalAlpha = 1;
    }
    // Fine film grain hides gradient banding after H.264 compression.
    const tile = document.createElement('canvas');
    tile.width = 256;
    tile.height = 256;
    const tileContext = tile.getContext('2d');
    const noise = tileContext.createImageData(256, 256);
    const random = seeded(17);
    for (let index = 0; index < noise.data.length; index += 4) {
      const value = Math.round(random() * 255);
      noise.data[index] = value;
      noise.data[index + 1] = value;
      noise.data[index + 2] = value;
      noise.data[index + 3] = 255;
    }
    tileContext.putImageData(noise, 0, 0);
    context.globalAlpha = 0.045;
    context.globalCompositeOperation = 'overlay';
    context.fillStyle = context.createPattern(tile, 'repeat');
    context.fillRect(0, 0, width, height);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    return canvas;
  }

  drawChrome(context) {
    const { frame, bar } = this.layout;
    if (!bar) return;
    const style = this.project.style;
    const top = context.createLinearGradient(0, frame.y, 0, frame.y + bar);
    top.addColorStop(0, '#f7f6f9');
    top.addColorStop(1, '#eceaef');
    context.fillStyle = top;
    context.fillRect(frame.x, frame.y, frame.w, bar);
    context.fillStyle = '#d8d6dd';
    context.fillRect(frame.x, frame.y + bar - Math.max(1, bar * 0.025), frame.w, Math.max(1, bar * 0.025));
    const centerY = frame.y + (bar / 2);
    ['#ff5f57', '#febc2e', '#28c840'].forEach((color, index) => {
      context.fillStyle = color;
      context.beginPath();
      context.arc(frame.x + (bar * 0.55) + (index * bar * 0.5), centerY, bar * 0.15, 0, Math.PI * 2);
      context.fill();
    });
    context.strokeStyle = '#9d9aa5';
    context.lineWidth = bar * 0.05;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    for (const [x, direction] of [[frame.x + (bar * 2.35), -1], [frame.x + (bar * 2.95), 1]]) {
      context.beginPath();
      context.moveTo(x - (direction * bar * 0.08), centerY - (bar * 0.14));
      context.lineTo(x + (direction * bar * 0.08), centerY);
      context.lineTo(x - (direction * bar * 0.08), centerY + (bar * 0.14));
      context.stroke();
    }
    const pillWidth = Math.min(frame.w * 0.46, bar * 14);
    const pillHeight = bar * 0.62;
    const pillX = frame.x + ((frame.w - pillWidth) / 2);
    context.fillStyle = '#e4e2e9';
    roundedRect(context, pillX, centerY - (pillHeight / 2), pillWidth, pillHeight, pillHeight / 2);
    context.fill();
    const url = style.frame?.url || '';
    if (url) {
      context.font = `500 ${bar * 0.33}px ${FONT}`;
      const textWidth = context.measureText(url).width;
      const lockX = frame.x + (frame.w / 2) - (textWidth / 2) - (bar * 0.22);
      context.fillStyle = '#6e6b76';
      roundedRect(context, lockX - (bar * 0.09), centerY - (bar * 0.02), bar * 0.18, bar * 0.15, bar * 0.03);
      context.fill();
      context.strokeStyle = '#6e6b76';
      context.lineWidth = bar * 0.035;
      context.beginPath();
      context.arc(lockX, centerY - (bar * 0.03), bar * 0.055, Math.PI, 0);
      context.stroke();
      context.fillStyle = '#3f3d46';
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(url, lockX + (bar * 0.18), centerY + (bar * 0.01));
      context.textBaseline = 'alphabetic';
    }
  }

  // The camera follows the pointer only while it is visibly in use, and never
  // during a focus hold on something an agent is doing by itself.
  followPoint(pointer, sourceMs, outMs) {
    if (!pointer) return null;
    if ((this.project.focusHolds || []).some((hold) => outMs >= hold.startMs - 400 && outMs <= hold.endMs + 400)) return null;
    return cursorVisibility(this.project.cursor?.moves, sourceMs) > 0.5 ? pointer : null;
  }

  // The camera-space layer. Returns nothing; draws into `context`.
  drawScene(context, outMs) {
    const { project, layout } = this;
    const { inset, frame } = layout;
    const style = project.style;
    const sourceMs = this.sourceTime(outMs);
    const introMs = project.timeline?.introMs || 0;
    const reveal = introMs ? smoothstep(clamp((outMs - (introMs - 750)) / 750, 0, 1)) : 1;
    const outroFade = project.outro ? smoothstep(clamp((outMs - this.recordingEnd - 350) / 900, 0, 1)) : 0;
    const pointer = cursorAt(project.cursor?.moves, sourceMs);
    const window = viewWindow(layout, cameraAt(project.camera, outMs), this.followPoint(pointer, sourceMs, outMs));
    const radius = style.radius * this.ui;

    context.save();
    context.setTransform(window.scale, 0, 0, window.scale, -window.x * window.scale, -window.y * window.scale);
    context.drawImage(this.backdrop, 0, 0);

    const grow = lerp(0.94, 1, reveal);
    const centerX = frame.x + (frame.w / 2);
    const centerY = frame.y + (frame.h / 2);
    context.translate(centerX, centerY);
    context.scale(grow, grow);
    context.translate(-centerX, -centerY);
    context.globalAlpha = reveal * (1 - outroFade);
    context.shadowColor = 'rgba(6, 2, 12, 0.5)';
    context.shadowBlur = 80 * this.ui;
    context.shadowOffsetY = 30 * this.ui;
    context.fillStyle = '#0b0b0f';
    roundedRect(context, frame.x, frame.y, frame.w, frame.h, radius);
    context.fill();
    context.shadowColor = 'transparent';
    context.save();
    roundedRect(context, frame.x, frame.y, frame.w, frame.h, radius);
    context.clip();
    this.drawChrome(context);
    const image = this.source?.current(sourceMs);
    if (image) {
      context.imageSmoothingQuality = 'high';
      context.drawImage(image, inset.x, inset.y, inset.w, inset.h);
    } else {
      context.fillStyle = '#16121c';
      context.fillRect(inset.x, inset.y, inset.w, inset.h);
      context.fillStyle = 'rgba(255, 255, 255, 0.55)';
      context.font = `600 ${28 * this.ui}px ${FONT}`;
      context.textAlign = 'center';
      context.fillText('No recording loaded', inset.x + (inset.w / 2), inset.y + (inset.h / 2));
    }

    // Screen recordings can include a personal browser tab strip. A configured
    // privacy mask replaces that strip with a branded title bar in the final
    // composition while leaving the underlying capture untouched for audits.
    const privacyMaskTop = clamp(Number(style.privacyMaskTop || 0), 0, 0.25);
    if (privacyMaskTop > 0) {
      const maskHeight = inset.h * privacyMaskTop;
      const gradient = context.createLinearGradient(inset.x, inset.y, inset.x + inset.w, inset.y);
      gradient.addColorStop(0, '#20113b');
      gradient.addColorStop(0.55, '#5b2474');
      gradient.addColorStop(1, '#29143f');
      context.fillStyle = gradient;
      context.fillRect(inset.x, inset.y, inset.w, maskHeight);
      context.fillStyle = style.accent || '#e05bbf';
      context.fillRect(inset.x, inset.y + maskHeight - (3 * this.ui), inset.w, 3 * this.ui);
      context.fillStyle = 'rgba(255, 255, 255, 0.92)';
      context.font = `700 ${17 * this.ui}px ${FONT}`;
      context.textAlign = 'left';
      context.textBaseline = 'middle';
      context.fillText(style.privacyMaskLabel || 'Nava Form-Filling Assistant · Synthetic demo data', inset.x + (24 * this.ui), inset.y + (maskHeight / 2));
      context.textBaseline = 'alphabetic';
    }

    if (pointer) {
      const px = inset.x + (pointer.x * inset.w);
      const py = inset.y + (pointer.y * inset.h);
      let press = 1;
      for (const click of project.cursor.clicks || []) {
        const age = sourceMs - click.atMs;
        if (age < -40 || age > 650) continue;
        if (age < 220) press = Math.min(press, lerp(0.78, 1, easeOutCubic(clamp(Math.abs(age) / 220, 0, 1))));
        if (age < 0) continue;
        const progress = easeOutCubic(age / 650);
        const cx = inset.x + (click.x * inset.w);
        const cy = inset.y + (click.y * inset.h);
        context.beginPath();
        context.arc(cx, cy, lerp(8, 42, progress) * layout.contentScale, 0, Math.PI * 2);
        context.strokeStyle = `rgba(224, 91, 191, ${0.85 * (1 - progress)})`;
        context.lineWidth = 3.5 * layout.contentScale;
        context.stroke();
        context.fillStyle = `rgba(224, 91, 191, ${0.18 * (1 - progress)})`;
        context.fill();
      }
      drawCursor(context, px, py, 30 * layout.contentScale, press, pointer.kind, cursorVisibility(project.cursor.moves, sourceMs));
    }
    context.restore();
    context.restore();
    return window;
  }

  // Screen-space displacement between the two edges of the shutter, used to
  // decide how many sub-frames a motion-blurred frame needs.
  motionAt(outMs) {
    const { layout, project } = this;
    const half = this.shutterMs / 2;
    const probe = (t) => {
      const sourceMs = this.sourceTime(t);
      const pointer = cursorAt(project.cursor?.moves, sourceMs);
      const window = viewWindow(layout, cameraAt(project.camera, t), this.followPoint(pointer, sourceMs, t));
      const corners = [recordingToScreen(layout, window, 0, 0), recordingToScreen(layout, window, 1, 1)];
      const cursor = pointer ? recordingToScreen(layout, window, pointer.x, pointer.y) : { x: 0, y: 0 };
      return { corners, cursor };
    };
    const from = probe(outMs - half);
    const to = probe(outMs + half);
    const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return Math.max(distance(from.corners[0], to.corners[0]), distance(from.corners[1], to.corners[1]), distance(from.cursor, to.cursor));
  }

  sceneSampleTimes(outMs, motionBlur = true) {
    const samples = motionBlur ? clamp(Math.ceil(this.motionAt(outMs) / 3), 1, 10) : 1;
    return samples === 1 ? [outMs] : Array.from({ length: samples }, (_, index) => outMs + (((index / (samples - 1)) - 0.5) * this.shutterMs));
  }

  drawBlurredScene(context, outMs) {
    const times = this.sceneSampleTimes(outMs);
    if (times.length === 1) {
      this.drawScene(context, outMs);
      return;
    }
    const { width, height } = this.layout;
    for (const name of ['blurTarget', 'blurLayer']) {
      if (!this[name]) {
        this[name] = document.createElement('canvas');
        this[name].width = width;
        this[name].height = height;
      }
    }
    const target = this.blurTarget.getContext('2d');
    const layer = this.blurLayer.getContext('2d');
    for (let index = 0; index < times.length; index += 1) {
      const t = times[index];
      layer.setTransform(1, 0, 0, 1, 0, 0);
      layer.clearRect(0, 0, width, height);
      this.drawScene(layer, t);
      target.globalAlpha = 1 / (index + 1);
      if (index === 0) target.clearRect(0, 0, width, height);
      target.drawImage(this.blurLayer, 0, 0);
    }
    target.globalAlpha = 1;
    context.drawImage(this.blurTarget, 0, 0);
  }

  drawCard(context, card, alpha, rise) {
    if (!card || alpha <= 0) return;
    const { width, height } = this.layout;
    const ui = this.ui;
    context.save();
    context.globalAlpha = alpha;
    context.drawImage(this.backdrop, 0, 0);
    context.textAlign = 'center';
    context.fillStyle = this.project.style.accent;
    context.font = `800 ${22 * ui}px ${FONT}`;
    context.letterSpacing = `${4 * ui}px`;
    if (card.eyebrow) context.fillText(card.eyebrow.toUpperCase(), width / 2, (height / 2) - (92 * ui) + rise);
    context.letterSpacing = '0px';
    context.fillStyle = '#fff';
    context.font = `800 ${76 * ui}px ${FONT}`;
    const titleLines = wrapLines(context, card.title || '', width * 0.72).map((words) => words.join(' '));
    titleLines.forEach((line, index) => context.fillText(line, width / 2, (height / 2) - (10 * ui) + rise + (((index * 86) - ((titleLines.length - 1) * 43)) * ui)));
    if (card.subtitle) {
      context.fillStyle = 'rgba(255, 255, 255, 0.72)';
      context.font = `500 ${34 * ui}px ${FONT}`;
      context.fillText(card.subtitle, width / 2, (height / 2) + rise + ((64 + ((titleLines.length - 1) * 43)) * ui));
    }
    context.restore();
  }

  // Subtitles highlight words as they are spoken.
  drawSubtitle(context, subtitle, outMs) {
    const { width, height } = this.layout;
    const { ui, project } = this;
    const fade = clamp(Math.min(outMs - subtitle.startMs, subtitle.endMs - outMs) / 140, 0, 1);
    const reserve = project.presenter ? (project.presenter.size + project.presenter.margin + (28 * ui)) : 60 * ui;
    context.save();
    context.globalAlpha = fade;
    context.font = `600 ${34 * ui}px ${FONT}`;
    const lines = wrapLines(context, subtitle.text, width - (reserve * 2) - (60 * ui)).slice(0, 2);
    const lineHeight = 44 * ui;
    const space = context.measureText(' ').width;
    const lineWidths = lines.map((words) => context.measureText(words.join(' ')).width);
    const boxWidth = Math.max(...lineWidths) + (56 * ui);
    const boxHeight = (lines.length * lineHeight) + (24 * ui);
    const boxY = height - boxHeight - (46 * ui);
    context.fillStyle = 'rgba(12, 8, 18, 0.8)';
    roundedRect(context, (width - boxWidth) / 2, boxY, boxWidth, boxHeight, 18 * ui);
    context.fill();
    const totalChars = subtitle.text.length;
    const spokenChars = clamp((outMs - subtitle.startMs) / Math.max(1, subtitle.endMs - subtitle.startMs), 0, 1) * totalChars;
    let seen = 0;
    context.textAlign = 'left';
    lines.forEach((words, lineIndex) => {
      let x = (width - lineWidths[lineIndex]) / 2;
      const y = boxY + ((lineIndex + 1) * lineHeight);
      for (const word of words) {
        context.fillStyle = seen <= spokenChars ? '#fff' : 'rgba(255, 255, 255, 0.52)';
        context.fillText(word, x, y);
        x += context.measureText(word).width + space;
        seen += word.length + 1;
      }
    });
    context.restore();
  }

  drawOverlays(context, outMs) {
    const { project, layout, ui } = this;
    const { width, height } = layout;
    const style = project.style;
    const sourceMs = this.sourceTime(outMs);
    const introMs = project.timeline?.introMs || 0;
    const outroFade = project.outro ? smoothstep(clamp((outMs - this.recordingEnd - 350) / 900, 0, 1)) : 0;

    const rate = rateAtSource(this.map, sourceMs);
    if (rate >= 1.5 && outMs > introMs && outMs < this.recordingEnd) {
      const label = `${rate >= 10 ? Math.round(rate) : Number(rate.toFixed(1))}×`;
      context.save();
      context.font = `700 ${24 * ui}px ${FONT}`;
      const icon = 26 * ui;
      const badgeWidth = context.measureText(label).width + icon + (42 * ui);
      const badgeHeight = 46 * ui;
      const x = width - badgeWidth - (36 * ui);
      const y = 32 * ui;
      context.fillStyle = 'rgba(12, 8, 18, 0.72)';
      roundedRect(context, x, y, badgeWidth, badgeHeight, badgeHeight / 2);
      context.fill();
      context.fillStyle = '#fff';
      for (const offset of [0, icon * 0.5]) {
        context.beginPath();
        context.moveTo(x + (18 * ui) + offset, y + (badgeHeight * 0.3));
        context.lineTo(x + (18 * ui) + offset + (icon * 0.5), y + (badgeHeight / 2));
        context.lineTo(x + (18 * ui) + offset, y + (badgeHeight * 0.7));
        context.closePath();
        context.fill();
      }
      context.textAlign = 'left';
      context.fillText(label, x + (26 * ui) + icon, y + (badgeHeight * 0.66));
      context.restore();
    }

    const subtitle = activeAt(project.subtitles, outMs);
    if (subtitle && project.subtitlesEnabled !== false) this.drawSubtitle(context, subtitle, outMs);

    this.drawCard(context, project.outro, outroFade, lerp(18, 0, easeOutCubic(outroFade)));

    if (introMs && outMs < introMs) {
      const alpha = 1 - smoothstep(clamp((outMs - (introMs - 750)) / 750, 0, 1));
      this.drawCard(context, project.intro, alpha, lerp(24, 0, easeOutCubic(clamp(outMs / 700, 0, 1))));
    }

    // The presenter is the final draw, above intro, outro, captions, and footage.
    if (this.presenter && project.presenter) {
      const { size, margin, enterMs = 0 } = project.presenter;
      const appear = easeOutCubic(clamp((outMs - enterMs) / 500, 0, 1));
      const swap = presenterSwapAt(project.presenter.swaps, outMs);
      this.presenter.draw(context, {
        x: lerp(width - margin - size, margin, swap),
        y: height - margin - size,
        size,
        tMs: outMs,
        mouth: mouthAt(project.voice, outMs),
        appear,
        accent: project.presenter.color || style.accent,
        lookSide: lerp(-1, 1, swap),
      });
    }

  }

  draw(context, outMs, { motionBlur = false } = {}) {
    if (motionBlur) this.drawBlurredScene(context, outMs);
    else this.drawScene(context, outMs);
    this.drawParallel(context, outMs);
    this.drawOverlays(context, outMs);
  }

  drawParallel(context, outMs) {
    const scene = this.project.parallel;
    if (!scene || outMs < scene.startMs || outMs > scene.endMs) return;
    const layers = this.source?.parallelLayers || [];
    if (layers.length !== (scene.cards?.length || 3)) return;
    const alpha = Math.min(smoothstep(clamp((outMs-scene.startMs)/550,0,1)),smoothstep(clamp((scene.endMs-outMs)/550,0,1)));
    const ui=this.ui;
    const width=this.layout.width;
    const sourceMs=Math.min(this.sourceTime(outMs),scene.freezeSourceMs ?? Infinity);
    const ready=outMs>=scene.readyMs;
    const workers=Object.values(scene.workers || {});
    const together=workers.length>1 && workers.every(worker=>sourceMs>=worker.firstWriteMs && sourceMs<worker.lastWriteMs);
    const realtime=sourceMs>=scene.realtimeStartMs && sourceMs<scene.realtimeEndMs;
    const elapsed=Math.max(0,Math.floor((sourceMs-scene.launchedSourceMs)/1000));
    context.save();
    context.globalAlpha=alpha;
    context.drawImage(this.backdrop,0,0);
    context.fillStyle='rgba(5,15,25,.24)';context.fillRect(0,0,width,this.layout.height);
    context.textAlign='center';
    context.fillStyle='#b4a0ff';context.font=`700 ${15*ui}px ${FONT}`;
    context.fillText(scene.eyebrow || 'ONE ACTION → THREE INDEPENDENT WORKERS',width/2,90*ui);
    context.fillStyle='#fff';context.font=`700 ${46*ui}px ${FONT}`;
    context.fillText(ready?(scene.readyTitle || 'Three applications. Ready for your review.'):together && scene.togetherTitle?scene.togetherTitle:(scene.workingTitle || 'Three workers. One action.'),width/2,154*ui);
    context.fillStyle='rgba(255,255,255,.70)';context.font=`400 ${19*ui}px ${FONT}`;
    const workingSubtitle=((realtime && scene.realtimeSubtitle) || scene.workingSubtitle || 'Independent background workers · Shared capture clock {elapsed}s · Time-lapse').replace('{elapsed}',String(elapsed));
    context.fillText(ready?(scene.readySubtitle || '18 fields filled across 3 applications · You review and submit'):workingSubtitle,width/2,198*ui);
    const names=scene.cards?.map(card=>card.name) || ['calfresh','wic','ihss'];
    const titles=scene.cards?.map(card=>card.title) || ['CalFresh','WIC','IHSS'];
    const gap=24*ui,margin=76*ui,cardW=(width-margin*2-gap*(names.length-1))/names.length,cardH=590*ui,top=255*ui;
    names.forEach((name,i)=>{
      const layer=layers.find(item=>item.name===name);const image=layer?.sequence.current(sourceMs);
      const x=margin+i*(cardW+gap);
      const rise=(1-alpha)*24*ui;
      context.save();context.translate(0,rise);
      context.shadowColor='rgba(0,0,0,.35)';context.shadowBlur=40*ui;context.shadowOffsetY=14*ui;
      context.fillStyle='#fff';roundedRect(context,x,top,cardW,cardH,15*ui);context.fill();
      context.shadowColor='transparent';
      context.save();roundedRect(context,x,top,cardW,cardH,15*ui);context.clip();
      context.fillStyle='#f1f3f8';context.fillRect(x,top,cardW,43*ui);
      ['#ff6c64','#ffbe44','#32c950'].forEach((color,j)=>{context.fillStyle=color;context.beginPath();context.arc(x+(18+j*15)*ui,top+21*ui,4.3*ui,0,Math.PI*2);context.fill()});
      context.fillStyle='#5a6679';context.font=`600 ${14*ui}px ${FONT}`;context.textAlign='center';context.fillText(titles[i]+' · Background tab',x+cardW/2,top+26*ui);
      if(image){
        // Crop to the actual form region; no pixels or values are recreated.
        const cropW=(scene.cropWidth || 740)*2,cropH=(scene.cropHeight || 720)*2,sx=Math.max(0,(image.width-cropW)/2),sy=0;
        context.drawImage(image,sx,sy,Math.min(cropW,image.width),Math.min(cropH,image.height),x,top+43*ui,cardW,cardH-43*ui);
      }
      context.restore();
      const phase=scene.workers?.[name];
      const writing=phase && sourceMs>=phase.firstWriteMs && sourceMs<phase.lastWriteMs;
      const entered=phase && sourceMs>=phase.lastWriteMs;
      const color=ready?'#b5f3cf':writing?'#b5f3cf':'#dad0ff';
      context.fillStyle=color;context.font=`600 ${18*ui}px ${FONT}`;context.textAlign='left';
      context.fillText(ready?(scene.cards?.[i]?.readyLabel || scene.readyCardLabel || '✓ Filled · Ready for your review'):writing?'Entering and checking answers':entered?'Known answers entered · Your decisions next':'Mapping + checking this application',x+10*ui,top+cardH+34*ui);
      if(!ready && !entered){
        // All lanes share source time. Activity indicates live workers, not fabricated input writes.
        const y=top+cardH+52*ui;
        context.fillStyle='rgba(218,208,255,.18)';roundedRect(context,x+10*ui,y,cardW-20*ui,5*ui,2.5*ui);context.fill();
        const laneW=(cardW-20*ui)*.22;
        const phaseT=((sourceMs/2200)+(i/3))%1;
        const laneX=x+10*ui+phaseT*((cardW-20*ui)-laneW);
        context.fillStyle=color;roundedRect(context,laneX,y,laneW,5*ui,2.5*ui);context.fill();
      }
      context.restore();
    });
    context.fillStyle='rgba(255,255,255,.55)';context.font=`400 ${16*ui}px ${FONT}`;context.textAlign='center';
    context.fillText(scene.footer || 'Actual background tab captures · Synthetic local forms',width/2,935*ui);
    context.restore();
  }
}
