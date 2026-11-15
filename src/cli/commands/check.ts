import { readFile, writeFile } from "node:fs/promises";

import consola from "consola";
import { box } from "consola/utils";
import path from "pathe";

import type { AactConfig } from "../../config";
import { loadFormat } from "../../formats/registry";
import type { FixCapability, FormatSyntax } from "../../formats/types";
import { canFix } from "../../formats/types";
import type { Model, SourceLocation } from "../../model";
import { formatLocation } from "../../model";
import { applyEdits, editLocation } from "../../rules/lib/applyEdits";
import type {
  FixResult,
  RelatedLocation,
  RuleDefinition,
  SourceEdit,
  Violation,
} from "../../rules/types";
import { issueToDiagnostic, loadModel } from "../loadModel";
import type { Diagnostic, ExitCode, Renderer, RuleMetadata } from "../output";
import { colors } from "../output/colors";
import {
  formatDisplayPath,
  formatLocationDisplay,
  linkSourceLocation,
} from "../output/hyperlinks";
import { adrHelpUri } from "../ruleHelpUri";
import {
  assertNoUnknownRules,
  buildEffectiveRules,
  isBuiltinRule,
  isRuleEnabled,
} from "../ruleResolution";
import type { ExecuteResult } from "../run";
import { cliCommandWithConfig } from "../run";
import { configArg, jsonArg, sarifArg } from "../sharedArgs";
import { sourceArg } from "../sourceArg";
import { checkSarifAdapter } from "./checkSarif";

// -----------------------------------------------------------------------------
// Public data shape (envelope.data for `aact check`)
// -----------------------------------------------------------------------------

export interface CheckViolation {
  readonly ruleId: string;
  /** Name of the offending node — points into `model.elements` or
   *  `model.boundaries` depending on `targetKind`. */
  readonly target: string;
  readonly targetKind: "element" | "boundary";
  readonly message: string;
  /**
   * Severity level — same JSON vocabulary as `Diagnostic.severity`. Reserved
   * as a three-value union at v3.0.0 so per-rule / configurable severity can
   * land later without a `schemaVersion` bump; today every rule emits
   * `"error"`. SARIF maps `info` → `note`, GitHub annotations `info` →
   * `notice` at the boundary.
   */
  readonly severity: "error" | "warning" | "info";
  /**
   * Optional location of the offending construct in source. Populated
   * either from `Violation.sourceLocation` if the rule set it
   * explicitly, or by looking up
   * `model.elements[v.target].sourceLocation` as fallback. Carried
   * in the JSON envelope for agents; text mode wraps it in a
   * per-terminal OSC 8 hyperlink via `linkSourceLocation` so the
   * file:line:col anchor is Cmd-clickable in VSCode / Cursor /
   * Zed / Ghostty / iTerm2 / WezTerm / Kitty.
   */
  readonly sourceLocation?: SourceLocation;
  /**
   * Secondary anchors that give context for the primary
   * `sourceLocation`. For `dbPerService` the primary anchor is the
   * DB declaration ("this DB has too many owners") and
   * `relatedLocations` lists each accessor edge so the consumer
   * sees *who* the owners are without re-reading the source.
   * Maps to SARIF v2.1.0 `result.relatedLocations[]`; rendered in
   * text mode as indented `↳ <message>: <path>:<line>:<col>` rows.
   */
  readonly relatedLocations?: readonly RelatedLocation[];
}

export interface CheckSummary {
  /** Rules that produced at least one violation. */
  readonly failed: number;
  /** Rules that produced no violations. `passed + failed` = rules evaluated. */
  readonly passed: number;
  /** Total violations across all failed rules — findings, not rules. */
  readonly violations: number;
}

export interface CheckFixesApplied {
  readonly count: number;
  readonly remaining: number;
  /** Pre-fix violations that are gone after the fix (matched by rule + target). */
  readonly resolved: number;
  /**
   * Post-fix violations that did not exist before — what the fix itself
   * caused. Non-zero means `--fix` traded one problem for another; a
   * plain `before − remaining` would hide it.
   */
  readonly introduced: number;
  /** Absolute path that received the fixes — always `config.source.path`. */
  readonly writePath: string;
  /**
   * Pre-fix snapshot for audit. In `--fix` mode `data.violations` and
   * `data.summary` reflect the **post-fix** state (so exitCode and
   * data agree); `before` carries what the command saw before any
   * edits landed.
   */
  readonly before: {
    readonly violations: readonly CheckViolation[];
    readonly summary: CheckSummary;
  };
}

export type CheckMode = "check" | "dry-run" | "fix";

// Rule metadata in `check --json` envelopes uses the shared
// `RuleMetadata` shape (src/cli/output/types.ts) — the same shape as
// `aact rule list`, so consumers join `violations[].ruleId` to
// `rules[].ruleId` on one key without a second `rule list` call.

