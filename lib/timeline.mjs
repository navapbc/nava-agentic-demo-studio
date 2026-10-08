// Pure timing and framing math shared by the Node planner and the browser
// compositor. Nothing in this module touches the DOM, the file system, or time.

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
export const lerp = (from, to, amount) => from + ((to - from) * amount);
export const easeInOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - ((((-2 * t) + 2) ** 3) / 2));
export const easeOutCubic = (t) => 1 - ((1 - t) ** 3);
export const smoothstep = (t) => t * t * (3 - (2 * t));

function lastIndexAtOrBefore(items, value, key) {
  let low = 0;
  let high = items.length - 1;
  if (high < 0 || items[0][key] > value) return -1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (items[middle][key] <= value) low = middle;
    else high = middle - 1;
  }
  return low;
}

// Speed spans cover the source recording end to end. The time map converts
// between source time (what the recorder saw) and output time (what the viewer
// sees after idle spans are compressed or cut). Cuts have zero output duration
// and remain explicit JSON data; Infinity would serialize to null.
export function createTimeMap(speed, sourceDurationMs) {
  const spans = speed?.length ? speed : [{ startMs: 0, endMs: sourceDurationMs, rate: 1 }];
  let outMs = 0;
  const segments = spans.map((span) => {
    const rate = span.rate || 1;
    const segment = { startMs: span.startMs, endMs: span.endMs, rate, ...(span.cut ? { cut: true } : {}), outStartMs: outMs };
    if (!span.cut) outMs += (span.endMs - span.startMs) / rate;
    segment.outEndMs = outMs;
    return segment;
  });
  return { segments, sourceDurationMs, outDurationMs: outMs };
}

export function sourceToOutput(map, sourceMs) {
  const value = clamp(sourceMs, 0, map.sourceDurationMs);
  const segment = map.segments[Math.max(0, lastIndexAtOrBefore(map.segments, value, 'startMs'))];
  return segment.cut ? segment.outStartMs : segment.outStartMs + ((value - segment.startMs) / segment.rate);
}

export function outputToSource(map, outMs) {
  const value = clamp(outMs, 0, map.outDurationMs);
  const segment = map.segments[Math.max(0, lastIndexAtOrBefore(map.segments, value, 'outStartMs'))];
  // At a cut boundary, binary search chooses the following retained span.
  // A trailing cut has no following span, so it resolves to the source end.
  return segment.cut ? segment.endMs : Math.min(segment.endMs, segment.startMs + ((value - segment.outStartMs) * segment.rate));
}

export function rateAtSource(map, sourceMs) {
  const index = lastIndexAtOrBefore(map.segments, sourceMs, 'startMs');
  return index < 0 ? 1 : map.segments[index].rate;
}

// Project output time includes an intro card before the recording starts and an
// outro hold after it ends; both show the first or last source frame.
export function projectSourceTime(project, map, outMs) {
  return outputToSource(map, outMs - (project.timeline?.introMs || 0));
}

// The recording sits in a window (optionally with browser chrome) centered on
// the backdrop. `inset` is the recording itself; `frame` is the whole window.
export function layoutFor(project) {
  const width = project.output?.width || 1920;
  const height = project.output?.height || 1080;
  const viewport = project.viewport;
  const padding = project.style?.padding ?? Math.round(height * 0.066);
  const chrome = project.style?.frame?.kind === 'browser' ? 40 : 0;
  const scale = Math.min((width - (padding * 2)) / viewport.width, (height - (padding * 2)) / (viewport.height + chrome));
  const insetWidth = viewport.width * scale;
  const insetHeight = viewport.height * scale;
  const bar = chrome * scale;
  const top = (height - insetHeight - bar) / 2;
  return {
    width,
    height,
    contentScale: scale,
    bar,
    frame: { x: (width - insetWidth) / 2, y: top, w: insetWidth, h: insetHeight + bar },
    inset: { x: (width - insetWidth) / 2, y: top + bar, w: insetWidth, h: insetHeight },
  };
}

// Camera keyframes are in output time. Each channel (x, y, log scale) is a
// monotone cubic (Fritsch-Carlson) spline: holds stay perfectly still, single
// moves ease in and out, and chained pans glide through intermediate targets
// instead of stopping at each one. Scale is interpolated in log space so a
// zoom from 1x to 2x feels as even as a zoom from 2x to 4x.
function pchipSlope(before, after, hBefore, hAfter) {
  if (before === null || after === null || before * after <= 0) return 0;
  const w1 = (2 * hAfter) + hBefore;
  const w2 = hAfter + (2 * hBefore);
  return (w1 + w2) / ((w1 / before) + (w2 / after));
}

