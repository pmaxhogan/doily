# Contributing

doily is a single-owner project, but changes are welcome. Read
`.claude/doily-spec.md` first; it records the decisions that shape the tool
surface, the fallback chain and the auth model.

## Setup

```sh
npm ci
cp .dev.vars.example .dev.vars   # only needed for npm run dev
```

Node 26 or newer is required (`.node-version`).

## Definition of done

`npm run check` is the only definition of done. It runs, in order: ESLint,
typecheck (source and tests), Prettier check, the ASCII check, the full test
suite, and a dry-run `wrangler deploy` build. CI runs the same checks with
coverage. Run it before every push.

## Tests

Three vitest projects, selected with `--project`:

- **unit** (`test/unit`, `npm run test:unit`): runs in Node. Every provider
  parser and the merge, dedup, paging and markdown logic are tested against
  committed fixtures. `fetch` is always injected through a deps object, never
  taken from the global, so unit tests never touch the network.
- **integration** (`test/integration`, `npm run test:integration`): runs inside
  workerd through `@cloudflare/vitest-plugin`, reading `wrangler.jsonc` with dummy
  secrets. It exercises `POST /mcp` end to end with stubbed upstreams, the auth
  paths (valid bearer, wrong bearer, no credential), `/healthz` and resource reads.
- **live** (`test/live`, `npm run test:live`): hits real upstream APIs and
  Sci-Hub mirrors. It only runs when `LIVE=1` and is never part of `npm run check`
  or CI. Run it locally when you change a provider.

## Fixtures

Fixtures in `test/fixtures` are recorded real responses, trimmed to the fields the
code reads and ASCII-escaped (non-ASCII characters become `\uXXXX` escapes in
JSON, or are stripped from HTML). Record from the real service, then trim; do not
invent responses, except for the explicitly named `synthetic-*` files that model
states a live service will not reliably produce. Never commit credentials, session
cookies or personal data in a fixture.

## Conventions

- **ASCII only** in every file: no em dashes, smart quotes or arrows.
  `npm run check:ascii` enforces it. LF line endings.
- **Conventional Commits** (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, with an
  optional scope such as `feat(scihub):`).
- **ESM with `.ts` relative imports** (`import { x } from "./x.ts"`).
- **Pinned versions** for `@modelcontextprotocol/server`, `agents` and
  `@cloudflare/workers-oauth-provider`: exact, no caret. Bump them deliberately
  and run the integration suite.
- **No `eslint-disable` without a reason** written on the same line or the line
  above.
- Prettier formats everything (`npm run format`). Two-space indent, double quotes,
  semicolons.
- Keep tool handlers pure over their `deps` (env, fetch, clock) so they are testable
  without workerd.
- Secrets never go in the repository, in logs or in error bodies.
