import * as v from "valibot";

import { imageHeuristicSchema } from "../_shared/optionsSchema";
import type { Format } from "../types";
import { generate } from "./generate";
import { load } from "./load";

const optionalString = v.optional(v.string());
const optionalStrings = v.optional(v.array(v.string()));

/** Mirrors `ComposeLoadOptions` (types.ts) — keep in sync. */
export const composeLoadOptionsSchema = v.strictObject({
  naming: v.optional(
    v.union([
      v.picklist([
        "as-is",
        "kebab-to-camel",
        "kebab-to-pascal",
        "snake-to-camel",
        "snake-to-pascal",
        "to-kebab",
        "to-snake",
      ]),
      // Runtime escape hatch — a function can't be validated deeper.
      v.strictObject({ transform: v.function() }),
    ]),
  ),
  labels: v.optional(
    v.strictObject({
      prefix: optionalString,
      element: optionalString,
      kind: optionalString,
      label: optionalString,
      description: optionalString,
      technology: optionalString,
      tags: optionalString,
      external: optionalString,
      link: optionalString,
      skip: optionalString,
    }),
  ),
  imageHeuristic: v.optional(imageHeuristicSchema),
  skip: optionalStrings,
  overrides: optionalStrings,
  profiles: optionalStrings,
  providers: v.optional(v.strictObject({ defaultTags: optionalStrings })),
  models: v.optional(
    v.strictObject({
      defaultTags: optionalStrings,
      relationDescription: optionalString,
    }),
  ),
});

/**
 * Docker Compose Format (Compose Spec 2026 edition).
 *
 * Capabilities: `load` + `generate`. Compose файлы обычно пишет
 * инфра-команда, но `generate` нужен для:
 *  - scaffold: архитектор пишет DSL → `aact generate compose` даёт
 *    starter `compose.yml` который dev-команда дополняет runtime'ом
 *    (volumes / env / ports / healthchecks);
 *  - round-trip контракт: `load(generate(M))` восстанавливает Model
 *    через aact-labels конвенцию.
 *
 * `fix` не поддерживается — Compose не predicate target для C4-rule
 * autofix'ов; правила работают на DSL/PUML, compose это IaC mirror.
 *
 * Load coverage:
 *  - services (`image` + `build` + `depends_on` + `labels` + `profiles`)
 *  - provider services (Compose Spec 2026 extension) → external System
 *  - top-level `models:` (AI models 2026) → external System + relations
 *  - `include:` рекурсивная композиция с cycle detection
 *  - Aact labels conventions (default prefix `aact`):
 *      aact.element / aact.kind / aact.label / aact.description /
 *      aact.technology / aact.tags / aact.external / aact.link
 *
 * Generate output:
 *  - Single `compose.yml` (no multi-file split — Compose Spec не
 *    предполагает per-service files; `include:` это user concern).
 *  - Детерминированная сортировка по service name → stable diff.
 *  - Runtime поля (volumes / networks / ports / healthchecks) НЕ
 *    эмитятся — Model их не моделирует, dev-команда дополняет руками.
 *
 * Limits (Phase 1 → расширим если будет реальный запрос):
 *  - `extends:` — info ModelIssue, base service skipped
 *  - `overrides` option — accepted but ignored (phase 1.5)
 *  - `profiles` option — accepted but ignored (phase 1.5)
 *  - networks / volumes / configs / secrets / develop — silently ignored
 *  - `version` top-level — info ModelIssue (obsolete in current spec)
 */
/**
 * 4 канонических имени по Compose Spec (auto-discovery приоритет
 * соответствует docker docs): `compose.yaml` > `compose.yml` >
 * `docker-compose.yaml` > `docker-compose.yml`. Override-файлы
 * (`compose.override.yaml`, env-specific `compose.prod.yaml` и т.д.)
 * пользователь подключает через `source.type: "compose"` явно —
 * auto-detect не угадывает их потому что они не stand-alone проекты.
 */
const COMPOSE_FILENAMES: readonly string[] = Object.freeze([
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
]);

export const composeFormat: Format = {
  name: "compose",
  defaultPattern: COMPOSE_FILENAMES,
  loadOptionsSchema: composeLoadOptionsSchema,
  load,
  generate,
};
