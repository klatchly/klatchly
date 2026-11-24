# Security policy

Klatchly holds a very sensitive secret: the Beeper access token, which is the Matrix access token of your Beeper
account. Whoever obtains it can read every chat and send messages as you on every connected network. Security reports
are taken seriously.

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

- Use GitHub's private vulnerability reporting: the **Security** tab of this repository, then **Report a
  vulnerability**. _(To be enabled on the public repository before the first release.)_
- Or e-mail **clad-such-reveal@duck.com**.

Please include the version (`web/package.json`), the package list you build (`web/ext/packages.json` or
`KLATCHLY_PACKAGES`), steps to reproduce, and the impact you expect. You should get a first answer within a reasonable
delay; this is a personal project maintained in spare time, so no fixed response time is promised.

Please never include a real Beeper token, chat content or other personal data in a report.

## Supported versions

_To be defined with the first public release._ Until then, only the latest version on the default branch receives
fixes.

| Version | Supported |
|---|---|
| latest `main` | yes |
| anything older | no |

## Scope

In scope:

- The Klatchly server and web app (`web/server`, `web/client`) and the packages in this repository (`web/ext/*`).
- Authentication: passkeys, enrollment codes, sessions, the optional OpenID Connect sign-in, step-up confirmation,
  and the device API under `/api/bearer/`.
- The relay to beeper-server: anything that lets a client reach Desktop API routes, files or hosts it should not
  (allow-list bypass, SSRF through link previews or media, path traversal).
- The Dockerfiles and `compose.yml` as shipped (hardening that does not hold).

Out of scope:

- beeper-server itself, the Beeper Desktop API and Beeper's services: report those to Beeper.
- The chat networks and the bridges Beeper runs.
- Your reverse proxy, host, or a configuration that departs from the documentation (for example a published
  beeper-server port, or a disabled authentication layer you added yourself).
- Packages that are not part of this repository.
- Issues that require an already compromised server or a malicious package you built in yourself (see below).

## What an extension (package) can do

Packages are compiled into the image at build time; nothing is loaded at run time. But **a package runs inside the
Klatchly server process, with all of its rights**:

- it can read the Beeper token and every chat, send messages, read and write the data volume (`state.json`:
  passkeys, sessions), open network connections and start processes, whatever it declares;
- its client half runs in the page with the user's session and can call the whole API.

The extension API constrains an *honest* package and makes its access visible: a package may only import the core
through its SDK, must declare the environment variables it reads and its capabilities (network, listeners, files,
processes), and the build-time boundary tests fail when code uses something undeclared. Settings → Extensions shows
these declarations. **This is not a sandbox**: malicious code can get around it. Installing a package means trusting
it as much as the core. Pin third-party packages to a commit and read their server code before building them in.
A report that a package can do something it did not declare is welcome as a bug, but it is not a vulnerability of
Klatchly unless the core grants it something it should not.
