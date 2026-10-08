# Nava Agentic Demo Studio

A free, local-first alternative to Screen Studio that agents can drive end to
end. An agent writes a short demo script; one command records it in headless
Chrome, narrates it, scores it, edits it, and exports a polished 1080p60 MP4 with
a talking-head presenter in the corner. No human steps, no paid services, and no
recording is uploaded by the studio. MIT licensed; no Screen Studio license,
paid video service, or AI subscription is required for recording and editing.
Automation of the product being demonstrated may have its own requirements.

New teammates can start with [the team quick start](docs/TEAM_QUICKSTART.md).
For tightening an existing recording, see [editing waits and parallel work](docs/EDITING.md).

![Contact sheet of the sample demo](docs/benefits-portal-contact-sheet.jpg)

![A frame from the sample demo](docs/frame-browser-presenter.jpg)

The extension-window pipeline has also been validated end to end with the real
unpacked Nava Form-Filling Assistant, the paired Codex subscription runtime,
generated warm-pop music, local narration, and the animated presenter:

![Contact sheet from the naturally narrated Codex-powered extension demo](docs/form-filler-extension-codex-natural-voice-contact-sheet.png)

## What you get

| Screen Studio-style feature | How it works here |
| --- | --- |
| Auto zoom where you click or type | Zoom depth adapts to the target (small buttons get a closer look than wide form rows). Camera moves use a monotone spline, so chained pans glide through targets instead of stopping at each one |
| Camera follows the cursor | While zoomed, the view keeps the pointer inside a comfort margin |
| Motion blur | Fast pans, zooms, and cursor moves are rendered with a 180° shutter (up to 10 sub-frames) |
| Smooth cursor with real shapes | Cursor redrawn from recorded paths: an arrow, a hand over clickable elements, and an I-beam over text fields. It hides when idle and returns just before the next move |
| Click effects and sounds | Ripples plus a two-part mechanical click (press and release), panned to where the click happens, and soft keyboard ticks while typing |
| Speed up slow parts | Idle spans (loading, waiting) are fast-forwarded with ramped speed changes and a fast-forward badge. Narration and actions always play at 1× |
| Cut dead time | `speed.cuts` removes source-time ranges entirely. Voice, captions, camera and all captured tabs follow one shared edit map; cuts that overlap narration or recorded actions are rejected |
| Background and window | Mesh-gradient wallpapers (`nava`, `aurora`, `sunset`, `ocean`, `midnight`, `paper`) with film grain against banding, and a macOS browser window with traffic lights and a URL bar |
| Title and closing cards | `intro` / `outro` cards in the script |
| AI voiceover | Kokoro-82M, an Apache-2.0 neural voice, runs locally, faster than real time on an M1. macOS `say` is the fallback. The recorder paces the actions to the narration |
| Background music | Five generated styles (`upbeat`, `synthwave`, `lofi`, `ambient`, `warm-pop`) with real sound design (drums, sidechain pumping, supersaws, FM electric piano, risers, vinyl). The arrangement follows the demo: a sparse intro under the title card, the groove on the reveal (tempo nudged so it lands on a bar line), a lift during fast-forwards, and a resolving outro. Or bring your own track (`music.file`), looped and loudness-matched. Always ducked under the voice, with no licensing |
| Talking head in the corner | A fictional presenter animated from one portrait with a triangle-mesh face rig. Audio-driven jaw, lip spread and rounding, visible teeth, nods and brow raises on stressed syllables, blinks at phrase ends, glances toward the demo during pauses, and it moves out of the way when the action is under it |
| Voice orb alternative | Set `presenter.kind` to `orb` for a code-rendered purple voice presence that breathes, pulses, and emits waveform filaments in sync with narration—no face or image asset required |
| Subtitles | Timed captions that highlight each word as it is spoken |
| Record real windows | ScreenCaptureKit capture of any window or display, including browser chrome and extension side panels, with a recorded pointer log driving zoom and cursor |
| Export | Frame-by-frame WebCodecs render to H.264/AAC MP4 at 1080p or 4K, 30 or 60 fps: deterministic, no dropped frames |

## Quick start

Requires Node 20+ and Google Chrome. The neural voice (`kokoro-js`) is an
optional dependency; the first run downloads the Kokoro model (about 330 MB)
into `~/.cache/nava-demo-studio/models`. Without it, macOS `say` is used, and
`"voice": { "provider": "none" }` renders captions with no voiceover.

