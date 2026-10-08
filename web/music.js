// Generated background music. Shared Web Audio instruments (drums, supersaw,
// FM electric piano, bass, risers, vinyl) feed a master chain, and each style
// plays the bar-by-bar arrangement from lib/music-plan.mjs, so the music
// follows the demo: sparse under the intro card, the groove at the reveal, a
// lift over fast-forwards, and a resolved ending under the outro card. Every
// random choice is seeded, so preview and export render identical samples.

import { clamp } from '/lib/timeline.mjs';
import { MUSIC_REFERENCE_RMS, MUSIC_STYLES, midiToHz, parsePattern, seeded, stitchLoop, swung } from '/lib/music-plan.mjs';

const ROLES = ['drums', 'bass', 'keys', 'fx'];
const isGroove = (bar) => bar.section === 'groove' || bar.section === 'lift';

// ---------------------------------------------------------------- node helpers

function gainNode(context, value = 1) {
  const node = context.createGain();
  node.gain.value = value;
  return node;
}

function filterNode(context, type, frequency, Q = 0.7071, gain = 0) {
  const node = context.createBiquadFilter();
  node.type = type;
  node.frequency.value = frequency;
  node.Q.value = Q;
  if (gain) node.gain.value = gain;
  return node;
}

function pannerNode(context, pan) {
  const node = context.createStereoPanner();
  node.pan.value = clamp(pan, -1, 1);
  return node;
}

function oscillatorNode(context, type, frequency, detune = 0) {
  const node = context.createOscillator();
  node.type = type;
  node.frequency.value = frequency;
  node.detune.value = detune;
  return node;
}

function compressorNode(context, { threshold, knee, ratio, attack, release }) {
  const node = context.createDynamicsCompressor();
  node.threshold.value = threshold;
  node.knee.value = knee;
  node.ratio.value = ratio;
  node.attack.value = attack;
  node.release.value = release;
  return node;
}

function shaperNode(context, curve) {
  const node = context.createWaveShaper();
  node.curve = curve;
  node.oversample = '4x';
  return node;
}

// Saturation: tanh drive normalized so full scale stays full scale.
function driveCurve(drive, size = 2048) {
  const curve = new Float32Array(size);
  const norm = Math.tanh(drive);
  for (let index = 0; index < size; index += 1) curve[index] = Math.tanh(drive * (((index / (size - 1)) * 2) - 1)) / norm;
  return curve;
}

// Linear below `knee`, then a tanh shoulder that never reaches full scale.
function softClipCurve(knee = 0.6, size = 4096) {
  const curve = new Float32Array(size);
  for (let index = 0; index < size; index += 1) {
    const x = ((index / (size - 1)) * 2) - 1;
    const magnitude = Math.abs(x);
    const y = magnitude <= knee ? magnitude : knee + ((1 - knee) * Math.tanh((magnitude - knee) / (1 - knee)));
    curve[index] = Math.sign(x) * y;
  }
  return curve;
}

// Attack, then an exponential fall to `sustain` (reaching about -35 dB of the
// way there after `decay` seconds); `end` starts the release.
function envelope(param, t, { peak, attack = 0.002, hold = 0, decay = 0.3, sustain = 0, end = null, release = 0.2 }) {
  param.setValueAtTime(0, t);
  param.linearRampToValueAtTime(peak, t + attack);
  if (hold) param.setValueAtTime(peak, t + attack + hold);
  param.setTargetAtTime(peak * sustain, t + attack + hold, Math.max(0.001, decay / 4));
  if (end !== null) param.setTargetAtTime(0, Math.max(end, t + attack + hold), Math.max(0.001, release / 4));
}

// ------------------------------------------------------------ seeded buffers

function monoBuffer(context, seconds, fill) {
  const buffer = context.createBuffer(1, Math.max(1, Math.ceil(context.sampleRate * seconds)), context.sampleRate);
  fill(buffer.getChannelData(0), context.sampleRate);
  return buffer;
}

function whiteNoise(context, seconds, random) {
  return monoBuffer(context, seconds, (data) => {
    for (let index = 0; index < data.length; index += 1) data[index] = (random() * 2) - 1;
  });
}

// Six square waves at the TR-808's inharmonic cymbal ratios, plus a little
// noise: the metallic source for hats and crashes.
function metalNoise(context, random) {
  const frequencies = [205.3, 304.4, 369.6, 522.7, 540, 800];
  const phases = frequencies.map(() => random());
  return monoBuffer(context, 1.5, (data, sampleRate) => {
    for (let index = 0; index < data.length; index += 1) {
      let value = 0;
      for (let voice = 0; voice < 6; voice += 1) value += (((frequencies[voice] * index) / sampleRate) + phases[voice]) % 1 < 0.5 ? 1 : -1;
      data[index] = ((value / 6) * 0.75) + (((random() * 2) - 1) * 0.25);
    }
  });
}

// Vinyl surface: soft hiss, frequent small ticks, and a few low pops.
function crackleBuffer(context, random, seconds = 7) {
  return monoBuffer(context, seconds, (data) => {
    let hiss = 0;
    for (let index = 0; index < data.length; index += 1) {
      hiss += 0.3 * (((random() * 2) - 1) - hiss);
      data[index] = hiss * 0.06;
    }
    for (let tick = 0; tick < seconds * 18; tick += 1) {
      const at = Math.floor(random() * (data.length - 64));
      const amplitude = (0.06 + (0.8 * (random() ** 3))) * (random() < 0.5 ? -1 : 1);
      const width = 1 + (random() * 4);
      for (let offset = 0; offset < 48; offset += 1) data[at + offset] += amplitude * Math.exp(-offset / width) * (offset % 2 ? -0.55 : 1);
    }
    for (let pop = 0; pop < seconds * 0.8; pop += 1) {
      const at = Math.floor(random() * (data.length - 600));
      const amplitude = (0.25 + (0.3 * random())) * (random() < 0.5 ? -1 : 1);
      for (let offset = 0; offset < 540; offset += 1) data[at + offset] += amplitude * (Math.sin((Math.PI * offset) / 540) ** 2) * Math.exp(-offset / 180);
    }
  });
}

// Stereo-decorrelated noise with an exponential decay that also darkens as it
// fades, like a real room. `gated` makes the 80s snare verb: dense, then cut.
function impulseResponse(context, random, { seconds = 2.5, predelayS = 0.015, damping = 0.45, gated = false }) {
  const sampleRate = context.sampleRate;
  const predelay = Math.round(predelayS * sampleRate);
  const length = Math.ceil(sampleRate * seconds) + predelay;
  const buffer = context.createBuffer(2, length, sampleRate);
  for (let channel = 0; channel < 2; channel += 1) {
    const data = buffer.getChannelData(channel);
    let low = 0;
    for (let index = predelay; index < length; index += 1) {
      const t = (index - predelay) / sampleRate;
      const progress = t / seconds;
      const level = gated ? (progress < 0.85 ? 1 - (0.4 * progress) : Math.max(0, 0.66 * (1 - ((progress - 0.85) / 0.15)))) : Math.exp(-6.9 * progress);
      const smoothing = gated ? 0.15 : Math.min(0.93, damping * progress * 1.8);
      low += (1 - smoothing) * (((random() * 2) - 1) - low);
      data[index] = low * level;
    }
  }
  return buffer;
}

