import type { KnipConfig } from "knip";

// Knip — finds unused exports/files/deps. Run via `pnpm knip`.
// Most config files are auto-detected; only non-default entries listed here.
export default <KnipConfig>{
  workspaces: {
    ".": {
      // Core aact package. Tests / examples / mutation config drive
      // the entry surface; src/ is the project scope.
      entry: [
        // Package surface: public API (`main`/`exports`) + the CLI bin.
        // Without these, knip treats the CLI entry and command exports as
        // unused and reports false positives.
        "src/index.ts",
        "src/cli/index.ts",
        "test/**/*.test.ts",
        "examples/**/*.test.ts",
        "examples/**/aact.config.ts",
        "vitest.mutation.config.ts",
        // Root type for `pnpm schema:gen`: ts-json-schema-generator reads
        // `ModelJsonFile` from this file by name, so nothing imports it.
        "src/formats/model-json/types.ts",
      ],
      project: ["src/**/*.ts", "test/**/*.ts", "examples/**/*.ts"],
    },
    "packages/view": {
      // Optional companion. Server-side entry auto-detected from
      // exports; SPA entry is `ui/index.html` which Vite walks
      // transitively. Knip's TS resolver doesn't read Svelte
      // `<script>` blocks — without a Svelte plugin we can't see
      // imports from .svelte files, so ui/src/ TS modules look
      // "unused" even though App.svelte pulls them in. Scope knip
      // to the server-side surface and trust Vite for the SPA.
      entry: ["ui/index.html"],
      project: ["src/**/*.ts", "ui/**/*.{ts,svelte}"],
    },
  },
  ignoreDependencies: [
    // Prettier plugin auto-loaded by prettier from name pattern; not imported.
    "prettier-plugin-packagejson",
    // @aact/view is workspace-symlinked from root so the core
    // `aact view` subcommand's dynamic import resolves during
    // local smoke. Nothing in src/ imports it directly.
    "@aact/view",
  ],
  // A re-export consumed only through its own file's return-type
  // surface (e.g. `interface X { y: readonly PreParseIssue[] }`)
  // looks "unused" without this flag because nothing else
  // `import`s it directly. Flipping the heuristic kills a long
  // tail of parser AST false-positives.
  ignoreExportsUsedInFile: true,
  // stryker.config.mjs imports types from `@stryker-mutator/api/core` which
  // is transitive via @stryker-mutator/core — knip flags as "unlisted".
  // Ignoring the config from knip's analysis entirely is simpler than
  // installing an extra devDep just for types.
  ignore: ["stryker.config.mjs"],
};
