# Make a presentation and product demo locally

The recorder, editor, music generator and MP4 exporter run locally. No Screen
Studio purchase, paid video service or model API is required. This is an
experimental authoring tool, primarily tested on macOS with Chrome. Product
agents used in a demo are separate and may require an account or subscription.

## Install

Install Node 20.9+ and Google Chrome, then clone the Nava repository:

```sh
git clone https://github.com/navapbc/nava-agentic-demo-studio.git
cd nava-agentic-demo-studio
npm ci
npm run doctor
```

The bundled example explicitly requests Kokoro narration. Its first narrated
build downloads a speech model and needs network access. For a captions-only
or offline build, set `"voice": { "provider": "none" }` in
`examples/benefits-portal.script.json` first. On macOS, `"provider": "say"` uses
the installed system voice. `doctor` checks Chrome and codecs, not the Kokoro
model. See [known limits](../README.md#known-limits) if setup fails.

## First presentation

From the installed checkout, run:

```sh
npm run presentation
node bin/presentation-studio.mjs serve exports/presentation
```

Paste `http://127.0.0.1:4311/index.html` into Chrome's address bar. The local
server blocks cross-site navigation, so clicking a localhost link on GitHub can
be blocked. The output folder includes an editable PowerPoint with its demo
embedded, a browser presentation, a PDF with video
posters and `presentation.zip` for sharing. The example records a fictional
portal using synthetic data. Review every slide and play the embedded clip
before sharing. You can also reuse an existing MP4 without recording again.

Install the combined storycraft and demo workflow in Codex:

```sh
codex plugin marketplace add navapbc/nava-agentic-demo-studio --ref v0.4.1
codex plugin add nava-presentation-studio@nava-presentation-studio
```

Then ask your agent:

> Use $nava-presentation-studio to turn this brief into a presentation. Read the
> repository's AGENTS.md. Shape the story, record or reuse the product moments,
> build editable slides with the demos included, and inspect the complete output.
> Use synthetic data for recordings and include the scope of any evidence claims.

The plugin is optional guidance; the cloned repo supplies the local build
runtime. These commands need a Codex CLI with plugin support. See
[the presentation system guide](PRESENTATION_SYSTEM.md) for custom manifests.

## First video

From the same checkout, run:

```sh
npm run make
node bin/demo-studio.mjs inspect exports/benefits-portal.mp4
```

The example uses a bundled fictional portal and synthetic applicant data. The
purple voice orb responds to the narration; no face image is used. The export
is `exports/benefits-portal.mp4`. Look at the generated contact sheet and
play the MP4 before sharing it. Build time varies with the machine, model
download/cache and output settings.

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
The orb is drawn in front of the scene and title cards. Use `"presenter": false`
for voiceover and captions without an avatar overlay. Shared demos use one of
these faceless options.

In the preview, use **Show voice orb** to turn the orb on or off. Voiceover,
music and captions continue; **Export MP4** uses the setting shown. This choice
lasts for the current preview session. Keep it in the script for future builds,
or pass `--orb on` / `--orb off` to the command:

```sh
node bin/demo-studio.mjs make examples/benefits-portal.script.json --orb off
node bin/demo-studio.mjs render recordings/benefits-portal/project.json exports/benefits-portal-voice-only.mp4 --orb off
```

Keep recordings, models, credentials and exports out of Git. Use synthetic data
even when recording official sites. Keep final submission and CAPTCHA completion
with a human. Studio has no recording-upload service, but any remote website or
extension may receive entered data. Environment-sourced text stays out of the
script and trace; it may still be visible on screen. Inspect the resulting media.

Run only trusted scripts and projects. The preview is a local development
server, not a hosted multi-user service. See [security guidance](../SECURITY.md)
and [contribution checks](../CONTRIBUTING.md).

See [editing guidance](EDITING.md) for a repeatable way to tighten an existing
recording without another live run.
