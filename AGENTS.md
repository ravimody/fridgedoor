# AGENTS.md

Guidance for anyone (person or AI agent) changing Fridgedoor's code. To *install*
Fridgedoor, read [docs/setup-with-an-ai-agent.md](docs/setup-with-an-ai-agent.md) instead.

Read [VALUES.md](VALUES.md) first: when two good options conflict, the values decide.

## Layout

`server/` (Hono API + worker), `web/` (React web app), `packages/contracts/` (shared zod
API schemas), `ios/` (SwiftUI app, separate MPL-2.0 license), `deploy/` (container and
install scripts), `docs/`. Architecture: [docs/architecture.md](docs/architecture.md).

## Tooling

- Node 22 or 24 with pnpm (`corepack enable`). The SQLite driver doesn't build on newer
  Node releases yet.
- Build contracts first: `pnpm --filter @fridgedoor/contracts build`. Server and web import
  the built package.
- Tests: `pnpm test` (all), `cd server && npx vitest run src/<path>`, `cd web && npx vitest run`.
  Typecheck with `pnpm typecheck`, lint with `pnpm lint`.
- iOS: `cd ios && xcodegen generate`, then build in Xcode; `cd ios/FridgedoorKit && swift test`.
- Local synthetic data for the iPhone app: `pnpm --filter @fridgedoor/server dev:native`.
- UX reviews follow [.claude/skills/ux-review/SKILL.md](.claude/skills/ux-review/SKILL.md);
  their work stays in the gitignored `work/`.

## Rules

- **Privacy first.** Never log or return email content, prompts, model output, tokens or
  keys. Errors are stable codes. Never add analytics or calls to services the household
  didn't configure.
- **Scope every query** by member and household. A plan is private to its owner until shared.
- **Model output is untrusted data.** Validate with zod, check evidence, and never let a
  model choose the actor, credentials or sharing.
- **Provider-neutral AI.** Feature code calls `LlmHub`/`LlmProvider` (`server/src/llm/`), never
  a vendor SDK. Check `capabilities` before relying on images, PDFs, tools, web search or
  transcription, and degrade gracefully.
- **Migrations are append-only.** Add a new numbered file in `server/src/db/migrations/`;
  never edit one that has shipped. Don't change column order of existing tables (tests
  insert positionally).
- **Zero-config by default.** New settings need a sensible default or a web-app control;
  environment variables override. Document them in [docs/configuration.md](docs/configuration.md).
- **Keep docs current** in the same change: README, `docs/`, `.env.example`, and this file.
- **No personal data** in code, fixtures or docs. Use the synthetic household (Alex, Sam,
  Brookside Elementary, `example.test` / `example.org` addresses).

## Style

Match the surrounding code: compact TypeScript, `zod` at boundaries, small services with
injected clocks for tests. Copy for families is short, warm and plain; the product is
"Fridgedoor" and the assistant is "the planner". iOS vocabulary lives in
[ios/DESIGN.md](ios/DESIGN.md).

## Pull requests

One purpose per PR, focused tests for the changed behavior, and a description of what
a self-hoster needs to do on upgrade (new settings, migrations).
