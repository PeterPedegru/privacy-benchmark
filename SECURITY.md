# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately, through GitHub's **Report a vulnerability** button on this repository's Security tab. Don't open a public issue, and don't include exploit details anywhere public.

Include what you found, how to reproduce it, and what an attacker could do with it. We'll acknowledge the report, keep you updated while we fix it, and credit you when the fix is released, unless you'd rather stay anonymous.

## In scope

- The public site and its API (`/api/public/*`), including the correction form and share cards.
- The admin dashboard and API (`/admin`, `/api/admin/*`): authentication, sessions, CSRF, authorization.
- The evaluation pipeline. Agents read untrusted web pages, documents, code and posts, so prompt injection that gets an agent to act on instructions, reach repositories or hosts it shouldn't, leak data, or record false evidence counts.
- Anything that could alter a published result without an editor's decision.

## Out of scope

- Disagreements with a project's score. Use the **Suggest a correction** form on the project's page; every decision is published in the corrections log.
- Denial of service through volume, and findings in third-party services the project depends on (report those to the service).
- Missing security headers or best-practice suggestions with no demonstrated impact.

## Handling secrets

No secrets live in this repository. Configuration comes from environment variables (see `apps/server/.env.example`). If you find a credential in the code or its history, report it as above.