// ------------------------------------------------------------------- buses

function reverbBus(kit, options, output) {
  const { context } = kit;
  const input = gainNode(context);
  const thin = filterNode(context, 'highpass', options.gated ? 400 : 220);
  const convolver = context.createConvolver();
  convolver.buffer = impulseResponse(context, seeded(kit.plan.seed + (options.gated ? 71 : 37)), options);
  const back = gainNode(context, options.level ?? 1);
  input.connect(thin).connect(convolver).connect(back).connect(output);
  return input;
}

// Tempo-synced ping-pong echo with a filtered feedback path, so repeats get
// darker and thinner instead of building up.
function pingPongBus(kit, { beats = 0.75, feedback = 0.35, level = 0.25, tone = 3000 }, output) {
  const { context } = kit;
  const time = beats * kit.beat;
  const input = gainNode(context);
  const damp = filterNode(context, 'lowpass', tone, 0.5);
  const thin = filterNode(context, 'highpass', 260);
  const left = context.createDelay(4);
  const right = context.createDelay(4);
  left.delayTime.value = time;
  right.delayTime.value = time;
  const across = gainNode(context, feedback);
  const back = gainNode(context, feedback);
  const back2 = gainNode(context, level);
  input.connect(damp).connect(thin).connect(left);
  left.connect(pannerNode(context, -0.7)).connect(back2);
  left.connect(across).connect(right);
  right.connect(pannerNode(context, 0.7)).connect(back2);
  right.connect(back).connect(damp);
  back2.connect(output);
  return input;
}

// Slow wow and fast flutter by modulating a short delay: the whole mix bends
// in pitch together, the way a worn cassette does.
function tapeWobble(kit, { depthS, rateHz, flutterS, flutterHz }) {
  const { context } = kit;
  const delay = context.createDelay(0.1);
  delay.delayTime.value = 0.015;
  for (const [depth, rate] of [[depthS, rateHz], [flutterS, flutterHz]]) {
    const lfo = oscillatorNode(context, 'sine', rate);
    const amount = gainNode(context, depth);
    lfo.connect(amount).connect(delay.delayTime);
    lfo.start(0);
    lfo.stop(kit.endS + 1);
  }
  return delay;
}

// Bus compressor -> gentle soft clip -> final limiter.
function masterChain(kit, sound, destination) {
  const { context } = kit;
  const input = gainNode(context);
  let node = input;
  const then = (next) => {
    node.connect(next);
    node = next;
  };
  then(filterNode(context, 'highpass', 28));
  if (sound.wobble) then(tapeWobble(kit, sound.wobble));
  if (sound.tone) then(filterNode(context, 'lowpass', sound.tone, 0.5));
  then(compressorNode(context, { threshold: -20, knee: 8, ratio: 2.5, attack: 0.02, release: 0.25 }));
  then(shaperNode(context, softClipCurve()));
  then(compressorNode(context, { threshold: -3, knee: 0, ratio: 20, attack: 0.002, release: 0.1 }));
  then(gainNode(context, sound.level ?? 1));
  node.connect(destination);
  return input;
}

function route(kit, node, { role = 'keys', verb = 0, delay = 0, gated = 0 } = {}) {
  node.connect(kit.roles[role]);
  if (kit.muted.has(role)) return;
  for (const [bus, amount] of [[kit.reverb, verb], [kit.delay, delay], [kit.gated, gated]]) {
    if (!bus || !amount) continue;
    node.connect(gainNode(kit.context, amount)).connect(bus);
  }
}

function createKit(context, destination, plan, sound, { solo = null } = {}) {
  const kit = {
    context,
    plan,
    sound,
    style: MUSIC_STYLES[plan.style],
    random: seeded((plan.seed * 7919) + 101),
    beat: plan.beatS,
    barS: plan.barS,
    endS: plan.endS,
    kicks: [],
    openHat: null,
    patterns: new Map(),
    muted: new Set(solo ? ROLES.filter((role) => role !== solo) : []),
  };
  kit.master = masterChain(kit, sound, destination);
  kit.noise = whiteNoise(context, 2, seeded(plan.seed + 11));
  kit.metal = metalNoise(context, seeded(plan.seed + 23));
  kit.pump = gainNode(context);
  kit.pump.connect(kit.master);
  kit.roles = Object.fromEntries(ROLES.map((role) => {
    const bus = gainNode(context, kit.muted.has(role) ? 0 : 1);
    bus.connect(sound.pump?.roles.includes(role) ? kit.pump : kit.master);
    return [role, bus];
  }));
  kit.reverb = reverbBus(kit, sound.reverb, kit.master);
  kit.delay = sound.delay ? pingPongBus(kit, sound.delay, kit.master) : null;
  kit.gated = sound.gated ? reverbBus(kit, { ...sound.gated, gated: true }, kit.master) : null;

  const kick = { drive: 2, lowpass: 12000, level: 0.9, ...sound.kick };
  kit.kickBus = gainNode(context);
  const kickOut = gainNode(context, kick.level);
  kit.kickBus.connect(shaperNode(context, driveCurve(kick.drive))).connect(filterNode(context, 'lowpass', kick.lowpass, 0.5)).connect(kickOut);
  route(kit, kickOut, { role: 'drums' });
  kit.bassBus = gainNode(context);
  const bassOut = gainNode(context);
  kit.bassBus.connect(shaperNode(context, driveCurve(1.4))).connect(filterNode(context, 'lowpass', 5200, 0.5)).connect(bassOut);
  route(kit, bassOut, { role: 'bass' });

  kit.chord = (index) => kit.style.progression[index];
  kit.steps = (pattern) => {
    if (!kit.patterns.has(pattern)) kit.patterns.set(pattern, parsePattern(pattern));
    return kit.patterns.get(pattern);
  };
  // A bar that starts before t = 0 (an intro card shorter than a bar) still
  // plays its downbeat, at t = 0; its other early events stay before the start
  // and are skipped by the instruments.
  kit.time = (bar, pos, humanize = sound.humanize || 0) => {
    const at = bar.startS + (swung(pos, plan.swing8, plan.swing16) * kit.beat) + (humanize ? (kit.random() - 0.5) * 2 * humanize : 0);
    return bar.startS >= 0 || pos === 0 ? Math.max(0, at) : at;
  };
  return kit;
}

// Sidechain pumping: the pumped roles duck on every kick and swell back
// before the next one.
function finishPump(kit) {
  const pump = kit.sound.pump;
  if (!pump) return;
  const times = [...new Set(kit.kicks)].sort((left, right) => left - right);
  const gain = kit.pump.gain;
  gain.setValueAtTime(1, 0);
  times.forEach((t, index) => {
    const next = times[index + 1] ?? Infinity;
    gain.setTargetAtTime(1 - pump.depth, t, 0.004);
    gain.setTargetAtTime(1, Math.min(t + 0.035, next - 0.001), kit.beat * pump.release);
  });
}

// ------------------------------------------------------------- instruments

