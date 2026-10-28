# Remove waits while preserving the product demonstration

Fast-forwarding a long wait can still leave several seconds of an unchanged
screen. Use an explicit cut when no relevant action or narration is happening.
Edit the captured source; another live application run is unnecessary.

## Source-time cuts

Add ordered ranges to the script's `speed` settings. Numbers are milliseconds
from the original recording, before the intro and any speed changes:

```json
{
  "speed": {
    "cuts": [
      { "startMs": 3000, "endMs": 8000 },
      { "startMs": 11000, "endMs": 17000 }
    ]
  },
  "introMs": 1600,
  "outroMs": 1600
}
```

These sample ranges suit the bundled [editing trace](../examples/idle-cuts.trace.json),
not arbitrary new recordings. Choose your ranges after inspecting your footage
and `trace.json`. The planner rejects unordered, overlapping or out-of-bounds
ranges and cuts that intersect narration, clicks, typing, movement, scrolling
or deliberate pauses. Waits, focus holds and milestones can be cut.

```sh
node bin/demo-studio.mjs plan examples/idle-cuts.trace.json /tmp/idle-cuts.project.json --script examples/idle-cuts.script.json
```

For your recording, pass its trace and voice manifest with the updated script:

```sh
node bin/demo-studio.mjs plan recordings/my-demo/trace.json recordings/my-demo/project.json --voice recordings/my-demo/voice/manifest.json --script examples/my-demo.script.json
node bin/demo-studio.mjs render recordings/my-demo/project.json exports/my-demo-tight.mp4
node bin/demo-studio.mjs inspect exports/my-demo-tight.mp4 --at 19.2,19.4,34.7,35
```

Use your own output seconds in `--at`; examine frames immediately before and
after each edit. The source screenshots jump at the cut while voice, captions,
music, camera and presenter follow the shorter output timeline.

## Parallel activity needs a shared clock

Use the `window` recorder, set `captureParallel: true`, configure
`parallelTargets` for the tabs you want captured, and author
`parallel-start` / `parallel-end` milestones. Every tab is timestamped from the
same capture start; the compositor selects only frames at or before that shared
source time. Never offset or independently retime tabs to imply concurrency.

Each target supplies a `name`, `origin`, `path` prefix, and `verifySelector`.
Optional `viewSelector` / `viewOffset` stage the real tab viewport;
`reviewViews` pairs a `milestone` with a `selector` and optional `offset` for
the final review. `minimumVerified`, `expectedChecks` (control IDs to booleans),
and `requireAllNativeRequired` check the real final controls. Control metadata
is stored in `verification.json`; entered values are never copied there.
Live benefits demos additionally collect the Nava extension's queue audit;
that integration requires the Nava Form-Filling Assistant extension.

An external agent may fill fields during one long `wait` event. The recorder
cannot infer that work from the pointer trace. Add a `pause` interval to the
trace spanning the measured active work, then cut only before and after it. The
pause preserves work at 1×, and the cut validator prevents deleting it. Keep
the untouched source and an unedited proof clip if concurrency is a product claim.

For the WIC/IHSS demo, the tightened edit preserves the entire measured write
window at 1×. Silence from the last planning narration to the first write is
0.9 seconds, and the completed-answer review begins 0.55 seconds after the last
verified write. Both site captures use the same cuts. The edit removes planning,
post-fill rescan waits and excess ending hold; it never redraws form pixels.

Before sharing, verify the chosen orb or voice-only layout stays clear,
required choices are visibly selected, the closing review stays framed steadily,
narration isn't clipped, and the video contains no silent holds beyond what the
viewer needs.
