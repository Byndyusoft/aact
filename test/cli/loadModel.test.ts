import path from "pathe";

import { issueToDiagnostic, loadModel } from "../../src/cli/loadModel";
import { ToolError } from "../../src/cli/output";
import type { AactConfig } from "../../src/config";
import { IncludeNotFoundError } from "../../src/formats/_shared/includeError";
import { loadFormat } from "../../src/formats/registry";
import type { Format } from "../../src/formats/types";
import type { ModelIssue } from "../../src/model";
import { makeModel } from "../helpers/makeModel";

vi.mock("../../src/formats/registry", () => ({
  loadFormat: vi.fn(),
  knownFormatNames: () => ["plantuml", "structurizr", "kubernetes"],
}));

const mockLoadFormat = vi.mocked(loadFormat);

const plantumlConfig: AactConfig = {
  source: { type: "plantuml", path: "./architecture.puml" },
};

const structurizrConfig: AactConfig = {
  source: { type: "structurizr", path: "./workspace.json" },
};

const fakeFormat = (load: Format["load"]): Format => ({
  name: "fake",
  load,
});

const enoent = (): NodeJS.ErrnoException => {
  const err: NodeJS.ErrnoException = new Error("ENOENT: no such file");
  err.code = "ENOENT";
  return err;
};