function kick(kit, t, velocity = 1) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const p = { startHz: 150, endHz: 48, sweepS: 0.08, decayS: 0.4, click: 0.35, ...kit.sound.kick };
  const body = oscillatorNode(context, 'sine', p.startHz);
  body.frequency.setValueAtTime(p.startHz, t);
  body.frequency.exponentialRampToValueAtTime(p.endHz, t + p.sweepS);
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: velocity, attack: 0.0015, hold: 0.01, decay: p.decayS * 0.9 });
  body.connect(amp).connect(kit.kickBus);
  body.start(t);
  body.stop(t + p.decayS + 0.2);
  if (p.click) {
    const click = context.createBufferSource();
    click.buffer = kit.noise;
    const clickGain = gainNode(context, 0);
    envelope(clickGain.gain, t, { peak: p.click * velocity, attack: 0.0006, decay: 0.012 });
    click.connect(filterNode(context, 'highpass', 2600)).connect(clickGain).connect(kit.kickBus);
    click.start(t, kit.random() * 1.5);
    click.stop(t + 0.05);
  }
  if (kit.sound.pump) kit.kicks.push(t);
}

function snare(kit, t, { velocity = 1, level = 0.45, tone = 190, noiseHp = 1300, noiseLp = 10000, decayS = 0.2, bodyDecayS = 0.12, verb = 0.15, gated = 0, pan = 0 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const out = pannerNode(context, pan);
  route(kit, out, { role: 'drums', verb, gated });
  const body = oscillatorNode(context, 'triangle', tone * 1.35);
  body.frequency.setValueAtTime(tone * 1.35, t);
  body.frequency.exponentialRampToValueAtTime(tone, t + 0.03);
  const bodyAmp = gainNode(context, 0);
  envelope(bodyAmp.gain, t, { peak: level * 0.6 * velocity, attack: 0.001, decay: bodyDecayS });
  body.connect(bodyAmp).connect(out);
  body.start(t);
  body.stop(t + bodyDecayS + 0.1);
  const noise = context.createBufferSource();
  noise.buffer = kit.noise;
  const noiseAmp = gainNode(context, 0);
  envelope(noiseAmp.gain, t, { peak: level * velocity, attack: 0.001, decay: decayS });
  noise.connect(filterNode(context, 'highpass', noiseHp)).connect(filterNode(context, 'peaking', 4800, 1, 3)).connect(filterNode(context, 'lowpass', noiseLp)).connect(noiseAmp).connect(out);
  noise.start(t, kit.random() * 1.5);
  noise.stop(t + decayS + 0.1);
}

// A clap is a few noise bursts about 10 ms apart, then a short tail.
function clap(kit, t, { velocity = 1, level = 0.45, tone = 1250, verb = 0.2, pan = 0 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const out = pannerNode(context, pan);
  route(kit, out, { role: 'drums', verb });
  const noise = context.createBufferSource();
  noise.buffer = kit.noise;
  const amp = gainNode(context, 0);
  const peak = level * velocity;
  for (const offset of [0, 0.0105, 0.021]) {
    amp.gain.setValueAtTime(peak * 0.8, t + offset);
    amp.gain.setTargetAtTime(0, t + offset + 0.0004, 0.003);
  }
  amp.gain.setValueAtTime(peak, t + 0.031);
  amp.gain.setTargetAtTime(0, t + 0.0315, 0.045);
  noise.connect(filterNode(context, 'bandpass', tone, 1.1)).connect(filterNode(context, 'highpass', 650)).connect(amp).connect(out);
  noise.start(t, kit.random() * 1.5);
  noise.stop(t + 0.4);
}

// Hats are scheduled in time order so an open hat can be choked by the next.
function hat(kit, t, { open = false, velocity = 1, level = 0.12, decayS = null, tone = 9500, pan = 0.22 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  if (kit.openHat && kit.openHat.startS < t && kit.openHat.untilS > t) kit.openHat.gain.setTargetAtTime(0, t, 0.006);
  const decay = decayS ?? (open ? 0.3 : 0.045);
  const source = context.createBufferSource();
  source.buffer = kit.metal;
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level * velocity, attack: 0.0008, decay });
  const out = pannerNode(context, pan);
  route(kit, out, { role: 'drums', verb: open ? 0.08 : 0.02 });
  source.connect(filterNode(context, 'highpass', open ? 6800 : 7600, 0.8)).connect(filterNode(context, 'peaking', tone, 1.4, 5)).connect(amp).connect(out);
  source.start(t, kit.random() * 1.2);
  source.stop(t + decay + 0.1);
  kit.openHat = open ? { gain: amp.gain, startS: t, untilS: t + decay } : kit.openHat;
}

function playHats(kit, bar, hits) {
  for (const hit of [...hits].sort((left, right) => left.pos - right.pos)) hat(kit, kit.time(bar, hit.pos), hit);
}

function crash(kit, t, { velocity = 1, level = 0.1, decayS = 2.4, verb = 0.3 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level * velocity, attack: 0.002, decay: decayS });
  const tone = filterNode(context, 'highpass', 4200, 0.7);
  tone.connect(filterNode(context, 'peaking', 8000, 1, 4)).connect(amp);
  route(kit, amp, { role: 'drums', verb });
  for (const [buffer, share] of [[kit.metal, 0.65], [kit.noise, 0.5]]) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.connect(gainNode(context, share)).connect(tone);
    source.start(t, kit.random());
    source.stop(t + decayS + 0.2);
  }
}

function tom(kit, t, { hz = 140, velocity = 1, level = 0.45, decayS = 0.35, gated = 0.6, pan = 0 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const out = pannerNode(context, pan);
  route(kit, out, { role: 'drums', gated, verb: 0.1 });
  const body = oscillatorNode(context, 'sine', hz * 1.6);
  body.frequency.setValueAtTime(hz * 1.6, t);
  body.frequency.exponentialRampToValueAtTime(hz, t + 0.06);
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level * velocity, attack: 0.001, decay: decayS });
  body.connect(amp).connect(out);
  body.start(t);
  body.stop(t + decayS + 0.1);
}

function subDrop(kit, t, { level = 0.3, fromHz = 100, toHz = 38, durationS = 1 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const body = oscillatorNode(context, 'sine', fromHz);
  body.frequency.setValueAtTime(fromHz, t);
  body.frequency.exponentialRampToValueAtTime(toHz, t + durationS);
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level, attack: 0.004, decay: durationS });
  body.connect(amp);
  route(kit, amp, { role: 'fx' });
  body.start(t);
  body.stop(t + durationS + 0.1);
}

// Filtered noise (and optionally a rising saw) sweeping up into a downbeat.
function riser(kit, startS, endS, { level = 0.08, fromHz = 400, toHz = 9000, q = 1.6, type = 'bandpass', tone = null, verb = 0.35, delay = 0.15 } = {}) {
  if (startS < 0 || endS - startS < 0.2) return;
  const { context } = kit;
  const sweep = filterNode(context, type, fromHz, q);
  sweep.frequency.setValueAtTime(fromHz, startS);
  sweep.frequency.exponentialRampToValueAtTime(toHz, endS);
  const amp = gainNode(context, 0);
  amp.gain.setValueAtTime(0.0001, startS);
  amp.gain.exponentialRampToValueAtTime(level, endS - 0.015);
  amp.gain.linearRampToValueAtTime(0, endS + 0.03);
  sweep.connect(filterNode(context, 'highpass', 200)).connect(amp);
  route(kit, amp, { role: 'fx', verb, delay });
  const noise = context.createBufferSource();
  noise.buffer = kit.noise;
  noise.loop = true;
  noise.connect(sweep);
  noise.start(startS, kit.random());
  noise.stop(endS + 0.1);
  if (tone) {
    const saw = oscillatorNode(context, 'sawtooth', midiToHz(tone.from));
    saw.frequency.setValueAtTime(midiToHz(tone.from), startS);
    saw.frequency.exponentialRampToValueAtTime(midiToHz(tone.to), endS);
    saw.connect(gainNode(context, tone.level)).connect(sweep);
    saw.start(startS);
    saw.stop(endS + 0.1);
  }
}

