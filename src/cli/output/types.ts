/**
 * Public CLI output contract. Stable from schemaVersion 1: additions only,
 * removals/renames bump schemaVersion. Consumers (CI parsers, agent loops,
 * IDE plugins) lock onto this shape.
 */

export type OutputMode = "text" | "json" | "sarif";

export type ExitCode = 0 | 1 | 2;

/**
 * Stable diagnostic taxonomy. New kinds may be added (additive). Renaming
 * existing kinds requires schemaVersion bump.
 */
export type DiagnosticKind =
  // Model validation issues (from validateModel / buildModel)
  | "model.danglingRelation"
  | "model.boundaryNotInModel"
  | "model.elementInBoundaryNotInModel"
  | "model.boundaryCycle"
  | "model.duplicateElementName"
  | "model.duplicateBoundaryName"
  | "model.duplicateIdentifier"
  | "model.selfRelation"
  | "model.unknownKind"
  | "model.loaderWarning"
  // Model load-time errors
  | "model.sourceNotFound"
  | "model.includeNotFound"
  | "model.parseError"
  | "model.unsupportedLoad"
  // Config layer
  | "config.unknownRule"
  | "config.loadFailed"
  | "config.invalidSchema"
  | "config.missingSource"
  | "config.invalidCustomRule"
  | "config.outputCollidesWithJson"
  | "config.missingOutputPath"
  // Format capability
  | "format.unsupportedFix"
  | "format.missingWritePath"
  | "format.unknown"
  | "format.emptyOutput"
  | "format.invalidGeneratedName"
  | "format.unsafeOutputPath"
  | "format.outputPathCollision"
  // Fix engine
  | "fix.editConflict"
  // Skill installer
  | "skill.unmanagedDir"
  | "skill.repoMismatch"
  // Architecture workbench (`aact view`)
  | "view.companionMissing"
  | "view.bootFailed"
  // Catchall for unexpected internal errors (should never appear in normal flow)
  | "internal.unexpected";

export interface Diagnostic {
  readonly kind: DiagnosticKind;
  readonly message: string;
  /**
   * `error` — a fatal tool problem that drove `exitCode: 2` (config rot,
   * missing source, parse failure; every `ToolError` lands here). `warning`
   * / `info` — non-fatal loader / operational notes that don't change the
   * exit code. One severity axis the JSON envelope, SARIF, and CI agree on.
   */
  readonly severity: "error" | "warning" | "info";
  readonly context?: Readonly<Record<string, string>>;
}

/**
 * Stable metadata describing a single rule. One shared shape across
 * `aact check --json` (`rules[]`), `aact rule list`, and the base of
 * `aact rule explain`. `ruleId` is the same key carried by every
 * `CheckViolation` and SARIF `result`, so consumers join findings to
 * rule metadata on one field instead of guessing `rule` vs `name`.
 */
export interface RuleMetadata {
  readonly ruleId: string;
  readonly description: string;
  readonly source: "built-in" | "custom";
  readonly enabled: boolean;
  readonly hasFix: boolean;
  /** Doc/ADR link for the rule when one exists. Maps to SARIF `helpUri`. */
  readonly helpUri?: string;
}

export interface EnvelopeMeta {
  readonly aactVersion: string;
  readonly durationMs: number;
  readonly configPath: string | null;
  /**
   * The single entry-point source the command ran against (the file at
   * `config.source.path`), or null when none applies. Intentionally
   * singular — per-node provenance already lives on each Model node's
   * `SourceLocation.file`. If multi-file models (e.g. Structurizr
   * `workspace extends`) ever need first-class provenance, add a
   * `sources: readonly string[]` field: that is purely additive and needs
   * no `schemaVersion` bump.
   */
  readonly source: string | null;
}

export interface CliEnvelope<TData = unknown> {
  readonly schemaVersion: 1;
  readonly command: string;
  readonly ok: boolean;
  readonly exitCode: ExitCode;
  readonly data: TData;
  readonly diagnostics: readonly Diagnostic[];
  readonly meta: EnvelopeMeta;
}

/**
 * Per-command text renderer. Receives envelope + target write stream
 * (stdout in the common case; stderr when an artefact has claimed stdout).
 */
export type Renderer<TData> = (
  envelope: CliEnvelope<TData>,
  sink: NodeJS.WritableStream,
) => void;

export interface CommandResult<TData = unknown> {
  readonly envelope: CliEnvelope<TData>;
  /**
   * Text-mode hint: command itself wrote to stdout (e.g. `generate --output -`).
   * When true, HumanReporter renders the envelope to stderr to avoid
   * corrupting the artefact stream. Ignored in JSON mode (which would have
   * rejected the stdout collision upfront).
   */
  readonly stdoutClaimed?: boolean;
}

export interface Reporter<TData = unknown> {
  emit(result: CommandResult<TData>): Promise<void> | void;
}
