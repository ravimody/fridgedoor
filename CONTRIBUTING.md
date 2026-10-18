# Contributing

Fridgedoor is built for families, so every change should keep it calm, private and easy
to run at home.

1. For anything bigger than a small fix, open an issue first to agree on the approach.
2. Read [AGENTS.md](AGENTS.md) for the layout, commands and rules (privacy, scoping,
   provider-neutral AI, append-only migrations).
3. Keep each pull request to one purpose with focused tests. Run `pnpm typecheck`,
   `pnpm lint` and `pnpm test` (and `swift test` in `ios/FridgedoorKit` for iOS changes).
4. Update docs in the same pull request, including `.env.example` for new settings.

By contributing, you agree that your contribution is licensed under the license of the
part of the project it touches: AGPL-3.0 for everything outside `ios/`, MPL-2.0 for `ios/`.
