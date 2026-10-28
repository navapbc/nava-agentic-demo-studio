import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('say receives option-like narration only on stdin, never as command arguments', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'studio-say-security-'));
  const fakeSay = join(directory, 'say');
  const result = join(directory, 'received.json');
  const output = join(directory, 'voice.wav');
  const text = '--input-file=/synthetic/private.txt --network-send=example.invalid:9999 $(touch never)';
  try {
    await writeFile(fakeSay, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args.length === 2 && args[0] === '-v' && args[1] === '?') {
  process.stdout.write('Samantha en_US # Synthetic test voice\\n');
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    fs.writeFileSync(process.env.STUDIO_SAY_TEST_RESULT, JSON.stringify({ args, input }));
    const wav = Buffer.alloc(46);
    wav.write('RIFF'); wav.writeUInt32LE(38, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
    wav.write('data', 36); wav.writeUInt32LE(2, 40);
    fs.writeFileSync(args[args.indexOf('-o') + 1], wav);
  });
}
`);
    await chmod(fakeSay, 0o700);
    await run(process.execPath, ['--input-type=module', '-e', `
      import { resolveVoiceProvider } from ${JSON.stringify(new URL('../lib/voice.mjs', import.meta.url).href)};
      const provider = await resolveVoiceProvider({ provider: 'say', voice: 'Samantha' });
      await provider.synthesize(process.env.STUDIO_SAY_TEST_TEXT, process.env.STUDIO_SAY_TEST_OUTPUT);
    `], {
      env: { ...process.env, PATH: directory + ':' + process.env.PATH, STUDIO_SAY_TEST_RESULT: result, STUDIO_SAY_TEST_TEXT: text, STUDIO_SAY_TEST_OUTPUT: output },
      timeout: 10000,
    });
    const received = JSON.parse(await readFile(result, 'utf8'));
    assert.equal(received.input, text);
    assert.deepEqual(received.args.slice(-2), ['-f', '-']);
    assert.ok(received.args.every(argument => !argument.includes(text) && !argument.startsWith('--input-file=') && !argument.startsWith('--network-send=')));
    assert.ok((await readFile(output)).subarray(0, 4).equals(Buffer.from('RIFF')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
