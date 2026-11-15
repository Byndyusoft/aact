# AGENTS.md

aact is a CLI and library that lints C4 architecture-as-code (PlantUML,
Structurizr DSL/JSON), reports violations of microservice patterns,
applies range-based auto-fixes, and emits Kubernetes manifests from the
model.

See `README.md` for what aact does for users. This file is how to _work
on_ aact and how AI coding agents should drive it.

## For AI agents using aact

aact ships an **agent skill** (`aact-architect`) with the C4 pattern
catalogue, ADR templates, and CLI wrappers. Install it once — your agent
then knows when and how to invoke aact without you re-explaining:

```bash
npx aact skill install --claude     # → ~/.claude/skills/aact-architect
npx aact skill install --cline      # → ~/.cline/skills/aact-architect
npx aact skill install --codex      # → ~/.agents/skills/aact-architect
npx aact skill install --cursor     # ditto (shared agent skills path)
npx aact skill install --copilot    # ditto (shared agent skills path)
npx aact skill install --all        # claude + cline + shared
npx aact skill install --dry-run    # show paths, write nothing
npx aact skill install --force      # overwrite unmanaged directory
```

Re-running `npx aact skill install` updates an existing managed install
in place. A `.aact-skill.json` marker file tracks managed state — never
delete it by hand. Override the source with `--repo` and `--ref`.

To scaffold a project that aact can lint:

```bash
npx aact init      # writes aact.config.ts + starter architecture.puml
npx aact check     # surfaces a deliberate CRUD violation in the starter
npx aact check --fix
```

`aact init` uses an `import type` config, so it works without
`npm install aact` first.

## Machine-readable output

Every command supports `--json` and emits a **stable JSON envelope**
(`CliEnvelope`, `schemaVersion: 1`). Use it instead of parsing text:

```bash
npx aact check --json     # CheckData: violations[], suggestedFixes[], rules[], summary
npx aact model --json     # ModelData: normalized C4 graph + loader issues
npx aact analyze --json   # AnalysisReport: cohesion / coupling / sync vs async
npx aact rule list --json # RuleListData: enabled / hasFix / description per rule
npx aact generate --json --format kubernetes --output ./k8s/
npx aact check --sarif    # SARIF v2.1.0 for GitHub Code Scanning
npx aact model --sarif    # SARIF: loader-level issues only
```

`aact model` is the primary inspection surface for agents — it
returns the same normalized Model the rule engine sees, so any
reasoning agents do about elements, boundaries, or relations stays
consistent with what `aact check` would flag. Prefer it over
re-parsing `.puml` / `.dsl` source by hand.

The rule / command / format reference under `docs/reference/` is
**generated** from the registries by `pnpm docs:gen` (CI guards drift
with `pnpm docs:check`) — read it instead of grepping `src/rules/`.

Exit codes are part of the contract: **`0`** clean, **`1`** violations
found, **`2`** tool error (config invalid, source missing, parse failed).
Agents must branch on these — do not collapse them. The envelope shape
is defined in `src/cli/output/types.ts`; additions are additive,
removals or renames require a `schemaVersion` bump.

**`schemaVersion` freeze policy.** `schemaVersion` is the **stable**
contract version, locked at `1` since the `v3.0.0` GA. Changes under it
are additive only; a removal or rename bumps `schemaVersion` per the rule
above. (The `3.0.0-beta.X` line reshaped fields under `1` without a bump —
those changes are in `CHANGELOG.md`.)

## Source-location hyperlinks

`aact check` text mode emits each violation with a Cmd-clickable
`<file>:<line>:<col>` anchor. The terminal hyperlink scheme is
host-aware:

| Terminal                                | Click target                          |
| --------------------------------------- | ------------------------------------- |
| VSCode / Cursor integrated terminal     | jumps to line:col in editor           |
| Zed integrated terminal                 | jumps to line:col in editor           |
| Ghostty / iTerm2 / WezTerm / Kitty etc. | opens `$AACT_FILE_OPENER` at line:col |
| Piped / non-TTY (`jq`, `> log.txt`, CI) | plain text — no escapes               |

`AACT_FILE_OPENER` accepts the same vocabulary as OpenAI Codex's
`file_opener` setting — `vscode` (default), `vscode-insiders`,
`cursor`, `windsurf`, `zed`, or `none`. Set it once in your shell:

```bash
export AACT_FILE_OPENER=cursor    # opens cursor://file/<abs>:line:col
```

In VSCode / Cursor / Zed integrated terminals the env var is
ignored — those editors handle their own terminal-link parser
and jumping happens internally.

