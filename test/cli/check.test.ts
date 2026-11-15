import { readFile, writeFile } from "node:fs/promises";

import { fc, test } from "@fast-check/vitest";

import { executeCheck, renderCheckText } from "../../src/cli/commands/check";
import { loadModel } from "../../src/cli/loadModel";
import { buildEnvelope } from "../../src/cli/output";
import type { AactConfig } from "../../src/config";
import { plantumlSyntax } from "../../src/formats/plantuml/syntax";
import { loadFormat } from "../../src/formats/registry";
import { structurizrDslSyntax } from "../../src/formats/structurizr/syntax";
import type { Format } from "../../src/formats/types";
import type { Model } from "../../src/model";
import type { RuleDefinition } from "../../src/rules/types";
import type { ElementSpec } from "../helpers/makeModel";
import { makeModel } from "../helpers/makeModel";
import { stripAnsi } from "../helpers/stripAnsi";

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("../../src/cli/loadModel", async () => {
  const actual = await vi.importActual<
    typeof import("../../src/cli/loadModel")
  >("../../src/cli/loadModel");
  return {
    ...actual,
    loadModel: vi.fn(),
  };
});

vi.mock("../../src/formats/registry", () => ({
  loadFormat: vi.fn(),
  knownFormatNames: () => ["plantuml", "structurizr", "kubernetes"],
}));

const mockLoadModel = vi.mocked(loadModel);
const mockLoadFormat = vi.mocked(loadFormat);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);

const fakeFormat = (
  name: string,
  fixSyntax = plantumlSyntax,
  load = vi.fn(),
): Format => ({ name, load, fix: { syntax: fixSyntax } });

// Built-in rules are opt-in (off unless named in config.rules), so tests
// that expect violations enable them explicitly.
const ALL_ON = {
  acl: true,
  acyclic: true,
  apiGateway: true,
  crud: true,
  dbPerService: true,
  cohesion: true,
  stableDependencies: true,
  commonReuse: true,
} as const;

const plantumlConfig: AactConfig = {
  source: { type: "plantuml", path: "test.puml" },
  rules: ALL_ON,
};

const cleanModel = (): Model =>
  makeModel({
    elements: [
      { name: "svc_a", relations: [{ to: "svc_b", technology: "http" }] },
      { name: "svc_b" },
    ],
    boundaries: [{ name: "project", elementNames: ["svc_a", "svc_b"] }],
  });

const violatingContainers: ElementSpec[] = [
  { name: "my_service", relations: [{ to: "ext_system" }] },
  { name: "ext_system", kind: "System", external: true },
];

const violatingModel = (): Model =>
  makeModel({
    elements: violatingContainers,
    boundaries: [
      {
        name: "project",
        elementNames: ["my_service", "ext_system"],
      },
    ],
  });

const cyclicModel = (): Model =>
  makeModel({
    elements: [
      { name: "svc_a", relations: [{ to: "svc_b" }] },
      { name: "svc_b", relations: [{ to: "svc_a" }] },
    ],
    boundaries: [{ name: "project", elementNames: ["svc_a", "svc_b"] }],
  });