```bash
npm install
npm run doctor
npm run make
```

`npm run make` records the bundled fictional benefits-portal fixture and writes
`exports/benefits-portal.mp4` (about 40 s long, about 75 s to produce). Review it
without opening a player:

```bash
node bin/demo-studio.mjs inspect exports/benefits-portal.mp4
```

Or scrub it interactively:

```bash
npm run serve
```

Open <http://127.0.0.1:4310/web/?project=/recordings/benefits-portal/project.json>.

## Making a demo (for agents)

1. Write a script. Every step can carry a `say` line; the recorder waits for the
   line to finish unless the step sets `"waitForSpeech": false`.

   ```json
   {
     "schema": "nava.demo-script.v1",
     "title": "An agent fills a benefits application",
     "startUrl": "examples/fixtures/benefits-portal/index.html",
     "voice": { "provider": "kokoro", "voice": "af_heart" },
     "frame": { "kind": "browser", "url": "benefits.example.org/apply" },
     "intro": { "eyebrow": "Nava Labs", "title": "An agent fills a benefits application" },
     "steps": [
       { "do": "click", "target": "#start", "label": "Start application", "say": "It starts a new application." },
       { "do": "type", "target": { "label": "First name" }, "text": "Celeste", "label": "Enter first name" },
       { "do": "wait", "for": "#review h2", "label": "Checking answers" },
       { "do": "hover", "target": "#ready", "say": "And it stops before anything is submitted." }
     ]
   }
   ```

2. Run `node bin/demo-studio.mjs make path/to/script.json`.
3. Run `inspect` on the MP4 and look at the contact sheet before sharing it
   (`--at 12.5,20` grabs full-size frames at specific seconds).

See [examples/benefits-portal.script.json](examples/benefits-portal.script.json)
for a complete script.

### Steps

| `do` | Required | Optional | Notes |
| --- | --- | --- | --- |
| `goto` | `url` | | Relative URLs are served from this repository |
| `click` | `target` | `at` | `at` is where to click inside the element, `{ "x": 0-1, "y": 0-1 }` |
| `type` | `target`, `text` | `delayMs`, `clear` | `text` is typed but never written to the trace |
| `select` | `target`, `value` | | Native select popups do not render in headless capture |
| `hover` | `target` | | |
| `scroll` | `to`, `y`, or `by` | | Smooth scroll |
| `wait` | `ms` or `for` | `timeoutMs`, `until: "filled"` | Waits are the spans that get fast-forwarded; `until` waits for an agent to fill the field |
| `focus` | `target` | | Holds the camera on a region without moving the pointer |
| `pause` | | `ms` | A deliberate hold at 1× |
| `milestone` | `label` | | |

Every step also accepts `label`, `say`, `leadMs`, `holdMs`, `waitForSpeech`, and `in` (`page` or `sidepanel`). A script's `setup` list takes the same steps (without `say`) and runs them before recording starts.
A `target` is a CSS/Playwright selector string, or `{ "text" }`, `{ "label" }`,
`{ "placeholder" }`, `{ "testId" }`, or `{ "role", "name" }`.

Script-level options:

- `viewport` and `deviceScaleFactor` (default 2, for retina capture).
- `voice`: `provider` is `auto`, `kokoro`, `say`, or `none`. `voice` is a Kokoro
  voice such as `af_heart`, `af_bella`, `am_michael`, or `bf_emma`, or a `say`
  voice. Also `speed` (Kokoro) and `rate` (`say`). For published demos, prefer
  Kokoro and tune `speed` to the script and footage; macOS `say` is kept as an
  availability fallback and will sound noticeably more synthetic.
- `frame`: `{ "kind": "browser" | "none", "url": "…" }`, or `false`.
- `browser` (window and screen recorders): `{ "profile": "nano", "onDeviceAI": true }`.
  `profile` keeps a named Chrome profile in `~/.cache/nava-demo-studio/chrome-profiles/`
  between runs. `onDeviceAI` enables Chrome's built-in Gemini Nano, which
  downloads once into that profile. The window recorder follows web tabs the
  page or an extension opens, so a site an extension launches is recorded
  too.
