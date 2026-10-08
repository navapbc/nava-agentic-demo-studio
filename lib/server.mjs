import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { basename, extname, join, normalize, resolve, sep } from 'node:path';
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
  const path = normalize(join(root, requestPath));
  return path === root || path.startsWith(root + sep) ? path : null;
}

export function safeExportName(name) {
  const cleaned = basename(String(name || '')).replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return /\.(mp4|webm|png|json|wav)$/i.test(cleaned) ? cleaned : null;
}

async function serveFile(request, response, requested) {
  let path = requested;
  let info = await stat(path).catch(() => null);
  if (info?.isDirectory()) {
    path = join(path, 'index.html');
    info = await stat(path).catch(() => null);
  }
  if (!info?.isFile()) {
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
    if (start > end || start >= info.size) {
      response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }).end();
      return;
    }
    response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    createReadStream(path, { start, end }).pipe(response);
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (request.method === 'HEAD') response.end();
  else createReadStream(path).pipe(response);
}

async function receiveExport(request, response, exportsDir, onExport) {
  const name = safeExportName(new URL(request.url, 'http://127.0.0.1').searchParams.get('name'));
  if (!name) {
    response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'name must end in .mp4, .webm, .png, .json, or .wav' }));
    return;
  }
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > MAX_UPLOAD_BYTES) {
    response.writeHead(413).end();
    return;
  }
  await mkdir(exportsDir, { recursive: true });
  const target = join(exportsDir, name);
  const partial = `${target}.partial`;
  await pipeline(request, createWriteStream(partial));
  await rename(partial, target);
  onExport?.(target);
  response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ path: target }));
}

// Local-only static server. It binds to 127.0.0.1, serves files from `root`,
// and accepts rendered exports into `exportsDir` so a headless renderer can
// hand its result back to the CLI without a download dialog.
export function startServer({ root, port = 0, exportsDir = join(root, 'exports'), onExport } = {}) {
  const base = resolve(root);
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'POST' && url.pathname === '/api/export') {
      receiveExport(request, response, exportsDir, onExport).catch((error) => {
        if (!response.headersSent) response.writeHead(500).end(String(error.message));
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
    serveFile(request, response, path).catch(() => {
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
