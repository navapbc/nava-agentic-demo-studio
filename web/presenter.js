// Talking-head presenter drawn from a single portrait and a landmark rig.
//
// The lower face is split at the lip line into two triangle meshes. Speech
// displaces them: the jaw drops (the lower lip most, the chin less, the neck
// not at all), the upper lip lifts, the lips spread for "ee" and round for
// "oo", and the gap between the lips reveals a mouth interior with teeth.
// Stressed syllables drive small nods and eyebrow raises; blinks land at phrase
// ends and at random. Everything is a pure function of time and the voice
// track, so preview and export render identical frames.

import { clamp, lerp, smoothstep } from '/lib/timeline.mjs';

const TAU = Math.PI * 2;

// Abstract voice presence for demos that should not imply a human avatar.
// The orb breathes at rest, brightens with speech energy, and emits deterministic
// rings and filaments on stressed syllables. It is drawn entirely in Canvas so
// it stays crisp at every export resolution and needs no generated asset.
export class VoiceOrb {
  constructor({ speech = [] } = {}) {
    this.speech = speech;
  }

  draw(context, { x, y, size, tMs, mouth = 0, level, appear = 1, accent = '#8b5cf6' }) {
    if (appear <= 0) return;
    const state = typeof mouth === 'number' ? { open: level ?? mouth, wide: 0, nod: 0 } : mouth;
    const speaking = clamp(state.speaking ?? state.open ?? 0, 0, 1);
    const accentHit = clamp(state.nod ?? 0, 0, 1);
    const t = tMs / 1000;
    const radius = size * 0.34;
    const cx = x + (size / 2);
    const cy = y + (size / 2);
    const breathe = 1 + (0.025 * Math.sin(t * 2.1)) + (speaking * 0.08) + (accentHit * 0.04);
    const core = radius * breathe;
    const grow = lerp(0.78, 1, smoothstep(appear));
    const px = size / 300;

    context.save();
    context.globalAlpha = appear;
    context.translate(cx, cy);
    context.scale(grow, grow);
    context.translate(-cx, -cy);

    // Audio-reactive outer waves.
    context.globalCompositeOperation = 'screen';
    for (let ring = 0; ring < 3; ring += 1) {
      const phase = ((t * (0.23 + (ring * 0.035))) + (ring * 0.31)) % 1;
      const wave = radius * (1.12 + (phase * (0.3 + (speaking * 0.22))));
      context.strokeStyle = `rgba(173, 112, 255, ${(0.07 + (speaking * 0.18)) * (1 - phase)})`;
      context.lineWidth = (3.5 - ring) * px;
      context.beginPath();
      context.arc(cx, cy, wave, 0, TAU);
      context.stroke();
    }

    // Keep the core opaque over white application pages. Screen blending would
    // make it disappear even though the orb is drawn above the recording.
    context.globalCompositeOperation = 'source-over';
    // Soft purple glow and glassy core.
    context.shadowColor = accent;
    context.shadowBlur = (42 + (speaking * 48)) * px;
    const glow = context.createRadialGradient(cx - (core * 0.28), cy - (core * 0.32), core * 0.08, cx, cy, core * 1.15);
    glow.addColorStop(0, '#f4e8ff');
    glow.addColorStop(0.16, '#cf9cff');
    glow.addColorStop(0.48, accent);
    glow.addColorStop(0.78, '#6d28d9');
    glow.addColorStop(1, 'rgba(37, 15, 74, 0.92)');
    context.fillStyle = glow;
    context.beginPath();
    context.arc(cx, cy, core, 0, TAU);
    context.fill();
    context.shadowColor = 'transparent';

    // Rotating voice filaments make the orb read as active intelligence.
    context.save();
    context.beginPath();
    context.arc(cx, cy, core * 0.94, 0, TAU);
    context.clip();
    context.translate(cx, cy);
    context.rotate((t * 0.34) + (state.wide || 0) * 0.08);
    for (let strand = 0; strand < 5; strand += 1) {
      const offset = (strand - 2) * core * 0.22;
      const amplitude = core * (0.12 + (speaking * 0.15));
      context.strokeStyle = `rgba(255, 255, 255, ${0.1 + (speaking * 0.2)})`;
      context.lineWidth = (1.5 + (speaking * 2.2)) * px;
      context.beginPath();
      for (let step = 0; step <= 36; step += 1) {
        const u = (step / 36) * 2 - 1;
        const sx = u * core;
        const sy = offset + (Math.sin((u * Math.PI * (2.2 + strand * 0.18)) + (t * 3.2) + strand) * amplitude * (1 - Math.abs(u)));
        if (step === 0) context.moveTo(sx, sy);
        else context.lineTo(sx, sy);
      }
      context.stroke();
    }
    context.restore();

    // Specular highlight and a sharp rim preserve shape against light pages.
    const shine = context.createRadialGradient(cx - (core * 0.36), cy - (core * 0.42), 0, cx - (core * 0.3), cy - (core * 0.36), core * 0.72);
    shine.addColorStop(0, 'rgba(255, 255, 255, 0.72)');
    shine.addColorStop(0.18, 'rgba(255, 255, 255, 0.18)');
    shine.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.fillStyle = shine;
    context.beginPath();
    context.arc(cx, cy, core * 0.95, 0, TAU);
    context.fill();
    context.strokeStyle = `rgba(244, 226, 255, ${0.58 + (speaking * 0.25)})`;
    context.lineWidth = 3.5 * px;
    context.beginPath();
    context.arc(cx, cy, core, 0, TAU);
    context.stroke();
    context.restore();
  }
}