## Setup (contributors)

Use **pnpm 11**, not npm or yarn. Supported Node.js lines are the
current LTS lines tested in CI: **22** and **24**. Node 26 is allowed
while current, but CI support starts when it becomes LTS.

```bash
pnpm install --frozen-lockfile
pnpm build         # unbuild → dist/, declarations + CLI shebang
pnpm typecheck
```

## Tests

Three vitest projects:

```bash
pnpm test:unit          # test/**, fast
pnpm test:integration   # examples/**, real fixtures, 15s timeout
pnpm test:e2e           # subprocess `npx aact …`, 90s timeout
pnpm test:coverage      # all + v8 + thresholds (CI uses this)
pnpm test:mutation      # Stryker; not in CI yet, run on demand
```

Coverage floors: **statements ≥95, branches ≥85, functions ≥95,
lines ≥95**. Do not lower them — add tests for the uncovered branch.

Every option-bearing rule needs a property-based test (`@fast-check/vitest`)
that flips the default value and asserts behaviour changes. Hardcoded
literals where the option should be read are the bug class these tests
catch.

For unit tests that need a Model without going through a parser, use
`test/helpers/makeModel.ts` — it synthesises `SourceLocation`s so
range-based rule code paths can be exercised.

## Lint and commit hygiene

```bash
pnpm lint       # eslint + prettier
pnpm knip       # unused exports / deps
pnpm publint    # package.json sanity for npm publish
```

`eslint.config.ts` is the source of truth, including the `boundaries`
plugin layering (`model → format → rule → analyze → cli`, no upward
imports). Do not silence rules with disable comments — fix the code, or
justify the disable in a comment if the rule is genuinely wrong here.

Husky runs `lint-staged` pre-commit so staged source files are linted and
formatted before commit. Commit messages are not rejected based on their
format. Conventional Commits are still recommended because `changelogen`
uses their types to group generated CHANGELOG entries.

## Public API contract

What `src/index.ts` re-exports is the public surface. Anything else is
internal and may change between releases without notice. Breaking changes
to the public API require a `!` marker in the commit and a CHANGELOG
entry.

## Adding a rule

One rule = one file at `src/rules/<name>.ts` exporting a single
`RuleDefinition<Options>` object with inline `check` and optional `fix`.

Do not create `rules/<name>/` subdirectories. Do not split `check.ts` /
`fix.ts` / `options.ts` apart. Register in `src/rules/registry.ts`,
re-export from `src/rules/index.ts`, add the option schema to
`src/config.ts` (both the valibot entry and the `BuiltinRulesConfig`
interface). Add tests in `test/rules/<name>.test.ts` and an ADR in
`ADRs/` if the rule encodes a non-trivial pattern. Run `pnpm docs:gen` —
the rule reference under `docs/reference/` is generated, and `docs:check`
fails CI if it's left stale.

See `src/rules/types.ts` for the contract and `src/rules/crud.ts` for
the canonical example (check + fix + options + naming-pattern matching).
End-to-end example of a _user-defined_ rule (config + tests):
`examples/custom-rules/`.

## Adding a format

One format = one directory at `src/formats/<name>/` with an `index.ts`
exporting a `Format` object. Declare only the `load` / `generate` /
`fix` capabilities the format actually supports. Loaders that emit
`SourceLocation` must use UTF-16 code-unit offsets (matches chevrotain
and LSP defaults). Register in `src/formats/registry.ts`.

The C4-PUML and Structurizr DSL parsers are hand-written chevrotain
grammars under `src/formats/<name>/parser/`. Reference grammars for
both formats live in `.parser-refs/` (fetched on demand via
`scripts/fetch-parser-refs.sh`, not checked in).

## Auto-fix

Fixes are range-based, not pattern-based. Return `SourceEdit[]`
(`replace` / `remove` / `insert-after` / `insert-before`) anchored on
`SourceLocation`s from Model nodes. `applyEdits` (`src/rules/lib/`) is
a pure splicer — do not reimplement text matching inside a rule.

## Releases

```bash
pnpm changelog       # draft next CHANGELOG entry from commits
pnpm release         # changelogen --release --push
```

`CHANGELOG.md` is a public English document. No Russian-English mix.
v3 is stable since `3.0.0`; the v2 and `3.0.0-beta.X` entries stay.

## Out of scope

aact targets C4 _static_ views (System / Container / Component) plus
System Landscape and Dynamic. Do not extend the Model with ArchiMate,
UML, BPMN, or deployment-view concepts. If a change needs them, open
an issue first.
