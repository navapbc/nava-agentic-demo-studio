# Agent contribution guide

Keep the tool local-first and deterministic. Never record typed text, DOM values,
passwords, tokens, or clipboard contents in an interaction trace. A trace may
contain only timestamps, normalized pointer coordinates, event kinds, redacted
step labels, public page titles, and script-authored narration. The allowed
fields per event kind live in `EVENT_FIELDS` in `lib/planner.mjs`; adding a
field means changing that contract and its tests on purpose.

The pipeline is `script -> voice -> record -> trace -> plan -> preview -> render`.
The presentation pipeline adds `story plan -> presentation manifest -> demos ->
editable deck + browser presentation + PDF + portable package`. Keep demos on
their original shared timeline; assembly must not alter their bytes. Do not
package recording scripts, environment values or author-machine paths. Preserve
editable text/tables and embedded local media in the PowerPoint. Test that a
video pauses when its slide is hidden and that media is present in the PPTX/ZIP.
Preserve the JSON schemas (`nava.demo-script.v1`, `nava.demo-trace.v1`,
`nava.demo-project.v1`, `nava.demo-frames.v1`, `nava.demo-voice.v1`,
`nava.presenter-rig.v1`), add tests for every timing transform, and make media
features optional when a machine lacks a codec or speech provider.

## Making a demo

1. Write a script under `examples/` using synthetic demo data only. Typed values
   are visible in the video even though they never reach the trace.
2. Run `node bin/demo-studio.mjs make <script>`.
3. Run `node bin/demo-studio.mjs inspect exports/<slug>.mp4` and look at the
   contact sheet. Grab exact moments with `--at`. Do not share a video you have
   not looked at.

## Screen recordings

`"recorder": "screen"` records a real window with ScreenCaptureKit through
`native/demo-capture.swift`. The helper must never read keystrokes. Its pointer
log holds only position, button state, and cursor shape. Check new screen
scripts with `record SCRIPT --dry-run` before recording them. A dry run needs
no Screen Recording permission.

## Working on the code

- `web/compositor.js` must stay a pure function of output time, so preview,
  scrubbing, and export render identical frames. The same goes for
  `web/presenter.js` and `web/audio.js`.
- Plan anything the viewer perceives as motion (camera, presenter swaps,
  subtitles) in output time; keep anything synced to the page (cursor, clicks)
  in source time. `lib/timeline.mjs` converts between them.
- Overlay sizes are authored for 1080p and scale with the output height.
- Run `npm test` (no browser needed) and `npm run e2e` (needs Chrome) before
  opening a pull request. Recordings and exports stay out of git.

Do not add covert recording, CAPTCHA bypass, final-submit automation, biometric
identification, a requirement to upload recordings to a cloud service, or a
presenter based on a real person's likeness.
