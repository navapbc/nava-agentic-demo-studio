#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { buildPresentation } from '../lib/presentation-build.mjs';
import { startServer } from '../lib/server.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const [command = 'help', input, ...args] = process.argv.slice(2);
try {
  if (command === 'build') {
    if (!input) throw new Error('Provide a presentation manifest JSON.');
    const outputFlag = args.indexOf('--out');
    if (outputFlag >= 0 && !args[outputFlag + 1]) throw new Error('--out needs a directory.');
    await buildPresentation(resolve(input), { root, outDir: outputFlag < 0 ? undefined : args[outputFlag + 1] });
  } else if (command === 'serve') {
    const server = await startServer({ root: resolve(input || 'exports/presentation'), port: Number(args[0]) || 4311 });
    console.log(`Open ${server.origin}/index.html`);
    process.once('SIGINT', async () => { await server.close(); process.exit(0); });
  } else if (command === 'help') {
    console.log('Nava Presentation Studio\n\n  presentation-studio build MANIFEST.json [--out DIRECTORY]\n  presentation-studio serve DIRECTORY [PORT]\n\nBuild editable PowerPoint, a browser presentation, PDF, MP4 demos, slide previews and a portable ZIP.');
  } else throw new Error(`Unknown command: ${command}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
