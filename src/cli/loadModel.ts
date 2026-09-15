import path from "pathe";

import type { AactConfig } from "../config";
import { IncludeNotFoundError } from "../formats/_shared/includeError";
import { loadFormat } from "../formats/registry";
import type { LoadResult } from "../formats/types";
import { canLoad } from "../formats/types";
import type { ModelIssue } from "../model";
import type { Diagnostic, DiagnosticKind } from "./output";
import { ToolError } from "./output";

export const issueKindMap: Record<ModelIssue["kind"], DiagnosticKind> = {
  "dangling-relation": "model.danglingRelation",
  "element-in-boundary-not-in-model": "model.elementInBoundaryNotInModel",
  "boundary-not-in-model": "model.boundaryNotInModel",
  "boundary-cycle": "model.boundaryCycle",
  "duplicate-element-name": "model.duplicateElementName",
  "duplicate-boundary-name": "model.duplicateBoundaryName",
  "duplicate-identifier": "model.duplicateIdentifier",
  "self-relation": "model.selfRelation",
  "unknown-kind": "model.unknownKind",
  "loader-warning": "model.loaderWarning",
};

const issueContext = (issue: ModelIssue): Record<string, string> => {
  switch (issue.kind) {
    case "dangling-relation": {
      return { from: issue.from, to: issue.to };
    }
    case "element-in-boundary-not-in-model": {
      return { element: issue.element, boundary: issue.boundary };
    }
    case "boundary-not-in-model": {
      return { parent: issue.parent, child: issue.child };
    }
    case "boundary-cycle": {
      return { path: issue.path.join(" → ") };
    }
    case "duplicate-element-name":
    case "duplicate-boundary-name": {
      return { name: issue.name };
    }
    case "duplicate-identifier": {
      return { identifier: issue.identifier };
    }
    case "self-relation": {
      return { element: issue.element };
    }
    case "unknown-kind": {
      return { element: issue.element, raw: issue.raw };
    }
    case "loader-warning": {
      const ctx: Record<string, string> = {
        source: issue.source,
        code: issue.code,
      };
      if (issue.element !== undefined) ctx.element = issue.element;
      return ctx;
    }
  }
};

const issueMessage = (issue: ModelIssue): string => {
  switch (issue.kind) {
    case "dangling-relation": {
      return `Relation "${issue.from} → ${issue.to}" references unknown target`;
    }
    case "element-in-boundary-not-in-model": {
      return `Boundary "${issue.boundary}" references element "${issue.element}" not in model`;
    }
    case "boundary-not-in-model": {
      return `Boundary "${issue.parent}" references child boundary "${issue.child}" not in model`;
    }
    case "boundary-cycle": {
      return `Boundary cycle detected: ${issue.path.join(" → ")}`;
    }
    case "duplicate-element-name": {
      return `Duplicate element name "${issue.name}"`;
    }
    case "duplicate-boundary-name": {
      return `Duplicate boundary name "${issue.name}"`;
    }
    case "duplicate-identifier": {
      return `Duplicate DSL identifier "${issue.identifier}" registered for two distinct elements`;
    }
    case "self-relation": {
      return `Element "${issue.element}" has a relation to itself`;
    }
    case "unknown-kind": {
      return `Element "${issue.element}" has unknown kind "${issue.raw}"`;
    }
    case "loader-warning": {
      return `[${issue.source}:${issue.code}] ${issue.message}`;
    }
  }
};

/**
 * Lossy projection of a structured `ModelIssue` onto the generic
 * `Diagnostic` envelope shape: the typed union collapses to a flat
 * message + string `context`, and severity is flattened to "warning"
 * (the CLI decides fatal-vs-warn separately). The structured original is
 * preserved on `aact model`'s `data.issues` — read that when you need the
 * typed fields. See `ModelData` for the canon/view split.
 */
export const issueToDiagnostic = (issue: ModelIssue): Diagnostic => ({
  kind: issueKindMap[issue.kind],
  message: issueMessage(issue),
  severity: "warning",
  context: issueContext(issue),
});

const isFileNotFound = (
  err: unknown,
): err is NodeJS.ErrnoException & { code: "ENOENT" } =>
  typeof err === "object" &&
  err !== null &&
  "code" in err &&
  err.code === "ENOENT";

