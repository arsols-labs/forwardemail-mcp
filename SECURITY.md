# Security Policy

## Reporting a Vulnerability

Please report security issues privately through GitHub Security Advisories for this repository. If private reporting is not available, contact the maintainers through the repository owner before opening a public issue.

Include:

- affected version or commit
- reproduction steps
- expected impact
- any suggested mitigation

Do not include live credentials, tokens, or private customer data in reports.

## Security Assumptions

- Secrets are provided at runtime through environment variables or the deployment platform secret store, never committed to git.
- `/mcp` is protected by a bearer token when exposed over HTTP.
- `/health` may be public and must not reveal secrets.
- Logs must not include `Authorization` headers, cookies, passwords, tokens, or secret values.
- Forward Email credentials are scoped only to the mailbox and DAV resources they need.
- Remote deployments should use TLS and, when possible, an additional perimeter control such as Cloudflare Access or an IP allowlist.