describe("executeCheck — exit code matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadFormat.mockResolvedValue(fakeFormat("plantuml"));
  });

  it("exitCode 0 on clean model", async () => {
    mockLoadModel.mockResolvedValue({ model: cleanModel(), issues: [] });
    const result = await executeCheck(plantumlConfig, {});
    expect(result.exitCode).toBe(0);
    expect(result.data.violations).toHaveLength(0);
    expect(result.data.mode).toBe("check");
  });

  it("exitCode 1 on violations without --fix", async () => {
    mockLoadModel.mockResolvedValue({ model: violatingModel(), issues: [] });
    const result = await executeCheck(plantumlConfig, {});
    expect(result.exitCode).toBe(1);
    expect(result.data.violations.length).toBeGreaterThan(0);
    expect(result.data.violations[0].severity).toBe("error");
    expect(result.data.violations[0].ruleId).toBe("acl");
  });

  it("exitCode 1 on --dry-run with violations (Codex P1 — was 0)", async () => {
    mockLoadModel.mockResolvedValue({ model: violatingModel(), issues: [] });
    const result = await executeCheck(plantumlConfig, { "dry-run": true });
    expect(result.exitCode).toBe(1);
    expect(result.data.mode).toBe("dry-run");
    expect(result.data.suggestedFixes.length).toBeGreaterThan(0);
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("exitCode 0 after --fix that clears all violations", async () => {
    mockLoadModel
      .mockResolvedValueOnce({ model: violatingModel(), issues: [] })
      .mockResolvedValueOnce({ model: cleanModel(), issues: [] });
    mockReadFile.mockResolvedValue(
      [
        'Container(my_service, "My Service")',
        'System_Ext(ext_system, "External System")',
        'Rel(my_service, ext_system, "")',
      ].join("\n"),
    );
    mockWriteFile.mockResolvedValue();

    const result = await executeCheck(plantumlConfig, { fix: true });

    expect(result.exitCode).toBe(0);
    expect(result.data.fixesApplied?.remaining).toBe(0);
    expect(result.data.fixesApplied?.count).toBeGreaterThan(0);
    expect(mockWriteFile).toHaveBeenCalledOnce();
  });

  it("surfaces fix.editConflict diagnostics for different overlapping edits", async () => {
    const rewriteA: RuleDefinition = {
      name: "rewriteA",
      description: "test-only rewrite A",
      check: () => [
        { target: "svc", targetKind: "element", message: "rewrite A" },
      ],
      fix: ({ model }) => {
        const range = model.elements.svc?.sourceLocation;
        return range
          ? [
              {
                ruleId: "rewriteA",
                description: "rewrite svc as A",
                edits: [
                  { kind: "replace", range, content: "Container(svc_a)" },
                ],
              },
            ]
          : [];
      },
    };
    const rewriteB: RuleDefinition = {
      name: "rewriteB",
      description: "test-only rewrite B",
      check: () => [
        { target: "svc", targetKind: "element", message: "rewrite B" },
      ],
      fix: ({ model }) => {
        const range = model.elements.svc?.sourceLocation;
        return range
          ? [
              {
                ruleId: "rewriteB",
                description: "rewrite svc as B",
                edits: [
                  { kind: "replace", range, content: "Container(svc_b)" },
                ],
              },
            ]
          : [];
      },
    };
    const conflictingConfig: AactConfig = {
      ...plantumlConfig,
      customRules: [rewriteA, rewriteB],
    };
    const conflictingModel = () =>
      makeModel({
        elements: [{ name: "svc" }],
      });
    mockLoadModel
      .mockResolvedValueOnce({ model: conflictingModel(), issues: [] })
      .mockResolvedValueOnce({ model: conflictingModel(), issues: [] });
    mockReadFile.mockResolvedValue("Container(svc)");
    mockWriteFile.mockResolvedValue();

    const result = await executeCheck(conflictingConfig, { fix: true });
    const conflictDiags = result.diagnostics?.filter(
      (d) => d.kind === "fix.editConflict",
    );
    expect(conflictDiags?.length ?? 0).toBeGreaterThan(0);
  });

  it("exitCode 1 after --fix when violations remain (Codex P1 — was 0)", async () => {
    mockLoadModel
      .mockResolvedValueOnce({ model: violatingModel(), issues: [] })
      .mockResolvedValueOnce({ model: violatingModel(), issues: [] });
    mockReadFile.mockResolvedValue(
      [
        'Container(my_service, "My Service")',
        'System_Ext(ext_system, "External System")',
        'Rel(my_service, ext_system, "")',
      ].join("\n"),
    );
    mockWriteFile.mockResolvedValue();

    const result = await executeCheck(plantumlConfig, { fix: true });

    expect(result.exitCode).toBe(1);
    expect(result.data.fixesApplied?.remaining).toBeGreaterThan(0);
  });

  it("--fix counts violations the fix introduced separately from resolved ones", async () => {
    // Pre-fix: violatingModel's violations. Post-fix: an unrelated cycle —
    // every old violation is gone and every new one was introduced.
    mockLoadModel
      .mockResolvedValueOnce({ model: violatingModel(), issues: [] })
      .mockResolvedValueOnce({ model: cyclicModel(), issues: [] });
    mockReadFile.mockResolvedValue(
      [
        'Container(my_service, "My Service")',
        'System_Ext(ext_system, "External System")',
        'Rel(my_service, ext_system, "")',
      ].join("\n"),
    );
    mockWriteFile.mockResolvedValue();

    const result = await executeCheck(plantumlConfig, { fix: true });
    const applied = result.data.fixesApplied!;

    expect(applied.resolved).toBe(applied.before.violations.length);
    expect(applied.introduced).toBe(applied.remaining);
    expect(applied.introduced).toBeGreaterThan(0);
  });

  it("exitCode 1 when violations exist but no auto-fix is available", async () => {
    mockLoadModel.mockResolvedValue({ model: cyclicModel(), issues: [] });
    const result = await executeCheck(
      { ...plantumlConfig, rules: { ...ALL_ON, acl: false } },
      {},
    );
    expect(result.exitCode).toBe(1);
    expect(result.data.violations.length).toBeGreaterThan(0);
  });
});

