# Architecture workbench (`aact view`)

## Status

Proposed. Targeted for v3.x — **not** v3.0.0 GA. Lives on the
`proposal/aact-view` branch until a concrete MVP lands.

## Context

Architects who keep their model in `architecture.puml` or
`workspace.dsl` have no zero-setup way to **see** what they wrote
locally:

- PlantUML needs a Java runtime + the `plantuml.jar` renderer
  (or an HTTP renderer service) before the source becomes a
  picture.
- Structurizr DSL needs Structurizr Lite (a Docker container or a
  separate Java app) to be reachable from the browser at all.
- Generated SVGs / PNGs go stale the moment the source file
  changes; refreshing them is an out-of-band step every time.

So in practice the loop is:

1. Edit `.puml` / `.dsl` in the editor.
2. Switch to a terminal, run a renderer.
3. Find the output, switch to a browser, refresh.
4. Discover a typo, go back to step 1.

That loop is heavy enough that most architects drop the diagram
from the workflow and live in text-only review. The model
becomes write-once, not live thinking material.

`aact` already loads the normalised `Model` from every supported
format and emits the full graph via `aact model --json`. The
ingredients for a local, format-agnostic, hot-reloading viewer
are already in the codebase — what is missing is a UI layer that
binds them to a browser tab.

## Краткое описание решения и его обоснование

### Решение

Ship `@aact/view` as an **optional companion npm package** that
the core `aact` CLI surfaces via the `view` subcommand. Follows
the same pattern as `vitest` + `@vitest/ui` or `next` +
`@next/eslint-plugin-next`: the companion stays out of the core
tarball; the core CLI dynamic-imports it on demand and prints an
actionable install hint when the package is absent.

```bash
pnpm add -D @aact/view   # one-time install
npx aact view                 # → reads aact.config.ts, opens browser
```

If `@aact/view` is not installed, `aact view` exits 2 with:

```
✗ aact view requires @aact/view to be installed.
  pnpm add -D @aact/view
  # or one-off:
  pnpm dlx -p aact -p @aact/view aact view
```

Runtime shape:

1. Core `aact view` subcommand (≈30 LOC in `src/cli/commands/view.ts`)
   calls `loadAndValidateConfig`, then dynamic-imports
   `@aact/view` and hands over the resolved config + a chokidar
   handle. No React / Svelte / ELK code ever lands in core.
2. `@aact/view` declares `aact` as a **peer dependency** and
   imports `loadModel` / `loadFormat` from its public API —
   never forks the loader, so format support (PUML / DSL /
   JSON / model-json) tracks aact-core automatically.
3. Companion spins a local HTTP server (UnJS `listhen` + `h3` v2
   - CrossWS for the WebSocket upgrade, consistent with the
     rest of the toolchain) and serves a pre-built static SPA from
     its own `dist/`. `npx`-friendly: the SPA bundle ships in the
     tarball — no build step on the user side.
4. The SPA fetches the current `ModelData` envelope, lays out
   the graph with ELK (hierarchical, native for C4 nesting),
   renders nodes through **Svelte Flow** (the xyflow Svelte
   port — official, DOM-node-based so custom C4 ribbons /
   boundary frames are just HTML), and overlays violations from
   `CheckData` + metrics from `AnalyzeData`.
5. A `chokidar` file watcher on `config.source.path` + every
   `customRules` import re-runs `loadModel` in-process and
   pushes the new envelope over the WebSocket; the SPA diffs
   the graph and animates the delta. Svelte 5 runes give
   fine-grained reactivity — only the nodes that actually
   changed re-render, so even a 500-element model updates
   without jank.
6. Drill-down by level — Structurizr-style **double-click
   descends one level**, breadcrumb / `Esc` ascends. Single-click
   selects the node and pins details to the side panel without
   changing scope.
   - **Landscape** — people, external systems, root software
     systems. Double-click a `softwareSystem` → System view.
   - **System** — containers inside the selected software
     system (or boundary). Double-click a `Container` →
     Element focus (Structurizr doesn't ship a Component view
     for `aact`'s scope; we stop here unless / until the model
     carries Components).
   - **Element focus** — selected node + 1-hop incoming /
     outgoing edges; details panel shows `kind`, `tags`,
     `properties`, related ADR, source location.
   - **Group slice** (optional view mode, not a C4 boundary) —
     a toggle that filters the current level by
     `properties.group`. Same level, narrower lens — orthogonal
     to the drill-down stack.

   The breadcrumb / `Esc` semantics keep the back button native
   (browser History API), so `⌘[` and the browser back arrow
   work exactly as Structurizr Lite trained users to expect.

