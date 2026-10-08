// Frame-by-frame MP4 export with WebCodecs. Every output frame is drawn at an
// exact timestamp (no screen capture, no dropped frames), so a render is
// deterministic and runs faster than real time in headless Chrome.

import { ArrayBufferTarget, Muxer } from '/node_modules/mp4-muxer/build/mp4-muxer.mjs';
import { renderMix } from './audio.js';
import { Compositor } from './compositor.js';

// H.264 High profile; level 5.1/5.2 for 4K, 4.2 for 1080p60.
const VIDEO_CODECS = ['avc1.64002A', 'avc1.640028', 'avc1.4D402A', 'avc1.42E02A'];
const VIDEO_CODECS_4K = ['avc1.640033', 'avc1.640034', 'avc1.4D4033'];
const AUDIO_CODECS = [{ codec: 'mp4a.40.2', muxer: 'aac' }, { codec: 'opus', muxer: 'opus' }];

async function pickVideoCodec(config) {
  const candidates = config.width * config.height > 1920 * 1088 ? VIDEO_CODECS_4K : VIDEO_CODECS;
  for (const codec of candidates) {
    const { supported } = await VideoEncoder.isConfigSupported({ ...config, codec });
    if (supported) return codec;
  }
  throw new Error('This browser cannot encode H.264 with WebCodecs.');
}

async function pickAudioCodec(config) {
  for (const option of AUDIO_CODECS) {
    const { supported } = await AudioEncoder.isConfigSupported({ ...config, codec: option.codec });
    if (supported) return option;
  }
  return null;
}

function waitForQueue(encoder, limit) {
  if (encoder.encodeQueueSize <= limit) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (encoder.encodeQueueSize <= limit) resolve();
      else encoder.addEventListener('dequeue', check, { once: true });
    };
    encoder.addEventListener('dequeue', check, { once: true });
  });
}

export async function renderToMp4(project, { canvas, onProgress = () => {} } = {}) {
  const { width, height, fps } = project.output;
  const target = canvas || document.createElement('canvas');
  target.width = width;
  target.height = height;
  const context = target.getContext('2d', { alpha: false });
  const compositor = await Compositor.create(project);
  const motionBlur = project.output.motionBlur !== false;

  onProgress({ stage: 'audio', progress: 0 });
  const mix = await renderMix(project);
  const videoConfig = { width, height, bitrate: project.output.bitrate || Math.round(width * height * fps * 0.11), framerate: fps, latencyMode: 'quality', avc: { format: 'avc' } };
  const videoCodec = await pickVideoCodec(videoConfig);
  const audioConfig = { sampleRate: mix.sampleRate, numberOfChannels: mix.numberOfChannels, bitrate: 192000 };
  const audioCodec = await pickAudioCodec(audioConfig);

  const muxTarget = new ArrayBufferTarget();
  const muxer = new Muxer({
    target: muxTarget,
    fastStart: 'in-memory',
    firstTimestampBehavior: 'offset',
    video: { codec: 'avc', width, height, frameRate: fps },
    ...(audioCodec ? { audio: { codec: audioCodec.muxer, numberOfChannels: mix.numberOfChannels, sampleRate: mix.sampleRate } } : {}),
  });
  let failure = null;
  const videoEncoder = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (error) => { failure = error; } });
  videoEncoder.configure({ ...videoConfig, codec: videoCodec });

  if (audioCodec) {
    const audioEncoder = new AudioEncoder({ output: (chunk, meta) => muxer.addAudioChunk(chunk, meta), error: (error) => { failure = error; } });
    audioEncoder.configure({ ...audioConfig, codec: audioCodec.codec });
    const channels = Array.from({ length: mix.numberOfChannels }, (_, index) => mix.getChannelData(index));
    const chunk = 4800;
    for (let start = 0; start < mix.length; start += chunk) {
      const frames = Math.min(chunk, mix.length - start);
      const data = new Float32Array(frames * channels.length);
      channels.forEach((channel, index) => data.set(channel.subarray(start, start + frames), index * frames));
      const audioData = new AudioData({ format: 'f32-planar', sampleRate: mix.sampleRate, numberOfFrames: frames, numberOfChannels: channels.length, timestamp: Math.round((start / mix.sampleRate) * 1e6), data });
      audioEncoder.encode(audioData);
      audioData.close();
    }
    await audioEncoder.flush();
  }

  const totalFrames = Math.ceil((project.timeline.outDurationMs / 1000) * fps);
  const started = performance.now();
  for (let index = 0; index < totalFrames; index += 1) {
    if (failure) throw failure;
    const outMs = (index * 1000) / fps;
    await compositor.prepare(outMs, { motionBlur });
    compositor.draw(context, outMs, { motionBlur });
    const frame = new VideoFrame(target, { timestamp: Math.round((index * 1e6) / fps), duration: Math.round(1e6 / fps) });
    videoEncoder.encode(frame, { keyFrame: index % (fps * 2) === 0 });
    frame.close();
    await waitForQueue(videoEncoder, 6);
    if (index % fps === 0) onProgress({ stage: 'video', progress: index / totalFrames, elapsedMs: performance.now() - started });
  }
  await videoEncoder.flush();
  if (failure) throw failure;
  muxer.finalize();
  onProgress({ stage: 'done', progress: 1, elapsedMs: performance.now() - started });
  return {
    blob: new Blob([muxTarget.buffer], { type: 'video/mp4' }),
    videoCodec,
    audioCodec: audioCodec?.codec || null,
    frames: totalFrames,
  };
}
