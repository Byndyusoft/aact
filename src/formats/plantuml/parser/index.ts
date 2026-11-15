/**
 * Public entry point for the C4-PlantUML chevrotain parser.
 *
 *   parseSource(text, filePath)
 *     → preParse  (strip non-C4 material, preserve source offsets)
 *     → tokenise  (chevrotain lexer)
 *     → parse     (CST)
 *     → AST       (visitor)
 *     → Model     (toModel)
 *     → LoadResult
 *
 * The pipeline mirrors the Structurizr parser's `index.ts` so callers
 * can swap formats by changing import paths only — same return shape,
 * same error semantics. PUML-specific bits:
 *
 *   - PUML has no `workspace` block, so `Model.workspace` is always
 *     undefined.
 *   - preParse strips opaque macros, preprocessor directives,
 *     PlantUML native syntax, and deployment blocks BEFORE lex — that
 *     way the chevrotain lexer never sees `!include https://...` or
 *     `LAYOUT_WITH_LEGEND()` and doesn't need a token for them.
 *   - preParse emits `PreParseIssue`s with `info` severity for
 *     deployment-block strip and multi-diagram trim; they surface
 *     here as `ChevrotainParseError`s with `severity: "info"`-style
 *     framing so the CLI can show "N deployment blocks ignored".
 */

import type { LoadResult } from "../../types";
import { c4PumlParser } from "./parser";
import type { PreParseIssue } from "./preParse";
import { preParse } from "./preParse";
import { C4PumlLexer } from "./tokens";
import { toModel } from "./toModel";
import { buildAst } from "./visitor";

export interface ChevrotainParseError {
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
}

export interface ChevrotainParseResult extends LoadResult {
  /** Lex + parse errors aggregated for the CLI. Empty on a clean parse. */
  readonly parseErrors: readonly ChevrotainParseError[];
  /** Info-level notes from preParse (deployment blocks ignored, second
   *  diagram trimmed). Kept separate from `parseErrors` so the CLI can
   *  surface them at the right severity. */
  readonly preParseIssues: readonly PreParseIssue[];
}

/**
 * Parse a C4-PlantUML source string. `filePath` is recorded on every
 * `SourceLocation` for downstream diagnostics — it need NOT exist on
 * disk. Returns the Model + aggregated diagnostics; nothing here
 * throws so callers can render multiple errors in one pass.
 */
export const parseSource = (
  text: string,
  filePath: string,
): ChevrotainParseResult => {
  // 1. Strip preprocessor / opaque / deployment / multi-diagram noise.
  //    Byte-length preserved — every offset on every downstream AST
  //    range still points at the right character in the original
  //    user file.
  const pre = preParse(text, filePath);

  // 2. Tokenize.
  const lex = C4PumlLexer.tokenize(pre.text);

  // 3. Parse → CST.
  c4PumlParser.input = lex.tokens;
  const cst = c4PumlParser.pumlFile();
  const parserErrors = c4PumlParser.errors;

  // 4. CST → AST.
  const ast = buildAst(cst, filePath);

  // 5. AST → Model. `preParse` extracted the SetPropertyHeader /
  //    AddProperty / WithoutPropertyHeader rows by target-line so the
  //    lowering attaches them as `Element.properties` /
  //    `Relation.properties` once it knows each node's
  //    sourceLocation.
  const result = toModel(ast, {
    attachedProperties: pre.attachedProperties,
    simpleConstants: pre.simpleConstants,
  });

  // 6. Aggregate lex + parse errors.
  const parseErrors: ChevrotainParseError[] = [];
  for (const err of lex.errors) {
    parseErrors.push({
      message: err.message,
      line: err.line ?? undefined,
      column: err.column ?? undefined,
    });
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

  return {
    model: result.model,
    issues: result.issues,
    parseErrors,
    preParseIssues: pre.issues,
  };
};

export type { PreParseIssue } from "./preParse";