- `music`: `{ "style": "upbeat" | "synthwave" | "lofi" | "ambient" | "warm-pop", "volume": 0.6 }`,
  `{ "file": "assets/music/track.mp3", "volume", "startAtS", "loop" }`, or
  `false`. Preview the styles with `node bin/demo-studio.mjs music`.
- `presenter` (or `false`), `intro`, `outro`.
  Use `{ "kind": "orb", "color": "#8b5cf6" }` for the animated voice orb.
- `zoom`: `minScale`, `maxScale`, `targetShare`, `sessionGapMs`, and more.
  `introMs` and `outroMs` control the duration of the opening and closing cards.
  `speed.cuts` accepts ordered `{ "startMs", "endMs" }` ranges in source milliseconds.
  `captureParallel: true` records background tabs on one clock; author
  `parallel-start` / `parallel-end` milestones and preserve active work with
  `pause` events in the recorded trace before planning.
- `speed`: `minIdleMs`, `maxRate`.
- `output`: `width`, `height`, `fps`, `bitrate`, `motionBlur`.
- `style`: `background` (a wallpaper name or a list of colors), `accent`,
  `padding`, `radius`.

## Recording extensions and real windows

There are three recorders. Pick one with `"recorder"` in the script:

| Recorder | What it captures | Needs |
| --- | --- | --- |
| `page` (default) | The web page, headless | Nothing; runs anywhere |
| `window` | A real Chrome window: the page plus an extension's side panel, each captured with the DevTools screencast and composited back into one window with drawn browser chrome | Nothing extra. Works unattended, while the window is covered or the Mac is locked |
| `screen` | The true pixels of any window or display (real browser chrome, native apps) with ScreenCaptureKit | Screen Recording permission and an unlocked display |

For an extension demo an agent records on its own, use `window`. Add
`"extensions": ["path/to/unpacked"]` and `"sidePanel": true`, and target the
panel with `"in": "sidepanel"`. `setup` steps run before capture starts, for
example to pair a model runtime. A typed value can come from the environment
(`"text": { "env": "NAVA_MODEL_BRIDGE_TOKEN" }`), so secrets never appear in the
script or the video. `{ "do": "focus", "target": "#form" }` points the camera
at something an agent is filling on its own. `{ "do": "wait", "for": "#phone", "until": "filled" }`
waits for that agent to finish. See
[examples/form-filler-extension.script.json](examples/form-filler-extension.script.json),
which records the Nava Form-Filling Assistant filling a form with Claude
through its subscription companion.

### Screen recording (real windows, native apps)

The page recorder sees only the web page. The screen recorder captures a real
window with ScreenCaptureKit, including browser tabs and toolbar, extension
side panels, and any native app. A small Swift helper
(`native/demo-capture.swift`, built automatically the first time with
`swiftc`) captures at retina resolution with the system cursor hidden, and
writes the same frame format the renderer already uses. It also logs cursor
position, clicks, and cursor shape (never keystrokes), so auto-zoom, the drawn
cursor, and click effects work on any recording.

macOS asks for **Screen Recording** permission once, for the app that runs the
command (Terminal, or Claude or Codex for an agent). Run `node bin/demo-studio.mjs screen access`,
approve it in System Settings > Privacy & Security > Screen & System Audio
Recording, then quit and reopen that app.

Two ways to use it:

1. **Record whatever a person or a computer-use agent does:**

   ```bash
   node bin/demo-studio.mjs screen list
   node bin/demo-studio.mjs screen record --app "Google Chrome" --seconds 45 --name my-demo --caption "My demo"
   ```

   It stops after `--seconds` (or on Ctrl-C), then plans and renders
   `exports/my-demo.mp4` with zooms driven by the recorded clicks.

2. **Scripted, with a real browser window:** set `"recorder": "screen"` in a
   script. It works like `window` but captures true pixels, so the display must
   be unlocked and the recorded window is brought to the front. Check a script
   without recording it by running `node bin/demo-studio.mjs record SCRIPT.json --dry-run`.

While a scripted screen recording runs, keep your own mouse off the recorded
window: real mouse events still reach it.

## Commands