function seeded(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function blinkSchedule(seed, extra = [], untilMs = 20 * 60 * 1000) {
  const random = seeded(seed);
  const times = [...extra];
  for (let at = 1100; at < untilMs; at += 2600 + (random() * 3400)) {
    times.push(at);
    if (random() < 0.15) times.push(at + 280);
  }
  times.sort((left, right) => left - right);
  return times.filter((time, index) => index === 0 || time - times[index - 1] > 600 || time - times[index - 1] === 280);
}

// Quadratic through the two mouth corners and the lip-line center.
function lipLine(mouth) {
  const [x0, y0] = mouth.left;
  const [x1, y1] = mouth.center;
  const [x2, y2] = mouth.right;
  return (x) => {
    const l0 = ((x - x1) * (x - x2)) / ((x0 - x1) * (x0 - x2));
    const l1 = ((x - x0) * (x - x2)) / ((x1 - x0) * (x1 - x2));
    const l2 = ((x - x0) * (x - x1)) / ((x2 - x0) * (x2 - x1));
    return (y0 * l0) + (y1 * l1) + (y2 * l2);
  };
}

// Maps one source triangle onto one destination triangle with an affine
// transform. The destination is inflated slightly so neighbours overlap and no
// hairline seams show.
function drawTriangle(context, image, source, target) {
  const [[sx0, sy0], [sx1, sy1], [sx2, sy2]] = source;
  const [[dx0, dy0], [dx1, dy1], [dx2, dy2]] = target;
  const denominator = (sx0 * (sy1 - sy2)) + (sx1 * (sy2 - sy0)) + (sx2 * (sy0 - sy1));
  if (Math.abs(denominator) < 1e-6) return;
  const a = ((dx0 * (sy1 - sy2)) + (dx1 * (sy2 - sy0)) + (dx2 * (sy0 - sy1))) / denominator;
  const b = ((dy0 * (sy1 - sy2)) + (dy1 * (sy2 - sy0)) + (dy2 * (sy0 - sy1))) / denominator;
  const c = ((dx0 * (sx2 - sx1)) + (dx1 * (sx0 - sx2)) + (dx2 * (sx1 - sx0))) / denominator;
  const d = ((dy0 * (sx2 - sx1)) + (dy1 * (sx0 - sx2)) + (dy2 * (sx1 - sx0))) / denominator;
  const e = ((dx0 * ((sx1 * sy2) - (sx2 * sy1))) + (dx1 * ((sx2 * sy0) - (sx0 * sy2))) + (dx2 * ((sx0 * sy1) - (sx1 * sy0)))) / denominator;
  const f = ((dy0 * ((sx1 * sy2) - (sx2 * sy1))) + (dy1 * ((sx2 * sy0) - (sx0 * sy2))) + (dy2 * ((sx0 * sy1) - (sx1 * sy0)))) / denominator;
  const cx = (dx0 + dx1 + dx2) / 3;
  const cy = (dy0 + dy1 + dy2) / 3;
  const grow = (x, y) => {
    const length = Math.hypot(x - cx, y - cy) || 1;
    return [x + (((x - cx) / length) * 0.7), y + (((y - cy) / length) * 0.7)];
  };
  context.save();
  context.beginPath();
  context.moveTo(...grow(dx0, dy0));
  context.lineTo(...grow(dx1, dy1));
  context.lineTo(...grow(dx2, dy2));
  context.closePath();
  context.clip();
  context.transform(a, b, c, d, e, f);
  const left = Math.floor(Math.min(sx0, sx1, sx2)) - 2;
  const top = Math.floor(Math.min(sy0, sy1, sy2)) - 2;
  const width = Math.ceil(Math.max(sx0, sx1, sx2)) + 2 - left;
  const height = Math.ceil(Math.max(sy0, sy1, sy2)) + 2 - top;
  context.drawImage(image, left, top, width, height, left, top, width, height);
  context.restore();
}

// Draws a grid mesh: `rest[row][col]` are source points, `moved` the
// displaced destination points for the same indices.
function drawMesh(context, image, rest, moved) {
  for (let row = 0; row < rest.length - 1; row += 1) {
    for (let col = 0; col < rest[row].length - 1; col += 1) {
      const s00 = rest[row][col];
      const s10 = rest[row][col + 1];
      const s01 = rest[row + 1][col];
      const s11 = rest[row + 1][col + 1];
      const d00 = moved[row][col];
      const d10 = moved[row][col + 1];
      const d01 = moved[row + 1][col];
      const d11 = moved[row + 1][col + 1];
      drawTriangle(context, image, [s00, s10, s11], [d00, d10, d11]);
      drawTriangle(context, image, [s00, s11, s01], [d00, d11, d01]);
    }
  }
}

export class Presenter {
  static async load(imageUrl, rig, options) {
    const image = new Image();
    image.src = imageUrl;
    await image.decode();
    return new Presenter(image, rig, options);
  }

  constructor(image, rig, { speechEnds = [], speech = [] } = {}) {
    this.image = image;
    this.rig = rig || {
      crop: { cx: image.naturalWidth / 2, cy: image.naturalHeight * 0.42, r: Math.min(image.naturalWidth, image.naturalHeight) * 0.4 },
      pivot: { x: image.naturalWidth / 2, y: image.naturalHeight * 0.75 },
    };
    this.lipY = this.rig.mouth ? lipLine(this.rig.mouth) : null;
    this.speech = speech.length ? speech : speechEnds.map((end) => ({ start: end - 1, end }));
    this.blinks = blinkSchedule(this.rig.seed || 11, this.speech.map((span) => span.end + 180));
    this.face = document.createElement('canvas');
    if (this.rig.mouth) this.buildMouthMesh();
  }

  buildMouthMesh() {
    const { mouth } = this.rig;
    const left = mouth.left[0];
    const right = mouth.right[0];
    const span = right - left;
    const margin = mouth.margin ?? span * 0.42;
    const columns = [left - margin, left - (margin / 2), left];
    for (let step = 1; step < 10; step += 1) columns.push(left + ((span * step) / 10));
    columns.push(right, right + (margin / 2), right + margin);
    const upperRows = 5;
    const lowerRows = 9;
    const upper = [];
    for (let row = 0; row <= upperRows; row += 1) {
      upper.push(columns.map((x) => [x, lerp(this.lipY(clamp(x, left, right)) - mouth.upperDepth, this.lipY(clamp(x, left, right)), row / upperRows)]));
    }
    const lower = [];
    for (let row = 0; row <= lowerRows; row += 1) {
      lower.push(columns.map((x) => [x, lerp(this.lipY(clamp(x, left, right)), this.lipY(clamp(x, left, right)) + mouth.depth, row / lowerRows)]));
    }
    this.mesh = { columns, upper, lower, left, right, span, x0: columns[0], x1: columns[columns.length - 1] };
  }

  blinkAt(tMs) {
    const duration = 170;
    let low = 0;
    let high = this.blinks.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (this.blinks[middle] <= tMs) low = middle;
      else high = middle - 1;
    }
    const age = tMs - this.blinks[low];
    return age >= 0 && age <= duration ? Math.sin(Math.PI * (age / duration)) : 0;
  }

  // 0 looks at the camera, 1 looks toward the demo. The presenter glances at
  // the demo during pauses longer than about a second and a half, and looks
  // back at the camera shortly before speaking again.
  gazeAt(tMs) {
    let away = 0;
    for (let index = 0; index <= this.speech.length; index += 1) {
      const quietFrom = index === 0 ? 0 : this.speech[index - 1].end;
      const quietTo = index === this.speech.length ? Infinity : this.speech[index].start;
      if (quietTo - quietFrom < 1500 || tMs < quietFrom || tMs > quietTo) continue;
      const leave = smoothstep(clamp((tMs - (quietFrom + 600)) / 320, 0, 1));
      const back = 1 - smoothstep(clamp((tMs - (quietTo - 450)) / 320, 0, 1));
      away = Math.max(away, Math.min(leave, back));
    }
    return away;
  }

  drawGaze(context, amount) {
    if (Math.abs(amount) < 0.02) return;
    for (const eye of this.rig.eyes || []) {
      const rx = eye.w / 2;
      const ry = eye.h / 2;
      const columns = 6;
      const rows = 4;
      const rest = [];
      const moved = [];
      for (let row = 0; row <= rows; row += 1) {
        const restRow = [];
        const movedRow = [];
        for (let col = 0; col <= columns; col += 1) {
          const u = col / columns;
          const v = row / rows;
          const x = eye.x - (rx * 1.05) + (u * rx * 2.1);
          const y = eye.y - (ry * 0.95) + (v * ry * 1.9);
          const bump = (Math.sin(Math.PI * u) ** 1.2) * (Math.sin(Math.PI * v) ** 1.5);
          restRow.push([x, y]);
          movedRow.push([x + (amount * (eye.gaze ?? 7) * bump), y + (Math.abs(amount) * 1.2 * bump)]);
        }
        rest.push(restRow);
        moved.push(movedRow);
      }
      drawMesh(context, this.image, rest, moved);
    }
  }

  // open 0..1 (jaw), wide -1..1 (round .. spread).
  drawMouth(context, open, wide) {
    const { mouth } = this.rig;
    if (!this.mesh || open < 0.035) return;
    const { upper, lower, left, span, x0, x1 } = this.mesh;
    const round = Math.max(0, -wide);
    const spread = Math.max(0, wide);
    const drop = open * mouth.maxOpen * (1 - (round * 0.12));
    const lift = drop * mouth.upperShare;
    const exponent = 0.75 + (round * 0.7);
    const centerX = mouth.center[0];
    const opening = (x) => {
      const u = (x - left) / span;
      return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u) ** exponent;
    };
    const jaw = (x) => Math.sin(Math.PI * clamp((x - x0) / (x1 - x0), 0, 1)) ** 0.6;
    const nearMouth = (x) => Math.sin(Math.PI * clamp((x - x0) / (x1 - x0), 0, 1)) ** 1.4;
    const lateral = (x, closeness) => (x - centerX) * ((spread * 0.1) - (round * 0.24)) * closeness * nearMouth(x);
    const cornerLift = (x) => spread * 2.2 * (1 - opening(x)) * nearMouth(x);

    const movedLower = lower.map((row, rowIndex) => {
      const v = rowIndex / (lower.length - 1);
      const toJaw = smoothstep(clamp(v / 0.35, 0, 1));
      const falloff = 1 - (v ** 2.2);
      const closeness = 1 - smoothstep(clamp(v / 0.5, 0, 1));
      return row.map(([x, y]) => [
        x + lateral(x, closeness),
        y + (drop * lerp(opening(x), jaw(x) * 0.7, toJaw) * falloff) - (cornerLift(x) * closeness),
      ]);
    });
    const movedUpper = upper.map((row, rowIndex) => {
      const v = rowIndex / (upper.length - 1);
      const weight = v ** 1.4;
      return row.map(([x, y]) => [x + lateral(x, weight), y - (lift * opening(x) * weight) - (cornerLift(x) * weight)]);
    });

    const top = movedUpper[movedUpper.length - 1];
    const bottom = movedLower[0];
    context.save();
    context.beginPath();
    context.moveTo(...top[0]);
    for (const point of top.slice(1)) context.lineTo(...point);
    for (const point of [...bottom].reverse()) context.lineTo(...point);
    context.closePath();
    const middle = Math.floor(top.length / 2);
    const gradient = context.createLinearGradient(0, top[middle][1], 0, bottom[middle][1]);
    gradient.addColorStop(0, '#2b0d12');
    gradient.addColorStop(1, '#130507');
    context.fillStyle = gradient;
    context.fill();
    context.clip();
    const gap = bottom[middle][1] - top[middle][1];
    const teeth = Math.min(gap * (0.44 + (spread * 0.14) - (round * 0.22)), mouth.maxOpen * 0.36);
    const teethTop = top[middle][1];
    const teethShade = context.createLinearGradient(0, teethTop, 0, teethTop + teeth);
    teethShade.addColorStop(0, 'rgba(200, 188, 182, 0.95)');
    teethShade.addColorStop(0.35, 'rgba(228, 219, 212, 0.95)');
    teethShade.addColorStop(1, 'rgba(186, 172, 166, 0.9)');
    context.fillStyle = teethShade;
    context.beginPath();
    context.moveTo(...top[0]);
    for (const point of top.slice(1)) context.lineTo(...point);
    for (const point of [...top].reverse()) context.lineTo(point[0], point[1] + (teeth * (opening(point[0]) ** 0.5)));
    context.fill();
    const edgeFade = context.createLinearGradient(this.mesh.left, 0, this.mesh.left + span, 0);
    edgeFade.addColorStop(0, 'rgba(19, 5, 7, 0.95)');
    edgeFade.addColorStop(0.24, 'rgba(19, 5, 7, 0)');
    edgeFade.addColorStop(0.76, 'rgba(19, 5, 7, 0)');
    edgeFade.addColorStop(1, 'rgba(19, 5, 7, 0.95)');
    context.fillStyle = edgeFade;
    context.fillRect(this.mesh.left, teethTop - teeth, span, teeth * 3);
    if (gap > mouth.maxOpen * 0.55) {
      context.fillStyle = 'rgba(214, 205, 200, 0.45)';
      context.fillRect(this.mesh.left + (span * 0.3), bottom[middle][1] - Math.min(gap * 0.14, 3), span * 0.4, 4);
      context.fillStyle = 'rgba(150, 62, 70, 0.55)';
      context.beginPath();
      context.ellipse(centerX, bottom[middle][1], span * 0.22, gap * 0.3, 0, Math.PI, TAU);
      context.fill();
    }
    context.restore();

    drawMesh(context, this.image, upper, movedUpper);
    drawMesh(context, this.image, lower, movedLower);
  }

  drawBrows(context, raise) {
    if (raise < 0.05) return;
    for (const brow of this.rig.brows || []) {
      const columns = 6;
      const rows = 5;
      const rest = [];
      const moved = [];
      for (let row = 0; row <= rows; row += 1) {
        const v = row / rows;
        const restRow = [];
        const movedRow = [];
        for (let col = 0; col <= columns; col += 1) {
          const u = col / columns;
          const x = lerp(brow.x0, brow.x1, u);
          const y = lerp(brow.y0, brow.y1, v);
          restRow.push([x, y]);
          movedRow.push([x, y - (raise * (brow.lift ?? 5) * (Math.sin(Math.PI * u) ** 0.7) * (Math.sin(Math.PI * v) ** 0.8))]);
        }
        rest.push(restRow);
        moved.push(movedRow);
      }
      drawMesh(context, this.image, rest, moved);
    }
  }

  // Closes each eye by stretching a band of the real upper-eyelid skin down
  // along a lid curve that travels from the upper lid line to the lower one,
  // so the lid keeps the portrait's own texture and lighting.
  drawBlink(context, closure) {
    if (closure < 0.02) return;
    this.lidCanvas ||= document.createElement('canvas');
    for (const eye of this.rig.eyes || []) {
      const rx = eye.w / 2;
      const ry = eye.h / 2;
      const left = eye.x - (rx * 1.25);
      const width = rx * 2.5;
      const top = eye.lidTop;
      const band = eye.lidBottom - eye.lidTop;
      const lidAt = (x) => {
        const u = (x - eye.x) / rx;
        const arc = Math.abs(u) < 1 ? Math.sqrt(1 - (u * u)) : 0;
        return lerp(eye.y - (ry * arc), eye.y + (ry * 0.85 * arc), closure);
      };
      const reach = lidAt(eye.x) + 3;
      const patch = this.lidCanvas;
      patch.width = Math.ceil(width);
      patch.height = Math.ceil((reach - top) + 6);
      const lid = patch.getContext('2d');
      lid.save();
      lid.beginPath();
      lid.moveTo(0, 0);
      lid.lineTo(width, 0);
      for (let x = width; x >= 0; x -= 2) lid.lineTo(x, lidAt(left + x) - top);
      lid.closePath();
      lid.clip();
      lid.filter = 'blur(1.4px)';
      lid.drawImage(this.image, left, top, width, band, 0, 0, width, reach - top);
      lid.filter = 'none';
      lid.restore();
      lid.strokeStyle = `rgba(40, 24, 24, ${0.18 + (closure * 0.42)})`;
      lid.lineWidth = 2.2;
      lid.lineCap = 'round';
      lid.beginPath();
      for (let x = rx * 0.35, first = true; x <= width - (rx * 0.35); x += 2, first = false) {
        const y = lidAt(left + x) - top;
        if (first) lid.moveTo(x, y);
        else lid.lineTo(x, y);
      }
      lid.stroke();
      lid.globalCompositeOperation = 'destination-in';
      const across = lid.createLinearGradient(0, 0, width, 0);
      across.addColorStop(0, 'rgba(0, 0, 0, 0)');
      across.addColorStop(0.16, '#000');
      across.addColorStop(0.84, '#000');
      across.addColorStop(1, 'rgba(0, 0, 0, 0)');
      lid.fillStyle = across;
      lid.fillRect(0, 0, width, patch.height);
      const down = lid.createLinearGradient(0, 0, 0, band);
      down.addColorStop(0, 'rgba(0, 0, 0, 0)');
      down.addColorStop(1, '#000');
      lid.fillStyle = down;
      lid.fillRect(0, 0, width, patch.height);
      lid.globalCompositeOperation = 'source-over';
      context.drawImage(patch, left, top);
    }
  }

  grainTile() {
    if (!this.grain) {
      this.grain = document.createElement('canvas');
      this.grain.width = 128;
      this.grain.height = 128;
      const context = this.grain.getContext('2d');
      const noise = context.createImageData(128, 128);
      const random = seeded(29);
      for (let index = 0; index < noise.data.length; index += 4) {
        const value = Math.round(random() * 255);
        noise.data.fill(value, index, index + 3);
        noise.data[index + 3] = 255;
      }
      context.putImageData(noise, 0, 0);
    }
    return this.grain;
  }

  renderFace(pixels, tMs, mouth, lookSide = -1) {
    const { crop, pivot } = this.rig;
    if (this.face.width !== pixels || this.face.height !== pixels) {
      this.face.width = pixels;
      this.face.height = pixels;
    }
    const context = this.face.getContext('2d');
    const scale = pixels / (crop.r * 2);
    const t = tMs / 1000;
    const nod = mouth.nod || 0;
    const angle = ((0.9 * Math.sin((t * TAU) / 6.3)) + (0.45 * Math.sin(((t * TAU) / 2.9) + 1.3)) + (nod * 0.5)) * (Math.PI / 180);
    const bob = (2.4 * Math.sin((t * TAU) / 4.1)) + (mouth.open * 2.2) + (nod * 5.5);
    const breathe = 1 + (0.004 * Math.sin((t * TAU) / 3.7)) + (nod * 0.004);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, pixels, pixels);
    context.imageSmoothingQuality = 'high';
    context.setTransform(scale, 0, 0, scale, -(crop.cx - crop.r) * scale, -(crop.cy - crop.r) * scale);
    context.translate(pivot.x, pivot.y);
    context.rotate(angle);
    context.scale(breathe, breathe);
    context.translate(-pivot.x, -pivot.y + bob);
    context.drawImage(this.image, 0, 0);
    this.drawGaze(context, lookSide * this.gazeAt(tMs));
    this.drawBrows(context, clamp(nod * 1.3, 0, 1));
    this.drawMouth(context, clamp((mouth.open - 0.06) / 0.8, 0, 1) ** 0.9, clamp(mouth.wide || 0, -1, 1));
    this.drawBlink(context, this.blinkAt(tMs));
    // Light sensor grain that shifts every frame so the still portrait reads
    // as live camera video.
    const grain = this.grainTile();
    const offset = Math.floor(tMs / 33);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 0.05;
    context.globalCompositeOperation = 'overlay';
    context.translate(-((offset * 37) % 128), -((offset * 53) % 128));
    context.fillStyle = context.createPattern(grain, 'repeat');
    context.fillRect(0, 0, pixels + 128, pixels + 128);
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    return this.face;
  }

  // `mouth` is { open, wide, nod } from timeline.mouthAt; a bare number is
  // treated as the jaw opening for callers of the original API.
  draw(context, { x, y, size, tMs, mouth = 0, level, appear = 1, accent = '#e05bbf', lookSide = -1 }) {
    if (appear <= 0) return;
    const state = typeof mouth === 'number' ? { open: level ?? mouth, wide: 0, nod: 0 } : mouth;
    const radius = size / 2;
    const centerX = x + radius;
    const centerY = y + radius;
    const face = this.renderFace(Math.round(size * 1.6), tMs, state, lookSide);
    const grow = lerp(0.82, 1, smoothstep(appear));
    const px = size / 300;
    context.save();
    context.globalAlpha = appear;
    context.translate(centerX, centerY);
    context.scale(grow, grow);
    context.translate(-centerX, -centerY);
    context.shadowColor = 'rgba(8, 4, 14, 0.5)';
    context.shadowBlur = 38 * px;
    context.shadowOffsetY = 16 * px;
    context.fillStyle = '#111';
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, TAU);
    context.fill();
    context.shadowColor = 'transparent';
    const speaking = state.speaking ?? state.open;
    if (speaking > 0.02) {
      context.strokeStyle = accent;
      context.globalAlpha = appear * clamp(speaking * 1.4, 0, 0.85);
      context.lineWidth = 9 * px;
      context.beginPath();
      context.arc(centerX, centerY, radius + (8 * px), 0, TAU);
      context.stroke();
      context.globalAlpha = appear;
    }
    context.save();
    context.beginPath();
    context.arc(centerX, centerY, radius, 0, TAU);
    context.clip();
    context.drawImage(face, x, y, size, size);
    context.restore();
    context.strokeStyle = 'rgba(255, 255, 255, 0.95)';
    context.lineWidth = 5 * px;
    context.beginPath();
    context.arc(centerX, centerY, radius - (1.5 * px), 0, TAU);
    context.stroke();
    context.restore();
  }
}
