# Contributing

Nava Presentation Studio is an experimental local authoring tool. Keep changes
focused, preserve existing scripts and schemas, and describe the behavior and
validation in the pull request. Read [AGENTS.md](AGENTS.md) for the trace privacy,
timing and media contracts.

## Setup and checks

Use Node 20.9+ and Google Chrome. From the repository root:

```sh
npm ci
npm run check
npm test
npm run doctor
npm run e2e
```

The syntax and unit checks need no browser. Browser checks need installed
Chrome with the required codecs. Native screen capture additionally needs
macOS 13+, Xcode Command Line Tools and Screen Recording permission. See
[the quick start](docs/TEAM_QUICKSTART.md) for the narrated example and
captions-only setup.

## Media and data

- Use synthetic records and public or locally bundled fixtures. Keep final
  submission and CAPTCHA completion with a person.
- Keep recordings, exports, credentials, downloaded models and personal paths
  out of commits. Labels and narration are authored text; do not put secrets in
  them. An environment variable does not hide a value in captured pixels.
- Inspect encoded output before sharing. For timing changes, review both sides
  of cuts, the first and final frames, narration and captions. Concurrent tabs
  must share one clock and edit map.
- Use the voice orb or voice-only style for shared media. Keep portrait
  experiments and face assets out of the repository.
- Include attribution and the applicable license when adding third-party
  material. The source revision for copied presentation guidance is recorded in
  [SOURCE_PROVENANCE.json](SOURCE_PROVENANCE.json).

Report reproducible bugs with the command, Node/Chrome/OS versions and a small
synthetic example. Do not attach sensitive recordings or credentials. Follow
[SECURITY.md](SECURITY.md) for vulnerability reports.
