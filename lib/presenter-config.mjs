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

function resolveOptions(settings) {
  if (settings.kind === 'orb' || !settings.image) {
    const { image, ...orb } = settings;
    return { color: '#8b5cf6', ...orb, kind: 'orb' };
  }
  return { ...settings, kind: 'portrait', image: `/${String(settings.image).replace(/^\//, '')}` };
}