export interface CheckData {
  readonly mode: CheckMode;
  readonly violations: readonly CheckViolation[];
  readonly suggestedFixes: readonly FixResult[];
  readonly summary: CheckSummary;
  readonly rules: readonly RuleMetadata[];
  /**
   * Rules whose byte-identical fix edits were absorbed by another
   * rule's kept edit during dedup, keyed by the rule that retained the
   * edit. Surfaces in both `--dry-run` (so "resolved together" is
   * visible at plan time) and `--fix` (so renderer credits every rule
   * the landed edit resolved). Omitted when no dedupe happened.
   */
  readonly mergedFixes?: Readonly<Record<string, readonly string[]>>;
  readonly fixesApplied?: CheckFixesApplied;
}

// -----------------------------------------------------------------------------
// Internal rule plumbing (kept pure: no consola, no console.log)
// -----------------------------------------------------------------------------

interface RuleResult {
  readonly name: string;
  readonly violations: readonly Violation[];
}

const getRuleConfigValue = (
  rules: AactConfig["rules"],
  ruleName: string,
): unknown => rules?.[ruleName];

const runRules = (
  model: Model,
  rules: AactConfig["rules"],
  effective: readonly RuleDefinition[],
): RuleResult[] => {
  const results: RuleResult[] = [];
  for (const rule of effective) {
    if (!isRuleEnabled(rules, rule.name, isBuiltinRule(rule.name))) {
      continue;
    }
    const configValue = getRuleConfigValue(rules, rule.name);
    const options = typeof configValue === "object" ? configValue : undefined;
    results.push({ name: rule.name, violations: rule.check(model, options) });
  }
  return results;
};

const buildRuleCatalogue = (
  rules: AactConfig["rules"],
  effective: readonly RuleDefinition[],
): readonly RuleMetadata[] =>
  effective.map((r) => {
    const isBuiltin = isBuiltinRule(r.name);
    return {
      ruleId: r.name,
      description: r.description,
      source: isBuiltin ? "built-in" : "custom",
      enabled: isRuleEnabled(rules, r.name, isBuiltin),
      hasFix: typeof r.fix === "function",
      // helpUri points at the rule's ADR when one exists.
      // Previously we synthesised `<readme>#${r.name}` for every
      // built-in, but the README has no per-rule anchors, so the
      // link went 404. Custom rules can surface their own helpUri
      // later if `RuleDefinition` grows one.
      ...(r.adrPath ? { helpUri: adrHelpUri(r.adrPath) } : {}),
    };
  });

interface FixCapabilityResolution {
  readonly capability: FixCapability | null;
  readonly diagnostic?: Diagnostic;
}

const resolveFixCapability = async (
  config: AactConfig,
): Promise<FixCapabilityResolution> => {
  const format = await loadFormat(config.source.type);
  if (!canFix(format)) {
    return {
      capability: null,
      diagnostic: {
        kind: "format.unsupportedFix",
        message: `Format "${format.name}" doesn't support --fix`,
        severity: "warning",
        context: { format: format.name },
      },
    };
  }
  // Structurizr range-edit semantics выровнены только с DSL.
  // JSON-source это read-only: loader парсит, но --fix приведёт к
  // drift между JSON и DSL (после write DSL обновлён, JSON отстал).
  // V3 model: DSL — authoring surface, JSON — generated artifact.
  // Решение: refuse --fix на JSON; пользователь переключает
  // source.path на .dsl файл (auto-detect type=structurizr) и --fix
  // пишет обратно в тот же файл.
  if (
    config.source.type === "structurizr" &&
    config.source.path.toLowerCase().endsWith(".json")
  ) {
    return {
      capability: null,
      diagnostic: {
        kind: "format.unsupportedFix",
        message:
          "Cannot --fix a Structurizr JSON workspace: JSON is a read-only artifact. Switch source.path to your .dsl file (auto-detects as structurizr), then regenerate JSON via `structurizr-cli export` after editing if you need to keep the JSON copy in sync.",
        severity: "warning",
      },
    };
  }
  return { capability: format.fix };
};

interface GeneratedFixes {
  readonly fixes: readonly FixResult[];
  /**
   * Rules whose byte-identical fix edits were absorbed by another
   * rule's kept edit, keyed by the rule that retained the edit.
   * Empty when no dedupe happened. Used to render
   * "also resolves: <rule>" annotations so the user sees both
   * concerns were addressed by the single edit.
   */
  readonly mergedRules: Readonly<Record<string, readonly string[]>>;
}

const generateFixes = (
  model: Model,
  results: readonly RuleResult[],
  rules: AactConfig["rules"],
  syntax: FormatSyntax,
  effective: readonly RuleDefinition[],
): GeneratedFixes => {
  const ruleByName = new Map(effective.map((r) => [r.name, r]));
  const fixes: FixResult[] = [];
  for (const result of results) {
    if (result.violations.length === 0) continue;
    const ruleDef = ruleByName.get(result.name);
    if (!ruleDef?.fix) continue;
    const configValue = getRuleConfigValue(rules, ruleDef.name);
    const options = typeof configValue === "object" ? configValue : undefined;
    fixes.push(
      ...(ruleDef.fix?.({
        model,
        violations: result.violations,
        syntax,
        options,
      }) ?? []),
    );
  }
  return deduplicateIdenticalFixEdits(fixes);
};

