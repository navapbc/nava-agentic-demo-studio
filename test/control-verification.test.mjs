import test from 'node:test';
import assert from 'node:assert/strict';
import { describeCapturedControls } from '../lib/recorder.mjs';

test('unchecked WIC choices are not counted as answered merely because they have values', () => {
  const node = (type, checked, value, valid=true) => ({id: type, type, checked, value, checkValidity:()=>valid});
  const statuses = describeCapturedControls([
    node('radio', false, 'Yes', false), node('radio', true, 'No'),
    node('checkbox', false, 'Pregnant'), node('checkbox', true, 'In-Person'),
    node('text', false, ''), node('text', false, 'Demo Applicant'),
  ]);
  assert.deepEqual(statuses.map(control=>control.filled), [false,true,false,true,false,true]);
  assert.equal(statuses[0].valid,false);
  assert.equal(statuses[1].checked,true);
  assert.equal(statuses[2].checked,false);
});
