# Changelog

All notable changes to `aact` are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## v3.0.1 — 2026-09-06

> Patch release. The `--json` envelope now survives a pipe, a missing
> `!include` names itself, and `aact view` / `aact skill install` point at
> targets that exist. It also carries the post-GA review fixes that were
> merged upstream after v3.0.0 — including one breaking change to the
> `FormatSyntax` plugin surface, kept in a patch because it shipped with
> those fixes.

### Fixed

- **`--json` output is no longer truncated at 65536 bytes when stdout is a
  pipe.** The CLI called `process.exit` immediately after an async stdout
  write, so whatever the pipe had not drained was discarded: any consumer
  reading the envelope from a subprocess got invalid JSON once the payload
  passed the pipe buffer — a ~40-element model is already past it. The exit
  path now waits for both standard streams to reach the OS. Redirecting to a
  file or writing to a TTY was never affected, which is how this survived to
  GA.
- **A missing local `!include` names the include, not the entry point.** The
  loaders' `ENOENT` reached the CLI indistinguishable from a missing source
  file, so the diagnostic read `Architecture file not found: <entry point>` —
  the one file that was fine. Both the C4-PlantUML and the Structurizr DSL
  loader now report `model.includeNotFound` with the missing path, the file
  holding the directive, and its line and column; nested chains report the
  innermost site.
- **`aact view` opens an authorised URL.** `listhen` opens its own `baseURL`,
  so the per-session token is passed there instead of being appended after
  `listen()` returned — the browser no longer lands on an unauthorised bare
  URL.
- **`aact view` install hints target the stable channel.** They still told
  users to install `aact@beta` / `@aact/view@beta` after GA.
- **`aact skill install` clones a repository that exists.** The default clone
  target had moved to `Byndyusoft/aact-architect-skill` ahead of the repo
  transfer, so the documented way for an agent to install the skill failed on
  a 404. It points back at `ChS23/aact-architect-skill` until the transfer
  happens.
- **`aact generate` reports bad output instead of writing it.** Element or
  boundary names that cannot become a DNS-1123 Kubernetes name, two names
  that normalise to the same one, absolute or directory-escaping generated
  paths, and two artefacts claiming one path now surface as
  `format.invalidGeneratedName`, `format.unsafeOutputPath` and
  `format.outputPathCollision`.

### Changed

- **BREAKING: `FormatSyntax.containerDecl` takes the Model `Element`**
  instead of `(name, label, tags)`. Rebuilding a declaration from three
  positional fields silently dropped description, technology, link and user
  properties, so an auto-fix that re-declared a container erased model data.
  Custom rules that call `containerDecl`, and formats that implement it, must
  pass / accept the element. This is a breaking change in a patch release: it
  landed with the post-GA review fixes merged upstream, and is documented
  here rather than renumbered. The JSON contract is untouched —
  `schemaVersion` stays `1`.

## v3.0.0 — 2026-06-21

> First stable v3. `schemaVersion: 1` is now frozen as the public contract.
> The headline work: hand-written chevrotain parsers (C4-PUML + Structurizr
> DSL) with source ranges, the capability-based Model / Format API, and the
> unified `--json` / `--sarif` envelope for CI and AI agents. The
> `3.0.0-beta.X` entries below are the incremental history.

### Changed

- **BREAKING: `Model.tags` no longer carries implicit tags that duplicate a
  typed field.** Structurizr stamped `Element` plus a kind tag (`Container`,
  `Software System`, …) and `External` on elements, and `Relationship` on
  relations, mirroring the reference parser. Each mirrors a field the Model
  already has (`kind`, `external`), no rule reads them (rules branch on the
  typed fields), and the PlantUML / kubernetes / compose loaders set the
  fields without emitting the tags. `buildModel` — the one constructor every
  loader flows through — now strips them, so the same model yields the same
  `tags` whatever format it loads from. User-authored domain tags (`repo`,
  `acl`, `owner:team`, the `async` relation marker) are untouched, and the
  Structurizr generator re-derives the styling tags from `kind` / `external`
  on output, so round-trips stay faithful.
- **Cross-format diff is quieter.** `aact diff` strips the same implicit tags
  when comparing (a net for hand-built Models / legacy `.aact.json`), and the
  loaders that synthesise a label from a machine name (`kubernetes`,
  `compose`) keep well-known acronyms uppercase (`orders-api` → `Orders API`,
  not `Orders Api`). Together these let `aact diff architecture.dsl ./k8s/`
  report real structural drift without tag or label noise. New `meaningfulTags`
  helper is exported from the model surface.
- **BREAKING: the root barrel (`aact`) is an explicit allow-list, not
  `export *`.** Re-exports are now chosen deliberately rather than mirroring
  whatever each module happens to hold. `AactConfigSchema` (author config via
  `defineConfig`) and `isDuplicateElement` (a validation internal) are no
  longer exported. `loadBaseline` and `DiffInputError` move out of CLI
  internals into the public `diff` module — the CLI maps `DiffInputError` to a
  tool error at its boundary — and join `meaningfulTags` / `formatLocation` on
  the documented surface.
- **`aact generate --format kubernetes` now emits real, `kubectl apply`-able
  manifests** — `apps/v1` Deployment / StatefulSet + `v1` Service / Namespace
  (current stable API) — replacing the legacy `name:` / `environment:`
  deploy-config. It's a scaffold, not a deployment source (the C4 model has no
  resources / probes / secrets / ingress — those stay in your Helm / Kustomize),
  but it round-trips: `generate` → `load` reproduces the model, with `aact.*`
  annotations preserving kind / technology / tags / name and relations becoming
  env-var Service references. `KubernetesGenerateOptions.dbConnectionTemplate`
  now substitutes `{service}` / `{db}`.
- **`aact generate` accepts a positional `source`** — like `model` / `check` /
  `analyze`, so `aact generate architecture.dsl --format plantuml` works ad-hoc
  with no `aact.config.ts`. The positional is the **input** (format auto-detected
  from the path); `--format` stays the **target** format.
- **BREAKING: a rule is identified by `ruleId` everywhere in the JSON
  contract.** `CheckViolation` and `FixResult` now carry `ruleId` (was
  `rule`), matching SARIF `result.ruleId`, so consumers join
  `violations[]`, `suggestedFixes[]`, and `rules[]` on a single key. `aact
rule list` and the `rules[]` array of `aact check --json` share one
  `RuleMetadata` shape (`ruleId, description, source, enabled, hasFix,
helpUri?`), and `rule list` now carries `helpUri`. The public
  `CheckRuleMetadata` and `RuleInfo` types are removed in favour of
  `RuleMetadata`; `RuleDefinition.name` (the authoring field) is unchanged.
- **BREAKING: `CheckSummary` drops `total` in favour of `violations`.**
  `passed` and `failed` count rules (`passed + failed` = rules evaluated);
  `violations` counts findings. The old `total` was a finding count, so it
  conflated the two axes (`total !== passed + failed`).
- **`CheckViolation.severity` is now `"error" | "warning" | "info"`** — the
  same JSON vocabulary as `Diagnostic.severity` — reserved as a union at
  v3.0.0 so configurable / per-rule severity can land later without a
  `schemaVersion` bump. Every rule still emits `"error"` today; SARIF maps
  `info` → `note`, GitHub annotations `info` → `notice`.
- `AnalysisReport` and its sub-types (`BoundaryAnalysis`, `CouplingRelation`,
  `DatabasesInfo`, `ElementCoupling`, `CyclesInfo`, `RelationStyleCounts`) are
  now fully `readonly`, matching the rest of the public type surface — the
  analyzer accumulates via an internal mutable builder. No JSON-output change.
- **BREAKING: an unknown name in `config.rules` is now a hard error
  (exit 2)** instead of a non-fatal warning. A typo previously disabled
  enforcement silently — exactly the failure CI must catch. Every unknown
  name is reported together; this matches the other `config.*` errors and
  ESLint's treatment of unknown rules. Register the name via `customRules`
  or remove it; `aact rule list` shows what's available.
- `Diagnostic.severity` gains `error` (was `warning | info`). A `ToolError`
  now surfaces as an `error`-severity diagnostic, so the JSON / SARIF severity
  matches the `exit 2` it produced (e.g. the new `config.unknownRule`) instead
  of misreporting a fatal as `warning`.
- SARIF rule passports now match the JSON ones: `check --sarif` uses the same
  ADR-based `helpUri` as `RuleMetadata` (the dead `#<name>` README anchor is
  gone, omitted when a rule has no ADR), and `model --sarif` rule ids / result
  `ruleId`s use the camelCase `DiagnosticKind` (`model.danglingRelation`) —
  the same vocabulary as `model --json` diagnostics, not kebab-case.
- `check`, `rule list`, and `rule explain` now resolve rules through one
  shared resolver, so they agree on the rule set: a `customRules` name that
  collides with a built-in (or another custom) is a `config.invalidCustomRule`
  error (exit 2) in all three — previously `rule list` silently duplicated it
  and `rule explain` shadowed the custom rule with the built-in.
- `generate --json` `files[].bytes` is now the UTF-8 byte size written to
  disk, not the JS string length (which counts UTF-16 code units and
  undercounts non-ASCII output).
- **`config.generate` is now per-format.** Options live under
  `generate.<format>` (`generate.plantuml.boundaryLabel`,
  `generate.structurizr.fileName`, `generate.kubernetes.path`), and
  `aact generate` passes the matching slice to `format.generate`. Previously
  `generate.boundaryLabel` sat at the top level and was silently ignored by
  the CLI.

### Added

- **`model`, `check`, and `analyze` accept a positional `source`** — a file or
  directory path, the way `aact diff` already does. It overrides
  `config.source`, and with no `aact.config.ts` it stands in for one
  (`aact model architecture.dsl`, `aact check ./k8s/`); the format is
  auto-detected from the path (directory → kubernetes). Ad-hoc `check` with no
  config runs every built-in rule.
- A `kubernetes-drift` example (`examples/kubernetes-drift/`) — an intended C4
  architecture vs. a deployed cluster with planted drift — backing the new
  [architecture-conformance guide](docs/guides/architecture-conformance.md)
  (AaC ↔ IaC).
- A `library-api` example (`examples/library-api/`) and guide
  ([aact as a library](docs/guides/library-api.md)) — driving aact from code:
  `load`, built-in + `defineRule` rules, `computeDiff`, `analyzeArchitecture`,
  `generate`, all through the public package surface.
- A [cascade coupling reduction guide](docs/guides/cascade-coupling.md) — how to
  model the hierarchy as nested boundaries and check, with `analyzeArchitecture`,
  that coupling doesn't grow up the levels (backed by the existing
  `examples/banking-plantuml/ccr.test.ts`).
- A [getting-started guide](docs/guides/getting-started.md) — the five-minute
  `init` → `check` → `--fix` onboarding path, with the real scaffolded output.
- An [agent-contract guide](docs/guides/agent-contract.md) — how an AI agent
  drives aact: the stable `--json` `CliEnvelope`, exit codes, `model` / `check` /
  `rule` data shapes, and the `aact-architect` skill.
- Format objects are exported from the package root — `plantumlFormat`,
  `structurizrFormat`, `modelJsonFormat`, `kubernetesFormat`,
  `composeFormat` — mirroring the rule objects (`aclRule`, `crudRule`, …).
  `loadFormat` stays for registry / dynamic use; the objects are for static
  imports and library examples.

### Schema

- The model-json JSON Schema (`aact-model-v1.json`) no longer pins
  `additionalProperties: false`, so additive Model fields under
  `schemaVersion: 1` don't make files written by a newer aact fail
  validation against the published v1 schema. Breaking shape changes still
  move to `aact-model-v2.json`.

### Fixed

- `aact generate` no longer corrupts the machine-readable envelope: a stdout
  artefact sink is now refused in **any** non-text output mode (`--json`,
  `--sarif`, or `config.output.mode`), not just the CLI `--json` flag.
  Previously `config.output.mode: "json"` without `--output` wrote the
  artefact and the JSON envelope to the same stdout.
