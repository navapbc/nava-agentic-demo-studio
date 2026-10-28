import test from 'node:test';
import assert from 'node:assert/strict';
import { localAssetUrl } from '../web/local-assets.js';

test('tool JSON paths stay on the local page origin, without embedded credentials', () => {
  const base = 'http://127.0.0.1:4310/web/render.html';
  assert.equal(localAssetUrl('/recordings/demo/project.json', base), 'http://127.0.0.1:4310/recordings/demo/project.json');
  assert.equal(localAssetUrl('../assets/rig.json', base), 'http://127.0.0.1:4310/assets/rig.json');
  assert.equal(localAssetUrl('http://127.0.0.1:4310/project.json', base), 'http://127.0.0.1:4310/project.json');
  for (const path of [
    'https://attacker.example/project.json', '//attacker.example/project.json',
    'http://localhost:4310/project.json', 'http://127.0.0.1:4311/project.json',
    'http://127.0.0.1:4310@attacker.example/project.json', 'http://user:pass@127.0.0.1:4310/project.json',
    'data:application/json,{}', 'file:///tmp/project.json', 'javascript:alert(1)', '', null,
  ]) assert.throws(() => localAssetUrl(path, base), /local asset path/);
});