The MVP renders **the normalised Model**, not the source
notation. Style hints from PUML (`AddElementTag`,
`UpdateElementStyle`, sprite, link) are deliberately ignored —
otherwise we re-create PlantUML and inherit its surface. The
canonical line is:

> ActView renders the architecture model, not the source code.

### Обоснование

- **Closes a measured gap.** PUML and DSL workflows both lack a
  zero-setup local viewer; everyone who's tried to use C4 as
  living documentation has hit this.
- **No new contracts.** The viewer consumes `aact model --json`
  / `aact check --json` / `aact analyze --json` envelopes — the
  `CliEnvelope` shape that's already frozen at `schemaVersion: 1`.
  No second source of truth for the Model.
- **Format-agnostic by construction.** PUML, Structurizr DSL /
  JSON, `model-json` all flow through the same registry-loaded
  `Model` already; the SPA doesn't know or care which one is on
  disk.
- **Solid base for downstream features** without expanding the
  Model surface: diff overlay (`baseline` vs `current` from
  `aact diff`), time-travel via git refs, violation-first
  navigation, ADR pop-ups.

### Не-цели MVP

The scope discipline that v3 has held throughout (this is a
linter, not a graph database) applies here too. The following
are intentional non-goals:

- **Source editing in the browser.** View only; the editor is
  the editor.
- **Multi-user / hosted mode.** Localhost-only. Architecture-as-
  service is a different product.
- **Custom layout persistence.** Compute layout from the graph
  every load — predictable, no hidden state.
- **PNG / SVG export.** That's PlantUML / Structurizr territory;
  recreating it pulls in renderer baggage we deliberately don't
  want.
- **Style fidelity with PUML.** Tags / sprites / line styles do
  not flow into the workbench. The canonical line above.

### Tech notes (May 2026 revision)

The first draft pencilled in `Solid + Cytoscape`. Two findings
from the 2026 stack survey flipped the call:

- **dagre is no longer maintained** — out of the layout shortlist.
- **xyflow (ex-React Flow) has official React and Svelte bindings,
  no Solid binding** — so the cleanest "DOM-node custom C4 nodes
  - ELK layout + fine-grained reactivity" combination is **Svelte
    5 + Svelte Flow**. Svelte runes deliver the same signal-grain
    reactivity Solid offers without the no-binding rough edge.

| Layer            | Choice                                        | Why                                                                                                                                                                                                           |
| ---------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Package          | `@aact/view` published separately on npm      | Companion install — core `aact` tarball stays lean; users who don't want the workbench never pay.                                                                                                             |
| Integration      | `aact view` subcommand → dynamic import       | Same pattern as `vitest` + `@vitest/ui`. Single discoverable surface, optional install, actionable error when missing.                                                                                        |
| Loader           | Peer dep on `aact`, imports `loadModel` etc.  | No loader fork; format support tracks aact-core automatically; in-process load = sub-100 ms reload.                                                                                                           |
| Server           | UnJS `listhen` + `h3 v2`                      | Matches aact's UnJS stack (c12 / citty / consola); zero lock-in; h3 v2 lands cross-runtime WS via CrossWS.                                                                                                    |
| WebSocket        | CrossWS (h3 v2 built-in)                      | Browser-side `WebSocket`; same runtime API on Node / Bun / Deno without a polyfill.                                                                                                                           |
| File watcher     | `chokidar`                                    | The proven cross-platform watcher.                                                                                                                                                                            |
| Browser launch   | `open`                                        | Cross-platform; falls back to printing the URL when no display is available.                                                                                                                                  |
| Frontend bundle  | Vite + **Svelte 5** + **Svelte Flow** + ELK   | Svelte 5 runes give fine-grained reactivity; svelteflow is official xyflow Svelte port, DOM-node-based so custom C4 nodes are plain HTML; ELK lays out C4 nesting natively. Bundle floor ~120–150 kB gzipped. |
| Bundle delivery  | Pre-built `dist/` in the `@aact/view` tarball | `npx aact view` works without a build step on the user side once the companion is added.                                                                                                                      |
| Communication    | The `CliEnvelope` shape, served from a route  | Re-uses the contract already documented in `src/cli/output/types.ts`.                                                                                                                                         |
| Cold-start floor | Server up + browser open < 1 s on the target  | The whole pitch is "zero friction" — every second of startup eats the value.                                                                                                                                  |

