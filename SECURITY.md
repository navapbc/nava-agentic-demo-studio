# Security

Studio is an experimental local authoring tool for trusted scripts and
projects. It is not a sandbox for untrusted files or a hosted multi-user
service. Browser automation can visit websites, enter data and interact with
extensions using the permissions of the local user. Review inputs before
running them and use synthetic demo data.

## Local use

- Keep preview and rendering servers on loopback. Do not expose them through a
  public tunnel or reverse proxy. Stop them when finished.
- Treat screenshots, frames, audio, traces and exported presentations as
  potentially sensitive. The trace schema restricts fields; it does not redact
  secrets placed in labels, narration, URLs or captured pixels.
- Environment-sourced text avoids embedding a value in the script. It can
  still be displayed by the target page. Do not record real passwords, tokens
  or client records.
- Studio has no recording-upload service. Package installation and optional
  model downloads use the network. Websites, extensions and authoring agents
  have their own network behavior and account requirements.
- Local server protections do not isolate Studio from other programs running
  as the same operating-system user. Use the tool in an appropriate local
  environment and review output before sharing it.

## Reporting a vulnerability

Use [GitHub's private vulnerability report for this repository](https://github.com/navapbc/nava-agentic-demo-studio/security/advisories/new)
when it is available. Include the affected revision, reproduction steps and a
minimal synthetic example. Do not put credentials, personal data or sensitive
recordings in a public issue.

If private reporting is unavailable, ask the maintainers for a private reporting
channel without disclosing exploit details or sensitive data publicly. This
project does not currently promise a security response time or long-term
support for older versions.
