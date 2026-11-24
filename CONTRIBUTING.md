# Contributing

**The contribution policy has not been decided yet.** Whether this repository accepts pull requests and issues, or is
published as "source available, no support", will be settled shortly after the first release. The code is licensed
under Apache-2.0 (LICENSE). Until the policy is settled, please do not send pull requests.

What is already welcome:

- **Security reports**, privately, as described in [SECURITY.md](SECURITY.md).
- **Your own packages**: the extension API is meant for code that lives outside this repository
  ([docs/extensions.md](docs/extensions.md)). A package does not need to be merged here to be used.

If contributions open later, the basics will be:

- From `web/`: `npm run typecheck && npm test && npm run build` must pass (Node 24); the tests reach no real service.
- No personal data in code, tests or comments: only synthetic identities (`web/test/fixtures/identities.ts`).
- Every user-facing string in the English and French catalogs.
- Changes to the extension API follow its versioning rules (a minor version for an addition, a major one for a
  removal), checked by `web/test/contract.test.ts`.

## Commit messages and pull requests

Commit messages and pull request titles follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/),
always in English:

```
<type>(<optional scope>): <description>

<optional body: what and why, wrapped at 72 columns>

<optional footers, e.g. BREAKING CHANGE: …>
```

- **Types**: `feat` (a user-visible feature), `fix` (a bug fix), `docs`, `refactor`, `perf`, `test`, `build`
  (dependencies, Dockerfiles), `ci`, `style`, `chore` (anything else, including releases), `revert`.
- **Scope**: the area touched, usually a package id or a core part: `beeper`, `agents`, `llm`, `writing`,
  `transcribe`, `accounts`, `server`, `client`, `auth`, `docker`, `deps`.
- **Description**: imperative mood, lower case, no final period, 72 characters at most
  (`feat(beeper): join a Matrix room`, not `Added Matrix joining.`).
- **Breaking changes**: `!` after the type or scope, and a `BREAKING CHANGE:` footer saying how to migrate
  (for example a renamed environment variable or an extension API major version).
- **Releases**: `chore(release): 0.26.3`, with the user-visible changes in the body.

A pull request uses the same format for its title and fills in `.github/pull_request_template.md`. A local hook
checks commit messages: `git config core.hooksPath .githooks`.