const sourceLocationKey = (loc: SourceLocation): string =>
  `${loc.file}:${loc.start.offset}:${loc.end.offset}`;

const editIdentity = (edit: SourceEdit): string => {
  switch (edit.kind) {
    case "replace": {
      return `${edit.kind}:${sourceLocationKey(edit.range)}:${edit.content}`;
    }
    case "remove": {
      return `${edit.kind}:${sourceLocationKey(edit.range)}`;
    }
    case "insert-after":
    case "insert-before": {
      return `${edit.kind}:${sourceLocationKey(edit.anchor)}:${edit.content}`;
    }
  }
};

/**
 * Multiple rules can discover the same safe rewrite from different
 * angles. The starter architecture is the canonical case: `crud` and
 * `dbPerService` both redirect `orders -> orders_db` through the
 * existing `orders_repo`. Keep the first occurrence and drop later
 * byte-identical edits before rendering/applying fixes; genuinely
 * different overlapping edits are still left for `applyEdits` to
 * report as conflicts. The map of subsumed rules per kept rule travels
 * alongside so the renderer can credit every rule the single edit
 * resolves.
 */
const deduplicateIdenticalFixEdits = (
  fixes: readonly FixResult[],
): GeneratedFixes => {
  const editKeyToOwner = new Map<string, string>();
  const merged = new Map<string, Set<string>>();
  const deduped: FixResult[] = [];

  for (const fix of fixes) {
    const edits = fix.edits.filter((edit) => {
      const key = editIdentity(edit);
      const owner = editKeyToOwner.get(key);
      if (owner !== undefined) {
        if (owner !== fix.ruleId) {
          const set = merged.get(owner) ?? new Set<string>();
          set.add(fix.ruleId);
          merged.set(owner, set);
        }
        return false;
      }
      editKeyToOwner.set(key, fix.ruleId);
      return true;
    });
    // Drop fixes whose every edit was deduped away (no work left). Fixes
    // that started with zero edits — legitimate no-op announcements —
    // pass through untouched.
    if (fix.edits.length > 0 && edits.length === 0) continue;
    deduped.push(edits.length === fix.edits.length ? fix : { ...fix, edits });
  }

  const mergedRules: Record<string, readonly string[]> = {};
  for (const [keeper, subsumed] of merged) {
    mergedRules[keeper] = [...subsumed].sort((a, b) => a.localeCompare(b));
  }

  return { fixes: deduped, mergedRules };
};

const flattenViolations = (
  results: readonly RuleResult[],
  model: Model,
): CheckViolation[] => {
  const out: CheckViolation[] = [];
  for (const result of results) {
    for (const v of result.violations) {
      // Anchor on the rule-set location if present; otherwise look
      // up the target node by kind. `targetKind` removes the old
      // "try both maps" guess that boundary-level rules used to
      // depend on.
      const fallbackLoc =
        v.targetKind === "element"
          ? model.elements[v.target]?.sourceLocation
          : model.boundaries[v.target]?.sourceLocation;
      const sourceLocation = v.sourceLocation ?? fallbackLoc;
      out.push({
        ruleId: result.name,
        target: v.target,
        targetKind: v.targetKind,
        message: v.message,
        severity: "error",
        ...(sourceLocation ? { sourceLocation } : {}),
        ...(v.relatedLocations && v.relatedLocations.length > 0
          ? { relatedLocations: v.relatedLocations }
          : {}),
      });
    }
  }
  return out;
};

const buildSummary = (results: readonly RuleResult[]): CheckSummary => {
  let failed = 0;
  let passed = 0;
  let violations = 0;
  for (const r of results) {
    if (r.violations.length === 0) passed += 1;
    else {
      failed += 1;
      violations += r.violations.length;
    }
  }
  return { failed, passed, violations };
};

interface ApplyFixesResult {
  readonly remaining: number;
  readonly remainingViolations: readonly CheckViolation[];
  readonly remainingSummary: CheckSummary;
  readonly writePath: string;
  readonly conflictDiagnostics: readonly Diagnostic[];
}

