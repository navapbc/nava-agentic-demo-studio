import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from '../bin/demo-studio.mjs';
import { buildProject } from '../lib/planner.mjs';
import { withOrbVisibility } from '../lib/presenter-config.mjs';

const trace = {
  schema: 'nava.demo-trace.v1',
  durationMs: 5000,
  viewport: { width: 1280, height: 800 },
  events: [{ atMs: 500, endMs: 3000, kind: 'narration', text: 'Narration stays in the same place.', clip: 'line-01' }],
};
const voice = { provider: 'test', clips: { 'line-01': { src: '/voice/line-01.wav', durationMs: 2500 } } };

test('CLI accepts explicit orb selections and rejects missing or invalid values', () => {
  assert.deepEqual(parseArgs(['demo.json', '--orb', 'off']), { positional: ['demo.json'], flags: { orb: 'off' } });
  assert.equal(parseArgs(['--orb=on', 'demo.json']).flags.orb, 'on');
  assert.equal(parseArgs(['demo.json']).flags.orb, undefined);
  assert.deepEqual(parseArgs(['--presenter', '--orb', 'off']).flags, { presenter: true, orb: 'off' });
  for (const args of [['--orb'], ['--orb', '--headed'], ['--orb', 'false'], ['--orb='], ['--orb=yes']]) {
    assert.throws(() => parseArgs(args), /--orb must be on or off/);
  }
});

test('changing the orb on an existing project preserves every other planned field', () => {
  const project = buildProject(trace, { voice, settings: { output: { width: 1280, height: 720 } } });
  project.presenter.color = '#a27fff';
  project.presenter.size = 170;
  const before = JSON.stringify(project);
  const hidden = withOrbVisibility(project, false);
  assert.equal(hidden.presenter, null);
  assert.equal(JSON.stringify(project), before, 'the saved source project is unchanged');
  const enabled = withOrbVisibility(hidden, true);
  assert.equal(enabled.presenter.kind, 'orb');
  assert.equal(enabled.presenter.size, 200, 'new orbs use the output scale');
  assert.equal(enabled.presenter.margin, 27);
  assert.deepEqual(enabled.presenter.swaps, []);
  const restored = withOrbVisibility({ ...hidden, presenter: project.presenter }, true);
  assert.deepEqual(restored.presenter, project.presenter, 'a saved orb restores its authored appearance and swaps');
  const legacy = withOrbVisibility({ presenter: null }, true);
  assert.equal(legacy.presenter.size, 300);
  assert.equal(legacy.presenter.margin, 40);
  assert.equal(legacy.presenter.enterMs, 0);
  for (const candidate of [hidden, enabled, restored]) {
    for (const key of Object.keys(project).filter(key => key !== 'presenter')) {
      assert.strictEqual(candidate[key], project[key], `${key} keeps the exact planned value`);
    }
  }
});

test('plan --orb overrides authored settings without changing scripts, narration, or timeline', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'demo-studio-orb-'));
  const command = fileURLToPath(new URL('../bin/demo-studio.mjs', import.meta.url));
  const tracePath = join(temp, 'trace.json');
  const scriptPath = join(temp, 'script.json');
  const voicePath = join(temp, 'voice.json');
  const projectPath = join(temp, 'project.json');
  const linkedCommand = join(temp, 'demo-studio');
  const script = { presenter: { kind: 'orb', color: '#a27fff', size: 170 }, music: false };
  const scriptJson = JSON.stringify(script);
  try {
    await symlink(command, linkedCommand);
    assert.match(execFileSync(process.execPath, [linkedCommand, 'help'], { encoding: 'utf8' }), /demo-studio make SCRIPT.json/);
    await writeFile(tracePath, JSON.stringify(trace));
    await writeFile(scriptPath, scriptJson);
    await writeFile(voicePath, JSON.stringify(voice));
    const plans = [];
    for (const selection of [undefined, 'off', 'on']) {
      execFileSync(process.execPath, [linkedCommand, 'plan', tracePath, projectPath, '--script', scriptPath, '--voice', voicePath, ...(selection ? ['--orb', selection] : [])]);
      plans.push(JSON.parse(await readFile(projectPath, 'utf8')));
    }
    assert.equal(plans[1].presenter, null);
    assert.equal(plans[2].presenter.kind, 'orb');
    assert.equal(plans[2].presenter.size, 170);
    const withoutPresenter = ({ presenter, ...project }) => project;
    assert.deepEqual(withoutPresenter(plans[1]), withoutPresenter(plans[0]));
    assert.deepEqual(withoutPresenter(plans[2]), withoutPresenter(plans[0]));
    assert.equal(await readFile(scriptPath, 'utf8'), scriptJson, 'CLI overrides never write the script');
    await writeFile(scriptPath, JSON.stringify({ ...script, presenter: false }));
    execFileSync(process.execPath, [linkedCommand, 'plan', tracePath, projectPath, '--script', scriptPath, '--orb', 'on']);
    assert.equal(JSON.parse(await readFile(projectPath, 'utf8')).presenter.kind, 'orb', 'on overrides an authored opt-out');
    assert.equal(await readFile(scriptPath, 'utf8'), JSON.stringify({ ...script, presenter: false }));
    assert.equal(await readFile(tracePath, 'utf8'), JSON.stringify(trace));
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
