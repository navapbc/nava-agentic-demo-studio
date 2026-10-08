// A demo script is what an agent authors: where to start, what to do, and what
// to say. Typed values live only here; the recorder never copies them into the
// trace, so scripts must use synthetic demo data.

export const SCRIPT_SCHEMA = 'nava.demo-script.v1';

const STEP_FIELDS = {
  goto: ['url'],
  click: ['target'],
  type: ['target', 'text'],
  select: ['target', 'value'],
  hover: ['target'],
  scroll: [],
  wait: [],
  pause: [],
  milestone: ['label'],
  focus: ['target'],
};
const COMMON_FIELDS = new Set(['do', 'label', 'say', 'leadMs', 'holdMs', 'at', 'waitForSpeech', 'in']);
const SURFACES = new Set(['page', 'sidepanel']);
const OPTIONAL_FIELDS = {
  type: ['delayMs', 'clear'],
  scroll: ['to', 'y', 'by'],
  wait: ['ms', 'for', 'timeoutMs', 'until'],
  pause: ['ms'],
  goto: [],
  click: [],
  select: [],
  hover: [],
  milestone: [],
  focus: [],
};

function fail(index, message) {
  throw new Error(index === null ? message : `Step ${index + 1}: ${message}`);
}

function validateTarget(target, index) {
  if (typeof target === 'string' && target.trim()) return;
  if (target && typeof target === 'object' && ['text', 'label', 'placeholder', 'testId'].some((key) => typeof target[key] === 'string')) return;
  if (target && typeof target === 'object' && typeof target.role === 'string') return;
  fail(index, 'target must be a selector string or { text | label | placeholder | testId | role, name }.');
}

// A typed value can come from the environment so secrets (pairing tokens) are
// never written into a script file.
function validateText(value, index) {
  if (typeof value === 'string') return;
  if (value && typeof value === 'object' && typeof value.env === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(value.env)) return;
  fail(index, 'text must be a string or { "env": "VARIABLE_NAME" }.');
}

function validateSteps(script, steps, { allowSay }) {
  steps.forEach((step, index) => {
    const required = STEP_FIELDS[step?.do];
    if (!required) fail(index, `unknown step "${step?.do}". Use one of: ${Object.keys(STEP_FIELDS).join(', ')}.`);
    for (const key of required) if (step[key] === undefined || step[key] === '') fail(index, `"${step.do}" needs "${key}".`);
    for (const key of Object.keys(step)) {
      if (!COMMON_FIELDS.has(key) && !required.includes(key) && !OPTIONAL_FIELDS[step.do].includes(key)) fail(index, `unexpected field "${key}" on "${step.do}".`);
    }
    if ('target' in step) validateTarget(step.target, index);
    if (step.do === 'type') validateText(step.text, index);
    if (step.in !== undefined && !SURFACES.has(step.in)) fail(index, `"in" must be one of ${[...SURFACES].join(', ')}.`);
    if (step.in === 'sidepanel' && !script.sidePanel) fail(index, 'targets the side panel; set "sidePanel": true (with "recorder": "window" or "screen" and an extension).');
    if (step.say !== undefined && (!allowSay || typeof step.say !== 'string' || !step.say.trim() || step.say.length > 400)) fail(index, allowSay ? 'say must be 1-400 characters.' : 'setup steps are not recorded, so they cannot narrate.');
    if (step.label !== undefined && (typeof step.label !== 'string' || step.label.length > 140)) fail(index, 'label must be at most 140 characters.');
    if (step.do === 'wait' && step.ms === undefined && step.for === undefined) fail(index, 'wait needs "ms" or "for".');
    if (step.do === 'wait' && step.for !== undefined) validateTarget(step.for, index);
    if (step.do === 'wait' && step.until !== undefined && step.until !== 'filled') fail(index, 'wait "until" can only be "filled".');
    if (step.do === 'scroll' && step.to === undefined && step.y === undefined && step.by === undefined) fail(index, 'scroll needs "to", "y", or "by".');
    if (step.do === 'scroll' && step.to !== undefined) validateTarget(step.to, index);
  });
}

export function validateScript(script) {
  if (!script || script.schema !== SCRIPT_SCHEMA) fail(null, `Expected a ${SCRIPT_SCHEMA} script.`);
  if (typeof script.startUrl !== 'string' || !script.startUrl) fail(null, 'startUrl is required.');
  if (!Array.isArray(script.steps) || !script.steps.length) fail(null, 'steps must be a non-empty array.');
  if (script.recorder !== undefined && !['page', 'window', 'screen'].includes(script.recorder)) fail(null, 'recorder must be "page", "window", or "screen".');
  if ((script.sidePanel || script.extensions?.length) && !['window', 'screen'].includes(script.recorder)) fail(null, 'Extensions and side panels need a visible browser; set "recorder": "window" (unattended) or "screen".');
  if (script.extensions !== undefined && !(Array.isArray(script.extensions) && script.extensions.every((path) => typeof path === 'string'))) fail(null, 'extensions must be a list of unpacked extension folders.');
  if (script.setup !== undefined && !Array.isArray(script.setup)) fail(null, 'setup must be a list of steps.');
  validateSteps(script, script.setup || [], { allowSay: false });
  validateSteps(script, script.steps, { allowSay: true });
  return script;
}

export function narrationLines(script) {
  return script.steps
    .map((step, index) => (step.say ? { id: `line-${String(index + 1).padStart(2, '0')}`, stepIndex: index, text: step.say.trim() } : null))
    .filter(Boolean);
}

export function slugFor(script, fallback = 'demo') {
  const source = script.slug || script.title || fallback;
  return String(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'demo';
}
