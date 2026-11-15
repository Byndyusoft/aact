/**
 * Public entry point for the Structurizr DSL chevrotain parser.
 *
 *   parseSource(text, filePath)
 *     → tokenise → parse → CST → AST → Model
 *     → LoadResult
 *
 * Today's grammar coverage matches `parser.ts` (workspace + model +
 * elements + body statements + directives + explicit relationships).
 * Remaining grammar.md surface area lands incrementally.
 */

import type { ModelIssue } from "../../../model";
import type { LoadResult } from "../../types";
import { parseStructurizrDsl } from "./parser";
import type {
  ArchetypeAlias,
  HardRemovedError,
  OpaqueBlock,
  ParsedInfoBlock,
} from "./preParse";
import {
  extractAndApplyArchetypes,
  findHardRemovedTokens,
  normalizeKeywordCase,
  stripDeploymentBlocks,
  stripInlineDirectives,
  stripOpaqueBlocks,
} from "./preParse";
import { StructurizrLexer } from "./tokens";
import { toModel } from "./toModel";
import { buildAst } from "./visitor";

export interface ChevrotainParseError {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface ChevrotainParseResult extends LoadResult {
  /** Lexer + parser errors plus hard-removed-construct rejections.
   *  Empty on a clean parse. */
  readonly parseErrors: readonly ChevrotainParseError[];
  /** Opaque workspace blocks (views/styles/configuration/branding/
   *  terminology/themes/archetypes) that were skipped during parsing.
   *  They are preserved here so a future writer can reinsert them
   *  verbatim. */
  readonly opaqueBlocks: readonly OpaqueBlock[];
  /** Deployment-family blocks (deploymentEnvironment/deploymentNode/
   *  …) skipped because aact does not model deployment topology yet.
   *  Each one carries the construct name and a hint so the CLI can
   *  show an info-level "N deployment blocks ignored" summary. */
  readonly infoBlocks: readonly ParsedInfoBlock[];
  /** Archetype aliases extracted from `archetypes { ... }`. Already
   *  applied to the token stream during pre-parse (alias → base
   *  keyword substitution + defaults merged onto resulting elements).
   *  Exposed for diagnostics and downstream tooling. */
  readonly archetypeAliases: ReadonlyMap<string, ArchetypeAlias>;
}

/**
 * Parse a Structurizr DSL source string. `filePath` is recorded on
 * every `SourceLocation` for downstream diagnostics; it does NOT need
 * to exist on disk.
 *
 * Returns the produced `Model` and an aggregated error list. Lexer
 * and parser errors do not throw; they are returned so the caller can
 * surface diagnostics in one pass.
 */
export const parseSource = (
  text: string,
  filePath: string,
): ChevrotainParseResult => {
  // Pre-lexer pass A: collapse backslash-newline continuations into
  // a single logical line, mirroring the reference parser's line
  // preprocessing (`StructurizrDslParser.preProcessLines`). Without
  // this, fixtures like multi-line.dsl that wrap a long
  // `softwareSystem` declaration across several lines fail to parse.
  const joined = joinContinuationLines(text);
  // Pre-lexer pass B: expand `${NAME}` substitutions sourced from
  // `!const NAME "VALUE"` / `!var NAME "VALUE"` declarations.
  // Reference parser does this on every token (`StructurizrDslParser:
  // 1385-1414`, STRING_SUBSTITUTION_PATTERN). We hoist it to the
  // pre-lex stage so token positions stay coherent and downstream
  // grammar doesn't need to think about it.
  const substituted = expandSubstitutions(joined);
  const lex = StructurizrLexer.tokenize(substituted);

  // Pre-parse passes in order:
  //   1. Normalise keyword case — rewrite lowercase keyword spellings
  //      (`softwaresystem`, …) from Identifier back to canonical
  //      keyword tokens so the grammar matches the reference parser's
  //      case-insensitive dispatch.
  //   2. Extract `archetypes { … }` alias declarations and substitute
  //      every alias-as-kind usage with the resolved base keyword.
  //      Runs BEFORE opaque stripping so the archetypes-block contents
  //      are still readable; the block itself is stripped by the next
  //      pass.
  //   3. Strip opaque workspace blocks (views/styles/archetypes/…) so
  //      their inner tokens never reach the parser.
  //   4. Strip deployment-family blocks — recognised but not modelled.
  //   5. Strip inline `!docs` / `!decisions` / `!adrs` directives.
  //   6. Convert hard-removed tokens (`!ref`/`enterprise`/…) into
  //      explicit errors with replacement hints.
  const normalizedTokens = normalizeKeywordCase(lex.tokens);
  const archetyped = extractAndApplyArchetypes(normalizedTokens);
  const stripped = stripOpaqueBlocks(archetyped.tokens, filePath);
  const deployment = stripDeploymentBlocks(stripped.tokens, filePath);
  const inlineStripped = stripInlineDirectives(deployment.tokens);
  const hardRemoved = findHardRemovedTokens(inlineStripped, filePath);

  const { cst, errors: parserErrors } = parseStructurizrDsl(hardRemoved.tokens);

  const parseErrors: ChevrotainParseError[] = [];
  for (const err of lex.errors) {
    // Lex errors inside an opaque block (e.g. `*` in `include *` inside
    // `views { ... }`) are noise — the block is dropped before parsing,
    // so we drop the diagnostic too.
    if (isInsideOpaqueBlock(err, stripped.blocks)) continue;
    parseErrors.push({
      message: err.message,
      line: err.line ?? undefined,
      column: err.column ?? undefined,
    });
  }
  for (const e of hardRemoved.errors) {
    parseErrors.push(hardRemovedToParseError(e));
  }
  for (const err of parserErrors as readonly {
    message?: string;
    token?: { startLine?: number; startColumn?: number };
  }[]) {
    parseErrors.push({
      message: err.message ?? "Parser error",
      line: err.token?.startLine,
      column: err.token?.startColumn,
    });
  }

  const workspace = buildAst(cst, filePath);
  const loadResult = toModel(workspace);
  const opaqueIssues = unsupportedOpaqueIssues(stripped.blocks);

  return {
    model: loadResult.model,
    issues: [...loadResult.issues, ...opaqueIssues],
    parseErrors,
    opaqueBlocks: stripped.blocks,
    infoBlocks: deployment.blocks,
    archetypeAliases: archetyped.aliasMap,
  };
};

const unsupportedOpaqueIssues = (
  blocks: readonly OpaqueBlock[],
): ModelIssue[] =>
  blocks
    .filter((block) => isSelectorBlock(block.name))
    .map((block) => ({
      kind: "loader-warning" as const,
      source: "structurizr",
      code: "selector-body-not-applied",
      message: `${block.name} selector body was parsed as opaque and not applied to the aact Model.`,
    }));

const isSelectorBlock = (name: string): boolean =>
  name === "!element" ||
  name === "!elements" ||
  name === "!relationship" ||
  name === "!relationships";

/**
 * Replace every `\\\n[whitespace]*` with a single space so the
 * remaining text is one logical line per source line. The reference
 * parser (`StructurizrDslParser:1311-1383`) strips the leading
 * whitespace after the join; we use a single space to keep token
 * separation (`softwareSystem\` joined with `name "X"` becomes
 * `softwareSystem name "X"` rather than `softwareSystemname "X"`).
 *
 * Source positions in the joined string no longer match the original
 * file — line numbers from the lexer point at the joined-line index.
 * For downstream diagnostics this is acceptable: continuation lines
 * are by convention logically one line, and reference parser
 * diagnostics behave the same way.
 */
/**
 * Walk the source one logical line at a time, collecting
 * `!const NAME "VALUE"` and `!var NAME "VALUE"` declarations into a
 * substitution table. Every `${NAME}` occurrence — in subsequent
 * lines AND inside text-block bodies (`"""..."""`) — is replaced with
 * the table value. Reference parser uses
 * `STRING_SUBSTITUTION_PATTERN = /\$\{([a-zA-Z0-9-_.]+)\}/g` and
 * iterates to a fixed point so a const can reference another const.
 *
 * Unknown `${NAME}` references are left verbatim — the reference
 * parser does the same (it stops substituting when no match is
 * found, leaving the token for the parser to error on).
 */
const expandSubstitutions = (text: string): string => {
  const pattern = /\$\{([a-zA-Z0-9_.-]+)\}/g;
  // Scan declarations first. Permit both `"value"` (StringLiteral)
  // and `"""value"""` (TextBlock) on the right-hand side; the
  // declaration line itself is left in source so the grammar can
  // still see `!const`/`!var` directives at parse time.
  const constVar =
    /!(?:const|var)\s+([a-zA-Z0-9_.-]+)\s+(?:"""([\s\S]*?)"""|"((?:[^"\\]|\\.)*)")/g;
  const table = new Map<string, string>();
  let match: RegExpExecArray | null;
  while ((match = constVar.exec(text)) !== null) {
    const name = match[1];
    const value = match[2] ?? match[3] ?? "";
    table.set(name, value);
  }
  // Iterate to a fixed point so chained references resolve
  // (`!const A "${B}"; !const B "X"` → "X"). Bound the loop to 16
  // passes to avoid runaway expansion on cyclic references.
  let current = text;
  for (let i = 0; i < 16; i++) {
    const next = current.replaceAll(pattern, (raw, name: string) =>
      table.has(name) ? table.get(name)! : raw,
    );
    if (next === current) break;
    current = next;
  }
  return current;
};

const joinContinuationLines = (text: string): string =>
  text.replaceAll(/\\\r?\n[ \t]*/g, " ");

const hardRemovedToParseError = (
  e: HardRemovedError,
): ChevrotainParseError => ({
  message: `\`${e.construct}\` is no longer supported. ${e.hint}`,
  line: e.range.start.line,
  column: e.range.start.col,
});

const isInsideOpaqueBlock = (
  err: { offset?: number; line?: number | null },
  blocks: readonly OpaqueBlock[],
): boolean => {
  if (typeof err.offset === "number") {
    return blocks.some(
      (b) =>
        err.offset! >= b.range.start.offset && err.offset! < b.range.end.offset,
    );
  }
  if (typeof err.line === "number") {
    return blocks.some(
      (b) => err.line! >= b.range.start.line && err.line! <= b.range.end.line,
    );
  }
  return false;
};
