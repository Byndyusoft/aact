import type { GenericSchema } from "valibot";

import type { Element, Model, ModelIssue } from "../model";

/**
 * Capability-based Format API. Один Format interface, capabilities
 * (load / generate / fix) — optional. Каждый формат self-describes что
 * support'ит. CLI и users-as-library narrowing через type guards.
 *
 * Долгосрочно (десятилетия): новые capabilities добавляются как optional
 * methods в существующем interface, не как новые типы. Никаких
 * "SourceFormat vs ArtifactFormat" junk types под комбинации фич.
 */

/**
 * Format-specific content builders used by rule `fix` functions.
 * Range-based fix engine anchors edits on `SourceLocation` source
 * ranges, so the syntax helper only emits *new* content (containers
 * / relations) — pattern matching is no longer needed. Future
 * builders (boundaryDecl, propertyDecl, …) plug in as additive
 * optional methods without breaking plugins.
 */
export interface FormatSyntax {
  /** Serialize the complete Container being inserted or replaced by a fix.
   * Taking the Model element rather than a few positional fields prevents a
   * re-declaration from silently dropping description, technology, links, or
   * user properties. */
  containerDecl(element: Element): string;
  /**
   * Build a relation declaration. `opts` carries the relation's
   * payload (description / technology / tags) — kept as an object so
   * callers don't have to pass `undefined` placeholders to skip a
   * field, and so future relation attributes (sprite, link, async
   * marker) can land as additive optional keys without breaking
   * plugins. Maps cleanly to both C4-PUML positional slots
   * (`Rel(from, to, label, techn, …)`) and Structurizr DSL
   * (`from -> to "description" "technology"`).
   */
  relationDecl(from: string, to: string, opts?: RelationDeclOptions): string;
}

export interface RelationDeclOptions {
  readonly description?: string;
  readonly technology?: string;
  readonly tags?: string;
}

export interface FixCapability {
  readonly syntax: FormatSyntax;
}

/**
 * Сериализованный output генератора. Single-file output (PlantUML/Mermaid/
 * Compose) — массив из одного `GeneratedFile`. Multi-file (k8s manifests
 * per service) — несколько. Один shape, CLI iterate'ит без discriminated
 * dispatch'а.
 */
interface GeneratedFile {
  readonly path: string;
  readonly content: string;
}

export interface FormatOutput {
  readonly files: readonly GeneratedFile[];
}

/** A deterministic generation failure that the CLI can expose as a
 * user-actionable diagnostic instead of an internal error. */
export class FormatGenerationError extends Error {
  constructor(
    message: string,
    readonly context: Readonly<Record<string, string>>,
  ) {
    super(message);
    this.name = "FormatGenerationError";
  }
}

/**
 * Результат load'а — Model + diagnostics. Loader заполняет `issues` через
 * buildModel (duplicate names, dangling refs, etc.) + post-build
 * validateModel. CLI решает severity (warn / fail), users-as-library
 * могут игнорировать или экспозить пользователю.
 */
export interface LoadResult {
  readonly model: Model;
  readonly issues: readonly ModelIssue[];
}

/**
 * Format — единственный contract для всех C4-as-code форматов и IaC
 * artefactов. Capabilities опциональны:
 *  - PlantUML / Mermaid / Structurizr: load + generate + fix
 *  - Kubernetes / Compose: load + generate (no fix — IaC не authored руками)
 *  - model-json: load + generate (no fix — JSON не имеет meaningful
 *    range semantics for C4 edits; для авторской работы PUML/DSL,
 *    JSON это snapshot / LLM-input / cross-tool exchange surface)
 *  - Hypothetical write-only: только generate
 *  - Hypothetical read-only: только load
 *
 * `name` — уникальный идентификатор в Format registry (config.source.type).
 * `defaultPattern` — glob (или массив globs) для CLI `init` шаблонов и
 * автодетекта по path. Compose шипится с `["compose.yaml",
 * "compose.yml", "docker-compose.yaml", "docker-compose.yml"]` —
 * Compose Spec разрешает все 4 канонических имени, и в реальных
 * репах ещё много `docker-compose.*` legacy. Формат с единственным
 * каноническим именем (PlantUML / Structurizr / model-json)
 * объявляет просто строку.
 *
 * Structurizr fix всегда пишет обратно в `source.path` (DSL).
 * JSON-source отрезан guard'ом в `check.ts` — JSON это read-only
 * artifact, authoring через DSL.
 */
export interface Format {
  readonly name: string;
  readonly defaultPattern?: string | readonly string[];
  /**
   * valibot-схема для `AactConfig.source.options` этого формата.
   * `loadConfig` валидирует опции ею сразу после резолва `source.type`
   * — опечатка в ключе падает как `config.invalidSchema`, а не молча
   * игнорируется loader'ом. Формат без схемы опций не принимает.
   */
  readonly loadOptionsSchema?: GenericSchema;
  /**
   * `options` — per-Format escape hatch. Каждый Format типизирует свою
   * options shape в собственном модуле; формат, которому опции не нужны,
   * просто игнорирует параметр. Проводка опций разная по capability:
   *   - `load`     ← `AactConfig.source.options` (discriminated by `source.type`)
   *   - `generate` ← `AactConfig.generate.<format>` (соответствующий срез)
   */
  load?(path: string, options?: unknown): Promise<LoadResult>;
  generate?(model: Model, options?: unknown): FormatOutput;
  fix?: FixCapability;
}

/** Format с гарантированным load — после canLoad narrow. */
export type LoadableFormat = Format & { load: NonNullable<Format["load"]> };

/** Format с гарантированным generate — после canGenerate narrow. */
export type GeneratableFormat = Format & {
  generate: NonNullable<Format["generate"]>;
};

/** Format с гарантированным fix — после canFix narrow. */
export type FixableFormat = Format & { fix: NonNullable<Format["fix"]> };

export const canLoad = (f: Format): f is LoadableFormat => f.load !== undefined;

export const canGenerate = (f: Format): f is GeneratableFormat =>
  f.generate !== undefined;

export const canFix = (f: Format): f is FixableFormat => f.fix !== undefined;