describe("executeCheck — diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadFormat.mockResolvedValue(fakeFormat("plantuml"));
  });

  it("rejects unknown rule names in config (hard config error)", async () => {
    mockLoadModel.mockResolvedValue({ model: cleanModel(), issues: [] });
    await expect(
      executeCheck(
        { ...plantumlConfig, rules: { totallyMadeUpRule: true } },
        {},
      ),
    ).rejects.toMatchObject({ kind: "config.unknownRule" });
  });

  it("emits model.* diagnostics from loader issues", async () => {
    mockLoadModel.mockResolvedValue({
      model: cleanModel(),
      issues: [{ kind: "self-relation", element: "svc_a" }],
    });
    const result = await executeCheck(plantumlConfig, {});
    expect(
      result.diagnostics?.some((d) => d.kind === "model.selfRelation"),
    ).toBe(true);
  });

  it("refuses --fix for Structurizr JSON source (read-only artifact)", async () => {
    // JSON это generated artifact (output structurizr-cli export),
    // не authoring surface. Drift между JSON и DSL после --fix скрывал
    // изменения. Решение v3: --fix только для DSL source.
    mockLoadFormat.mockResolvedValue(
      fakeFormat("structurizr", structurizrDslSyntax),
    );
    mockLoadModel.mockResolvedValue({ model: violatingModel(), issues: [] });
    const config: AactConfig = {
      source: { type: "structurizr", path: "workspace.json" },
      rules: ALL_ON,
    };
    const result = await executeCheck(config, { fix: true });
    expect(
      result.diagnostics?.some((d) => d.kind === "format.unsupportedFix"),
    ).toBe(true);
    expect(result.data.suggestedFixes).toHaveLength(0);
  });

  it("reports a withheld fix as a diagnostic, and only when fixes were asked for", async () => {
    // examples/violations-demo: the crud redirect would close a cycle, so the
    // rule withholds the fix and explains why. That explanation used to hit
    // stderr on every plain check and never reached the JSON envelope.
    const cycleModel = () =>
      makeModel({
        elements: [
          {
            name: "orders_api",
            relations: [{ to: "orders_crud" }, { to: "inventory_api" }],
          },
          {
            name: "orders_crud",
            tags: ["repo"],
            relations: [{ to: "orders_db" }],
          },
          { name: "orders_db", kind: "ContainerDb" },
          { name: "inventory_api", relations: [{ to: "orders_db" }] },
        ],
        boundaries: [
          {
            name: "orders",
            elementNames: ["orders_api", "orders_crud", "orders_db"],
          },
          { name: "inventory", elementNames: ["inventory_api"] },
        ],
      });
    mockLoadFormat.mockResolvedValue(fakeFormat("plantuml"));
    mockLoadModel.mockResolvedValue({ model: cycleModel(), issues: [] });
    const config: AactConfig = {
      source: { type: "plantuml", path: "test.puml" },
      rules: { crud: true },
    };
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);

    const plain = await executeCheck(config, {});
    const preview = await executeCheck(config, { "dry-run": true });

    expect(plain.diagnostics?.some((d) => d.kind === "fix.skipped")).toBe(
      false,
    );
    expect(stderr).not.toHaveBeenCalled();
    expect(preview.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: "fix.skipped",
        context: { rule: "crud" },
        message: expect.stringContaining("would create a dependency cycle"),
      }),
    );
  });

  it("stays quiet about --fix support on a plain check", async () => {
    // Regression: `aact check` on a model-json / Structurizr JSON source
    // warned "doesn't support --fix" although nobody passed --fix.
    mockLoadFormat.mockResolvedValue({ name: "model-json" });
    mockLoadModel.mockResolvedValue({ model: violatingModel(), issues: [] });
    const config: AactConfig = {
      source: { type: "model-json", path: "as-built.aact.json" },
      rules: ALL_ON,
    };

    const plain = await executeCheck(config, {});
    const preview = await executeCheck(config, { "dry-run": true });

    expect(
      plain.diagnostics?.some((d) => d.kind === "format.unsupportedFix"),
    ).toBe(false);
    expect(plain.data.suggestedFixes).toHaveLength(0);
    expect(
      preview.diagnostics?.some((d) => d.kind === "format.unsupportedFix"),
    ).toBe(true);
  });

  it("DSL-source structurizr --fix writes back to source.path (no writePath)", async () => {
    mockLoadFormat.mockResolvedValue(
      fakeFormat("structurizr", structurizrDslSyntax),
    );
    mockLoadModel.mockResolvedValue({ model: violatingModel(), issues: [] });
    const config: AactConfig = {
      source: { type: "structurizr", path: "./workspace.dsl" },
      rules: ALL_ON,
    };
    const result = await executeCheck(config, {});
    expect(
      result.diagnostics?.some((d) => d.kind === "format.unsupportedFix"),
    ).toBe(false);
    expect(result.data.suggestedFixes.length).toBeGreaterThan(0);
  });

  it("DSL-source --fix re-checks after write, no false-green CI (Codex P1)", async () => {
    // Mixed fixable/non-fixable scenario: первый load даёт N violations,
    // после write re-load даёт оставшиеся → remaining > 0, exit=1.
    mockLoadFormat.mockResolvedValue(
      fakeFormat("structurizr", structurizrDslSyntax),
    );
    mockLoadModel
      .mockResolvedValueOnce({ model: violatingModel(), issues: [] })
      .mockResolvedValueOnce({ model: violatingModel(), issues: [] });
    mockReadFile.mockResolvedValue("workspace { model { } }");
    mockWriteFile.mockResolvedValue();

    const config: AactConfig = {
      source: { type: "structurizr", path: "./workspace.dsl" },
      rules: ALL_ON,
    };
    const result = await executeCheck(config, { fix: true });

    expect(result.data.fixesApplied?.remaining).toBeGreaterThan(0);
    expect(result.exitCode).toBe(1);
    // loadModel был вызван дважды: initial + re-check после write.
    expect(mockLoadModel).toHaveBeenCalledTimes(2);
  });
});