const applyFixes = async (
  config: AactConfig,
  fixes: readonly FixResult[],
  effective: readonly RuleDefinition[],
): Promise<ApplyFixesResult> => {
  // Fixes всегда пишутся обратно в `source.path`. v2 `writePath`
  // dropped: JSON-source случай отрезан upstream guard'ом, остальные
  // форматы (DSL / PUML / etc.) являются и source и target.
  const writePath = path.resolve(config.source.path);
  const source = await readFile(writePath, "utf8");

  // Pool every edit from every fix into one batch — the range-based
  // applier resolves offset conflicts globally (reverse-order splice)
  // instead of running each fix sequentially on the already-mutated
  // string, which would invalidate the source ranges of later fixes.
  const allEdits = fixes.flatMap((f) => f.edits);
  const { content, conflicts } = applyEdits(source, allEdits);

  // Conflicts mean two fix edits wanted overlapping source ranges. The
  // applier kept the first one (deterministic), but the user needs
  // to know we silently dropped the second — otherwise `--fix`
  // becomes a "wrote the file but some rules didn't land" trap.
  // Surfacing as warning rather than error keeps the loop usable
  // (re-running `check` either re-emits the dropped fix or shows
  // the rule's been resolved by the kept edit).
  const conflictDiagnostics: Diagnostic[] = conflicts.map((c) => {
    const keptLoc = editLocation(c.conflictsWith);
    const skippedLoc = editLocation(c.skipped);
    return {
      kind: "fix.editConflict",
      // User-facing message uses display paths (relative to cwd
      // when possible). The `context` record keeps absolute
      // `formatLocation` strings so JSON / SARIF consumers can
      // round-trip back to the file system without guessing cwd.
      message: `Skipped overlapping fix edit: kept ${c.conflictsWith.kind} at ${formatLocationDisplay(keptLoc)}, dropped ${c.skipped.kind} at ${formatLocationDisplay(skippedLoc)}. Re-run \`aact check --fix\` after reviewing the partial result.`,
      severity: "warning",
      context: {
        kept: c.conflictsWith.kind,
        keptAt: formatLocation(keptLoc),
        skipped: c.skipped.kind,
        skippedAt: formatLocation(skippedLoc),
      },
    };
  });

  await writeFile(writePath, content, "utf8");

  // Re-check тот же файл после write — иначе false-green CI скрывает
  // non-fixable violations. v2 имел short-circuit для JSON→DSL flow,
  // но JSON-source теперь refused upstream — re-load всегда возможен.
  // Post-fix violations + summary become the envelope's authoritative
  // state so `data.violations` and `exitCode` always agree.
  const { model: reModel } = await loadModel(config);
  const reResults = runRules(reModel, config.rules, effective);
  const remainingViolations = flattenViolations(reResults, reModel);
  const remainingSummary = buildSummary(reResults);
  return {
    remaining: remainingViolations.length,
    remainingViolations,
    remainingSummary,
    writePath,
    conflictDiagnostics,
  };
};

// -----------------------------------------------------------------------------
// Pure executor (testable without citty / process.exit)
// -----------------------------------------------------------------------------

export interface CheckArgs {
  readonly fix?: boolean;
  readonly "dry-run"?: boolean;
}

const resolveMode = (args: CheckArgs): CheckMode => {
  if (args["dry-run"]) return "dry-run";
  if (args.fix) return "fix";
  return "check";
};

// A violation is "the same" across the pre- and post-fix runs when the rule
// and the offending node match — the message can legitimately change (a
// shared DB loses one accessor, a cycle gets shorter).
const violationKey = (v: CheckViolation): string =>
  `${v.ruleId}\u0000${v.targetKind}\u0000${v.target}`;

const compareViolations = (
  before: readonly CheckViolation[],
  after: readonly CheckViolation[],
): { readonly resolved: number; readonly introduced: number } => {
  const beforeKeys = new Set(before.map(violationKey));
  const afterKeys = new Set(after.map(violationKey));
  return {
    resolved: [...beforeKeys].filter((k) => !afterKeys.has(k)).length,
    introduced: [...afterKeys].filter((k) => !beforeKeys.has(k)).length,
  };
};

/**
 * Rules explain a withheld fix ("would create a dependency cycle — fix
 * manually") through `consola.warn`, the only channel the rule layer has.
 * Printed directly, that text landed on stderr during a plain `check` and
 * never reached the JSON envelope. Capture it while fixes are generated and
 * hand it back as diagnostics instead.
 */
const captureFixWarnings = <T>(
  run: () => T,
): { readonly result: T; readonly warnings: readonly Diagnostic[] } => {
  const warnings: Diagnostic[] = [];
  const saved = consola.options.reporters;
  consola.setReporters([
    {
      log: (entry) => {
        const message = entry.args.map(String).join(" ");
        const rule = /^fix (\S+):/u.exec(message)?.[1];
        warnings.push({
          kind: "fix.skipped",
          message,
          severity: "warning",
          ...(rule ? { context: { rule } } : {}),
        });
      },
    },
  ]);
  try {
    return { result: run(), warnings };
  } finally {
    consola.setReporters(saved);
  }
};

const computeExitCode = (
  violationsCount: number,
  fixesApplied: CheckFixesApplied | undefined,
): ExitCode => {
  if (fixesApplied) return fixesApplied.remaining > 0 ? 1 : 0;
  return violationsCount > 0 ? 1 : 0;
};