- `aact generate --format compose` now emits valid Compose for a generic
  `Container` with no inferable image: the service gets `build: { context: "." }`
  (the Compose Spec requires `image` **or** `build`), and the original
  `technology` is preserved as an `aact.technology` label so `generate → load`
  round-trips it instead of dropping it. Previously such a service had neither
  key — rejected by `docker compose config` and by aact's own loader.
- `aact generate --format plantuml` no longer emits diagrams that render
  broken. PlantUML treats `//` as Creole italic markup, so a raw URL in a
  label / description / technology / property (e.g. `https://gateway/v1`)
  rendered as `[https: …]</size>//`. Generated text now escapes `//` → `~//`
  (hyperlink `$link` targets are left intact), and the loader decodes the
  escape so the Model keeps the real value and `generate → load` round-trips.

## v3.0.0-beta.29 — 2026-06-10

> Opt-in rules, a full documentation layer (eight guides plus a generated
> reference), and a round of CLI / CI hardening on the way to v3.0.0 GA.

### Changed

- **BREAKING: built-in rules are now opt-in.** `aact check` runs only the
  rules named in `config.rules` (`<name>: true` or an options object).
  Previously every built-in ran unless explicitly disabled, so a config
  never showed what was actually enforced. Now an empty or absent `rules`
  block enforces nothing — the config is the single source of truth.
  `aact init` already scaffolds the built-ins explicitly, so `init`-based
  projects are unaffected; hand-written configs must list the rules they
  want. Custom rules registered via `customRules` stay auto-enabled, and
  `<name>: false` remains an explicit opt-out. Inspect the effective set
  with `aact rule list`.

### Added

- **Generated reference** under `docs/reference/` — per-rule pages (rationale,
  good/bad examples, fix and ADR links), a command list, and a
  format-capability table, all built from aact's own registries by
  `pnpm docs:gen` and drift-guarded in CI (`pnpm docs:check`).
- **Eight usage guides** under `docs/guides/` — modeling for aact, running
  `check`, configuring rules, `analyze` metrics, CI via SARIF / GitHub Code
  Scanning, custom rules, reviewing architecture diffs, and exploring an
  architecture with `view`.

### Fixed

- Name-convention rule options are accepted in `config.rules` again:
  `acl.namePatterns`, `apiGateway.aclNamePatterns`, `crud.repoNamePatterns`
  and `dbPerService.ownerNamePatterns` were read by the rules but rejected by
  the config schema.
- `generate --output` treats a trailing slash or an existing directory as a
  directory sink.
- Config loading stays silent in a project without `package.json` — no more
  Node ESM warning on stderr (the config is loaded via jiti).
- Non-TTY / redirected output on Windows no longer emits ANSI escape codes.
- Hardened C4 PlantUML parser compatibility and the `@aact/view` release path.

### Internal

- CI builds before linting (so `@aact/view`'s typecheck resolves `aact`), runs
  the first-time-user smoke walkthrough on Windows as well with stricter
  stderr / k8s-output assertions, and drops the obsolete PlantUML auto-render
  workflow. Unit coverage restored to the 95 / 85 / 95 / 95 floor.

## v3.0.0-beta.28 — 2026-05-23

> CLI plan-view round. `aact check --dry-run` is now a dedicated mode
> with inline per-violation annotations and compact edit previews —
> not a copy of `check` with a "Suggested fixes" trailer. The
> envelope's `mergedFixes` field, previously hidden under
> `fixesApplied`, surfaces at the top of `data` so `--dry-run`
> consumers (and any non-fix-mode reader) can see which rules dedupe
> collapsed together.

### Added

- **`aact check --dry-run` plan view.** Per violation: standard
  location/rule/target row + an inline annotation:
  - `→ would <description>` followed by a compact one-line preview of
    each planned edit (`replace <file:line:col>  →  <new content>`)
    when the rule has an autofix;
  - `→ resolved together with <rule> fix` when dedupe collapsed this
    rule's fix into another's edit;
  - `→ no autofix — manual review` otherwise.

  The result box switches to `✗ check (dry-run)` with a
  `N violations · X fixable · Y manual` headline plus a
  `run --fix to apply` hint. Distinct shape from `check`'s diagnose
  table and `--fix`'s outcome list — each command renders for its
  own purpose.

### Changed

- **`mergedFixes` promoted to the top of `CheckData`.** Previously
  nested under `fixesApplied.mergedRules` and therefore invisible to
  `--dry-run` consumers (and any non-fix reader). The new top-level
  `data.mergedFixes` is populated whenever dedupe collapsed cross-rule
  edits, regardless of mode. `fixesApplied.mergedRules` is removed —
  read the same shape from `data.mergedFixes`.

## v3.0.0-beta.27 — 2026-05-23

> View UI polish round. `aact view` databases and queues now render as
> canonical C4 cylinders and horizontal pipes (inline SVG so the shapes
> stay crisp at any size). Topbar brand block adopts Zed's title-bar
> language — no middot separators, a real 6×6 status dot, muted
> subcommand breadcrumb. Three single-letter keyboard shortcuts land
> (`1/2/3` for view mode, `A` for analyze, `Esc` to clear selection)
> with a discoverable cheat-sheet next to the C4 legend.

### Added

- **Canonical C4 shapes for `ContainerDb` / `ContainerQueue`.** Inline
  SVG paths with `preserveAspectRatio="none"` and `vector-effect:
non-scaling-stroke` give databases a cylinder profile (visible top
  rim ellipse + bottom curve) and queues a horizontal pipe profile
  (left rim ellipse + right end-cap), regardless of the ELK-assigned
  node aspect ratio. Both keep the same solid C4 fill / hairline
  stroke / typography hierarchy as the regular Container nodes, so
  the three node families read as one visual family while keeping
  their canonical shape hints.
- **Keyboard shortcuts on the workbench.** `1`, `2`, `3` switch
  between Drill / Expand / Flat view modes; `A` toggles the Analyze
  overlay; `Esc` clears the current node / boundary selection.
  Shortcuts no-op while focus sits in a form control so they don't
  fight the page. A small chip-style cheat-sheet sits next to the
  C4 element legend so the bindings are visible without a tooltip.
- **`aact view` topbar brand block: Zed title-bar style.** The
  `aact · view · <Workspace> · ● live` chain drops the middot
  separators for a tight 10px gap, splits the readable identity
  (`aact` semi-bold app name, `view` muted breadcrumb,
  `<Workspace>` regular text), and replaces the unicode `●` with a
  real 6×6 `border-radius: 999px` div whose colour tracks the
  connection state (`#34d399` live / `#fbbf24` reload error /
  `#f87171` disconnected / muted while connecting). Mirrors Zed's
  `Indicator::dot()` + `LabelSize::Small Color::Muted` pattern.
- **`ContainerDb` and `ContainerQueue` kind labels render with a
  space.** The uppercase chip in the node header now reads as
  `CONTAINER DB` / `CONTAINER QUEUE` instead of the camelCased
  `CONTAINERDB` / `CONTAINERQUEUE`.

### Changed

- **SvelteFlow Controls moved to the top-left of the canvas.**
  The default bottom-left position collided with the C4 legend; top-left
  keeps zoom / fit / lock buttons reachable without overlap. Style
  matches the Zed-language hairline border + flat surface other
  overlays use.

> Honesty fix on the `--fix` summary. When dedupe collapsed two
> rules' byte-identical edits into one (beta.25), the outcome read
> as "1 fix applied" — looked like only one of the two violations
> got addressed. Now the summary credits every rule the single
> landed edit resolved and shows the violations-resolved count
> alongside the edit count.

### Added

- **Renderer + envelope credit subsumed rules in `--fix` output.**
  When the dedupe pass merges another rule's byte-identical edit into
  the kept one, the renderer now appends
  `(also resolves: <rule>, …)` to the affected fix line, and the
  result box shows `N fix applied · M violations resolved` so the
  pre-fix violation count is visible alongside the edit count.
  Machine consumers read the same data from
  `data.fixesApplied.mergedRules`, a record keyed by the kept rule
  with the list of rules it subsumes (omitted when no dedupe
  happened).

## v3.0.0-beta.25 — 2026-05-23

> Quality-of-life on the autofix loop. Two rules that propose
> byte-identical edits no longer raise an `editConflict` warning —
> the duplicate is dropped silently and the single edit applies.
> `aact check --fix` text output drops the pre-fix violation table
> for a per-applied-fix one-liner + outcome box. In JSON, `--fix`
> mode now treats `data.violations` / `data.summary` as the
> **post-fix** state so `exitCode` and the envelope agree; pre-fix
> data moves to `fixesApplied.before` for audit.

### Added

- **`fixesApplied.before` in the `check --fix` JSON envelope.** Carries
  the pre-fix `violations` + `summary` snapshot for tooling that needs
  to audit what the command saw before any edits landed. Top-level
  `data.violations` / `data.summary` continue to be the authoritative
  final state — in `--fix` mode they now reflect the post-fix re-check
  result, matching `exitCode`. Outside `--fix` they're unchanged.

### Fixed

- **`aact check --fix`: dedupe byte-identical edits across rules
  before applying.** Multiple rules can independently discover the
  same safe rewrite — the starter architecture is the canonical case:
  `crud` and `dbPerService` both route `orders → orders_db` through
  the existing `orders_repo`. Previously the applier reported the
  second occurrence as an `editConflict` and required a re-run; now
  the duplicate is filtered out before render so the single edit
  applies cleanly. Genuinely different overlapping edits still
  surface as conflicts.

### Changed

- **`aact check --fix` text output: outcome-focused, no duplicate
  violation table.** The pre-fix violation listing belonged to `check`;
  repeating it under `--fix` read as "found 2 errors → still found 2
  errors → applied" even though the second listing was just the
  pre-fix state. New shape: one line per applied fix
  (`✓ <rule>  <description>`), then a result box
  (`N fix applied · M violations remaining · wrote <path>`). When some
  violations had no autofix, they're listed under a "Not auto-fixed"
  heading. `check` and `--dry-run` output is unchanged.

## v3.0.0-beta.24 — 2026-05-23

> Format API reaches feature-complete: Docker Compose and Kubernetes
> loaders join PlantUML, Structurizr DSL/JSON, and `.aact.json` as
> first-class formats. Structurizr DSL gains a round-trip generator,
> so a model loaded from DSL can be regenerated back to DSL with
> identifier and property preservation. The `diff` engine moves from
> naive rename heuristics to Kuhn-Munkres optimal assignment over an
> eight-feature similarity vector with fixed-point chain-rename
> resolution and architectural ChangeGroup detection. `aact view`
> grows a diff overlay, an analyze overlay, and a non-AI visual
> language. One breaking change: `source.writePath` is dropped and
> Structurizr JSON now refuses `--fix` (use DSL).

### Added

- **Docker Compose loader and generator.** Auto-detects all four
  canonical filenames (`compose.yaml`, `compose.yml`,
  `docker-compose.yaml`, `docker-compose.yml`); resolves service
  names through the unified image-heuristic helper shared with the
  Kubernetes loader; preserves user-authored labels; round-trips
  through `aact generate --format compose`.
- **Kubernetes loader.** Walks Deployment, StatefulSet, DaemonSet,
  Job, and CronJob workloads; reads namespaces, annotations, and
  Service relations; chases `kustomization.yaml` resource graphs so
  the loader sees the same flattened tree `kubectl apply -k` would
  apply. Pairs with the existing `generate --format kubernetes`
  output for closed-loop infrastructure conformance.
- **Structurizr DSL generator with round-trip parity.** Models
  loaded from `.dsl` regenerate to `.dsl` with identifiers,
  workspace body overrides, archetype alias chains, and implied
  relationships preserved. Closes the symmetry gap left when v3
  only supported DSL loading.
- **Structurizr archetype family.** Kind-default archetype form
  (`archetype "service" { tags … }`), archetype alias usage with
  chained defaults, and property/perspective propagation through
  the archetype hierarchy. Workspace-body overrides and bare
  `impliedRelationships` directive land in the same pass.
- **Diff: Hungarian assignment over multi-feature similarity.**
  Rename detection replaces the previous greedy nearest-neighbour
  pass with Kuhn-Munkres optimal assignment on a similarity matrix
  computed from name, label, technology, external flag, tags,
  relations, description, and properties — eight weighted features
  derived from the EMF Compare convention. Configurable
  `--rename-threshold` (default 0.65) controls the minimum
  similarity required to admit a candidate rename.
- **Diff: fixed-point iteration for chain renames.** When a rename
  unlocks adjacent rename candidates (e.g. a service renames and
  its repository renames in tandem), the resolver re-runs until the
  assignment stabilises, capped at 5 iterations. Removes a known
  failure mode where the first pass would miss the second leg of a
  refactor.
- **Diff: architectural ChangeGroup detectors.** Primitive changes
  are post-processed into higher-level patterns:
  `technologySwapped` (a container's technology field changed —
  surfaced as one group instead of one field-change per affected
  property), `introducedRepository` (a new repository container
  appeared and accessor relations rerouted through it). Each group
  carries a confidence score and the list of underlying change
  addresses. The text reporter and `--json` envelope both expose
  groups under `data.groups`.
- **Diff benchmark corpus.** Twelve hand-authored before/after
  scenarios under `test/diff/benchmark/case-NN/` cover renames,
  decomposition, repository extraction, technology swaps, boundary
  moves, and chain renames. Each case ships an `expected.json`
  asserting exact diff output — the corpus doubles as a regression
  harness and a tuning ground for future similarity weight
  adjustments.
- **`aact view` — diff mode.** `aact view --diff <baseline>` boots
  the workbench against the current model and a baseline (file path
  or git ref), colours added / removed / modified / renamed / moved
  nodes and relations on the graph, and adds a sidebar diff panel
  listing ChangeGroups and top primitive changes. Baseline is
  loaded once at boot; live-reload still tracks the current source.
- **`aact view` — analyze overlay.** Toggle in the topbar surfaces
  architecture metrics in the sidebar (elements by kind, relations
  by style, top fan-in / fan-out, cycles) and highlights cycle
  edges on the graph itself. The same `AnalysisReport` shape the
  `aact analyze --json` envelope returns.
- **`aact view` — non-AI visual language.** Topbar adopts Zed-style
  segmented controls with hairline dividers and muted accent on
  active. Sidebar drops the stat-card grid for a horizontal
  info-line; section headers unify on a single uppercase tracking
  treatment. Diff palette is paired with `+ − ~ ↦ ⇄` glyphs so the
  status survives colour-blindness. Boundary chips drop the solid
  pill background for an understated kind label tinted with the
  family accent; element nodes drop gradients and decorative
  shadows for a solid C4 fill with hairline border.
- **Per-module READMEs for public contracts.** `src/model/`,
  `src/rules/`, `src/diff/`, and `src/formats/` each ship a README
  documenting the public surface, design choices, and integration
  hooks. Targeted at library consumers and AI agents building
  against the envelope.

### Fixed

- **Diff: pass `source.options` through to baseline + current
  loaders.** Format options configured in `aact.config.ts` were
  silently dropped when `aact diff` loaded the two sides. Both
  loaders now receive the resolved options.
- **Diff: auto-detect Kubernetes directories as baseline / current.**
  When the baseline or current path is a directory containing
  Kubernetes manifests, the loader now infers `format: kubernetes`
  instead of failing the format dispatch.
- **`aact check --fix`: universal parse-error mapping.** Parse
  errors raised by any loader (PlantUML, Structurizr DSL, Compose,
  K8s) now flow through a single `parse-error` diagnostic with
  consistent source-location anchoring, and `--fix` re-checks after
  applying edits so partial-fix runs surface remaining violations
  in the same invocation.
- **Structurizr: DSL-source parity for config inference and
  `--fix`.** The DSL loader and the existing JSON loader now agree
  on how config-level options (`source.options.structurizr.*`)
  flow into element kind defaults, so `aact check --fix` produces
  identical edits regardless of which form the workspace was
  loaded from.
- **`aact view`: scope WebSocket upgrades to `/api/ws` and surface
  layout errors.** WebSocket upgrade attempts on unrelated paths
  used to crash the h3 server with a CrossWS error; they now
  return 404. ELK layout failures surface as a banner over the
  canvas instead of a blank pane.

### Tests

- Property-based + e2e push closes the remaining coverage gap to
  clear the 95% statements floor consistently across runs.

### Breaking Changes

- **`source.writePath` is dropped.** The config option only existed
  to support read-from-A-write-to-B during the v2 → v3 cutover; v3
  rules write back to the same path they read from. Drop the
  field from any `aact.config.ts` that still declares it.
- **Structurizr JSON refuses `aact check --fix`.** Structurizr JSON
  is treated as a generated artefact (`workspace.json` from
  Structurizr Cloud, CI, or the DSL CLI). `--fix` against a JSON
  source now errors with a hint to point the config at the
  authoring DSL instead. DSL `--fix` is unchanged.

## v3.0.0-beta.23 — 2026-05-21

> Supersedes the rapid-iteration sequence beta.19 → beta.22. The
> first four publishes shipped the same feature but stumbled on
> packaging / runtime details discovered only on real installs
> (workspace protocol leaking through `npm publish`; WebSocket
> upgrade crash; missing `@beta` dist-tag in the auto-install
> hint; the dead-end prompt under `npx` / `pnpm dlx`). Upgrade
> directly from beta.18 to beta.23 — the intermediate tags
> remain published but are not recommended.

### Added

- **`aact view` — experimental browser workbench (`@aact/view`).**
  Companion package, optional dependency on aact. `aact view`
  boots a local h3 server with a Svelte 5 SPA on the model
  resolved from `aact.config.ts`; ELK lays the graph out, Svelte
  Flow renders it, chokidar pushes live re-layouts over WebSocket
  on every source save. Three modes (Drill / Expand / Flat) match
  how an architect navigates a C4 hierarchy. Edge filter
  highlights Bounded-Context interactions when intra-context
  wiring obscures the diagram. Visual language follows the Simon
  Brown C4 reference palette; the details panel surfaces tags,
  technology, properties, outgoing relations, and a source link
  that opens the DSL line in the IDE configured via
  `AACT_FILE_OPENER`. A per-session auth token guards
  `/api/model` and the WebSocket upgrade so unrelated browser
  pages on the same machine cannot read the graph. The subcommand
  lives in core; `@aact/view` ships as a separate npm package so
  users who do not want a browser dependency keep their install
  light. When the companion is missing, `aact view` either
  prompts to install via the project's package manager (when the
  binary is running from a real `node_modules`) or prints a
  three-option hint covering project-local install, multi-package
  `npx -p` one-off, and global install (when running from an
  `_npx` / `dlx` cache where in-cwd installs are invisible to the
  cached binary). Full visual + interaction spec in
  [`packages/view/DESIGN.md`](packages/view/DESIGN.md).