// Detuned oscillator stacks (a supersaw with the defaults) through a moving
// low-pass. `cutoff` points are spread evenly across the note.
function pad(kit, notes, t, length, { layers = [{ wave: 'sawtooth', detunes: [-7, 7] }], attack = 0.5, release = 1, level = 0.05, cutoff = [1200], q = 0.7, width = 0.6, role = 'keys', verb = 0.3, delay = 0 } = {}) {
  const start = Math.max(0, t);
  const end = Math.min(t + length, kit.endS);
  if (end - start < 0.05) return;
  const { context } = kit;
  const lowpass = filterNode(context, 'lowpass', cutoff[0], q);
  if (cutoff.length > 1) {
    lowpass.frequency.setValueAtTime(cutoff[0], start);
    cutoff.slice(1).forEach((hz, index) => lowpass.frequency.linearRampToValueAtTime(hz, start + (((end - start) * (index + 1)) / (cutoff.length - 1))));
  }
  const amp = gainNode(context, 0);
  const rise = Math.min(attack, (end - start) * 0.9);
  amp.gain.setValueAtTime(0, start);
  amp.gain.linearRampToValueAtTime(level, start + rise);
  amp.gain.setValueAtTime(level, end);
  amp.gain.setTargetAtTime(0, end, release / 4);
  const left = pannerNode(context, -width);
  const right = pannerNode(context, width);
  left.connect(lowpass);
  right.connect(lowpass);
  lowpass.connect(amp);
  route(kit, amp, { role, verb, delay });
  for (const note of notes) {
    for (const layer of layers) {
      const share = (layer.gain ?? 1) / Math.sqrt(layer.detunes.length);
      layer.detunes.forEach((cents, voice) => {
        const oscillator = oscillatorNode(context, layer.wave, midiToHz(note + (12 * (layer.octave || 0))), cents + ((kit.random() - 0.5) * 3));
        oscillator.connect(gainNode(context, share)).connect(layer.detunes.length === 1 ? lowpass : (voice % 2 ? right : left));
        // Staggered starts give each voice its own phase, so stacks do not
        // flam on the attack.
        oscillator.start(Math.max(0, start - (kit.random() * 0.02)));
        oscillator.stop(end + (release * 1.5) + 0.05);
      });
    }
  }
}

function stab(kit, notes, t, { velocity = 1, level = 0.045, wave = 'sawtooth', detunes = [-9, 0, 9], decayS = 0.22, cutoff = [4800, 800], filterS = 0.12, q = 1.4, width = 0.5, role = 'keys', verb = 0.15, delay = 0.12 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const lowpass = filterNode(context, 'lowpass', cutoff[0], q);
  lowpass.frequency.setValueAtTime(cutoff[0], t);
  lowpass.frequency.setTargetAtTime(cutoff[1], t, filterS / 3);
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level * velocity, attack: 0.003, decay: decayS });
  const left = pannerNode(context, -width);
  const right = pannerNode(context, width);
  left.connect(lowpass);
  right.connect(lowpass);
  lowpass.connect(amp);
  route(kit, amp, { role, verb, delay });
  const share = 1 / Math.sqrt(detunes.length);
  for (const note of notes) {
    detunes.forEach((cents, voice) => {
      const oscillator = oscillatorNode(context, wave, midiToHz(note), cents + ((kit.random() - 0.5) * 3));
      oscillator.connect(gainNode(context, share)).connect(voice === 1 ? lowpass : (voice % 2 ? right : left));
      oscillator.start(t);
      oscillator.stop(t + decayS + 0.15);
    });
  }
}

// Two-operator FM keys. With ratio 1 and a short high "tine" modulator this
// is a Rhodes-style electric piano; a non-integer ratio makes a soft bell.
function fmKeys(kit, note, t, length, { velocity = 0.8, level = 0.1, ratio = 1, index = 2, indexFloor = 0.2, indexDecayS = 0.5, tine = 0.18, tineRatio = 14, decayS = 2.2, sustain = 0.3, release = 0.3, dest = null, role = 'keys', verb = 0.2, delay = 0 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const frequency = midiToHz(note);
  const end = Math.min(t + length, kit.endS);
  const carrier = oscillatorNode(context, 'sine', frequency, (kit.random() - 0.5) * 4);
  const modulator = oscillatorNode(context, 'sine', frequency * ratio);
  const depth = gainNode(context, 0);
  const brightness = index * (0.45 + (velocity * 0.75));
  depth.gain.setValueAtTime(brightness * frequency * ratio, t);
  depth.gain.setTargetAtTime(indexFloor * frequency * ratio, t, indexDecayS / 3);
  modulator.connect(depth).connect(carrier.frequency);
  const oscillators = [carrier, modulator];
  if (tine) {
    const bell = oscillatorNode(context, 'sine', frequency * tineRatio);
    const bellDepth = gainNode(context, 0);
    bellDepth.gain.setValueAtTime(tine * velocity * frequency * tineRatio, t);
    bellDepth.gain.setTargetAtTime(0, t, 0.012);
    bell.connect(bellDepth).connect(carrier.frequency);
    oscillators.push(bell);
  }
  const amp = gainNode(context, 0);
  // Low notes ring longer, as on a real instrument.
  const ring = decayS * (2 ** ((60 - note) / 24));
  envelope(amp.gain, t, { peak: level * (0.35 + (velocity * 0.65)), attack: 0.002, decay: ring, sustain, end, release });
  carrier.connect(amp);
  if (dest) amp.connect(dest);
  else route(kit, amp, { role, verb, delay });
  for (const oscillator of oscillators) {
    oscillator.start(t);
    oscillator.stop(end + release + 0.1);
  }
}

// The Rhodes bus: suitcase-style stereo tremolo and a warm top end.
function electricPianoBus(kit, { tremoloHz = 4.5, depth = 0.28, tone = 4200, verb = 0.25, delay = 0 } = {}) {
  const { context } = kit;
  const input = gainNode(context);
  const pan = context.createStereoPanner();
  const lfo = oscillatorNode(context, 'sine', tremoloHz);
  lfo.connect(gainNode(context, depth)).connect(pan.pan);
  lfo.start(0);
  lfo.stop(kit.endS + 1);
  const warm = filterNode(context, 'lowpass', tone, 0.5);
  input.connect(pan).connect(warm);
  route(kit, warm, { role: 'keys', verb, delay });
  return input;
}

function strum(kit, notes, t, length, velocity, { spread = 0.012, ...options } = {}) {
  notes.forEach((note, index) => fmKeys(kit, note, t + (index * spread), length - (index * spread), { velocity: velocity * (0.9 + (kit.random() * 0.1)), dest: kit.ep, ...options }));
}

const BASS = {
  sub: { partials: [['sine', 1, 1], ['triangle', 1, 0.3]], cutoff: 900, attack: 0.004, sustain: 0.85, decay: 0.6, release: 0.05 },
  round: { partials: [['triangle', 1, 0.8], ['sine', 1, 0.7]], cutoff: 750, attack: 0.012, sustain: 0.6, decay: 0.9, release: 0.08 },
  saw: { partials: [['sawtooth', 1, 0.45], ['sawtooth', 1.0035, 0.45], ['sine', 1, 0.6]], cutoff: 320, attack: 0.003, sustain: 0.7, decay: 0.25, release: 0.04, env: 1500, q: 3 },
  swell: { partials: [['sine', 1, 1], ['triangle', 2, 0.12]], cutoff: 600, attack: 1.4, sustain: 1, decay: 1, release: 2 },
};

function bass(kit, note, t, length, { kind = 'sub', velocity = 1, level = 0.3, ...overrides } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const voice = { ...BASS[kind], ...overrides };
  const frequency = midiToHz(note);
  const end = Math.min(t + length, kit.endS);
  const lowpass = filterNode(context, 'lowpass', voice.cutoff, voice.q ?? 0.6);
  if (voice.env) {
    lowpass.frequency.setValueAtTime(voice.cutoff + voice.env, t);
    lowpass.frequency.setTargetAtTime(voice.cutoff, t, 0.05);
  }
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level * velocity, attack: voice.attack, decay: voice.decay, sustain: voice.sustain, end, release: voice.release });
  lowpass.connect(amp).connect(kit.bassBus);
  for (const [wave, ratio, share] of voice.partials) {
    const oscillator = oscillatorNode(context, wave, frequency * ratio);
    oscillator.connect(gainNode(context, share)).connect(lowpass);
    oscillator.start(t);
    oscillator.stop(end + voice.release + 0.1);
  }
}

