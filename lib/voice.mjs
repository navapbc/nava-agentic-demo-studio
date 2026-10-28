import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

export const VOICE_SCHEMA = 'nava.demo-voice.v1';
export const KOKORO_MODEL = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const MOUTH_HZ = 60;

// Reads a 16-bit PCM WAV file (what `say` and writeWav produce).
export function parseWav(buffer) {
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a RIFF/WAVE file.');
  let offset = 12;
  let format;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('ascii', offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (id === 'data') {
      if (!format) throw new Error('WAV data chunk appears before its format chunk.');
      if (format.audioFormat !== 1 || format.bitsPerSample !== 16) throw new Error('Only 16-bit PCM WAV is supported.');
      const frames = Math.floor(Math.min(size, buffer.length - body) / (2 * format.channels));
      const samples = new Float32Array(frames);
      for (let frame = 0; frame < frames; frame += 1) {
        let total = 0;
        for (let channel = 0; channel < format.channels; channel += 1) total += buffer.readInt16LE(body + (((frame * format.channels) + channel) * 2));
        samples[frame] = total / format.channels / 32768;
      }
      return { ...format, samples, durationMs: (frames / format.sampleRate) * 1000 };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV file has no data chunk.');
}

export function encodeWav(samples, sampleRate) {
  const data = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767), index * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// RMS loudness at `hz` frames per second, normalized to 0-100 against the
// clip's own 95th percentile so quiet and loud voices animate the same way.
export function loudnessEnvelope(samples, sampleRate, hz = MOUTH_HZ) {
  const window = Math.max(1, Math.round(sampleRate / hz));
  const values = [];
  for (let start = 0; start < samples.length; start += window) {
    let sum = 0;
    const end = Math.min(samples.length, start + window);
    for (let index = start; index < end; index += 1) sum += samples[index] * samples[index];
    values.push(Math.sqrt(sum / Math.max(1, end - start)));
  }
  return normalize(values, 0.08).map((value) => Math.round(value * 100));
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;
}

function normalize(values, floorShare) {
  const reference = percentile(values, 0.95) || 1;
  const floor = reference * floorShare;
  return values.map((value) => Math.min(1, Math.max(0, (value - floor) / Math.max(1e-9, reference - floor))));
}

function fft(re, im) {
  const size = re.length;
  for (let index = 1, swap = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [re[index], re[swap]] = [re[swap], re[index]];
      [im[index], im[swap]] = [im[swap], im[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepRe = Math.cos(angle);
    const stepIm = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let rotRe = 1;
      let rotIm = 0;
      for (let offset = 0; offset < length / 2; offset += 1) {
        const a = start + offset;
        const b = a + (length / 2);
        const tRe = (re[b] * rotRe) - (im[b] * rotIm);
        const tIm = (re[b] * rotIm) + (im[b] * rotRe);
        re[b] = re[a] - tRe;
        im[b] = im[a] - tIm;
        re[a] += tRe;
        im[a] += tIm;
        const nextRe = (rotRe * stepRe) - (rotIm * stepIm);
        rotIm = (rotRe * stepIm) + (rotIm * stepRe);
        rotRe = nextRe;
      }
    }
  }
}

function smooth(values, radius) {
  return values.map((_, index) => {
    let total = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const value = values[index + offset];
      if (value === undefined) continue;
      total += value;
      count += 1;
    }
    return total / count;
  });
}

// Audio-driven mouth track at `hz` frames per second:
//   open    jaw opening from voiced (150-3500 Hz) energy, 0-100
//   wide    lip spread from the second-formant region: "ee" spreads (+),
//           "oo" rounds (-), -100..100
//   accent  onset strength of stressed syllables, drives nods and brows, 0-100
export function analyzeMouth(samples, sampleRate, hz = MOUTH_HZ) {
  const size = 1024;
  const hop = sampleRate / hz;
  const frames = Math.ceil(samples.length / hop);
  const hann = Float32Array.from({ length: size }, (_, index) => 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / (size - 1))));
  const binHz = sampleRate / size;
  const band = (low, high) => [Math.max(1, Math.floor(low / binHz)), Math.min((size / 2) - 1, Math.ceil(high / binHz))];
  const [voicedLow, voicedHigh] = band(150, 3500);
  const [formantLow, formantHigh] = band(900, 2800);
  const [hissLow, hissHigh] = band(4500, 11000);
  const voiced = [];
  const centroid = [];
  const hiss = [];
  const re = new Float32Array(size);
  const im = new Float32Array(size);
  for (let frame = 0; frame < frames; frame += 1) {
    const center = Math.round(frame * hop);
    for (let index = 0; index < size; index += 1) {
      const sample = samples[center - (size / 2) + index] ?? 0;
      re[index] = sample * hann[index];
      im[index] = 0;
    }
    fft(re, im);
    let voicedEnergy = 0;
    let weighted = 0;
    let magnitude = 0;
    let hissEnergy = 0;
    for (let bin = voicedLow; bin <= Math.max(voicedHigh, hissHigh); bin += 1) {
      const power = (re[bin] * re[bin]) + (im[bin] * im[bin]);
      if (bin <= voicedHigh) voicedEnergy += power;
      if (bin >= formantLow && bin <= formantHigh) {
        const amplitude = Math.sqrt(power);
        weighted += amplitude * bin * binHz;
        magnitude += amplitude;
      }
      if (bin >= hissLow && bin <= hissHigh) hissEnergy += power;
    }
    voiced.push(Math.sqrt(voicedEnergy));
    centroid.push(magnitude ? weighted / magnitude : 0);
    hiss.push(hissEnergy / (voicedEnergy + hissEnergy + 1e-12));
  }
  const open = smooth(normalize(voiced, 0.1), 1).map((value) => value ** 0.85);
  const speaking = centroid.filter((_, index) => open[index] > 0.25);
  // Center on the midpoint of the 20th-80th percentile range (not the median)
  // so a clip dominated by one vowel still spreads and rounds symmetrically.
  const low = percentile(speaking, 0.2);
  const high = percentile(speaking, 0.8);
  const median = (low + high) / 2;
  const spread = Math.max(80, ((high - low) / 2) * 1.2);
  const wide = smooth(centroid.map((value, index) => {
    if (open[index] < 0.12) return 0;
    const spreadLips = Math.max(-1, Math.min(1, (value - median) / spread));
    return Math.max(-1, Math.min(1, spreadLips + (hiss[index] > 0.35 ? 0.35 : 0)));
  }), 3);
  const onset = open.map((value, index) => {
    let previous = 0;
    for (let back = 1; back <= 6; back += 1) previous += open[index - back] ?? 0;
    return Math.max(0, value - (previous / 6));
  });
  const accentScale = percentile(onset.filter((value) => value > 0), 0.95) || 1;
  // Keep only clear peaks at least ~250 ms apart so the head nods on stressed
  // syllables rather than bobbing continuously.
  const strength = onset.map((value) => Math.min(1, value / accentScale));
  const reach = Math.round(hz * 0.25);
  const accent = strength.map((value, index) => {
    if (value < 0.45) return 0;
    for (let offset = -reach; offset <= reach; offset += 1) {
      const other = strength[index + offset] ?? 0;
      if (other > value || (other === value && offset < 0)) return 0;
    }
    return value;
  });
  return {
    hz,
    open: open.map((value) => Math.round(value * 100)),
    wide: wide.map((value) => Math.round(value * 100)),
    accent: accent.map((value) => Math.round(value * 100)),
  };
}

