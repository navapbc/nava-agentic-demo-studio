// Pure music planning shared by the Node planner and the browser mixer: the
// style registry (tempo, harmony, phrasing), music settings, tempo alignment,
// and the bar-by-bar arrangement that follows a project's timeline. Nothing in
// this module touches Web Audio, the DOM, or the clock, so the plan for a
// project is the same in the preview, the export, and the tests.

import { clamp, createTimeMap, sourceToOutput } from './timeline.mjs';

export const DEFAULT_MUSIC_STYLE = 'warm-pop';
export const DEFAULT_MUSIC_VOLUME = 0.7;
export const DEFAULT_MUSIC_SEED = 7;
export const BEATS_PER_BAR = 4;
// Generated music may drift this far from a style's tempo to land the reveal
// and the outro on bar lines.
export const TEMPO_TOLERANCE = 0.08;
// The final chord needs at least this long to ring out before the video ends.
const MIN_TAIL_S = 1.2;
// Groove-section RMS of every generated style at volume 1, before the mix
// limiter. User music files are loudness-matched to it, so `volume` means the
// same thing for a file as for a generated style.
export const MUSIC_REFERENCE_DB = -21;
export const MUSIC_REFERENCE_RMS = 10 ** (MUSIC_REFERENCE_DB / 20);

const chord = (name, root, notes) => ({ name, root, notes });

// Harmony is authored as MIDI notes: `root` feeds the bass, `notes` the
// chords. `tonic` is the chord the outro resolves to and `cadence` the chord
// that leads into it.
export const MUSIC_STYLES = {
  'warm-pop': {
    label: 'Warm pop',
    description: 'Soft IV-vi-I-V pads, plucked arpeggios, light drums',
    bpm: 92,
    phraseBars: 8,
    barsPerChord: 1,
    swing8: 0.5,
    swing16: 0.5,
    drums: true,
    phraseRisers: false,
    progression: [
      chord('Gmaj7', 43, [55, 59, 62, 66]),
      chord('Bm', 47, [54, 57, 59, 62]),
      chord('Dadd9', 50, [54, 57, 62, 64]),
      chord('A', 45, [52, 57, 61, 64]),
    ],
    tonic: 2,
    cadence: 3,
  },
  lofi: {
    label: 'Lo-fi',
    description: 'Jazzy ii-V-I Rhodes chords, swung hats, vinyl crackle, tape wobble',
    bpm: 75,
    phraseBars: 4,
    barsPerChord: 1,
    swing8: 0.6,
    swing16: 0.5,
    drums: true,
    phraseRisers: false,
    progression: [
      chord('Gm9', 43, [58, 62, 65, 69]),
      chord('C13', 36, [58, 62, 64, 69]),
      chord('Fmaj9', 41, [57, 60, 64, 67]),
      chord('Dm9', 38, [57, 60, 64, 65]),
    ],
    tonic: 2,
    cadence: 1,
  },
  synthwave: {
    label: 'Synthwave',
    description: 'Minor i-VI-III-VII supersaws, octave bass, gated snare, arpeggio',
    bpm: 104,
    phraseBars: 8,
    barsPerChord: 1,
    swing8: 0.5,
    swing16: 0.5,
    drums: true,
    phraseRisers: true,
    progression: [
      chord('Am', 45, [57, 60, 64, 69]),
      chord('F', 41, [57, 60, 65, 69]),
      chord('C', 48, [55, 60, 64, 67]),
      chord('G', 43, [55, 59, 62, 67]),
    ],
    tonic: 0,
    cadence: 3,
  },
  upbeat: {
    label: 'Upbeat',
    description: 'Four-on-the-floor tech house-pop, pumping chords, offbeat bass, risers',
    bpm: 120,
    phraseBars: 8,
    barsPerChord: 1,
    swing8: 0.5,
    swing16: 0.54,
    drums: true,
    phraseRisers: true,
    progression: [
      chord('Gadd9', 43, [59, 62, 67, 69]),
      chord('D', 38, [57, 62, 66, 69]),
      chord('Em7', 40, [59, 62, 64, 67]),
      chord('Cadd9', 36, [60, 62, 64, 67]),
    ],
    tonic: 0,
    cadence: 1,
  },
  ambient: {
    label: 'Ambient',
    description: 'Slow evolving pads, shimmer, a soft pulse, no drums',
    bpm: 70,
    phraseBars: 4,
    barsPerChord: 2,
    swing8: 0.5,
    swing16: 0.5,
    drums: false,
    phraseRisers: false,
    progression: [
      chord('Dmaj9', 38, [57, 61, 64, 66]),
      chord('Bm11', 35, [54, 57, 62, 64]),
      chord('Gmaj9', 31, [54, 59, 62, 69]),
      chord('Asus4', 33, [52, 57, 62, 64]),
    ],
    tonic: 0,
    cadence: 3,
  },
};