export const executeCheck = async (
  config: AactConfig,
  args: CheckArgs,
): Promise<ExecuteResult<CheckData>> => {
  const diagnostics: Diagnostic[] = [];
  const effective = buildEffectiveRules(config.customRules);
  assertNoUnknownRules(config.rules, effective);

  const { model, issues } = await loadModel(config);
  for (const issue of issues) diagnostics.push(issueToDiagnostic(issue));

  const results = runRules(model, config.rules, effective);
  const violations = flattenViolations(results, model);
  const summary = buildSummary(results);
  const mode = resolveMode(args);

  let suggestedFixes: readonly FixResult[] = [];
  let mergedRules: Readonly<Record<string, readonly string[]>> = {};
  if (violations.length > 0) {
    const fixCap = await resolveFixCapability(config);
    // Fixes are computed in every mode (they ship in `suggestedFixes`), but
    // "this format can't --fix" only means something to someone who asked
    // for --fix / --dry-run. In a plain check it reads as a user error.
    if (fixCap.diagnostic && mode !== "check") {
      diagnostics.push(fixCap.diagnostic);
    }
    if (fixCap.capability) {
      const { syntax } = fixCap.capability;
      const { result: generated, warnings } = captureFixWarnings(() =>
        generateFixes(model, results, config.rules, syntax, effective),
      );
      suggestedFixes = generated.fixes;
      mergedRules = generated.mergedRules;
      // Same reasoning as unsupportedFix above: why a fix was withheld only
      // matters to someone asking for fixes.
      if (mode !== "check") diagnostics.push(...warnings);
    }
  }

  let fixesApplied: CheckFixesApplied | undefined;
  // In `--fix` mode `data.violations` / `data.summary` are overwritten
  // with the post-fix re-check so the envelope's authoritative state
  // matches `exitCode`. Pre-fix data moves to `fixesApplied.before` for
  // audit. Outside `--fix` these stay pointing at the initial run.
  let finalViolations: readonly CheckViolation[] = violations;
  let finalSummary: CheckSummary = summary;
  if (mode === "fix" && suggestedFixes.length > 0) {
    const result = await applyFixes(config, suggestedFixes, effective);
    const { resolved, introduced } = compareViolations(
      violations,
      result.remainingViolations,
    );
    fixesApplied = {
      count: suggestedFixes.length,
      remaining: result.remaining,
      resolved,
      introduced,
      writePath: result.writePath,
      before: { violations, summary },
    };
    finalViolations = result.remainingViolations;
    finalSummary = result.remainingSummary;
    // Surface every edit conflict — silent drops here would defeat
    // the whole point of moving from string-matching to range-based
    // edits. Each conflict is its own diagnostic so the user can see
    // exactly what landed and what didn't.
    diagnostics.push(...result.conflictDiagnostics);
  }

  const ruleCatalogue = buildRuleCatalogue(config.rules, effective);
  const hasMerges = Object.keys(mergedRules).length > 0;

  return {
    data: {
      mode,
      violations: finalViolations,
      suggestedFixes,
      summary: finalSummary,
      rules: ruleCatalogue,
      ...(hasMerges ? { mergedFixes: mergedRules } : {}),
      ...(fixesApplied ? { fixesApplied } : {}),
    },
    exitCode: computeExitCode(finalViolations.length, fixesApplied),
    diagnostics,
  };
};

// -----------------------------------------------------------------------------
// Text rendering
// -----------------------------------------------------------------------------

// Severity → coloured cell / annotation level. Today every violation is
// "error"; the switches are in place so warning/note render correctly the
// moment configurable severity ships — no renderer change needed then.
const severityCell = (severity: CheckViolation["severity"]): string => {
  switch (severity) {
    case "warning": {
      return colors.yellow("warning");
    }
    case "info": {
      return colors.cyan("info");
    }
    default: {
      return colors.red("error");
    }
  }
};

const githubLevel = (severity: CheckViolation["severity"]): string => {
  switch (severity) {
    case "warning": {
      return "warning";
    }
    case "info": {
      return "notice";
    }
    default: {
      return "error";
    }
  }
};

const renderGithubAnnotations = (
  data: CheckData,
  sink: NodeJS.WritableStream,
): void => {
  for (const v of data.violations) {
    // GitHub Actions annotation format:
    //   ::error file=<path>,line=<L>,col=<C>,title=<rule>::<msg>
    // Without `file`/`line` the annotation appears only in the
    // workflow log; with them it surfaces as an inline PR comment
    // anchored to the offending position (`SourceLocation` from Model).
    const loc = v.sourceLocation;
    const locAttrs = loc
      ? `file=${loc.file},line=${loc.start.line},col=${loc.start.col},`
      : "";
    sink.write(
      `::${githubLevel(v.severity)} ${locAttrs}title=${v.ruleId}::${v.target}: ${v.message}\n`,
    );
  }
};

/**
 * Lint-style violation table, one line per violation:
 *
 *   path/arch.dsl:12:5  error  acl   payments_api: calls external system X
 *   path/arch.dsl:18:1  error  crud  payments_api: directly accesses db_users
 *
 * Columns auto-align by widest cell. The location column is clickable
 * (OSC8) when stdout is a TTY-with-hyperlinks; falls back to plain
 * text in CI / piped output. Violations without `sourceLocation` show
 * a dim `<file>:?:?` placeholder so column alignment stays stable.
 */