describe("loadModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delegates to format.load when format supports load capability", async () => {
    const empty = makeModel({});
    const load = vi.fn().mockResolvedValue({ model: empty, issues: [] });
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    const result = await loadModel(plantumlConfig);

    expect(mockLoadFormat).toHaveBeenCalledWith("plantuml");
    expect(load).toHaveBeenCalledOnce();
    expect(result.model).toBe(empty);
  });

  it("throws ToolError model.unsupportedLoad when format doesn't expose `load`", async () => {
    mockLoadFormat.mockResolvedValue({ name: "kubernetes" });

    await expect(loadModel(plantumlConfig)).rejects.toMatchObject({
      name: "ToolError",
      kind: "model.unsupportedLoad",
    });
  });

  it("throws ToolError model.sourceNotFound when source file is missing (plantuml)", async () => {
    const load = vi.fn().mockRejectedValue(enoent());
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    await expect(loadModel(plantumlConfig)).rejects.toMatchObject({
      name: "ToolError",
      kind: "model.sourceNotFound",
      message: expect.stringContaining("./architecture.puml"),
    });
  });

  it("throws ToolError model.sourceNotFound when source file is missing (structurizr)", async () => {
    const load = vi.fn().mockRejectedValue(enoent());
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    await expect(loadModel(structurizrConfig)).rejects.toMatchObject({
      name: "ToolError",
      kind: "model.sourceNotFound",
    });
  });

  it("throws ToolError model.includeNotFound naming the include, not the entry point", async () => {
    const load = vi.fn().mockRejectedValue(
      new IncludeNotFoundError(
        {
          missingPath: "/abs/partials/missing.puml",
          target: "partials/missing.puml",
          includedFrom: "/abs/architecture.puml",
          line: 3,
          column: 1,
        },
        "PlantUML",
      ),
    );
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    const error = (await loadModel(plantumlConfig).catch(
      (error_: unknown) => error_,
    )) as ToolError;

    expect(error).toMatchObject({
      name: "ToolError",
      kind: "model.includeNotFound",
      context: {
        path: "/abs/partials/missing.puml",
        includedFrom: "/abs/architecture.puml",
        line: "3",
        column: "1",
      },
    });
    expect(error.message).toContain("/abs/partials/missing.puml");
    expect(error.message).toContain("/abs/architecture.puml:3:1");
  });

  it("attributes a bare ENOENT to the errno path when it isn't the entry point", async () => {
    // Loaders that pull extra files in without wrapping their own ENOENT
    // (Structurizr `!include <dir>`, Compose `include:`) still must not
    // send the reader to source.path.
    const err = enoent();
    err.path = "/abs/parts/missing.dsl";
    const load = vi.fn().mockRejectedValue(err);
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    await expect(loadModel(structurizrConfig)).rejects.toMatchObject({
      name: "ToolError",
      kind: "model.includeNotFound",
      message: expect.stringContaining("/abs/parts/missing.dsl"),
    });
  });

  it("keeps model.sourceNotFound when the errno path is the entry point itself", async () => {
    const err = enoent();
    err.path = path.resolve("./architecture.puml");
    const load = vi.fn().mockRejectedValue(err);
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    await expect(loadModel(plantumlConfig)).rejects.toMatchObject({
      name: "ToolError",
      kind: "model.sourceNotFound",
      message: expect.stringContaining("./architecture.puml"),
    });
  });

  it("throws ToolError model.parseError on invalid JSON for structurizr", async () => {
    const load = vi
      .fn()
      .mockRejectedValue(new SyntaxError("Unexpected token } in JSON"));
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    await expect(loadModel(structurizrConfig)).rejects.toMatchObject({
      name: "ToolError",
      kind: "model.parseError",
      message: expect.stringContaining("Cannot parse Structurizr"),
    });
  });

  it("throws ToolError model.parseError on missing model.softwareSystems for structurizr", async () => {
    const load = vi
      .fn()
      .mockRejectedValue(
        new TypeError(
          "Cannot read properties of undefined (reading 'softwareSystems')",
        ),
      );
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    await expect(loadModel(structurizrConfig)).rejects.toMatchObject({
      name: "ToolError",
      kind: "model.parseError",
      message: expect.stringContaining("Invalid Structurizr workspace"),
    });
  });

  // Per-variant issueToDiagnostic mapping table — locks the public CLI
  // contract for every ModelIssue kind. New kinds added to ModelIssue must
  // add a row here; missing rows surface as TS exhaustiveness errors at
  // compile time.
  it.each<{ readonly issue: ModelIssue; readonly kind: string }>([
    {
      issue: { kind: "dangling-relation", from: "a", to: "ghost" },
      kind: "model.danglingRelation",
    },
    {
      issue: {
        kind: "element-in-boundary-not-in-model",
        element: "ghost",
        boundary: "b1",
      },
      kind: "model.elementInBoundaryNotInModel",
    },
    {
      issue: { kind: "boundary-not-in-model", parent: "b1", child: "ghost" },
      kind: "model.boundaryNotInModel",
    },
    {
      issue: { kind: "boundary-cycle", path: ["a", "b", "a"] },
      kind: "model.boundaryCycle",
    },
    {
      issue: { kind: "duplicate-element-name", name: "svc" },
      kind: "model.duplicateElementName",
    },
    {
      issue: { kind: "duplicate-boundary-name", name: "boundary" },
      kind: "model.duplicateBoundaryName",
    },
    {
      issue: { kind: "duplicate-identifier", identifier: "api" },
      kind: "model.duplicateIdentifier",
    },
    {
      issue: { kind: "self-relation", element: "loop" },
      kind: "model.selfRelation",
    },
    {
      issue: { kind: "unknown-kind", element: "x", raw: "Mystery" },
      kind: "model.unknownKind",
    },
    {
      issue: {
        kind: "loader-warning",
        source: "compose",
        code: "version-obsolete",
        message: "version key is obsolete",
      },
      kind: "model.loaderWarning",
    },
  ])("maps $issue.kind to $kind diagnostic", ({ issue, kind }) => {
    const diag = issueToDiagnostic(issue);
    expect(diag.kind).toBe(kind);
    expect(diag.severity).toBe("warning");
    expect(diag.message.length).toBeGreaterThan(0);
    expect(diag.context).toBeDefined();
  });

  // loader-warning has format-specific shape (source/code/message + optional
  // element) — the diagnostic message and context must carry all of them so
  // agents reading the envelope can attribute the warning to a format + code.
  it("renders loader-warning message with [source:code] prefix and message body", () => {
    const diag = issueToDiagnostic({
      kind: "loader-warning",
      source: "kubernetes",
      code: "kustomize-skipped",
      message: "kustomization patch ignored",
    });
    expect(diag.kind).toBe("model.loaderWarning");
    expect(diag.message).toBe(
      "[kubernetes:kustomize-skipped] kustomization patch ignored",
    );
  });

  it("includes element in loader-warning context only when present", () => {
    const withElement = issueToDiagnostic({
      kind: "loader-warning",
      source: "compose",
      code: "extends-unsupported",
      message: "extends is not supported",
      element: "orders",
    });
    expect(withElement.context).toEqual({
      source: "compose",
      code: "extends-unsupported",
      element: "orders",
    });

    const withoutElement = issueToDiagnostic({
      kind: "loader-warning",
      source: "compose",
      code: "version-obsolete",
      message: "version key is obsolete",
    });
    expect(withoutElement.context).toEqual({
      source: "compose",
      code: "version-obsolete",
    });
    expect(withoutElement.context).not.toHaveProperty("element");
  });

  it("wraps any non-ToolError, non-ENOENT throw as model.parseError", async () => {
    // Универсальный fallback: parse failures из ЛЮБОГО loader'а
    // (plantuml chevrotain, compose YAML, k8s YAML, model-json JSON.parse,
    // structurizr DSL) приходят сюда как plain Error и должны стать
    // model.parseError, не internal.unexpected.
    const load = vi
      .fn()
      .mockRejectedValue(new Error("boom — totally unexpected"));
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    const error = await loadModel(plantumlConfig).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe("model.parseError");
    expect((error as ToolError).message).toContain("boom — totally unexpected");
    expect((error as ToolError).context).toMatchObject({
      format: "plantuml",
      path: plantumlConfig.source.path,
    });
  });

  it("preserves Structurizr-specific JSON hint for SyntaxError", async () => {
    const structurizrConfig = {
      source: { type: "structurizr", path: "./workspace.json" },
    } as Parameters<typeof loadModel>[0];
    const load = vi
      .fn()
      .mockRejectedValue(new SyntaxError("Unexpected token } at position 42"));
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    const error = await loadModel(structurizrConfig).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe("model.parseError");
    expect((error as ToolError).message).toMatch(/valid JSON/);
  });

  it("propagates compose / k8s parse failures as model.parseError", async () => {
    const composeConfig = {
      source: { type: "compose", path: "./compose.yaml" },
    } as Parameters<typeof loadModel>[0];
    const load = vi
      .fn()
      .mockRejectedValue(
        new Error("YAMLParseError: bad indentation at line 5"),
      );
    mockLoadFormat.mockResolvedValue(fakeFormat(load));

    const error = await loadModel(composeConfig).catch(
      (error_: unknown) => error_,
    );
    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe("model.parseError");
    expect((error as ToolError).context).toMatchObject({ format: "compose" });
  });
});
