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
