import fs from "node:fs/promises";

import path from "pathe";

import type { ModelIssue } from "../../model";
import { toIncludeError } from "../_shared/includeError";
import type { LoadResult } from "../types";
import type { PreParseIssue } from "./parser";
import type { ChevrotainParseError } from "./parser";
import { parseSource } from "./parser";

const preParseIssueToModelIssue = (issue: PreParseIssue): ModelIssue => ({
  kind: "loader-warning",
  source: "plantuml",
  code: "preparse-info",
  message: issue.message,
});

const HTTP_URL_RE = /^https?:\/\//iu;
const INCLUDE_DIRECTIVES = ["!include_once", "!include_many", "!include"];

interface IncludeDirective {
  readonly kind: "include" | "include_once" | "include_many";
  readonly target: string;
}

const formatPlantumlParseErrors = (
  filepath: string,
  errors: readonly ChevrotainParseError[],
): string => {
  const summary = errors
    .slice(0, 5)
    .map((e) => `  ${e.line ?? "?"}:${e.column ?? "?"} ${e.message}`)
    .join("\n");
  const more = errors.length > 5 ? `\n  ...and ${errors.length - 5} more.` : "";
  return `Failed to parse PlantUML ${filepath}:\n${summary}${more}`;
};

const stripQuoted = (value: string): string => {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

const localIncludeDirective = (line: string): IncludeDirective | undefined => {
  const trimmed = line.trimStart();
  if (trimmed.startsWith("!includeurl")) return undefined;

  const directive = INCLUDE_DIRECTIVES.find((d) => trimmed.startsWith(d));
  if (directive === undefined) return undefined;

  const raw = trimmed.slice(directive.length);
  if (raw.length === 0 || !/\s/u.test(raw[0])) return undefined;

  const value = raw.trim();
  const target =
    value.startsWith('"') || value.startsWith("'")
      ? stripQuoted(value)
      : (value.split(/\s+/u)[0] ?? "");
  if (
    target.length === 0 ||
    target.startsWith("<") ||
    HTTP_URL_RE.test(target) ||
    target.startsWith("$") ||
    target.startsWith("%")
  ) {
    return undefined;
  }
  if (directive === "!include_once") return { kind: "include_once", target };
  if (directive === "!include_many") return { kind: "include_many", target };
  return { kind: "include", target };
};

const expandPlantumlIncludes = async (
  filepath: string,
  stack = new Set<string>(),
  includedOnce = new Set<string>(),
): Promise<string> => {
  const absPath = path.resolve(filepath);
  if (stack.has(absPath)) {
    throw new Error(`PlantUML include cycle detected: ${absPath}`);
  }

  stack.add(absPath);
  try {
    const raw = await fs.readFile(absPath, "utf8");
    const out: string[] = [];
    let lineNumber = 0;
    for (const line of raw.split(/(?<=\n)/u)) {
      lineNumber += 1;
      let newline = "";
      if (line.endsWith("\r\n")) newline = "\r\n";
      else if (line.endsWith("\n")) newline = "\n";

      const content = newline ? line.slice(0, -newline.length) : line;
      const include = localIncludeDirective(content);
      if (include === undefined) {
        out.push(line);
        continue;
      }

      const includePath = path.resolve(path.dirname(absPath), include.target);
      if (include.kind === "include_once" && includedOnce.has(includePath)) {
        if (newline) out.push(newline);
        continue;
      }
      if (include.kind === "include_once") includedOnce.add(includePath);

      let expanded: string;
      try {
        expanded = await expandPlantumlIncludes(
          includePath,
          stack,
          includedOnce,
        );
      } catch (error) {
        // A missing include must name the include, not the entry point
        // the CLI happened to be pointed at.
        throw toIncludeError(
          error,
          {
            missingPath: includePath,
            target: include.target,
            includedFrom: absPath,
            line: lineNumber,
            column: content.length - content.trimStart().length + 1,
          },
          "PlantUML",
        );
      }
      out.push(expanded);
      if (newline && !expanded.endsWith("\n")) out.push(newline);
    }
    return out.join("");
  } finally {
    stack.delete(absPath);
  }
};

/**
 * Load a `.puml` file via the chevrotain C4-PlantUML parser. The
 * parser does the heavy lifting (preParse → tokenise → CST → AST →
 * Model) so this function is a thin file-I/O wrapper.
 *
 * The full `parseSource` result also exposes `parseErrors` and
 * `preParseIssues`, but `LoadResult` is intentionally narrow (model +
 * issues) so users-as-library code can consume any format
 * uniformly. Lex / parse errors degrade the Model — for example, a
 * relation with an unresolvable source surfaces as a
 * `dangling-relation` issue via `validateModel`.
 */
export const load = async (filePath: string): Promise<LoadResult> => {
  const filepath = path.resolve(filePath);
  const raw = await expandPlantumlIncludes(filepath);
  const result = parseSource(raw, filepath);
  if (result.parseErrors.length > 0) {
    throw new Error(formatPlantumlParseErrors(filepath, result.parseErrors));
  }
  return {
    model: result.model,
    issues: [
      ...result.issues,
      ...result.preParseIssues.map(preParseIssueToModelIssue),
    ],
  };
};