### Integration pattern — companion package, not bundled

Core `aact` ships nothing view-related at runtime. The pattern is
borrowed from the broader 2026 OSS playbook (vitest + @vitest/ui,
next + @next/eslint-plugin-next, eslint + per-plugin packages):

```
aact (always installed)
└─ src/cli/commands/view.ts        ← ~30 LOC subcommand
   ├─ loadAndValidateConfig()       ← shared with check / analyze / model
   ├─ try dynamic import("@aact/view")
   │    success → call its `runWorkbench({ config, sourceDir })`
   │    failure → ToolError("view.companionMissing", install hint)
   └─ exit code follows the companion (0 on user-quit, 2 on server boot fail)

@aact/view (separately installed; peer dep aact ^3)
├─ runWorkbench()                  ← lifecycle: load → serve → watch → cleanup
├─ src/server/                     ← listhen + h3 + CrossWS
├─ src/watcher/                    ← chokidar reload pipeline
├─ ui/                             ← Svelte 5 SPA, Vite-built
│   ├─ Routes: /, /system/:name, /element/:name
│   ├─ Svelte Flow + ELK layout
│   └─ Hot-reload subscriber over the CrossWS channel
└─ dist/                           ← pre-built SPA, ships in tarball
```

Repo layout: `@aact/view` lives **inside this repo** as a pnpm
workspace package under `packages/view/`, with the existing
aact source tree at `src/` left untouched. The view package
imports `loadModel`, `loadFormat`, and the `CliEnvelope` types
through the `aact` workspace symlink — current code reused, not
forked, not moved. CI publishes the two packages from the same
checkout; their versions can diverge inside the v3 major.

The user's mental model stays single-surface: they type
`aact view` regardless of whether the companion is present. The
core CLI is the one place that knows about the optional package;
documentation, the agent skill, and `aact --help` all reference
`aact view`, never `npx @aact/view` directly.

## Как покрыть тестами

- **Loader path.** Existing parser / loader tests already cover
  format → `Model`. The view package consumes the public
  `loadFormat` / `loadModel` surfaces; no new format contracts.
- **Server.** `vitest` integration test boots the h3 server on
  an ephemeral port, hits `/api/model` / `/api/check` /
  `/api/analyze`, asserts the envelope shape matches
  `schemaVersion: 1`.
- **WebSocket reload.** Vitest test starts the server with a
  scratch fixture file, opens a `ws` client, writes a change to
  the fixture, asserts the next message carries the new
  envelope.
- **SPA bundle.** Playwright smoke that opens the served URL on
  a fixture, asserts the graph renders, a violation node shows
  the rule name in tooltip, drill-down click changes the
  visible element set.
- **`pnpm pack` smoke.** Ensure the pre-built SPA dist actually
  ships in the tarball (publint + a check on the `files` list).

### Примеры тестов

- `packages/view/test/server.test.ts` — server envelope wiring.
- `packages/view/test/watch.test.ts` — file-watcher → WS flush.
- `packages/view/e2e/landscape.spec.ts` — Playwright drill-down.

## Roadmap (post-MVP)

These are deferred until a real user asks. None of them are
load-bearing for the workbench thesis.

- **Diff overlay.** Show `aact diff` output as colour-coded
  edges / nodes between two refs.
- **Group slice mode.** Filter by `properties.group` as a
  one-click view layer (still not a C4 boundary).
- **Time-travel.** Walk `git log` of the source file, scrub the
  workbench through history.
- **Inline ADR view.** When clicking a rule violation, surface
  the rule's ADR right inside the workbench.
- **VS Code / Cursor extension.** Embed the same SPA inside an
  editor webview pane so users never leave the IDE.