export async function listSayVoices() {
  try {
    const { stdout } = await run('say', ['-v', '?']);
    return stdout.split('\n').map((line) => line.match(/^(.+?)\s+([a-z]{2}_[A-Z]{2})\s+#/)).filter(Boolean).map((match) => ({ name: match[1].trim(), locale: match[2] }));
  } catch {
    return [];
  }
}

async function sayProvider(options) {
  const voices = await listSayVoices();
  if (!voices.length) throw new Error('macOS `say` is unavailable. Use "voice": { "provider": "none" } to render captions without a voiceover.');
  if (options.voice && !voices.some((entry) => entry.name === options.voice)) {
    throw new Error(`Voice "${options.voice}" is not installed. Installed English voices: ${voices.filter((entry) => entry.locale.startsWith('en_')).map((entry) => entry.name).join(', ')}.`);
  }
  return {
    name: 'say',
    voice: options.voice || null,
    async synthesize(text, path) {
      const args = ['--file-format=WAVE', '--data-format=LEI16@24000', '-o', path];
      if (options.voice) args.unshift('-v', options.voice);
      if (options.rate) args.unshift('-r', String(options.rate));
      // Narration is input, never a command option (or process-list content).
      const speech = run('say', [...args, '-f', '-']);
      // The process promise reports launch/exit failures; avoid a second,
      // unhandled EPIPE if say exits before accepting its input.
      speech.child.stdin.on('error', () => {});
      speech.child.stdin.end(text);
      await speech;
      return parseWav(await readFile(path));
    },
  };
}

// Kokoro-82M (Apache-2.0) runs locally through ONNX Runtime. The model is
// downloaded once from Hugging Face into ~/.cache/nava-demo-studio/models.
export async function kokoroAvailable() {
  try {
    await import('kokoro-js');
    return true;
  } catch {
    return false;
  }
}

async function kokoroProvider(options) {
  let KokoroTTS;
  try {
    ({ KokoroTTS } = await import('kokoro-js'));
  } catch {
    throw new Error('The kokoro voice needs the optional "kokoro-js" dependency. Run `npm install` (without --omit=optional) or use "provider": "say".');
  }
  try {
    const { env } = await import('@huggingface/transformers');
    env.cacheDir = process.env.DEMO_STUDIO_MODEL_CACHE || join(homedir(), '.cache', 'nava-demo-studio', 'models');
  } catch {
    // Fall back to the library's default cache location.
  }
  const tts = await KokoroTTS.from_pretrained(options.model || KOKORO_MODEL, { dtype: options.dtype || 'fp32', device: 'cpu' });
  const voice = options.voice || 'af_heart';
  if (!tts.voices[voice]) throw new Error(`Kokoro voice "${voice}" does not exist. Try one of: ${Object.keys(tts.voices).join(', ')}.`);
  return {
    name: 'kokoro',
    voice,
    async synthesize(text, path) {
      const audio = await tts.generate(text, { voice, speed: options.speed || 1 });
      const samples = audio.audio;
      await writeFile(path, encodeWav(samples, audio.sampling_rate));
      return { samples, sampleRate: audio.sampling_rate, durationMs: (samples.length / audio.sampling_rate) * 1000 };
    },
  };
}

// "auto" prefers the neural Kokoro voice, then macOS `say`, then no voice.
export async function resolveVoiceProvider(options = {}) {
  const requested = options.provider || 'auto';
  if (requested === 'none') return null;
  if (requested === 'kokoro') return kokoroProvider(options);
  if (requested === 'say') return sayProvider(options);
  if (requested !== 'auto') throw new Error(`Unknown voice provider "${requested}". Supported: auto, kokoro, say, none.`);
  if (await kokoroAvailable()) return kokoroProvider({ ...options, voice: options.kokoroVoice || (options.voice?.includes('_') ? options.voice : undefined) });
  if ((await listSayVoices()).length) return sayProvider({ ...options, voice: options.voice?.includes('_') ? undefined : options.voice });
  return null;
}

// Speech level every narration clip is normalized to, so voices from any
// provider sit at the same place in the mix (music is planned around it).
export const SPEECH_TARGET_DB = -16;

// Scales a clip so its voiced passages reach `targetDb` RMS, without letting
// peaks exceed -1 dBFS.
export function normalizeSpeech(samples, targetDb = SPEECH_TARGET_DB) {
  let sum = 0;
  let count = 0;
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
    if (magnitude > 0.02) {
      sum += sample * sample;
      count += 1;
    }
  }
  if (!count) return { samples, gainDb: 0 };
  const rmsDb = 10 * Math.log10(sum / count);
  const gain = Math.min(10 ** ((targetDb - rmsDb) / 20), 0.89 / Math.max(peak, 1e-6), 8);
  return { samples: samples.map((sample) => sample * gain), gainDb: Number((20 * Math.log10(gain)).toFixed(1)) };
}

// Synthesizes every narration line in a demo script. Returns a manifest keyed
// by clip id with the measured duration and an audio-driven mouth track.
export async function synthesizeNarration(lines, outDir, options = {}) {
  const manifest = { schema: VOICE_SCHEMA, provider: 'none', voice: null, clips: {} };
  if (!lines.length) return manifest;
  const provider = await resolveVoiceProvider(options);
  if (!provider) return manifest;
  Object.assign(manifest, { provider: provider.name, voice: provider.voice });
  await mkdir(outDir, { recursive: true });
  for (const line of lines) {
    const path = join(outDir, `${line.id}.wav`);
    const audio = await provider.synthesize(line.text, path);
    const leveled = normalizeSpeech(audio.samples);
    await writeFile(path, encodeWav(leveled.samples, audio.sampleRate));
    const mouth = analyzeMouth(audio.samples, audio.sampleRate);
    manifest.clips[line.id] = {
      file: path,
      text: line.text,
      durationMs: Math.round(audio.durationMs),
      gainDb: leveled.gainDb,
      envelopeHz: mouth.hz,
      envelope: mouth.open,
      mouth,
    };
  }
  await writeFile(join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
