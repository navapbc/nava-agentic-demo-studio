// Pure audio measurements for checking rendered music without listening to
// it: levels, per-bar loudness, spectral band balance, a spectrogram, and a
// 16-bit PCM WAV encoder. Shared by the browser tool page and the tests.

export const toDb = (value) => (value > 1e-9 ? 20 * Math.log10(value) : -180);
const round = (value, places = 1) => Number(value.toFixed(places));

export function levels(channels, start = 0, end = channels[0]?.length || 0) {
  let sum = 0;
  let peak = 0;
  let count = 0;
  for (const data of channels) {
    for (let index = Math.max(0, start); index < Math.min(end, data.length); index += 1) {
      const sample = data[index];
      sum += sample * sample;
      const magnitude = Math.abs(sample);
      if (magnitude > peak) peak = magnitude;
      count += 1;
    }
  }
  return { rms: count ? Math.sqrt(sum / count) : 0, peak };
}

// In-place iterative radix-2 FFT.
export function fft(real, imaginary) {
  const size = real.length;
  for (let index = 1, swap = 0; index < size; index += 1) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [real[index], real[swap]] = [real[swap], real[index]];
      [imaginary[index], imaginary[swap]] = [imaginary[swap], imaginary[index]];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let offset = 0; offset < size; offset += length) {
      let twiddleReal = 1;
      let twiddleImaginary = 0;
      for (let index = 0; index < length / 2; index += 1) {
        const even = offset + index;
        const odd = even + (length / 2);
        const oddReal = (real[odd] * twiddleReal) - (imaginary[odd] * twiddleImaginary);
        const oddImaginary = (real[odd] * twiddleImaginary) + (imaginary[odd] * twiddleReal);
        real[odd] = real[even] - oddReal;
        imaginary[odd] = imaginary[even] - oddImaginary;
        real[even] += oddReal;
        imaginary[even] += oddImaginary;
        const nextReal = (twiddleReal * stepReal) - (twiddleImaginary * stepImaginary);
        twiddleImaginary = (twiddleReal * stepImaginary) + (twiddleImaginary * stepReal);
        twiddleReal = nextReal;
      }
    }
  }
}

// Short-time power spectra of the mono downmix: `columns` Hann-windowed frames
// spread evenly over the signal. `power[column * bins + bin]` is linear power,
// normalized so a full-scale sine reads about 0 dB.
export function spectrogram(channels, sampleRate, { columns = 1200, fftSize = 4096 } = {}) {
  const length = channels[0].length;
  const bins = fftSize / 2;
  const power = new Float32Array(columns * bins);
  const window = Float32Array.from({ length: fftSize }, (_, index) => 0.5 - (0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1))));
  const scale = 2 / (fftSize * 0.5);
  const real = new Float64Array(fftSize);
  const imaginary = new Float64Array(fftSize);
  for (let column = 0; column < columns; column += 1) {
    const center = Math.round(((column + 0.5) / columns) * length);
    const start = center - (fftSize / 2);
    for (let index = 0; index < fftSize; index += 1) {
      const at = start + index;
      let sample = 0;
      if (at >= 0 && at < length) for (const data of channels) sample += data[at];
      real[index] = (sample / channels.length) * window[index];
      imaginary[index] = 0;
    }
    fft(real, imaginary);
    for (let bin = 0; bin < bins; bin += 1) {
      const magnitude = Math.hypot(real[bin], imaginary[bin]) * scale;
      power[(column * bins) + bin] = magnitude * magnitude;
    }
  }
  return { columns, bins, fftSize, sampleRate, secondsPerColumn: length / sampleRate / columns, power };
}

export const BANDS = [
  ['sub', 20, 120],
  ['low', 120, 400],
  ['mid', 400, 2000],
  ['presence', 2000, 6000],
  ['air', 6000, 16000],
];

// Average power per band (dB) over the spectrogram columns inside [startS, endS).
export function bandLevels(spectrum, startS = 0, endS = Infinity) {
  const { columns, bins, fftSize, sampleRate, secondsPerColumn, power } = spectrum;
  const from = Math.max(0, Math.floor(startS / secondsPerColumn));
  const to = Math.min(columns, Math.ceil(endS / secondsPerColumn));
  const result = {};
  for (const [name, low, high] of BANDS) {
    const firstBin = Math.max(1, Math.floor((low * fftSize) / sampleRate));
    const lastBin = Math.min(bins - 1, Math.ceil((high * fftSize) / sampleRate));
    let total = 0;
    for (let column = from; column < to; column += 1) {
      for (let bin = firstBin; bin <= lastBin; bin += 1) total += power[(column * bins) + bin];
    }
    result[name] = round(toDb(Math.sqrt(total / Math.max(1, to - from))));
  }
  return result;
}