const renderViolationsTable = (
  data: CheckData,
  sink: NodeJS.WritableStream,
): void => {
  if (data.violations.length === 0) return;

  // Pre-compute the cells so we can right-align all three columns.
  const rows = data.violations.map((v) => {
    const loc = v.sourceLocation;
    // Display-only relativisation against cwd — the SourceLocation
    // itself stays absolute so linkSourceLocation can build a proper
    // editor deeplink URI further down.
    const locText = loc ? formatLocationDisplay(loc) : "";
    return {
      locText,
      sourceLocation: loc,
      ruleId: v.ruleId,
      severity: v.severity,
      target: v.target,
      message: v.message,
      relatedLocations: v.relatedLocations,
    };
  });

  const locWidth = Math.max(...rows.map((r) => r.locText.length), 1);
  const ruleWidth = Math.max(...rows.map((r) => r.ruleId.length));

  for (const r of rows) {
    // Order: pad → link → color (OSC 8 escapes would skew .length).
    // linkSourceLocation reads AACT_FILE_OPENER env to pick the
    // URL scheme — see src/cli/output/hyperlinks.ts for the
    // per-terminal logic.
    const paddedLoc = r.locText.padEnd(locWidth);
    const linked = linkSourceLocation(paddedLoc, r.sourceLocation);
    const locCell = colors.dim(linked);
    const severity = severityCell(r.severity);
    const ruleCell = colors.yellow(r.ruleId.padEnd(ruleWidth));
    const subject = colors.bold(r.target);
    sink.write(
      `  ${locCell}  ${severity}  ${ruleCell}  ${subject}: ${r.message}\n`,
    );

    // Related locations — indented `↳ <label>: <file>:<line>:<col>`
    // rows under the primary anchor. Each is independently
    // Cmd-clickable. Gives the consumer the *context* of the
    // violation (accessors, targets, cycle edges) without
    // re-reading source.
    if (r.relatedLocations && r.relatedLocations.length > 0) {
      const indent = " ".repeat(locWidth + 2);
      for (const rel of r.relatedLocations) {
        const relText = formatLocationDisplay(rel.sourceLocation);
        const relLink = linkSourceLocation(relText, rel.sourceLocation);
        const label = rel.message ? `${rel.message}: ` : "";
        const arrow = `↳ ${label}${relLink}`;
        sink.write(`  ${indent}${colors.dim(arrow)}\n`);
      }
    }
  }
  sink.write("\n");
};

const renderBoxSummary = (
  data: CheckData,
  fixableCount: number,
  sink: NodeJS.WritableStream,
): void => {
  if (data.summary.violations === 0) {
    sink.write(
      box(colors.green("No violations found."), {
        title: colors.green("✓ check"),
        style: { borderColor: "green" },
      }) + "\n",
    );
    return;
  }

  const violationsLabel =
    data.summary.violations === 1 ? "violation" : "violations";
  const rulesLabel = data.summary.failed === 1 ? "rule" : "rules";
  const fixableHas =
    fixableCount === 1 ? "rule has auto-fix" : "rules have auto-fix";
  const fixableLine =
    fixableCount > 0
      ? "\n" + colors.dim(`${fixableCount} ${fixableHas} — run with --fix`)
      : "";
  const headline =
    colors.red(`${data.summary.violations} ${violationsLabel}`) +
    " " +
    colors.dim("in") +
    " " +
    colors.red(`${data.summary.failed} ${rulesLabel}`) +
    fixableLine;
  sink.write(
    box(headline, {
      title: colors.red("✗ check"),
      style: { borderColor: "red" },
    }) + "\n",
  );
};

export type CheckTextMode = "human" | "github-actions";

const detectCheckTextMode = (): CheckTextMode =>
  process.env.GITHUB_ACTIONS ? "github-actions" : "human";

/**
 * Text-mode renderer for `aact check`. The `mode` parameter selects either
 * the human table (default for local terminals) or GitHub Actions
 * annotation lines (consumed by the Workflow UI). The default reads
 * `GITHUB_ACTIONS` from the env so production calls keep working without
 * threading mode through every layer; tests pass it explicitly. JSON mode
 * is handled by JsonReporter upstream, never reaches this function.
 */
export const renderCheckText = (
  envelope: Parameters<Renderer<CheckData>>[0],
  sink: Parameters<Renderer<CheckData>>[1],
  mode: CheckTextMode = detectCheckTextMode(),
): void => {
  const { data } = envelope;

  if (mode === "github-actions") {
    renderGithubAnnotations(data, sink);
    return;
  }

  // Mode-specific output shapes — each command has a distinct purpose:
  //   `check`     — diagnose: what's wrong
  //   `--dry-run` — plan:     what would be fixed and how (per-violation
  //                           inline annotation + planned edits)
  //   `--fix`     — apply:    what was just fixed (per-applied summary,
  //                           pre-fix violation table dropped)
  if (data.mode === "fix") {
    renderFixOutcome(data, sink);
    return;
  }
  if (data.mode === "dry-run") {
    renderDryRunPlan(data, sink);
    return;
  }

  renderViolationsTable(data, sink);

  const fixableRules = new Set(data.suggestedFixes.map((f) => f.ruleId)).size;
  renderBoxSummary(data, fixableRules, sink);
};

/**
 * Plan output for `aact check --dry-run`. For each violation: standard
 * row + inline annotation about whether an autofix exists, the rule's
 * fix description, and a compact preview of each planned edit. Closes
 * with a box that splits "fixable" vs "manual review".
 *
 * Differs from `check` (just the violation table) and `--fix` (only
 * the applied summary) — `--dry-run` is the "plan" mode that shows
 * BOTH what's wrong AND what `--fix` would do, without touching disk.
 */