export function cameraAt(keyframes, outMs) {
  if (!keyframes?.length) return { x: 0.5, y: 0.5, scale: 1 };
  const index = lastIndexAtOrBefore(keyframes, outMs, 'outMs');
  if (index < 0) return { ...keyframes[0] };
  if (index >= keyframes.length - 1) return { ...keyframes[keyframes.length - 1] };
  const k0 = keyframes[index];
  const k1 = keyframes[index + 1];
  const previous = keyframes[index - 1];
  const next = keyframes[index + 2];
  const h = Math.max(1, k1.outMs - k0.outMs);
  const hBefore = previous ? Math.max(1, k0.outMs - previous.outMs) : 1;
  const hAfter = next ? Math.max(1, next.outMs - k1.outMs) : 1;
  const s = clamp((outMs - k0.outMs) / h, 0, 1);
  const h00 = (2 * s * s * s) - (3 * s * s) + 1;
  const h10 = (s * s * s) - (2 * s * s) + s;
  const h01 = (-2 * s * s * s) + (3 * s * s);
  const h11 = (s * s * s) - (s * s);
  const channel = (read) => {
    const v0 = read(k0);
    const v1 = read(k1);
    const secant = (v1 - v0) / h;
    const before = previous ? (v0 - read(previous)) / hBefore : null;
    const after = next ? (read(next) - v1) / hAfter : null;
    const m0 = pchipSlope(before, secant, hBefore, h);
    const m1 = pchipSlope(secant, after, h, hAfter);
    return (h00 * v0) + (h10 * h * m0) + (h01 * v1) + (h11 * h * m1);
  };
  return { x: channel((key) => key.x), y: channel((key) => key.y), scale: Math.exp(channel((key) => Math.log(key.scale))) };
}

// The visible window over the composed scene (backdrop plus inset recording).
// As the camera zooms in, the window is progressively confined to the inset so
// a fully zoomed view never shows the backdrop, the way Screen Studio frames it.
export function viewWindow(layout, camera, follow = null) {
  const { width, height, inset } = layout;
  const scale = Math.max(1, camera.scale);
  const windowWidth = width / scale;
  const windowHeight = height / scale;
  const fillScale = Math.max(width / inset.w, height / inset.h);
  const confinement = fillScale > 1 ? clamp((scale - 1) / (fillScale - 1), 0, 1) : 1;
  const bounds = {
    left: lerp(0, inset.x, confinement),
    top: lerp(0, inset.y, confinement),
    right: lerp(width, inset.x + inset.w, confinement),
    bottom: lerp(height, inset.y + inset.h, confinement),
  };
  let focusX = inset.x + (camera.x * inset.w);
  let focusY = inset.y + (camera.y * inset.h);
  // While zoomed, keep the cursor inside a comfort margin of the view so the
  // camera follows the pointer the way Screen Studio does.
  if (follow && scale > 1.05) {
    const followX = inset.x + (follow.x * inset.w);
    const followY = inset.y + (follow.y * inset.h);
    const marginX = windowWidth * 0.2;
    const marginY = windowHeight * 0.2;
    const pull = clamp((scale - 1.05) / 0.25, 0, 1);
    const overshootX = followX - clamp(followX, focusX - (windowWidth / 2) + marginX, focusX + (windowWidth / 2) - marginX);
    const overshootY = followY - clamp(followY, focusY - (windowHeight / 2) + marginY, focusY + (windowHeight / 2) - marginY);
    focusX += pull * overshootX;
    focusY += pull * overshootY;
  }
  const centerX = bounds.right - bounds.left <= windowWidth
    ? (bounds.left + bounds.right) / 2
    : clamp(focusX, bounds.left + (windowWidth / 2), bounds.right - (windowWidth / 2));
  const centerY = bounds.bottom - bounds.top <= windowHeight
    ? (bounds.top + bounds.bottom) / 2
    : clamp(focusY, bounds.top + (windowHeight / 2), bounds.bottom - (windowHeight / 2));
  return { x: centerX - (windowWidth / 2), y: centerY - (windowHeight / 2), w: windowWidth, h: windowHeight, scale };
}

export function recordingToScreen(layout, window, x, y) {
  const sceneX = layout.inset.x + (x * layout.inset.w);
  const sceneY = layout.inset.y + (y * layout.inset.h);
  return { x: (sceneX - window.x) * window.scale, y: (sceneY - window.y) * window.scale };
}

// Cursor moves are in source time so the drawn pointer stays in sync with the
// hover states the page actually rendered. `kind` switches to the target's
// cursor (pointer, text) as the pointer arrives over it.
export function cursorAt(moves, sourceMs) {
  if (!moves?.length) return null;
  const index = lastIndexAtOrBefore(moves, sourceMs, 'atMs');
  if (index < 0) return { x: moves[0].x, y: moves[0].y, kind: moves[0].cursor || 'default' };
  const move = moves[index];
  const from = index > 0 ? moves[index - 1] : move;
  const span = move.endMs - move.atMs;
  const progress = span > 0 ? clamp((sourceMs - move.atMs) / span, 0, 1) : 1;
  const kind = (progress >= 0.7 ? move.cursor : from.cursor) || 'default';
  if (progress >= 1) return { x: move.x, y: move.y, kind };
  const eased = { in: progress * progress, out: 1 - ((1 - progress) ** 2), linear: progress }[move.ease] ?? easeInOutCubic(progress);
  return { x: lerp(from.x, move.x, eased), y: lerp(from.y, move.y, eased), kind };
}