/**
 * Loads architecture model через format registry. Возвращает LoadResult с
 * Model + diagnostic issues (dangling refs, duplicate names etc.) от
 * validateModel + buildModel. CLI решает severity: fatal issues → exit,
 * warnings → diagnostics envelope.
 *
 * Adding new source format = добавить formats/<name>/ + строчку в
 * formats/registry.ts. Никаких case'ов здесь.
 *
 * On failure throws `ToolError` which the runner converts into an exit-2
 * envelope with the matching diagnostic kind. No `process.exit` calls here.
 */
export const loadModel = async (config: AactConfig): Promise<LoadResult> => {
  const resolvedPath = path.resolve(config.source.path);

  try {
    const format = await loadFormat(config.source.type);
    if (!canLoad(format)) {
      throw new ToolError(
        "model.unsupportedLoad",
        `Format "${format.name}" doesn't support load. Specify a source-capable format (plantuml, structurizr).`,
        { format: format.name },
      );
    }
    return await format.load(resolvedPath, config.source.options);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    // A missing `!include` is a different repair than a missing entry
    // point: the file to create is the include target, and the file to
    // edit is the one holding the directive. Reporting `config.source.path`
    // for both (which is what a bare ENOENT collapses to) sends the reader
    // to a file that exists and looks fine.
    if (error instanceof IncludeNotFoundError) {
      const { site } = error;
      throw new ToolError(
        "model.includeNotFound",
        `Included file not found: ${site.missingPath}. Referenced as "${site.target}" from ${site.includedFrom}:${site.line}:${site.column}. Create the file or fix the include path.`,
        {
          path: site.missingPath,
          target: site.target,
          includedFrom: site.includedFrom,
          line: String(site.line),
          column: String(site.column),
        },
      );
    }
    if (isFileNotFound(error)) {
      // Fallback for loaders that pull in extra files without wrapping
      // their own ENOENT (e.g. Structurizr `!include <directory>`, Compose
      // `include:`): the errno path still names what actually went
      // missing, so don't blame the entry point for it.
      const errnoPath = error.path;
      if (errnoPath !== undefined && path.resolve(errnoPath) !== resolvedPath) {
        throw new ToolError(
          "model.includeNotFound",
          `Referenced file not found: ${errnoPath}. It was pulled in while loading ${config.source.path}; fix the reference in that source.`,
          { path: errnoPath, includedFrom: resolvedPath },
        );
      }
      throw new ToolError(
        "model.sourceNotFound",
        `Architecture file not found: ${config.source.path}. Update source.path in aact.config.ts or run \`aact init\` to scaffold a starter.`,
        { path: config.source.path },
      );
    }
    // Specific Structurizr hints (keep before universal fallback — они
    // дают actionable user messages для двух распространённых ошибок).
    if (error instanceof SyntaxError && config.source.type === "structurizr") {
      throw new ToolError(
        "model.parseError",
        `Cannot parse Structurizr workspace: ${config.source.path}. ${error.message}. Check that the file is valid JSON.`,
        { path: config.source.path, format: "structurizr" },
      );
    }
    if (
      error instanceof TypeError &&
      config.source.type === "structurizr" &&
      /softwareSystems|model|people/.test(error.message)
    ) {
      throw new ToolError(
        "model.parseError",
        `Invalid Structurizr workspace: ${config.source.path}. Expected a top-level "model" object with "softwareSystems".`,
        { path: config.source.path, format: "structurizr" },
      );
    }
    // Universal fallback: любой остальной non-ToolError throw из
    // `format.load` — это failure парсера / загрузчика для текущего
    // формата. Surface как `model.parseError` чтобы agents и users
    // видели actionable diagnostic, не `internal.unexpected` от
    // generic CLI catch-all'а. Раньше narrow SyntaxError/TypeError
    // mapping ловил только structurizr, а compose / k8s / model-json
    // parse fails проваливались в "internal" категорию.
    const message = error instanceof Error ? error.message : String(error);
    throw new ToolError(
      "model.parseError",
      `Cannot load ${config.source.type} source: ${config.source.path}. ${message}`,
      { path: config.source.path, format: config.source.type },
    );
  }
};
