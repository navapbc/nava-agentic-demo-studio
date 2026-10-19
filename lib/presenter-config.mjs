// Keep partial overrides partial until they have been merged with the trace.
export function presenterOptions(value) {
  if (value === false || value === null) return false;
  if (value === undefined) return undefined;
  const authored = typeof value === 'string' ? { image: value } : (value || {});
  return Object.fromEntries(Object.entries(authored)
    .filter(([key, entry]) => ['kind', 'image', 'color', 'size', 'margin'].includes(key) && entry !== undefined && entry !== null));
}

// New demos use a code-rendered purple orb. A portrait is available only when
// its image is explicitly authored; no bundled face or rig is inferred.
export function resolvePresenter(value) {
  const settings = presenterOptions(value);
  if (settings === false) return false;
  return resolveOptions(settings || {});
}

// An explicit orb selection never carries portrait media into a new plan.
export function orbPresenterOptions(value) {
  const { image, ...settings } = presenterOptions(value) || {};
  return { ...settings, kind: 'orb' };
}

// Change the visual on an already planned project without touching narration,
// camera, source timing, or any other edit. Callers can retain the prior orb
// config while hidden and pass it back when restoring the visual.
export function withOrbVisibility(project, visible) {
  if (!visible) return { ...project, presenter: null };
  if (project.presenter?.kind === 'orb') return { ...project, presenter: { ...project.presenter } };
  const scale = (project.output?.height || 1080) / 1080;
  return {
    ...project,
    presenter: {
      kind: 'orb',
      color: '#8b5cf6',
      size: Math.round(300 * scale),
      margin: Math.round(40 * scale),
      rig: null,
      enterMs: Math.max(0, (project.timeline?.introMs || 0) - 300),
      swaps: [],
    },
  };
}

function resolveOptions(settings) {
  if (settings.kind === 'orb' || !settings.image) {
    const { image, ...orb } = settings;
    return { color: '#8b5cf6', ...orb, kind: 'orb' };
  }
  return { ...settings, kind: 'portrait', image: `/${String(settings.image).replace(/^\//, '')}` };
}