export const midiToHz = (note) => 440 * (2 ** ((note - 69) / 12));

const mod = (value, size) => ((value % size) + size) % size;

// Deterministic LCG: every "random" choice in the music comes from a seed, so
// a preview and an export of the same project render identical samples.
export function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

// Maps a straight position in beats to a swung one. `swing8` is where the
// off-beat eighth lands within the beat (0.5 is straight, 0.6 is lazy), and
// `swing16` does the same for the off-beat sixteenth within each eighth.
export function swung(pos, swing8 = 0.5, swing16 = 0.5) {
  const beat = Math.floor(pos + 1e-9);
  const frac = pos - beat;
  const secondHalf = frac >= 0.5 - 1e-9;
  const from = secondHalf ? swing8 : 0;
  const to = secondHalf ? 1 : swing8;
  const local = secondHalf ? (frac - 0.5) / 0.5 : frac / 0.5;
  const shaped = local < 0.5 ? (local / 0.5) * swing16 : swing16 + (((local - 0.5) / 0.5) * (1 - swing16));
  return beat + from + ((to - from) * shaped);
}

// One character per sixteenth: "x" accent, "o" normal, "-" ghost, "." rest.
const VELOCITY = { x: 1, o: 0.72, '-': 0.4 };
export function parsePattern(pattern) {
  return [...pattern].flatMap((symbol, step) => (VELOCITY[symbol] ? [{ step, pos: step / 4, velocity: VELOCITY[symbol] }] : []));
}

function finiteOr(value, fallback, name, min, max) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`music.${name} must be a number from ${min} to ${max}.`);
  return value;
}