const renderDryRunPlan = (
  data: CheckData,
  sink: NodeJS.WritableStream,
): void => {
  if (data.violations.length === 0) {
    sink.write(
      box(colors.green("No violations found."), {
        title: colors.green("✓ check (dry-run)"),
        style: { borderColor: "green" },
      }) + "\n",
    );
    return;
  }

  // Group fixes by rule so each violation can pull the matching plan.
  const fixesByRule = new Map<string, FixResult[]>();
  for (const fix of data.suggestedFixes) {
    const list = fixesByRule.get(fix.ruleId) ?? [];
    list.push(fix);
    fixesByRule.set(fix.ruleId, list);
  }
  // Rules whose fixes were absorbed by a sibling — used to label
  // "resolved together with X" when this rule's violations have no
  // direct fix in suggestedFixes.
  const resolvedByOtherRule = new Map<string, string>();
  const mergedFixes = data.mergedFixes ?? {};
  for (const keeper of Object.keys(mergedFixes)) {
    for (const subsumed of mergedFixes[keeper] ?? []) {
      resolvedByOtherRule.set(subsumed, keeper);
    }
  }

  const seenFixForRule = new Set<string>();
  let fixableCount = 0;
  for (const v of data.violations) {
    renderViolationRow(v, sink);
    const ownFixes = fixesByRule.get(v.ruleId);
    if (ownFixes && ownFixes.length > 0) {
      fixableCount += 1;
      if (seenFixForRule.has(v.ruleId)) {
        sink.write(
          colors.dim(`     → covered by the ${v.ruleId} fix above\n\n`),
        );
      } else {
        seenFixForRule.add(v.ruleId);
        for (const fix of ownFixes) renderDryRunFix(fix, sink);
      }
      continue;
    }
    const subsumedBy = resolvedByOtherRule.get(v.ruleId);
    if (subsumedBy) {
      fixableCount += 1;
      sink.write(
        colors.dim(`     → resolved together with ${subsumedBy} fix\n\n`),
      );
      continue;
    }
    sink.write(colors.dim(`     → no autofix — manual review\n\n`));
  }

  renderDryRunBox(data.violations.length, fixableCount, sink);
};

const renderViolationRow = (
  v: CheckViolation,
  sink: NodeJS.WritableStream,
): void => {
  const locText = v.sourceLocation
    ? formatLocationDisplay(v.sourceLocation)
    : "";
  const paddedLoc = locText.padEnd(Math.max(locText.length, 1));
  const linked = linkSourceLocation(paddedLoc, v.sourceLocation);
  const severity = severityCell(v.severity);
  const ruleCell = colors.yellow(v.ruleId);
  const subject = colors.bold(v.target);
  sink.write(
    `  ${colors.dim(linked)}  ${severity}  ${ruleCell}  ${subject}: ${v.message}\n`,
  );
  if (v.relatedLocations && v.relatedLocations.length > 0) {
    const indent = " ".repeat(locText.length + 4);
    for (const rel of v.relatedLocations) {
      const relText = formatLocationDisplay(rel.sourceLocation);
      const relLink = linkSourceLocation(relText, rel.sourceLocation);
      const label = rel.message ? `${rel.message}: ` : "";
      const arrow = colors.dim(`↳ ${label}${relLink}`);
      sink.write(`  ${indent}${arrow}\n`);
    }
  }
};

const renderDryRunFix = (fix: FixResult, sink: NodeJS.WritableStream): void => {
  sink.write(colors.dim(`     → would `) + fix.description + "\n");
  for (const edit of fix.edits) renderDryRunEdit(edit, sink);
  sink.write("\n");
};

const renderDryRunEdit = (
  edit: SourceEdit,
  sink: NodeJS.WritableStream,
): void => {
  const action = editActionLabel(edit.kind);
  const anchorLoc =
    edit.kind === "remove" || edit.kind === "replace"
      ? edit.range
      : edit.anchor;
  const loc = formatLocationDisplay(anchorLoc);
  const linkedLoc = linkSourceLocation(loc, anchorLoc);
  sink.write(colors.dim(`       ${action} ${linkedLoc}`));
  if (edit.kind === "remove") {
    sink.write("\n");
    return;
  }
  const single = edit.content.replaceAll(/\s+/g, " ").trim();
  const compact = single.length > 64 ? single.slice(0, 61) + "…" : single;
  sink.write(colors.dim("  →  ") + colors.green(compact) + "\n");
};

const editActionLabel = (kind: SourceEdit["kind"]): string => {
  switch (kind) {
    case "replace": {
      return "replace";
    }
    case "remove": {
      return "remove";
    }
    case "insert-after": {
      return "insert after";
    }
    case "insert-before": {
      return "insert before";
    }
  }
};