// Hides the cursor after it has been idle for `idleMs`, and brings it back just
// before the next move.
export function cursorVisibility(moves, sourceMs, idleMs = 2200) {
  if (!moves?.length) return 0;
  const index = lastIndexAtOrBefore(moves, sourceMs, 'atMs');
  if (index < 0) return 1;
  const idle = sourceMs - Math.max(moves[index].endMs, moves[index].atMs);
  const fading = 1 - smoothstep(clamp((idle - idleMs) / 350, 0, 1));
  const next = moves[index + 1];
  const returning = next ? smoothstep(clamp((sourceMs - (next.atMs - 250)) / 250, 0, 1)) : 0;
  return Math.max(fading, returning);
}

export function activeAt(items, atMs, startKey = 'startMs', endKey = 'endMs') {
  if (!items?.length) return undefined;
  const index = lastIndexAtOrBefore(items, atMs, startKey);
  for (let cursor = index; cursor >= 0 && cursor > index - 4; cursor -= 1) {
    if (items[cursor][endKey] >= atMs) return items[cursor];
  }
  return undefined;
}

// 0 keeps the presenter in its home corner, 1 moves it to the opposite corner.
export function presenterSwapAt(segments, outMs, transitionMs = 450) {
  let value = 0;
  for (const segment of segments || []) {
    const entering = clamp((outMs - segment.startMs) / transitionMs, 0, 1);
    const leaving = clamp((segment.endMs - outMs) / transitionMs, 0, 1);
    value = Math.max(value, Math.min(entering, leaving));
  }
  return smoothstep(value);
}

// Presenter mouth state from a clip's audio-driven track. Lips lead the sound
// by about 50 ms, as they do in real speech; `nod` is a half-sine response to
// recent stressed-syllable onsets.
export function mouthAt(clips, outMs, leadMs = 50) {
  const at = outMs + leadMs;
  const clip = activeAt(clips, at, 'outMs', 'outEndMs');
  const speaking = voiceLevelAt(clips, outMs);
  if (!clip) return { open: 0, wide: 0, nod: 0, speaking };
  const track = clip.mouth || { hz: clip.envelopeHz || 60, open: clip.envelope || [] };
  const hz = track.hz || 60;
  const position = ((at - clip.outMs) / 1000) * hz;
  const sample = (values) => {
    if (!values?.length) return 0;
    const index = Math.floor(position);
    const from = values[clamp(index, 0, values.length - 1)];
    const to = values[clamp(index + 1, 0, values.length - 1)];
    return lerp(from, to, position - index) / 100;
  };
  let nod = 0;
  const accents = track.accent || [];
  for (let back = 0; back < hz * 0.5; back += 1) {
    const index = Math.floor(position) - back;
    if (index < 0) break;
    if (!accents[index]) continue;
    const tau = back / hz;
    nod += (accents[index] / 100) * Math.sin(Math.PI * (tau / 0.5)) * Math.exp(-tau / 0.35);
  }
  return { open: sample(track.open), wide: sample(track.wide), nod: clamp(nod, 0, 1), speaking };
}

// Voice level drives the presenter's speaking glow. A short look-back window keeps the
// mouth from flickering frame to frame while staying deterministic under seek.
export function voiceLevelAt(clips, outMs, windowMs = 70) {
  const clip = activeAt(clips, outMs, 'outMs', 'outEndMs');
  if (!clip?.envelope?.length) return 0;
  const hz = clip.envelopeHz || 60;
  const position = ((outMs - clip.outMs) / 1000) * hz;
  const reach = Math.max(1, Math.round((windowMs / 1000) * hz));
  let total = 0;
  let weights = 0;
  for (let offset = 0; offset <= reach; offset += 1) {
    const sample = Math.floor(position) - offset;
    if (sample < 0 || sample >= clip.envelope.length) continue;
    const weight = reach + 1 - offset;
    total += (clip.envelope[sample] / 100) * weight;
    weights += weight;
  }
  return weights ? total / weights : 0;
}
// Background tabs begin at different points on the shared recording clock.
// Never return a frame captured after the requested time.
export function frameIndexAt(frames, sourceMs) {
  if (!frames.length || sourceMs < frames[0].t) return -1;
  let low = 0;
  let high = frames.length - 1;
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if (frames[middle].t <= sourceMs) low = middle;
    else high = middle - 1;
  }
  return low;
}
