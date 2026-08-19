# Security

## Reporting a vulnerability

Please report security issues privately to the maintainer of this repository
rather than opening a public issue.

Useful details to include:

- what kind of issue it is (for example: injection, privilege escalation,
  credential exposure, SSRF)
- the file paths and code involved
- how to reproduce it, including any configuration required
- what an attacker could achieve with it

## Scope notes for this deployment

This application is designed to run locally or behind your own
authentication. A few areas are worth knowing about before exposing it more
widely:

- **User-supplied LLM endpoints.** The server makes outbound requests to the
  API base URL you configure. Set `DF_ALLOWED_API_BASES` to an allowlist, or
  pass `--disable-custom-models`, on any shared instance.
- **Anonymous multi-user mode.** Browser identities are client-supplied and
  therefore spoofable. Disable data connectors (`--disable-data-connectors`)
  or require SSO before hosting for more than one person. See the deployment
  profiles in `DEVELOPMENT.md`.
- **AI-generated code.** Generated Python runs in a sandbox that blocks
  network access, file writes, and dangerous imports. Report any escape.
- **Data flow.** See `PRIVACY.md` for what leaves the machine and what does
  not.
