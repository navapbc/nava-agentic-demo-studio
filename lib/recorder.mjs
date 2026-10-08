import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { chromeForTesting, freePort, launchBrowser } from './browser.mjs';
import { TRACE_SCHEMA } from './planner.mjs';
import { browserPid, ScreenCapture } from './screen.mjs';
import { narrationLines } from './script.mjs';
import { clamp, easeInOutCubic, lerp } from './timeline.mjs';

export const FRAMES_SCHEMA = 'nava.demo-frames.v1';

// Choice values such as "Yes" exist even while the radio/checkbox is unchecked.
// Verification must inspect the selected state, rather than counting value strings.
export function describeCapturedControls(nodes) {
  return nodes.map(node => ({
    id: node.id,
    type: node.type,
    filled: ['checkbox', 'radio'].includes(node.type) ? Boolean(node.checked) : Boolean(String(node.value || '').trim()),
    checked: ['checkbox', 'radio'].includes(node.type) ? Boolean(node.checked) : null,
    valid: node.checkValidity(),
    visible: node.getClientRects ? node.getClientRects().length > 0 : true,
    disabled: Boolean(node.disabled),
  }));
}

const sleep = (ms) => new Promise((done) => setTimeout(done, Math.max(0, ms)));

// Captures the page with the Chrome DevTools screencast: damage-driven JPEG
// frames at device resolution, stamped with the compositor's own clock.
export class FrameCapture {
  constructor(context, page, dir, { width, height, quality }) {
    Object.assign(this, { context, page, dir, width, height, quality });
    this.frames = [];
    this.writes = [];
    this.t0 = null;
    this.session = null;
  }

  async start() {
    await mkdir(this.dir, { recursive: true });
    await this.attach();
    this.page.on('load', () => this.attach().catch(() => {}));
  }

  async attach() {
    const previous = this.session;
    if (previous) await previous.send('Page.stopScreencast').catch(() => {});
    const session = await this.context.newCDPSession(this.page);
    session.on('Page.screencastFrame', (frame) => this.onFrame(session, frame));
    await session.send('Page.startScreencast', { format: 'jpeg', quality: this.quality, maxWidth: this.width, maxHeight: this.height });
    this.session = session;
    if (previous) previous.detach().catch(() => {});
  }

  // Keeps the same frame sequence going on another tab (for example one an
  // extension opened), so the recording follows the work.
  async follow(page) {
    this.page = page;
    page.on('load', () => this.attach().catch(() => {}));
    await this.attach();
  }

  onFrame(session, frame) {
    session.send('Page.screencastFrameAck', { sessionId: frame.sessionId }).catch(() => {});
    if (this.t0 === null || this.stopped) return;
    const t = Math.max(0, Math.round((frame.metadata.timestamp * 1000) - this.t0));
    this.save(t, Buffer.from(frame.data, 'base64'));
  }

  save(t, bytes) {
    const name = `${String(this.frames.length + 1).padStart(6, '0')}.jpg`;
    this.frames.push({ t, file: name });
    this.writes.push(writeFile(join(this.dir, name), bytes));
  }

  async begin(t0 = null) {
    const still = await this.page.screenshot({ type: 'jpeg', quality: this.quality });
    this.t0 = t0 ?? Date.now();
    this.save(Math.max(0,Date.now()-this.t0), still);
  }

  async stop(endMs) {
    const still = await this.page.screenshot({ type: 'jpeg', quality: this.quality }).catch(() => null);
    this.stopped = true;
    if (still) this.save(endMs, still);
    await this.session?.send('Page.stopScreencast').catch(() => {});
    await Promise.all(this.writes);
    this.frames.sort((left, right) => left.t - right.t);
    return this.frames;
  }
}

// Headless page capture: the frame is the viewport and the page fills it.
async function openPageSession(script, { outDir, urlPrefix, headless }) {
  const viewport = script.viewport || { width: 1440, height: 900 };
  const scale = script.deviceScaleFactor || 2;
  const browser = await launchBrowser({
    headless,
    args: [`--force-device-scale-factor=${scale}`, `--window-size=${viewport.width + 200},${viewport.height + 300}`, '--hide-scrollbars', '--mute-audio'],
  });
  const context = await browser.newContext({ viewport, deviceScaleFactor: scale, locale: 'en-US', colorScheme: script.colorScheme || 'light' });
  const page = await context.newPage();
  const capture = new FrameCapture(context, page, join(outDir, 'frames'), { width: viewport.width * scale, height: viewport.height * scale, quality: script.quality || 88 });
  return {
    page,
    frame: viewport,
    async surface() {
      return { page, offset: { x: 0, y: 0 } };
    },
    async prepare() {},
    async startCapture() {
      await capture.start();
      await sleep(500);
      await capture.begin();
      return capture.t0;
    },
    async stopCapture(durationMs) {
      const frames = await capture.stop(durationMs);
      const manifest = {
        schema: FRAMES_SCHEMA,
        width: viewport.width * scale,
        height: viewport.height * scale,
        viewport,
        deviceScaleFactor: scale,
        durationMs,
        frames: frames.map((frame) => ({ t: frame.t, src: `${urlPrefix}/frames/${frame.file}` })),
      };
      await writeFile(join(outDir, 'frames.json'), `${JSON.stringify(manifest)}\n`);
      return { manifest, source: { kind: 'frames', manifest: `${urlPrefix}/frames.json` } };
    },
    close: () => browser.close(),
  };
}

