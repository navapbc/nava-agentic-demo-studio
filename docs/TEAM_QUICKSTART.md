# Make a presentation and product demo locally

The recorder, editor, music generator and MP4 exporter are MIT licensed and run
locally. No Screen Studio purchase, paid video service or AI subscription is
required. Kokoro narration runs locally after its first model download; `say`
is the macOS fallback. Product agents used in an extension demo are separate
from the video tools and may require an account or subscription.

## First presentation

After cloning and installing as shown below, run:

```sh
npm run presentation
node bin/presentation-studio.mjs serve exports/presentation
```

Open <http://127.0.0.1:4311/index.html>. The output folder includes an editable
PowerPoint with its demo embedded, a browser presentation, a PDF with video
posters and `presentation.zip` for sharing. The example records a fictional
portal using synthetic data. Review every slide and play the embedded clip
before sharing. You can also reuse an existing MP4 without recording again.

Install the combined storycraft and demo workflow in Codex:

```sh
codex plugin marketplace add navapbc/nava-agentic-demo-studio --ref v0.4.0
codex plugin add nava-presentation-studio@nava-presentation-studio
```

Then ask your agent:

> Use $nava-presentation-studio to turn this brief into a presentation. Read the
> repository's AGENTS.md. Shape the story, record or reuse the product moments,
> build editable slides with the demos included, and inspect the complete output.
> Use synthetic data for recordings and include the scope of any evidence claims.

The plugin is guidance; the cloned repo supplies the local build runtime. See
[the presentation system guide](PRESENTATION_SYSTEM.md) for custom manifests.

## First video

Install Node 20+ and Google Chrome. Clone either repository you have access to:

```sh
git clone https://github.com/navapbc/nava-agentic-demo-studio.git
cd nava-agentic-demo-studio
npm ci
npm run doctor
npm run make
node bin/demo-studio.mjs inspect exports/benefits-portal.mp4
```

The example uses a bundled fictional portal and synthetic applicant data. The
export is `exports/benefits-portal.mp4`. Look at the generated contact sheet and
play the MP4 before sharing it. On machines without a speech engine, set
`"voice": { "provider": "none" }` in your script to use captions.

## Give your agent this prompt

> Read AGENTS.md and README.md. Build a short product demo using synthetic data.
> Write a script under examples/, record it, plan it and export an MP4. Use a
> purple voice orb, generated music and captions. Keep zooms easy to follow.
> Inspect the encoded video, then remove the silent planning and finished-work
> waits with speed.cuts. Preserve narration and active work. If showing parallel
> tasks, capture them on one clock and use one shared edit map. Inspect both sides
> of every cut, the first shot and the closing frames before delivering the MP4.

## Choose a recorder

| Recorder | Use it for | Requirements |
| --- | --- | --- |
| `page` | Web apps and the bundled example | Chrome; runs headless |
| `window` | Chrome with an extension side panel | Chrome; works unattended |
| `screen` | Native apps or actual system chrome | macOS 13+, Xcode Command Line Tools, Screen Recording permission and an unlocked display |

Copy [the example script](../examples/benefits-portal.script.json), set your
product URL and selectors, and use `node bin/demo-studio.mjs make SCRIPT.json`.
Use `"presenter": { "kind": "orb", "color": "#8b5cf6" }` for a voice orb.
The orb is drawn in front of the scene and title cards.

Recordings, models, credentials and exports stay out of Git. Use synthetic data
even when recording official sites. Keep final submission and CAPTCHA completion
with a human. The studio never uploads recordings, but any remote website you
interact with may receive the entered data.

See [editing guidance](EDITING.md) for a repeatable way to tighten an existing
recording without another live run.
