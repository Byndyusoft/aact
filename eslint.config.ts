import js from "@eslint/js";
import eslintComments from "@eslint-community/eslint-plugin-eslint-comments/configs";
import vitest from "@vitest/eslint-plugin";
import boundaries from "eslint-plugin-boundaries";
import citty from "eslint-plugin-citty";
import importX from "eslint-plugin-import-x";
import nodePlugin from "eslint-plugin-n";
import simpleImportSort from "eslint-plugin-simple-import-sort";
import sonarjs from "eslint-plugin-sonarjs";
import unicorn from "eslint-plugin-unicorn";
import globals from "globals";
import type { ConfigArray } from "typescript-eslint";
import tseslint from "typescript-eslint";

// eslint-disable-next-line sonarjs/deprecation -- tseslint.config() is the recommended API
export default tseslint.config(
  {
    ignores: [
      "dist/",
      "node_modules/",
      "resources/",
      "coverage/",
      "reports/",
      ".stryker-tmp/",
      // Cloned parser references (Java/structurizr-dsl etc.) — fetched
      // on demand by scripts/fetch-parser-refs.sh, not our code.
      ".parser-refs/",
      "stryker.config.mjs",
      // Standalone Node adapter for the dotnet-monolith example —
      // a runnable script outside the TS project service, same reason
      // as stryker.config.mjs above.
      "examples/dotnet-monolith/tools/*.mjs",
      // AactLoop research bench corpus — standalone .mjs runners/scorers,
      // not part of the shipped TS project, so the typed lint's project
      // service can't resolve them. Research material, not core code.
      "docs/research/",
      // Workspace packages own their own lint config + dist. The
      // root config only covers the core aact code under src/ and
      // test/; touching packages/* from here would force one
      // ruleset onto wildly different runtime stacks (Svelte +
      // Vite under packages/view/, for instance).
      "packages/",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  unicorn.configs.recommended,
  sonarjs.configs!.recommended as ConfigArray[number],
  nodePlugin.configs["flat/recommended-module"],
  eslintComments.recommended,
  // citty plugin — narrowly scoped to src/cli/**. Cherry-picked rules
  // that match our coding style without overlap with simple-import-sort/etc.
  {
    files: ["src/cli/**/*.ts"],
    plugins: { citty },
    rules: {
      "citty/no-duplicated-version": "error",
      "citty/valid-version": "error",
      "citty/no-meaningless-value-hint": "warn",
      "citty/no-hidden-root-command": "warn",
      "citty/enum-must-have-options": "error",
      "citty/must-have-run-or-sub-commands": "error",
      "citty/no-empty-command-properties": "warn",
      "citty/no-default-on-positional": "warn",
      "citty/no-alias-on-positional": "error",
    },
  },
  // eslint-plugin-import-x: cherry-pick value rules. Skip rules that
  // require eslint-import-resolver-typescript (no-unresolved, default,
  // namespace, no-duplicates — they need a resolver setup we don't have).
  {
    plugins: { "import-x": importX },
    rules: {
      "import-x/no-cycle": ["error", { maxDepth: 10 }],
      "import-x/no-self-import": "error",
      "import-x/consistent-type-specifier-style": ["error", "prefer-top-level"],
      "import-x/first": "error",
      "import-x/newline-after-import": "error",
    },
  },
  // eslint-plugin-boundaries: enforces architectural layers. Структура из
  // convention становится contract — случайный нарушение слоёв = CI red.
  // Layers: model (root) → format-shared → format → rule → analyzer → cli.
  // Configured for src/formats/<name>/ структуру (после v3 структурного move'а).
  {
    files: ["src/**/*.ts"],
    plugins: { boundaries },
    settings: {
      // TypeScript resolver — без него boundaries не может resolve relative
      // imports (`../rules` → `src/rules/index.ts`) → правило silently skip'ит.
      // Pattern из официальных docs: https://www.jsboundaries.dev/docs/guides/typescript-support/
      "import/resolver": {
        typescript: { alwaysTryTypes: true },
      },
      "boundaries/elements": [
        { type: "model", pattern: "src/model" },
        { type: "format-shared", pattern: "src/formats/_shared" },
        {
          type: "format",
          // Glob — любой непомеченный подпрефикс директории внутри
          // `src/formats/`. Новые форматы (compose / backstage /
          // terraform) не требуют правки этой регулярки. `_shared/`
          // выше уже забран как `format-shared`; `types.ts` /
          // `registry.ts` ниже забираются как `format-core` (файловые
          // паттерны), не subdirectory'ями.
          pattern: "src/formats/*",
          capture: ["formatName"],
        },
        {
          type: "format-core",
          pattern: "src/formats/(types|registry).ts",
          mode: "file",
        },
        { type: "rule", pattern: "src/rules" },
        { type: "analyze", pattern: "src/analyze.ts", mode: "file" },
        { type: "diff", pattern: "src/diff" },
        { type: "cli", pattern: "src/cli" },
        { type: "config", pattern: "src/config.ts", mode: "file" },
        { type: "index", pattern: "src/index.ts", mode: "file" },
      ],
    },
    rules: {
      "boundaries/no-unknown-files": "error",
      "boundaries/dependencies": [
        "error",
        {
          default: "disallow",
          rules: [
            // format-shared — только model
            {
              from: { type: "format-shared" },
              allow: { to: { type: "model" } },
            },
            // format-core (types.ts, registry.ts) — model + format + self
            // (registry.ts импортит Format type из types.ts)
            {
              from: { type: "format-core" },
              allow: { to: { type: ["model", "format", "format-core"] } },
            },
            // format implementations — model, format-shared, format-core
            {
              from: { type: "format" },
              allow: {
                to: { type: ["model", "format-shared", "format-core"] },
              },
            },
            // rules — model + format-core (для SourceSyntax типа)
            {
              from: { type: "rule" },
              allow: { to: { type: ["model", "format-core"] } },
            },
            // analyze — model + rules
            {
              from: { type: "analyze" },
              allow: { to: { type: ["model", "rule"] } },
            },
            // diff — pure structural diff engine. Reads Model
            // (and saved Model JSON via format registry); does
            // not depend on rules / analyze / cli.
            {
              from: { type: "diff" },
              allow: { to: { type: ["model", "format", "format-core"] } },
            },
            // cli — может всё кроме index'а
            {
              from: { type: "cli" },
              allow: {
                to: {
                  type: [
                    "model",
                    "format",
                    "format-core",
                    "format-shared",
                    "rule",
                    "analyze",
                    "diff",
                    "config",
                  ],
                },
              },
            },
            // index — public API barrel. Also re-exports the
            // envelope contract + per-command --json data shapes
            // from cli/ so library users can type-check
            // `aact <cmd> --json` output. Type-only re-exports;
            // runtime doesn't pull cli command implementations
            // into the library entrypoint.
            {
              from: { type: "index" },
              allow: {
                to: {
                  type: [
                    "model",
                    "format",
                    "format-core",
                    "rule",
                    "analyze",
                    "diff",
                    "config",
                    "cli",
                  ],
                },
              },
            },
            // config — type-only зависимость от rule для typed customRules:
            // defineConfig const-generic'и propagate'ят option shapes из
            // RuleDefinition's check signature в `rules{}` autocomplete.
            // Type-only dependency, runtime не тянет rules code.
            {
              from: { type: "config" },
              allow: { to: { type: "rule" } },
            },
            // model — `default: disallow` сам запрещает любые outbound
            // imports (root layer). Не нужно явных rules.
          ],
        },
      ],
    },
  },
  {
    plugins: {
      "simple-import-sort": simpleImportSort,
    },
    rules: {
      "simple-import-sort/imports": "error",
      "simple-import-sort/exports": "error",

      // relaxed due to loose types in plantuml-parser (CJS, no strict typing)
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/no-unnecessary-type-assertion": "warn",
      "@typescript-eslint/restrict-template-expressions": "warn",

      // relaxed — existing codebase conventions
      "unicorn/prevent-abbreviations": "off",
      "unicorn/no-array-for-each": "off",
      "unicorn/no-null": "off",
      "unicorn/prefer-top-level-await": "off",
      "unicorn/no-process-exit": "off",
      "unicorn/filename-case": "off",
      "unicorn/no-await-expression-member": "off",
      "unicorn/no-array-reduce": "off",
      "unicorn/no-array-callback-reference": "off",
      "unicorn/consistent-function-scoping": "off",
      "unicorn/explicit-length-check": "off",
      "unicorn/no-array-sort": "off",
      "unicorn/no-useless-collection-argument": "off",

      // node plugin
      "n/no-unsupported-features/node-builtins": "off",
      "n/no-missing-import": "off",
      // Tool config files (*.config.ts, changelog.config.ts, etc.) import
      // from devDeps — that's expected, not "extraneous".
      "n/no-extraneous-import": "off",

      // sonarjs relaxations
      "sonarjs/cognitive-complexity": ["warn", 20],
      "sonarjs/no-misleading-array-reverse": "warn",
      "sonarjs/no-commented-code": "off",
      "sonarjs/slow-regex": "warn",
      "sonarjs/prefer-regexp-exec": "warn",
      "sonarjs/deprecation": "warn",

      // eslint-comments: require justification for disable comments.
      "@eslint-community/eslint-comments/no-unused-disable": "error",
    },
  },
  // Parser / loader layer — chevrotain CST visitors, pre-lex passes,
  // grammar dispatchers naturally accrue branching on every grammar
  // case the C4 dialects expose. Industry norm for this kind of code
  // is 30-40 (SonarQube parsers are 50+). Raising the threshold here
  // — instead of fragmenting functions into helpers that obscure the
  // grammar shape — keeps the parser code readable while still
  // catching surprise complexity in our own application layer.
  // chevrotain's `this.visit(node)` is typed `any`, so visitor
  // returns also get an explicit pass on `no-unsafe-return`.
  {
    files: ["src/formats/*/parser/**/*.ts", "src/formats/*/load.ts"],
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 40],
      "@typescript-eslint/no-unsafe-return": "off",
    },
  },
  // Algorithmic core — graph traversal (cycle detection, instability
  // metrics, boundary classification). These functions have to weave
  // multiple invariants in one pass; splitting them at the 20 mark
  // tends to hide the algorithm rather than reveal it.
  {
    files: ["src/model/validate.ts", "src/analyze.ts"],
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 25],
    },
  },
  // Diff engine — `diffRelations` does multiset matching, pair
  // collapse, and severity assignment in a single sequential pass.
  // Each phase is short on its own, but the function as a whole
  // weaves them together against a shared rename map. Extracting
  // would split a single algorithmic narrative into helpers that
  // only ever call each other in one order — readers would chase
  // them anyway.
  {
    files: ["src/diff/computeDiff.ts"],
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 50],
    },
  },
  // Rule fix planners (e.g. crud, dbPerService) walk the model
  // and emit a SourceEdit per case branch. The branch count IS the
  // rule's behavioural surface; refactoring into helpers would
  // hide the case table that the ADR is anchored on.
  {
    files: ["src/rules/*.ts"],
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 35],
    },
  },
  // `aact rule explain` text renderer fans out into rationale /
  // examples / ADR / helpUri / hyperlink sections — every section
  // is an `if (data.x)` branch. The body is shallow but wide; the
  // 20-branch ceiling fights the user-visible structure.
  {
    files: ["src/cli/commands/rule.ts"],
    rules: {
      "sonarjs/cognitive-complexity": ["warn", 25],
    },
  },
  // @vitest/eslint-plugin — cherry-pick high-value rules. Skip
  // no-conditional-expect/no-standalone-expect — our property-based tests
  // legitimately use both patterns.
  {
    files: ["test/**/*.test.ts", "examples/**/*.test.ts"],
    plugins: { vitest },
    rules: {
      "vitest/no-focused-tests": "error",
      "vitest/no-identical-title": "error",
      "vitest/expect-expect": "warn",
      "vitest/no-disabled-tests": "warn",
      "vitest/prefer-to-be": "warn",
      "vitest/valid-title": "warn",
    },
  },
  {
    files: ["test/**/*.ts", "examples/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "no-console": "off",
      // vitest inline snapshots escape `$` inside backticks — we accept it.
      "no-useless-escape": "off",
      "sonarjs/no-duplicate-string": "off",
      "sonarjs/cognitive-complexity": "off",
      // Test fixtures use http URLs and small inline sorts; the rules are
      // for production code, not test data.
      "sonarjs/no-clear-text-protocols": "off",
      "sonarjs/no-alphabetical-sort": "off",
      "sonarjs/no-identical-functions": "off",
      "unicorn/import-style": "off",
    },
  },
);