function pluck(kit, note, t, { velocity = 1, level = 0.05, wave = 'triangle', partials = [[1, 1], [2, 0.35]], decayS = 0.5, cutoff = 3200, cutoffEnd = null, q = 0.8, pan = 0, role = 'keys', verb = 0.2, delay = 0.2 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const lowpass = filterNode(context, 'lowpass', cutoff, q);
  if (cutoffEnd) {
    lowpass.frequency.setValueAtTime(cutoff, t);
    lowpass.frequency.setTargetAtTime(cutoffEnd, t, decayS / 4);
  }
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level * velocity, attack: 0.004, decay: decayS });
  const out = pannerNode(context, pan);
  lowpass.connect(amp).connect(out);
  route(kit, out, { role, verb, delay });
  for (const [ratio, share] of partials) {
    const oscillator = oscillatorNode(context, ratio === 1 ? wave : 'sine', midiToHz(note) * ratio);
    oscillator.connect(gainNode(context, share)).connect(lowpass);
    oscillator.start(t);
    oscillator.stop(t + decayS + 0.1);
  }
}

// A mellow sine lead with delayed vibrato, for lo-fi hooks.
function lead(kit, note, t, length, { velocity = 1, level = 0.04, vibratoCents = 14, verb = 0.35, delay = 0.25 } = {}) {
  if (t < 0 || t >= kit.endS) return;
  const { context } = kit;
  const end = Math.min(t + length, kit.endS);
  const amp = gainNode(context, 0);
  envelope(amp.gain, t, { peak: level * velocity, attack: 0.03, decay: 1.2, sustain: 0.7, end, release: 0.3 });
  const tone = filterNode(context, 'lowpass', 2600, 0.5);
  tone.connect(amp);
  route(kit, amp, { role: 'keys', verb, delay });
  const vibrato = oscillatorNode(context, 'sine', 5.2);
  const vibratoDepth = gainNode(context, 0);
  vibratoDepth.gain.setValueAtTime(0, t);
  vibratoDepth.gain.linearRampToValueAtTime(vibratoCents, t + 0.4);
  vibrato.connect(vibratoDepth);
  for (const [wave, share, detune] of [['sine', 1, 0], ['triangle', 0.35, 4]]) {
    const oscillator = oscillatorNode(context, wave, midiToHz(note), detune);
    vibratoDepth.connect(oscillator.detune);
    oscillator.connect(gainNode(context, share)).connect(tone);
    oscillator.start(t);
    oscillator.stop(end + 0.4);
  }
  vibrato.start(t);
  vibrato.stop(end + 0.4);
}

function vinyl(kit, { level = 0.035 } = {}) {
  const { context } = kit;
  const source = context.createBufferSource();
  source.buffer = crackleBuffer(context, seeded(kit.plan.seed + 53));
  source.loop = true;
  const amp = gainNode(context, level);
  source.connect(filterNode(context, 'highpass', 260)).connect(filterNode(context, 'lowpass', 9000)).connect(amp);
  route(kit, amp, { role: 'fx' });
  source.start(0);
  source.stop(kit.endS + 0.1);
  return amp.gain;
}

// ------------------------------------------------------------------ styles

const ARPEGGIO = [0, 1, 2, 3, 2, 1, 2, 3];

