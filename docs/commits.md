# Commit messages and pull requests

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