| Command | What it does |
| --- | --- |
| `make SCRIPT [--out OUT.mp4] [--4k] [--fps 30] [--headed]` | voice, record, plan, render |
| `voice SCRIPT` | Synthesize narration only |
| `record SCRIPT [--headed]` | Voice + record + plan, no render |
| `plan TRACE PROJECT [--voice MANIFEST] [--script SCRIPT]` | Trace to project (edit decision list) |
| `render PROJECT [OUT.mp4]` | Headless MP4 render of a project |
| `inspect VIDEO [SHEET.png] [--at s,s]` | Contact sheet or full-size frames |
| `rig [RIG.json] [OUT.png]` | Preview a presenter rig's mouth and blink states |
| `music [--style NAME\|all\|list] [--seconds 30]` | Render music auditions (M4A/WAV), spectrograms, and levels |
| `screen access` | Request macOS Screen Recording permission |
| `screen list [--json]` | Windows and displays you can record |
| `screen record [--app NAME \| --window ID \| --display ID] [--seconds N] [--name SLUG] [--caption TITLE]` | Record a window a person or agent drives, then render it |
| `record SCRIPT --dry-run` | Run a script's steps without capturing, to check them |
| `serve [PORT]` | Preview UI |
| `doctor` | Check Chrome, H.264/AAC encoding, and voices |

## Architecture

```text
script.json --voice--> recordings/<slug>/voice/*.wav + manifest.json
            --record-> recordings/<slug>/frames/*.jpg + frames.json + trace.json
            --plan---> recordings/<slug>/project.json
            --render-> exports/<slug>.mp4
```

- `lib/recorder.mjs` drives headless Chrome through the script and captures
  damage-driven retina frames with the DevTools screencast.
- `lib/planner.mjs` turns the trace into speed spans, camera keyframes, cursor
  paths, subtitles, voice placement, click effects, and presenter swaps.
- `lib/timeline.mjs` holds the pure timing and framing math shared by Node and
  the browser.
- `web/compositor.js` draws a frame as a pure function of output time;
  `web/audio.js` renders the mix offline; `web/render.js` encodes with
  WebCodecs and muxes with `mp4-muxer`. The preview and the export use the same
  code, so what you scrub is what you ship.

## Privacy contract

A trace may contain only timestamps, normalized pointer coordinates, event
kinds, redacted step labels, and script-authored narration. `validateTrace`
rejects any other field, so a typed value cannot slip into a trace, and the e2e
test (`npm run e2e`) checks a real recording for the typed strings. Scripts must
use synthetic demo data because typed values are visible in the video itself.

## The presenter

`assets/fictional-presenter.png` is an entirely fictional, AI-generated person.
`assets/fictional-presenter.rig.json` marks the lip line, eye openings, eyelid
skin bands, crop, and head pivot in image pixels. To add a presenter, add a
portrait and a rig, then check it with `node bin/demo-studio.mjs rig
assets/your.rig.json`:

![Presenter rig preview](docs/presenter-rig.jpg)

Do not use a real person's likeness.

## Known limits

- The screen recorder needs macOS 13 or newer, the Xcode Command Line Tools
  (for `swiftc`), Screen Recording permission, and an unlocked display: macOS
  draws no windows while the screen is locked, and Chrome stops painting a
  covered window. The `window` recorder has neither limit. Scripted side
  panels need an extension that declares `side_panel`.
- Extensions load into real Google Chrome over DevTools
  (`--enable-unsafe-extension-debugging` plus `Extensions.loadUnpacked`),
  because Chrome 137+ ignores `--load-extension`. Set
  `"browser": { "engine": "testing" }` to use Chrome for Testing instead.
  Chrome for Testing has no working component updater, so Gemini Nano only
  works in the Chrome engine.
- Gemini Nano downloads once, about 4 GB, into the named profile
  (`"browser": { "profile": "chrome-nano", "onDeviceAI": true }`). It does not
  reuse the copy in your everyday Chrome profile.
- Kokoro sounds natural but has no word timings, so lip shapes come from the
  audio spectrum rather than phonemes. That is close at picture-in-picture
  size, but not frame-accurate the way a phoneme aligner would be.
- The talking head is a mesh warp of one still portrait: no head turns and no
  lighting changes. A generative lip-sync model would look more alive; see
  work package 4 in [ROADMAP.md](ROADMAP.md).
- Legacy `rawVideo` projects (a `.mov`/`.mp4` plus a hand-written trace) still
  plan and render, but seeking a long H.264 file per frame is slow.

## Tests

```bash
npm test
npm run e2e
```

`npm test` runs the unit tests and needs no browser. `npm run e2e` records and
renders a short demo and needs Chrome.