const SOUNDS = {
  // The original generator, now on the shared drum kit.
  'warm-pop': {
    level: 0.173,
    humanize: 0.004,
    reverb: { seconds: 2.6, damping: 0.45 },
    delay: { beats: 0.75, feedback: 0.3, level: 0.22, tone: 3500 },
    kick: { startHz: 130, endHz: 46, sweepS: 0.1, decayS: 0.36, click: 0.25, drive: 1.6, lowpass: 6000, level: 0.8 },
    bar(kit, bar) {
      const chord = kit.chord(bar.chord);
      const { beat } = kit;
      const groove = isGroove(bar);
      const lift = bar.section === 'lift';
      const b = bar.variant === 'B';
      pad(kit, chord.notes, bar.startS, kit.barS, { layers: [{ wave: 'sawtooth', detunes: [-6, 6] }], attack: 0.9, release: 1.1, level: 0.05, cutoff: [700, lift ? 1900 : 1400, 850], q: 0.5, verb: 0.34 });
      if (groove || bar.buildup) {
        const steps = lift ? 16 : 8;
        for (let step = 0; step < steps; step += 1) {
          pluck(kit, chord.notes[ARPEGGIO[step % 8]] + 12, kit.time(bar, step * (4 / steps)), { velocity: 0.75 + (kit.random() * 0.25), level: bar.underVoice ? 0.034 : 0.048, cutoff: bar.buildup ? 1400 : 3200, verb: 0.3, delay: 0.3 });
        }
      }
      if (!groove) return;
      bass(kit, chord.root, bar.startS, beat * 1.8, { kind: 'round', level: 0.34 });
      bass(kit, chord.root, bar.startS + (beat * 2), beat * 1.6, { kind: 'round', level: 0.3 });
      for (const hit of kit.steps(b ? 'x.......x.o.....' : 'x.......x.......')) kick(kit, kit.time(bar, hit.pos, 0), hit.velocity);
      for (const pos of [1, 3]) {
        const t = kit.time(bar, pos);
        snare(kit, t, { level: 0.3, tone: 210, decayS: 0.17, verb: 0.3 });
        clap(kit, t + 0.004, { level: 0.2, verb: 0.3 });
      }
      const hats = kit.steps(lift ? '-.x--.x--.x--.x-' : b ? '-.x.-.x.-.x.-.o.' : '..x...x...x...x.').map((hit) => ({ ...hit, level: 0.1 }));
      if (b && !lift) hats[hats.length - 1].open = true;
      playHats(kit, bar, bar.typing ? hats.filter((hit) => hit.velocity > 0.5) : hats);
      if (bar.fill) [[3.25, 0.35], [3.5, 0.5], [3.75, 0.7]].forEach(([pos, velocity]) => snare(kit, kit.time(bar, pos), { velocity, level: 0.26, tone: 210, decayS: 0.12, verb: 0.2 }));
      if (bar.impact) crash(kit, bar.startS, { level: 0.07 });
    },
    riser(kit, span) {
      riser(kit, span.startS, span.endS, { level: span.kind === 'lift' ? 0.07 : 0.05, fromHz: 500, toHz: 7000 });
    },
    finale(kit, bar, length) {
      const chord = kit.chord(bar.chord);
      const t = bar.startS;
      pad(kit, chord.notes, t, length - 0.9, { layers: [{ wave: 'sawtooth', detunes: [-6, 6] }], attack: 0.15, release: 1.4, level: 0.055, cutoff: [1500, 700], q: 0.5, verb: 0.5 });
      chord.notes.forEach((note, index) => pluck(kit, note + 12, t + (index * 0.07), { level: 0.045, decayS: 1.6, verb: 0.5, delay: 0.3 }));
      bass(kit, chord.root, t, length - 1, { kind: 'round', level: 0.3, release: 0.8 });
      crash(kit, t, { level: 0.05 });
    },
  },

  lofi: {
    level: 0.175,
    humanize: 0.007,
    reverb: { seconds: 1.8, damping: 0.65 },
    delay: { beats: 0.75, feedback: 0.3, level: 0.16, tone: 2200 },
    wobble: { depthS: 0.0016, rateHz: 0.5, flutterS: 0.00005, flutterHz: 6.1 },
    tone: 7800,
    kick: { startHz: 115, endHz: 50, sweepS: 0.07, decayS: 0.36, click: 0.12, drive: 1.3, lowpass: 1500, level: 0.9 },
    setup(kit) {
      kit.ep = electricPianoBus(kit, { tremoloHz: 4.2, depth: 0.3, tone: 3800, verb: 0.28, delay: 0.08 });
      kit.crackle = vinyl(kit, { level: 0.04 });
    },
    bar(kit, bar) {
      const chord = kit.chord(bar.chord);
      const next = kit.chord(bar.nextChord);
      const { beat } = kit;
      const groove = isGroove(bar);
      const lift = bar.section === 'lift';
      const b = bar.variant === 'B';
      kit.crackle.setTargetAtTime(groove ? 0.024 : 0.04, Math.max(0, bar.startS), 0.4);
      const comping = !groove ? [[0, 3.9, 0.62]] : b ? [[0, 1.45, 0.8], [1.5, 0.45, 0.5], [2.5, 1.4, 0.68]] : [[0, 2.4, 0.78], [2.5, 1.45, 0.6]];
      for (const [pos, beats, velocity] of comping) strum(kit, chord.notes, kit.time(bar, pos), beats * beat, velocity, { level: 0.085 });
      if (!groove) return;
      // Root, a pickup, the fifth, and a chromatic approach into the next chord.
      const approach = next.root === chord.root ? chord.root + 7 : next.root - 1;
      for (const [pos, note, beats] of [[0, chord.root, 1.5], [2.5, chord.root, 0.45], [3, chord.root + 7, 0.6], [3.75, approach, 0.25]]) {
        bass(kit, note, kit.time(bar, pos), beats * beat, { kind: 'round', level: 0.36 });
      }
      for (const hit of kit.steps(b ? 'x......o..x.....' : 'x.........x.....')) kick(kit, kit.time(bar, hit.pos), hit.velocity);
      for (const pos of [1, 3]) snare(kit, kit.time(bar, pos), { level: 0.3, tone: 185, noiseHp: 900, noiseLp: 5200, decayS: 0.17, verb: 0.22 });
      const hatPattern = bar.typing ? 'x...x...x...x...' : lift ? 'x-o-x-o-x-o-x-o-' : 'x.o.x.o.x.o.x.o.';
      playHats(kit, bar, kit.steps(hatPattern).map((hit) => ({ ...hit, level: 0.075, tone: 7000 })));
      if (bar.fill) snare(kit, kit.time(bar, 3.75), { velocity: 0.4, level: 0.26, tone: 185, noiseHp: 900, noiseLp: 5200, decayS: 0.12 });
      // A short hook in B phrases, only while the narrator is quiet.
      if (b && !bar.underVoice) {
        const tones = chord.notes.slice(-3).map((note) => note + 12);
        [[0.5, tones[2], 0.4], [1, tones[1], 0.9], [2.5, tones[0], 1.2]].forEach(([pos, note, beats]) => lead(kit, note, kit.time(bar, pos), beats * beat, { level: 0.04 }));
      }
    },
    riser(kit, span) {
      riser(kit, span.startS, span.endS, { level: 0.035, fromHz: 300, toHz: 2600, type: 'lowpass', q: 0.8, verb: 0.4 });
    },
    finale(kit, bar, length) {
      const chord = kit.chord(bar.chord);
      const t = bar.startS;
      kit.crackle.setTargetAtTime(0.045, t, 0.4);
      strum(kit, chord.notes, t, length - 0.6, 0.7, { spread: 0.07, level: 0.085, decayS: 3.5, sustain: 0.2, release: 0.8 });
      fmKeys(kit, chord.notes[chord.notes.length - 1] + 12, t + 0.35, length - 1, { velocity: 0.5, level: 0.05, dest: kit.ep, decayS: 2.5 });
      bass(kit, chord.root, t, length - 0.8, { kind: 'round', level: 0.34, release: 0.9 });
    },
  },

  synthwave: {
    level: 0.179,
    humanize: 0.002,
    reverb: { seconds: 3.4, damping: 0.35 },
    delay: { beats: 0.75, feedback: 0.4, level: 0.24, tone: 3200 },
    gated: { seconds: 0.34, predelayS: 0.004 },
    pump: { depth: 0.42, release: 0.17, roles: ['keys', 'bass'] },
    kick: { startHz: 150, endHz: 47, sweepS: 0.085, decayS: 0.4, click: 0.35, drive: 2.2, lowpass: 9000, level: 0.85 },
    bar(kit, bar) {
      const chord = kit.chord(bar.chord);
      const { beat } = kit;
      const groove = isGroove(bar);
      const lift = bar.section === 'lift';
      const b = bar.variant === 'B';
      const sweep = bar.index % 2 ? [2600, 1500] : [1200, 2600];
      const cutoff = !groove ? [450, bar.buildup ? 1400 : 900] : lift ? sweep.map((hz) => hz * 1.4) : sweep;
      pad(kit, chord.notes, bar.startS, kit.barS, { layers: [{ wave: 'sawtooth', detunes: [-28, -17, -7, 0, 7, 17, 28] }], attack: groove ? 0.04 : 1, release: 0.45, level: 0.05, cutoff, q: 1.1, width: 0.8, verb: 0.35 });
      if (!groove && !bar.buildup) return;
      const stepBeats = lift ? 0.25 : 0.5;
      for (let step = 0; step < 4 / stepBeats; step += 1) {
        const high = lift ? [0, 0, 1, 0][step % 4] : step % 2;
        bass(kit, chord.root - 12 + (high ? 12 : 0), kit.time(bar, step * stepBeats), stepBeats * beat * 0.8, { kind: 'saw', level: bar.buildup ? 0.18 : 0.24, cutoff: bar.buildup ? 220 : 320 });
      }
      if (!groove) return;
      for (let pos = 0; pos < 4; pos += 1) kick(kit, kit.time(bar, pos, 0));
      for (const pos of [1, 3]) snare(kit, kit.time(bar, pos), { level: 0.4, tone: 175, noiseHp: 900, decayS: 0.2, verb: 0.1, gated: 1 });
      const hats = kit.steps(bar.typing || !(b || lift) ? 'o.x.o.x.o.x.o.x.' : 'o-x-o-x-o-x-o-x-').map((hit) => ({ ...hit, level: 0.09 }));
      if ((b || lift) && !bar.typing) hats.find((hit) => hit.step === 14).open = true;
      playHats(kit, bar, hats);
      if (bar.fill && !bar.underVoice) [200, 165, 135, 110].forEach((hz, index) => tom(kit, kit.time(bar, 3 + (index * 0.25)), { hz, velocity: 0.7 + (index * 0.1), level: 0.4, pan: 0.4 - (index * 0.27) }));
      else if (bar.fill) [3.5, 3.75].forEach((pos) => snare(kit, kit.time(bar, pos), { velocity: 0.45, level: 0.35, tone: 175, gated: 0.6 }));
      if (b || lift) {
        const tones = [...chord.notes, chord.notes[0] + 12].map((note) => note + 12);
        const order = [0, 1, 2, 3, 4, 3, 2, 1];
        for (let step = 0; step < 16; step += 1) {
          pluck(kit, tones[order[step % 8]], kit.time(bar, step / 4), { wave: 'square', partials: [[1, 1]], level: bar.underVoice ? 0.016 : 0.028, decayS: 0.2, cutoff: 3400, cutoffEnd: 900, q: 2.5, pan: step % 2 ? 0.3 : -0.3, verb: 0.2, delay: 0.35 });
        }
      }
      if (bar.impact) {
        crash(kit, bar.startS, { level: 0.09 });
        subDrop(kit, bar.startS, { level: 0.28 });
      }
    },
    riser(kit, span) {
      riser(kit, span.startS, span.endS, { level: 0.07, fromHz: 400, toHz: 8000, tone: { from: 57, to: 81, level: 0.25 } });
    },
    finale(kit, bar, length) {
      const chord = kit.chord(bar.chord);
      const t = bar.startS;
      pad(kit, chord.notes, t, length - 0.7, { layers: [{ wave: 'sawtooth', detunes: [-28, -17, -7, 0, 7, 17, 28] }], attack: 0.02, release: 1, level: 0.055, cutoff: [2600, 500], q: 1.1, width: 0.8, verb: 0.55 });
      bass(kit, chord.root - 12, t, length - 0.9, { kind: 'saw', level: 0.24, cutoff: 260, env: 900, release: 0.8, decay: 1.5 });
      pluck(kit, chord.notes[3] + 12, t, { wave: 'square', partials: [[1, 1]], level: 0.028, decayS: 1.2, cutoff: 3000, cutoffEnd: 800, q: 2.5, delay: 0.5, verb: 0.3 });
      crash(kit, t, { level: 0.09 });
      subDrop(kit, t, { level: 0.22 });
    },
  },

  upbeat: {
    level: 0.146,
    humanize: 0.002,
    reverb: { seconds: 2, damping: 0.4 },
    delay: { beats: 0.75, feedback: 0.3, level: 0.18, tone: 4200 },
    pump: { depth: 0.55, release: 0.14, roles: ['keys', 'bass'] },
    kick: { startHz: 170, endHz: 52, sweepS: 0.065, decayS: 0.32, click: 0.5, drive: 2.8, lowpass: 12000, level: 0.9 },
    bar(kit, bar) {
      const chord = kit.chord(bar.chord);
      const { beat } = kit;
      const groove = isGroove(bar);
      const lift = bar.section === 'lift';
      const b = bar.variant === 'B';
      pad(kit, chord.notes, bar.startS, kit.barS, { layers: [{ wave: 'sawtooth', detunes: [-16, -6, 6, 16] }], attack: groove ? 0.02 : 0.9, release: 0.35, level: 0.035, cutoff: groove ? [2200] : [500, bar.buildup ? 2000 : 1300], q: 0.7, width: 0.7, verb: 0.3 });
      if (!groove && !bar.buildup) return;
      const stabs = lift ? 'x..x..x.x..x.xx.' : b ? 'x..x..x...x..x..' : '..x...x...x...x.';
      for (const hit of kit.steps(stabs)) {
        stab(kit, chord.notes, kit.time(bar, hit.pos), { velocity: hit.velocity, level: bar.underVoice ? 0.03 : 0.045, cutoff: bar.buildup ? [1500, 500] : [5200, 900], decayS: 0.22, filterS: 0.13, verb: 0.2, delay: 0.15 });
      }
      if (!groove) return;
      for (const pos of [0.5, 1.5, 2.5, 3.5]) bass(kit, chord.root, kit.time(bar, pos), beat * 0.4, { kind: 'sub', level: 0.42 });
      if (b || lift) bass(kit, chord.root + 12, kit.time(bar, 3.75), beat * 0.2, { kind: 'sub', level: 0.24 });
      for (let pos = 0; pos < 4; pos += 1) kick(kit, kit.time(bar, pos, 0));
      for (const pos of [1, 3]) {
        const t = kit.time(bar, pos);
        clap(kit, t, { level: 0.42, verb: 0.22 });
        snare(kit, t, { level: 0.14, tone: 220, decayS: 0.12, verb: 0.05 });
      }
      const hats = [0.5, 1.5, 2.5, 3.5].map((pos) => ({ pos, open: true, decayS: 0.17, level: 0.1 }));
      if ((b || lift) && !bar.typing) for (let step = 1; step < 16; step += 2) hats.push({ pos: step / 4, level: 0.045, velocity: step % 4 === 1 ? 0.7 : 1 });
      playHats(kit, bar, hats);
      if (bar.fill) [12, 13, 14, 15].forEach((step, index) => clap(kit, kit.time(bar, step / 4), { velocity: 0.35 + (index * 0.15), level: 0.3, verb: 0.3 }));
      if (bar.impact) {
        crash(kit, bar.startS, { level: 0.08 });
        subDrop(kit, bar.startS, { level: 0.2, fromHz: 90 });
      }
    },
    riser(kit, span) {
      riser(kit, span.startS, span.endS, { level: 0.08, fromHz: 500, toHz: 10000, tone: { from: 55, to: 79, level: 0.2 } });
    },
    finale(kit, bar, length) {
      const chord = kit.chord(bar.chord);
      const t = bar.startS;
      stab(kit, chord.notes, t, { level: 0.05, decayS: 0.7, cutoff: [5200, 1200], filterS: 0.4, verb: 0.4, delay: 0.3 });
      pad(kit, chord.notes, t, length - 0.7, { layers: [{ wave: 'sawtooth', detunes: [-16, -6, 6, 16] }], attack: 0.01, release: 1.2, level: 0.045, cutoff: [2600, 600], q: 0.7, width: 0.7, verb: 0.5 });
      bass(kit, chord.root, t, length - 1, { kind: 'sub', level: 0.4, release: 0.6, decay: 2, sustain: 0.5 });
      crash(kit, t, { level: 0.08 });
      subDrop(kit, t, { level: 0.2, fromHz: 90 });
    },
  },

  ambient: {
    level: 0.2,
    reverb: { seconds: 6.5, damping: 0.5, predelayS: 0.035 },
    delay: { beats: 1.5, feedback: 0.45, level: 0.28, tone: 2400 },
    bar(kit, bar) {
      const chord = kit.chord(bar.chord);
      const { beat } = kit;
      const groove = isGroove(bar);
      const lift = bar.section === 'lift';
      const b = bar.variant === 'B';
      if (bar.chordStart) {
        const length = (bar.chordBars || 1) * kit.barS;
        pad(kit, chord.notes, bar.startS, length, { layers: [{ wave: 'triangle', detunes: [-7, 7] }, { wave: 'sawtooth', detunes: [-11, 11], gain: 0.3 }], attack: 2.2, release: 3.2, level: 0.07, cutoff: lift ? [800, 2600, 1600] : [600, 1500, 900], q: 0.4, width: 0.8, verb: 0.65 });
        if (groove) bass(kit, chord.root, bar.startS, length, { kind: 'swell', level: 0.16 });
        if (groove && (b || lift)) {
          pad(kit, chord.notes.slice(1), bar.startS + beat, length, { layers: [{ wave: 'sine', detunes: [-4, 4], octave: 1 }, { wave: 'sine', detunes: [0], octave: 2, gain: 0.5 }], attack: 2.8, release: 3, level: 0.022, cutoff: [7000], verb: 0.9, delay: 0.25 });
        }
      }
      if (!groove) return;
      const tones = [chord.root + 24, chord.root + 31];
      const stepBeats = lift ? 0.25 : 0.5;
      for (let step = 0; step < 4 / stepBeats; step += 1) {
        const onBeat = (step * stepBeats) % 1 === 0;
        pluck(kit, tones[onBeat ? 0 : 1], kit.time(bar, step * stepBeats), { wave: 'sine', partials: [[1, 1], [2, 0.15]], velocity: onBeat ? 1 : 0.6, level: bar.underVoice ? 0.018 : 0.026, decayS: 0.4, cutoff: 1500, verb: 0.35, delay: 0.3 });
      }
      if ((b || lift) && !bar.underVoice) {
        for (let twinkle = 0; twinkle < 2; twinkle += 1) {
          const pos = Math.floor(kit.random() * 8) / 2;
          const note = chord.notes[Math.floor(kit.random() * chord.notes.length)] + 24;
          fmKeys(kit, note, kit.time(bar, pos), 0.5, { ratio: 3.5, index: 0.9, indexFloor: 0.05, indexDecayS: 0.8, tine: 0, decayS: 3, sustain: 0, release: 2.5, level: 0.03, verb: 0.8, delay: 0.4 });
        }
      }
    },
    riser(kit, span) {
      riser(kit, span.startS, span.endS, { level: 0.03, fromHz: 250, toHz: 2500, type: 'lowpass', q: 0.7, verb: 0.6 });
    },
    finale(kit, bar, length) {
      const chord = kit.chord(bar.chord);
      const t = bar.startS;
      pad(kit, chord.notes, t, length - 1.2, { layers: [{ wave: 'triangle', detunes: [-7, 7] }, { wave: 'sawtooth', detunes: [-11, 11], gain: 0.3 }], attack: 0.9, release: 2.5, level: 0.07, cutoff: [1300, 700], q: 0.4, width: 0.8, verb: 0.7 });
      pad(kit, chord.notes.slice(1), t + 0.3, length - 1.2, { layers: [{ wave: 'sine', detunes: [-4, 4], octave: 1 }], attack: 1.2, release: 2.5, level: 0.02, cutoff: [7000], verb: 0.9, delay: 0.3 });
      bass(kit, chord.root, t, length - 1.2, { kind: 'swell', level: 0.14, attack: 0.8 });
    },
  },
};

