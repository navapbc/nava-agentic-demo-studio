# Roadmap

## Milestone 1 — working local draft

- [x] Privacy-safe action-trace format, enforced field-by-field by `validateTrace`
- [x] Automatic click zooms and click ripples
- [x] Automatic idle-span compression, with speed ramps and a fast-forward badge
- [x] Caption and narration cue track
- [x] Fictional presenter picture-in-picture asset
- [x] Browser canvas preview and export (now MP4, frame-accurate)
- [x] Agent-driven browser recorder (headless Chrome, retina screencast)
- [x] ScreenCaptureKit recorder with window/display selection
- [x] Pointer log (position, clicks, cursor shape; no keystrokes) instead of an event tap
- [x] Scripted screen recordings in a real browser window, with unpacked extensions and side panels

## Milestone 2 — agentic authoring

- [x] Agent-authored demo scripts (`nava.demo-script.v1`) with one-command `make`
- [x] Local speech synthesis (macOS `say`), narration-paced recording
- [x] Generated background music, click audio, and voice ducking
- [x] Five music styles with a demo-aware arrangement, user music files, and `music` auditions
- [x] Narration loudness normalization across voice providers
- [x] Self-review: `inspect` contact sheets and full-size frame grabs
- [ ] Generate a script from an agent run and its sanitized activity log (work package 2)
- [ ] Let an agent mark hook, proof, comparison, and closing moments
- [ ] Model-reviewed narration script (pacing, jargon, plain language)
- [x] Neural local voice (Kokoro-82M) with `say` fallback
- [ ] Optional cloud voice providers behind the `voice.provider` interface

## Milestone 3 — presenter and polish

- [x] Animate the fictional presenter from the narration track (mesh-warp jaw, lip spread and rounding, teeth, nods, brow raises, blinks, gaze)
- [x] Presenter avoids covering the action; branded backdrop, title and closing cards
- [x] H.264/AAC MP4 export (WebCodecs in Chrome, no native renderer needed)
- [ ] Presenter layouts (circle, rounded card, side-by-side) and lower thirds
- [ ] Visual regression tests for zoom framing and overlay safe areas
- [x] Motion blur on fast pans and cursor moves, keystroke sounds, cursor idle-hide
- [x] Adaptive zoom depth, cursor follow, spline camera, cursor shapes (hand, I-beam)
- [x] Mesh-gradient wallpapers and macOS browser window chrome
- [x] 4K export

## Work packages for parallel agents

Each package is bounded and testable on its own. Claim one in an issue before
starting.

1. **Screen capture follow-ups.** The `window` recorder records extension demos
   unattended in real Chrome, with the Form-Filling Assistant running on
   Claude (subscription companion) or Gemini Nano (on-device). Next: the Nava
   API provider (needs a running API and tenant key), live application-site
   demos (need an explicit permission rule for real-world form submissions in
   the agent's harness), typing cues for externally driven screen recordings,
   and following a window that moves.
2. **Script from an activity log.** Convert a form-filler activity export (the
   `nava-form-filling-activity-*.json` files) into a demo script: map each
   agent step to a `do` step and draft `say` lines, keeping values synthetic.
3. **Voice providers.** Kokoro is in. Next: word timings (a forced aligner or a
   TTS that returns durations) to drive exact visemes, and optional cloud voices
   behind `resolveVoiceProvider`. Keep the manifest shape (`durationMs`,
   `envelope`, `mouth`).
4. **Presenter quality.** Add a video presenter track (`presenter.clips` per
   narration line) so a generative lip-sync model can replace the mesh rig when
   one is available. Options: a Weave model through the Figma connection
   (needs the Figma account linked to Weave), a hosted avatar API, or a local
   model; check model and weight licences before shipping. Also presenter
   shapes (rounded card) and a second fictional presenter with its own rig.
5. **Screen Studio import.** Read a `.screenstudio` project's recording and
   cursor data into `rawVideo` + trace so existing recordings can be re-edited.
6. **Framing regression tests.** Golden-frame checks for camera windows,
   subtitle safe areas, and presenter swaps at 720p, 1080p, and 4K.
