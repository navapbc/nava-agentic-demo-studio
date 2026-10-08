import { describeMusic, resolveMusicSettings } from './music-plan.mjs';
import {
  cameraAt,
  clamp,
  createTimeMap,
  layoutFor,
  recordingToScreen,
  sourceToOutput,
  viewWindow,
} from './timeline.mjs';

export const TRACE_SCHEMA = 'nava.demo-trace.v1';
export const PROJECT_SCHEMA = 'nava.demo-project.v1';

// The trace contract (AGENTS.md): timestamps, normalized pointer coordinates,
// event kinds, redacted step labels, and script-authored narration. Every other
// field is rejected so a typed value can never ride along by accident.
const EVENT_FIELDS = {
  click: ['x', 'y', 'w', 'h', 'label'],
  milestone: ['label'],
  pause: ['endMs', 'label'],
  move: ['endMs', 'x', 'y', 'cursor', 'ease'],
  type: ['endMs', 'x', 'y', 'w', 'h', 'label'],
  scroll: ['endMs', 'label'],
  wait: ['endMs', 'label'],
  narration: ['endMs', 'text', 'clip'],
  focus: ['endMs', 'x', 'y', 'w', 'h', 'label'],
};
const POINTER_KINDS = new Set(['click', 'move', 'type']);
const FOCUS_KINDS = new Set(['click', 'type', 'focus']);
const CURSOR_KINDS = new Set(['pointer', 'text']);
const EASES = new Set(['in', 'out', 'linear']);
const MAX_LABEL_LENGTH = 140;

const DEFAULTS = {
  output: { width: 1920, height: 1080, fps: 60 },
  zoom: { scale: 1.8, minScale: 1.45, maxScale: 2.1, targetShare: 0.5, sessionGapMs: 3200, leadMs: 1000, holdMs: 900, releaseMs: 900, minPanMs: 520 },
  speed: { minIdleMs: 3000, maxRate: 8, msPerOutputSecond: 1500, rampMs: 450 },
  style: { background: 'nava', padding: 72, radius: 14, accent: '#e05bbf' },
  presenter: { size: 300, margin: 40 },
  introMs: 2400,
  outroMs: 2200,
};

function withoutEmpty(value) {
  return Object.fromEntries(Object.entries(value || {}).filter(([, entry]) => entry !== undefined && entry !== null));
}

function fail(message) {
  throw new Error(message);
}

