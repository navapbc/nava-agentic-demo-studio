# Present the story and the product together

Nava Presentation Studio v0.4 combines the Nava presentation toolkit's story
architecture and review gates with the existing demo recorder and editor. One
manifest describes the deck and its product recordings. The local builder
records requested demos, generates editable slides, embeds the media and creates
a package ready to present.

For shared demo clips, use the purple voice orb with
`"presenter": { "kind": "orb", "color": "#8b5cf6" }`, or use
`"presenter": false` for voiceover without an avatar overlay. Review reused
MP4s and their posters against the same faceless presentation standard.

Start with `npm ci`, `npm run doctor`, then `npm run presentation`. For a custom
project, copy [the starter manifest](../examples/presentation-system.presentation.json).
The [manifest and build reference](../plugins/nava-presentation-studio/skills/nava-presentation-studio/references/presentation-build.md)
documents layouts, inputs, evidence notes and commands.

| Output | Purpose |
| --- | --- |
| `presentation.pptx` | Native editable text and tables, with MP4s embedded |
| `index.html` and `media/` | Local browser presentation with playable demos |
| `presentation.pdf` | Reading copy with video posters |
| `slides/` | Rendered previews for review |
| `presentation.json` | Portable description using packaged media paths |
| `build-report.json` | Clip hashes, decoded dimensions and measured slide objects |
| `presentation.zip` | All of the above in a sharing package |

Browser video playback starts on click and pauses when leaving its slide. Arrow
keys and Previous/Next navigate. Unzip the package before opening `index.html`
in Chrome, or run `node bin/presentation-studio.mjs serve OUTPUT_DIRECTORY`.
PowerPoint media support varies by presentation app; verify playback in the app
used for the event. The browser provides the tested local playback path.

Existing MP4s are copied byte for byte, including into the PowerPoint and ZIP.
Assembly does not change their timing or manufacture simultaneous activity.
Create edits in Demo Studio first; use one edit map for all concurrently captured
tabs. Original recording scripts and their environment values are excluded from
the sharing package. Slide copy, notes and sources are authored content: check
them and the visible recording for sensitive information before sharing.

Use an optional `storyPlan` to run the packaged storycraft auditor. Its slide
titles and count must match the manifest. The builder rejects overflowing slide
content and numeric evidence without sources and scope. It checks that every
clip decodes, measures the browser composition, then uses those positions for
native PowerPoint objects.

The combined plugin is available from either Studio repository; installation
commands are in [README](../README.md). Nava storycraft references and the auditor
are copied from `navapbc/nava-presentation-toolkit` at the commit recorded in
[SOURCE_PROVENANCE.json](../SOURCE_PROVENANCE.json). The standalone toolkit
remains usable.

This release creates new decks from a manifest. It does not import an existing
PowerPoint or Google Slides template, synchronize narration across slides, or
export a movie of the whole deck. Use the authoritative presentation tool for an
existing template and bring Studio's finished MP4s into that deck. The built-in
theme is a Studio starter, rather than an official Nava brand template.