// Browser-fetchable path for a music file. The pipeline checks that the file
// exists inside the repository; this only normalizes the spelling.
export function musicFileUrl(file) {
  const cleaned = String(file).trim().replace(/\\/g, '/').replace(/^\.\//, '');
  return cleaned.startsWith('/') ? cleaned : `/${cleaned}`;
}

// Normalizes script or project music settings. `{ bpm }` without a style is
// the original warm-pop generator; a style without a bpm gets its own tempo.
export function resolveMusicSettings(input = {}) {
  const music = input && typeof input === 'object' ? { ...input } : {};
  const volume = finiteOr(music.volume, DEFAULT_MUSIC_VOLUME, 'volume', 0, 4);
  if (music.file !== undefined && music.file !== null) {
    if (typeof music.file !== 'string' || !music.file.trim()) throw new Error('music.file must be a path to an audio file.');
    if (/^[a-z][a-z0-9+.-]*:/i.test(music.file)) throw new Error('music.file must be a file inside the repository, not a URL.');
    const settings = {
      file: musicFileUrl(music.file),
      volume,
      startAtS: finiteOr(music.startAtS, 0, 'startAtS', 0, 36000),
      loop: music.loop !== false,
    };
    if (music.fadeInS !== undefined) settings.fadeInS = finiteOr(music.fadeInS, 1, 'fadeInS', 0, 60);
    if (music.fadeOutS !== undefined) settings.fadeOutS = finiteOr(music.fadeOutS, 3, 'fadeOutS', 0, 60);
    if (music.crossfadeS !== undefined) settings.crossfadeS = finiteOr(music.crossfadeS, 1.5, 'crossfadeS', 0, 20);
    if (music.normalize === false) settings.normalize = false;
    return settings;
  }
  const style = music.style ?? DEFAULT_MUSIC_STYLE;
  if (!MUSIC_STYLES[style]) throw new Error(`Unknown music style "${style}". Use one of: ${Object.keys(MUSIC_STYLES).join(', ')}, or set music.file.`);
  const { file, ...rest } = music;
  return {
    ...rest,
    style,
    bpm: finiteOr(music.bpm, MUSIC_STYLES[style].bpm, 'bpm', 40, 220),
    volume,
    seed: Math.round(finiteOr(music.seed, DEFAULT_MUSIC_SEED, 'seed', 0, 2 ** 31)),
  };
}

export function describeMusic(music) {
  if (!music) return null;
  return music.file ? `file:${music.file}` : `generated:${music.style || DEFAULT_MUSIC_STYLE}`;
}

// Picks the tempo within `tolerance` of `bpm` that fits a whole number of bars
// between the reveal (the end of the intro card) and the outro, preferring the
// smallest change and, among near ties, phrase-friendly bar counts. Returns
// `bars: null` when the span is too short to align, in which case only the
// reveal lands on a bar line.
export function alignTempo({ bpm, revealS = 0, resolveS, tolerance = TEMPO_TOLERANCE, beatsPerBar = BEATS_PER_BAR, align = true }) {
  const span = resolveS - revealS;
  if (!align || !(span > 0)) return { bpm, bars: null };
  const secondsPerBarAt = (tempo) => (60 / tempo) * beatsPerBar;
  const lowest = Math.ceil((span / secondsPerBarAt(bpm * (1 - tolerance))) - 1e-9);
  const highest = Math.floor((span / secondsPerBarAt(bpm * (1 + tolerance))) + 1e-9);
  let best = null;
  for (let bars = Math.max(1, lowest); bars <= highest; bars += 1) {
    const tempo = (bars * secondsPerBarAt(1)) / span;
    const score = Math.abs(Math.log(tempo / bpm)) + (bars % 2 ? 0.006 : 0) + (bars % 4 ? 0.004 : 0);
    if (!best || score < best.score) best = { bpm: tempo, bars, score };
  }
  return best ? { bpm: best.bpm, bars: best.bars } : { bpm, bars: null };
}

export function mergeSpans(spans, gapS = 0) {
  return [...spans]
    .filter(([start, end]) => end > start)
    .sort((left, right) => left[0] - right[0])
    .reduce((merged, span) => {
      const last = merged[merged.length - 1];
      if (last && span[0] - last[1] < gapS) last[1] = Math.max(last[1], span[1]);
      else merged.push([...span]);
      return merged;
    }, []);
}

// Narration spans in output seconds, merged across short breaths. The mixer
// ducks the music under these and the arranger thins the top layers.
export function voiceSpans(project, gapS = 0.7) {
  return mergeSpans((project.voice || []).filter((line) => line.src).map((line) => [line.outMs / 1000, (line.outMs + line.durationMs) / 1000]), gapS);
}

// Fast-forward spans (rate > 1, including their ramps) in output seconds.
export function fastForwardSpans(project) {
  const speed = project.speed || [];
  if (!speed.some((span) => span.rate > 1)) return [];
  const sourceDurationMs = project.timeline?.sourceDurationMs ?? project.durationMs ?? speed[speed.length - 1].endMs;
  const map = createTimeMap(speed, sourceDurationMs);
  const introMs = project.timeline?.introMs || 0;
  const toOut = (sourceMs) => (introMs + sourceToOutput(map, sourceMs)) / 1000;
  return mergeSpans(speed.filter((span) => span.rate > 1).map((span) => [toOut(span.startMs), toOut(span.endMs)]), 0.05);
}

export function typingSpans(project) {
  return mergeSpans((project.sfx || []).filter((effect) => effect.kind === 'typing').map((effect) => [effect.outMs / 1000, effect.outEndMs / 1000]), 0.3);
}

function overlap(spans, start, end) {
  return spans.reduce((total, [from, to]) => total + Math.max(0, Math.min(end, to) - Math.max(start, from)), 0);
}

const SECTION_ENERGY = { intro: 0, groove: 1, lift: 3, outro: 0 };

// The arrangement is a list of bars on a fixed tempo grid whose bar 0 starts
// exactly when the recording is revealed. Intro-card bars are sparse, the
// groove starts at the reveal, bars under a fast-forward get a lift (more
// hats, a riser into the next bar line), narration thins the top layers, and
// the outro resolves on the tonic with the drums dropped.
export function planMusic(project, overrides = {}) {
  const music = resolveMusicSettings({ ...(project.music || {}), ...overrides });
  const timeline = project.timeline || {};
  const endS = Math.max(0, (timeline.outDurationMs ?? project.durationMs ?? 0) / 1000);
  const voice = voiceSpans(project);
  if (music.file) {
    return {
      kind: 'file',
      file: music.file,
      volume: music.volume,
      startAtS: music.startAtS,
      loop: music.loop,
      fadeInS: music.fadeInS ?? 1,
      fadeOutS: Math.min(music.fadeOutS ?? 3, endS / 2),
      crossfadeS: music.crossfadeS ?? 1.5,
      normalize: music.normalize !== false,
      endS,
      voice,
    };
  }

  const style = MUSIC_STYLES[music.style];
  const revealS = clamp((timeline.introMs || 0) / 1000, 0, endS);
  const outroS = clamp(endS - ((timeline.outroMs || 0) / 1000), revealS, endS);
  const tempo = alignTempo({ bpm: music.bpm, revealS, resolveS: outroS, align: music.align !== false });
  const beatS = 60 / tempo.bpm;
  const barS = beatS * BEATS_PER_BAR;
  const originS = revealS;
  const barStart = (index) => originS + (index * barS);
  let firstBar = Math.floor(((0 - originS) / barS) + 1e-9);
  // A sliver of a bar before the first full one would be a chord change a
  // moment after the music starts; start on the next bar instead.
  if (barStart(firstBar + 1) < 0.3 * barS && barStart(firstBar + 1) < originS) firstBar += 1;

  let finalBar = Math.round((outroS - originS) / barS);
  while (finalBar > firstBar + 1 && endS - barStart(finalBar) < Math.min(MIN_TAIL_S, endS / 4)) finalBar -= 1;
  finalBar = Math.max(finalBar, firstBar + 1);
  // Without an intro card, count in inside the recording so the groove still
  // arrives as an event rather than at sample zero.
  let grooveBar = revealS >= beatS ? 0 : (barS < 2.6 ? 2 : 1);
  grooveBar = Math.max(firstBar + 1, Math.min(grooveBar, finalBar - 1));

  const lifts = fastForwardSpans(project).filter(([start, end]) => end > barStart(grooveBar) && start < barStart(finalBar));
  const typing = typingSpans(project);
  const { progression, barsPerChord, phraseBars, tonic, cadence } = style;
  const chordFor = (index) => {
    if (index >= finalBar) return tonic;
    if (index >= finalBar - barsPerChord && index >= grooveBar) return cadence;
    return mod(Math.floor((index - grooveBar) / barsPerChord), progression.length);
  };

  const bars = [];
  for (let index = firstBar; index <= finalBar; index += 1) {
    const startS = barStart(index);
    const endBarS = startS + barS;
    const clippedStart = Math.max(0, startS);
    const visible = Math.max(0.001, Math.min(endBarS, endS) - clippedStart);
    let section = 'groove';
    if (index < grooveBar) section = 'intro';
    else if (index === finalBar) section = 'outro';
    else if (lifts.some(([from, to]) => overlap([[from, to]], startS, endBarS) >= Math.min(0.3 * barS, 0.6 * (to - from)))) section = 'lift';
    const inPhrase = index - grooveBar;
    const phrase = section === 'intro' ? -1 : Math.floor(inPhrase / phraseBars);
    bars.push({
      index,
      startS,
      endS: endBarS,
      section,
      phrase,
      barInPhrase: section === 'intro' ? index - firstBar : mod(inPhrase, phraseBars),
      variant: phrase >= 0 && phrase % 2 ? 'B' : 'A',
      energy: section === 'groove' && phrase % 2 ? 2 : SECTION_ENERGY[section],
      chord: chordFor(index),
      nextChord: chordFor(index + 1),
      underVoice: overlap(voice, clippedStart, endBarS) / visible > 0.35,
      typing: overlap(typing, clippedStart, endBarS) / visible > 0.3,
      // A long intro card gets a hint of the groove in its last bar.
      buildup: section === 'intro' && index === grooveBar - 1 && barStart(grooveBar) >= 2 * barS,
      fill: false,
      impact: false,
    });
  }
  const barAt = (index) => bars[index - firstBar];
  bars.forEach((bar, position) => {
    const next = bars[position + 1];
    if (!next || bar.section === 'intro' || bar.section === 'outro') return;
    bar.fill = bar.barInPhrase === phraseBars - 1 || (next.section === 'lift' && bar.section !== 'lift') || next.section === 'outro';
  });
  // Chord slots: a chord is struck once and held for `barsPerChord` bars, so
  // a slow style (ambient) does not re-attack its pads every bar.
  let run = 0;
  bars.forEach((bar, position) => {
    const previous = bars[position - 1];
    const crossesReveal = previous && (previous.section === 'intro') !== (bar.section === 'intro');
    bar.chordStart = !previous || previous.chord !== bar.chord || crossesReveal || run >= barsPerChord;
    run = bar.chordStart ? 1 : run + 1;
  });
  bars.forEach((bar, position) => {
    if (!bar.chordStart) return;
    let length = 1;
    while (bars[position + length] && !bars[position + length].chordStart) length += 1;
    bar.chordBars = length;
  });

  const risers = [];
  const addRiser = (kind, startS, endAtS) => {
    const from = Math.max(0.05, startS);
    if (endAtS - from < Math.min(beatS, 0.4)) return;
    const existing = risers.find((riser) => Math.abs(riser.endS - endAtS) < 1e-6);
    if (existing) {
      existing.startS = Math.min(existing.startS, from);
      if (kind === 'lift') existing.kind = 'lift';
      return;
    }
    risers.push({ kind, startS: from, endS: endAtS });
    const target = barAt(Math.round((endAtS - originS) / barS));
    if (target && target.section !== 'outro') target.impact = true;
  };
  const grooveS = barStart(grooveBar);
  if (grooveS > 0.5) addRiser('reveal', grooveS - Math.min(barS, grooveS - 0.1, 3), grooveS);
  for (const [start, end] of lifts) {
    const index = clamp(Math.ceil(((end - originS) / barS) - 0.1), grooveBar + 1, finalBar);
    const endAtS = barStart(index);
    addRiser('lift', Math.max(Math.min(start, endAtS - beatS), endAtS - (2 * barS)), endAtS);
  }
  if (style.phraseRisers) {
    for (const bar of bars) {
      const previous = barAt(bar.index - 1);
      const boundary = bar.section !== 'intro' && bar.index > grooveBar && (bar.barInPhrase === 0 || bar.section === 'outro');
      if (!boundary || !previous || previous.underVoice) continue;
      if (risers.some((riser) => riser.endS > bar.startS - barS - 1e-6 && riser.endS < bar.startS + 1e-6)) continue;
      addRiser('phrase', bar.startS - Math.min(barS, 2.4), bar.startS);
    }
  }
  risers.sort((left, right) => left.startS - right.startS);

  return {
    kind: 'generated',
    style: music.style,
    label: style.label,
    seed: music.seed,
    volume: music.volume,
    baseBpm: music.bpm,
    bpm: tempo.bpm,
    alignedBars: tempo.bars,
    beatS,
    barS,
    swing8: style.swing8,
    swing16: style.swing16,
    originS,
    revealS,
    grooveS,
    finalS: barStart(finalBar),
    endS,
    grooveBar,
    finalBar,
    bars,
    risers,
    lifts,
    voice,
  };
}

// One line for logs: what the arranger decided.
export function summarizeMusicPlan(plan) {
  if (plan.kind === 'file') return `music: ${plan.file}${plan.loop ? ' (looped)' : ''}, ${plan.volume} volume`;
  const lifts = plan.bars.filter((bar) => bar.section === 'lift').length;
  return `music: ${plan.style} at ${plan.bpm.toFixed(1)} bpm (base ${plan.baseBpm}), groove at ${plan.grooveS.toFixed(1)}s, ${plan.finalBar - plan.grooveBar} bars, ${lifts} lift bar${lifts === 1 ? '' : 's'}, ${plan.risers.length} riser${plan.risers.length === 1 ? '' : 's'}, resolves at ${plan.finalS.toFixed(1)}s`;
}

// A demo-shaped timeline for auditioning a style without recording anything:
// the default intro and outro cards and one fast-forward span in the middle.
export function auditionProject({ style = DEFAULT_MUSIC_STYLE, seconds = 30, seed, volume, bpm, fastForward = true } = {}) {
  const outDurationMs = Math.round(clamp(seconds, 6, 600) * 1000);
  const introMs = 2400;
  const outroMs = 2200;
  const recordedOutMs = outDurationMs - introMs - outroMs;
  const rate = 4;
  const fastOutStart = Math.round(recordedOutMs * 0.46);
  const fastOutMs = fastForward && recordedOutMs > 12000 ? 1800 : 0;
  const speed = fastOutMs
    ? [
      { startMs: 0, endMs: fastOutStart, rate: 1 },
      { startMs: fastOutStart, endMs: fastOutStart + (fastOutMs * rate), rate },
      { startMs: fastOutStart + (fastOutMs * rate), endMs: recordedOutMs + (fastOutMs * (rate - 1)), rate: 1 },
    ]
    : [{ startMs: 0, endMs: recordedOutMs, rate: 1 }];
  const sourceDurationMs = speed[speed.length - 1].endMs;
  const music = { style };
  if (seed !== undefined) music.seed = seed;
  if (volume !== undefined) music.volume = volume;
  if (bpm !== undefined) music.bpm = bpm;
  return {
    schema: 'nava.demo-project.v1',
    title: `Music audition: ${style}`,
    durationMs: sourceDurationMs,
    timeline: { introMs, outroMs, sourceDurationMs, outDurationMs },
    speed,
    voice: [],
    sfx: [],
    music: resolveMusicSettings(music),
    audio: { clickSound: false, duckingDb: -10, backgroundMusic: `generated:${style}` },
  };
}

// Trims or loops decoded audio to `lengthS`, starting at `startS`. Each
// repeat restarts at `loopStartS` and overlaps the previous pass by an
// equal-power crossfade so the seam is inaudible.
export function stitchLoop(channels, sampleRate, { startS = 0, loopStartS = startS, lengthS, loop = true, crossfadeS = 1.5 } = {}) {
  const sourceLength = channels[0]?.length || 0;
  const length = Math.max(0, Math.round(lengthS * sampleRate));
  const outputs = channels.map(() => new Float32Array(length));
  if (!sourceLength || !length) return outputs;
  const loopStart = clamp(Math.round(loopStartS * sampleRate), 0, sourceLength - 1);
  const body = sourceLength - loopStart;
  const fade = Math.max(0, Math.min(Math.round(crossfadeS * sampleRate), Math.floor(body / 3)));
  let from = clamp(Math.round(startS * sampleRate), 0, sourceLength - 1);
  if (loop && sourceLength - from <= fade * 2) from = loopStart;
  let at = 0;
  let first = true;
  while (at < length) {
    const segment = sourceLength - from;
    const fadeIn = first ? 0 : fade;
    const fadeOut = loop ? fade : 0;
    for (let index = 0; index < segment && at + index < length; index += 1) {
      let gain = 1;
      if (index < fadeIn) gain = Math.sin((Math.PI / 2) * ((index + 0.5) / fadeIn));
      const fromEnd = segment - index;
      if (fromEnd <= fadeOut) gain *= Math.cos((Math.PI / 2) * ((fadeOut - fromEnd + 0.5) / fadeOut));
      for (let channel = 0; channel < channels.length; channel += 1) outputs[channel][at + index] += channels[channel][from + index] * gain;
    }
    if (!loop || segment - fade <= 0) break;
    at += segment - fade;
    from = loopStart;
    first = false;
  }
  return outputs;
}
