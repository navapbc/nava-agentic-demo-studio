import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startServer } from '../lib/server.mjs';

async function withServer(run, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'studio-security-'));
  const root = join(directory, 'public');
  await mkdir(root);
  const server = await startServer({ root, ...options });
  try {
    assert.equal(server.server.address().address, '127.0.0.1');
    await run({ ...server, root, directory, exportsDir: join(root, 'exports') });
  } finally {
    await server.close();
    await rm(directory, { recursive: true, force: true });
  }
}

async function eventually(check) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await check()) return;
    await delay(10);
  }
  assert.fail('Timed out waiting for upload cleanup');
}

function rawRequest(url, { method = 'GET', headers = {}, body } = {}) {
  // Browser-compatible fetch implementations may replace forbidden headers.
  // Use the HTTP client to exercise exactly the attacker-supplied headers.
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, response => {
      response.resume();
      response.once('end', () => resolve(response.statusCode));
    });
    request.once('error', reject);
    request.end(body);
  });
}

test('static requests cannot read metadata, hidden files, or external symlinks', async () => {
  await withServer(async ({ origin, root, directory }) => {
    await writeFile(join(root, '.env'), 'synthetic-private-configuration');
    await mkdir(join(root, '.git'));
    await writeFile(join(root, '.git', 'config'), 'synthetic-private-metadata');
    await writeFile(join(directory, 'outside.txt'), 'synthetic-outside-root');
    await symlink(join(directory, 'outside.txt'), join(root, 'escape.txt'));
    await symlink(join(root, '.env'), join(root, 'alias.txt'));
    await mkdir(join(root, 'directory'));
    await symlink(join(directory, 'outside.txt'), join(root, 'directory', 'index.html'));
    await writeFile(join(root, 'public.txt'), 'public asset');
    await symlink(join(root, 'public.txt'), join(root, 'public-alias.txt'));
    for (const path of ['/.env', '/%2eenv', '/.git/config', '/escape.txt', '/alias.txt', '/directory/', '/..%2foutside.txt']) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 404, path);
      assert.equal(await response.text(), 'Not found');
    }
    const permitted = await fetch(origin + '/public-alias.txt');
    assert.equal(await permitted.text(), 'public asset');
    assert.equal(permitted.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(permitted.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(permitted.headers.get('content-security-policy'), "frame-ancestors 'none'");
    assert.equal(permitted.headers.get('x-frame-options'), 'DENY');
    assert.equal((await fetch(origin + '/%ZZ')).status, 400);
    assert.equal((await fetch(origin + '/public.txt')).status, 200);
  });
});