// Opens the extension's side panel. sidePanel.open() needs a user gesture, so
// a trusted click on a button injected into one of the extension's own pages
// provides it. The panel is then driven through a CDP connection, because it
// is a separate page target that the launching context does not expose.
async function openSidePanel(context, page, port, log) {
  let [worker] = context.serviceWorkers();
  worker ||= await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;
  const panelPath = await worker.evaluate(() => chrome.runtime.getManifest().side_panel?.default_path);
  if (!panelPath) throw new Error('The extension does not declare a side_panel.default_path.');
  const pageUrl = page.url();
  const windowId = await worker.evaluate(async (url) => {
    const windows = await chrome.windows.getAll({ populate: true });
    return (windows.find((entry) => entry.tabs.some((tab) => tab.url === url)) || windows[0]).id;
  }, pageUrl);
  const opener = await context.newPage();
  await opener.goto(`chrome-extension://${extensionId}/${panelPath}`);
  await opener.evaluate((id) => {
    const button = document.createElement('button');
    button.id = '__demo_studio_open_panel';
    button.style.cssText = 'position:fixed;inset:0;z-index:2147483647;opacity:0';
    button.onclick = () => chrome.sidePanel.open({ windowId: id }).then(() => { window.__opened = true; }, (error) => { window.__opened = String(error); });
    document.body.append(button);
  }, windowId);
  await opener.click('#__demo_studio_open_panel');
  await opener.waitForFunction(() => window.__opened !== undefined, null, { timeout: 5000 });
  const opened = await opener.evaluate(() => window.__opened);
  await opener.close();
  if (opened !== true) throw new Error(`Could not open the side panel: ${opened}`);
  await page.bringToFront();
  const cdp = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const panel = cdp.contexts().flatMap((entry) => entry.pages()).find((candidate) => candidate.url().startsWith(`chrome-extension://${extensionId}/${panelPath}`));
    if (panel) {
      await panel.waitForLoadState('load').catch(() => {});
      log(`screen: side panel open (${panelPath})`);
      return { panel, cdp };
    }
    await sleep(100);
  }
  await cdp.close();
  throw new Error('The side panel opened but its page never appeared.');
}

// A real, visible browser window recorded with ScreenCaptureKit. The frame is
// the whole window (tabs, toolbar, extension side panel), so each surface
// reports where its content sits inside the window.
// A visible browser window, with unpacked extensions loaded through Chrome for
// Testing (branded Chrome ignores --load-extension since version 137).
// `browser.profile` keeps a named profile between runs (so a one-time download
// such as Chrome's on-device model is reused); otherwise each run gets a fresh
// temporary profile. `browser.onDeviceAI` turns back on the component updater
// and optimization service that Chrome's built-in Gemini Nano needs; Chrome
// uses the last value of a repeated switch, so these later flags win.
function profileDir(name) {
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) throw new Error('browser.profile must be a short lowercase name like "nano".');
  return join(homedir(), '.cache', 'nava-demo-studio', 'chrome-profiles', name);
}

async function launchWindowBrowser(script, extraArgs = []) {
  const extensions = script.extensions || [];
  const window = { x: 60, y: 60, width: 1440, height: 900, ...(script.window || {}) };
  const persistent = script.browser?.profile ? profileDir(script.browser.profile) : null;
  if (persistent) await mkdir(persistent, { recursive: true });
  const userDataDir = persistent || await mkdtemp(join(tmpdir(), 'demo-studio-profile-'));
  const onDeviceAI = Boolean(script.browser?.onDeviceAI);
  const port = await freePort();
  // Branded Chrome ignores --load-extension since version 137 but still loads
  // unpacked extensions over DevTools when started with
  // --enable-unsafe-extension-debugging, and only branded Chrome runs the
  // component updater that delivers Gemini Nano. "testing" uses Chrome for
  // Testing and the command-line flag instead.
  const testing = script.browser?.engine === 'testing';
  const executablePath = testing ? await chromeForTesting() : undefined;
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    ...(executablePath ? { executablePath } : { channel: process.env.DEMO_STUDIO_CHANNEL || 'chrome' }),
    viewport: null,
    locale: 'en-US',
    colorScheme: script.colorScheme || 'light',
    ignoreDefaultArgs: ['--enable-automation', ...(extensions.length ? ['--disable-extensions'] : []), ...(onDeviceAI ? ['--disable-component-update', '--disable-field-trial-config'] : [])],
    args: [
      ...(onDeviceAI ? ['--disable-features=Translate,MediaRouter,DialMediaRouteProvider', '--enable-features=CDPScreenshotNewSurface,PromptAPIForGeminiNano,OptimizationGuideOnDeviceModel'] : []),
      `--window-position=${window.x},${window.y}`,
      `--window-size=${window.width},${window.height}`,
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--hide-crash-restore-bubble',
      ...extraArgs,
      ...(extensions.length && testing ? [`--disable-extensions-except=${extensions.join(',')}`, `--load-extension=${extensions.join(',')}`] : []),
      ...(extensions.length && !testing ? ['--enable-unsafe-extension-debugging'] : []),
    ],
  });
  if (extensions.length && !testing) {
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const session = await browser.newBrowserCDPSession();
      for (const path of extensions) await session.send('Extensions.loadUnpacked', { path });
    } finally {
      await browser.close().catch(() => {});
    }
  }
  const page = context.pages()[0] || await context.newPage();
  return { context, page, port, userDataDir: persistent ? null : userDataDir, profileDir: userDataDir };
}