- **Structurizr DSL loader: nested boundaries no longer surface
  as root.** Previously every parsed boundary landed in
  `model.rootBoundaryNames`, so a `softwareSystem` wrapping
  `container` groups produced both the System boundary AND its
  child Container boundaries at the top level. Downstream
  consumers (`aact view` Landscape, `aact model` text-summary,
  PlantUML `generate`) all double-counted as a result. A boundary
  that any other boundary lists in `boundaryNames` is now
  filtered out of the root set.

## v3.0.0-beta.18 — 2026-05-21

Parser corpus consolidation. PUML `SetPropertyHeader` / `AddProperty`
rows are now preserved on `Model.properties` with a round-trip
through `aact generate`. Structurizr DSL `group` blocks stop
contaminating the identifier namespace, boundary `elementNames`, and
container-to-boundary classification — three separate bugs the
parallel `aact-architect` agent surfaced on real workspaces. CI
gains a user-smoke workflow that walks every public CLI command on
a fresh project so user-facing regressions land in red before they
land in beta.

### Added

- **PUML `AddProperty` rows preserved on Model.** New
  `extractAttachedProperties` pre-lex pass walks the source for
  `AddProperty(...)` lines preceding any in-scope macro
  (Container / Person / System / Boundary / Rel / BiRel /
  RelIndex variants) and returns a 1-based-line-keyed map. toModel
  attaches them to `Element.properties` / `Relation.properties` /
  `Boundary.properties` by `sourceLocation.start.line` lookup.
  `generate` emits one `AddProperty("k", "v")` per entry ahead of
  each element / relation macro so the round-trip survives.
  `SetPropertyHeader` and `WithoutPropertyHeader` are render-time
  protocol — they reset the pending buffer but do not surface on
  `Model.properties`.

  Edge cases covered:
  - **Named-arg form** `AddProperty($col1="value")` from upstream
    `TestPropertyMissingColumns.puml` — the `$colN=` prefix is
    stripped before the value lands on the key/value pair.
  - **Escape-safe round-trip** — `unwrapArg` uses `JSON.parse`,
    `renderPropertyLines` uses `JSON.stringify`, so keys / values
    containing `"` or `\` survive parse → generate → re-parse
    unchanged.
  - **Whitespace-only keys dropped** — upstream column-placeholder
    rows (`AddProperty(" ", " ", ...)`) carry no architectural
    information and would surface as meaningless `" "` keys.
  - **`user-smoke` CI workflow** walks `init` → `check` → `model
--json` → `analyze --json` → `diff` → `generate --format
model-json` (with `$schema` round-trip) → `rule list` / `rule
explain` (asserts the live ADR blob URL, not the dead README
    anchor) → `check --fix` → `check --sarif` → unknown command
    on a fresh `$RUNNER_TEMP/aact-smoke` project. Catches the
    "looked green in vitest but the CLI surface broke" bug class.

### Fixed

- **Structurizr `group` no longer pollutes the parent boundary.**
  `softwareSystem "S" { group "Backend" { api = container "API" } }`
  used to push the string `"Backend"` onto the boundary's
  `elementNames`, leaving a dangling reference that
  `validateModel` flagged as `elementInBoundaryNotInModel`. The
  resulting empty boundary read `cohesion = 0` and made every
  group-using model look broken. `flattenGroupTargets` now walks
  group nesting and yields concrete element / boundary nodes; the
  boundary's `elementNames` and `boundaryNames` describe what's
  actually in the Model.
- **Group names no longer claim identifier-map slots.**
  `handleElement` dispatches into `handleGroup` _before_ the
  identifier registration block, so a group's display name never
  competes with element identifiers. Two groups with the same
  name (`group "Backend" { ... } group "Backend" { ... }`) stop
  emitting a phantom `duplicate-identifier`; an element identifier
  that collides with an outer group name (`Payments = container