describe("executeCheck — disabled rules respected", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockLoadFormat.mockResolvedValue(fakeFormat("plantuml"));
  });

  it("rule disabled via rules.<name>: false does not produce violations", async () => {
    mockLoadModel.mockResolvedValue({ model: violatingModel(), issues: [] });
    const result = await executeCheck(
      { ...plantumlConfig, rules: { ...ALL_ON, acl: false } },
      {},
    );
    expect(result.data.violations.every((v) => v.ruleId !== "acl")).toBe(true);
  });
});

describe("renderCheckText", () => {
  const captureSink = (): {
    sink: NodeJS.WritableStream;
    output: () => string;
  } => {
    const chunks: Buffer[] = [];
    const sink: Partial<NodeJS.WritableStream> = {
      write: (chunk: string | Uint8Array) => {
        chunks.push(Buffer.from(chunk));
        return true;
      },
    };
    return {
      sink: sink as NodeJS.WritableStream,
      // Strip ANSI at the assertion boundary. consola's `colors.bold(...)`
      // wraps labels mid-token (e.g. `[1mApplied [22m3 fix(es)`), so a
      // toContain that anchors on `Applied 3 fix(es)` breaks whenever
      // colour is auto-enabled (real TTY locally, GITHUB_ACTIONS in CI).
      output: () => stripAnsi(Buffer.concat(chunks).toString("utf8")),
    };
  };

  // Pin the renderer mode explicitly so the test stays decoupled from
  // the ambient GITHUB_ACTIONS env. Tests that exercise the annotation
  // branch use `renderGha`.
  const renderHuman: typeof renderCheckText = (envelope, sink) =>
    renderCheckText(envelope, sink, "human");
  const renderGha: typeof renderCheckText = (envelope, sink) =>
    renderCheckText(envelope, sink, "github-actions");

  it("renders box summary when clean", () => {
    const { sink, output } = captureSink();
    renderHuman(
      buildEnvelope({
        command: "check",
        exitCode: 0,
        data: {
          mode: "check",
          violations: [],
          suggestedFixes: [],
          summary: { failed: 0, passed: 8, violations: 0 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: "test.puml" },
      }),
      sink,
    );
    expect(output()).toContain("No violations found");
  });

  it("renders violations table when failing", () => {
    const { sink, output } = captureSink();
    renderHuman(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "check",
          violations: [
            {
              ruleId: "acl",
              target: "my_service",
              targetKind: "element" as const,
              message: "calls external system",
              severity: "error",
            },
          ],
          suggestedFixes: [],
          summary: { failed: 1, passed: 7, violations: 1 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    const text = output();
    expect(text).toContain("acl");
    expect(text).toContain("my_service");
    expect(text).toContain("1 violation");
  });

  it("renders relatedLocations as indented `↳ label: path:line:col` rows", () => {
    const { sink, output } = captureSink();
    renderHuman(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "check",
          violations: [
            {
              ruleId: "dbPerService",
              target: "orders_db",
              targetKind: "element" as const,
              message: "shared between A, B",
              severity: "error",
              sourceLocation: {
                file: "/abs/arch.puml",
                start: { line: 10, col: 1, offset: 100 },
                end: { line: 10, col: 20, offset: 119 },
              },
              relatedLocations: [
                {
                  sourceLocation: {
                    file: "/abs/arch.puml",
                    start: { line: 25, col: 1, offset: 400 },
                    end: { line: 25, col: 30, offset: 429 },
                  },
                  message: "accessor: A",
                },
                {
                  sourceLocation: {
                    file: "/abs/arch.puml",
                    start: { line: 26, col: 1, offset: 460 },
                    end: { line: 26, col: 30, offset: 489 },
                  },
                  message: "accessor: B",
                },
              ],
            },
          ],
          suggestedFixes: [],
          summary: { failed: 1, passed: 7, violations: 1 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    const text = output();
    expect(text).toMatch(/↳ accessor: A: \/abs\/arch\.puml:25:1/);
    expect(text).toMatch(/↳ accessor: B: \/abs\/arch\.puml:26:1/);
  });

  it("renders relatedLocations without label when message is absent", () => {
    const { sink, output } = captureSink();
    renderHuman(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "check",
          violations: [
            {
              ruleId: "acyclic",
              target: "svc_a",
              targetKind: "element" as const,
              message: "participates in cycle",
              severity: "error",
              sourceLocation: {
                file: "/abs/x.puml",
                start: { line: 5, col: 1, offset: 50 },
                end: { line: 5, col: 10, offset: 59 },
              },
              relatedLocations: [
                {
                  sourceLocation: {
                    file: "/abs/x.puml",
                    start: { line: 7, col: 1, offset: 80 },
                    end: { line: 7, col: 10, offset: 89 },
                  },
                },
              ],
            },
          ],
          suggestedFixes: [],
          summary: { failed: 1, passed: 7, violations: 1 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    expect(output()).toMatch(/↳ \/abs\/x\.puml:7:1/);
  });

  it("renders suggested fixes preview only in dry-run mode", () => {
    const inDryRun = (() => {
      const { sink, output } = captureSink();
      renderHuman(
        buildEnvelope({
          command: "check",
          exitCode: 1,
          data: {
            mode: "dry-run",
            violations: [
              {
                ruleId: "acl",
                target: "my_service",
                targetKind: "element" as const,
                message: "msg",
                severity: "error",
              },
            ],
            suggestedFixes: [
              {
                ruleId: "acl",
                description: "add anti-corruption layer",
                edits: [
                  {
                    kind: "insert-after",
                    anchor: {
                      file: "x.puml",
                      start: { line: 1, col: 1, offset: 0 },
                      end: { line: 1, col: 10, offset: 10 },
                    },
                    content: "fake",
                  },
                ],
              },
            ],
            summary: { failed: 1, passed: 0, violations: 1 },
            rules: [],
          },
          meta: { durationMs: 1, configPath: null, source: null },
        }),
        sink,
      );
      return output();
    })();

    const inCheck = (() => {
      const { sink, output } = captureSink();
      renderHuman(
        buildEnvelope({
          command: "check",
          exitCode: 1,
          data: {
            mode: "check",
            violations: [
              {
                ruleId: "acl",
                target: "my_service",
                targetKind: "element" as const,
                message: "msg",
                severity: "error",
              },
            ],
            suggestedFixes: [
              {
                ruleId: "acl",
                description: "add anti-corruption layer",
                edits: [
                  {
                    kind: "insert-after",
                    anchor: {
                      file: "x.puml",
                      start: { line: 1, col: 1, offset: 0 },
                      end: { line: 1, col: 10, offset: 10 },
                    },
                    content: "fake",
                  },
                ],
              },
            ],
            summary: { failed: 1, passed: 0, violations: 1 },
            rules: [],
          },
          meta: { durationMs: 1, configPath: null, source: null },
        }),
        sink,
      );
      return output();
    })();

    // Dry-run renders inline plan: violation row + "→ would <description>" +
    // compact edit preview + (dry-run) box. Plain check shows only the
    // violation table + diagnose box, no fix preview.
    expect(inDryRun).toContain("would add anti-corruption layer");
    expect(inDryRun).toContain("(dry-run)");
    expect(inCheck).not.toContain("would add anti-corruption layer");
    expect(inCheck).not.toContain("(dry-run)");
  });

  it("renders github annotations in github-actions mode", () => {
    const { sink, output } = captureSink();
    renderGha(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "check",
          violations: [
            {
              ruleId: "acl",
              target: "my_service",
              targetKind: "element" as const,
              message: "calls external",
              severity: "error",
            },
          ],
          suggestedFixes: [],
          summary: { failed: 1, passed: 0, violations: 1 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    expect(output()).toMatch(/^::error title=acl::my_service:/m);
  });

  it("annotates github errors with file/line/col when sourceLocation is present", () => {
    const { sink, output } = captureSink();
    renderGha(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "check",
          violations: [
            {
              ruleId: "acl",
              target: "my_service",
              targetKind: "element" as const,
              message: "calls external",
              severity: "error",
              sourceLocation: {
                file: "/abs/arch.dsl",
                start: { line: 42, col: 5, offset: 800 },
                end: { line: 42, col: 25, offset: 820 },
              },
            },
          ],
          suggestedFixes: [],
          summary: { failed: 1, passed: 0, violations: 1 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    expect(output()).toMatch(
      /^::error file=\/abs\/arch\.dsl,line=42,col=5,title=acl::my_service: calls external/m,
    );
  });

  // severity is reserved as "error" | "warning" | "info" — every rule emits
  // "error" today, but the renderers must already map all three levels.
  it("maps severity to github annotation level (warning → ::warning, info → ::notice)", () => {
    const { sink, output } = captureSink();
    renderGha(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "check",
          violations: [
            {
              ruleId: "naming",
              target: "svc_a",
              targetKind: "element" as const,
              message: "identifier breaks convention",
              severity: "warning",
            },
            {
              ruleId: "hint",
              target: "svc_b",
              targetKind: "element" as const,
              message: "consider renaming",
              severity: "info",
            },
          ],
          suggestedFixes: [],
          summary: { failed: 2, passed: 0, violations: 2 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    const text = output();
    expect(text).toMatch(/^::warning title=naming::svc_a:/m);
    expect(text).toMatch(/^::notice title=hint::svc_b:/m);
  });

  it("renders the per-level severity label in the violations table", () => {
    const { sink, output } = captureSink();
    renderHuman(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "check",
          violations: [
            {
              ruleId: "naming",
              target: "svc_a",
              targetKind: "element" as const,
              message: "identifier breaks convention",
              severity: "warning",
            },
            {
              ruleId: "hint",
              target: "svc_b",
              targetKind: "element" as const,
              message: "consider renaming",
              severity: "info",
            },
          ],
          suggestedFixes: [],
          summary: { failed: 2, passed: 0, violations: 2 },
          rules: [],
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    const text = output();
    expect(text).toContain("warning");
    expect(text).toContain("info");
  });

  it("renders fixesApplied summary when present", () => {
    const { sink, output } = captureSink();
    renderHuman(
      buildEnvelope({
        command: "check",
        exitCode: 0,
        data: {
          mode: "fix",
          violations: [],
          suggestedFixes: [],
          summary: { failed: 1, passed: 7, violations: 1 },
          rules: [],
          fixesApplied: {
            count: 3,
            remaining: 0,
            resolved: 3,
            introduced: 0,
            writePath: "/abs/test.puml",
            before: {
              violations: [],
              summary: { failed: 1, passed: 7, violations: 1 },
            },
          },
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    expect(output()).toContain("3 fixes applied");
    expect(output()).toContain("/abs/test.puml");
  });

  it("reports violations a fix introduced instead of netting them out", () => {
    // Regression (examples/violations-demo): 4 violations before, 3 new
    // ones after, rendered as "1 violation resolved".
    const { sink, output } = captureSink();
    renderHuman(
      buildEnvelope({
        command: "check",
        exitCode: 1,
        data: {
          mode: "fix",
          violations: [],
          suggestedFixes: [],
          summary: { failed: 2, passed: 6, violations: 3 },
          rules: [],
          fixesApplied: {
            count: 3,
            remaining: 3,
            resolved: 4,
            introduced: 3,
            writePath: "/abs/workspace.dsl",
            before: {
              violations: [],
              summary: { failed: 3, passed: 5, violations: 4 },
            },
          },
        },
        meta: { durationMs: 1, configPath: null, source: null },
      }),
      sink,
    );
    const text = stripAnsi(output());
    expect(text).toContain("4 violations resolved");
    expect(text).toContain("3 new violations introduced");
    expect(text).toContain("3 violations remaining");
  });

  // Property-based check that the `mode` argument — not the
  // GITHUB_ACTIONS env — drives the branch. The bug class this catches:
  // a future refactor reintroduces `process.env.GITHUB_ACTIONS` inside
  // the renderer body, silently ignoring the explicit arg. fast-check
  // sweeps arbitrary env values (including ones that look "truthy" to
  // an accidental Boolean coercion) crossed with both modes, so any
  // branch reading the env instead of the argument fails on at least
  // one combination.
  const violationEnvelope = () =>
    buildEnvelope({
      command: "check",
      exitCode: 1,
      data: {
        mode: "check" as const,
        violations: [
          {
            ruleId: "acl",
            target: "svc",
            targetKind: "element" as const,
            message: "msg",
            severity: "error" as const,
          },
        ],
        suggestedFixes: [],
        summary: { failed: 1, passed: 0, violations: 1 },
        rules: [],
      },
      meta: { durationMs: 1, configPath: null, source: null },
    });

  test.prop([
    fc.constantFrom("human" as const, "github-actions" as const),
    fc.constantFrom("true", "1", "yes", "", "false", "0"),
  ])(
    "explicit mode arg overrides GITHUB_ACTIONS env for any combination",
    (mode, envValue) => {
      const prev = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = envValue;
      try {
        const { sink, output } = captureSink();
        renderCheckText(violationEnvelope(), sink, mode);
        const out = output();
        if (mode === "github-actions") {
          expect(out).toMatch(/^::error/m);
        } else {
          expect(out).not.toMatch(/^::error/m);
        }
      } finally {
        if (prev === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = prev;
      }
    },
  );

  // Symmetric to the above: when the caller OMITS the mode argument,
  // the env-derived default must still distinguish the two formats.
  // The interesting bug class here: a future refactor pins the
  // default to a literal ("human") and silently breaks the
  // GitHub-Actions integration. The property holds whatever value
  // shape GITHUB_ACTIONS takes — including the empty string, which
  // is falsy and must fall through to "human".
  test.prop([fc.constantFrom("true", "1", "yes", "false", "0")])(
    "with no explicit mode, truthy GITHUB_ACTIONS produces ::error annotations",
    (envValue) => {
      const prev = process.env.GITHUB_ACTIONS;
      process.env.GITHUB_ACTIONS = envValue;
      try {
        const { sink, output } = captureSink();
        renderCheckText(violationEnvelope(), sink);
        expect(output()).toMatch(/^::error/m);
      } finally {
        if (prev === undefined) delete process.env.GITHUB_ACTIONS;
        else process.env.GITHUB_ACTIONS = prev;
      }
    },
  );

  test("with no explicit mode and empty GITHUB_ACTIONS, falls back to human table", () => {
    const prev = process.env.GITHUB_ACTIONS;
    process.env.GITHUB_ACTIONS = "";
    try {
      const { sink, output } = captureSink();
      renderCheckText(violationEnvelope(), sink);
      expect(output()).not.toMatch(/^::error/m);
    } finally {
      if (prev === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = prev;
    }
  });
});
