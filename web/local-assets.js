// Tool pages consume local authored JSON, never remote projects or rigs supplied
// by a link. Keep credentials out of the URL even when the origin matches.
export function localAssetUrl(path, base = globalThis.location.href) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Supply a local asset path.');
  const current = new URL(base);
  const url = new URL(path, current);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== current.origin || url.username || url.password) {
    throw new Error('Projects and rigs must use a same-origin local asset path.');
  }
  return url.href;
}
