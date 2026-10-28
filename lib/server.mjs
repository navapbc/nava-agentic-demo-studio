import { constants, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, realpath, rename, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join, relative, resolve, sep } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.wav': 'audio/wav',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
};
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export function resolveInside(root, requestPath) {
  const base = resolve(root);
  const path = resolve(join(base, requestPath));
  const local = relative(base, path);
  if (local === '..' || local.startsWith(`..${sep}`)) return null;
  // Repository metadata and local configuration are never web assets.
  return local.split(sep).some((part) => part.startsWith('.')) ? null : path;
}

export function safeExportName(name) {
  const cleaned = basename(String(name || '')).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return /\.(mp4|webm|png|json|wav)$/i.test(cleaned) ? cleaned : null;
}

async function serveFile(request, response, root, requested) {
  let path = await realpath(requested).catch(() => null);
  if (!path || resolveInside(root, relative(root, path)) !== path) {
    response.writeHead(404).end('Not found');
    return;
  }
  let info = await stat(path).catch(() => null);
  if (info?.isDirectory()) {
    path = await realpath(join(path, 'index.html')).catch(() => null);
    if (!path || resolveInside(root, relative(root, path)) !== path) {
      response.writeHead(404).end('Not found');
      return;
    }
    info = await stat(path).catch(() => null);
  }
  if (!info?.isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  // Open the resolved file before sending headers; a replaced final symlink
  // must not redirect the stream after the confinement check.
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    info = await file.stat();
    if (!info.isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    const headers = {
      'Content-Type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Accept-Ranges': 'bytes',
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range || '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= info.size) {
        response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
        return;
      }
      response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      if (request.method === 'HEAD') response.end();
      else await pipeline(file.createReadStream({ start, end, autoClose: false }), response);
      return;
    }
    response.writeHead(200, { ...headers, 'Content-Length': info.size });
    if (request.method === 'HEAD') response.end();
    else await pipeline(file.createReadStream({ autoClose: false }), response);
  } finally {
    await file.close();
  }
}

async function receiveExport(request, response, exportsDir, onExport, maxUploadBytes) {
  const name = safeExportName(new URL(request.url, 'http://127.0.0.1').searchParams.get('name'));
  if (!name) {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'name must end in .mp4, .webm, .png, .json, or .wav' }));
    return;
  }
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > maxUploadBytes) {
    request.resume();
    response.writeHead(413, { Connection: 'close' }).end();
    return;
  }
  await mkdir(exportsDir, { recursive: true });
  const directory = await realpath(exportsDir);
  const target = join(directory, name);
  const temporary = await mkdtemp(join(directory, '.upload-'));
  let received = 0;
  let oversized = false;
  const limit = new Transform({
    transform(chunk, encoding, done) {
      received += chunk.length;
      if (received > maxUploadBytes) done(Object.assign(new Error('Export too large'), { statusCode: 413 }));
      else done(null, chunk);
    },
  });
  const interrupted = () => limit.destroy(new Error('Upload interrupted'));
  request.once('aborted', interrupted);
  request.once('error', interrupted);
  try {
    // The client may have gone away during the filesystem awaits above,
    // before the abort listener could be attached.
    if (request.aborted || request.destroyed) throw new Error('Upload interrupted');
    // Keep the request out of pipeline's destruction chain so a streamed limit
    // failure can return 413 rather than silently resetting the connection.
    request.pipe(limit);
    await pipeline(limit, createWriteStream(join(temporary, 'export'), { flags: 'wx', mode: 0o600 }));
    await rename(join(temporary, 'export'), target);
  } catch (error) {
    request.unpipe(limit);
    request.resume();
    if (error.statusCode === 413) oversized = true;
    else throw error;
  } finally {
    request.off('aborted', interrupted);
    request.off('error', interrupted);
    await rm(temporary, { recursive: true, force: true });
  }
  if (oversized) {
    response.writeHead(413, { Connection: 'close' }).end();
    return;
  }
  // Preserve the caller's path spelling (for example /var vs /private/var).
  const reportedTarget = join(exportsDir, name);
  onExport?.(reportedTarget);
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: reportedTarget }));
}

// Local-only static server. It binds to 127.0.0.1, serves files from `root`,
// and accepts rendered exports into `exportsDir` so a headless renderer can
// hand its result back to the CLI without a download dialog.
export async function startServer({ root, port = 0, exportsDir = join(root, 'exports'), onExport, maxUploadBytes = MAX_UPLOAD_BYTES } = {}) {
  const base = await realpath(resolve(root));
  if (!Number.isSafeInteger(maxUploadBytes) || maxUploadBytes < 1) throw new Error('maxUploadBytes must be a positive integer.');
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('X-Frame-Options', 'DENY');
    const localPort = server.address().port;
    const host = request.headers.host?.toLowerCase();
    const allowedHosts = [`127.0.0.1:${localPort}`, `localhost:${localPort}`];
    if (localPort === 80) allowedHosts.push('127.0.0.1', 'localhost');
    const origin = `http://${host}`.replace(/:80$/, '');
    // A loopback bind alone does not stop DNS rebinding or a hostile website
    // posting a simple request to a guessed local port.
    if (!allowedHosts.includes(host)
      || (request.headers.origin && request.headers.origin !== origin)
      || (request.headers['sec-fetch-site'] && !['none', 'same-origin'].includes(request.headers['sec-fetch-site']))) {
      request.resume();
      response.writeHead(403).end('Forbidden');
      return;
    }
    let url;
    try {
      url = new URL(request.url, origin);
      if (!request.url.startsWith('/') || url.origin !== origin) throw new Error('Bad URL');
    } catch {
      response.writeHead(400).end('Bad URL');
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/export') {
      receiveExport(request, response, exportsDir, onExport, maxUploadBytes).catch(() => {
        if (!response.headersSent) response.writeHead(500).end('Export failed');
      });
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.writeHead(405).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      response.writeHead(400).end('Bad path');
      return;
    }
    const path = resolveInside(base, pathname === '/' ? '/web/index.html' : pathname);
    if (!path) {
      response.writeHead(404).end('Not found');
      return;
    }
    serveFile(request, response, base, path).catch(() => {
      if (!response.headersSent) response.writeHead(500).end();
    });
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      resolvePromise({ server, port: address.port, origin: `http://127.0.0.1:${address.port}`, close: () => new Promise((done) => server.close(done)) });
    });
  });
}