const renderDryRunBox = (
  total: number,
  fixable: number,
  sink: NodeJS.WritableStream,
): void => {
  const manual = total - fixable;
  const violationsWord = total === 1 ? "violation" : "violations";
  const parts: readonly string[] = [
    colors.red(`${total} ${violationsWord}`),
    ...(fixable > 0 ? [colors.green(`${fixable} fixable`)] : []),
    ...(manual > 0 ? [colors.yellow(`${manual} manual`)] : []),
  ];
  const headline = parts.join(colors.dim(" · "));
  const subline = fixable > 0 ? colors.dim("run --fix to apply") : "";
  const content = subline ? `${headline}\n${subline}` : headline;
  sink.write(
    box(content, {
      title: colors.red("✗ check (dry-run)"),
      style: { borderColor: "red" },
    }) + "\n",
  );
};

/**
 * Outcome-only output for `aact check --fix`. Shows the one-line summary
 * of each applied fix, then a result box ("N fix applied · M remaining")
 * — no duplicated pre-fix violation table.
 */
const renderAppliedFixLine = (
  fix: FixResult,
  mergedRules: Readonly<Record<string, readonly string[]>>,
  sink: NodeJS.WritableStream,
): void => {
  const subsumed = mergedRules[fix.ruleId] ?? [];
  const annotation =
    subsumed.length > 0
      ? "  " + colors.dim(`(also resolves: ${subsumed.join(", ")})`)
      : "";
  sink.write(
    `  ${colors.green("✓")}  ${colors.yellow(fix.ruleId)}  ${fix.description}${annotation}\n`,
  );
};

const renderRemainingViolations = (
  data: CheckData,
  sink: NodeJS.WritableStream,
): void => {
  sink.write(colors.yellow("Not auto-fixed:") + "\n");
  for (const v of data.violations) {
    const loc = v.sourceLocation
      ? colors.dim(formatLocationDisplay(v.sourceLocation)) + "  "
      : "";
    sink.write(
      `  ${colors.yellow("⚠")}  ${loc}${colors.yellow(v.ruleId)}  ${colors.bold(v.target)}: ${v.message}\n`,
    );
  }
  sink.write("\n");
};

const renderFixOutcomeBox = (
  applied: CheckFixesApplied,
  sink: NodeJS.WritableStream,
): void => {
  // Edits landed (count) and violations gone (resolved) tell different
  // stories — one edit can resolve two rules. `introduced` is the one that
  // must never hide inside a net number: a fix that closes four violations
  // and opens three is not "1 resolved".
  const { resolved, introduced } = applied;
  const fixLabel = applied.count === 1 ? "fix" : "fixes";
  const parts: string[] = [
    colors.green(`${applied.count} ${fixLabel} applied`),
  ];
  if (resolved !== applied.count || introduced > 0) {
    const label = resolved === 1 ? "violation" : "violations";
    parts.push(colors.green(`${resolved} ${label} resolved`));
  }
  if (introduced > 0) {
    const label = introduced === 1 ? "violation" : "violations";
    parts.push(colors.red(`${introduced} new ${label} introduced`));
  }
  if (applied.remaining > 0) {
    const label = applied.remaining === 1 ? "violation" : "violations";
    parts.push(colors.yellow(`${applied.remaining} ${label} remaining`));
  }
  const wrote = colors.dim(`wrote ${formatDisplayPath(applied.writePath)}`);
  const headline = parts.join(colors.dim(" · ")) + "\n" + wrote;

  const warn = applied.remaining > 0;
  const title = warn
    ? colors.yellow("⚠ check --fix")
    : colors.green("✓ check --fix");
  sink.write(
    box(headline, {
      title,
      style: { borderColor: warn ? "yellow" : "green" },
    }) + "\n",
  );
};

const renderFixOutcome = (
  data: CheckData,
  sink: NodeJS.WritableStream,
): void => {
  const applied = data.fixesApplied;
  // No applied fixes — either nothing was wrong (clean) or there were
  // violations with no autofix available. Fall back to the regular
  // diagnose layout so the user still sees what stayed.
  if (!applied || applied.count === 0) {
    renderViolationsTable(data, sink);
    const fixableRules = new Set(data.suggestedFixes.map((f) => f.ruleId)).size;
    renderBoxSummary(data, fixableRules, sink);
    return;
  }

  const mergedRules = data.mergedFixes ?? {};
  for (const fix of data.suggestedFixes) {
    renderAppliedFixLine(fix, mergedRules, sink);
  }
  sink.write("\n");

  if (applied.remaining > 0 && data.violations.length > 0) {
    renderRemainingViolations(data, sink);
  }

  renderFixOutcomeBox(applied, sink);
};

// -----------------------------------------------------------------------------
// Command definition
// -----------------------------------------------------------------------------

export const check = cliCommandWithConfig({
  name: "check",
  meta: { name: "check", description: "Check architecture rules" },
  args: {
    ...sourceArg,
    ...configArg,
    ...jsonArg,
    ...sarifArg,
    fix: {
      type: "boolean",
      description: "Apply auto-fixes to the source file",
    },
    "dry-run": {
      type: "boolean",
      description:
        "Show fixes without applying them (exits 1 if violations exist)",
    },
  },
  renderText: renderCheckText,
  sarifAdapter: checkSarifAdapter,
  execute: (ctx, config) => executeCheck(config, ctx.args as CheckArgs),
});