// ------------------------------------------------------------------ entry

// Schedules a generated-music plan into `destination`. `solo` renders one
// role (drums, bass, keys, fx) for level checks.
export function scheduleMusic(context, destination, plan, { solo = null } = {}) {
  const sound = SOUNDS[plan.style];
  if (!sound) throw new Error(`No sound design for music style "${plan.style}".`);
  const kit = createKit(context, destination, plan, sound, { solo });
  sound.setup?.(kit);
  for (const bar of plan.bars) {
    if (bar.section === 'outro') sound.finale(kit, bar, Math.max(0.6, plan.endS - bar.startS));
    else sound.bar(kit, bar);
  }
  for (const span of plan.risers) sound.riser?.(kit, span);
  finishPump(kit);
  return kit;
}

export async function loadMusicFile(context, plan) {
  const bytes = await fetch(plan.file).then((response) => {
    if (!response.ok) throw new Error(`Music file ${plan.file} returned ${response.status}.`);
    return response.arrayBuffer();
  });
  try {
    return await context.decodeAudioData(bytes);
  } catch (error) {
    throw new Error(`Could not decode music file ${plan.file}: ${error.message}`);
  }
}

// A user-supplied track: trimmed or looped (with a crossfade) to the video,
// loudness-matched to the generated styles so `volume` means the same thing,
// and faded in and out.
export function scheduleMusicFile(context, destination, plan, decoded) {
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, index) => decoded.getChannelData(index));
  const stitched = stitchLoop(channels, decoded.sampleRate, { startS: plan.startAtS, lengthS: plan.endS, loop: plan.loop, crossfadeS: plan.crossfadeS });
  const audible = plan.loop ? stitched[0].length : Math.min(stitched[0].length, Math.max(0, decoded.length - Math.round(plan.startAtS * decoded.sampleRate)));
  let sum = 0;
  for (const data of stitched) for (let index = 0; index < audible; index += 1) sum += data[index] * data[index];
  const rms = Math.sqrt(sum / Math.max(1, audible * stitched.length));
  const level = plan.normalize && rms > 1e-5 ? clamp(MUSIC_REFERENCE_RMS / rms, 0.05, 4) : 1;
  const buffer = context.createBuffer(stitched.length, Math.max(1, stitched[0].length), decoded.sampleRate);
  stitched.forEach((data, index) => buffer.copyToChannel(data, index));
  const source = context.createBufferSource();
  source.buffer = buffer;
  const fader = gainNode(context, 0);
  const fadeIn = Math.max(0.01, plan.fadeInS);
  const fadeOutStart = Math.max(fadeIn, plan.endS - plan.fadeOutS);
  fader.gain.setValueAtTime(0, 0);
  fader.gain.linearRampToValueAtTime(level, fadeIn);
  fader.gain.setValueAtTime(level, fadeOutStart);
  fader.gain.linearRampToValueAtTime(0, Math.max(fadeOutStart + 0.01, plan.endS));
  source.connect(fader).connect(destination);
  source.start(0);
  return { level, rms };
}