// Whole-file and per-bar levels plus per-section band balance for a rendered
// music plan (see lib/music-plan.mjs).
export function analyzeMusic(channels, sampleRate, plan, spectrum = null) {
  const length = channels[0].length;
  const whole = levels(channels);
  const dc = channels.map((data) => round(data.reduce((sum, sample) => sum + sample, 0) / Math.max(1, data.length), 6));
  let clipped = 0;
  for (const data of channels) for (const sample of data) if (Math.abs(sample) >= 0.999) clipped += 1;
  const toSample = (seconds) => Math.max(0, Math.min(length, Math.round(seconds * sampleRate)));
  const bars = (plan.bars || []).map((bar) => {
    const endS = bar.section === 'outro' ? plan.endS : Math.min(bar.endS, plan.endS);
    const measured = levels(channels, toSample(Math.max(0, bar.startS)), toSample(endS));
    return { index: bar.index, startS: round(Math.max(0, bar.startS), 2), section: bar.section, variant: bar.variant, underVoice: bar.underVoice, rmsDb: round(toDb(measured.rms)), peakDb: round(toDb(measured.peak)) };
  });
  const sections = {};
  for (const section of ['intro', 'groove', 'lift', 'outro']) {
    const spans = (plan.bars || []).filter((bar) => bar.section === section).map((bar) => [Math.max(0, bar.startS), bar.section === 'outro' ? plan.endS : Math.min(bar.endS, plan.endS)]);
    if (!spans.length) continue;
    let sum = 0;
    let count = 0;
    for (const [startS, endS] of spans) {
      const measured = levels(channels, toSample(startS), toSample(endS));
      const samples = toSample(endS) - toSample(startS);
      sum += measured.rms * measured.rms * samples;
      count += samples;
    }
    sections[section] = {
      rmsDb: round(toDb(Math.sqrt(sum / Math.max(1, count)))),
      seconds: round(count / sampleRate, 2),
      ...(spectrum ? { bands: averageBands(spectrum, spans) } : {}),
    };
  }
  const voiceLevels = {};
  if (plan.voice?.length) {
    const inside = [];
    const outside = [];
    const grooveStart = plan.grooveS ?? 0;
    const grooveEnd = plan.finalS ?? plan.endS;
    const step = Math.round(sampleRate * 0.05);
    for (let at = toSample(grooveStart); at + step <= toSample(grooveEnd); at += step) {
      const seconds = at / sampleRate;
      const speaking = plan.voice.some(([from, to]) => seconds >= from + 0.4 && seconds + 0.05 <= to);
      const clear = plan.voice.every(([from, to]) => seconds + 0.05 < from - 0.4 || seconds > to + 1.2);
      if (speaking) inside.push(at);
      else if (clear) outside.push(at);
    }
    const pooled = (starts) => {
      let sum = 0;
      for (const at of starts) sum += levels(channels, at, at + step).rms ** 2;
      return starts.length ? round(toDb(Math.sqrt(sum / starts.length))) : null;
    };
    voiceLevels.underVoiceRmsDb = pooled(inside);
    voiceLevels.clearRmsDb = pooled(outside);
  }
  return {
    seconds: round(length / sampleRate, 2),
    rmsDb: round(toDb(whole.rms)),
    peakDb: round(toDb(whole.peak), 2),
    dc,
    clipped,
    sections,
    ...voiceLevels,
    bars,
  };
}

function averageBands(spectrum, spans) {
  const total = spans.reduce((sum, [startS, endS]) => sum + (endS - startS), 0) || 1;
  const sums = {};
  for (const [startS, endS] of spans) {
    const bands = bandLevels(spectrum, startS, endS);
    for (const [name, db] of Object.entries(bands)) sums[name] = (sums[name] || 0) + ((10 ** (db / 10)) * ((endS - startS) / total));
  }
  return Object.fromEntries(Object.entries(sums).map(([name, value]) => [name, round(10 * Math.log10(Math.max(value, 1e-18)))]));
}

// Interleaved 16-bit PCM WAV (browser- and Node-safe, no Buffer).
export function encodeWav16(channels, sampleRate) {
  const frames = channels[0].length;
  const channelCount = channels.length;
  const bytes = new Uint8Array(44 + (frames * channelCount * 2));
  const view = new DataView(bytes.buffer);
  const text = (offset, value) => [...value].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
  text(0, 'RIFF');
  view.setUint32(4, 36 + (frames * channelCount * 2), true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channelCount, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channelCount * 2, true);
  view.setUint16(32, channelCount * 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, frames * channelCount * 2, true);
  let offset = 44;
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channelCount; channel += 1) {
      const sample = Math.max(-1, Math.min(1, channels[channel][frame]));
      view.setInt16(offset, Math.round(sample * 32767), true);
      offset += 2;
    }
  }
  return bytes;
}