async function extensionName(context) {
  const [worker] = context.serviceWorkers();
  return worker ? worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => null) : null;
}

// Unattended browser recording: each surface (the page and the extension side
// panel) is captured with the DevTools screencast and composited back into one
// window by the renderer. Unlike ScreenCaptureKit this works while the window
// is covered or the screen is locked, so an agent can record on its own.
const PANEL_HEADER = 40;
async function openWindowSession(script, { outDir, urlPrefix, log }) {
  const scale = script.deviceScaleFactor || 2;
  const { context, page: firstPage, port, userDataDir } = await launchWindowBrowser(script, [`--force-device-scale-factor=${scale}`, '--hide-scrollbars']);
  let panel = null;
  let cdp = null;
  let layout = null;
  let captures = [];
  const parallelCaptures = [];
  const blockedDemoRequests = [];
  if (script.parallelTargets?.length) {
    await context.route('**/*',async route=>{
      const request=route.request(),url=new URL(request.url());
      if (['POST','PUT','PATCH','DELETE'].includes(request.method()) && script.parallelTargets.some(target=>target.origin===url.origin)) {
        blockedDemoRequests.push({method:request.method(),origin:url.origin,path:url.pathname});
        await route.abort('blockedbyclient');
      } else await route.continue();
    });
  }
  let captureStartMs = null;
  let current = firstPage;
  // Follow web tabs opened after capture starts (an extension opening an
  // application site in its own tab); extension pages are ignored.
  context.on('page', async (opened) => {
    await opened.waitForLoadState('domcontentloaded').catch(() => {});
    if (!/^https?:/.test(opened.url()) || !captures.length) return;
    current = opened;
    opened.setDefaultTimeout(script.stepTimeoutMs || 15000);
    log(`window: following new tab ${new URL(opened.url()).host}`);
    await captures.find((entry) => entry.name === 'page')?.capture.follow(opened).catch(() => {});
    const openedUrl=new URL(opened.url());
    const target=(script.parallelTargets || []).find(item=>item.origin===openedUrl.origin && openedUrl.pathname.startsWith(item.path));
    const legacyName=/\/demo\/(calfresh|wic|ihss)\.html$/.test(openedUrl.pathname) ? openedUrl.pathname.split('/').pop().replace('.html','') : '';
    if (script.captureParallel && (target || legacyName)) {
      const name=target?.name || legacyName;
      const capture = new FrameCapture(context, opened, join(outDir, 'frames', name), { width: layout.page.w * scale, height: layout.page.h * scale, quality: script.quality || 88 });
      const entry = { name, target, page: opened, capture, samples:[] };
      parallelCaptures.push(entry);
      await capture.start();
      await capture.begin(captureStartMs);
      if(target?.viewSelector) await opened.locator(target.viewSelector).evaluate((element,offset)=>{
        element.scrollIntoView({block:'start',behavior:'instant'});
        scrollBy({top:-offset,behavior:'instant'});
      },target.viewOffset || 0);
      const sample = async () => {
        if (entry.stopped) return;
        try {
          const bytes = await opened.screenshot({type:'jpeg',quality:script.quality||88});
          if (!entry.stopped) capture.save(Date.now()-captureStartMs,bytes);
          const controls = await opened.locator(target?.verifySelector || 'input').evaluateAll(describeCapturedControls);
          const filled = controls.filter(control=>control.filled).length;
          if (filled !== entry.lastFilled) {
            const atMs=Date.now()-captureStartMs;
            log(`background ${name}: ${filled} tracked fields filled at ${atMs}ms`);
            entry.samples.push({atMs,filled});entry.lastFilled=filled;
          }
        } catch {}
        if (!entry.stopped) entry.timer=setTimeout(sample,500);
      };
      entry.pending=sample();
    }
  });
  const session = {
    get page() {
      return current;
    },
    frame: null,
    async surface(name = 'page') {
      if (name === 'sidepanel') {
        if (!panel) throw new Error('This step targets the side panel; set "sidePanel": true in the script.');
        return { page: panel, offset: { x: layout.panel.x, y: layout.panel.y } };
      }
      return { page: current, offset: { x: 0, y: 0 } };
    },
    async stageParallelViews(label) {
      await Promise.all(parallelCaptures.map(async ({target,page}) => {
        const view = target?.reviewViews?.find(item=>item.milestone===label);
        if (!view) return;
        await page.locator(view.selector).evaluate((element,offset)=>{
          element.scrollIntoView({block:'start',behavior:'instant'});
          scrollBy({top:-offset,behavior:'instant'});
        },view.offset || 0);
      }));
    },
    async syncActive() {
      const worker = context.serviceWorkers()[0];
      if (!worker) return;
      const url = await worker.evaluate(async () => (await chrome.tabs.query({active:true,currentWindow:true}))[0]?.url).catch(() => null);
      const selected = context.pages().find((candidate) => candidate.url() === url);
      if (selected && selected !== current && /^https?:/.test(url)) {
        current = selected;
        await captures.find((entry) => entry.name === 'page')?.capture.follow(selected);
      }
    },
    async prepare() {
      if (script.sidePanel) ({ panel, cdp } = await openSidePanel(context, current, port, log));
      await current.bringToFront();
      const view = await current.evaluate(() => ({ width: innerWidth, height: innerHeight }));
      const side = panel ? await panel.evaluate(() => ({ width: innerWidth, height: innerHeight })) : null;
      layout = {
        page: { x: 0, y: 0, w: view.width, h: view.height },
        panel: side ? { x: view.width + 1, y: PANEL_HEADER, w: side.width, h: Math.min(side.height, view.height - PANEL_HEADER) } : null,
        title: panel ? await extensionName(context) : null,
      };
      session.frame = { width: view.width + (side ? side.width + 1 : 0), height: view.height };
      if (panel) panel.setDefaultTimeout(script.stepTimeoutMs || 15000);
    },
    async startCapture() {
      const quality = script.quality || 88;
      captures = [
        { name: 'page', rect: layout.page, capture: new FrameCapture(context, current, join(outDir, 'frames', 'page'), { width: layout.page.w * scale, height: layout.page.h * scale, quality }) },
        ...(panel ? [{ name: 'sidepanel', rect: layout.panel, capture: new FrameCapture(panel.context(), panel, join(outDir, 'frames', 'sidepanel'), { width: layout.panel.w * scale, height: layout.panel.h * scale, quality }) }] : []),
      ];
      for (const { capture } of captures) await capture.start();
      await sleep(500);
      const t0 = Date.now();
      captureStartMs = t0;
      await Promise.all(captures.map(({ capture }) => capture.begin(t0)));
      return t0;
    },
    async stopCapture(durationMs) {
      const layers = [];
      for (const { name, rect, capture } of captures) {
        const frames = await capture.stop(durationMs);
        layers.push({ name, rect, frames: frames.map((frame) => ({ t: frame.t, src: `${urlPrefix}/frames/${name}/${frame.file}` })) });
      }
      const manifest = {
        schema: FRAMES_SCHEMA,
        origin: 'window',
        width: session.frame.width * scale,
        height: session.frame.height * scale,
        viewport: session.frame,
        deviceScaleFactor: scale,
        durationMs,
        layers,
        frames: layers.flatMap((layer) => layer.frames),
        ...(panel ? { chrome: { sidePanel: { title: layout.title || 'Extension', headerHeight: PANEL_HEADER } } } : {}),
      };
      if (script.captureParallel) {
        manifest.parallelLayers = [];
        const verification = [];
        for (const {name, target, page, capture} of parallelCaptures) {
          const entry=parallelCaptures.find(item=>item.name===name);entry.stopped=true;clearTimeout(entry.timer);await entry.pending;
          const frames = await capture.stop(durationMs);
          manifest.parallelLayers.push({name,width:layout.page.w*scale,height:layout.page.h*scale,frames:frames.map((frame)=>({t:frame.t,src:`${urlPrefix}/frames/${name}/${frame.file}`}))});
          const controls = await page.locator(target?.verifySelector || 'input').evaluateAll(describeCapturedControls);
          const requiredControls = await page.locator('input[required],select[required],textarea[required]').evaluateAll(describeCapturedControls);
          const expectedChecks = Object.entries(target?.expectedChecks || {}).map(([id,checked])=>({id,expectedChecked:checked,actualChecked:controls.find(control=>control.id===id)?.checked,matched:controls.find(control=>control.id===id)?.checked===checked}));
          verification.push({application:name,site:page.url(),controls,requiredControls:requiredControls.filter(control=>control.visible&&!control.disabled&&!/captcha|recaptcha/i.test(control.id)),expectedChecks,samples:entry.samples,submitAttempts:await page.locator('body').evaluate(node=>Number(node.dataset.submitAttempts||0))});
        }
        await writeFile(join(outDir,'verification.json'),JSON.stringify(verification,null,2));
        if(script.parallelTargets?.length){
          if(verification.length!==script.parallelTargets.length || verification.some(item=>item.controls.filter(control=>control.filled&&control.valid).length < (script.parallelTargets.find(target=>target.name===item.application)?.minimumVerified || 1))) throw new Error('A real-site application did not keep the expected tracked values.');
          if(verification.some(item=>item.expectedChecks.some(check=>!check.matched))) throw new Error('An expected radio or checkbox state was not retained.');
          if(verification.some(item=>script.parallelTargets.find(target=>target.name===item.application)?.requireAllNativeRequired && item.requiredControls.some(control=>!control.valid))) throw new Error('A required live-site form control remains invalid.');
          await writeFile(join(outDir,'blocked-demo-requests.json'),JSON.stringify(blockedDemoRequests,null,2));
          const worker=context.serviceWorkers()[0];
          const audit=await worker.evaluate(async()=>{
            const queue=(await chrome.storage.local.get('nava:work-queue'))['nava:work-queue'];
            const session=(await chrome.storage.session.get('nava:session'))['nava:session'];
            return {applications:(queue?.applications||[]).map(app=>({id:app.id,name:app.name,status:app.status,blocked:(session?.apps||[]).find(item=>item.id===app.id)?.blocked?.map(item=>({fieldKey:item.fieldKey,label:item.label,reason:item.reason})) || []})),events:queue?.audit || []};
          });
          audit.captureStartedAtMs = captureStartMs;
          await writeFile(join(outDir,'application-audit.json'),JSON.stringify(audit,null,2));
        }else if (verification.length!==3 || verification.some(item=>item.controls.length!==6 || item.controls.some(control=>!control.filled||!control.valid) || item.submitAttempts!==0)) throw new Error('The three local applications did not all have six valid filled fields and zero submission attempts.');
      }
      await writeFile(join(outDir, 'frames.json'), `${JSON.stringify(manifest)}\n`);
      return { manifest, source: { kind: 'frames', origin: 'window', manifest: `${urlPrefix}/frames.json` } };
    },
    async close() {
      await cdp?.close().catch(() => {});
      await context.close().catch(() => {});
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return session;
}

async function openScreenSession(script, { outDir, urlPrefix, log, dryRun = false }) {
  const { context, page, port, userDataDir, profileDir: browserProfile } = await launchWindowBrowser(script);
  let panel = null;
  let cdp = null;
  let capture = null;
  const measure = (target) => target.evaluate(() => ({ outerWidth, outerHeight, innerWidth, innerHeight, dpr: devicePixelRatio }));
  let sizes = null;
  const session = {
    page,
    frame: null,
    // Content offsets inside the window: the page sits under the toolbar at
    // the left edge; the side panel is anchored to the bottom-right corner.
    async surface(name = 'page') {
      if (name === 'sidepanel') {
        if (!panel) throw new Error('This step targets the side panel; set "sidePanel": true in the script.');
        const inner = await panel.evaluate(() => ({ innerWidth, innerHeight }));
        return { page: panel, offset: { x: sizes.outerWidth - inner.innerWidth, y: sizes.outerHeight - inner.innerHeight } };
      }
      const current = await measure(page);
      return { page, offset: { x: 0, y: current.outerHeight - current.innerHeight } };
    },
    async prepare() {
      if (script.sidePanel) ({ panel, cdp } = await openSidePanel(context, page, port, log));
      await page.bringToFront();
      sizes = await measure(page);
      session.frame = { width: sizes.outerWidth, height: sizes.outerHeight };
      if (panel) panel.setDefaultTimeout(script.stepTimeoutMs || 15000);
    },
    async startCapture() {
      if (dryRun) return Date.now();
      const pid = await browserPid(browserProfile);
      if (!pid) throw new Error('Could not find the browser process to record.');
      capture = new ScreenCapture({ outDir, urlPrefix, target: { pid }, fps: script.fps || 60, scale: sizes.dpr || 2, activate: true, log });
      await capture.start();
      await sleep(400);
      await capture.begin();
      return Date.now();
    },
    async stopCapture(durationMs) {
      if (dryRun) {
        const manifest = { schema: FRAMES_SCHEMA, origin: 'screen', width: session.frame.width * 2, height: session.frame.height * 2, viewport: session.frame, deviceScaleFactor: 2, durationMs, frames: [] };
        await writeFile(join(outDir, 'frames.json'), `${JSON.stringify(manifest)}\n`);
        return { manifest, source: { kind: 'frames', origin: 'screen', manifest: `${urlPrefix}/frames.json` } };
      }
      const { manifest, summary } = await capture.stop();
      if (summary?.dropped) log(`screen: ${summary.dropped} frames dropped while encoding`);
      return { manifest, source: { kind: 'frames', origin: 'screen', manifest: `${urlPrefix}/frames.json` } };
    },
    async close() {
      await cdp?.close().catch(() => {});
      await context.close().catch(() => {});
      if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
  return session;
}

function locate(page, target) {
  if (typeof target === 'string') return page.locator(target).first();
  if (target.role) return page.getByRole(target.role, target.name ? { name: target.name, exact: target.exact } : {}).first();
  if (target.label) return page.getByLabel(target.label, { exact: target.exact }).first();
  if (target.placeholder) return page.getByPlaceholder(target.placeholder, { exact: target.exact }).first();
  if (target.testId) return page.getByTestId(target.testId).first();
  return page.getByText(target.text, { exact: target.exact }).first();
}

function describe(step) {
  return step.label || (typeof step.target === 'string' ? step.target : JSON.stringify(step.target || step.url || step.do));
}

// Runs an agent-authored demo script and writes:
//   frames/*.jpg + frames.json  the raw capture
//   trace.json                  the privacy-safe action trace for the planner
// `script.recorder` picks the capture: "page" (default) records the page in
// headless Chrome; "screen" records a real browser window, including browser
// chrome, extensions, and their side panels, with ScreenCaptureKit.
export async function recordScript(script, { outDir, origin, urlPrefix, voice, headless = true, dryRun = false, log = () => {} }) {
  const stepTimeoutMs = script.stepTimeoutMs || 15000;
  const session = script.recorder === 'screen'
    ? await openScreenSession(script, { outDir, urlPrefix, log, dryRun })
    : script.recorder === 'window'
      ? await openWindowSession(script, { outDir, urlPrefix, log })
      : await openPageSession(script, { outDir, urlPrefix, headless });
  const { page } = session;
  page.setDefaultTimeout(stepTimeoutMs);
  const events = [];
  let t0 = null;
  const clock = () => Date.now() - t0;
  // Setup steps run before capture starts; nothing they do reaches the trace.
  let recording = false;
  const emit = (event) => { if (recording) events.push(event); };
  // A camera focus stays on its target until the next pointer action.
  let openFocus = null;
  const closeFocus = () => {
    if (openFocus) openFocus.endMs = Math.max(openFocus.atMs, clock());
    openFocus = null;
  };
  const textOf = (value) => {
    if (typeof value === 'string') return value;
    const secret = process.env[value.env];
    if (secret === undefined) throw new Error(`environment variable ${value.env} is not set`);
    return secret;
  };
  const resolveUrl = (url) => new URL(url, `${origin}/`).href;
  const lines = new Map(narrationLines(script).map((line) => [line.stepIndex, line]));
  // The pointer lives in capture-frame coordinates (CSS px of the frame).
  let pointer = null;
  let frame = null;
  const normalized = (x, y) => ({ x: Number(clamp(x / frame.width, 0, 1).toFixed(4)), y: Number(clamp(y / frame.height, 0, 1).toFixed(4)) });

  // The shape the system cursor would take over the target: a hand over
  // clickable elements, an I-beam over text inputs.
  const cursorOver = (surface, x, y) => surface.page.evaluate(({ px, py }) => {
    const element = document.elementFromPoint(px, py);
    if (!element) return null;
    const style = getComputedStyle(element).cursor;
    if (style === 'pointer') return 'pointer';
    if (style === 'text' || element.matches('textarea, [contenteditable=""], [contenteditable="true"], input:not([type=checkbox]):not([type=radio]):not([type=button]):not([type=submit]):not([type=range])')) return 'text';
    return null;
  }, { px: x - surface.offset.x, py: y - surface.offset.y }).catch(() => null);

  async function moveTo(surface, x, y) {
    const distance = Math.hypot(x - pointer.x, y - pointer.y);
    if (distance < 2) return;
    const durationMs = clamp(280 + (distance * 0.55), 350, 950);
    const steps = Math.max(8, Math.round(durationMs / 16));
    const from = { ...pointer };
    const shape = await cursorOver(surface, x, y);
    const startedAt = clock();
    const event = { atMs: startedAt, endMs: startedAt + Math.round(durationMs), kind: 'move', ...normalized(x, y), ...(shape ? { cursor: shape } : {}) };
    emit(event);
    for (let index = 1; index <= steps; index += 1) {
      const progress = easeInOutCubic(index / steps);
      await surface.page.mouse.move(lerp(from.x, x, progress) - surface.offset.x, lerp(from.y, y, progress) - surface.offset.y);
      await sleep((startedAt + ((durationMs * index) / steps)) - clock());
    }
    event.endMs = clock();
    Object.assign(pointer, { x, y });
  }

  async function settleScroll(target = page) {
    let last = null;
    let stable = 0;
    for (let attempt = 0; attempt < 40 && stable < 3; attempt += 1) {
      await sleep(60);
      const position = await target.evaluate(() => `${scrollX},${scrollY}`);
      stable = position === last ? stable + 1 : 0;
      last = position;
    }
  }

  // Returns the target's box in capture-frame coordinates.
  async function reveal(surface, locator, label) {
    await locator.waitFor({ state: 'visible' });
    const moved = await locator.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      if (rect.top >= 72 && rect.bottom <= innerHeight - 72) return false;
      element.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return true;
    });
    if (moved) {
      const atMs = clock();
      await settleScroll(surface.page);
      emit({ atMs, endMs: clock(), kind: 'scroll', ...(label ? { label } : {}) });
    }
    const box = await locator.boundingBox();
    if (!box) throw new Error('target has no visible box');
    return { ...box, x: box.x + surface.offset.x, y: box.y + surface.offset.y };
  }

  async function pointAt(surface, step, box) {
    const at = step.at || (step.do === 'type' ? { x: 0.25, y: 0.5 } : { x: 0.5, y: 0.5 });
    const x = box.x + (box.width * at.x);
    const y = box.y + (box.height * at.y);
    await moveTo(surface, x, y);
    return { x, y };
  }

  const boxSize = (box) => ({ w: Number(clamp(box.width / frame.width, 0, 1).toFixed(4)), h: Number(clamp(box.height / frame.height, 0, 1).toFixed(4)) });

  async function click(step, label) {
    const surface = await session.surface(step.in);
    const locator = locate(surface.page, step.target);
    const box = await reveal(surface, locator, label);
    if (!recording) {
      // Setup is not part of the interaction trace. Use an actionability-checked
      // click so late side-panel renders cannot move the button under the pointer.
      await locator.click();
      return { locator, box, surface };
    }
    const { x, y } = await pointAt(surface, step, box);
    await surface.page.mouse.down();
    emit({ atMs: clock(), kind: 'click', ...normalized(x, y), ...boxSize(box), ...(label ? { label } : {}) });
    await sleep(70);
    await surface.page.mouse.up();
    return { locator, box, surface };
  }

  const runners = {
    async goto(step) {
      await session.page.goto(resolveUrl(step.url), { waitUntil: 'load' });
      if (step.label) emit({ atMs: clock(), kind: 'milestone', label: step.label });
    },
    async click(step) {
      const { surface } = await click(step, step.label);
      await surface.page.waitForLoadState('domcontentloaded').catch(() => {});
      await sleep(250);
      await session.syncActive?.();
      // The page may have changed under the stationary pointer; record the
      // shape the system cursor would switch to.
      const shape = await cursorOver(surface, pointer.x, pointer.y);
      const atMs = clock();
      emit({ atMs, endMs: atMs, kind: 'move', ...normalized(pointer.x, pointer.y), ...(shape ? { cursor: shape } : {}) });
    },
    async type(step) {
      const { locator, box, surface } = await click(step, undefined);
      if (step.clear) await locator.fill('');
      const at = normalized(pointer.x, pointer.y);
      const atMs = clock();
      await surface.page.keyboard.type(textOf(step.text), { delay: step.delayMs ?? 45 });
      emit({ atMs, endMs: clock(), kind: 'type', ...at, ...boxSize(box), ...(step.label ? { label: step.label } : {}) });
    },
    // Chooses the option without opening the native popup, which would
    // otherwise appear in a screen recording.
    async select(step) {
      const surface = await session.surface(step.in);
      const locator = locate(surface.page, step.target);
      const box = await reveal(surface, locator, step.label);
      const { x, y } = await pointAt(surface, step, box);
      emit({ atMs: clock(), kind: 'click', ...normalized(x, y), ...boxSize(box), ...(step.label ? { label: step.label } : {}) });
      await locator.selectOption(step.value);
    },
    async hover(step) {
      const surface = await session.surface(step.in);
      const locator = locate(surface.page, step.target);
      await pointAt(surface, step, await reveal(surface, locator, step.label));
    },
    async scroll(step) {
      const surface = await session.surface(step.in);
      const atMs = clock();
      if (step.to !== undefined) await locate(surface.page, step.to).evaluate((element) => element.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      else await surface.page.evaluate(({ y, by }) => (by !== undefined ? scrollBy({ top: by, behavior: 'smooth' }) : scrollTo({ top: y, behavior: 'smooth' })), { y: step.y, by: step.by });
      await settleScroll(surface.page);
      emit({ atMs, endMs: clock(), kind: 'scroll', ...(step.label ? { label: step.label } : {}) });
    },
    async wait(step) {
      const atMs = clock();
      const timeout = step.timeoutMs || 30000;
      if (step.for !== undefined) {
        const locator = locate((await session.surface(step.in)).page, step.for);
        await locator.waitFor({ state: 'visible', timeout });
        // "filled": wait until an agent (not this script) has put a value in it.
        if (step.until === 'filled') {
          const deadline = Date.now() + timeout;
          while (!(await locator.inputValue().catch(() => ''))) {
            if (Date.now() > deadline) throw new Error(`nothing filled ${JSON.stringify(step.for)} within ${timeout} ms`);
            await sleep(250);
          }
        }
      } else {
        await sleep(step.ms);
      }
      emit({ atMs, endMs: clock(), kind: 'wait', ...(step.label ? { label: step.label } : {}) });
    },
    async pause(step) {
      const atMs = clock();
      await sleep(step.ms ?? 1000);
      emit({ atMs, endMs: clock(), kind: 'pause', ...(step.label ? { label: step.label } : {}) });
    },
    async milestone(step) {
      await session.stageParallelViews?.(step.label);
      emit({ atMs: clock(), kind: 'milestone', label: step.label });
    },
    // Points the camera at a region without moving the pointer, e.g. a form
    // an agent is filling on its own.
    async focus(step) {
      const surface = await session.surface(step.in);
      const box = await reveal(surface, locate(surface.page, step.target), step.label);
      openFocus = { atMs: clock(), endMs: clock(), kind: 'focus', ...normalized(box.x + (box.width / 2), box.y + (box.height / 2)), ...boxSize(box), ...(step.label ? { label: step.label } : {}) };
      emit(openFocus);
    },
  };
  const holdsFocus = new Set(['wait', 'pause', 'milestone', 'focus']);

  try {
    await page.goto(resolveUrl(script.startUrl), { waitUntil: 'load' });
    await session.prepare();
    frame = session.frame;
    pointer = { x: (script.cursor?.x ?? 0.5) * frame.width, y: (script.cursor?.y ?? 0.62) * frame.height };
    const home = await session.surface();
    await page.mouse.move(pointer.x - home.offset.x, pointer.y - home.offset.y);
    if (script.setup?.length) {
      t0 = Date.now();
      for (const [index, step] of script.setup.entries()) {
        log(`setup ${index + 1}/${script.setup.length}: ${step.do} ${describe(step)}`);
        try {
          await runners[step.do](step);
        } catch (error) {
          throw new Error(`Setup step ${index + 1} (${step.do} ${describe(step)}) failed: ${error.message.split('\n')[0]}`);
        }
      }
    }
    t0 = await session.startCapture();
    recording = true;
    emit({ atMs: 0, endMs: 0, kind: 'move', ...normalized(pointer.x, pointer.y) });

    // Narration paces the recording: a step waits for its line to finish unless
    // it sets waitForSpeech: false, and lines never overlap each other.
    let speechEndsAt = 0;
    for (const [index, step] of script.steps.entries()) {
      const line = lines.get(index);
      if (line) {
        await sleep((speechEndsAt + 250) - clock());
        const clip = voice?.clips?.[line.id];
        const startedAt = clock();
        const durationMs = clip?.durationMs ?? Math.round(line.text.split(/\s+/).length * 380);
        speechEndsAt = startedAt + durationMs;
        emit({ atMs: startedAt, endMs: speechEndsAt, kind: 'narration', text: line.text, clip: line.id });
        await sleep(step.leadMs ?? 450);
      }
      log(`step ${index + 1}/${script.steps.length}: ${step.do} ${describe(step)}`);
      if (!holdsFocus.has(step.do)) closeFocus();
      try {
        await runners[step.do](step);
      } catch (error) {
        throw new Error(`Step ${index + 1} (${step.do} ${describe(step)}) failed: ${error.message.split('\n')[0]}`);
      }
      if (step.waitForSpeech !== false) await sleep((speechEndsAt + 300) - clock());
      if (step.holdMs) await sleep(step.holdMs);
    }
    await sleep((speechEndsAt + 300) - clock());
    await sleep(script.tailMs ?? 1200);
    closeFocus();
    const durationMs = clock();
    const { manifest, source } = await session.stopCapture(durationMs);
    events.sort((left, right) => left.atMs - right.atMs);
    for (const event of events) if (event.endMs > durationMs) event.endMs = durationMs;
    const trace = {
      schema: TRACE_SCHEMA,
      title: script.title || 'Product demo',
      durationMs,
      viewport: frame,
      source,
      ...(script.presenter === false ? {} : { presenter: `/${(script.presenter?.image || 'assets/fictional-presenter.png').replace(/^\//, '')}` }),
      events,
    };
    await writeFile(join(outDir, 'trace.json'), `${JSON.stringify(trace, null, 2)}\n`);
    log(`captured ${manifest.frames.length} frames over ${(durationMs / 1000).toFixed(1)}s`);
    return { trace, manifest };
  } finally {
    await session.close();
  }
}
