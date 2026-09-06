import * as v from "valibot";

import type { AclOptions } from "./rules/acl";
import type { AcyclicOptions } from "./rules/acyclic";
import type { ApiGatewayOptions } from "./rules/apiGateway";
import type { CohesionOptions } from "./rules/cohesion";
import type { CommonReuseOptions } from "./rules/commonReuse";
import type { CrudOptions } from "./rules/crud";
import type { DbPerServiceOptions } from "./rules/dbPerService";
import type { StableDependenciesOptions } from "./rules/stableDependencies";
import type { RuleDefinition } from "./rules/types";

const ruleOption = <T extends v.ObjectEntries>(entries: T) =>
  v.optional(v.union([v.boolean(), v.strictObject(entries)]));

/**
 * AactConfig — что пишет пользователь в `aact.config.ts`. Source + rules
 * (per-rule опции) + customRules (external RuleDefinition[]) + generate.
 *
 * v3: убраны legacy options (externalType, dbType, internalType) — kind
 * и external теперь typed fields на Model, а не configurable. Если нужно
 * переопределить detection — это сейчас loader-side concern, не rule.
 *
 * Source shape — accepts:
 *   1. String shorthand: `source: "./architecture.puml"` — type inferred from path
 *   2. Object form: `source: { path, type?, options? }` — type optional,
 *      inferred from path if missing; explicit overrides infer
 *
 * Type accepts arbitrary string (validated against runtime format registry at
 * load time) — добавление нового формата = entry в registry, не breaking-bump.
 *
 * Rules — looseObject: typed entries для built-ins (autocomplete +
 * options валидация через valibot strictObject), extra keys разрешены
 * для custom rules. Custom rule options сейчас не валидируются
 * runtime'ом — авторы кастомных правил отвечают за собственный
 * type narrowing внутри `check()` / `fix()`. Per-rule options schema
 * на `RuleDefinition` — open extension point, не реализован.
 *
 * Built-in rules — **opt-in**: правило бежит только если перечислено здесь
 * (`<name>: true` / options-объект). Пустой/отсутствующий `rules` → ни одно
 * built-in не активно — конфиг единственный источник правды о том, что
 * энфорсится. `<name>: false` — явный opt-out. Активация решается в
 * `check.ts` (`isRuleActive`); `aact rule list` показывает итоговое состояние.
 *
 * CustomRules — array of RuleDefinition. Auto-enabled при load'е (не нужно
 * писать `rules: { myRule: true }`). Чтобы выключить — `rules.<name>: false`.
 */
export const AactConfigSchema = v.strictObject({
  source: v.union([
    v.string(),
    v.strictObject({
      path: v.string(),
      /** Optional — infer'ится из `path` через format registry `defaultPattern` если опущен. */
      type: v.optional(v.string()),
      /**
       * Per-Format опции (`ComposeLoadOptions` / `KubernetesLoadOptions`).
       * Shape зависит от `source.type`, который известен только после
       * резолва против format registry, поэтому здесь `unknown`;
       * `loadConfig` валидирует значение схемой формата
       * (`Format.loadOptionsSchema`) сразу после резолва типа. Формат
       * без схемы опций не принимает.
       */
      options: v.optional(v.unknown()),
    }),
  ]),
  rules: v.optional(
    v.looseObject({
      acl: ruleOption({
        tag: v.optional(v.string()),
        // Name-convention fallback: a container counts as ACL even
        // without the explicit tag if its name matches a pattern.
        namePatterns: v.optional(v.array(v.string())),
      }),
      // The four option-less rules accept `boolean | {}` so the
      // config shape is symmetric with the option-bearing rules.
      // `ruleOption({})` produces `boolean | strictObject({})` —
      // empty object literal is the only accepted object form
      // until any of these rules grows real options (at which
      // point the entry widens additively).
      acyclic: ruleOption({}),
      apiGateway: ruleOption({
        aclTag: v.optional(v.string()),
        gatewayPattern: v.optional(v.instance(RegExp)),
        // Name-convention fallback for ACL detection (mirrors acl.namePatterns).
        aclNamePatterns: v.optional(v.array(v.string())),
      }),
      crud: ruleOption({
        repoTags: v.optional(v.array(v.string())),
        // Name-convention fallback: a container counts as a repo even
        // without an explicit tag if its name matches a pattern
        // (`*_repo`, `*_repository`, ...). Defaults documented on CrudOptions.
        repoNamePatterns: v.optional(v.array(v.string())),
      }),
      dbPerService: ruleOption({
        ownerTags: v.optional(v.array(v.string())),
        // Name-convention fallback for owner detection (mirrors crud.repoNamePatterns).
        ownerNamePatterns: v.optional(v.array(v.string())),
      }),
      cohesion: ruleOption({}),
      stableDependencies: ruleOption({}),
      commonReuse: ruleOption({}),
    }),
  ),
  // RuleDefinition содержит function fields (check/fix) — valibot не валидирует
  // shape глубже массива. Структурная проверка делается в check.ts на activation
  // time (name/check required, conflict detection vs built-ins).
  customRules: v.optional(v.array(v.any())),
  analyze: v.optional(
    v.strictObject({
      /** Technology substrings (case-insensitive) used as fallback
       *  classifier when a relation has no explicit `sync`/`async` tag. */
      syncTechnologies: v.optional(v.array(v.string())),
      asyncTechnologies: v.optional(v.array(v.string())),
      /** Element filter for fan-in / fan-out hotspot rankings.
       *  Structural metrics (boundaries, cycles) stay full-graph. */
      exclude: v.optional(
        v.strictObject({
          tags: v.optional(v.array(v.string())),
          namePatterns: v.optional(v.array(v.string())),
        }),
      ),
      /** Top-N hotspot list size. Default 5. */
      topN: v.optional(v.number()),
    }),
  ),
  generate: v.optional(
    v.strictObject({
      // Per-format generate settings, keyed by `source.type` / registry name.
      // `aact generate` passes `generate.<format>` to `format.generate(model,
      // opts)`, so a slice may carry both generator options AND a CLI sink
      // setting. `kubernetes.path` is the latter — the default output
      // directory (read by the sink resolver), not a generator option; the
      // k8s generator ignores it. Library users can also pass options directly.
      plantuml: v.optional(
        v.strictObject({
          boundaryLabel: v.optional(v.string()),
        }),
      ),
      structurizr: v.optional(
        v.strictObject({
          fileName: v.optional(v.string()),
        }),
      ),
      kubernetes: v.optional(
        v.strictObject({
          path: v.optional(v.string()),
        }),
      ),
    }),
  ),
  output: v.optional(
    v.strictObject({
      mode: v.optional(v.picklist(["text", "json", "sarif"])),
    }),
  ),
});

