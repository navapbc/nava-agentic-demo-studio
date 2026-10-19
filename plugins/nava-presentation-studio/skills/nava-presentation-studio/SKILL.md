---
name: nava-presentation-studio
description: Create a complete product presentation that combines a slide narrative with recorded product demos, or assemble existing demo clips into a new deck and browser presentation. Use for presentations with product walkthroughs and end-to-end slide-and-video production.
---

# Nava Presentation Studio

Connect the story to a visible product demonstration, then deliver the slides
and video together. The local runtime creates an editable PowerPoint with
embedded MP4s, a browser presentation, PDF with video posters, slide previews
and a portable ZIP. It does not upload the results.

## Story and composition

Define the audience, purpose and intended decision using the supplied material.
Read [story architecture](references/story-architecture.md) and
[Nava presentation standards](references/nava-presentation-standards.md) when
building or substantially rewriting the story. Read
[visual composition](references/visual-composition.md) for layout choices and
[review gates](references/review-gates.md) before delivery.

Use the product demo at the point where it proves the claim. Preserve source
boundaries: a synthetic prototype run does not establish production readiness.
Put supporting detail, citations and necessary caveats in speaker notes; show
caveats on the slide when the audience needs them to interpret the result.

For a supplied native template or existing deck, use the applicable presentation
authoring tools to preserve that design and its native content. The standalone
generator creates a new deck from a manifest; it does not import or restyle
existing PowerPoint or Google Slides files. Do not replace an explicit template
with its starter theme. The browser and PDF can accompany a separately authored
native deck when that is what the user needs.

## Recording and assembly

Read [the build reference](references/presentation-build.md) for the manifest
schema and commands. Locate a checkout of the Studio repo or clone
`navapbc/nava-agentic-demo-studio`, then install its Node dependencies. The
plugin supplies guidance; the repo supplies the executable runtime.

Reuse a valid existing MP4 when it already shows the required moment. Otherwise
author a demo script using the studio's `script -> voice -> record -> trace ->
plan -> preview -> render` pipeline. Use synthetic data for tests and shipped
examples. For actual work, follow the user's approved data and site boundaries.
Read the runtime's AGENTS.md before recording.

For shared demos, set `"presenter": { "kind": "orb", "color": "#8b5cf6" }`
for a purple voice orb, or `"presenter": false` for voiceover with no avatar
overlay. Do not use portrait presenters in shared demos, screenshots or posters.
Review reused MP4s and their posters for the same requirement.

Keep the orb above scene/title overlays. Trim silent planning and completed-work
waits with `speed.cuts`; preserve speech and actual product activity. For parallel
tasks, every captured tab must share one clock and one edit map. Do not independently
retime tabs or redraw form pixels to imply concurrency. A full real-time work
interval can be protected with a `pause` trace event before planning.

Write the narrative plan, run `scripts/audit_slide_plan.mjs` against it, and resolve
errors. The presentation manifest can reference that plan; assembly checks that
its slide titles and count match. See the build reference for layout choices,
video sources and output files.

## Review and deliver

Build the package, inspect all rendered slide previews and play each demo in
the browser presentation. Check title/body fit, layout rhythm, video placement,
speaker notes and the ending. Native text and tables remain editable in the
PowerPoint; video bytes are embedded rather than linked to the author's computer.

Check the first and final video frames and both sides of any cuts. Keep known
human-review boundaries visible when material to the claim. The generated fit
check catches bounds errors, but it cannot judge narrative quality or claim accuracy.

Deliver the requested formats. A PDF shows posters rather than playable video;
PowerPoint media playback depends on the presentation app. The browser package
is the tested playback path. Keep its media directory beside `index.html`, or
share the ZIP. State a compatibility limitation when it affects the user's use.