test('rejects DNS-rebinding hosts and cross-origin export requests', async () => {
  await withServer(async ({ origin, root, exportsDir }) => {
    await writeFile(join(root, 'public.txt'), 'public asset');
    assert.equal(await rawRequest(origin + '/public.txt', { headers: { Host: 'attacker.example' } }), 403);
    const endpoint = origin + '/api/export?name=out.mp4';
    for (const headers of [
      { Origin: 'https://attacker.example' },
      { Origin: 'null' },
      { Origin: origin + '-evil' },
      { 'Sec-Fetch-Site': 'cross-site' },
      { 'Sec-Fetch-Site': 'same-site', 'Sec-Fetch-Mode': 'navigate' },
    ]) {
      assert.equal(await rawRequest(endpoint, { method: 'POST', headers, body: 'untrusted' }), 403);
    }
    assert.deepEqual(await readdir(exportsDir).catch(() => []), []);
    assert.equal(await rawRequest(origin + '/web/render.html?project=https://attacker.example/project.json&out=out.mp4', { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate' } }), 403, 'cross-site navigation must not turn the local renderer into an export gadget');
    assert.equal(await rawRequest(origin + '/public.txt', { headers: { 'Sec-Fetch-Site': 'none', 'Sec-Fetch-Mode': 'navigate' } }), 200, 'direct navigation from the CLI or address bar still works');
    const accepted = await fetch(endpoint, { method: 'POST', headers: { Origin: origin, 'Sec-Fetch-Site': 'same-origin' }, body: 'trusted' });
    assert.equal(accepted.status, 200);
    assert.equal(await readFile(join(exportsDir, 'out.mp4'), 'utf8'), 'trusted');
  });
});

test('enforces the export limit on chunked bodies and removes failed uploads', async () => {
  await withServer(async ({ origin, exportsDir }) => {
    const endpoint = origin + '/api/export?name=out.mp4';
    const declared = await fetch(endpoint, { method: 'POST', body: '0123456789' });
    assert.equal(declared.status, 413);
    const chunked = await fetch(endpoint, {
      method: 'POST', duplex: 'half',
      body: (async function* () { yield '0123'; yield '4567'; yield '89'; })(),
    });
    assert.equal(chunked.status, 413);
    assert.deepEqual(await readdir(exportsDir), []);
    const accepted = await fetch(endpoint, { method: 'POST', body: '12345678' });
    assert.equal(accepted.status, 200);
    assert.equal(await readFile(join(exportsDir, 'out.mp4'), 'utf8'), '12345678');
  }, { maxUploadBytes: 8 });
});

test('exports do not follow partial or final symlinks and simultaneous writes stay separate', async () => {
  await withServer(async ({ origin, directory, exportsDir }) => {
    await mkdir(exportsDir);
    const outside = join(directory, 'outside.txt');
    await writeFile(outside, 'unchanged');
    await symlink(outside, join(exportsDir, 'out.mp4.partial'));
    await symlink(outside, join(exportsDir, 'out.mp4'));
    const first = await fetch(origin + '/api/export?name=out.mp4', { method: 'POST', body: 'exported' });
    assert.equal(first.status, 200);
    assert.equal(await readFile(outside, 'utf8'), 'unchanged');
    assert.equal(await readFile(join(exportsDir, 'out.mp4'), 'utf8'), 'exported');
    const bodies = ['a'.repeat(65536), 'b'.repeat(65536)];
    const responses = await Promise.all(bodies.map(body => fetch(origin + '/api/export?name=parallel.mp4', { method: 'POST', body })));
    assert.ok(responses.every(response => response.status === 200));
    assert.ok(bodies.includes(await readFile(join(exportsDir, 'parallel.mp4'), 'utf8')));
    assert.ok(!(await readdir(exportsDir)).some(name => name.startsWith('.upload-')));
  });
});

test('aborted uploads clean up their temporary file and never publish a partial export', async () => {
  await withServer(async ({ origin, exportsDir, server }) => {
    const early = httpRequest(origin + '/api/export?name=early.mp4', { method: 'POST' });
    early.on('error', () => {});
    await new Promise(resolve => {
      server.once('request', incoming => {
        incoming.once('aborted', resolve);
        early.destroy();
      });
      early.flushHeaders();
    });
    // Let the in-progress filesystem setup finish after this early abort.
    await delay(50);
    await eventually(async () => (await readdir(exportsDir).catch(() => [])).length === 0);
    const request = httpRequest(origin + '/api/export?name=aborted.mp4', { method: 'POST' });
    request.on('error', () => {});
    request.write('partial body');
    await eventually(async () => (await readdir(exportsDir).catch(() => [])).some(name => name.startsWith('.upload-')));
    request.destroy();
    await eventually(async () => (await readdir(exportsDir)).length === 0);
  });
});

test('HEAD byte ranges send metadata without a body and invalid numeric ranges do not crash', async () => {
  await withServer(async ({ origin, root }) => {
    await writeFile(join(root, 'clip.mp4'), '0123456789');
    const head = await fetch(origin + '/clip.mp4', { method: 'HEAD', headers: { Range: 'bytes=2-5' } });
    assert.equal(head.status, 206);
    assert.equal(head.headers.get('content-length'), '4');
    assert.equal(await head.text(), '');
    assert.equal((await fetch(origin + '/clip.mp4', { headers: { Range: 'bytes=9999999999999999999999999999-' } })).status, 416);
    assert.equal(await (await fetch(origin + '/clip.mp4')).text(), '0123456789');
  });
});
