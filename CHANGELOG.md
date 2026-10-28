# Releases

## 0.4.1 — Local server protections and setup

- Restrict local preview/export requests by host and browser origin; block
  hidden files and static symlinks that resolve outside the served root.
- Reject cross-site navigation and framing. Keep project JSON requests on the
  same origin and reject redirects.
- Enforce the export size limit while streaming, write through unique private
  temporary files and clean up failed or aborted exports.
- Pass macOS speech text through standard input to prevent narration from
  being interpreted as command options.
- Validate recording paths before replacing frames and close preview servers
  when browser launch fails.
- Retain the source frames needed by each motion-blur sample, avoiding blank
  frames during accelerated playback and across cuts.
- Update vulnerable transitive image dependencies, require Node 20.9+ and add
  a dependency-audit check to CI.
- Clarify Nava setup, optional speech/model downloads, integration examples,
  local trust boundaries and what can remain visible in recordings.
- Add contribution and private vulnerability-reporting guidance, retain
  synthetic fixtures and document screenshot/source credits.

## 0.4.0 — Nava Presentation Studio

- Combine Nava storycraft and the product demo workflow in one installable plugin.
- Build editable PowerPoint slides with embedded demos from a presentation manifest.
- Record new demos or reuse existing MP4s without changing their timing.
- Export a local browser presentation, PDF, slide previews and portable ZIP.
- Run story-plan, evidence, fit and video decoding checks during assembly.
- Keep the existing video CLI, parallel capture and source-time editing workflows.

## 0.3.0 — Tighten recordings without another live run

- Remove source-time dead spans with `speed.cuts` while protecting narration and actions.
- Apply one edit map to camera, captions, presenter and concurrent tab captures.
- Add team setup and editing guides.