"Payments Service"` next to `group "Payments"`) loads cleanly.
- **Body-form `group "Layer"` is a property, not a boundary.**
  `api = container "API" { group "Application Layer" }` is the
  reference parser's body-form syntax: a bare `group` with no
  `{ }` block sets `properties.group` on the enclosing element.
  Previously the empty-members group was treated as a structural
  child and promoted the container to a Boundary. New
  `isGroupPropertyStatement` predicate excludes it from the
  structural-child set; the property surfaces, the boundary
  doesn't.
- **`pnpm pack` outside a git checkout no longer prints a husky
  warning.** The previous `husky || true` only swallowed husky's
  non-zero exit; its stderr "fatal: not a git repository" still
  leaked into sandboxes and publint smoke checks. Gated on
  `test -d .git` so dev checkouts still install hooks and
  consumer extractions stay silent.

### Tooling

- **CI `pnpm test`** now runs all 1300+ unit tests including the
  new `extractAttachedProperties` and `groupProperty` suites.
- **CI verifies `pnpm schema:check`, `pnpm knip`, `pnpm lint`,
  `pnpm typecheck`** all clean — no warnings, no errors on the v3
  branch.

## v3.0.0-beta.17 — 2026-05-20

UX polish and parser corpus coverage release. Every text-mode anchor
in the CLI now relativises against cwd (rustc / biome / eslint
convention), so `aact check` no longer eats half the terminal width
with `/Users/.../project/architecture.puml:23:1` repeats. `aact
generate --format model-json` writes a `$schema` pointer so
VSCode / Cursor / JetBrains / Zed auto-attach the bundled JSON Schema
and validate `*.aact.json` files inline. The PUML and Structurizr
parsers survive the upstream stdlib corpus, and Structurizr-DSL
loaded models reach parity with what the Structurizr JSON loader
already produced (`ContainerDb` from technology, `external: true`
from the location tag).

### Added

- **`$schema` in `architecture.aact.json`.** `aact generate
--format model-json` now writes a top-level
  `"$schema": "https://raw.githubusercontent.com/Byndyusoft/aact/main/schemas/aact-model-v1.json"`
  ahead of `schemaVersion` and `model`. Editors that resolve
  `$schema` (VSCode + forks, JetBrains, Zed) attach the bundled
  JSON Schema and provide autocomplete on Element / Boundary
  fields, `kind` enum suggestions, hover docs from the TS JSDoc,
  and real-time validation — same DX as writing TS without
  running aact. The schema is generated from `ModelJsonFile` via
  `pnpm schema:gen` and pinned in CI with `pnpm schema:check`
  so it can never drift from the TS type.
- **`renderCheckText` takes an explicit `mode` argument** (`"human"`
  or `"github-actions"`). Tests no longer rely on ambient
  `GITHUB_ACTIONS` env; production CLI behaviour is unchanged via
  an env-derived default.
- **PUML parser** accepts the C4-PlantUML stdlib's long-form layout
  macros (`Lay_Down` / `Lay_Up` / `Lay_Left` / `Lay_Right`),
  single-quoted strings (`'Sample'`), `$var` references as named
  arg values (`$sprite=$img`), and macro keywords used as bare
  element aliases (`Component(Component, "Component")`). A new
  `stripLineComments` preParse pass blanks `' …` whole-line
  comments before the lexer can pair them with single-quoted
  strings. `@startuml diagram-name` (and quoted variants) carries
  through to the AST.
- **Structurizr parser** infers `ContainerDb` / `ContainerQueue`
  from a container's `technology` field via the shared
  `kindHeuristics` helper, and lifts `external: true` from the
  `structurizr.location.external` tag for softwareSystem leaves —
  DSL-loaded models now match what the Structurizr JSON loader
  already produced. CST recovery hardened so a partial parse
  (missing closing brace) yields a `recovered: true` Model
  instead of throwing on undefined token access.
- **Corpus confidence smoke tests** for both parsers. Walks
  `examples/`, `fixtures/`, and `.parser-refs/{C4-PlantUML,java}/`
  — first-party diagrams must round-trip through `generate`,
  upstream fixtures must never throw, and `*.dsl` / compiled
  `*.json` siblings must produce identical Models.

### Fixed

- **CLI text-mode paths relativise against cwd.** Following the
  rustc / biome / eslint / oxlint convention, every user-facing
  path in `aact check` (violation table primary anchor, `↳`
  related-location rows, dry-run `~ replace …` preview,
  `editConflict` diagnostic message, `✔ Applied N fix(es),
wrote …` success line), `aact diff` header, and `aact generate`
  write messages now prints relative to the current working
  directory when the file lives under it. The URI on the OSC 8
  hyperlink stays absolute so editor click-through still works in
  VSCode / Cursor / Ghostty / iTerm2 / Zed / CI. JSON / SARIF
  outputs untouched — they continue to carry absolute paths for
  downstream tooling that joins them against external anchors.
- **`envelope.meta.source` canonicalised to absolute path.** The
  raw config string (`"./architecture.puml"`) used to sit next to
  an absolute `configPath` from c12, mixing conventions in a
  single envelope and breaking downstream tools that joined the
  two fields. Both now land absolute.
- **`source.path` / `source.writePath` resolve relative to the
  config file.** Running `npx aact check` from a subdirectory was
  hitting `ENOENT` because relative paths in `aact.config.ts`
  resolved against the process cwd instead of the directory of
  the config. Both fields now go through
  `resolve(dirname(configFile), …)` at envelope-assembly time.
- **`rule.helpUri` points at the rule's ADR**, not a dead README
  anchor. The synthesised `<readme>#<rule>` link was a soft 404
  for every built-in (the README has no per-rule headings).
  `helpUri` now points at the actual ADR blob URL
  (`https://github.com/Byndyusoft/aact/blob/main/ADRs/Anti-corruption%20Layer.md`,
  etc.); rules without an ADR omit `helpUri` entirely instead of
  emitting a dead link.
- **Tool errors no longer print twice.** The shared error renderer
  consumed `diagnostics[0]` for the `✗ <command>: <message>` line
  and then `renderDiagnostics` re-emitted the same primary
  diagnostic as `⚠ <kind>  <message>`. Skip the first entry on
  error envelopes; route the `✗` line to stderr (Unix convention)
  so pipe consumers (`aact check | jq`) still see failures even
  when stdout is captured.
- **Structurizr `linkedRelationshipId` edges dropped on load.**
  Structurizr JSON propagates each `Container → Container` edge
  up to its enclosing `System → System` pair as a derived
  relationship with `linkedRelationshipId` pointing back at the
  concrete edge. They are aggregate / view artefacts, not
  author-level model edges — loading them duplicated every
  container call as a phantom system-to-system arrow on the
  Model.
- **`structurizr.dsl.identifier` filtered from `Element.properties`.**
  The DSL compiler's internal marker is plumbing, not user data;
  it no longer leaks through into Model.properties to pollute
  diff / generate output with a key no one wrote.
- **pnpm 11 compatibility.**
  `package.json#pnpm.onlyBuiltDependencies` was silently ignored
  by pnpm 11 (the field moved). esbuild + unrs-resolver build
  approval now lives in `pnpm-workspace.yaml`'s `allowBuilds` map.
- **`aact generate` with empty output no longer trips on null
  `outputPath`.** When `outputSink === "none"` / `"stdout"`,
  `data.outputPath` is null; passing it through
  `formatDisplayPath` would crash on `.startsWith` without a
  guard.

### Tooling

- **Stryker scope expanded** to `src/diff/**`, `src/config.ts`,
  and the pure modules under `src/cli/output/` (envelope,
  sarifReporter, hyperlinks, resolveMode). Targeted test passes
  on the two below-threshold files lifted scores to:
  `resolveMode 100`, `envelope 89`, `hyperlinks 86`,
  `sarifReporter 80`, `computeDiff 71` (was 58), `config 100`
  (was 35).
- **`@fast-check/vitest` property test** for `renderCheckText`'s
  `mode` argument — sweeps mode × env combinations so a future
  refactor that quietly re-reads `process.env.GITHUB_ACTIONS`
  instead of the explicit arg fails on at least one combination.
- **CI fetches parser reference fixtures** before tests so the
  empirical roundtrip / corpus suites actually exercise the
  upstream samples instead of silently skipping.
- **CI verifies schema sync** via `pnpm schema:check`.
- **Lint thresholds tuned** for the file groups that already had
  legitimate density (`computeDiff` 50, `rules/*` 35,
  `cli/commands/rule` 25). Same justification pattern as the
  existing parser / validate / analyze overrides — splitting on
  the 20-branch ceiling would hide the algorithm.
- **Knip / ESLint / Prettier all clean** on the v3 branch — zero
  warnings, zero errors.

## v3.0.0-beta.16 — 2026-05-20

Agent-facing release. Three commands' worth of new surface for AI
coding agents and architecture reviewers, plus rule-anchor and
database-detection cleanup that was technically a regression
against the CHANGELOG of earlier betas. New `aact diff` for PR
review; new `aact rule explain` for in-context rule rationale;
new `model-json` source format for LLM-generated architectures
and stable snapshots. `Violation.relatedLocations` threads
supporting evidence through text / JSON / SARIF, per-rule
anchors point at the conceptually correct source (DB declaration
instead of a random accessor edge for `dbPerService`), and
`envelope.meta.configPath` now reports the c12-resolved config
file even without an explicit `--config` flag.

### Added

- **`model-json` source format.** A first-class registered Format —
  `aact.config.ts → source: { type: "model-json", path: "arch.aact.json" }`
  is now a valid config, `aact check` / `aact analyze` / `aact model` /
  `aact diff` all consume `.aact.json` through the same registry
  pathway as PlantUML and Structurizr. Capabilities: **load +
  generate, no fix** (JSON has no meaningful range semantics for
  C4 edits — for authoring use PUML/DSL; model-json is the
  LLM-input / snapshot / cross-tool exchange surface).

  **Canonical shape** on emit: `{ "schemaVersion": 1, "model": Model }`.
  The version header future-proofs the format independently of the
  Model TS type evolving post-GA. Loader accepts three shapes by
  structural detection (canonical → envelope → raw):
  - **Canonical** — `{ schemaVersion, model }`, from
    `aact generate --format model-json`.
  - **`CliEnvelope<ModelData>`** — from `aact model --json`, so
    `aact model --json > snap.aact.json && aact diff snap.aact.json`
    just works.
  - **Raw `Model`** — `{ elements, boundaries, rootBoundaryNames }`,
    hand-authored or LLM-emitted.

  **Determinism.** `generate` sorts element / boundary keys
  alphabetically before stringifying so two emits from the same
  Model are byte-identical — `aact diff` against a regenerated
  baseline shows phantom-move-free output.

  **Auto-detect** keys off `*.aact.json` (strict — collision-free
  with structurizr's `workspace.json` and PUML's `*.puml`).
  Non-canonical names like `my-arch.json` require explicit
  `source.type: "model-json"` in config or `--baseline-format
model-json` for `aact diff`. `diff/baseline.ts` no longer owns
  an inline JSON loader; it routes through `loadFormat("model-json")`
  like every other format.

- **`aact diff <baseline> [<current>]` command.** Structural diff
  between two C4 architecture models — designed for PR review:
  agents and humans see what changed _architecturally_, not what
  bytes shifted in the source file. Three input forms for each
  side: file path, git ref (`main:architecture.puml`), or `-`
  (stdin). `current` defaults to `aact.config.ts → source`. The
  `.aact.json` format accepts both the raw `Model` shape and the
  full `CliEnvelope<ModelData>` shape — `aact model --json >
snap.json && aact diff snap.json` works out of the box.

  Output across modes:
  - **Text**: glyph-coded change list (`+` add, `-` remove,
    `~` modify), grouped by entity. Cosmetic-only changes collapse
    into a single `+N cosmetic changes` summary so PR review
    output stays readable.
  - **`--json`**: `CliEnvelope<DiffData>` with `summary.headline`
    (one-line reasoning seed), `summary.bySeverity` (structural /
    semantic / cosmetic split), and `changes[]` sorted by
    severity → action precedence → address. Domain-grouped per
    entity (`element` / `boundary` / `relation` / `workspace`),
    with per-field deltas inside each change.
  - **`--with-patch`**: opt-in RFC 6902 patch array against the
    normalized Model JSON. For tooling that wants to replay the
    delta; off by default to keep the agent-facing payload lean.
  - **No `--sarif`** — diff is a review artifact, not a static
    analysis finding. SARIF would distort the `result.baselineState`
    semantics; agents and CI use `--json` instead.

  Rename detection: same-kind elements/boundaries with similarity
  ≥0.7 (label edit-distance + relations Jaccard) collapse into
  `action: "renamed"` with a `confidence` score so agents can
  gate on heuristic strength. Relation diff is rename-aware —
  edges touching renamed elements survive as matched
  (no spurious add+remove pair). Tunable via `--rename-threshold
<0..1>` and `--no-rename-detection`.

  Relation pair-collapse: same `(from, to)` removed+added with
  different `technology` surfaces as a single `modified` change
  with `field: "technology"` rather than noisy add+remove
  bookkeeping.

  Exit codes: `0` no diff (or cosmetic-only without `--strict`),
  `1` structural / semantic diff (or cosmetic with `--strict`),
  `2` tool error (baseline missing, parse failure).

