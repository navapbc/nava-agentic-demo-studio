# Build a presentation with demos

Requires Node 20+ and Chrome. No paid video service or model API is required.
The authoring agent is optional: an authored JSON manifest can be built directly.
Local Kokoro narration is optional; macOS `say` or captions can be used instead.

```sh
npm ci
npm run presentation
node bin/presentation-studio.mjs serve exports/presentation
```

For a custom project:

```sh
node bin/presentation-studio.mjs build path/to/presentation.json --out exports/my-presentation
```

## Manifest

```json
{
  "schema": "nava.presentation.v1",
  "title": "A product presentation",
  "audience": "Product team",
  "purpose": "Show the change and the evidence supporting it",
  "storyPlan": "story-plan.json",
  "demos": [{ "id": "workflow", "file": "workflow.mp4", "posterAtSeconds": 12 }],
  "slides": [
    { "id": "context", "layout": "statement", "title": "The workflow", "body": ["One concrete point about the workflow"], "notes": "Supporting context" },
    { "id": "demonstration", "layout": "demo", "title": "The product in use", "demo": "workflow", "caption": "Prototype with fictional data" }
  ]
}
```

`storyPlan` is optional for a manually authored manifest. When supplied, the
storycraft auditor runs and the plan's titles/count must match the final slides.
Use the story-architecture reference for its schema.

Each demo needs exactly one of `file` (existing local MP4) or `script` (a local
demo-script JSON to record and render). Optional `poster` uses an existing PNG
or JPEG; otherwise Chrome extracts one at `posterAtSeconds`, defaulting to two
seconds. Input paths are relative to the manifest, and absolute local paths also
work. Every demo must be used by a slide. The portable manifest only includes
packaged media paths; scripts, environment values and original local paths are
not copied into the sharing package.

Every slide needs a unique lowercase `id`, a `title` and a `layout`:

| Layout | Additional fields | Use |
| --- | --- | --- |
| `cover` | `body`, optional `eyebrow` | Sparse title and occasion |
| `statement` | `body` | One dominant point |
| `bullets` | `body` | A short list when the items are parallel |
| `split` | `body`, `image`, optional `imageAlt` | Documentary image and explanation |
| `demo` | `demo`, optional `caption` | Playable product recording |
| `table` | `columns`, `rows` | Editable comparison or evidence table |
| `closing` | `body`, optional `eyebrow` | Earned implication or next decision |

Optional `notes`, `sources` and `scope` go into native speaker notes. Numeric
evidence such as entries, writes, percentages and timings requires sources and
scope. Use `caption` for caveats that need to be visible. Keep copy short: the
fit check rejects overflow rather than silently shrinking the text.

`theme` optionally supplies `font` and six-digit hex values (without `#`) for
`background`, `foreground`, `accent`, `paper` and `ink`. The starter theme is a
Studio theme, not a substitute for an authoritative Nava template.

## Outputs

`presentation.pptx` has editable text/tables and embedded MP4s. `index.html`
presents the same composition with local video playback. `presentation.pdf`
contains the slides and video posters. `media/` contains copied clips/posters;
`slides/` contains rendered previews. `presentation.zip` contains the complete
package. The build report records clip hashes, successful frame decoding and
slide fit checks; it is a validation artifact, not slide content.

Open `index.html` in Chrome after unzipping, or use the local `serve` command.
Arrow keys and Previous/Next move through slides. Video playback is user-initiated
and pauses when leaving a slide. PowerPoint playback depends on the presentation
app; the browser is the portable playback path. PDF is a reading version.

The runtime uses [PptxGenJS media support](https://gitbrent.github.io/PptxGenJS/docs/api-media/)
for native video embedding. It never uploads a presentation. It does not produce
a single movie of the entire deck or synchronize spoken narration across slides.