function isUnit(value) {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

export function validateTrace(value) {
  if (!value || value.schema !== TRACE_SCHEMA) fail(`Expected a ${TRACE_SCHEMA} trace.`);
  if (!Number.isFinite(value.durationMs) || value.durationMs <= 0) fail('durationMs must be positive.');
  if (!value.viewport || !(value.viewport.width > 0) || !(value.viewport.height > 0)) fail('A positive viewport is required.');
  const events = Array.isArray(value.events) ? value.events : [];
  let previous = -1;
  events.forEach((event, index) => {
    if (!Number.isFinite(event.atMs) || event.atMs < previous || event.atMs > value.durationMs) fail('Events must be ordered within the recording.');
    const fields = EVENT_FIELDS[event.kind];
    if (!fields) fail(`Unsupported event kind: ${event.kind}`);
    for (const key of Object.keys(event)) {
      if (key !== 'atMs' && key !== 'kind' && !fields.includes(key)) {
        fail(`Event ${index} (${event.kind}) has field "${key}", which the trace contract does not allow.`);
      }
    }
    if ((POINTER_KINDS.has(event.kind) || event.kind === 'focus') && !(isUnit(event.x) && isUnit(event.y))) fail('Click coordinates must be normalized from 0 to 1.');
    if (('w' in event || 'h' in event) && !(isUnit(event.w) && isUnit(event.h))) fail(`Event ${index} target size must be normalized from 0 to 1.`);
    if ('cursor' in event && !CURSOR_KINDS.has(event.cursor)) fail(`Event ${index} cursor must be one of ${[...CURSOR_KINDS].join(', ')}.`);
    if ('ease' in event && !EASES.has(event.ease)) fail(`Event ${index} ease must be one of ${[...EASES].join(', ')}.`);
    if ('endMs' in event && !(Number.isFinite(event.endMs) && event.endMs >= event.atMs && event.endMs <= value.durationMs + 1)) {
      fail(`Event ${index} (${event.kind}) must end within the recording.`);
    }
    if (event.label !== undefined && (typeof event.label !== 'string' || event.label.length > MAX_LABEL_LENGTH)) {
      fail(`Event ${index} label must be a string of at most ${MAX_LABEL_LENGTH} characters.`);
    }
    if (event.kind === 'narration' && (typeof event.text !== 'string' || !event.text.trim())) fail(`Narration event ${index} needs text.`);
    previous = event.atMs;
  });
  return { ...value, events };
}

function protectedWindowsFor(events, durationMs) {
  const windows = [];
  for (const event of events) {
    // Waits and camera focus holds are exactly the spans worth fast-forwarding.
    if (event.kind === 'wait' || event.kind === 'focus') continue;
    const endMs = event.endMs ?? event.atMs;
    const before = event.endMs === undefined ? 800 : 300;
    const after = event.endMs === undefined ? 1500 : 600;
    windows.push({ startMs: Math.max(0, event.atMs - before), endMs: Math.min(durationMs, endMs + after) });
  }
  return windows;
}

// Idle, unprotected spans are compressed; each compressed span ramps in and out
// so speed changes read as a deliberate fast-forward rather than a jump cut.
export function planSpeed(events, durationMs, options = {}) {
  const settings = { ...DEFAULTS.speed, ...options };
  const cuts = settings.cuts ?? [];
  if (!Array.isArray(cuts)) fail('speed.cuts must be a list of source-time ranges.');
  let previousEnd = 0;
  for (const cut of cuts) {
    if (!cut || !Number.isFinite(cut.startMs) || !Number.isFinite(cut.endMs)
      || cut.startMs < previousEnd || cut.endMs <= cut.startMs || cut.endMs > durationMs) {
      fail('speed.cuts must be ordered, non-overlapping, positive ranges within the recording.');
    }
    for (const event of events) {
      if (['wait', 'focus', 'milestone'].includes(event.kind)) continue;
      const end = event.endMs ?? event.atMs;
      const overlaps = end > event.atMs
        ? event.atMs < cut.endMs && end > cut.startMs
        : event.atMs >= cut.startMs && event.atMs < cut.endMs;
      if (overlaps) fail(`speed.cuts overlaps a protected ${event.kind} event at ${event.atMs}ms.`);
    }
    previousEnd = cut.endMs;
  }
  const windows = protectedWindowsFor(events, durationMs);
  const boundaries = [...new Set([
    0,
    durationMs,
    ...cuts.flatMap((cut) => [cut.startMs, cut.endMs]),
    ...events.map((event) => event.atMs),
    ...windows.flatMap((window) => [window.startMs, window.endMs]),
  ])].sort((left, right) => left - right);
  const raw = [];
  for (let index = 1; index < boundaries.length; index += 1) {
    const startMs = boundaries[index - 1];
    const endMs = boundaries[index];
    const midpoint = (startMs + endMs) / 2;
    if (cuts.some((cut) => cut.startMs <= midpoint && cut.endMs >= midpoint)) {
      raw.push({ startMs, endMs, rate: 1, cut: true });
      continue;
    }
    const isProtected = windows.some((window) => window.startMs <= midpoint && window.endMs >= midpoint);
    const idle = !isProtected && endMs - startMs >= settings.minIdleMs;
    const rate = idle ? clamp((endMs - startMs) / settings.msPerOutputSecond, 2, settings.maxRate) : 1;
    raw.push({ startMs, endMs, rate: Number(rate.toFixed(2)) });
  }
  const spans = [];
  for (const span of raw) {
    if (span.cut || span.rate === 1) {
      spans.push(span);
      continue;
    }
    const ramp = Math.min(settings.rampMs, (span.endMs - span.startMs) * 0.15);
    const midRate = Number(((1 + span.rate) / 2).toFixed(2));
    spans.push({ startMs: span.startMs, endMs: span.startMs + ramp, rate: midRate });
    spans.push({ startMs: span.startMs + ramp, endMs: span.endMs - ramp, rate: span.rate });
    spans.push({ startMs: span.endMs - ramp, endMs: span.endMs, rate: midRate });
  }
  return spans.reduce((merged, span) => {
    const last = merged[merged.length - 1];
    if (last && Boolean(last.cut) === Boolean(span.cut) && last.rate === span.rate && last.endMs === span.startMs) last.endMs = span.endMs;
    else if (span.endMs > span.startMs) merged.push({ ...span });
    return merged;
  }, []);
}

// Camera keyframes are planned in output time so zoom transitions keep a fixed
// on-screen duration even when the page underneath is being fast-forwarded.
export function planCamera(points, outDurationMs, options = {}) {
  const settings = { ...DEFAULTS.zoom, ...options };
  const keys = [{ outMs: 0, x: 0.5, y: 0.5, scale: 1 }];
  const overview = (outMs) => ({ outMs, x: 0.5, y: 0.5, scale: 1 });
  const sessions = [];
  for (const point of points) {
    const current = sessions[sessions.length - 1];
    if (current && point.outMs - current[current.length - 1].outEndMs <= settings.sessionGapMs) current.push(point);
    else sessions.push([point]);
  }
  // Zoom depth adapts to what is being clicked: small buttons get a closer
  // look than wide form rows. One depth per session avoids zoom pumping.
  const depthFor = (session) => {
    const sized = session.filter((point) => Number.isFinite(point.w));
    if (!sized.length) return settings.scale;
    const depths = sized.map((point) => clamp(settings.targetShare / Math.max(point.w, 0.16), settings.minScale, settings.maxScale)).sort((a, b) => a - b);
    return depths[Math.floor(depths.length / 2)];
  };
  for (const session of sessions) {
    const [first] = session;
    const zoom = depthFor(session);
    keys.push(overview(first.outMs - settings.leadMs));
    keys.push({ outMs: first.outMs - 150, x: first.x, y: first.y, scale: zoom });
    for (let index = 1; index < session.length; index += 1) {
      const previous = session[index - 1];
      const point = session[index];
      const arriveMs = point.outMs - 120;
      const previousArrival = keys[keys.length - 1].outMs;
      // Hold on the previous target until its action ends, but always leave at
      // least minPanMs for the pan so the camera glides instead of snapping.
      const departMs = Math.min(Math.max(previous.outEndMs + 250, point.outMs - 800), arriveMs - settings.minPanMs);
      const panFrom = Math.max(departMs, previousArrival);
      if (departMs > previousArrival + 40) keys.push({ outMs: departMs, x: previous.x, y: previous.y, scale: zoom });
      if (Math.hypot(point.x - previous.x, point.y - previous.y) > 0.45) {
        keys.push({ outMs: (panFrom + arriveMs) / 2, x: (point.x + previous.x) / 2, y: (point.y + previous.y) / 2, scale: Math.min(zoom, 1.3) });
      }
      keys.push({ outMs: arriveMs, x: point.x, y: point.y, scale: zoom });
    }
    const last = session[session.length - 1];
    keys.push({ outMs: last.outEndMs + settings.holdMs, x: last.x, y: last.y, scale: zoom });
    keys.push(overview(last.outEndMs + settings.holdMs + settings.releaseMs));
  }
  keys.push(overview(outDurationMs));
  const ordered = [];
  for (const key of keys) {
    const outMs = clamp(Math.round(key.outMs), 0, outDurationMs);
    while (ordered.length && ordered[ordered.length - 1].outMs >= outMs) ordered.pop();
    ordered.push({ outMs, x: Number(key.x.toFixed(4)), y: Number(key.y.toFixed(4)), scale: Number(key.scale.toFixed(3)) });
  }
  return ordered;
}

// Moves the presenter to the opposite corner whenever the action on screen
// would land underneath it.
export function planPresenterSwaps(project, points) {
  const layout = layoutFor(project);
  const { size, margin } = project.presenter;
  const reach = 70;
  const box = {
    left: layout.width - margin - size - reach,
    top: layout.height - margin - size - reach,
  };
  const segments = [];
  for (const point of points) {
    for (const outMs of [point.outMs, point.outEndMs]) {
      const window = viewWindow(layout, cameraAt(project.camera, outMs));
      const screen = recordingToScreen(layout, window, point.x, point.y);
      if (screen.x < box.left || screen.y < box.top) continue;
      const segment = { startMs: Math.max(0, point.outMs - 1400), endMs: point.outEndMs + 1600 };
      const last = segments[segments.length - 1];
      if (last && segment.startMs - last.endMs < 800) last.endMs = Math.max(last.endMs, segment.endMs);
      else segments.push(segment);
      break;
    }
  }
  return segments;
}

export function chunkCaption(text, maxChars = 64) {
  const words = text.trim().split(/\s+/);
  const chunks = [];
  let current = '';
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxChars && current) {
      chunks.push(current);
      current = word;
    } else {
      current = next;
    }
    if (/[.!?;:]$/.test(word) && current.length > maxChars * 0.45) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function buildProject(input, options = {}) {
  const trace = validateTrace(input);
  const { events } = trace;
  const durationMs = trace.durationMs;
  const settings = options.settings || {};
  const output = { ...DEFAULTS.output, ...(settings.output || trace.output) };
  const intro = settings.intro === false ? null : { title: trace.title || 'Product demo', ...(settings.intro || {}) };
  const introMs = intro ? (settings.introMs ?? DEFAULTS.introMs) : 0;
  const outroMs = settings.outroMs ?? DEFAULTS.outroMs;

  // The cached audio is authoritative when a hand-authored trace has a shorter
  // narration end. A cut must not truncate the actual spoken clip.
  const speedEvents = events.map(event => {
    if (event.kind !== 'narration') return event;
    const clipEnd = event.atMs + (options.voice?.clips?.[event.clip]?.durationMs ?? 0);
    return clipEnd > (event.endMs ?? event.atMs) ? { ...event, endMs: clipEnd } : event;
  });
  const speed = planSpeed(speedEvents, durationMs, settings.speed);
  const map = createTimeMap(speed, durationMs);
  const toOut = (sourceMs) => Math.round(introMs + sourceToOutput(map, sourceMs));
  const outDurationMs = Math.round(introMs + map.outDurationMs + outroMs);

  const points = events
    .filter((event) => FOCUS_KINDS.has(event.kind))
    .map((event) => ({ x: event.x, y: event.y, w: event.w, h: event.h, outMs: toOut(event.atMs), outEndMs: toOut(event.endMs ?? event.atMs) }));
  const camera = planCamera(points, outDurationMs, settings.zoom);

  const voiceManifest = options.voice?.clips || {};
  const voice = events.filter((event) => event.kind === 'narration').map((event) => {
    const clip = voiceManifest[event.clip] || {};
    const clipDurationMs = clip.durationMs ?? ((event.endMs ?? event.atMs) - event.atMs);
    const outMs = toOut(event.atMs);
    return {
      text: event.text,
      src: clip.src || null,
      atMs: event.atMs,
      outMs,
      durationMs: clipDurationMs,
      outEndMs: outMs + clipDurationMs,
      envelopeHz: clip.envelopeHz || 60,
      envelope: clip.envelope || [],
      mouth: clip.mouth || null,
    };
  });

  const labelled = events.filter((event) => event.label && event.kind !== 'move');
  const subtitles = voice.length
    ? voice.flatMap((line) => {
      const chunks = chunkCaption(line.text);
      const totalChars = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
      let cursor = line.outMs;
      return chunks.map((chunk) => {
        const length = line.durationMs * (chunk.length / totalChars);
        const subtitle = { startMs: Math.round(cursor), endMs: Math.round(cursor + length), text: chunk };
        cursor += length;
        return subtitle;
      });
    })
    : labelled.map((event) => ({
      startMs: toOut(Math.max(0, event.atMs - 150)),
      endMs: toOut(Math.min(durationMs, event.atMs + (event.kind === 'milestone' ? 2600 : 1800))),
      text: event.label,
    }));

  // Clicks and typing keep the shape the pointer arrived with; a move always
  // sets its own (including back to the default arrow).
  let arrivedWith;
  const moves = events.filter((event) => POINTER_KINDS.has(event.kind)).map((event) => {
    if (event.kind === 'move') arrivedWith = event.cursor;
    const cursor = event.kind === 'move' ? event.cursor : arrivedWith;
    return {
      atMs: event.atMs,
      endMs: event.kind === 'click' ? event.atMs : event.endMs,
      x: event.x,
      y: event.y,
      ...(cursor ? { cursor } : {}),
      ...(event.ease ? { ease: event.ease } : {}),
    };
  });
  const frame = settings.frame === false ? null : {
    // Page captures get drawn browser chrome; screen captures already show the
    // real window.
    kind: (trace.source?.kind === 'frames' && trace.source?.origin !== 'screen' ? 'browser' : 'none'),
    ...(settings.frame || {}),
  };

  const presenterSettings = withoutEmpty(settings.presenter);
  const presenterKind = presenterSettings.kind || 'portrait';
  const presenterImage = typeof trace.presenter === 'string' ? trace.presenter : trace.presenter?.image;
  const presenter = (presenterKind === 'orb' || presenterImage) ? {
    kind: presenterKind,
    ...(presenterImage ? { image: presenterImage } : {}),
    rig: presenterKind === 'orb' ? null : (options.rig || null),
    size: Math.round(output.height * (DEFAULTS.presenter.size / 1080)),
    margin: Math.round(output.height * (DEFAULTS.presenter.margin / 1080)),
    ...presenterSettings,
    enterMs: Math.max(0, introMs - 300),
    swaps: [],
  } : null;

  const project = {
    schema: PROJECT_SCHEMA,
    title: trace.title || 'Product demo',
    durationMs,
    viewport: trace.viewport,
    rawVideo: trace.rawVideo,
    source: trace.source || (trace.rawVideo ? { kind: 'video', src: trace.rawVideo } : null),
    output,
    style: { ...DEFAULTS.style, ...(settings.style || {}), frame },
    timeline: { introMs, outroMs, sourceDurationMs: durationMs, outDurationMs },
    intro,
    outro: settings.outro || null,
    events,
    speed,
    camera,
    cursor: { moves, clicks: events.filter((event) => event.kind === 'click').map(({ atMs, x, y }) => ({ atMs, x, y })) },
    subtitles,
    voice,
    // Camera holds on something an agent is working on; the camera does not
    // follow the (idle) pointer while one is active.
    focusHolds: events.filter((event) => event.kind === 'focus').map((event) => ({ startMs: toOut(event.atMs), endMs: toOut(event.endMs) })),
    sfx: [
      ...events.filter((event) => event.kind === 'click').map((event) => ({ kind: 'click', outMs: toOut(event.atMs), x: event.x })),
      ...events.filter((event) => event.kind === 'type').map((event) => ({ kind: 'typing', outMs: toOut(event.atMs), outEndMs: toOut(event.endMs), x: event.x })),
    ].sort((left, right) => left.outMs - right.outMs),
    music: settings.music === false ? null : resolveMusicSettings(settings.music || {}),
    presenter,
    // Kept for consumers of the original v1 project shape.
    zooms: events.filter((event) => event.kind === 'click').map((event) => ({
      startMs: Math.max(0, event.atMs - 350),
      peakMs: event.atMs + 180,
      endMs: Math.min(durationMs, event.atMs + 1450),
      x: event.x,
      y: event.y,
      scale: 1.58,
    })),
    captions: labelled.map((event) => ({
      startMs: Math.max(0, event.atMs - 150),
      endMs: Math.min(durationMs, event.atMs + (event.kind === 'milestone' ? 2600 : 1800)),
      text: event.label,
    })),
    narration: (voice.length ? voice.map((line) => ({ atMs: line.atMs, text: line.text })) : labelled.map((event) => ({ atMs: Math.max(0, event.atMs - 150), text: event.label }))),
    audio: {
      clickSound: true,
      backgroundMusic: settings.music === false ? null : describeMusic(resolveMusicSettings(settings.music || {})),
      voiceover: voice.some((line) => line.src) ? (options.voice?.provider || 'say') : null,
      duckingDb: settings.duckingDb ?? -10,
    },
  };
  if (project.presenter) project.presenter.swaps = planPresenterSwaps(project, points);
  return project;
}