/**
 * Built-in rules config — handcrafted interface (вместо v.InferOutput) чтобы
 * TS user получал чистые option types в `rules{}` без `[key: string]: unknown`
 * index-signature leak из looseObject inference.
 *
 * Runtime parsing идёт через `AactConfigSchema.rules` looseObject; этот TS-тип
 * это user-facing surface для autocomplete.
 */
export interface BuiltinRulesConfig {
  readonly acl?: boolean | AclOptions;
  readonly acyclic?: boolean | AcyclicOptions;
  readonly apiGateway?: boolean | ApiGatewayOptions;
  readonly crud?: boolean | CrudOptions;
  readonly dbPerService?: boolean | DbPerServiceOptions;
  readonly cohesion?: boolean | CohesionOptions;
  readonly stableDependencies?: boolean | StableDependenciesOptions;
  readonly commonReuse?: boolean | CommonReuseOptions;
}

/**
 * Extract'ит options type из RuleDefinition'а через сигнатуру `check(model, options?: O)`.
 * Используется defineConfig'ом для inference custom rule options types в `rules{}`.
 */
type ExtractRuleOptions<R> = R extends RuleDefinition
  ? Exclude<Parameters<R["check"]>[1], undefined>
  : never;

/**
 * Maps кастомные правила к их config-shape: `{ <rule.name>?: false | options }`.
 * Через `<const C>` в defineConfig — TS preserves литеральные имена,
 * R['name'] становится narrow string literal, а не `string`.
 */
export type CustomRulesConfig<C extends readonly RuleDefinition[]> = {
  readonly [R in C[number] as R["name"]]?: boolean | ExtractRuleOptions<R>;
};

export type AactRulesConfig<C extends readonly RuleDefinition[]> =
  BuiltinRulesConfig & CustomRulesConfig<C>;

/**
 * Raw user-facing shape — это что юзер пишет в aact.config.ts. Generic'и
 * подбираются через `defineConfig<const C>` чтобы дать autocomplete на
 * custom rule options в `rules{}`.
 */
export interface AactConfigInput<
  C extends readonly RuleDefinition[] = readonly RuleDefinition[],
> {
  readonly source:
    | string
    | {
        readonly path: string;
        readonly type?: string;
        /** Per-Format опции. Shape специфичен для каждого формата
         *  (см. `ComposeLoadOptions` / `KubernetesLoadOptions` и т.д.). */
        readonly options?: unknown;
      };
  readonly rules?: AactRulesConfig<C>;
  readonly customRules?: C;
  readonly analyze?: v.InferInput<typeof AactConfigSchema>["analyze"];
  readonly generate?: v.InferInput<typeof AactConfigSchema>["generate"];
  readonly output?: v.InferInput<typeof AactConfigSchema>["output"];
}

/** Normalized — то что `loadAndValidateConfig` возвращает. Source всегда object с populated `type`. */
export interface AactConfig {
  readonly source: {
    readonly path: string;
    readonly type: string;
    /** Per-Format опции (`ComposeLoadOptions` / `KubernetesLoadOptions` / ...). */
    readonly options?: unknown;
  };
  readonly rules?: BuiltinRulesConfig & Readonly<Record<string, unknown>>;
  readonly customRules?: readonly RuleDefinition[];
  readonly analyze?: v.InferOutput<typeof AactConfigSchema>["analyze"];
  readonly generate?: v.InferOutput<typeof AactConfigSchema>["generate"];
  readonly output?: v.InferOutput<typeof AactConfigSchema>["output"];
}

/**
 * Typed config builder. `<const C>` captures customRules array's literal type
 * — каждое правило сохраняет свой `name` (literal) и `Parameters<check>[1]`
 * (options type). Через mapped type `CustomRulesConfig<C>` это даёт user'у
 * autocomplete + type validation на `rules: { customRuleName: { ←tab } }`.
 */
export const defineConfig = <const C extends readonly RuleDefinition[]>(
  config: AactConfigInput<C>,
): AactConfigInput<C> => config;