- **`aact rule explain <name>` command + `rationale` / `examples` /
  `adrPath` on `RuleDefinition`.** `aact rule list` shows the
  one-line description of each rule; `explain` shows the full
  context — the architectural principle the rule enforces (in
  prose), a `good` / `bad` pair of source snippets, and a
  Cmd-clickable pointer to the ADR document when available.
  Threads through every output mode:
  - **Text**: framed sections — `Rationale`, `Examples` (✓/✗
    markers), `ADR`, `See also`.
  - **`--json`**: `RuleExplainData` envelope with optional
    `rationale`, `examples[]`, `adrPath`, `helpUri`.
  - Works on `customRules` too — your `defineRule({ ..., rationale,
examples })` content surfaces unchanged.

  All 8 built-ins are now populated. Agents reading
  `violations[].rule` can fetch the rule's full context with a
  single follow-up `aact rule explain --json` and reason about a
  fix with the architectural intent in hand, not just the
  one-liner.

- **`Violation.relatedLocations`** — rules can now attach secondary
  source anchors to a violation alongside the primary
  `sourceLocation`. The primary anchor is _where_ the violation
  lives; related locations are _the supporting evidence_. Threads
  through every output mode:
  - **Text**: indented `↳ <label>: <file>:<line>:<col>` rows under
    the primary anchor, each independently Cmd-clickable.
  - **`--json`**: `data.violations[].relatedLocations[]` —
    `{ sourceLocation, message? }[]`. Additive, no `schemaVersion`
    bump (we're in beta — see AGENTS.md schemaVersion policy).
  - **`--sarif`**: maps to SARIF v2.1.0 `result.relatedLocations[]`
    (§3.27.22). GitHub Code Scanning surfaces these in the alert
    detail view's "Related locations" panel.

  Each built-in rule now populates relevant context:
  - `crud` — the DB element(s) this container directly accesses
  - `acl` — the external system(s) being called
  - `apiGateway` — the external system on the other side
  - `stableDependencies` — the less-stable dependency target
  - `dbPerService` — every accessor edge of the shared DB
  - `acyclic` — every outgoing relation of the cycle participant

### Fixed

- **`dbPerService` primary anchor now points at the DB declaration**,
  not at whichever accessor edge happened to register first. The
  conceptual location of "this DB has too many owners" is the DB
  itself; the accessor edges are now surfaced via
  `relatedLocations`. Two different rules firing on the same line
  (because the historical anchor heuristic happened to pick the
  same edge) is no longer the default UX.

- **`Databases` count now includes `ComponentDb`** in addition to
  `ContainerDb` — both at the `analyze` summary level and inside
  the `dbPerService` / `crud` rules' database detection. The
  earlier hardcoded `kind === "ContainerDb"` check silently dropped
  component-level data stores.

- **`envelope.meta.configPath` now reflects the resolved config
  file path even without an explicit `--config` flag.** Beta.15
  returned `null` whenever c12 discovered `aact.config.ts`
  automatically in cwd / parents — the path was loaded but
  discarded before it reached the envelope. Now the resolved
  absolute path surfaces in every `--json` envelope so agents
  see _where_ the config came from.

## v3.0.0-beta.15 — 2026-05-19

Two themes: source-location hyperlinks now actually navigate in
every modern terminal (Ghostty / iTerm2 / WezTerm / Kitty were
silently broken in beta.14), and `aact analyze` gets a full
redesign — drops the useless hardcoded sync/async counter for
structural metrics that work on any DSL / PUML out of the box.

### Changed

- **`aact analyze` redesigned around structural metrics that work
  on any DSL / PUML out of the box.** The previous output mixed an
  unconfigurable `Sync API calls` / `Async API calls` pair driven
  by a hardcoded `["http","grpc","tcp"]` list with no escape hatch
  — in real PUML where `technology` is often empty, both numbers
  were `0`. The new shape:
  - **`elementsByKind`** — per-`ElementKind` count.
  - **`relationsByStyle`** — global `{ sync, async, unspecified }`
    breakdown. Classified by relation tags first (`async` / `sync`
    — primary signal, portable across DSLs; Structurizr DSL emits
    `async` automatically from `interactionStyle: "Asynchronous"`),
    with an opt-in technology fallback when configured.
  - **`boundaries[].syncCoupling` / `.asyncCoupling` /
    `.unspecifiedCoupling`** — per-boundary fragility split. Total
    matches existing `.coupling`. Sync-heavy coupling out of a
    boundary surfaces latency-cascade risk.
  - **`boundaries[].ratio`** — `cohesion / (cohesion + coupling)`;
    `null` when both are zero.
  - **`fanIn` / `fanOut`** — top-N elements by afferent / efferent
    coupling (default `topN = 5`). Respects an `exclude` filter
    (tags + glob) to drop infrastructure noise from the ranking
    without distorting other elements' counts.
  - **`cycles`** — `{ count, smallest }` from Tarjan SCC; self-loops
    are excluded (those are surfaced by `validateModel` as
    `self-relation` ModelIssues).
- **`AactConfig.analyze`** — new config section:
  ```ts
  analyze: {
    syncTechnologies?: string[];   // case-insensitive substring fallback
    asyncTechnologies?: string[];
    exclude?: { tags?: string[]; namePatterns?: string[] };  // hotspot noise filter
    topN?: number;                 // default 5
  }
  ```
  Defaults to empty — pure tag-driven classification with no
  exclude filter. Plumbed through to the library `analyzeArchitecture`
  for direct consumers.

### Fixed

- **`Databases` count now includes `ComponentDb` elements**, not just
  `ContainerDb`. The earlier hardcoded `kind === "ContainerDb"` check
  silently dropped component-level data stores from the metric.

### Removed (breaking on `AnalysisReport` / `AnalyzeOptions`)

- `AnalysisReport.syncApiCalls` / `asyncApiCalls` — replaced by
  `relationsByStyle` (global) and `boundaries[].syncCoupling` etc.
  (per-boundary, only on coupling edges where fragility matters).
- `AnalyzeOptions.apiTechnologies` — replaced by the
  `syncTechnologies` / `asyncTechnologies` pair with explicit
  semantics. Library users migrating: rename
  `{ apiTechnologies: [...] }` to `{ syncTechnologies: [...] }` and
  add `asyncTechnologies` if you want symmetric classification.

### Fixed

- **Source-location hyperlinks now navigate to line/column in every
  modern terminal.** Beta.14 emitted OSC 8 with a
  `file://abs:line:col` URL that only VSCode integrated terminal's
  private parser handled — under Ghostty, iTerm2, WezTerm, Kitty,
  Cursor's external terminal, and similar hosts the OS handler
  treated `:23:1` as part of the filename and the click silently
  did nothing. The hyperlink emitter now picks a URL scheme
  per-terminal, mirroring OpenAI Codex's `file_opener` vocabulary:
  - `TERM_PROGRAM=vscode` or `CURSOR_TRACE_ID` set →
    `file://abs:line:col` (VSCode/Cursor internal parser jumps)
  - `TERM_PROGRAM=zed` → plain text (Zed's built-in path
    autodetect drives the click; external URL would bypass Zed's
    "open in this window" flow)
  - everything else → `<scheme>://file/abs:line:col` where
    `<scheme>` defaults to `vscode` and is overridable via the
    `AACT_FILE_OPENER` env var (`vscode` / `vscode-insiders` /
    `cursor` / `windsurf` / `zed` / `none`).

  The visible display text remains plain `<file>:<line>:<col>`
  so terminals with Smart Selection / built-in path autodetection
  still pick it up when OSC 8 isn't supported (CI, piped output).

## v3.0.0-beta.14 — 2026-05-19

Agent-facing surface. `aact check --json` now ships the rule
catalogue inline (no separate `aact rule list` call needed), the
new `aact model` command exposes the normalized graph for agents
that reason about architecture without re-parsing PUML / DSL
themselves, and the library API barrel grows to cover the envelope
contract so consumers parsing `aact <command> --json` have
first-class types for every shape they read. AGENTS.md +
copilot-instructions symlink + English README mirror put the agent
quickstart and the machine-readable output contract on top of every
AI-onboarding surface (Claude Code, Copilot Coding Agent,
Cursor, Codex).

### Added

- **`CheckData.rules`** — every `aact check --json` envelope now
  includes a `rules: CheckRuleMetadata[]` catalogue listing every
  effective rule (built-in + custom) with `name`, `description`,
  `source` (`"built-in"` or `"custom"`), `enabled` flag, `hasFix`,
  and a `helpUri` anchor for built-ins. Agents reasoning about a
  `violations[].rule` no longer need a second `aact rule list`
  round-trip to look up what that rule does.

- **`aact model` command.** Inspects the normalized model used by
  the rule engine. `--json` emits a `ModelData` envelope
  (`{ model, issues }`) with the full graph for agent consumption;
  `--sarif` surfaces loader-level problems (dangling refs,
  duplicate ids, unknown kinds) as SARIF results under the
  `model.*` namespace so they can be reviewed in GitHub Code
  Scanning alongside rule violations. Text mode prints a summary
  with workspace metadata, element counts by kind, the boundary
  tree, and the relation count.

- **Library API barrel.** `src/index.ts` re-exports the full
  CLI-envelope contract (`CliEnvelope`, `Diagnostic`,
  `DiagnosticKind`, `ExitCode`, `OutputMode`, `EnvelopeMeta`,
  `Renderer`, `Reporter`, `CommandResult`) and the per-command
  data shapes (`CheckData`, `CheckRuleMetadata`, `CheckViolation`,
  `CheckSummary`, `CheckFixesApplied`, `CheckMode`, `ModelData`,
  `RuleListData`, `RuleInfo`, `RuleListSummary`, `GenerateData`,
  `GeneratedFileInfo`, `GenerateOutputSink`, `InitData`,
  `InitCreated`, `InitSkipped`, `InitFileKind`, `SkillData`,
  `SkillPlanResult`, `SkillAction`, `InstallPlan`), plus the
  complete SARIF v2.1.0 surface (`SarifLog`, `SarifResult`,
  `SarifAdapter`, …). Library users writing custom reporters or
  agents parsing `--json` output now have first-class types for
  every shape `aact` emits.

- **`AGENTS.md`** — top-level guide for AI coding agents:
  installing the `aact-architect` skill across Claude / Cline /
  shared agent-skill paths, the `--json` envelope contract for
  every command, the `--sarif` path into GitHub Code Scanning,
  and the stable `0 / 1 / 2` exit-code semantics agents must
  branch on. `CLAUDE.md` is a symlink to `AGENTS.md` so Claude
  Code picks up the same file until native AGENTS.md support
  lands upstream; `.github/copilot-instructions.md` is the same
  symlink for GitHub Copilot Coding Agent.

- **English README (`README.en.md`)** mirrors the Russian
  `README.md` with a flag-emoji language switcher at the top of
  both files. Russian-only resources (YouTube / Habr / Telegram)
  remain in the English version with a `(Russian)` tag.

- **"AI agents" quickstart section** in both READMEs surfaces
  the agent-skill installer and the JSON / SARIF output paths
  that were previously only documented inside `AGENTS.md`.

### Changed

- **`CheckRuleMetadata.source` is `"built-in" | "custom"`**, aligned
  with the existing `RuleInfo.source` enum that `aact rule list`
  has shipped. Two-spelling drift caught before publishing.

## v3.0.0-beta.13 — 2026-05-19

GH Code Scanning polish. The SARIF output that landed in beta.12
was correct for the happy path but had three production
inconveniences caught against real `code-scanning/upload-sarif`
runs: `aact check --sarif` crashed on config-load failures,
absolute paths didn't attach to PR diffs, and fingerprints used
a non-conventional key. All three are closed. The eight built-in
rules also gain symmetric options types so `rules: { acyclic: {} }`
type-checks and runtime-validates the same way as
`rules: { acl: { tag: "..." } }`.

### Fixed

- **`aact check --sarif` no longer crashes on tool errors.** Running
  `check --config missing.ts --sarif` (or any path where the wrapper
  builds a `data: null` error envelope) used to throw
  `TypeError: Cannot read properties of null (reading 'violations')`
  because `checkSarifAdapter` dereferenced data before the
  envelope's exit code was checked. The reporter now short-circuits
  for `exitCode === 2 || data === null` and emits the SARIF
  spec-canonical shape: `runs[].invocations[]` with
  `executionSuccessful: false` and every diagnostic as
  `toolExecutionNotifications[]`.
- **`artifactLocation.uri` is now repo-relative + resolves correctly
  under macOS `/tmp` symlink.** Absolute paths like
  `/Users/dev/proj/architecture.puml` failed to attach to PR diffs
  in GitHub Code Scanning, which matches against repo-relative
  paths. The adapter now resolves the repo root via
  `git rev-parse --show-toplevel` (fall back to `cwd` outside a
  git checkout), canonicalises both base and file through
  `realpathSync` so the macOS symlink stops breaking relativization
  silently, and tags relative URIs with
  `uriBaseId: "SRCROOT"`. The base itself ships as
  `originalUriBaseIds.SRCROOT = file://<repo-root>/` built through
  `pathToFileURL` (handles spaces, non-ASCII, Windows drive
  letters).
- **`partialFingerprints` now ships under
  `primaryLocationLineHash`** — the conventional key GitHub Code
  Scanning uses for cross-run alert continuity (ESLint SARIF
  formatter, Semgrep, etc. all agree on it). The namespaced
  `aactViolationHash` carries the same value for multi-tool
  workflows that want to filter aact alerts specifically.

### Added

- **`AcyclicOptions` / `CohesionOptions` / `CommonReuseOptions` /
  `StableDependenciesOptions`** exported from `aact`. The four
  option-less built-ins now ship `Record<string, never>` aliases
  so the eight built-ins are symmetric at the type level. Strict-
  empty rejects unknown keys (`rules: { acyclic: { foo: 1 } }`
  fails compile + runtime validation today); when any rule gains
  real options the type widens to a non-empty interface and lands
  in a documented breaking change.
- **`BuiltinRulesConfig`** entries for those four rules accept
  `boolean | XOptions` instead of `boolean` only. `rules:
{ acyclic: {} }` now compiles AND passes runtime validation —
  config shape is symmetric with the option-bearing rules.

## v3.0.0-beta.12 — 2026-05-19

Output mode for GitHub Code Scanning. `aact check --sarif` emits a
standard SARIF v2.1.0 log that drops straight into
`github/codeql-action/upload-sarif@v3`, surfacing every violation as
a native PR code-scanning alert with rule metadata, source region,
and stable fingerprints for cross-run alert continuity. The same
`SourceLocation` ranges the chevrotain parsers populate (used by
range-based `--fix` and OSC8 hyperlinks) now drive
rustc-style underlines in SARIF consumers like `sarif-fmt`.

### Added

- **SARIF v2.1.0 output** for `aact check`. Pass `--sarif` (or set
  `output.mode: "sarif"` in `aact.config.ts`) to emit the
  industry-standard static-analysis log on stdout. Drops straight
  into `github/codeql-action/upload-sarif@v3` and surfaces aact
  violations as native PR code-scanning alerts — no handcrafted
  workflow-annotation scripts needed.

  The emitted log includes the full rule catalogue under
  `tool.driver.rules[]` (id, name, description, helpUri), every
  violation as a `result` with `ruleId` / `level` / `message` /
  `locations[].physicalLocation.{artifactLocation,region}`, plus
  stable `partialFingerprints` so GitHub keeps alerts continuous
  across edits that shift line numbers.

  `--sarif` outranks `--json` if both are supplied; commands
  without a SARIF-specific adapter (init, skill, analyze, generate)
  still produce a valid empty log so `--sarif` never crashes.

- `SarifAdapter<TData>`, `SarifReporter`, and the SARIF v2.1.0
  type surface (`SarifLog`, `SarifRun`, `SarifResult`, …) are
  exported from `aact` for library consumers building their own
  output paths or extending the SARIF emit with custom properties.

## v3.0.0-beta.11 — 2026-05-19

API ergonomics + terminology cleanup. Two changes that custom rule
authors care about: the field `Violation.element` no longer pretends
boundary-level rules emit element names, and a handful of types
that were already defined internally now actually re-export through
the library barrel. Plus a wide doc sweep replacing leftover "byte
range / byte offset" prose with the honest UTF-16 code-unit framing.

### Changed (breaking — rule API)

- `Violation.element` renamed to `Violation.target` and gains a
  required `targetKind: "element" | "boundary"` discriminator. Most
  rules fire on elements (acl, crud, acyclic, stableDependencies,
  apiGateway, dbPerService) and emit `targetKind: "element"`; the
  two boundary-level rules (cohesion, commonReuse) emit
  `targetKind: "boundary"`. The old `element: string` field lied
  for boundary-level rules — agents and LSP consumers that did
  `model.elements[v.element]` lookup got `undefined` on cohesion /
  commonReuse violations. The discriminator removes the guess.
- `CheckViolation` JSON envelope field follows: the old
  `data.violations[].element` is replaced by `.target` and
  `.targetKind`.
- Custom rules: rename the `element` field in returned violations to
  `target` and add `targetKind: "element"` (or `"boundary"` for
  boundary-level rules). TypeScript surfaces every call site at
  compile time; no runtime fallback shipped.

### Added — public exports

These types were defined internally but never re-exported from the
library barrel, so users couldn't declare variables / function
signatures with them through `import { … } from "aact"`:

- `editLocation` helper from `rules/lib/applyEdits` — for custom
  applier callers that need the source range of an edit without
  re-matching the discriminant.
- `ApplyEditsResult` / `EditConflict` — the return shape and
  conflict entry of `applyEdits`.
- `RelationDeclOptions` — opts arg type of `FormatSyntax.relationDecl`.
- `LoadableFormat` / `GeneratableFormat` / `FixableFormat` —
  the narrowed `Format` types produced by the `canLoad` /
  `canGenerate` / `canFix` type guards.

## v3.0.0-beta.10 — 2026-05-19

Range-based `--fix` engine replaces the string-matching applier. Every
fix edit now anchors on a real `SourceLocation` source range
(UTF-16 code-unit offsets — see `SourcePosition.offset`; chevrotain
parsers populate them on every Element / Boundary / Relation), so the
applier is a pure string splicer — no more `[warn] ambiguous pattern`
fallbacks, no guessing which of two same-looking lines the rule meant.
Overlapping edits between rules are detected and surfaced as
`fix.editConflict` diagnostics instead of silently dropped.

### Changed (breaking — fix API)

- `SourceEdit` is a discriminated union by `kind`:
  - `{ kind: "replace"; range: SourceLocation; content: string }`
  - `{ kind: "remove"; range: SourceLocation }`
  - `{ kind: "insert-after"; anchor: SourceLocation; content: string }`
  - `{ kind: "insert-before"; anchor: SourceLocation; content: string }`

  The old `{ type, search, content }` shape is gone. Custom rule
  authors anchor edits on the node's `sourceLocation` directly —
  `model.elements[name].sourceLocation`, `rel.sourceLocation`, etc.

- `RuleDefinition.fix` now takes a single `FixContext<O>` argument:
  ```ts
  fix?(ctx: { model, violations, syntax, options }): readonly FixResult[]
  ```
  Bag-of-args so future additions (raw source string, multi-file map)
  land as additive optional fields without changing the call shape.
- `FormatSyntax` (renamed from `SourceSyntax`) is reduced to two
  content-builders: `containerDecl` and `relationDecl`. The
  `containerPattern` / `relationPattern` regex builders are gone —
  range-based edits don't need them.
- `relationDecl` signature changed from positional
  `(from, to, tech?, tags?)` to `(from, to, opts?: RelationDeclOptions)`
  where `opts = { description?, technology?, tags? }`. The old shape
  conflated `description` (PUML positional 3 = label) with
  `technology` (positional 4 = techn) — every rule fix that passed
  `rel.technology` was actually overwriting the label slot. Now both
  fields land in the correct PUML / Structurizr DSL positions and
  survive a rewire intact.
- `applyEdits(source, edits)` returns a structured result
  `{ content, applied, conflicts }`. Pure function, no `consola.warn`
  side effects — the CLI surfaces conflicts as diagnostics instead.

### Documentation

- `SourcePosition.offset` JSDoc now states explicitly that the value
  is a 0-based **UTF-16 code unit** index — matching JS string
  semantics, chevrotain's `token.startOffset` / `endOffset`, and
  LSP's default `positionEncoding: "utf-16"`. The previous wording
  said "byte offset" which was wrong: applying `String.prototype.slice`
  to a byte offset would land mid-glyph on cyrillic / emoji / CJK
  content. Producer and consumer always agreed on the unit; only the
  docstring lied. Regression tests pin the invariant through both
  `applyEdits` directly and the full `crud --fix` rewrite path on a
  PUML source containing non-ASCII labels.

### Added

- `fix.editConflict` diagnostic kind. Emitted when two fix edits want
  to touch overlapping source ranges. The applier keeps the first one
  (deterministic, input order), reports the rest with `kept` /
  `skipped` / `keptAt` / `skippedAt` context. Re-running `--fix`
  after a conflict picks up the dropped edit if it's still applicable.
- `editLocation(edit): SourceLocation` helper in `rules/lib/applyEdits`
  for callers (CLI, diagnostics, future LSP) that need to display
  edit positions without re-matching the discriminant.
- `RelationSpec.sourceLocation` / `ElementSpec.sourceLocation` in
  `test/helpers/makeModel` — lets rule tests synthesize models that
  the range-based fix engine can operate on without a parser pass.

### Migration

Custom rule with a `fix`:

```ts
// Before (beta.9)
fix(model, violations, syntax, options) {
  return violations.map((v) => ({
    rule: "myRule",
    description: "...",
    edits: [
      { type: "replace", search: syntax.relationPattern(v.element, "x"),
        content: syntax.relationDecl(v.element, "y") },
    ],
  }));
}

// After (beta.10)
fix({ model, violations, syntax }) {
  return violations.flatMap((v) => {
    const rel = model.elements[v.element]?.relations.find((r) => r.to === "x");
    if (!rel?.sourceLocation) return [];
    return [{
      rule: "myRule",
      description: "...",
      edits: [
        { kind: "replace", range: rel.sourceLocation,
          content: syntax.relationDecl(v.element, "y") },
      ],
    }];
  });
}
```

## v3.0.0-beta.9 — 2026-05-19

C4 vocabulary alignment is the headline of this beta — the wrapper type
that aggregates every architectural node was named `Container` for
historical reasons, which collided with C4's own level-2 `Container`
concept. Renamed to `Element` everywhere it surfaces in the public API.
Custom rules and JSON envelope consumers have to update one field name
(`container` → `element`); the C4 `kind: "Container"` literal value is
unchanged.

### Added

- `aact init` now scaffolds a starter architecture that demonstrates
  name-pattern role detection out of the box: `orders_repo` ships
  without `$tags="repo"` but is auto-detected as a repository by the
  default `*_{repo,…}` picomatch glob. Two intentional violations
  (`crud` + `dbPerService`) clear in one `--fix` pass — closer to
  importing a legacy archive than the prior single-rule demo.
- All 8 built-in rules now anchor violations on the precise source
  range that broke the principle. `stableDependencies` and
  `commonReuse` were the last two falling back to the source element's
  location through the CLI helper; both now point directly at the
  offending edge. With this every text-mode lint line and every
  GitHub-annotation comment lands on the source position the rule flagged.

### Changed

- `docs/format-coverage.md` refreshed to the post-beta.7 reality:
  `sourceLocation` is documented as fully populated by chevrotain
  loaders, the `Relation.order` and `Boundary.description` PUML gaps
  are gone (covered since the chevrotain cutover), and the
  "plantuml-parser 0.4 limit" framing was removed — the dep was
  excised in commit `642ff23`.
- `BoundaryKind` JSDoc clarifies that `Component_Boundary` does not
  exist in C4-PlantUML stdlib; the `"Component"` kind is preserved
  for model-level fidelity but `aact generate` for PUML falls back
  to `Container_Boundary` (the canonical way to group components per
  the stdlib).
- `WorkspaceMetadata` JSDoc trimmed to match the actual shape —
  earlier wording mentioned `version` and `properties` fields that
  never made it onto the type. Linting rules don't need them.

### Changed (breaking — v3 API)

- C4 vocabulary alignment: `Container` is no longer the umbrella term for
  every architectural node in the model. The model now uses `Element` as
  the level-agnostic abstraction (Person / System / Container /
  Component all live in `model.elements`), matching the C4 spec's own
  vocabulary. The `kind: "Container"` literal value is unchanged — it
  remains a valid C4 level-2 kind.
- Public type / helper / field renames:
  - `Container` → `Element`
  - `ContainerKind` → `ElementKind`
  - `Model.containers` → `Model.elements`
  - `allContainers()` → `allElements()`
  - `getContainer()` → `getElement()`
  - `Boundary.containerNames` → `Boundary.elementNames`
  - `Violation.container` → `Violation.element`
  - `CheckViolation.container` → `CheckViolation.element` (JSON envelope
    field `data.violations[].container` → `.element`)
  - `ModelBuildInput.containers` → `ModelBuildInput.elements`
  - `ModelIssue` field `container` → `element` on `self-relation`,
    `unknown-kind`, `element-in-boundary-not-in-model` variants
  - `ModelIssue.kind` values: `container-in-boundary-not-in-model` →
    `element-in-boundary-not-in-model`, `duplicate-container-name` →
    `duplicate-element-name`
  - `DiagnosticKind` values: `model.containerInBoundaryNotInModel` →
    `model.elementInBoundaryNotInModel`, `model.duplicateContainerName`
    → `model.duplicateElementName`
- Migration for custom rules: rename the `container` key in returned
  violations to `element`. Type errors surface every call site at compile
  time; no runtime fallback / alias is shipped.

## v3.0.0-beta.8 — 2026-05-19

Lint-style output with clickable violations and name-pattern role
detection. The `SourceLocation` foundation from beta.7 now powers
OSC8 terminal hyperlinks and eslint-style `path:line:col error rule
message` output. Rules pick up implicit roles from container naming
conventions, so legacy archives and agent-generated diagrams converge
in a single `--fix` pass without spurious `_repo` duplicates.

### Added

- `aact check` text output rewritten in eslint style:
  `arch.dsl:13:1  error  crud  orders: directly accesses orders_db`.
  Auto-aligned columns; the location column is an OSC8 hyperlink in
  TTYs that support it (iTerm2, Ghostty, VSCode terminal, Windows
  Terminal, modern tmux). CI logs, piped output, and older
  terminals automatically fall back to plain text.
- `CheckViolation.sourceLocation?: SourceLocation` in the JSON
  envelope — `aact check --json` consumers (Claude Code / Codex
  CLI / dashboards) get the violation's source anchor. Falls back
  to the container's location when the rule doesn't anchor more
  precisely.
- `file=<path>,line=<L>,col=<C>` attributes on GitHub Actions
  error annotations — violations surface as inline PR comments
  anchored to the offending position instead of generic workflow-log
  entries.
- 5 built-in rules now anchor violations on the precise relation /
  boundary that broke the principle (acl, acyclic, crud,
  dbPerService, cohesion) — the remaining 3 fall back to the
  container's location through a shared helper.
- **Name-pattern role detection.** New options on 4 rules — picomatch
  globs with brace expansion (`*_{repo,repository,storage,dao,store}`,
  `*{Repository,Storage,DAO}`):
  - `acl.namePatterns`
  - `apiGateway.aclNamePatterns`
  - `crud.repoNamePatterns`
  - `dbPerService.ownerNamePatterns`

  Rules treat a container as repo / acl / owner even without an
  explicit tag when its name matches a pattern. `crud --fix` rewires
  through the existing name-matched repo and promotes its tag in one
  pass — no duplicate `_repo` container created for legacy archives.
  Closes a reported friction on importing an aact-naive codebase.

- `Violation.sourceLocation?: SourceLocation` on the rule API —
  custom rules can set it to anchor diagnostics on a specific
  relation / boundary / property. Legacy rules (just `container` +
  `message`) get fallback anchoring through the container
  automatically.
- `formatLocation(loc): string` exported from the library — pure-
  data `<file>:<line>:<col>` formatter for callers rendering text
  outside the terminal (Slack, PR descriptions, dashboards).

### Dependencies

- Added `terminal-link@^5.0.0` (Sindre Sorhus). Handles
  OSC8-capability detection across iTerm2, Ghostty, VSCode,
  Windows Terminal, tmux, and CI environments. ~5 KB total with
  transitive deps (`ansi-escapes` + `supports-hyperlinks` +
  `has-flag`).
- Added `picomatch@^4.0.0` (5M+ projects: Jest, Vitest, Astro,
  fast-glob, chokidar). Zero deps, blazing-fast glob matcher with
  brace-expansion support. Already a transitive dep via vitest, so
  promotion to direct is near-zero cost.

## v3.0.0-beta.7 — 2026-05-19

Architecture-as-code parsers rewritten from scratch on chevrotain;
every third-party parsing dependency is dropped. `SourceLocation`
(file + line + UTF-16 code-unit offset) now lands on every `Container` /
`Boundary` / `Relation`, anchored to original-file positions through
whitespace-preserving pre-lex strip passes (each pass preserves
string length so chevrotain offsets line up with the input).

### Added

- **Structurizr DSL chevrotain parser** (`src/formats/structurizr/parser/`).
  Replaces the v2 regex-based DSL loader with a typed lexer →
  parser → CST → AST → Model pipeline. Covers the full Structurizr
  DSL surface: model body, element bodies, body statements
  (`description` / `technology` / `tags` / `url` / `properties` /
  `perspectives`), explicit relationships (`a -> b`), group
  nesting with separator, `!const` / `!var` substitution,
  archetypes, selectors, deployment family (parsed-then-info-issue),
  hard-removed constructs (`!ref` / `enterprise` → typed error with
  modern-replacement hint), workspace metadata (`name` /
  `description` / `extends`). Verified against reference fixtures
  (`big-bank-plc.dsl`, `getting-started.dsl`, `this.dsl`,
  `multi-line.dsl`).
- **C4-PlantUML chevrotain parser** (`src/formats/plantuml/parser/`).
  Replaces the `plantuml-parser` 0.4.0 third-party adapter end-to-
  end. Covers all C4 stdlib macros: element family (Person /
  System* / Container* / Component* + `_Ext` / `Db` / `Queue`
  variants), boundary family (Enterprise / System / Container +
  generic with `$type`), Rel family (12 variants including
  `Rel_Back_Neighbor`), RelIndex family (12 variants), BiRel family
  (10 variants), Lay\_* layout hints. Five pre-lex strip passes for
  preprocessor directives, opaque macros, deployment blocks,
  PlantUML native syntax, and multi-diagram trimming. 14 of 17
  reference fixtures from `.parser-refs/C4-PlantUML/samples/`
  load with zero parse errors; the 3 exclusions (sequence flavour
  and deprecated `$index-N` old format) are pinned in tests and
  documented in `grammar.md §8`.
- **`SourceLocation` on every `Container` / `Boundary` / `Relation`**.
  Foundation for terminal OSC8 file:line:col links, AST-aware fixes
  ("replace bytes 1024..1051" instead of regex search/replace), and
  precise CLI diagnostics. Preserved through both parsers' pre-lex
  strip passes by replacing stripped content with same-length
  whitespace so chevrotain offsets stay anchored to the user's
  original file.

### Removed

- `plantuml-parser` 0.4.0 dependency. The chevrotain parser
  obsoletes the entire `Enteee/plantuml-parser`-based adapter
  layer; `src/formats/plantuml/lib/filterElements.ts` and the
  marker-strip pre-transform hacks (`$tags=` → `__aact_tags__:`,
  etc.) are gone with it.

### Internal

- Both parser stacks share the same shape: `tokens.ts` → `preParse.ts`
  → `parser.ts` → `visitor.ts` → `toModel.ts` → `index.ts`. The
  Structurizr stack has its own `preParse` for substitutions, opaque
  blocks, deployment strip, inline directives, and hard-removed
  errors. The PUML stack has five whitespace-preserving passes
  covering preprocessor / native / opaque / deployment / arithmetic
  / multi-diagram normalisation. Both produce a typed `FileNode` /
  `WorkspaceNode` AST that `toModel` lowers to `Model`.
- Roundtrip identity (`parse → Model → generate → re-parse → Model`)
  verified against 12 PUML reference fixtures and the canonical
  Structurizr DSL corpus.

## v3.0.0-beta.6 — 2026-05-18

Unified CLI output layer. Every command now speaks the same versioned
JSON envelope (`schemaVersion: 1`) and follows a tight exit-code
contract. This is the v3 API break window — review the Breaking section
before upgrading from beta.5.

### Breaking

- **`--format` dropped from `check` and `analyze`.** `--format json` is
  replaced by `--json` everywhere; no deprecation period. `--format`
  remains valid on `generate`, where it still means "artefact target"
  (`plantuml`, `kubernetes`, ...) — never an output renderer.
- **Exit code 2 for tool errors.** Missing source files, schema-invalid
  config, unknown formats, and any non-domain failure exit `2`,
  distinct from exit `1` (architecture violations). CI scripts and
  agent loops can now branch on tool-failure vs domain-failure.
- **`aact check --dry-run` exits 1 when violations remain** (was `0`).
  CI gates that depended on the previous behaviour will start blocking
  PRs with unresolved violations — typically the intended outcome.
- **`aact check --fix` exits 1 when violations remain after applying
  fixes** (was `0`). Same rationale.
- **JSON output is now a versioned envelope.** Previously each command
  emitted an ad-hoc shape (`check` wrapped in `{ results }`, `analyze`
  returned the raw report, `rule list` returned a bare array).
  Consumers must update their parsers.

### Added

- `--json` flag on every command: `init`, `check`, `analyze`,
  `generate`, `rule list`, `skill`. In JSON mode stdout is reserved for
  the envelope; warnings and progress go to stderr.
- `--config` flag on `rule list` (previously missing — c12
  auto-discovery only). All config-aware commands now accept it
  uniformly.
- Stable `DiagnosticKind` enum surfaced in
  `envelope.diagnostics[].kind` (`model.duplicateContainerName`,
  `config.unknownRule`, `format.missingWritePath`,
  `config.outputCollidesWithJson`, etc.). Agents and CI scripts can
  branch on the kind without scraping prose. New kinds are additive;
  renames or removals require a `schemaVersion` bump.
- `config.output.mode: "text" | "json"` in `aact.config.ts` for a
  project-wide default output mode. CLI `--json` still wins
  per-invocation.
- `aact generate --output -` — UNIX `-` sentinel explicitly routes the
  artefact to stdout. Multi-file artefacts (e.g. `kubernetes`) reject
  `-` with `config.missingOutputPath`.

### Changed

- `aact rule list` no longer silently swallows config errors. A broken
  or schema-invalid config exits 2 with a typed diagnostic instead of
  falling back to built-ins. A missing config (no file in cwd) still
  falls back to built-ins-only — the legitimate discovery use case.
- `aact check` no longer prints inline "Suggested fixes" outside
  `--dry-run` text mode. Agents read `data.suggestedFixes[]` from the
  JSON envelope; humans see the preview only when they ask via
  `--dry-run`.
- `aact generate --json --output <file>` writes the artefact to disk
  and emits the envelope on stdout. `aact generate --json` without
  `--output` exits 2 — the artefact and the envelope cannot both own
  stdout.
- GitHub Actions annotations still auto-enable on `aact check` when
  `GITHUB_ACTIONS=true` is set; the explicit `--format=github` flag is
  gone alongside `--format=json`.

### Internal

- New `src/cli/output/` module owns every `stdout`/`stderr` write.
  Commands return a typed `ExecuteResult<TData>`; the wrapper
  (`cliCommand` / `cliCommandWithConfig`) picks `JsonReporter` or
  `HumanReporter` and exits with `envelope.exitCode`. The only
  remaining command-side `process.stdout.write` lives in `generate.ts`
  for explicit `--output -` artefact streaming.

### Migration

```bash
# Before
aact check --format json | jq '.results[]'
aact analyze --format json

# After
aact check --json | jq '.data.violations[]'
aact analyze --json | jq '.data'
```

Exit-code matrix for CI / agents:

```bash
aact check --json > report.json
case $? in
  0) ;;                                # clean
  1) echo "Violations remain" ;;       # domain failure
  2) echo "aact tool error" ;;         # config / source / format
esac
```

## v3.0.0-beta.5 — 2026-05-17

Agent skill installer. No library API changes; safe upgrade.

### Added

- `aact skill` / `aact skill install` command for installing the community
  `aact-architect` skill from
  `https://github.com/ChS23/aact-architect-skill.git`.
- Client targets for shared Agent Skills (`~/.agents/skills`), Claude Code
  (`~/.claude/skills`) and Cline (`~/.cline/skills`). Codex, Cursor and
  GitHub Copilot resolve to the shared target.
- `--target`, `--repo`, `--ref`, `--force`, `--dry-run`, `--client` and
  per-client flags for controlled installation/update flows.

## v3.0.0-beta.4 — 2026-05-14

PlantUML loader robustness. No API changes; safe upgrade.

### Fixed

- `Component_Boundary` no longer crashes the PlantUML loader. The
  underlying `plantuml-parser` 0.4 grammar lacks this token; the loader
  now rewrites it to `Container_Boundary` before parsing and restores
  `kind: "Component"` from the captured aliases.
- `$index=` on a `Rel` no longer drops the entire relation. The named
  argument previously made `plantuml-parser` discard the relation
  silently; it is now extracted and populates `Relation.order` (both
  `$index=1` and `$index="1"` forms; non-numeric values degrade to
  `undefined`).

## v3.0.0-beta.3 — 2026-05-13

Docs / template polish on top of beta.2. No API changes; safe upgrade.

### Changed

- `aact init` template now includes a commented `customRules` block
  showing how to switch from the type-only import to `defineConfig` for
  project-specific rules. Type-only import remains the default so
  `npx aact@beta init` still works without a local install.

### Docs

- `examples/custom-rules/` reworked around two realistic rules:
  `bcIsolation` (DDD bounded-context isolation) and `requireOwnerTag`
  (operational ownership). README walks through anatomy, registration,
  and when to write a custom rule.

## v3.0.0-beta.2 — 2026-05-13

### Added

- `customRules: RuleDefinition[]` config field for project-specific rules.
  Auto-enabled; disable via `rules: { name: false }`; pass options via
  `rules: { name: { ... } }` — identical syntax to built-ins.
- `defineRule()` helper preserves the rule's literal `name` for
  TypeScript inference.
- `aact rule list` command. Shows the effective rule set with source
  labels (built-in / custom) and enabled state. Add `--json` for tooling.
- `examples/custom-rules/` — end-to-end example with two custom rules.

### Changed

- `defineConfig` is generic over its `customRules`. TypeScript now
  autocompletes custom rule names and option shapes in `rules{}`, the
  same as built-in rules.
- `config.rules` accepts unknown keys; typos surface as a runtime warning
  instead of a parse error.
- `RuleDefinition.check` / `.fix` are declared as methods so typed rules
  fit `RuleDefinition[]` arrays without casts.

### Conflict policy

A custom rule whose `name` matches a built-in or another custom rule is
rejected at startup. Prefix rule names per project (for example,
`acmeBffBoundary`) to keep them unique.

### Migration from beta.1

None. `customRules` is additive.

## v3.0.0-beta.1 — 2026-05-12

First v3 beta. Use for evaluation before the stable cut.

### Breaking

| v2                                               | v3                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `ArchitectureModel`                              | `Model`                                                                           |
| `model.allContainers`                            | `Object.values(model.containers)` or `import { allContainers } from "aact"`       |
| `model.allContainers.find(c => c.name === x)`    | `model.containers[x]` or `getContainer(model, x)`                                 |
| `model.allContainers.some(c => c.name === x)`    | `x in model.containers`                                                           |
| `container.type === "ContainerDb"`               | `container.kind === "ContainerDb"`                                                |
| `container.type === "System_Ext"`                | `container.external === true && container.kind === "System"`                      |
| `relation.to.name`                               | `relation.to` (it is the name now)                                                |
| `relation.to.kind`                               | `model.containers[relation.to]?.kind` or `targetOf(model, relation)?.kind`        |
| `boundary.containers`                            | `boundary.containerNames.map(n => model.containers[n]!)`                          |
| `boundary.boundaries`                            | `boundary.boundaryNames.map(n => model.boundaries[n]!)`                           |
| `boundary.type`                                  | `boundary.kind` (typed: `"System" \| "Container" \| "Component" \| "Enterprise"`) |
| `checkAcl(containers, options)`                  | `aclRule.check(model, options)`                                                   |
| `fixAcl(model, violations, syntax, options)`     | `aclRule.fix(model, violations, syntax, options)`                                 |
| `loadPlantumlElements(path)` + mapper            | `plantumlFormat.load(path)` returns `{ model, issues }`                           |
| `loadStructurizrElements(path)`                  | `structurizrFormat.load(path)`                                                    |
| `generatePlantumlFromModel(model)`               | `plantumlFormat.generate(model)`                                                  |
| `generateKubernetes(model)`                      | `kubernetesFormat.generate(model)`                                                |
| `EXTERNAL_SYSTEM_TYPE`, `CONTAINER_DB_TYPE`, ... | literal strings (`"System"`, `"ContainerDb"`)                                     |
| `import ... from "aact/loaders/..."`             | `import ... from "aact/formats/..."`                                              |
| `import ... from "aact/generators/..."`          | `import ... from "aact/formats/..."`                                              |

### Added

- `ContainerKind` typed union (full C4 stdlib: `Person`, `System`,
  `Container`, `ContainerDb`, `ContainerQueue`, `Component`, `ComponentDb`,
  `ComponentQueue`).
- `BoundaryKind` typed union (`System`, `Container`, `Component`,
  `Enterprise`).
- `external: boolean` orthogonal to `kind`. Replaces the `_Ext` kind
  variants from PlantUML and Mermaid.
- `validateModel(model)` returns `ModelIssue[]` for dangling references,
  duplicate names, boundary cycles, self-relations, and unknown kinds.
- `Container.technology`, `Container.sprite` (separated from tags),
  `Container.link`, `Container.properties`, `Relation.link`,
  `Relation.description`, `Relation.order`, `Boundary.link` — all
  preserved on round-trip.
- `Format` capability interface with `canLoad` / `canGenerate` / `canFix`
  type guards. Adding a format is a single folder under
  `src/formats/<name>/`.

### Changed

- One file per rule under `src/rules/<name>.ts` containing the full
  `RuleDefinition` object.
- `src/loaders/` and `src/generators/` collapsed into `src/formats/<name>/`.

### Removed

- The v1 YAML→PUML migrator (`src/generators/plantuml.ts`).
- `containerTypes.ts` constants, replaced by typed unions.
- Stringly-typed rule options (`externalType`, `dbType`); detection flows
  from typed `kind` / `external` fields.
- `enrichTagsFromNames` heuristic in the Structurizr loader.

### Known limitations

**Structurizr.** Component-level elements are not loaded yet. System-level
relations between internal `SoftwareSystem`s are dropped (internal systems
map to a `Boundary`, which has no outgoing relations). Dynamic-view step
ordering is not extracted.

**PlantUML (`plantuml-parser` 0.4).** Properties (`SetPropertyHeader` /
`AddProperty`), `Boundary` description, `$index=` for dynamic diagrams,
and `Component_Boundary` are not exposed by the parser. File:line source
locations are not populated yet.

**Kubernetes.** Generate-only; reverse-engineering from YAML is deferred
to a later v3.x.

## v2.1.5 — 2026-05-07

### Fixed

- `cohesion` rule: custom option values were ignored for inner
  boundaries; the rule now applies the configured external / internal
  types at every call site.
- `kubernetes` generator: `System` and `Component` elements leaked into
  the output. Switched to a whitelist — only `Container`-typed elements
  produce deployment YAML.
- `plantuml` generator: `System` and `Component` containers were
  re-rendered as `Container`, losing their C4 level. Both kinds are now
  emitted with the matching macro.

## v2.1.4 — 2026-05-07

### Changed

- README rewritten with a two-modes intro (CLI vs library).

### Fixed

- The fix preview in `aact check --fix` is labelled and aligned.

## v2.1.3 — 2026-05-07

### Added

- `aact init` scaffolds a runnable starter project (config plus
  `architecture.puml`).

### Changed

- Quick Start section in the README rewritten to match what `aact init`
  produces.

### Fixed

- Friendly error messages when the source file is missing or malformed,
  instead of raw Node stack traces.
- `aact --help` reads the version from `package.json` and stays in sync.
- Codex-review findings in the `crud` rule and `kubernetes` generator.

## v2.1.2 — 2026-03-31

### Fixed

- Added a default-export fallback in `package.json` so library consumers
  on legacy resolvers can still `import` from `aact`.

## v2.1.1 — 2026-03-21

### Fixed

- Added `jiti` as a runtime dependency so that loading `aact.config.ts`
  works without an additional install step.

## v2.1.0 — 2026-03-21

### Added

- `commonReuse` rule with its ADR.
- `apiGateway` rule.
- `stableDependencies` rule.
- Auto-fix for the `crud` rule.
- Naming-convention auto-detection for fix-generated identifiers
  (snake_case / camelCase / PascalCase) — fixes blend in with the rest
  of the project.
- Structurizr DSL output and a write-target workflow via
  `source.writePath` for `aact check --fix` against Structurizr inputs.
- `--config` flag on `check`, `analyze`, and `generate`.
- `ecommerce-structurizr` example.
- `aclSuffix` option on the `acl` rule.

### Changed

- Hardcoded type strings replaced by named constants throughout the
  loaders, rules, and generators.
- Boundary-aware redirect logic extracted into a shared helper used by
  the `dbPerService` fix.
- `O(1)` rule lookup in `generateFixes`; parallel writes for Kubernetes
  output; `Set`-based replacement for previously `O(n²)` patterns in hot
  paths.

### Fixed

- Source indentation is preserved when applying fix edits.
- Structurizr loader naming bug for nested elements.
- Cleaner CLI output (summary lines, fix preview layout).

## v2.0.2 — 2026-02-14

### Fixed

- CLI shebang line and npm keywords. Required for `npx aact` to resolve
  the bin correctly and for discoverability on the npm registry.

## v2.0.1 — 2026-02-14

### Fixed

- Re-publish shortly after v2.0.0 to correct an issue spotted in the
  freshly-published tarball.

## v2.0.0 — 2026-02-14

First v2 release. Full rewrite from the v1 hand-rolled checks.

### Added

- CLI with `check`, `generate`, and `init` commands.
- Built-in rules: `acl`, `acyclic`, `crud`, `dbPerService`, `cohesion`.
- Auto-fix for `acl` and `dbPerService` rules with a `SourceSyntax`
  adapter for PlantUML.
- Code generators for PlantUML and Kubernetes manifests.
- Structurizr DSL loader.
- Architecture metrics (`aact analyze`) over boundaries (cohesion,
  coupling, instability, nested attribution).
- Config validation via `valibot` (`aact.config.ts`).
- Rule registry as the extension point for built-ins.

### Changed

- TypeScript- and ESM-first rewrite with modernised tooling.
- Project layout restructured to match the target ADR layout (`loaders/`,
  `generators/`, `rules/`, `cli/`).

## v1.0.0 — 2026-02-07

Initial publish. Hand-rolled boundary checks for a single example
PlantUML project, no CLI, no config schema. Superseded by the v2
rewrite.
